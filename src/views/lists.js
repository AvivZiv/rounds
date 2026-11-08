import { store } from '../store.js';
import { db } from '../db/index.js';
import { captureHTML, bindCapture, itemRowHTML, bindReorder } from './common.js';
import { esc, icon, $, toast, confirmDialog } from '../ui.js';

export function renderLists(root) {
  const count = (l) => store.items.filter((i) => i.list_id === l.id && i.status === 'open').length;
  root.innerHTML = `
    <header class="page-head"><h1>Lists</h1></header>
    <ul class="lists">
      ${store.lists.map((l) => `<li><a href="#/list/${l.id}"><span>${esc(l.name)}${l.is_default ? ' <span class="muted small">(default)</span>' : ''}</span><span class="count">${count(l)}</span></a></li>`).join('')}
    </ul>
    <form class="new-list row">
      <input name="name" placeholder="New list, e.g. Neurology rotation" required>
      <button class="btn">${icon('plus')} Add</button>
    </form>`;
  $('.new-list', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    const l = await db.createList({ name, position: Date.now() });
    store.lists.push(l); store.emit();
  });
}

export function renderList(root, id) {
  const list = store.list(id);
  if (!list) { root.innerHTML = '<p class="empty">List not found.</p>'; return; }
  const items = store.items.filter((i) => i.list_id === id);
  const open = items.filter((i) => i.status === 'open').sort((a, b) => a.position - b.position);
  const done = items.filter((i) => i.status === 'done').sort((a, b) => (b.done_at || '').localeCompare(a.done_at || ''));
  root.innerHTML = `
    <header class="page-head row">
      <a href="#/lists" class="back" aria-label="Back">${icon('back')}</a>
      <h1 class="grow">${esc(list.name)}</h1>
      <details class="menu"><summary aria-label="List options">${icon('more')}</summary>
        <div class="menu-pop">
          <button data-act="rename">Rename</button>
          ${list.is_default ? '' : '<button data-act="default">Make default</button><button data-act="delete" class="danger">Delete list</button>'}
        </div></details>
    </header>
    ${captureHTML({ listId: id })}
    <p class="muted small">Drag ${icon('grip')} to set priority — top is most important.</p>
    <ul class="items sortable">${open.map((i) => itemRowHTML(i, { draggable: true })).join('') || '<li class="empty">No open items.</li>'}</ul>
    ${done.length ? `<details class="done-group"><summary>Done (${done.length})</summary><ul class="items">${done.map((i) => itemRowHTML(i)).join('')}</ul></details>` : ''}
  `;
  bindCapture(root);
  bindReorder($('.sortable', root), async (ids) => {
    // Positions are spaced floats so a single move only rewrites what changed.
    const updates = [];
    ids.forEach((iid, idx) => { const it = store.item(iid); if (it && it.position !== idx) updates.push([iid, idx]); });
    for (const [iid, pos] of updates) { const it = store.item(iid); it.position = pos; }
    await Promise.all(updates.map(([iid, pos]) => db.updateItem(iid, { position: pos })));
  });
  root.querySelector('.menu')?.addEventListener('click', async (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    if (act === 'rename') {
      const name = prompt('List name', list.name)?.trim();
      if (name) { Object.assign(list, await db.updateList(id, { name })); store.emit(); }
    } else if (act === 'default') {
      for (const l of store.lists) if (l.is_default) Object.assign(l, await db.updateList(l.id, { is_default: false }));
      Object.assign(list, await db.updateList(id, { is_default: true })); store.emit(); toast('New items go here by default');
    } else if (act === 'delete') {
      if (!(await confirmDialog(`Delete "${list.name}"? Its items move to your default list.`))) return;
      const def = store.defaultList();
      for (const it of store.items.filter((i) => i.list_id === id)) await store.updateItem(it.id, { list_id: def.id });
      await db.deleteList(id);
      store.lists = store.lists.filter((l) => l.id !== id);
      location.hash = '#/lists';
      store.emit();
    }
  });
}
