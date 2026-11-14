import { store } from '../store.js';
import { captureHTML, bindCapture, itemRowHTML } from './common.js';
import { daysUntil, todayISO, esc } from '../ui.js';

const SOON_DAYS = 3;

export function renderToday(root) {
  store.loadProgress(); // async; re-renders when it arrives
  const P = store.progress;
  const open = store.items.filter((i) => i.status === 'open');
  const due = open.filter((i) => i.deadline && daysUntil(i.deadline) <= SOON_DAYS).sort(byDeadline);
  const review = store.items.filter((i) => i.status === 'done' && i.review_date && i.review_date <= todayISO()).sort((a, b) => a.review_date.localeCompare(b.review_date));
  const taken = new Set([...due, ...review].map((i) => i.id));
  const started = open.filter((i) => !taken.has(i.id) && P[i.id]?.read).sort((a, b) => (P[b.id].last || '').localeCompare(P[a.id].last || ''));
  const fresh = open.filter((i) => !taken.has(i.id) && !P[i.id]?.read).sort((a, b) => b.created_at.localeCompare(a.created_at));

  const dueWeek = open.filter((i) => i.deadline && daysUntil(i.deadline) <= 7).length;
  const readAll = Object.values(P).reduce((a, p) => a + p.read, 0);
  const readToday = Object.values(P).reduce((a, p) => a + (p.readToday || 0), 0);
  const h = new Date().getHours();
  const hello = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';

  const group = (title, items, cls = '', more = '') => items.length ? `
    <section class="group ${cls}"><h2><span>${esc(title)}</span>${more}</h2>
      <ul class="items cards">${items.map((i) => itemRowHTML(i, { showList: false })).join('')}</ul></section>` : '';

  root.innerHTML = `
    <header class="home-head">
      <div><p class="date">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p><h1>${hello}</h1></div>
    </header>
    <div class="stats">
      <div class="stat"><b>${dueWeek}</b><small>due this week</small></div>
      <div class="stat"><b>${readAll}</b><small>nodes read</small></div>
      <div class="stat"><b>${readToday}</b><small>read today</small></div>
    </div>
    ${captureHTML()}
    ${group('Due soon', due, 'due', `<a href="#/lists">See all</a>`)}
    ${group('Review today', review, 'review')}
    ${group('Continue', started.slice(0, 5), 'continue')}
    ${group(started.length || due.length ? 'Not started' : 'Your topics', fresh.slice(0, 6), 'fresh')}
    ${!open.length && !review.length ? `<p class="empty">Nothing yet. Add what comes up on rounds above.</p>` : ''}
  `;
  bindCapture(root);
}

const byDeadline = (a, b) => a.deadline.localeCompare(b.deadline);
