// In-memory app state, loaded from the backend and kept in sync on writes.
import { db } from './db/index.js';
import { buildLesson, librarySignature } from './lib/lesson.js';

export const store = {
  lists: [], items: [], books: [], settings: { career_interest: '', emphasis: [], theme: 'auto' },
  listeners: new Set(),
  emit() { this.listeners.forEach((fn) => fn()); },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },

  async load() {
    [this.lists, this.items, this.books, this.settings] = await Promise.all([db.listLists(), db.listItems(), db.listBooks(), db.getSettings()]);
    if (!this.lists.length) {
      this.lists = [await db.createList({ name: 'Inbox', is_default: true, position: 0 }), await db.createList({ name: 'Curiosity', position: 1 })];
    }
    this.emit();
  },
  defaultList() { return this.lists.find((l) => l.is_default) || this.lists[0]; },
  list(id) { return this.lists.find((l) => l.id === id); },
  item(id) { return this.items.find((i) => i.id === id); },
  book(id) { return this.books.find((b) => b.id === id); },

  async addItem(row) {
    const item = await db.createItem({ list_id: this.defaultList()?.id, ...row });
    this.items.push(item); this.emit();
    queueEstimate(item.id);
    return item;
  },
  async updateItem(id, patch) {
    const before = this.item(id);
    const item = await db.updateItem(id, patch);
    this.items = this.items.map((i) => (i.id === id ? item : i)); this.emit();
    if (before && (patch.title && patch.title !== before.title || 'preferred_book_id' in patch && patch.preferred_book_id !== before.preferred_book_id)) {
      await invalidate(id); queueEstimate(id);
    }
    return item;
  },
  async deleteItem(id) { await db.deleteItem(id); this.items = this.items.filter((i) => i.id !== id); this.emit(); },
  async refreshBooks() { this.books = await db.listBooks(); this.emit(); },
  async saveSettings(s) { this.settings = await db.saveSettings({ ...this.settings, ...s }); this.emit(); },
};

// ---------------------------------------------------------------- lessons
const building = new Map();

/** Returns a cached lesson if it was built from the current library, otherwise builds and stores it. */
export async function getLesson(item, depth, { force = false, onStep } = {}) {
  const sig = librarySignature(store.books) + `|${item.title}|${item.preferred_book_id || ''}|${(store.settings.emphasis || []).join(',')}`;
  const key = `${item.id}:${depth}`;
  if (!force) {
    const cached = await db.getLesson(item.id, depth);
    if (cached && cached.library_sig === sig) return cached;
  }
  if (building.has(key)) return building.get(key);
  const pr = (async () => {
    const content = await buildLesson(item, depth, { books: store.books, settings: store.settings, onStep });
    const row = await db.saveLesson(item.id, depth, content, sig);
    const patch = depth === 'basic' ? { est_basic_min: content.minutes } : { est_expanded_min: content.minutes };
    patch.coverage = content.status === 'ok' ? 'covered' : content.status === 'no_coverage' ? 'none' : null;
    const updated = await db.updateItem(item.id, patch);
    store.items = store.items.map((i) => (i.id === item.id ? updated : i)); store.emit();
    return row;
  })();
  building.set(key, pr);
  try { return await pr; } finally { building.delete(key); }
}

async function invalidate(itemId) {
  const updated = await db.updateItem(itemId, { est_basic_min: null, est_expanded_min: null, coverage: null });
  store.items = store.items.map((i) => (i.id === itemId ? updated : i)); store.emit();
}

// Background estimates: build both depths for items that have none yet (one at a time).
const queue = [];
let running = false;
export function queueEstimate(id) { if (!queue.includes(id)) queue.push(id); pump(); }
export function queueMissingEstimates() {
  if (!store.books.some((b) => b.status === 'ready')) return;
  for (const i of store.items) if (i.status === 'open' && (i.est_basic_min == null || i.est_expanded_min == null) && i.coverage !== 'none') queueEstimate(i.id);
}
async function pump() {
  if (running || !store.books.some((b) => b.status === 'ready')) return;
  running = true;
  try {
    while (queue.length) {
      const item = store.item(queue.shift());
      if (!item) continue;
      try {
        const basic = await getLesson(item, 'basic');
        if (basic.content.status === 'ok') await getLesson(store.item(item.id), 'expanded');
      } catch (e) { console.warn('estimate failed', e); }
    }
  } finally { running = false; }
}
