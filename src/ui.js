import { escapeHtml } from './lib/text.js';

export const esc = escapeHtml;
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

export const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
export function addDays(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
export function daysUntil(iso) { return Math.round((new Date(iso + 'T12:00:00') - new Date(todayISO() + 'T12:00:00')) / 86400000); }
export function dueLabel(iso) {
  const n = daysUntil(iso);
  if (n < -1) return `${-n} days overdue`;
  if (n === -1) return 'yesterday';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n < 7) return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function confirmDialog(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dialog';
    d.innerHTML = `<p>${esc(message)}</p><div class="row end"><button class="btn ghost" value="no">Cancel</button><button class="btn danger" value="yes">${esc(okLabel)}</button></div>`;
    document.body.append(d);
    d.addEventListener('click', (e) => { const v = e.target.closest('button')?.value; if (v) { d.close(); d.remove(); resolve(v === 'yes'); } });
    d.showModal();
  });
}
