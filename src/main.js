import './styles.css';
import { db } from './db/index.js';
import { store, queueMissingEstimates } from './store.js';
import { applyTheme } from './theme.js';
import { esc, icon, $ } from './ui.js';
import { renderToday } from './views/today.js';
import { renderLists, renderList } from './views/lists.js';
import { renderItem } from './views/item.js';
import { renderLibrary } from './views/library.js';
import { renderSettings } from './views/settings.js';
import { renderReader, leaveReader } from './views/reader.js';
import { renderTree, leaveTree } from './views/tree.js';

const app = document.getElementById('app');

async function boot() {
  try { applyTheme(localStorage.getItem('rounds-theme') || 'auto'); } catch { applyTheme('auto'); }
  const session = await db.session();
  if (!session) return renderLogin();
  await start();
}

function renderLogin(error = '') {
  app.innerHTML = `
    <main class="login">
      <h1>Rounds</h1>
      <p class="muted">Study companion</p>
      <form>
        <input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
        <button class="btn primary">Unlock</button>
        ${error ? `<p class="error small">${esc(error)}</p>` : ''}
      </form>
    </main>`;
  $('form', app).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await db.signIn(e.target.password.value); await start(); }
    catch (err) { renderLogin(err.message === 'Invalid login credentials' ? 'Wrong password.' : err.message); }
  });
}

async function start() {
  app.innerHTML = `
    <nav class="tabs">
      <a href="#/today" data-tab="today">${icon('sun')}<span>Today</span></a>
      <a href="#/lists" data-tab="lists">${icon('list')}<span>Lists</span></a>
      <a href="#/library" data-tab="library">${icon('book')}<span>Library</span></a>
      <a href="#/settings" data-tab="settings">${icon('gear')}<span>Settings</span></a>
    </nav>
    ${db.mode === 'local' ? '<div class="local-banner">Local mode — data stays in this browser</div>' : ''}
    <main id="view"></main>`;
  await store.load();
  applyTheme(store.settings.theme);
  store.on(scheduleRender);
  addEventListener('hashchange', () => route(true));
  route(true);
  queueMissingEstimates();
}

// Re-render on data changes, but never while the user is typing or dragging.
let dirty = false;
function scheduleRender() {
  if (['read', 'tree'].includes(currentRoute().name)) return; // reader and tree manage themselves
  const a = document.activeElement;
  if (a && a.closest?.('#view') && a.matches('input, textarea, select') || document.querySelector('.dragging')) {
    dirty = true; return;
  }
  route(false);
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (dirty && !document.activeElement?.matches?.('input, textarea, select')) { dirty = false; route(false); }
}, 0));

function currentRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  return { name: parts[0] || 'today', args: parts.slice(1) };
}

let lastName = null;
function route(navigated) {
  const view = document.getElementById('view');
  if (!view) return;
  const { name, args } = currentRoute();
  // A panel (map, figure viewer, book passages) locks page scrolling while open; any
  // navigation closes it, so the lock can never outlive the panel.
  if (navigated) document.body.classList.remove('lb-open');
  if (lastName === 'read' && name !== 'read') leaveReader();
  if (lastName === 'tree' && name !== 'tree') leaveTree();
  // Preserve scroll position on data-driven re-renders.
  const y = scrollY;
  const openDetails = [...view.querySelectorAll('details[open]')].map((d) => d.className);
  switch (name) {
    case 'today': renderToday(view); break;
    case 'lists': renderLists(view); break;
    case 'list': renderList(view, args[0]); break;
    case 'item': renderItem(view, args[0]); break;
    case 'library': renderLibrary(view); break;
    case 'settings': renderSettings(view); break;
    case 'read': if (navigated || lastName !== 'read') renderReader(view, args[0], args[1] || 'basic'); break;
    case 'tree': if (navigated) renderTree(view, args[0], args[1] || null); break;
    default: location.hash = '#/today'; return;
  }
  if (!navigated) {
    scrollTo(0, y);
    openDetails.forEach((c) => view.querySelector(`details.${c.split(' ').join('.')}`)?.setAttribute('open', ''));
  } else if (name !== 'read') scrollTo(0, 0);
  lastName = name;
  const tab = { list: 'lists', item: 'lists', tree: 'lists', read: 'lists' }[name] || name;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot().catch((e) => { app.innerHTML = `<p class="error">Could not start: ${esc(e.message)}</p>`; console.error(e); });
