import { store } from '../store.js';
import { captureHTML, bindCapture, itemRowHTML } from './common.js';
import { daysUntil, todayISO, esc } from '../ui.js';

const SOON_DAYS = 3;

export function renderToday(root) {
  const open = store.items.filter((i) => i.status === 'open');
  const overdue = open.filter((i) => i.deadline && daysUntil(i.deadline) < 0).sort(byDeadline);
  const soon = open.filter((i) => i.deadline && daysUntil(i.deadline) >= 0 && daysUntil(i.deadline) <= SOON_DAYS).sort(byDeadline);
  const review = store.items.filter((i) => i.status === 'done' && i.review_date && i.review_date <= todayISO()).sort((a, b) => a.review_date.localeCompare(b.review_date));
  const recent = open.filter((i) => !i.deadline).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5);

  const group = (title, items, cls = '') => items.length ? `
    <section class="group ${cls}"><h2>${esc(title)} <span class="count">${items.length}</span></h2>
      <ul class="items">${items.map((i) => itemRowHTML(i, { showList: true })).join('')}</ul></section>` : '';

  const nothing = !overdue.length && !soon.length && !review.length;
  root.innerHTML = `
    <header class="page-head"><h1>Today</h1><p class="muted">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p></header>
    ${captureHTML()}
    ${group('Overdue', overdue, 'overdue')}
    ${group(`Due in the next ${SOON_DAYS} days`, soon)}
    ${group('Review today', review, 'review')}
    ${nothing ? `<p class="empty">Nothing due. ${open.length ? 'Your lists hold ' + open.length + ' open item' + (open.length > 1 ? 's' : '') + '.' : 'Capture what comes up on rounds.'}</p>` : ''}
    ${group('Recently captured', recent, 'recent')}
    ${!store.books.length ? `<p class="hint">Upload your textbooks in <a href="#/library">Library</a> to get lessons and reading-time estimates.</p>` : ''}
  `;
  bindCapture(root);
}

const byDeadline = (a, b) => a.deadline.localeCompare(b.deadline);
