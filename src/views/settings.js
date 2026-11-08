import { store } from '../store.js';
import { db } from '../db/index.js';
import { esc, $, toast } from '../ui.js';
import { applyTheme } from '../theme.js';

export function renderSettings(root) {
  const s = store.settings;
  root.innerHTML = `
    <header class="page-head"><h1>Settings</h1></header>
    <form class="settings">
      <h2>Study preferences <span class="muted small">(optional)</span></h2>
      <label>Career interest<input name="career_interest" value="${esc(s.career_interest || '')}" placeholder="e.g. future internist"></label>
      <label>Specialties to emphasise<input name="emphasis" value="${esc((s.emphasis || []).join(', '))}" placeholder="e.g. ENT, cardiology"></label>
      <p class="small muted">Topics in these specialties get a slightly fuller “basic” lesson. Leave empty for a general medical-student level.</p>
      <h2>Reading</h2>
      <label>Theme<select name="theme">
        ${['auto', 'light', 'dark'].map((t) => `<option value="${t}" ${s.theme === t ? 'selected' : ''}>${{ auto: 'Follow device', light: 'Paper (light)', dark: 'Night (dark)' }[t]}</option>`).join('')}
      </select></label>
      <button class="btn primary">Save</button>
    </form>
    <section class="settings-foot">
      <p class="small muted">${db.mode === 'local'
        ? 'Local mode: data is stored in this browser only and does not sync. Configure Supabase to sync across devices (see README).'
        : 'Synced with your private Supabase project.'}</p>
      ${db.mode === 'local' ? '' : '<button class="btn ghost" data-act="signout">Sign out</button>'}
    </section>`;
  $('.settings', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await store.saveSettings({
      career_interest: f.get('career_interest').trim(),
      emphasis: f.get('emphasis').split(',').map((x) => x.trim()).filter(Boolean),
      theme: f.get('theme'),
    });
    applyTheme(store.settings.theme);
    toast('Saved');
  });
  root.querySelector('[data-act=signout]')?.addEventListener('click', async () => { await db.signOut(); location.reload(); });
}
