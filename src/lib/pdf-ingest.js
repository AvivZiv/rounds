// PDF ingestion — runs ONCE per book, in the browser.
//
//   text layer ──► lines (column-aware) ──► headings / captions / paragraphs
//                                      └──► figure & table regions ──► cropped images
//   paragraphs ──► chunks (original text, verbatim) ──► embeddings ──► db
//
// Everything here is heuristic; textbooks vary a lot. The design goal is that the
// passages a student reads are faithful to the book, even if section detection is imperfect.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { db } from '../db/index.js';
import { embedPassages } from './embed.js';
import { wordCount } from './text.js';
import { MAX_STORED_PDF_BYTES } from '../config.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const PAGE_BATCH = 16;
const MIN_CHUNK_WORDS = 60;
const MAX_CHUNK_WORDS = 320;
const CAPTION_RE = /^(fig(?:ure)?s?\.?|table|tab\.)\s*([0-9]+[A-Za-z]?(?:\s*[-.–—]\s*[0-9]+[A-Za-z]?)*)/i;
const CROP_SCALE = 2;
const BYLINE_RE = /^((and\s+)?[A-Z][\w'’-]+(\s+[A-Z]\.)+\s+[A-Z][\w'’-]+(,\s*(MD|PhD|MPH|DO|MBBS|FRCP)\.?)*,?\s*)+$/;
const REFERENCES_RE = /^(further reading|references|suggested reading|bibliography|selected readings?)\b/i;

/**
 * @param {object} book   db row
 * @param {File|Blob|null} file  the PDF (null = download from storage, used for resume)
 * @param {(p:{phase:string,page?:number,pages?:number,msg?:string})=>void} onProgress
 * @param {{signal?:AbortSignal}} opts
 */
export async function ingestBook(book, file, onProgress = () => {}, opts = {}) {
  const resume = !file;
  if (!file) {
    if (!book.file_path) throw new Error('The original PDF was not stored (too large). Please re-upload it to continue.');
    onProgress({ phase: 'download' });
    file = await db.downloadBookFile(book.file_path);
  }
  const data = new Uint8Array(await file.arrayBuffer());

  if (!resume && !book.file_path && file.size <= MAX_STORED_PDF_BYTES) {
    onProgress({ phase: 'upload' });
    const path = await db.uploadBookFile(book.id, file);
    book = await db.updateBook(book.id, { file_path: path, file_size: file.size });
  }

  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = pdf.numPages;
  book = await db.updateBook(book.id, { page_count: pages, status: 'processing', error: null });

  // ---- book-level analysis (fast, sampled)
  onProgress({ phase: 'analyse', pages });
  const outline = await flattenOutline(pdf);
  const stats = await analyseFonts(pdf);
  if (stats.charsPerPage < 80) {
    await db.updateBook(book.id, { status: 'error', error: 'This PDF has no text layer (it looks scanned). Run OCR on it first, then upload again.' });
    throw new Error('No text layer');
  }
  await db.updateBook(book.id, { body_font_size: stats.body });

  const state = {
    book, body: stats.body, repeated: stats.repeated, outline,
    chapter: null, section: null, sectionKey: `${book.id}:start`, headingCount: 0,
    para: null,          // paragraph being built (may cross page/column)
    chunk: null,         // chunk being built
    ready: [],           // finished chunks waiting for embedding
    figures: [],
    sections: [],
  };
  // On resume, restore the chapter/section context at the resume page.
  const start = (book.processed_pages || 0) + 1;
  if (start > 1) restoreContext(state, start);

  // Pipeline: while one batch is embedded and saved, the next pages are already being read.
  let saving = Promise.resolve();
  for (let p0 = start; p0 <= pages; p0 += PAGE_BATCH) {
    if (opts.signal?.aborted) { await saving; throw new DOMException('Cancelled', 'AbortError'); }
    const p1 = Math.min(pages, p0 + PAGE_BATCH - 1);
    for (let pn = p0; pn <= p1; pn++) {
      onProgress({ phase: 'pages', page: pn, pages });
      const page = await pdf.getPage(pn);
      try { await processPage(page, pn, state); } finally { page.cleanup(); }
    }
    if (p1 === pages) { flushPara(state, true); flushChunk(state); }
    const batch = { sections: state.sections, ready: state.ready, figures: state.figures };
    state.sections = []; state.ready = []; state.figures = [];
    await saving; // at most one batch in flight; processed_pages only advances after a batch is saved
    saving = persist(book, batch).then(() => db.updateBook(book.id, { processed_pages: p1 }));
  }
  await saving;
  await pdf.destroy();
  return db.updateBook(book.id, { status: 'ready', processed_pages: pages });
}

// ------------------------------------------------------------------ persistence
async function persist(book, { sections, ready, figures }) {
  if (sections.length) await db.insertSections(sections);
  if (ready.length) {
    // Heading + start of the passage; the embedder keeps the first ~160 tokens.
    const texts = ready.map((c) => `${c.chapter || ''}${c.section ? ' — ' + c.section : ''}\n${c.text}`.split(/\s+/).slice(0, 200).join(' '));
    const vecs = await embedPassages(texts);
    await db.insertChunks(ready.map((c, i) => ({ ...c, book_id: book.id, embedding: vecs[i] })));
  }
  if (figures.length) await db.insertFigures(figures.map((f) => ({ ...f, book_id: book.id })));
}

// ------------------------------------------------------------------ outline
async function flattenOutline(pdf) {
  const out = [];
  let raw;
  try { raw = await pdf.getOutline(); } catch { raw = null; }
  if (!raw) return { entries: [], chapterDepth: 0 };
  async function walk(nodes, depth) {
    for (const n of nodes) {
      let page = null;
      try {
        const dest = typeof n.dest === 'string' ? await pdf.getDestination(n.dest) : n.dest;
        if (dest?.[0]) page = (await pdf.getPageIndex(dest[0])) + 1;
      } catch { /* ignore broken destinations */ }
      if (page) out.push({ title: clean(n.title), depth, page });
      if (n.items?.length) await walk(n.items, depth + 1);
    }
  }
  await walk(raw, 0);
  // If the top level is "Parts" (few entries) and the next level is chapters, use depth 1.
  const c0 = out.filter((e) => e.depth === 0).length, c1 = out.filter((e) => e.depth === 1).length;
  let chapterDepth = c0 < 15 && c1 > 2 * c0 ? 1 : 0;
  for (let d = 0; d <= 2; d++) {
    const at = out.filter((e) => e.depth === d);
    const numbered = at.filter((e) => /^(chapter\s+)?\d{1,4}[.:]?\s+\S/i.test(e.title)).length;
    if (at.length >= 5 && numbered >= at.length * 0.5) { chapterDepth = d; break; }
  }
  const entries = out.sort((a, b) => a.page - b.page || a.depth - b.depth);
  // Front/back matter (contents, contributors, index...) is keyword-dense but never lesson material.
  const MATTER = /^(cover|title( page)?|half title|copyright|(table of )?contents|contributors|preface|foreword|acknowledg|dedication|index|related resources|about the (author|editor)s?|abbreviations)\b/i;
  const skip = [];
  entries.forEach((e, i) => {
    if (!MATTER.test(e.title)) return;
    const next = entries.slice(i + 1).find((n) => n.depth <= e.depth && n.page > e.page);
    skip.push([e.page, next ? next.page - 1 : Infinity]);
  });
  return { entries, chapterDepth, skip };
}

function restoreContext(state, page) {
  const { entries, chapterDepth } = state.outline;
  const prior = entries.filter((e) => e.page < page);
  const ch = [...prior].reverse().find((e) => e.depth <= chapterDepth);
  const sec = [...prior].reverse().find((e) => e.depth > chapterDepth);
  if (ch) state.chapter = ch.title;
  if (sec && (!ch || sec.page >= ch.page)) state.section = sec.title;
  state.sectionKey = `${state.book.id}:r${page}`;
}

// ------------------------------------------------------------------ font statistics
async function analyseFonts(pdf) {
  const n = pdf.numPages;
  const sample = [...new Set(Array.from({ length: Math.min(40, n) }, (_, i) => 1 + Math.floor((i * n) / Math.min(40, n))))];
  const hist = new Map();
  const edgeCounts = new Map();
  let chars = 0;
  for (const pn of sample) {
    const page = await pdf.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      if (!it.str?.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, it.transform);
      const size = Math.round(Math.hypot(t[2], t[3]) * 2) / 2;
      hist.set(size, (hist.get(size) || 0) + it.str.length);
      chars += it.str.length;
      const y = t[5];
      if (y < vp.height * 0.08 || y > vp.height * 0.93) {
        const key = normEdge(it.str);
        if (key.length > 3) edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
      }
    }
    page.cleanup();
  }
  const body = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const repeated = new Set([...edgeCounts.entries()].filter(([, c]) => c >= Math.max(3, sample.length * 0.2)).map(([k]) => k));
  return { body, repeated, charsPerPage: chars / sample.length };
}
const normEdge = (s) => s.toLowerCase().replace(/[0-9ivxlc]+/g, '#').replace(/\s+/g, ' ').trim();
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ page processing
async function processPage(page, pn, state) {
  if (state.outline.skip?.some(([a, b]) => pn >= a && pn <= b)) { flushPara(state, true); flushChunk(state); state.skipping = true; return; }
  if (state.skipping) { state.skipping = false; state.section = null; }
  const vp = page.getViewport({ scale: 1 });
  const W = vp.width, H = vp.height;
  const [tc, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()]);

  // 1. Text items in top-down page coordinates.
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = pdfjs.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]);
    if (size < 3) continue;
    if (Math.abs(t[1]) > 0.1 * size || Math.abs(t[2]) > 0.1 * size) continue; // rotated text: side tabs, margins
    const width = it.width * (size / Math.hypot(it.transform[2], it.transform[3]) || 1);
    items.push({ str: it.str, x: t[4], y: t[5], size, w: width, bold: isBold(page, it.fontName, tc.styles) });
  }

  // 2. Column layout, lines, reading order.
  const twoCol = detectTwoColumns(items, W, state.body);
  const lines = buildLines(items, W, twoCol, state.body);
  const ordered = orderLines(lines, twoCol);

  // 3. Drop running headers/footers and page numbers.
  state.recent ??= new Map(); // normalised short line -> last pages it appeared on
  const isRunningHead = (l) => {
    if (wordCount(l.text) > 10) return false;
    const pages = state.recent.get(normEdge(l.text)) || [];
    return pages.filter((p) => p !== pn && pn - p <= 6).length >= 2;
  };
  const body = ordered.filter((l) => !(isEdge(l, H) && (/^[\divxlc\s.|–-]+$/i.test(l.text) || state.repeated.has(normEdge(l.text)) || wordCount(l.text) <= 8)) && !isRunningHead(l));
  for (const l of ordered) {
    if (wordCount(l.text) > 10) continue;
    const k = normEdge(l.text);
    const pages = (state.recent.get(k) || []).filter((p) => pn - p <= 6);
    if (!pages.includes(pn)) pages.push(pn);
    state.recent.set(k, pages);
  }
  if (state.recent.size > 5000) for (const [k, v] of state.recent) if (v.every((p) => pn - p > 6)) state.recent.delete(k);

  // 4. Figures & tables.
  const images = imageBoxes(ops, vp);
  const regions = findRegions(body, images, W, H, state.body, twoCol);
  const inRegion = (l) => regions.some((r) => l.x >= r.x0 - 2 && l.xEnd <= r.x1 + 2 && l.y >= r.y0 - 2 && l.y - l.size <= r.y1 + 2);

  // 5. Outline headings that start on this page.
  const { entries, chapterDepth } = state.outline;
  const outlineHere = entries.filter((e) => e.page === pn);
  const outlineTitles = new Map(outlineHere.map((e) => [norm(e.title), e]));
  for (const e of outlineHere) if (e.depth <= chapterDepth && !matchesAnyLine(e.title, body)) setHeading(state, 1, e.title, pn, true);

  // 6. Walk lines: headings, paragraphs.
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (l.caption) { for (const r of regions) if (r.capLine === l) r.sectionKey = state.sectionKey; }
    if (inRegion(l) || l.caption || l.inCaption) continue;
    const o = outlineTitles.get(norm(l.text));
    let level = o ? (o.depth <= chapterDepth ? 1 : 2) : headingLevel(l, body[i + 1], state.body);
    if (level === 1 && !o && entries.length) level = 2;
    if (level && BYLINE_RE.test(l.text)) { continue; } // chapter author lines
    if (level) {
      // Merge a heading that wraps onto two lines.
      let title = l.text;
      while (body[i + 1] && !body[i + 1].caption && Math.abs(body[i + 1].size - l.size) < 0.3 && body[i + 1].bold === l.bold
        && body[i + 1].y - l.y < l.size * 1.8 && wordCount(title) < 14 && headingLevel(body[i + 1], body[i + 2], state.body)) {
        title += ' ' + body[++i].text;
      }
      setHeading(state, level, title, pn, false);
      continue;
    }
    if (state.inReferences) continue;
    addLine(state, l, body[i - 1], pn);
  }
  if (regions.length && !state.dryRun) await cropRegions(page, pn, regions, state);
  // A paragraph that ends with terminal punctuation at the page end is finished;
  // otherwise it continues onto the next page.
  flushPara(state, false);
}

function isBold(page, fontName, styles) {
  try {
    if (page.commonObjs.has(fontName)) {
      const f = page.commonObjs.get(fontName);
      if (f?.bold || /bold|black|heavy|semibold|demi/i.test(f?.name || '')) return true;
    }
  } catch { /* font not loaded */ }
  return /bold/i.test(styles?.[fontName]?.fontFamily || '');
}

function detectTwoColumns(items, W, body) {
  let left = 0, right = 0, span = 0;
  for (const it of items) {
    if (Math.abs(it.size - body) > 1) continue;
    const x1 = it.x + it.w;
    if (x1 < W * 0.53) left += it.str.length;
    else if (it.x > W * 0.47) right += it.str.length;
    else span += it.str.length;
  }
  const total = left + right + span;
  return total > 200 && left > total * 0.25 && right > total * 0.25 && span < total * 0.15;
}

function buildLines(items, W, twoCol, body) {
  const col = (it) => (!twoCol ? 0 : it.x + it.w < W * 0.53 ? 1 : it.x > W * 0.47 ? 2 : 0);
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const c = col(it);
    const line = lines.findLast?.((l) => l.col === c && Math.abs(l.y - it.y) < Math.max(l.size, it.size) * 0.45)
      ?? [...lines].reverse().find((l) => l.col === c && Math.abs(l.y - it.y) < Math.max(l.size, it.size) * 0.45);
    if (line && it.x >= line.xEnd - line.size * 0.6) {
      const gap = it.x - line.xEnd;
      if (gap > line.size * 2.2) line.gaps++;
      line.text += (gap > it.size * 0.15 && !line.text.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
      line.xEnd = Math.max(line.xEnd, it.x + it.w);
      line.sizes.set(Math.round(it.size * 2) / 2, (line.sizes.get(Math.round(it.size * 2) / 2) || 0) + it.str.length);
      line.bold = line.bold && it.bold;
      line.n++;
    } else {
      lines.push({ text: it.str, x: it.x, xEnd: it.x + it.w, y: it.y, size: it.size, bold: it.bold, col: c, gaps: 0, n: 1, sizes: new Map([[Math.round(it.size * 2) / 2, it.str.length]]) });
    }
  }
  for (const l of lines) {
    l.size = [...l.sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    l.text = l.text.replace(/\s+/g, ' ').trim();
    const m = l.text.match(CAPTION_RE);
    const after = m ? l.text.slice(m[0].length) : '';
    l.caption = m && !/^\s*[),;]/.test(after) && (l.bold || Math.abs(l.size - body) > 0.4) ? m : null;
  }
  return lines.filter((l) => l.text);
}

function orderLines(lines, twoCol) {
  if (!twoCol) return lines.sort((a, b) => a.y - b.y || a.x - b.x);
  const colLines = lines.filter((l) => l.col);
  const top = Math.min(...colLines.map((l) => l.y), Infinity);
  const spanTop = lines.filter((l) => !l.col && l.y <= top);
  const spanRest = lines.filter((l) => !l.col && l.y > top);
  const byY = (a, b) => a.y - b.y;
  return [...spanTop.sort(byY), ...lines.filter((l) => l.col === 1).sort(byY), ...lines.filter((l) => l.col === 2).sort(byY), ...spanRest.sort(byY)];
}

const isEdge = (l, H) => l.y < H * 0.07 || l.y > H * 0.94;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
function matchesAnyLine(title, lines) { const t = norm(title); return t.length > 3 && lines.some((l) => norm(l.text) === t || (norm(l.text).length > 6 && t.startsWith(norm(l.text)))); }

function headingLevel(l, next, body) {
  const words = wordCount(l.text);
  if (words > 18 || l.caption || l.gaps > 0 || /[,;]$/.test(l.text) || /^[a-z]/.test(l.text)) return 0;
  if (!/[A-Za-z]{3}/.test(l.text)) return 0;
  const r = l.size / body;
  if (r >= 1.6) return 1;
  if (r >= 1.28) return 2;
  if (r >= 1.1) return 3;
  // Same-size bold line standing on its own (not a run-in head that continues the paragraph).
  if (l.bold && words <= 12 && !/[.:]$/.test(l.text) && Math.abs(r - 1) < 0.08 && (!next || !next.bold)) return 3;
  return 0;
}

function setHeading(state, level, title, pn, fromOutline) {
  title = clean(title);
  flushPara(state, true);
  flushChunk(state);
  state.headingCount++;
  if (level === 1) { state.chapter = title; state.section = null; }
  else state.section = title;
  // Reference lists ("Further reading", "References") are not indexed.
  state.inReferences = level > 1 && REFERENCES_RE.test(title.replace(/^[■•▪\s]+/, ''));
  state.sectionKey = `${state.book.id}:p${pn}h${state.headingCount}`;
  state.sections.push({ book_id: state.book.id, level, title, page_start: pn, ord: pn * 1000 + state.headingCount });
}

// ------------------------------------------------------------------ paragraphs & chunks
function addLine(state, l, prev, pn) {
  const p = state.para;
  if (p) {
    const sameFlow = prev && prev.col === l.col && !prev.caption;
    const gap = sameFlow ? l.y - prev.y : 0;
    const indent = sameFlow && l.x - p.lineX > l.size * 0.9;
    const prevEnded = /[.!?:”")\]]$/.test(p.lastText);
    const shortPrev = sameFlow && prev.xEnd < p.maxXEnd - l.size * 3;
    const newPara = (sameFlow && gap > l.size * 1.75) || (indent && prevEnded) || (shortPrev && prevEnded)
      || (Math.abs(l.size - p.size) > 1.2) || (!sameFlow && prevEnded && !p.continued);
    if (newPara) flushPara(state, true);
  }
  if (!state.para) state.para = { text: '', page: pn, pageEnd: pn, lineX: l.x, maxXEnd: l.xEnd, size: l.size, lastText: '' };
  const q = state.para;
  q.text = joinLine(q.text, l.text);
  q.pageEnd = pn;
  q.lastText = l.text;
  q.lineX = Math.min(q.lineX, l.x);
  q.maxXEnd = Math.max(q.maxXEnd, l.xEnd);
  q.continued = false;
}

function joinLine(acc, line) {
  if (!acc) return line;
  if (/[A-Za-z]-$/.test(acc) && /^[a-z]/.test(line)) {
    const lastWord = acc.slice(acc.lastIndexOf(' ') + 1, -1);
    return lastWord.includes('-') ? acc + line : acc.slice(0, -1) + line; // de-hyphenate, but keep compounds
  }
  return acc + ' ' + line;
}

function flushPara(state, force) {
  const p = state.para;
  if (!p) return;
  if (!force && !/[.!?:”")\]]$/.test(p.lastText)) { p.continued = true; return; }
  state.para = null;
  const text = p.text.trim();
  if (wordCount(text) < 4) return;
  addParagraph(state, text, p.page, p.pageEnd);
}

function addParagraph(state, text, page, pageEnd) {
  const words = wordCount(text);
  // Very long paragraphs are split so each chunk stays embeddable: at sentence ends where
  // possible, otherwise (lists, tables, text without punctuation) every MAX_CHUNK_WORDS words.
  if (words > MAX_CHUNK_WORDS * 1.4) {
    for (const piece of splitLong(text)) { appendToChunk(state, piece, wordCount(piece), page, pageEnd); flushChunk(state); }
    return;
  }
  appendToChunk(state, text, words, page, pageEnd);
}

function splitLong(text) {
  const sentences = text.match(/[^.!?]+[.!?]+["”)]?\s*|[^.!?]+$/g) || [text];
  const pieces = [];
  let buf = '';
  const push = () => { if (buf.trim()) pieces.push(buf.trim()); buf = ''; };
  for (const s of sentences) {
    if (wordCount(s) > MAX_CHUNK_WORDS) {
      push();
      const w = s.trim().split(/\s+/);
      for (let i = 0; i < w.length; i += MAX_CHUNK_WORDS) pieces.push(w.slice(i, i + MAX_CHUNK_WORDS).join(' '));
      continue;
    }
    if (buf && wordCount(buf + s) > MAX_CHUNK_WORDS) push();
    buf += s;
  }
  push();
  return pieces;
}

function appendToChunk(state, text, words, page, pageEnd) {
  let c = state.chunk;
  if (c && c.word_count + words > MAX_CHUNK_WORDS) { flushChunk(state); c = null; }
  if (!c) {
    c = state.chunk = {
      ord: nextOrd(state, page), chapter: state.chapter, section: state.section,
      section_key: state.sectionKey, page_start: page, page_end: pageEnd, text: '', word_count: 0,
    };
  }
  c.text += (c.text ? '\n\n' : '') + text;
  c.word_count += words;
  c.page_end = pageEnd;
  if (c.word_count >= MIN_CHUNK_WORDS * 2.5) flushChunk(state);
}

// Reading-order key that stays monotonic across resumed runs: page * 1000 + n.
function nextOrd(state, page) {
  if (state.ordPage !== page) { state.ordPage = page; state.ordN = 0; }
  return page * 1000 + Math.min(999, ++state.ordN);
}

function flushChunk(state) {
  const c = state.chunk;
  state.chunk = null;
  if (c && c.word_count >= 8) state.ready.push(c);
}

// ------------------------------------------------------------------ figures & tables
function imageBoxes(opList, vp) {
  const { OPS, Util } = pdfjs;
  const boxes = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args?.[0]) ctm = Util.transform(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const m = Util.transform(vp.transform, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => Util.applyTransform([x, y], m));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const b = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      const w = b.x1 - b.x0, h = b.y1 - b.y0;
      if (w > 40 && h > 30 && w * h < vp.width * vp.height * 0.85) boxes.push(b);
    }
  }
  return boxes;
}

/** Locate figure/table regions anchored on their captions. Returns boxes in page units. */
function findRegions(lines, images, W, H, body, twoCol) {
  const regions = [];
  const used = new Set();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.caption) continue;
    const kind = /^tab/i.test(l.caption[1]) ? 'table' : 'figure';
    const label = l.caption[2].replace(/\s+/g, '');
    // Caption block = caption line + following lines in the same block.
    const capLines = [l];
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j], last = capLines[capLines.length - 1];
      if (n.col !== l.col || n.y - last.y > last.size * 1.7 || n.caption || capLines.length > 12) break;
      if (kind === 'table' && n.gaps > 0) break;
      capLines.push(n);
    }
    capLines.forEach((c) => (c.inCaption = true));
    const caption = capLines.reduce((acc, c) => joinLine(acc, c.text), '');
    const colX0 = twoCol && l.col === 2 ? W * 0.47 : twoCol && l.col === 1 ? 0 : 0;
    const colX1 = twoCol && l.col === 1 ? W * 0.53 : W;
    const cap = { x0: Math.min(...capLines.map((c) => c.x)), x1: Math.max(...capLines.map((c) => c.xEnd)), y0: l.y - l.size, y1: capLines[capLines.length - 1].y + 2 };

    let box = null;
    if (kind === 'figure') {
      // Nearest image above (or below) the caption that overlaps horizontally.
      const cands = images.map((b, k) => ({ b, k })).filter(({ b, k }) => !used.has(k) && b.x1 > cap.x0 - 20 && b.x0 < Math.max(cap.x1, colX1) + 20);
      const dist = ({ b }) => (b.y1 <= cap.y0 + 5 ? cap.y0 - b.y1 : b.y0 >= cap.y1 - 5 ? (b.y0 - cap.y1) * 1.5 : 0);
      cands.sort((a, b) => dist(a) - dist(b));
      if (cands[0] && dist(cands[0]) < H * 0.25) {
        box = { ...cands[0].b };
        used.add(cands[0].k);
        // Multi-panel figures: absorb other nearby images.
        images.forEach((b, k) => { if (!used.has(k) && b.y1 > box.y0 - 30 && b.y0 < box.y1 + 30 && b.x1 > box.x0 - 40 && b.x0 < box.x1 + 40) { box = union(box, b); used.add(k); } });
      } else {
        // Vector figure: take the text-free gap above the caption in this column.
        const above = lines.filter((m) => m !== l && m.col === l.col && m.y < cap.y0 && !m.caption && !m.inCaption);
        const prevBottom = above.length ? Math.max(...above.map((m) => m.y)) + 3 : H * 0.07;
        if (cap.y0 - prevBottom > 60) box = { x0: colX0 + 10, x1: colX1 - 10, y0: prevBottom, y1: cap.y0 };
      }
      if (!box) {
        // Caption separated from its image (e.g. flowed into the other column):
        // pair it with the largest unused image on the page and crop the image alone.
        const free = images.map((b, k) => ({ b, k })).filter(({ k }) => !used.has(k))
          .sort((a, b) => (b.b.x1 - b.b.x0) * (b.b.y1 - b.b.y0) - (a.b.x1 - a.b.x0) * (a.b.y1 - a.b.y0));
        if (!free.length) continue;
        used.add(free[0].k);
        const b = free[0].b;
        regions.push({ x0: Math.max(0, b.x0 - 6), y0: Math.max(0, b.y0 - 6), x1: Math.min(W, b.x1 + 6), y1: Math.min(H, b.y1 + 6), kind, label, caption, capLine: l });
        continue;
      }
      box = union(box, cap);
    } else {
      // Table: caption on top, then rows until ordinary body prose resumes.
      let y1 = cap.y1;
      let prose = 0;
      for (let j = i + capLines.length; j < lines.length; j++) {
        const n = lines[j];
        if (n.col !== l.col) continue;
        if (n.y < cap.y0) continue;
        if (n.caption || (n.bold && n.size >= body - 0.3 && n.gaps === 0) || n.size > body * 1.1) break;
        if (n.y - y1 > n.size * 3.5) break;
        const isProse = Math.abs(n.size - body) < 0.4 && n.gaps === 0 && (n.xEnd - n.x) > (colX1 - colX0) * 0.7;
        prose = isProse ? prose + 1 : 0;
        if (prose >= 2) break;
        if (!isProse) y1 = n.y + 2;
      }
      if (y1 - cap.y1 < 15) continue;
      box = { x0: cap.x0, x1: cap.x1, y0: cap.y0, y1 };
      // Widen to the actual extent of table rows.
      const rows = lines.filter((n) => n.col === l.col && n.y >= box.y0 && n.y <= box.y1);
      if (rows.length) { box.x0 = Math.min(box.x0, ...rows.map((r) => r.x)); box.x1 = Math.max(box.x1, ...rows.map((r) => r.xEnd)); }
    }
    box = { x0: Math.max(0, box.x0 - 6), y0: Math.max(0, box.y0 - 6), x1: Math.min(W, box.x1 + 6), y1: Math.min(H, box.y1 + 6) };
    regions.push({ ...box, kind, label, caption, capLine: l });
  }
  return regions;
}
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const overlapsX = (l, x0, x1) => l.xEnd > x0 && l.x < x1;

let webpOk = null;
async function cropRegions(page, pn, regions, state) {
  const vp = page.getViewport({ scale: CROP_SCALE });
  const canvas = new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  for (const [k, r] of regions.entries()) {
    const w = Math.round((r.x1 - r.x0) * CROP_SCALE), h = Math.round((r.y1 - r.y0) * CROP_SCALE);
    if (w < 40 || h < 30) continue;
    const out = new OffscreenCanvas(w, h);
    out.getContext('2d').drawImage(canvas, r.x0 * CROP_SCALE, r.y0 * CROP_SCALE, w, h, 0, 0, w, h);
    let blob = webpOk !== false ? await out.convertToBlob({ type: 'image/webp', quality: 0.8 }) : null;
    if (webpOk === null) webpOk = blob?.type === 'image/webp';
    if (!webpOk) blob = await out.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const name = `p${pn}-${k}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
    const image_path = await db.uploadFigure(state.book.id, name, blob);
    state.figures.push({ page: pn, kind: r.kind, label: r.label, caption: r.caption.slice(0, 1000), image_path, width: w, height: h, section_key: r.sectionKey || state.sectionKey });
  }
}

/** Dev helper: the classified lines of one page (used to tune heuristics on a new book). */
export async function debugPage(data, pn, body = 10) {
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const page = await pdf.getPage(pn);
  const vp = page.getViewport({ scale: 1 });
  const [tc, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  const items = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = pdfjs.Util.transform(vp.transform, it.transform);
    const size = Math.hypot(t[2], t[3]);
    items.push({ str: it.str, x: t[4], y: t[5], size, w: it.width * (size / Math.hypot(it.transform[2], it.transform[3]) || 1), bold: isBold(page, it.fontName, tc.styles), font: page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName).name : it.fontName });
  }
  const twoCol = detectTwoColumns(items, vp.width, body);
  const lines = orderLines(buildLines(items, vp.width, twoCol, body), twoCol);
  return { twoCol, images: imageBoxes(ops, vp), fonts: [...new Set(items.map((i) => i.font + (i.bold ? '*' : '')))], lines: lines.map((l) => `${l.col} y${Math.round(l.y)} x${Math.round(l.x)}-${Math.round(l.xEnd)} s${l.size.toFixed(1)}${l.bold ? 'B' : ''}${l.caption ? 'CAP' : ''} ${l.text.slice(0, 70)}`) };
}

/** Dev helper: run the full page walk without saving anything; returns paragraphs/chunks. */
export async function debugWalk(data, body = 10) {
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const state = { book: { id: 'dbg' }, body, repeated: new Set(), outline: await flattenOutline(pdf), chapter: null, section: null, sectionKey: 'start',
    headingCount: 0, para: null, chunk: null, ready: [], figures: [], sections: [], dryRun: true };
  for (let pn = 1; pn <= pdf.numPages; pn++) await processPage(await pdf.getPage(pn), pn, state);
  flushPara(state, true); flushChunk(state);
  return { outline: state.outline, sections: state.sections.map((s) => `${s.level}:${s.title}@${s.page_start}`), chunks: state.ready };
}

// Dev-only access to the stages, for diagnosing a specific book.
export const _stages = { flattenOutline, analyseFonts, processPage, pdfjs };
