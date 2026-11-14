import { store, getLesson } from '../store.js';
import { esc, icon, $, toast, confirmDialog, todayISO, addDays, dueLabel } from '../ui.js';
import { formatMinutes } from '../lib/text.js';

export function renderItem(root, id) {
  const item = store.item(id);
  if (!item) { root.innerHTML = '<p class="empty">Item not found.</p>'; return; }
  const list = store.list(item.list_id);
  const hasBooks = store.books.some((b) => b.status === 'ready');

  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === (cur ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
  const readBtn = (depth, mins) => `<a class="btn small ghost" href="#/read/${item.id}/${depth}">${depth === 'basic' ? 'Basic' : 'Expanded'} passages${mins != null ? ' · ' + formatMinutes(mins) : ''}</a>`;

  root.innerHTML = `
    <header class="page-head row">
      <a href="${list ? '#/list/' + list.id : '#/today'}" class="back" aria-label="Back">${icon('back')}</a>
      <span class="muted grow">${esc(list?.name || '')}</span>
    </header>
    <form class="item-form">
      <textarea name="title" class="title-edit" rows="2" aria-label="Title">${esc(item.title)}</textarea>
      ${item.status === 'done' ? `<p class="done-banner">${icon('check')} Done${item.done_at ? ' on ' + new Date(item.done_at).toLocaleDateString() : ''}${item.review_date ? ` · review ${esc(dueLabel(item.review_date))}` : ''}</p>` : ''}
      <div class="read-row">
        <a class="read-btn preferred grow" href="#/tree/${item.id}">
          <span class="read-depth">${icon('list')} Open</span>
          <span class="read-time">Short paragraphs, go as deep as you need</span>
        </a>
        <a class="read-btn" href="#/tree/${item.id}/map">
          <span class="read-depth">${icon('repeat')} Review</span>
          <span class="read-time">Map of where you went</span>
        </a>
      </div>
      ${hasBooks ? `<div class="row wrap small-row"><span class="muted small">From your books:</span>${item.coverage === 'none' ? '<span class="muted small">not covered</span>' : readBtn('basic', item.est_basic_min) + readBtn('expanded', item.est_expanded_min)}</div>` : ''}
      <div class="fields">
        <label>List<select name="list_id">${store.lists.map((l) => opt(l.id, item.list_id, l.name)).join('')}</select></label>
        <label>Deadline<input type="date" name="deadline" value="${esc(item.deadline || '')}"></label>
        <label>Default depth<select name="depth">${opt('basic', item.depth, 'Basic')}${opt('expanded', item.depth, 'Expanded')}</select></label>
        <label>Preferred book<select name="preferred_book_id">${opt('', item.preferred_book_id, 'Automatic')}${store.books.map((b) => opt(b.id, item.preferred_book_id, b.title)).join('')}</select></label>
        <label class="span2">Note<input name="note" value="${esc(item.note || '')}" placeholder="Context, e.g. patient in bed 4"></label>
      </div>
    </form>
    <section class="after">
      ${item.status === 'open'
        ? `<button class="btn primary" data-act="done">${icon('check')} Mark as done</button>`
        : `<button class="btn" data-act="reopen">Reopen</button>`}
      <div class="review">
        <span>Review on</span>
        <button class="btn small ghost" data-review="3">3 days</button>
        <button class="btn small ghost" data-review="7">1 week</button>
        <button class="btn small ghost" data-review="30">1 month</button>
        <input type="date" name="review_date" value="${esc(item.review_date || '')}" aria-label="Review date">
        ${item.review_date ? '<button class="btn small ghost" data-act="clear-review">Clear</button>' : ''}
      </div>
      ${hasBooks && item.coverage !== 'none' ? '' : (hasBooks ? `<button class="btn small ghost" data-act="recheck">Check books again</button>` : '')}
      <button class="btn ghost danger" data-act="delete">${icon('trash')} Delete item</button>
    </section>`;

  const form = $('.item-form', root);
  const save = async (patch) => { try { await store.updateItem(id, patch); } catch (e) { toast('Could not save: ' + e.message); } };
  form.addEventListener('change', (e) => {
    const { name, value } = e.target;
    if (name === 'title') { if (value.trim()) save({ title: value.trim() }); return; }
    save({ [name]: value || null });
  });
  form.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });

  root.querySelector('.after').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.review) { await save({ review_date: addDays(todayISO(), +b.dataset.review) }); toast(`It will reappear in Today on ${dueLabel(addDays(todayISO(), +b.dataset.review))}`); }
    else if (b.dataset.act === 'done') await save({ status: 'done', done_at: new Date().toISOString() });
    else if (b.dataset.act === 'reopen') await save({ status: 'open', done_at: null });
    else if (b.dataset.act === 'clear-review') await save({ review_date: null });
    else if (b.dataset.act === 'recheck') { toast('Checking your books…'); await getLesson(item, 'basic', { force: true }); }
    else if (b.dataset.act === 'delete') {
      if (await confirmDialog('Delete this item and its saved lessons and highlights?')) { await store.deleteItem(id); location.hash = list ? '#/list/' + list.id : '#/today'; }
    }
  });
  root.querySelector('[name=review_date]').addEventListener('change', (e) => save({ review_date: e.target.value || null }));
}
