import { store, queueMissingEstimates } from '../store.js';
import { db } from '../db/index.js';
import { esc, icon, $, toast, confirmDialog } from '../ui.js';
import { onModelProgress } from '../lib/embed.js';

// Ingestion jobs live outside the view so they survive navigation.
const jobs = new Map(); // bookId -> {phase, page, pages, msg, ctrl}
const jobQueue = [];
let jobRunning = false;
let modelMsg = '';
onModelProgress((p) => {
  if (p.status === 'progress' && p.total > 1e6) { modelMsg = `Downloading reading model… ${Math.round(p.progress)}%`; store.emit(); }
  else if (p.status === 'ready') { modelMsg = ''; store.emit(); }
});

function enqueue(book, file) {
  jobs.set(book.id, { phase: 'queued', ctrl: new AbortController() });
  jobQueue.push({ book, file });
  store.emit();
  runJobs();
}

async function runJobs() {
  if (jobRunning) return;
  jobRunning = true;
  const { ingestBook } = await import('../lib/pdf-ingest.js'); // pdf.js loads only when needed
  // Keep the screen awake while indexing; browsers slow down background tabs a lot.
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  while (jobQueue.length) {
    const { book, file } = jobQueue.shift();
    const job = jobs.get(book.id);
    try {
      await ingestBook(book, file, (p) => { Object.assign(job, p); store.emit(); }, { signal: job.ctrl.signal });
      toast(`“${book.title}” is ready`);
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error(e);
        await db.updateBook(book.id, { status: 'error', error: e.message }).catch(() => {});
        toast(`Problem with “${book.title}”: ${e.message}`, 5000);
      }
    }
    jobs.delete(book.id);
    await store.refreshBooks();
  }
  jobRunning = false;
  lock?.release().catch(() => {});
  queueMissingEstimates();
}

export function renderLibrary(root) {
  const row = (b) => {
    const job = jobs.get(b.id);
    const pct = b.page_count ? Math.round(((job?.page ?? b.processed_pages) / b.page_count) * 100) : 0;
    let status;
    if (job) {
      const label = { queued: 'Waiting…', upload: 'Uploading to private storage…', download: 'Fetching stored PDF…', analyse: 'Reading the layout…', pages: `Page ${job.page} of ${job.pages}`, embed: `Indexing ${job.msg || ''}` }[job.phase] || '…';
      status = `<div class="progress"><span style="width:${pct}%"></span></div><span class="small muted">${esc(label)}</span>
        <button class="btn small ghost" data-act="cancel" data-id="${b.id}">Pause</button>`;
    } else if (b.status === 'ready') status = `<span class="small muted">${b.page_count} pages · indexed</span>`;
    else {
      const where = `${b.status === 'error' ? `<span class="small error">${esc(b.error || 'Error')}</span> · ` : ''}<span class="small muted">stopped at page ${b.processed_pages} of ${b.page_count || '?'}</span>`;
      status = where + (b.file_path
        ? ` <button class="btn small" data-act="resume" data-id="${b.id}">Continue</button>`
        : ` <label class="btn small">Choose the PDF to continue<input type="file" accept="application/pdf" hidden data-reupload="${b.id}"></label>`);
    }
    return `<li class="book" data-id="${b.id}">
      <div class="book-icon">${icon('book')}</div>
      <div class="grow">
        <input class="book-title" value="${esc(b.title)}" data-id="${b.id}" aria-label="Book title">
        <div class="book-status">${status}</div>
      </div>
      <details class="menu"><summary aria-label="Book options">${icon('more')}</summary><div class="menu-pop">
        ${b.file_path && !job ? `<button data-act="reindex" data-id="${b.id}">Re-index</button>` : ''}
        <button data-act="delete" data-id="${b.id}" class="danger">Delete</button></div></details>
    </li>`;
  };
  root.innerHTML = `
    <header class="page-head"><h1>Library</h1>
      <p class="muted">Your own textbooks. They stay private to you and are processed once on upload.</p></header>
    <label class="upload">
      <input type="file" accept="application/pdf" multiple hidden>
      ${icon('upload')} <span>Upload PDF textbooks</span>
    </label>
    ${modelMsg ? `<p class="small muted">${esc(modelMsg)}</p>` : ''}
    <p class="small muted">Large books take a while. Keep this tab in front while it works — browsers slow down background tabs. You can pause and resume. A laptop is faster than a phone.</p>
    <ul class="books">${store.books.map(row).join('') || '<li class="empty">No books yet.</li>'}</ul>`;

  $('.upload input', root).addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      const title = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
      const book = await db.createBook({ title, file_size: file.size });
      store.books.push(book);
      enqueue(book, file);
    }
    e.target.value = '';
  });
  root.querySelector('.books').addEventListener('change', async (e) => {
    if (e.target.dataset.reupload) {
      // Large PDFs are not stored; picking the file again continues from the last indexed page.
      const book = store.book(e.target.dataset.reupload);
      const file = e.target.files[0];
      if (book && file) enqueue(await db.updateBook(book.id, { status: 'processing', error: null }), file);
      return;
    }
    if (!e.target.matches('.book-title')) return;
    const title = e.target.value.trim();
    if (title) { await db.updateBook(e.target.dataset.id, { title }); await store.refreshBooks(); }
  });
  root.querySelector('.books').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const book = store.book(b.dataset.id);
    if (b.dataset.act === 'cancel') { jobs.get(book.id)?.ctrl.abort(); }
    else if (b.dataset.act === 'resume') enqueue(book, null);
    else if (b.dataset.act === 'reindex') {
      if (!(await confirmDialog(`Rebuild the index for “${book.title}”? Saved lessons will be rebuilt from it next time.`, 'Re-index'))) return;
      await db.clearBookIndex(book.id);
      enqueue(await db.updateBook(book.id, { processed_pages: 0, status: 'pending' }), null);
    } else if (b.dataset.act === 'delete') {
      if (!(await confirmDialog(`Delete “${book.title}” and its index? Lessons built from it will no longer include it.`))) return;
      jobs.get(book.id)?.ctrl.abort();
      await db.deleteBook(book.id);
      await store.refreshBooks();
    }
  });
}

export const libraryBusy = () => jobs.size > 0;
