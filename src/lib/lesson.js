// Lesson builder: turns a learning item into a reading lesson made of ORIGINAL book passages.
//
//  1. hybrid search (vector + keyword) over every ready book
//  2. decide coverage — if nothing is truly about the topic, say so
//  3. take the best book sections and pull their passages in reading order
//  4. keep passages that are relevant enough for the requested depth
//  5. sort passages into logical lesson sections (What it is / How to perform it / ...)
//  6. attach the figures/tables those passages sit next to or reference
//  7. add a short, clearly-marked connecting note only where sources are scattered
//  8. compute reading time from the actual words + figures

import { db } from '../db/index.js';
import { embedQuery, embedQueries, embedPassages } from './embed.js';
import { cosine, keywordScore, tokenize, wordCount, readingMinutes, sentenceSpans } from './text.js';

export const LESSON_VERSION = 7;

const ROLES = [
  { id: 'overview', title: 'What it is', basic: true, kw: /\b(introduction|overview|definition|general|background|approach to)\b/i, q: (t) => `${t}: definition and overview` },
  { id: 'presentation', title: 'Clinical features', basic: true, kw: /\b(clinical (manifestations|features|presentation)|symptoms|signs|presentation|history)\b/i, q: (t) => `${t}: symptoms, signs and clinical presentation` },
  { id: 'technique', title: 'How to perform it', basic: true, kw: /\b(technique|procedure|maneuver|manoeuvre|examination|how to|performing|method|steps|test)\b/i, q: (t) => `how to perform ${t}: technique, positioning and steps` },
  { id: 'mechanism', title: 'Why it works', basic: true, kw: /\b(mechanism|physiology|principle|rationale|anatomy)\b/i, q: (t) => `why ${t} works: mechanism, anatomy and physiology` },
  { id: 'pathophysiology', title: 'Pathophysiology', basic: false, kw: /\b(pathophysiology|pathogenesis|etiology|aetiology|causes|pathology|risk factors)\b/i, q: (t) => `pathophysiology, etiology and causes of ${t}` },
  { id: 'diagnosis', title: 'Diagnosis', basic: true, kw: /\b(diagnosis|diagnostic|evaluation|investigations?|laboratory|imaging|work-?up|findings)\b/i, q: (t) => `diagnosis and investigations of ${t}` },
  { id: 'differential', title: 'Differential diagnosis', basic: false, kw: /\b(differential)\b/i, q: (t) => `differential diagnosis of ${t}: conditions to distinguish` },
  { id: 'treatment', title: 'Treatment', basic: true, kw: /\b(treatment|management|therapy|therapeutic)\b/i, q: (t) => `treatment and management of ${t}` },
  { id: 'prognosis', title: 'Course & complications', basic: false, kw: /\b(prognosis|complications?|course|outcome)\b/i, q: (t) => `prognosis, course and complications of ${t}` },
];

// margin: how far below the best passage (per subtopic) a passage may score and still be included.
// extraMargin: in basic depth, "deep" roles (pathophysiology, differentials...) stay only within this margin.
const DEPTH = {
  basic: { margin: 0.10, extraMargin: 0.04, gate: 0.22, sections: 5, figures: 4 },
  expanded: { margin: 0.18, extraMargin: 1, gate: 0.30, sections: 12, figures: 10 },
};

// Coverage threshold on the relevance score (bge-small cosine + keyword bonus).
// Calibrated so an on-topic textbook passage clears it and a merely medical-sounding one does not.
const COVER_REL = 0.78;
const KW_WEIGHT = 0.15;
// Exact terms (eponyms, abbreviations) are weak spots for small embedding models: a passage that
// contains every topic word and is at least loosely related semantically also counts as coverage.
const COVER_EXACT_SIM = 0.55;
const PREFERRED_BONUS = 0.03;
const CANDIDATE_SECTIONS = 24;
const ABS_FLOOR = 0.70;

const SPECIALTY_TERMS = {
  ent: ['ent', 'otolaryngology', 'otology', 'ear', 'nose', 'throat', 'vestibular', 'vertigo', 'hearing', 'larynx', 'sinus'],
  cardiology: ['cardio', 'heart', 'cardiac', 'coronary', 'arrhythmia'],
  neurology: ['neuro', 'brain', 'stroke', 'seizure', 'nerve'],
  internal: ['internal', 'internist', 'medicine'],
  surgery: ['surg', 'operative'],
  pediatrics: ['pediatric', 'paediatric', 'child', 'neonat'],
  psychiatry: ['psych'],
  obgyn: ['obstetric', 'gynec', 'gynaec', 'pregnan'],
};

export function librarySignature(books) {
  return `v${LESSON_VERSION}|` + books.filter((b) => b.status === 'ready').map((b) => `${b.id}:${b.page_count}`).sort().join(',');
}

/**
 * @returns {Promise<object>} lesson content
 */
export async function buildLesson(item, depth, { books, settings, onStep = () => {} }) {
  const topic = item.title.trim();
  const cfg = { ...DEPTH[depth] };
  const ready = books.filter((b) => b.status === 'ready' || (b.status === 'processing' && b.processed_pages > 0));
  const bookById = new Map(books.map((b) => [b.id, b]));
  const base = { topic, depth, version: LESSON_VERSION, sections: [], words: 0, figures: 0, minutes: 0 };
  if (!ready.length) return { ...base, status: 'no_books' };

  onStep('Searching your books');
  // "Dix-Hallpike and Epley for BPPV" -> the whole phrase plus each part, so no part gets drowned out.
  const queries = subtopics(topic);
  const qvs = await embedQueries(queries);
  const qTok = queries.map(tokenize);
  const bookIds = ready.map((b) => b.id);

  // Candidate sections from hybrid search for every (sub)topic.
  const hitLists = await Promise.all(queries.map((q, i) => db.searchChunks(qvs[i], q, 30, bookIds)));
  const secBest = new Map();
  hitLists.forEach((hits) => hits.forEach((h, rank) => {
    const v = (h.similarity ?? 0) - rank * 0.002;
    if (!secBest.has(h.section_key) || secBest.get(h.section_key) < v) secBest.set(h.section_key, v);
  }));
  const candidateKeys = [...secBest.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATE_SECTIONS).map(([k]) => k);

  onStep('Reading the relevant sections');
  const pool = await db.sectionChunks(candidateKeys);
  if (!pool.length) return { ...base, status: 'no_coverage', best: null };

  // Relevance of a passage to subtopic i: semantic similarity, plus a keyword bonus when the
  // passage text OR its chapter/section heading names the topic (so a "Diagnosis" section inside
  // the Heart Failure chapter counts as being about heart failure).
  for (const c of pool) {
    c.sims = qvs.map((v) => cosine(v, c.embedding));
    // keyword match in the passage text or in its chapter/section heading
    c.kws = qTok.map((t) => Math.max(keywordScore(t, c.text), keywordScore(t, `${c.chapter || ''} ${c.section || ''}`)));
    c.rels = queries.map((_, i) => c.sims[i]
      + KW_WEIGHT * c.kws[i]
      + (item.preferred_book_id && c.book_id === item.preferred_book_id ? PREFERRED_BONUS : 0));
  }
  const tops = queries.map((_, i) => Math.max(...pool.map((c) => c.rels[i])));
  const covered = queries.map((_, i) => pool.some((c) => c.rels[i] >= COVER_REL || (c.kws[i] === 1 && c.sims[i] >= COVER_EXACT_SIM)));
  // Reference level per subtopic: mean of its 3 best passages, so one stand-out definition
  // paragraph does not shrink the lesson to a single passage.
  const refs = queries.map((_, i) => { const r = pool.map((c) => c.rels[i]).sort((a, b) => b - a).slice(0, 3); return r.reduce((a, b) => a + b, 0) / r.length; });
  if (!covered.some(Boolean)) {
    return { ...base, status: 'no_coverage', best: { rel: Math.max(...tops) } };
  }

  // Specialty emphasis: topics in an emphasised specialty get a fuller basic lesson.
  const best = [...pool].sort((a, b) => Math.max(...b.rels) - Math.max(...a.rels));
  if (depth === 'basic' && matchesEmphasis(settings, item, best.slice(0, 5), bookById)) {
    cfg.margin = 0.15; cfg.extraMargin = 0.08; cfg.figures = 6; cfg.emphasised = true;
  }

  // score <= 0: distance below the best passage for the subtopic it serves best.
  // A part of the topic only pulls in passages that are still reasonably about the whole topic (cfg.gate).
  for (const c of pool) {
    const gate = c.rels[0] >= tops[0] - cfg.gate;
    c.score = Math.max(...c.rels.map((r, i) => {
      if (!covered[i] || (i > 0 && !gate)) return -Infinity;
      // Never include a passage that is not itself about the (sub)topic, however small the library.
      const onTopic = r >= ABS_FLOOR || (c.kws[i] === 1 && c.sims[i] >= COVER_EXACT_SIM);
      return onTopic ? r - refs[i] : -Infinity;
    }));
  }
  for (const c of pool) c.rel = Math.max(...c.rels);

  // ---- keep relevant passages, limited to the best sections, then fill single gaps so text reads on
  let keptList = pool.filter((c) => c.score >= -cfg.margin);
  const secRank = [...groupBy(keptList, (c) => c.section_key).entries()]
    .map(([k, l]) => [k, Math.max(...l.map((c) => c.score))]).sort((a, b) => b[1] - a[1]).slice(0, cfg.sections).map(([k]) => k);
  keptList = keptList.filter((c) => secRank.includes(c.section_key));
  const kept = new Set(keptList.map((c) => c.id));
  const bySec = groupBy(pool, (c) => c.section_key);
  for (const list of bySec.values()) {
    list.sort((a, b) => a.ord - b.ord);
    for (let i = 1; i < list.length - 1; i++) {
      if (!kept.has(list[i].id) && kept.has(list[i - 1].id) && kept.has(list[i + 1].id)) kept.add(list[i].id);
    }
  }
  let passages = pool.filter((c) => kept.has(c.id));

  // ---- drop near-duplicates (same content in two books / overlapping chunks)
  passages.sort((a, b) => b.rel - a.rel);
  const unique = [];
  for (const p of passages) if (!unique.some((u) => u.embedding && p.embedding && cosine(u.embedding, p.embedding) > 0.965)) unique.push(p);
  passages = unique;

  // ---- assign lesson roles
  onStep('Organising the lesson');
  const roleVecs = await embedQueries(ROLES.map((r) => r.q(topic)));
  const qv = qvs[0];
  for (const p of passages) {
    const heading = `${p.section || ''}`;
    let best = null;
    ROLES.forEach((r, i) => {
      const s = (p.embedding ? cosine(p.embedding, roleVecs[i]) : 0) + (r.kw.test(heading) ? 0.06 : 0);
      if (!best || s > best.s) best = { r, s };
    });
    p.role = best.r;
  }
  // Basic depth = essentials. Deep roles stay only if they are among the very best passages.
  if (depth === 'basic') passages = passages.filter((p) => p.role.basic || p.score >= -cfg.extraMargin);

  // ---- assemble sections in a teaching order, passages in book reading order
  const sections = [];
  for (const r of ROLES) {
    const ps = passages.filter((p) => p.role === r);
    if (!ps.length) continue;
    const bookOrder = [...new Set(ps.sort((a, b) => b.rel - a.rel).map((p) => p.book_id))];
    ps.sort((a, b) => bookOrder.indexOf(a.book_id) - bookOrder.indexOf(b.book_id) || a.ord - b.ord);
    sections.push({
      role: r.id, title: r.title,
      blocks: ps.map((p) => ({
        type: 'passage', chunk_id: p.id, book_id: p.book_id, book_title: bookById.get(p.book_id)?.title || 'Book',
        chapter: p.chapter, section: p.section, section_key: p.section_key, page_start: p.page_start, page_end: p.page_end, text: p.text, words: p.word_count,
      })),
    });
  }

  // ---- figures and tables
  onStep('Adding figures and tables');
  let figCount = 0;
  const figCache = new Map();
  const usedFigs = new Set();
  for (const s of sections) {
    const out = [];
    for (const b of s.blocks) {
      out.push(b);
      if (figCount >= cfg.figures) continue;
      if (!figCache.has(b.book_id)) {
        // Figures can sit up to a few pages from the passage that cites them.
        const pages = new Set();
        for (const p of passages) if (p.book_id === b.book_id) for (let k = p.page_start - 6; k <= p.page_end + 6; k++) if (k > 0) pages.add(k);
        figCache.set(b.book_id, await db.figuresForPages(b.book_id, [...pages]));
      }
      const figs = figCache.get(b.book_id).filter((f) => !usedFigs.has(f.id) && figureBelongs(f, b));
      for (const f of figs.slice(0, 2)) {
        usedFigs.add(f.id); figCount++;
        out.push(figureBlock(f, b.book_id, b.book_title));
      }
    }
    s.blocks = out;
  }

  // ---- connecting notes where a section is scattered across books/chapters
  for (const s of sections) {
    const ps = s.blocks.filter((b) => b.type === 'passage');
    const books_ = new Set(ps.map((p) => p.book_id));
    const chapters = new Set(ps.map((p) => `${p.book_id}|${p.chapter}`));
    const span = Math.max(...ps.map((p) => p.page_end)) - Math.min(...ps.map((p) => p.page_start));
    if (ps.length < 2 || (books_.size < 2 && chapters.size < 2 && span < 25)) continue;
    // One cite per distinct book page.
    const cites = [...new Map(ps.map((p) => [`${p.book_id}|${p.page_start}`, { book_title: p.book_title, page: p.page_start }])).values()];
    const citeText = (p) => `${shortTitle(p.book_title)} p. ${p.page_start}`;
    let text = await db.connectNote({
      topic, section: s.title, level: settings?.career_interest || 'general medical student',
      passages: ps.map((p) => ({ cite: citeText(p), text: p.text })),
    });
    if (!text) {
      const where = [...groupBy(ps, (p) => p.book_title).entries()]
        .map(([t, list]) => `${shortTitle(t)} (p. ${[...new Set(list.map((p) => p.page_start))].join(', ')})`);
      text = `This part combines passages from ${listJoin(where)}.`;
    }
    s.blocks.unshift({ type: 'note', text, cites });
  }

  // ---- supplement: every figure/table the passages mention that is not already shown
  onStep('Collecting referenced figures');
  const shown = new Set(sections.flatMap((s) => s.blocks.filter((b) => b.type === 'figure').map((b) => refKey(b.book_id, b.kind, b.label))));
  const wanted = new Map(); // key -> {book_id, book_title, kind, label, cited_on}
  for (const s of sections) for (const b of s.blocks) {
    if (b.type !== 'passage') continue;
    for (const r of figureRefs(b.text)) {
      const key = refKey(b.book_id, r.kind, r.label);
      if (!shown.has(key) && !wanted.has(key)) wanted.set(key, { book_id: b.book_id, book_title: b.book_title, kind: r.kind, label: r.label, cited_on: b.page_start });
    }
  }
  const supplement = [];
  for (const [bookId, refs] of groupBy([...wanted.values()], (r) => r.book_id)) {
    const labels = [...new Set(refs.flatMap((r) => [r.label, r.label.replace(/-/g, '–')]))];
    const found = await db.figuresByLabels(bookId, labels);
    for (const r of refs.sort((a, b) => a.kind.localeCompare(b.kind) || labelOrder(a.label) - labelOrder(b.label))) {
      const f = found.find((x) => refKey(bookId, x.kind, x.label) === refKey(bookId, r.kind, r.label));
      supplement.push(f ? { ...figureBlock(f, bookId, r.book_title), cited_on: r.cited_on }
        : { type: 'missing', book_id: bookId, book_title: r.book_title, kind: r.kind, label: r.label, cited_on: r.cited_on });
    }
  }
  if (supplement.length) sections.push({ role: 'supplement', title: 'Figures & tables', supplement: true, blocks: supplement });

  const words = passages.reduce((a, p) => a + (p.word_count || wordCount(p.text)), 0);
  return { ...base, status: 'ok', sections, words, figures: figCount, minutes: readingMinutes(words, figCount), emphasised: !!cfg.emphasised };
}

function figureBlock(f, bookId, bookTitle) {
  return { type: 'figure', figure_id: f.id, book_id: bookId, kind: f.kind, label: f.label, caption: f.caption, image_path: f.image_path,
    width: f.width, height: f.height, book_title: bookTitle, page: f.page };
}

/** "Fig. 21-4", "Figures 3.2", "Table 28-1A" in a passage -> [{kind, label}] (sub-panel letters dropped). */
export function figureRefs(text) {
  const out = [];
  for (const m of text.matchAll(FIG_REF_RE)) out.push({ kind: /^tab/i.test(m[1]) ? 'table' : 'figure', label: normLabel(m[2]), index: m.index, length: m[0].length });
  return out;
}
export const FIG_REF_RE = /\b(Figs?\.?|Figures?|FIGURES?|Tables?|TABLES?|Tab\.)\s+(\d+[A-Za-z]?(?:\s?[-–—.]\s?\d+[A-Za-z]?)*)/g;
export const normLabel = (l) => (l || '').replace(/\s+/g, '').replace(/[–—]/g, '-').replace(/[A-Za-z]$/, '');
export const refKey = (bookId, kind, label) => `${bookId}|${kind}|${normLabel(label)}`;
const labelOrder = (l) => l.split(/[-.]/).reduce((a, n) => a * 1000 + (parseInt(n, 10) || 0), 0);

/** A figure belongs next to a passage if the passage cites it, or it sits on the passage's pages in the same section. */
function figureBelongs(f, p) {
  const ref = f.label && new RegExp(`\\b(fig(ure)?s?\\.?|table)\\s*${escapeRe(f.label).replace(/[-–—.]/g, '[-–—.]\\s*')}\\b`, 'i').test(p.text);
  if (ref) return Math.abs(f.page - p.page_start) <= 6;
  return f.page >= p.page_start && f.page <= p.page_end && f.section_key === p.section_key;
}

function matchesEmphasis(settings, item, topHits, bookById) {
  const emph = (settings?.emphasis || []).map((e) => e.toLowerCase().trim()).filter(Boolean);
  if (!emph.length) return false;
  const hay = [item.title, item.note, ...topHits.map((h) => `${h.chapter} ${h.section} ${bookById.get(h.book_id)?.title}`)].join(' ').toLowerCase();
  return emph.some((e) => {
    const key = Object.keys(SPECIALTY_TERMS).find((k) => e.includes(k) || SPECIALTY_TERMS[k].some((t) => e.includes(t)));
    const terms = key ? SPECIALTY_TERMS[key] : [e];
    return terms.some((t) => new RegExp(`\\b${escapeRe(t)}`, 'i').test(hay));
  });
}

/** Optional auto-underline: the sentences most similar to the topic. */
export async function keySentences(content, topic) {
  const [qv] = await embedQueries([topic]);
  const cands = [];
  for (const s of content.sections) for (const b of s.blocks) {
    if (b.type !== 'passage') continue;
    for (const [a, z] of sentenceSpans(b.text)) cands.push({ chunk_id: b.chunk_id, start: a, end: z, text: b.text.slice(a, z) });
  }
  if (!cands.length) return [];
  const vecs = await embedPassages(cands.map((c) => c.text));
  cands.forEach((c, i) => (c.score = cosine(qv, vecs[i])));
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  const n = Math.max(2, Math.round(cands.length * 0.12));
  const cut = sorted[Math.min(n, sorted.length) - 1].score;
  return cands.filter((c) => c.score >= cut && c.score > 0.6);
}

function groupBy(arr, fn) { const m = new Map(); for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function shortTitle(t) {
  const s = cleanTitle(t).split(/[:–—]/)[0].trim();
  if (s.length <= 42) return s;
  return s.slice(0, 42).replace(/\s+\S*$/, '') + '…';
}
/** Strip download-site noise from file-name titles: "(z-lib.org)", "(1)", author lists in brackets. */
export const cleanTitle = (t) => (t || '').replace(/\.pdf$/i, '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
const listJoin = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);

/** Split a multi-part topic into its parts (always keeping the full phrase first). */
export function subtopics(topic) {
  const parts = topic.split(/\s+(?:and|&|for|vs\.?|versus|plus)\s+|\s*[,;/+]\s*/i)
    .map((p) => p.trim()).filter((p) => p.length >= 3 && tokenize(p).length);
  return [...new Set([topic, ...(parts.length > 1 ? parts : [])])].slice(0, 6);
}
