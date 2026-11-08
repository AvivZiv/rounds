import { WORDS_PER_MINUTE, SECONDS_PER_FIGURE } from '../config.js';

const STOP = new Set(('a an and are as at be by for from has have how in into is it its of on or that the this to was were what when where which why with ' +
  'learn learning about vs versus basic basics review understand ' +
  // generic medical words that appear on almost every page and would drown out the real topic
  'disease diseases syndrome syndromes disorder disorders patient patients condition conditions approach clinical').split(' '));

export function tokenize(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Fraction of query terms present in text (prefix match handles plurals/inflections). */
export function keywordScore(qTokens, text) {
  if (!qTokens.length) return 0;
  const t = ' ' + (text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
  let hits = 0;
  for (const q of qTokens) if (t.includes(' ' + q.slice(0, Math.max(4, q.length - 2)))) hits++;
  return hits / qTokens.length;
}

export function cosine(a, b) {
  // Vectors are L2-normalised at embed time, so the dot product is the cosine.
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export const wordCount = (s) => (s.match(/\S+/g) || []).length;

export function readingMinutes(words, figures = 0) {
  return words / WORDS_PER_MINUTE + (figures * SECONDS_PER_FIGURE) / 60;
}

export function formatMinutes(m) {
  if (m == null) return '…';
  if (m < 1) return '<1 min';
  if (m < 60) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
}

/** Sentence spans [start, end) over a passage string. Avoids splitting on "e.g." / "Fig." etc. */
export function sentenceSpans(text) {
  const spans = [];
  const re = /[^.!?]+(?:[.!?]+(?=\s+[A-Z(\[]|\s*$)|$)/g;
  let m, start = 0, buf = '';
  const abbrev = /\b(e\.g|i\.e|Fig|fig|Figs|vs|al|etc|approx|Dr|No|cf|ca)\.$/;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (!buf) start = m.index;
    buf += m[0];
    if (abbrev.test(buf.trimEnd()) && re.lastIndex < text.length) continue;
    const lead = buf.length - buf.trimStart().length;
    spans.push([start + lead, start + buf.trimEnd().length]);
    buf = '';
  }
  return spans.filter(([a, b]) => b - a > 20);
}

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
