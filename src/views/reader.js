// Reading view — the core of the product. Text, not an embedded PDF.
import { store, getLesson } from '../store.js';
import { db } from '../db/index.js';
import { keySentences, shortTitle } from '../lib/lesson.js';
import { esc, icon, $, $$, toast, todayISO, addDays, dueLabel } from '../ui.js';
import { formatMinutes, readingMinutes } from '../lib/text.js';
import { applyTheme } from '../theme.js';

let cleanup = null;

export async function renderReader(root, itemId, depth) {
  cleanup?.(); cleanup = null;
  const item = store.item(itemId);
  if (!item) { root.innerHTML = '<p class="empty">Item not found.</p>'; return; }
  document.body.classList.add('reading');
  root.innerHTML = `
    <div class="reader">
      ${topbar(item, depth)}
      <div class="reader-loading"><div class="spinner"></div><p class="step">Preparing your lesson…</p></div>
    </div>`;
  bindTopbar(root, item, depth);

  let lesson;
  try {
    lesson = await getLesson(item, depth, { onStep: (s) => { const el = $('.step', root); if (el) el.textContent = s + '…'; } });
  } catch (e) {
    console.error(e);
    $('.reader-loading', root).innerHTML = `<p class="error">Could not build this lesson: ${esc(e.message)}</p>`;
    return;
  }
  if (location.hash !== `#/read/${itemId}/${depth}`) return; // navigated away meanwhile
  const content = lesson.content;
  const highlights = await db.listHighlights(lesson.id);
  const page = $('.reader', root);
  $('.reader-loading', root).remove();
  page.insertAdjacentHTML('beforeend', lessonHTML(item, content, depth));
  paintHighlights(page, highlights);
  loadFigures(page);
  cleanup = bindReading(page, item, lesson, highlights);
}

export function leaveReader() { cleanup?.(); cleanup = null; document.body.classList.remove('reading'); }

// ---------------------------------------------------------------- markup
function topbar(item, depth) {
  const other = depth === 'basic' ? 'expanded' : 'basic';
  return `
  <div class="reader-bar">
    <a class="back" href="#/item/${item.id}" aria-label="Back">${icon('back')}</a>
    <span class="bar-title">${esc(item.title)}</span>
    <div class="seg" role="group" aria-label="Depth">
      <a href="#/read/${item.id}/basic" class="${depth === 'basic' ? 'on' : ''}">Basic</a>
      <a href="#/read/${item.id}/expanded" class="${depth === 'expanded' ? 'on' : ''}">Expanded</a>
    </div>
    <details class="menu"><summary aria-label="Reading options">Aa</summary>
      <div class="menu-pop reading-opts">
        <div class="row"><button data-font="-1" aria-label="Smaller text">A−</button><button data-font="1" aria-label="Larger text">A+</button></div>
        <div class="row"><button data-theme="light">Paper</button><button data-theme="dark">Night</button><button data-theme="auto">Auto</button></div>
        <label class="row"><input type="checkbox" data-key> Underline key sentences</label>
        <button data-act="rebuild">Rebuild lesson</button>
      </div></details>
  </div>`;
}

const ROLE_COLORS = { overview: 'c1', presentation: 'c2', technique: 'c3', mechanism: 'c4', pathophysiology: 'c5', diagnosis: 'c6', differential: 'c7', treatment: 'c8', prognosis: 'c9' };

function lessonHTML(item, c, depth) {
  if (c.status === 'no_books') return `<div class="lesson-msg"><h1>${esc(item.title)}</h1><p>Your library is empty. Upload your textbooks in <a href="#/library">Library</a> first.</p></div>`;
  if (c.status === 'no_coverage') return `<div class="lesson-msg"><h1>${esc(item.title)}</h1><p><strong>None of your books covers this topic.</strong></p><p class="muted">Checked: ${esc(store.books.filter((b) => b.status === 'ready').map((b) => b.title).join(', '))}.</p></div>`;

  const sources = new Set(); c.sections.forEach((s) => s.blocks.forEach((b) => b.type === 'passage' && sources.add(b.book_title)));
  const secMinutes = (s) => readingMinutes(s.blocks.filter((b) => b.type === 'passage').reduce((a, b) => a + b.words, 0), s.blocks.filter((b) => b.type === 'figure').length);

  let html = `
  <article class="lesson">
    <header class="lesson-head">
      <p class="kicker">${depth === 'basic' ? 'Basic' : 'Expanded'} lesson${c.emphasised ? ' · emphasised specialty' : ''}</p>
      <h1>${esc(item.title)}</h1>
      <p class="lesson-meta">${formatMinutes(c.minutes)} · ${c.words.toLocaleString()} words${c.figures ? ` · ${c.figures} figure${c.figures > 1 ? 's' : ''}/table${c.figures > 1 ? 's' : ''}` : ''} · from ${[...sources].map((s) => esc(shortTitle(s))).join(', ')}</p>
      ${item.note ? `<p class="lesson-note">${icon('pin')} ${esc(item.note)}</p>` : ''}
    </header>
    <nav class="outline" aria-label="Lesson outline"><ol>
      ${c.sections.map((s, i) => `<li class="${ROLE_COLORS[s.role]}"><a href="#sec-${i}" data-jump="sec-${i}"><span class="dot"></span>${esc(s.title)}<span class="muted">${formatMinutes(secMinutes(s))}</span></a></li>`).join('')}
    </ol></nav>`;

  c.sections.forEach((s, i) => {
    html += `<section class="lsec ${ROLE_COLORS[s.role]}" id="sec-${i}">
      <h2 class="lsec-title"><span class="lsec-num">${i + 1}</span>${esc(s.title)}</h2>`;
    let lastSrc = '';
    for (const b of s.blocks) {
      if (b.type === 'note') {
        html += `<aside class="gen-note"><span class="gen-label">${icon('spark')} Generated connecting note — not from the book</span><p>${esc(b.text)}</p>
          <p class="gen-cites">Draws on: ${b.cites.map((x) => `${esc(shortTitle(x.book_title))} p. ${x.page}`).join(' · ')}</p></aside>`;
      } else if (b.type === 'passage') {
        const src = `${b.book_id}|${b.chapter}|${b.section}`;
        const pages = b.page_start === b.page_end ? `p. ${b.page_start}` : `pp. ${b.page_start}–${b.page_end}`;
        if (src !== lastSrc) {
          html += `<div class="source">${icon('book')} <span class="src-book">${esc(shortTitle(b.book_title))}</span>${b.chapter ? ` · <span>${esc(b.chapter)}</span>` : ''}${b.section && b.section !== b.chapter ? ` · <span>${esc(b.section)}</span>` : ''}</div>`;
          lastSrc = src;
        }
        html += `<div class="passage" data-chunk="${b.chunk_id}"><span class="page-tag">${pages}</span>${paragraphs(b.text)}</div>`;
      } else if (b.type === 'figure') {
        const ratio = b.width && b.height ? `aspect-ratio:${b.width}/${b.height}` : '';
        html += `<figure class="fig ${b.kind}" data-path="${esc(b.image_path)}">
          <div class="fig-img" style="${ratio}"><img alt="${esc(b.caption || b.kind)}" decoding="async"></div>
          <figcaption>${b.caption ? esc(b.caption) : esc(b.kind)} <span class="muted">— ${esc(shortTitle(b.book_title))}, p. ${b.page}</span></figcaption></figure>`;
      }
    }
    html += `<div class="lsec-end">end of ${esc(s.title.toLowerCase())}</div></section>`;
  });

  html += `
    <footer class="lesson-foot">
      ${item.status === 'done'
        ? `<p>${icon('check')} Marked as done.${item.review_date ? ` Review ${esc(dueLabel(item.review_date))}.` : ''}</p>`
        : `<button class="btn primary big" data-act="done">${icon('check')} Mark lesson as done</button>`}
      <div class="review-pick">
        <span class="muted">Review again in</span>
        <button class="btn small ghost" data-review="3">3 days</button>
        <button class="btn small ghost" data-review="7">1 week</button>
        <button class="btn small ghost" data-review="30">1 month</button>
        <input type="date" data-review-date value="${esc(item.review_date || '')}" aria-label="Review date">
      </div>
    </footer>
  </article>`;
  return html;
}

function paragraphs(text) {
  let off = 0;
  return text.split('\n\n').map((p) => {
    const html = `<p data-start="${off}" data-len="${p.length}">${esc(p)}</p>`;
    off += p.length + 2;
    return html;
  }).join('');
}

// ---------------------------------------------------------------- highlights
function paintHighlights(page, highlights, keys = []) {
  for (const pass of $$('.passage', page)) {
    const cid = pass.dataset.chunk;
    const hs = highlights.filter((h) => h.chunk_id === cid).map((h) => ({ ...h, start: h.start_off, end: h.end_off }));
    const ks = keys.filter((k) => k.chunk_id === cid).map((k) => ({ ...k, style: 'key' }));
    const all = [...hs, ...ks];
    for (const p of $$('p[data-start]', pass)) {
      const s0 = +p.dataset.start, len = +p.dataset.len;
      const text = p.textContent;
      const inP = all.filter((h) => h.end > s0 && h.start < s0 + len);
      if (!inP.length) { if (p.querySelector('mark')) p.textContent = text; continue; }
      const cuts = new Set([0, len]);
      inP.forEach((h) => { cuts.add(Math.max(0, h.start - s0)); cuts.add(Math.min(len, h.end - s0)); });
      const pts = [...cuts].sort((a, b) => a - b);
      let html = '';
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const seg = esc(text.slice(a, b));
        const cover = inP.filter((h) => h.start - s0 <= a && h.end - s0 >= b);
        if (!cover.length) { html += seg; continue; }
        const classes = [...new Set(cover.map((h) => h.style))].join(' ');
        const user = cover.filter((h) => h.id).at(-1);
        html += `<mark class="${classes}"${user ? ` data-hid="${user.id}"` : ''}>${seg}</mark>`;
      }
      p.innerHTML = html;
    }
  }
}

/** Character offset of a DOM point inside a passage (paragraph offsets + text within). */
function offsetOf(node, offset) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  const p = el?.closest('p[data-start]');
  if (!p) return null;
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let n, acc = 0;
  if (node.nodeType === 1) { // element container: offset counts child nodes
    const range = document.createRange(); range.setStart(p, 0); range.setEnd(node, offset);
    return +p.dataset.start + range.toString().length;
  }
  while ((n = walker.nextNode())) { if (n === node) return +p.dataset.start + acc + offset; acc += n.length; }
  return null;
}

// ---------------------------------------------------------------- figures
async function loadFigures(page) {
  const io = new IntersectionObserver(async (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const img = e.target.querySelector('img');
      try { img.src = await db.figureUrl(e.target.dataset.path); } catch { e.target.classList.add('missing'); }
      img.addEventListener('click', () => e.target.classList.toggle('zoom'));
    }
  }, { rootMargin: '600px' });
  $$('figure.fig', page).forEach((f) => io.observe(f));
}

// ---------------------------------------------------------------- interactions
function bindTopbar(root, item, depth) {
  const prefs = readPrefs();
  document.documentElement.style.setProperty('--read-size', prefs.size + 'px');
  $('.reading-opts', root).addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.font) { prefs.size = Math.min(26, Math.max(15, prefs.size + +b.dataset.font)); savePrefs(prefs); document.documentElement.style.setProperty('--read-size', prefs.size + 'px'); }
    if (b.dataset.theme) { await store.saveSettings({ theme: b.dataset.theme }); applyTheme(b.dataset.theme); }
    if (b.dataset.act === 'rebuild') {
      // Highlights are anchored to book passages, so they survive a rebuild
      // whenever the same passage is chosen again.
      await getLesson(item, depth, { force: true });
      renderReader(root, item.id, depth);
    }
  });
}

function bindReading(page, item, lesson, highlights) {
  let keys = [];
  // Outline jump
  page.addEventListener('click', (e) => {
    const j = e.target.closest('[data-jump]');
    if (j) { e.preventDefault(); document.getElementById(j.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });

  // Selection toolbar
  const tb = document.createElement('div');
  tb.className = 'sel-toolbar';
  tb.innerHTML = `<button data-style="highlight">${icon('marker')} Highlight</button><button data-style="underline">${icon('underline')} Underline</button>`;
  document.body.append(tb);
  const pop = document.createElement('div');
  pop.className = 'sel-toolbar';
  pop.innerHTML = `<button data-remove>${icon('trash')} Remove</button>`;
  document.body.append(pop);
  let pending = null, removeId = null;

  const place = (el, rect) => {
    el.style.top = `${window.scrollY + rect.top - 48}px`;
    el.style.left = `${Math.max(8, Math.min(window.innerWidth - 220, rect.left + rect.width / 2 - 100))}px`;
    el.classList.add('show');
  };
  const onSel = () => {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { tb.classList.remove('show'); pending = null; return; }
    const r = sel.getRangeAt(0);
    const sp = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement)?.closest('.passage');
    const ep = (r.endContainer.nodeType === 1 ? r.endContainer : r.endContainer.parentElement)?.closest('.passage');
    if (!sp || sp !== ep) { tb.classList.remove('show'); pending = null; return; }
    const a = offsetOf(r.startContainer, r.startOffset), z = offsetOf(r.endContainer, r.endOffset);
    if (a == null || z == null || z - a < 2) return;
    pending = { chunk_id: sp.dataset.chunk, start_off: Math.min(a, z), end_off: Math.max(a, z) };
    place(tb, r.getBoundingClientRect());
  };
  document.addEventListener('selectionchange', onSel);

  tb.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
  tb.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !pending) return;
    const row = await db.addHighlight({ lesson_id: lesson.id, ...pending, style: b.dataset.style });
    highlights.push(row);
    getSelection().removeAllRanges();
    tb.classList.remove('show');
    paintHighlights(page, highlights, keys);
  });
  page.addEventListener('click', (e) => {
    const m = e.target.closest('mark[data-hid]');
    if (!m || !getSelection().isCollapsed) { pop.classList.remove('show'); return; }
    removeId = m.dataset.hid;
    place(pop, m.getBoundingClientRect());
  });
  pop.addEventListener('click', async () => {
    if (!removeId) return;
    await db.deleteHighlight(removeId);
    const i = highlights.findIndex((h) => h.id === removeId);
    if (i >= 0) highlights.splice(i, 1);
    pop.classList.remove('show');
    paintHighlights(page, highlights, keys);
  });

  // Key sentences (optional, computed on demand, not saved)
  const keyBox = $('[data-key]', page);
  keyBox?.addEventListener('change', async () => {
    if (keyBox.checked) {
      toast('Finding key sentences…');
      try { keys = await keySentences(lesson.content, item.title); } catch { keys = []; }
    } else keys = [];
    paintHighlights(page, highlights, keys);
  });

  // Done & review
  page.querySelector('.lesson-foot')?.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'done') {
      await store.updateItem(item.id, { status: 'done', done_at: new Date().toISOString() });
      b.outerHTML = `<p>${icon('check')} Marked as done.</p>`;
      toast('Nice work.');
    }
    if (b.dataset.review) {
      const d = addDays(todayISO(), +b.dataset.review);
      await store.updateItem(item.id, { review_date: d });
      $('[data-review-date]', page).value = d;
      toast(`It will reappear in Today ${dueLabel(d)}`);
    }
  });
  $('[data-review-date]', page)?.addEventListener('change', async (e) => {
    await store.updateItem(item.id, { review_date: e.target.value || null });
    if (e.target.value) toast(`It will reappear in Today ${dueLabel(e.target.value)}`);
  });

  // Hide the bar while reading down, show it when scrolling up.
  let lastY = scrollY;
  const bar = $('.reader-bar');
  const onScroll = () => { const y = scrollY; bar?.classList.toggle('hidden', y > lastY && y > 120); lastY = y; };
  addEventListener('scroll', onScroll, { passive: true });

  return () => {
    document.removeEventListener('selectionchange', onSel);
    removeEventListener('scroll', onScroll);
    tb.remove(); pop.remove();
  };
}

function readPrefs() { try { return { size: 19, ...JSON.parse(localStorage.getItem('rounds-reader') || '{}') }; } catch { return { size: 19 }; } }
function savePrefs(p) { try { localStorage.setItem('rounds-reader', JSON.stringify(p)); } catch { /* ignore */ } }
