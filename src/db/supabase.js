// Supabase backend: auth, Postgres (with pgvector) and PRIVATE storage buckets.
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_EMAIL } from '../config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

function check({ data, error }) { if (error) throw new Error(error.message); return data; }
const vec = (arr) => `[${Array.from(arr, (x) => x.toFixed(6)).join(',')}]`;
const parseVec = (v) => (typeof v === 'string' ? Float32Array.from(JSON.parse(v)) : v ? Float32Array.from(v) : null);
const now = () => new Date().toISOString();

const urlCache = new Map(); // path -> {url, exp}
let noteUnavailable = false;
let userId = null;

async function uidPrefix() {
  if (!userId) userId = (await sb.auth.getUser()).data.user?.id;
  return userId;
}

async function inBatches(rows, size, fn) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

export const supabase = {
  mode: 'supabase',
  // ---- auth: single owner, password only
  async session() { return (await sb.auth.getSession()).data.session; },
  async signIn(password) {
    const data = check(await sb.auth.signInWithPassword({ email: OWNER_EMAIL, password }));
    userId = data.user.id;
    return data.session;
  },
  async signOut() { userId = null; await sb.auth.signOut(); },

  // ---- lists
  async listLists() { return check(await sb.from('lists').select('*').order('position')); },
  async createList(row) { return check(await sb.from('lists').insert({ position: Date.now(), ...row }).select().single()); },
  async updateList(id, patch) { return check(await sb.from('lists').update(patch).eq('id', id).select().single()); },
  async deleteList(id) { check(await sb.from('lists').delete().eq('id', id)); },

  // ---- items
  async listItems() { return check(await sb.from('items').select('*').order('position')); },
  async getItem(id) { return check(await sb.from('items').select('*').eq('id', id).maybeSingle()); },
  async createItem(row) { return check(await sb.from('items').insert({ position: Date.now(), ...row }).select().single()); },
  async updateItem(id, patch) { return check(await sb.from('items').update({ ...patch, updated_at: now() }).eq('id', id).select().single()); },
  async deleteItem(id) { check(await sb.from('items').delete().eq('id', id)); },

  // ---- books
  async listBooks() { return check(await sb.from('books').select('*').order('created_at')); },
  async getBook(id) { return check(await sb.from('books').select('*').eq('id', id).maybeSingle()); },
  async createBook(row) { return check(await sb.from('books').insert(row).select().single()); },
  async updateBook(id, patch) { return check(await sb.from('books').update(patch).eq('id', id).select().single()); },
  // A big textbook has tens of thousands of rows and thousands of figure files. Deleting them
  // in one request exceeds Supabase's per-request time limit, so everything goes in small steps.
  async deleteBook(id, onProgress = () => {}) {
    await this.clearBookIndex(id, (f) => onProgress(f * 0.8));
    const uid = await uidPrefix();
    const folder = `${uid}/${id}`;
    for (;;) {
      const { data: files, error } = await sb.storage.from('figures').list(folder, { limit: 500 });
      if (error) throw new Error(error.message);
      if (!files?.length) break;
      check(await sb.storage.from('figures').remove(files.map((f) => `${folder}/${f.name}`)));
      onProgress(0.9);
    }
    await sb.storage.from('books').remove([`${uid}/${id}.pdf`]);
    check(await sb.from('books').delete().eq('id', id));
    onProgress(1);
  },
  async clearBookIndex(id, onProgress = () => {}) {
    const book = check(await sb.from('books').select('page_count').eq('id', id).maybeSingle());
    const pages = Math.max(book?.page_count || 0, 1);
    const STEP = 50; // pages per request (~350 passages)
    for (let p = 0; p <= pages + STEP; p += STEP) {
      // ord = page * 1000 + n for chunks and sections; figures use page directly
      check(await sb.from('chunks').delete().eq('book_id', id).gte('ord', p * 1000).lt('ord', (p + STEP) * 1000));
      check(await sb.from('book_sections').delete().eq('book_id', id).gte('ord', p * 1000).lt('ord', (p + STEP) * 1000));
      check(await sb.from('figures').delete().eq('book_id', id).gte('page', p).lt('page', p + STEP));
      onProgress(Math.min(1, (p + STEP) / pages));
    }
    // anything left outside the expected ranges
    check(await sb.from('chunks').delete().eq('book_id', id));
    check(await sb.from('book_sections').delete().eq('book_id', id));
    check(await sb.from('figures').delete().eq('book_id', id));
  },
  async uploadBookFile(bookId, file) {
    const path = `${await uidPrefix()}/${bookId}.pdf`;
    check(await sb.storage.from('books').upload(path, file, { upsert: true, contentType: 'application/pdf' }));
    return path;
  },
  async downloadBookFile(path) { return check(await sb.storage.from('books').download(path)); },

  // ---- index
  async insertSections(rows) { await inBatches(rows, 500, async (b) => check(await sb.from('book_sections').insert(b))); },
  async insertChunks(rows) {
    await inBatches(rows, 100, async (b) =>
      check(await sb.from('chunks').insert(b.map((r) => ({ ...r, embedding: vec(r.embedding) })))));
  },
  async insertFigures(rows) { await inBatches(rows, 200, async (b) => check(await sb.from('figures').insert(b))); },
  async uploadFigure(bookId, name, blob) {
    const path = `${await uidPrefix()}/${bookId}/${name}`;
    check(await sb.storage.from('figures').upload(path, blob, { upsert: true, contentType: blob.type }));
    return path;
  },
  async figureUrl(path) {
    const c = urlCache.get(path);
    if (c && c.exp > Date.now()) return c.url;
    const { signedUrl } = check(await sb.storage.from('figures').createSignedUrl(path, 3600));
    urlCache.set(path, { url: signedUrl, exp: Date.now() + 50 * 60 * 1000 });
    return signedUrl;
  },
  async figuresForBook(bookId) { return check(await sb.from('figures').select('*').eq('book_id', bookId)); },
  async figuresByLabels(bookId, labels) {
    if (!labels.length) return [];
    return check(await sb.from('figures').select('*').eq('book_id', bookId).in('label', labels.slice(0, 200)));
  },
  async figuresForPages(bookId, pages) {
    if (!pages.length) return [];
    return check(await sb.from('figures').select('*').eq('book_id', bookId).in('page', pages.slice(0, 300)));
  },

  async searchChunks(embedding, queryText, k = 60, bookIds = null) {
    return check(await sb.rpc('match_chunks', {
      query_embedding: vec(embedding), query_text: queryText, match_count: k, book_filter: bookIds,
    }));
  },
  async sectionChunks(keys) {
    if (!keys.length) return [];
    const rows = check(await sb.rpc('section_chunks', { keys }));
    return rows.map((r) => ({ ...r, embedding: parseVec(r.embedding) }));
  },

  // ---- lessons & highlights
  async getLesson(itemId, depth) {
    return check(await sb.from('lessons').select('*').eq('item_id', itemId).eq('depth', depth).maybeSingle());
  },
  async saveLesson(itemId, depth, content, library_sig) {
    return check(await sb.from('lessons').upsert({ item_id: itemId, depth, content, library_sig, built_at: now() }, { onConflict: 'item_id,depth' }).select().single());
  },
  async listHighlights(lessonId) { return check(await sb.from('highlights').select('*').eq('lesson_id', lessonId)); },
  async addHighlight(row) { return check(await sb.from('highlights').insert(row).select().single()); },
  async deleteHighlight(id) { check(await sb.from('highlights').delete().eq('id', id)); },
  async clearHighlights(lessonId) { check(await sb.from('highlights').delete().eq('lesson_id', lessonId)); },

  // ---- settings
  async getSettings() {
    return check(await sb.from('settings').select('*').maybeSingle()) || { career_interest: '', emphasis: [], theme: 'auto' };
  },
  async saveSettings(s) {
    const { user_id, ...rest } = s;
    return check(await sb.from('settings').upsert({ ...rest, updated_at: now() }).select().single());
  },

  // ---- optional generated connecting note via Edge Function (returns null if not deployed/configured)
  // Optional: stops trying for this session once the function turns out not to be deployed or configured.
  async connectNote(payload) {
    if (noteUnavailable) return null;
    try {
      const { data, error } = await sb.functions.invoke('connect-note', { body: payload });
      if (error || data?.reason === 'no_api_key') { noteUnavailable = true; return null; }
      return data?.note || null;
    } catch { noteUnavailable = true; return null; }
  },
};
