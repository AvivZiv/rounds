// Reading view — the core of the product. Text, not an embedded PDF.
import { store, getLesson } from '../store.js';
import { db } from '../db/index.js';
import { keySentences, shortTitle, figureRefs, refKey } from '../lib/lesson.js';
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
  paintText(page, highlights);
  loadFigures(page);
  cleanup = bindReading(page, item, lesson, highlights);
}

export function leaveReader() { cleanup?.(); cleanup = null; document.body.classList.remove('reading'); }

// ---------------------------------------------------------------- markup
function topbar(item, depth) {
  return `
  <div class="reader-bar">
    <a class="back" href="#/item/${item.id}" aria-label="Back">${icon('back')}</a>
    <div class="bar-mid">
      <span class="bar-title">${esc(item.title)}</span>
      <span class="bar-left" aria-live="polite"></span>
    </div>
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
    <div class="read-progress" aria-hidden="true"><span></span></div>
  </div>`;
}

const ROLE_COLORS = { overview: 'c1', presentation: 'c2', technique: 'c3', mechanism: 'c4', pathophysiology: 'c5', diagnosis: 'c6', differential: 'c7', treatment: 'c8', prognosis: 'c9', supplement: 'c9' };
const cleanHead = (t) => (t || '').replace(/^[■•▪●◆\s]+/, '').trim();
const titleCase = (t) => (t === t.toUpperCase() && /[A-Z]{3}/.test(t) ? t.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : t);
const kindLabel = (k, l) => `${k === 'table' ? 'Table' : 'Figure'} ${l}`;

function lessonHTML(item, c, depth) {
  if (c.status === 'no_books') return `<div class="lesson-msg"><h1>${esc(item.title)}</h1><p>Your library is empty. Upload your textbooks in <a href="#/library">Library</a> first.</p></div>`;
  if (c.status === 'no_coverage') return `<div class="lesson-msg"><h1>${esc(item.title)}</h1><p><strong>None of your books covers this topic.</strong></p><p class="muted">Checked: ${esc(store.books.filter((b) => b.status === 'ready').map((b) => shortTitle(b.title)).join(', '))}.</p></div>`;

  const reading = c.sections.filter((s) => !s.supplement);
  const supp = c.sections.find((s) => s.supplement);
  const sources = new Set(); reading.forEach((s) => s.blocks.forEach((b) => b.type === 'passage' && sources.add(shortTitle(b.book_title))));
  const secMinutes = (s) => readingMinutes(s.blocks.filter((b) => b.type === 'passage').reduce((a, b) => a + b.words, 0), s.blocks.filter((b) => b.type === 'figure').length);

  let html = `
  <article class="lesson">
    <header class="lesson-head">
      <p class="kicker">${depth === 'basic' ? 'Basic' : 'Expanded'} lesson${c.emphasised ? ' · your specialty' : ''}</p>
      <h1>${esc(item.title)}</h1>
      <p class="lesson-meta">${formatMinutes(c.minutes)} read · from ${[...sources].map(esc).join(' and ')}</p>
      ${item.note ? `<p class="lesson-note">${icon('pin')} ${esc(item.note)}</p>` : ''}
    </header>
    <nav class="outline" aria-label="Lesson outline"><ol>
      ${reading.map((s, i) => `<li class="${ROLE_COLORS[s.role]}"><a href="#sec-${i}" data-jump="sec-${i}"><span class="num">${i + 1}</span><span class="otitle">${esc(s.title)}</span><span class="omin">${formatMinutes(secMinutes(s))}</span></a></li>`).join('')}
      ${supp ? `<li class="c9 osupp"><a href="#sec-supp" data-jump="sec-supp"><span class="num">${icon('image')}</span><span class="otitle">Figures &amp; tables</span><span class="omin">${supp.blocks.length}</span></a></li>` : ''}
    </ol></nav>`;

  reading.forEach((s, i) => {
    html += `<section class="lsec ${ROLE_COLORS[s.role]}" id="sec-${i}">
      <h2 class="lsec-title"><span class="lsec-num">${i + 1}</span>${esc(s.title)}</h2>`;
    let lastSrc = '', lastSub = '';
    for (const b of s.blocks) {
      if (b.type === 'note') {
        html += `<aside class="gen-note"><span class="gen-label">${icon('spark')} Connecting note · generated, not from the book</span>${esc(b.text)}
          <span class="gen-cites">${b.cites.map((x) => `${esc(shortTitle(x.book_title))} p. ${x.page}`).join(' · ')}</span></aside>`;
      } else if (b.type === 'passage') {
        const src = `${b.book_id}|${b.chapter}`;
        if (src !== lastSrc) {
          html += `<div class="source">${icon('book')}<span class="src-book">${esc(shortTitle(b.book_title))}</span>${b.chapter ? `<span class="src-ch">${esc(titleCase(cleanHead(b.chapter)))}</span>` : ''}</div>`;
          lastSrc = src; lastSub = '';
        }
        const sub = cleanHead(b.section);
        if (sub && sub !== lastSub && sub !== cleanHead(b.chapter)) { html += `<h3 class="book-sub">${esc(titleCase(sub))}</h3>`; }
        lastSub = sub;
        const pages = b.page_start === b.page_end ? `p. ${b.page_start}` : `pp. ${b.page_start}–${b.page_end}`;
        html += `<div class="passage" data-chunk="${b.chunk_id}" data-book="${b.book_id}"><span class="page-tag">${pages}</span>${paragraphs(b.text)}</div>`;
      } else if (b.type === 'figure') {
        html += figureHTML(b);
      }
    }
    html += `<div class="lsec-end">end of ${esc(s.title.toLowerCase())}</div></section>`;
  });

  if (supp) {
    html += `<section class="lsec supp c9" id="sec-supp">
      <h2 class="lsec-title">${esc('Figures & tables')}</h2>
      <p class="supp-intro">Mentioned in the passages above.</p>
      <div class="supp-grid">${supp.blocks.map((b) => (b.type === 'figure' ? figureHTML(b, true)
        : `<div class="fig-missing" data-ref="${esc(refKey(b.book_id, b.kind, b.label))}">
            <strong>${esc(kindLabel(b.kind, b.label))}</strong>
            <span>Couldn't be captured from the PDF. It's in ${esc(shortTitle(b.book_title))}, cited on p. ${b.cited_on}.</span></div>`)).join('')}
      </div></section>`;
  }

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
  </article>
  <div class="lightbox" hidden role="dialog" aria-modal="true" aria-label="Figure">
    <button class="lb-close" aria-label="Close">×</button>
    <div class="lb-scroll"><img alt=""></div>
    <p class="lb-cap"></p>
  </div>`;
  return html;
}

function figureHTML(b, compact = false) {
  const ratio = b.width && b.height ? `aspect-ratio:${b.width}/${b.height}` : '';
  const cap = b.caption || kindLabel(b.kind, b.label);
  return `<figure class="fig ${b.kind}${compact ? ' compact' : ''}" data-path="${esc(b.image_path)}" data-ref="${esc(refKey(b.book_id, b.kind, b.label))}" tabindex="0">
    <div class="fig-img" style="${ratio}"><img alt="${esc(cap)}" decoding="async"></div>
    <figcaption>${esc(compact ? cap.slice(0, 160) + (cap.length > 160 ? '…' : '') : cap)} <span class="muted">${esc(shortTitle(b.book_title))}, p. ${b.page}</span></figcaption></figure>`;
}

function paragraphs(text) {
  let off = 0;
  return text.split('\n\n').map((p) => {
    const html = `<p data-start="${off}" data-len="${p.length}">${esc(p)}</p>`;
    off += p.length + 2;
    return html;
  }).join('');
}

// ---------------------------------------------------------------- text marks: highlights, key sentences, figure refs
function paintText(page, highlights, keys = []) {
  for (const pass of $$('.passage', page)) {
    const cid = pass.dataset.chunk, bookId = pass.dataset.book;
    const ranges = [
      ...highlights.filter((h) => h.chunk_id === cid).map((h) => ({ start: h.start_off, end: h.end_off, cls: h.style, hid: h.id })),
      ...keys.filter((k) => k.chunk_id === cid).map((k) => ({ start: k.start, end: k.end, cls: 'key' })),
    ];
    for (const p of $$('p[data-start]', pass)) {
      const s0 = +p.dataset.start, len = +p.dataset.len;
      const text = p.textContent;
      const refs = figureRefs(text).map((r) => ({ start: s0 + r.index, end: s0 + r.index + r.length, cls: 'figref', ref: refKey(bookId, r.kind, r.label) }));
      const inP = [...ranges.filter((h) => h.end > s0 && h.start < s0 + len), ...refs];
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
        const classes = [...new Set(cover.map((h) => h.cls))].join(' ');
        const hid = cover.filter((h) => h.hid).at(-1)?.hid;
        const ref = cover.find((h) => h.ref)?.ref;
        html += `<mark class="${classes}"${hid ? ` data-hid="${hid}"` : ''}${ref ? ` data-ref="${esc(ref)}"` : ''}>${seg}</mark>`;
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
  const range = document.createRange();
  range.setStart(p, 0);
  try { range.setEnd(node, offset); } catch { return null; }
  return +p.dataset.start + range.toString().length;
}

// ---------------------------------------------------------------- figures
async function loadFigures(page) {
  const io = new IntersectionObserver(async (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const img = e.target.querySelector('img');
      try { img.src = await db.figureUrl(e.target.dataset.path); } catch { e.target.classList.add('missing'); }
    }
  }, { rootMargin: '800px' });
  $$('figure.fig', page).forEach((f) => io.observe(f));
}

async function openLightbox(page, fig) {
  const lb = $('.lightbox', page);
  const img = $('img', lb);
  img.removeAttribute('src');
  lb.classList.remove('zoomed');
  $('.lb-cap', lb).textContent = fig.querySelector('figcaption')?.textContent || '';
  lb.hidden = false;
  document.body.classList.add('lb-open');
  try { img.src = fig.querySelector('img').src || (await db.figureUrl(fig.dataset.path)); } catch { /* shown empty */ }
  $('.lb-close', lb).focus();
}
function closeLightbox(page) { const lb = $('.lightbox', page); if (lb) lb.hidden = true; document.body.classList.remove('lb-open'); }

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
  const content = lesson.content;

  // Outline jump
  page.addEventListener('click', (e) => {
    const j = e.target.closest('[data-jump]');
    if (j) { e.preventDefault(); document.getElementById(j.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });

  // Figures: tap a figure or a "(Fig. 21-4)" reference to open it full-screen
  const figureFor = (ref) => $$('figure.fig', page).find((f) => f.dataset.ref === ref);
  page.addEventListener('click', (e) => {
    const fig = e.target.closest('figure.fig');
    if (fig && !e.target.closest('.lightbox')) { openLightbox(page, fig); return; }
    const m = e.target.closest('mark.figref');
    if (m && getSelection().isCollapsed && !m.dataset.hid) {
      const f = figureFor(m.dataset.ref);
      if (f) { openLightbox(page, f); return; }
      const miss = $$('.fig-missing', page).find((x) => x.dataset.ref === m.dataset.ref);
      if (miss) { miss.scrollIntoView({ behavior: 'smooth', block: 'center' }); miss.classList.add('flash'); setTimeout(() => miss.classList.remove('flash'), 1600); }
      else toast('That figure is in another chapter and not part of this lesson.');
    }
  });
  page.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('figure.fig')) openLightbox(page, e.target); });
  const lb = $('.lightbox', page);
  lb?.addEventListener('click', (e) => {
    if (e.target.closest('.lb-close') || e.target === lb) closeLightbox(page);
    else if (e.target.tagName === 'IMG') lb.classList.toggle('zoomed');
  });
  const onKey = (e) => { if (e.key === 'Escape') closeLightbox(page); };
  document.addEventListener('keydown', onKey);

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
    paintText(page, highlights, keys);
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
    paintText(page, highlights, keys);
  });

  // Key sentences (optional, computed on demand, not saved)
  const keyBox = $('[data-key]', page);
  keyBox?.addEventListener('change', async () => {
    if (keyBox.checked) {
      toast('Finding key sentences…');
      try { keys = await keySentences(content, item.title); } catch { keys = []; }
    } else keys = [];
    paintText(page, highlights, keys);
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

  // Reading progress, time left, and resume where you stopped.
  const bar = $('.reader-bar');
  const prog = $('.read-progress span');
  const left = $('.bar-left');
  const article = $('.lesson', page);
  const suppTop = () => document.getElementById('sec-supp')?.offsetTop ?? $('.lesson-foot', page)?.offsetTop ?? article.scrollHeight;
  const posKey = `rounds-pos-${lesson.id}`;
  let lastY = scrollY, saveT = null;
  const onScroll = () => {
    const y = scrollY;
    bar?.classList.toggle('hidden', y > lastY && y > 160 && !document.body.classList.contains('lb-open'));
    lastY = y;
    const end = Math.max(1, suppTop() - innerHeight * 0.6);
    const f = Math.min(1, Math.max(0, y / end));
    if (prog) prog.style.width = `${f * 100}%`;
    if (left && content.minutes) left.textContent = f >= 0.99 ? 'Finished' : `${formatMinutes(content.minutes * (1 - f))} left`;
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { localStorage.setItem(posKey, String(y)); } catch { /* ignore */ } }, 400);
  };
  addEventListener('scroll', onScroll, { passive: true });
  try {
    const saved = +localStorage.getItem(posKey);
    if (saved > 300) {
      requestAnimationFrame(() => scrollTo(0, saved));
      toast('Continuing where you left off');
    }
  } catch { /* ignore */ }
  onScroll();

  return () => {
    document.removeEventListener('selectionchange', onSel);
    document.removeEventListener('keydown', onKey);
    removeEventListener('scroll', onScroll);
    document.body.classList.remove('lb-open');
    tb.remove(); pop.remove();
  };
}

function readPrefs() { try { return { size: 19, ...JSON.parse(localStorage.getItem('rounds-reader') || '{}') }; } catch { return { size: 19 }; } }
function savePrefs(p) { try { localStorage.setItem('rounds-reader', JSON.stringify(p)); } catch { /* ignore */ } }
