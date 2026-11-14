// Local backend: IndexedDB in this browser only. Same interface as supabase.js.
import { cosine, keywordScore, tokenize } from '../lib/text.js';

const DB_NAME = 'rounds-local';
const STORES = ['lists', 'items', 'books', 'book_sections', 'chunks', 'figures', 'lessons', 'highlights', 'settings', 'files', 'tree_nodes', 'node_marks'];
const LOCAL_USER = 'local-user';

let dbp;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (db.objectStoreNames.contains(s)) continue;
        const os = db.createObjectStore(s, { keyPath: s === 'settings' ? 'user_id' : (s === 'files' ? 'path' : 'id') });
        if (['book_sections', 'chunks', 'figures'].includes(s)) os.createIndex('book_id', 'book_id');
        if (s === 'chunks') os.createIndex('section_key', 'section_key');
        if (s === 'highlights') os.createIndex('lesson_id', 'lesson_id');
        if (s === 'lessons') os.createIndex('item_id', 'item_id');
        if (s === 'tree_nodes') { os.createIndex('item_id', 'item_id'); os.createIndex('parent_id', 'parent_id'); }
        if (s === 'node_marks') os.createIndex('node_id', 'node_id');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function p(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
async function tx(store, mode = 'readonly') { return (await open()).transaction(store, mode).objectStore(store); }
async function all(store) { return p((await tx(store)).getAll()); }
async function byIndex(store, index, value) { return p((await tx(store)).index(index).getAll(value)); }
async function get(store, key) { return p((await tx(store)).get(key)); }
async function put(store, row) { await p((await tx(store, 'readwrite')).put(row)); return row; }
async function del(store, key) { return p((await tx(store, 'readwrite')).delete(key)); }
async function putMany(store, rows) {
  const db = await open();
  await new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const r of rows) os.put(r);
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}
async function delByIndex(store, index, value) {
  const db = await open();
  await new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    const req = t.objectStore(store).index(index).openKeyCursor(IDBKeyRange.only(value));
    req.onsuccess = () => { const c = req.result; if (c) { t.objectStore(store).delete(c.primaryKey); c.continue(); } };
    t.oncomplete = res; t.onerror = () => rej(t.error);
  });
}

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const withMeta = (row) => ({ id: uid(), user_id: LOCAL_USER, created_at: now(), ...row });

// Small in-memory cache of chunks for brute-force search (rebuilt when books change).
let chunkCache = null;
async function chunks() { if (!chunkCache) chunkCache = await all('chunks'); return chunkCache; }

export const local = {
  mode: 'local',
  // ---- auth (no-op)
  async session() { return { user: { id: LOCAL_USER } }; },
  async signIn() { return { user: { id: LOCAL_USER } }; },
  async signOut() {},

  // ---- lists
  async listLists() { return (await all('lists')).sort((a, b) => a.position - b.position); },
  async createList(row) { return put('lists', withMeta({ position: Date.now(), is_default: false, ...row })); },
  async updateList(id, patch) { return put('lists', { ...(await get('lists', id)), ...patch }); },
  async deleteList(id) {
    for (const it of (await all('items')).filter((i) => i.list_id === id)) await put('items', { ...it, list_id: null });
    return del('lists', id);
  },

  // ---- items
  async listItems() { return (await all('items')).sort((a, b) => a.position - b.position); },
  async getItem(id) { return get('items', id); },
  async createItem(row) {
    return put('items', withMeta({ depth: 'basic', status: 'open', position: Date.now(), updated_at: now(), ...row }));
  },
  async updateItem(id, patch) { return put('items', { ...(await get('items', id)), ...patch, updated_at: now() }); },
  async deleteItem(id) {
    for (const l of await byIndex('lessons', 'item_id', id)) { await delByIndex('highlights', 'lesson_id', l.id); await del('lessons', l.id); }
    return del('items', id);
  },

  // ---- books
  async listBooks() { return (await all('books')).sort((a, b) => a.created_at.localeCompare(b.created_at)); },
  async getBook(id) { return get('books', id); },
  async createBook(row) { return put('books', withMeta({ status: 'pending', processed_pages: 0, ...row })); },
  async updateBook(id, patch) { return put('books', { ...(await get('books', id)), ...patch }); },
  async deleteBook(id, onProgress = () => {}) {
    const book = await get('books', id);
    for (const f of await byIndex('figures', 'book_id', id)) await del('files', f.image_path);
    if (book?.file_path) await del('files', book.file_path);
    await delByIndex('chunks', 'book_id', id);
    await delByIndex('figures', 'book_id', id);
    await delByIndex('book_sections', 'book_id', id);
    chunkCache = null;
    await del('books', id);
    onProgress(1);
  },
  async clearBookIndex(id) {
    await delByIndex('chunks', 'book_id', id); await delByIndex('figures', 'book_id', id); await delByIndex('book_sections', 'book_id', id);
    chunkCache = null;
  },
  async uploadBookFile(bookId, file) {
    const path = `${LOCAL_USER}/${bookId}.pdf`;
    await put('files', { path, blob: file });
    return path;
  },
  async downloadBookFile(path) { return (await get('files', path))?.blob ?? null; },

  // ---- index
  async insertSections(rows) { await putMany('book_sections', rows.map((r) => withMeta(r))); },
  async insertChunks(rows) {
    await putMany('chunks', rows.map((r) => withMeta({ ...r, embedding: Float32Array.from(r.embedding) })));
    chunkCache = null;
  },
  async insertFigures(rows) { await putMany('figures', rows.map((r) => withMeta(r))); },
  async uploadFigure(bookId, name, blob) {
    const path = `${LOCAL_USER}/${bookId}/${name}`;
    await put('files', { path, blob });
    return path;
  },
  async figureUrl(path) { const f = await get('files', path); return f ? URL.createObjectURL(f.blob) : null; },
  async figuresForBook(bookId) { return byIndex('figures', 'book_id', bookId); },
  async figuresByLabels(bookId, labels) { const set = new Set(labels); return (await byIndex('figures', 'book_id', bookId)).filter((f) => set.has(f.label)); },
  async figuresForPages(bookId, pages) { const set = new Set(pages); return (await byIndex('figures', 'book_id', bookId)).filter((f) => set.has(f.page)); },

  /** Hybrid search: vector similarity + keyword overlap, fused by reciprocal rank. */
  async searchChunks(embedding, queryText, k = 60, bookIds = null) {
    let rows = await chunks();
    if (bookIds) rows = rows.filter((r) => bookIds.includes(r.book_id));
    const qTokens = tokenize(queryText);
    const scored = rows.map((r) => ({ r, sim: cosine(embedding, r.embedding), kw: keywordScore(qTokens, (r.section || '') + ' ' + r.text) }));
    const bySim = [...scored].sort((a, b) => b.sim - a.sim).slice(0, k * 2);
    const byKw = scored.filter((s) => s.kw > 0).sort((a, b) => b.kw - a.kw).slice(0, k * 2);
    const fused = new Map();
    bySim.forEach((s, i) => fused.set(s.r.id, { s, rrf: 1 / (61 + i) }));
    byKw.forEach((s, i) => { const f = fused.get(s.r.id) || { s, rrf: 0 }; f.rrf += 1 / (61 + i); fused.set(s.r.id, f); });
    return [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, k)
      .map(({ s, rrf }) => ({ ...s.r, embedding: undefined, similarity: s.sim, keyword_rank: s.kw, score: rrf }));
  },
  async sectionChunks(keys) {
    const set = new Set(keys);
    return (await chunks()).filter((c) => set.has(c.section_key)).sort((a, b) => a.book_id.localeCompare(b.book_id) || a.ord - b.ord);
  },

  // ---- lessons & highlights
  async getLesson(itemId, depth) { return (await byIndex('lessons', 'item_id', itemId)).find((l) => l.depth === depth) || null; },
  async saveLesson(itemId, depth, content, library_sig) {
    const existing = await this.getLesson(itemId, depth);
    return put('lessons', { ...(existing || withMeta({})), item_id: itemId, depth, content, library_sig, built_at: now() });
  },
  async listHighlights(lessonId) { return byIndex('highlights', 'lesson_id', lessonId); },
  async addHighlight(row) { return put('highlights', withMeta(row)); },
  async deleteHighlight(id) { return del('highlights', id); },
  async clearHighlights(lessonId) { return delByIndex('highlights', 'lesson_id', lessonId); },

  // ---- settings
  async getSettings() { return (await get('settings', LOCAL_USER)) || { user_id: LOCAL_USER, career_interest: '', emphasis: [], theme: 'auto' }; },
  async saveSettings(s) { return put('settings', { ...s, user_id: LOCAL_USER, updated_at: now() }); },

  // ---- optional generated connecting note (needs the Supabase edge function)
  async connectNote() { return null; },

  // ---- knowledge tree. In local mode generation runs through the Vite dev hook (/__tree),
  // which calls Claude Code on this machine; there is no queue.
  async listNodes(itemId) { return (await byIndex('tree_nodes', 'item_id', itemId)).sort((a, b) => a.depth - b.depth || a.ord - b.ord); },
  async requestTree(itemId, nodeId = null) {
    const item = await get('items', itemId);
    const settings = await this.getSettings();
    const level = [settings.career_interest, settings.emphasis?.length ? 'emphasise ' + settings.emphasis.join(', ') : ''].filter(Boolean).join('; ');
    const all = await this.listNodes(itemId);
    let ctx = null, node = null;
    if (nodeId) {
      node = all.find((n) => n.id === nodeId);
      if (!node || node.children === 'ready') return;
      await put('tree_nodes', { ...node, children: 'pending' });
      const byId = new Map(all.map((n) => [n.id, n]));
      const ancestors = [];
      for (let p_ = byId.get(node.parent_id); p_; p_ = byId.get(p_.parent_id)) ancestors.unshift({ label: p_.label, text: p_.text });
      ctx = { node: { label: node.label, text: node.text, depth: node.depth }, ancestors, siblings: all.filter((n) => n.parent_id === node.parent_id && n.id !== node.id).map((n) => ({ label: n.label })) };
    } else if (all.some((n) => !n.parent_id)) return;
    try {
      const res = await fetch('/__tree', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { topic: item.title, note: item.note, level }, ctx }) });
      const g = await res.json();
      if (!res.ok) throw new Error(g.error || res.statusText);
      let parentId = nodeId, depth = node ? node.depth + 1 : 1;
      if (!nodeId) {
        const rootRow = withMeta({ item_id: itemId, parent_id: null, depth: 0, ord: 0, label: item.title, text: g.root.summary, expandable: true, children: 'ready', topic_type: g.root.topic_type, model: g.model });
        await put('tree_nodes', rootRow); parentId = rootRow.id;
      }
      await putMany('tree_nodes', g.nodes.map((n) => withMeta({ item_id: itemId, parent_id: parentId, depth, ...n, children: 'none', model: g.model })));
      if (node) await put('tree_nodes', { ...node, children: 'ready' });
    } catch (e) {
      if (node) await put('tree_nodes', { ...node, children: 'none' });
      throw e;
    }
  },
  /** Local mode has no background generator: results arrive when requestTree resolves. */
  subscribeTree(itemId, onChange) { return () => {}; },
  async pendingRequest() { return null; },
  async listMarks(itemId) { const ids = new Set((await byIndex('tree_nodes', 'item_id', itemId)).map((n) => n.id)); return (await all('node_marks')).filter((m) => ids.has(m.node_id)); },
  async markVisited(nodeId, count) { const n = await get('tree_nodes', nodeId); if (n) await put('tree_nodes', { ...n, visited_at: now(), visit_count: count }); },
  async setMark(nodeId, style) {
    const existing = (await byIndex('node_marks', 'node_id', nodeId))[0];
    if (!style) { if (existing) await del('node_marks', existing.id); return null; }
    return put('node_marks', { ...(existing || withMeta({})), node_id: nodeId, style });
  },
  async clearTree(itemId) { await delByIndex('tree_nodes', 'item_id', itemId); },
};
