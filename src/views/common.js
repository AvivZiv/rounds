import { store } from '../store.js';
import { esc, icon, dueLabel, daysUntil, toast, $ } from '../ui.js';
import { formatMinutes } from '../lib/text.js';

/** Quick capture: one text field; Advanced is collapsed by default. */
export function captureHTML({ listId } = {}) {
  const lists = store.lists.map((l) => `<option value="${l.id}" ${l.id === (listId || store.defaultList()?.id) ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const books = store.books.map((b) => `<option value="${b.id}">${esc(b.title)}</option>`).join('');
  return `
  <form class="capture" autocomplete="off">
    <div class="capture-row">
      <input name="title" class="capture-input" placeholder="What do you need to learn?" enterkeyhint="done" aria-label="New learning item" required>
      <button class="btn primary" type="submit" aria-label="Save">${icon('plus')}</button>
    </div>
    <details class="advanced">
      <summary>Advanced</summary>
      <div class="adv-grid">
        <label>List<select name="list_id">${lists}</select></label>
        <label>Deadline<input type="date" name="deadline"></label>
        <label>Depth<select name="depth"><option value="basic">Basic</option><option value="expanded">Expanded</option></select></label>
        <label>Preferred book<select name="preferred_book_id"><option value="">Automatic</option>${books}</select></label>
        <label class="span2">Note<input name="note" placeholder="e.g. patient in bed 4 with vertigo"></label>
      </div>
    </details>
  </form>`;
}

export function bindCapture(root, onSaved) {
  const form = $('.capture', root);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const title = f.get('title').trim();
    if (!title) return;
    const row = { title, list_id: f.get('list_id') || store.defaultList()?.id, depth: f.get('depth') || 'basic' };
    if (f.get('deadline')) row.deadline = f.get('deadline');
    if (f.get('preferred_book_id')) row.preferred_book_id = f.get('preferred_book_id');
    if (f.get('note')?.trim()) row.note = f.get('note').trim();
    form.reset();
    if (row.list_id) form.list_id.value = row.list_id;
    $('.capture-input', form).focus();
    try { await store.addItem(row); toast('Saved'); onSaved?.(); } catch (err) { toast('Could not save: ' + err.message); }
  });
}

export function estimateHTML(item) {
  if (item.coverage === 'none') return `<span class="muted small">Not covered in your books</span>`;
  if (!store.books.some((b) => b.status === 'ready')) return '';
  const b = item.est_basic_min, x = item.est_expanded_min;
  if (b == null && x == null) return '';
  return `<span class="est small">${icon('clock')} ${formatMinutes(b)} <span class="muted">· expanded ${formatMinutes(x)}</span></span>`;
}

/** Progress ring: share of an item's tree you have read. */
export function ringSVG(p, size = 38) {
  const r = size / 2 - 3, c = 2 * Math.PI * r, f = p?.total ? p.read / p.total : 0;
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-bg"/>${f ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-fg" stroke-dasharray="${(f * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}${f >= 0.999 ? `<path class="ring-ok" d="M${size * 0.34} ${size * 0.52}l${size * 0.11} ${size * 0.11} ${size * 0.2}-${size * 0.24}"/>` : ''}</svg>`;
}

export function itemRowHTML(item, { showList = false, draggable = false } = {}) {
  const list = showList ? store.list(item.list_id) : null;
  let due = '';
  if (item.deadline && item.status !== 'done') {
    const n = daysUntil(item.deadline);
    due = `<span class="chip ${n < 0 ? 'overdue' : n <= 2 ? 'soon' : ''}">${icon('calendar')} ${esc(dueLabel(item.deadline))}</span>`;
  }
  const review = item.review_date && item.status === 'done' ? `<span class="chip review">${icon('repeat')} review ${esc(dueLabel(item.review_date))}</span>` : '';
  const p = store.progress[item.id];
  return `
  <li class="item ${item.status === 'done' ? 'done' : ''}" data-id="${item.id}">
    ${draggable ? `<span class="handle" aria-label="Drag to reorder" title="Drag to reorder">${icon('grip')}</span>` : ''}
    <a class="item-ring" href="#/item/${item.id}" aria-hidden="true" tabindex="-1">${ringSVG(p)}</a>
    <a class="item-main" href="#/item/${item.id}">
      <span class="item-title">${esc(item.title)}</span>
      <span class="item-meta">${p?.total ? `<span class="prog">${p.read ? `${p.read} of ${p.total} read` : 'Not started'}</span>` : ''}${list ? `<span class="chip list">${esc(list.name)}</span>` : ''}${due}${review}</span>
    </a>
  </li>`;
}

/** Pointer-based drag reorder (works with touch). Calls onReorder(ids) at the end. */
export function bindReorder(ul, onReorder) {
  let drag = null;
  ul.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    if (!handle) return;
    const li = handle.closest('li');
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    drag = { li, handle, startY: e.clientY };
    li.classList.add('dragging');
  });
  ul.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { li } = drag;
    const siblings = [...ul.children].filter((c) => c !== li && c.matches('li.item'));
    const after = siblings.find((s) => { const r = s.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (after) ul.insertBefore(li, after); else ul.append(li);
  });
  const end = () => {
    if (!drag) return;
    drag.li.classList.remove('dragging');
    drag = null;
    onReorder([...ul.querySelectorAll('li.item')].map((li) => li.dataset.id));
  };
  ul.addEventListener('pointerup', end);
  ul.addEventListener('pointercancel', end);
}
