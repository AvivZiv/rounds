import { EMBED_MODEL, QUERY_PREFIX } from '../config.js';

let worker = null;
let seq = 0;
const pending = new Map();
const listeners = new Set();
const queryCache = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/embed.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { listeners.forEach((fn) => fn(data.p)); return; }
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    data.type === 'error' ? p.reject(new Error(data.error)) : p.resolve(data.vectors);
  };
  return worker;
}

export function onModelProgress(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Embed passages (documents). Similar lengths are batched together (less padding); order is preserved. */
export async function embedPassages(texts, group = 256) {
  const order = texts.map((t, i) => i).sort((a, b) => texts[a].length - texts[b].length);
  const out = new Array(texts.length);
  for (let i = 0; i < order.length; i += group) {
    const idx = order.slice(i, i + group);
    const vecs = await call(idx.map((k) => texts[k]));
    idx.forEach((k, j) => (out[k] = vecs[j]));
  }
  return out;
}

/** Embed a search query (bge models expect an instruction prefix for queries). */
export async function embedQuery(text) {
  const key = text.trim().toLowerCase();
  if (queryCache.has(key)) return queryCache.get(key);
  const [v] = await call([QUERY_PREFIX + text]);
  queryCache.set(key, v);
  return v;
}

export async function embedQueries(texts) {
  const missing = texts.filter((t) => !queryCache.has(t.trim().toLowerCase()));
  if (missing.length) {
    const vs = await embedPassages(missing.map((t) => QUERY_PREFIX + t));
    missing.forEach((t, i) => queryCache.set(t.trim().toLowerCase(), vs[i]));
  }
  return texts.map((t) => queryCache.get(t.trim().toLowerCase()));
}

function call(texts) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, model: EMBED_MODEL, texts });
  });
}
