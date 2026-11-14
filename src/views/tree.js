// Knowledge tree: a feed of short nodes, each opening into its own feed. Breadcrumbs go back up,
// the Map shows everything generated so far. "In your books" shows the matching textbook passages.
import { store } from '../store.js';
import { db } from '../db/index.js';
import { esc, icon, $, $$, toast } from '../ui.js';
import { shortTitle } from '../lib/lesson.js';

let state = null; // { itemId, focusId, nodes, marks, unsub, timer }

export async function renderTree(root, itemId, focusId = null) {
  const wantMap = focusId === 'map'; if (wantMap) focusId = null;
  leaveTree();
  const item = store.item(itemId);
  if (!item) { root.innerHTML = '<p class="empty">Item not found.</p>'; return; }
  document.body.classList.add('reading');
  state = { itemId, focusId, nodes: [], marks: [], root, item, waitingSince: null, openMapOnce: wantMap };
  root.innerHTML = `<div class="tree"><div class="tree-bar">
      <a class="back" href="#/item/${item.id}" aria-label="Back to item">${icon('back')}</a>
      <span class="bar-title">${esc(item.title)}</span>
      <button class="btn small ghost" data-act="map" aria-label="Map of the whole tree">${icon('list')} Map</button>
      <button class="btn small ghost" data-act="books" aria-label="Read in your books" title="In your books">${icon('book')}</button>
    </div><div class="tree-body"><div class="reader-loading"><div class="spinner"></div><p class="step">Loading…</p></div></div>
    <div class="sheet" hidden></div></div>`;
  bind(root);
  await refresh();
  state.unsub = db.subscribeTree(itemId, () => refresh());
}

export function leaveTree() {
  if (!state) return;
  state.unsub?.(); clearTimeout(state.timer);
  state = null;
  document.body.classList.remove('reading');
}

async function refresh() {
  if (!state) return;
  const s = state;
  [s.nodes, s.marks] = await Promise.all([db.listNodes(s.itemId), db.listMarks(s.itemId)]);
  if (state !== s) return;
  const rootNode = s.nodes.find((n) => !n.parent_id);
  if (!rootNode) {
    s.waitingSince ??= Date.now();
    draw();
    try { await db.requestTree(s.itemId, null); } catch (e) { showError(e); return; }
    if (db.mode === 'local') return refresh(); // local: generation completed inside requestTree
    return;
  }
  if (!s.focusId) s.focusId = rootNode.id;
  const focus = s.nodes.find((n) => n.id === s.focusId) || rootNode;
  s.focusId = focus.id;
  if (focus.children === 'none' && focus.expandable) {
    s.waitingSince ??= Date.now();
    draw();
    try { await db.requestTree(s.itemId, focus.id); } catch (e) { showError(e); return; }
    if (db.mode === 'local') return refresh();
    return;
  }
  if (focus.children === 'ready') s.waitingSince = null;
  if (s.visited !== focus.id) {
    s.visited = focus.id;
    focus.visit_count = (focus.visit_count || 0) + 1; focus.visited_at = new Date().toISOString();
    db.markVisited(focus.id, focus.visit_count).catch(() => {});
  }
  draw();
  if (s.openMapOnce) { s.openMapOnce = false; openMap(); }
}

function showError(e) {
  const body = $('.tree-body', state.root);
  if (body) body.innerHTML = `<p class="error" style="padding:24px">Could not build this part: ${esc(e.message)}</p>`;
}

// ---------------------------------------------------------------- drawing
function draw() {
  const s = state; if (!s) return;
  const body = $('.tree-body', s.root);
  const byId = new Map(s.nodes.map((n) => [n.id, n]));
  const focus = byId.get(s.focusId);
  if (!focus) { body.innerHTML = waitingHTML('Building the overview…'); return; }
  const crumbs = [];
  for (let p = focus; p; p = byId.get(p.parent_id)) crumbs.unshift(p);
  const children = s.nodes.filter((n) => n.parent_id === focus.id).sort((a, b) => a.ord - b.ord);
  const markOf = (id) => s.marks.find((m) => m.node_id === id)?.style;
  const kids = (id) => s.nodes.filter((n) => n.parent_id === id).length;

  body.innerHTML = `
    ${crumbs.length > 1 ? `<nav class="crumbs" aria-label="Path">${crumbs.map((c, i) => i === crumbs.length - 1
      ? `<span class="crumb on">${esc(c.label)}</span>`
      : `<a class="crumb" href="#/tree/${s.itemId}/${c.id}">${esc(c.label)}</a><span class="sep">›</span>`).join('')}</nav>` : ''}
    <header class="focus ${markOf(focus.id) || ''}">
      ${focus.depth === 0 ? `<p class="kicker">${esc(focus.topic_type || 'topic')}</p>` : ''}
      <h1>${esc(focus.label)}</h1>
      <p class="focus-text">${esc(focus.text)}</p>
      <div class="focus-actions">
        <button class="btn small ghost" data-mark="${focus.id}">${icon('marker')} ${markOf(focus.id) ? 'Unmark' : 'Mark'}</button>
        <button class="btn small ghost" data-books="${focus.id}">${icon('book')} In your books</button>
        ${focus.depth > 0 ? `<a class="btn small ghost" href="#/tree/${s.itemId}/${focus.parent_id}">${icon('back')} Up</a>` : ''}
      </div>
    </header>
    ${children.length ? `<ol class="feed">${children.map((c) => `
      <li class="node ${markOf(c.id) || ''} ${c.expandable ? 'can' : 'leaf'}" data-id="${c.id}">
        <a class="node-main" href="#/tree/${s.itemId}/${c.id}">
          <span class="node-label">${esc(c.label)}</span>
          <span class="node-text">${esc(c.text)}</span>
          <span class="node-meta">${c.children === 'ready' ? `${kids(c.id)} below` : c.children === 'pending' ? 'building…' : c.expandable ? 'tap to go deeper' : ''}</span>
        </a>
        <button class="node-more" data-menu="${c.id}" aria-label="More">${icon('more')}</button>
      </li>`).join('')}</ol>`
      : focus.children === 'pending' || (focus.children === 'none' && focus.expandable) ? waitingHTML(focus.depth === 0 ? 'Building the overview…' : `Going deeper into ${focus.label}…`)
      : `<p class="leaf-end">Nothing further below this.</p>`}
  `;
  // Long waits on the phone mean the laptop generator is off.
  if (s.waitingSince && Date.now() - s.waitingSince > 20000 && db.mode !== 'local') {
    body.insertAdjacentHTML('beforeend', `<p class="hint">Taking a while. New parts are written on your laptop — it needs to be awake with the generator running.</p>`);
  }
  if (s.waitingSince) { clearTimeout(s.timer); s.timer = setTimeout(draw, 21000); }
}

const waitingHTML = (msg) => `<div class="reader-loading"><div class="spinner"></div><p class="step">${esc(msg)}</p></div>`;

// ---------------------------------------------------------------- interactions
function bind(root) {
  root.addEventListener('click', async (e) => {
    const s = state; if (!s) return;
    const mapBtn = e.target.closest('[data-act=map]');
    if (mapBtn) return openMap();
    const booksTop = e.target.closest('[data-act=books]');
    if (booksTop) return openBooks(s.focusId);
    const mark = e.target.closest('[data-mark]');
    if (mark) return toggleMark(mark.dataset.mark);
    const books = e.target.closest('[data-books]');
    if (books) return openBooks(books.dataset.books);
    const menu = e.target.closest('[data-menu]');
    if (menu) return openNodeMenu(menu.dataset.menu);
    if (e.target.closest('.sheet-close') || e.target.classList.contains('sheet')) return closeSheet();
  });
}

async function toggleMark(nodeId) {
  const cur = state.marks.find((m) => m.node_id === nodeId);
  await db.setMark(nodeId, cur ? null : 'highlight');
  state.marks = await db.listMarks(state.itemId);
  draw(); closeSheet();
}

function openNodeMenu(nodeId) {
  const n = state.nodes.find((x) => x.id === nodeId);
  const marked = state.marks.some((m) => m.node_id === nodeId);
  sheet(`<h3>${esc(n.label)}</h3><p class="muted">${esc(n.text)}</p>
    <div class="sheet-actions">
      <button class="btn" data-mark="${nodeId}">${icon('marker')} ${marked ? 'Remove mark' : 'Mark as important'}</button>
      <button class="btn" data-books="${nodeId}">${icon('book')} In your books</button>
      ${n.expandable ? `<a class="btn primary" href="#/tree/${state.itemId}/${nodeId}">Go deeper</a>` : ''}
    </div>`);
}

function openMap() {
  const s = state;
  const byParent = new Map();
  for (const n of s.nodes) { const k = n.parent_id || 'root'; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(n); }
  const rootNode = s.nodes.find((n) => !n.parent_id);
  if (!rootNode) return;
  const marked = new Set(s.marks.map((m) => m.node_id));
  const visited = s.nodes.filter((n) => n.visited_at);
  const last = visited.map((n) => n.visited_at).sort().at(-1);

  // ---- layout: root on the left, depth along x, leaves stacked along y (tidy tree, centred parents)
  const W = 150, H = 30, GX = 46, GY = 10;
  const pos = new Map();
  let cursor = 0;
  const place = (n, depth) => {
    const kids = (byParent.get(n.id) || []).sort((a, b) => a.ord - b.ord);
    let y;
    if (!kids.length) { y = cursor; cursor += H + GY; }
    else { const ys = kids.map((k) => place(k, depth + 1)); y = (ys[0] + ys[ys.length - 1]) / 2; }
    pos.set(n.id, { x: depth * (W + GX), y, depth });
    return y;
  };
  place(rootNode, 0);
  const maxDepth = Math.max(...[...pos.values()].map((p) => p.depth));
  const width = (maxDepth + 1) * (W + GX) - GX + 8, height = cursor - GY + 8;

  // ---- draw
  const label = (t) => (t.length > 21 ? t.slice(0, 20).replace(/\s+\S*$/, '') + '…' : t);
  let links = '', boxes = '';
  for (const n of s.nodes) {
    const p = pos.get(n.id); if (!p) continue;
    const par = n.parent_id && pos.get(n.parent_id);
    if (par) {
      const x1 = par.x + W + 4, y1 = par.y + H / 2 + 4, x2 = p.x + 4, y2 = p.y + H / 2 + 4, mx = (x1 + x2) / 2;
      links += `<path class="tl ${n.visited_at ? 'seen' : ''}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
    }
    const kids = byParent.get(n.id)?.length || 0;
    const cls = ['tn', n.visited_at ? 'seen' : 'unseen', marked.has(n.id) ? 'marked' : '', n.id === s.focusId ? 'on' : '', !kids && n.expandable ? 'more' : ''].join(' ');
    boxes += `<a href="#/tree/${s.itemId}/${n.id}" class="${cls}" transform="translate(${p.x + 4},${p.y + 4})">
      <title>${esc(n.label)} — ${n.visited_at ? 'read ' + new Date(n.visited_at).toLocaleDateString() : 'not read yet'}${!kids && n.expandable ? ' · can go deeper' : ''}</title>
      <rect width="${W}" height="${H}" rx="8"/><text x="10" y="${H / 2 + 4}">${esc(label(n.label))}</text>${!kids && n.expandable ? `<text class="dots" x="${W - 14}" y="${H / 2 + 4}">…</text>` : ''}</a>`;
  }
  const svg = `<svg class="treemap" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${links}${boxes}</svg>`;
  sheet(`<h3>Where you went</h3>
    <p class="muted small">${visited.length} of ${s.nodes.length} nodes read${last ? ` · last ${new Date(last).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}
      <span class="legend"><span class="dot seen"></span>read <span class="dot unseen"></span>built, not read <span class="dot marked"></span>marked · “…” can go deeper</span></p>
    <div class="tm-tools"><button class="btn small ghost" data-zoom="-1" aria-label="Zoom out">−</button><button class="btn small ghost" data-zoom="1" aria-label="Zoom in">+</button><button class="btn small ghost" data-zoom="0">Fit</button></div>
    <div class="tm-scroll"><div class="tm-canvas">${svg}</div></div>`, true);
  // zoom: scale the canvas; Fit = whole tree width in view
  const scroll = $('.tm-scroll', s.root), canvas = $('.tm-canvas', s.root);
  let scale = 1;
  const apply = () => { canvas.style.transform = `scale(${scale})`; canvas.style.width = width + 'px'; canvas.style.height = height + 'px'; canvas.style.transformOrigin = '0 0'; canvas.parentElement.style.height = height * scale + 'px'; };
  const fit = () => { scale = Math.min(1, (scroll.clientWidth - 8) / width); apply(); };
  $('.tm-tools', s.root).addEventListener('click', (e) => {
    const z = e.target.closest('[data-zoom]')?.dataset.zoom; if (z == null) return;
    if (z === '0') fit(); else { scale = Math.min(2, Math.max(0.3, scale * (z === '1' ? 1.25 : 0.8))); apply(); }
  });
  requestAnimationFrame(fit);
}

async function openBooks(nodeId) {
  const s = state;
  const n = s.nodes.find((x) => x.id === nodeId);
  const books = store.books.filter((b) => b.status === 'ready');
  if (!books.length) return sheet(`<h3>In your books</h3><p>No textbooks in your <a href="#/library">Library</a> yet.</p>`);
  sheet(`<h3>In your books</h3><p class="muted small">${esc(n.label)}</p><div class="reader-loading"><div class="spinner"></div></div>`, true);
  try {
    const { embedQuery } = await import('../lib/embed.js');
    const byId = new Map(s.nodes.map((x) => [x.id, x]));
    const path = [];
    for (let p = byId.get(n.parent_id); p && p.depth > 0; p = byId.get(p.parent_id)) path.unshift(p.label);
    const query = `${s.item.title} ${path.join(' ')} ${n.label}: ${n.text}`;
    const hits = await db.searchChunks(await embedQuery(query), `${s.item.title} ${n.label}`, 12, books.map((b) => b.id));
    const top = hits.filter((h) => h.similarity >= 0.6).slice(0, 4);
    const bookTitle = (id) => shortTitle(store.book(id)?.title || 'Book');
    const html = top.length ? top.map((h) => `
      <article class="book-hit">
        <div class="source">${icon('book')}<span class="src-book">${esc(bookTitle(h.book_id))}</span>${h.chapter ? `<span class="src-ch">${esc(h.chapter)}</span>` : ''}<span class="src-ch">p. ${h.page_start}</span></div>
        ${h.text.split('\\n\\n').map((p) => `<p>${esc(p)}</p>`).join('')}
      </article>`).join('')
      : `<p>Your books don't have a passage that matches this point.</p>`;
    const el = $('.sheet-inner', s.root);
    if (el) el.innerHTML = `<button class="sheet-close" aria-label="Close">×</button><h3>In your books</h3><p class="muted small">${esc(n.label)}</p>${html}`;
  } catch (e) { toast('Could not search your books: ' + e.message); closeSheet(); }
}

function sheet(html, tall = false) {
  const el = $('.sheet', state.root);
  el.hidden = false;
  el.className = 'sheet' + (tall ? ' tall' : '');
  el.innerHTML = `<div class="sheet-inner"><button class="sheet-close" aria-label="Close">×</button>${html}</div>`;
  document.body.classList.add('lb-open');
}
function closeSheet() { const el = state && $('.sheet', state.root); if (el) el.hidden = true; document.body.classList.remove('lb-open'); }
