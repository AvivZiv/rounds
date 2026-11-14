# Rounds — Study Companion (v2)

Capture what comes up on rounds in a few seconds, then learn it as a **knowledge tree**: short paragraphs (1–2 sentences each) covering the whole scope of the topic in clinical order, each one opening into its own short paragraphs, as deep as you need. Your own textbooks are one tap away from any node ("In your books").

## v2: the knowledge tree

- **Nodes are written by Claude**, through your Claude subscription (Claude Code headless), not an API key. Content is generated, not quoted; verify doses and cut-offs against the book node ("In your books" shows the matching textbook passage with page).
- **How it runs:** the phone/web app writes a request to Supabase; a small **generator on your laptop** (`npm run generator`, or installed at login with `npm run generator:install`) picks it up, runs `claude -p`, and writes the nodes back. Roots are pre-built two levels deep for every open item, so most taps are instant; deeper dives wait for the laptop if it is asleep. Config lives in `.env.local` (copy of `.env.example` plus `OWNER_PASSWORD`); it never leaves the laptop.
- **Database:** run `supabase/migrations/002_tree.sql` after `001_init.sql`.
- **Model:** `claude-sonnet-5-5` by default (same node quality as Opus in testing, three times faster); set `ROUNDS_MODEL` in `.env.local` to change it.
- In local mode (no Supabase) the dev server builds trees itself via `/__tree`.
- The verbatim lesson builder from v1 is still there ("From your books" on an item) but no longer runs in the background.


- **Quick capture** — one field; Advanced (list, deadline, depth, preferred book, note) is collapsed.
- **Lists & Today** — your own lists, drag to prioritise, deadlines; *Today* collects overdue, due-in-3-days and review-today items from every list.
- **Library** — upload your PDF textbooks; each is processed **once** (text, chapters/sections, figures & tables, embeddings).
- **Lessons** — verbatim book paragraphs, possibly from several books, organised into sections (*What it is / How to perform it / Why it works / Diagnosis / Treatment …*). Basic or expanded. Every passage shows book · chapter · section · page. If no book covers the topic, it says so.
- **Reading view** — text (not a PDF), paper background, book typography, dark mode, outline, coloured section rules, figures/tables as cropped page images, highlight/underline (saved), optional key-sentence underlining.
- **After reading** — mark done, set a review date; the item returns to *Today* on that date.

## How it works

| Piece | Where it runs | Cost |
|---|---|---|
| UI (static site, installable PWA) | GitHub Pages | free |
| Auth, database (Postgres + pgvector), **private** file storage | Supabase free tier | free |
| PDF processing (pdf.js) and embeddings (`bge-small-en-v1.5`, quantised, ~34 MB, downloaded once) | **in your browser** | free |
| Optional connecting notes (1–3 sentences, only when a section mixes books/chapters) | Supabase Edge Function → Claude API | ~fractions of a cent per lesson; off unless you set a key |

Books are embedded once at upload; lessons are cached and only rebuilt when your library, the item title, preferred book or specialty settings change. PDFs and figure crops live in **private** buckets and are read through short-lived signed URLs. Nothing is ever public.

```
src/
  lib/pdf-ingest.js   column-aware text extraction, headings, captions, figure/table crops, chunking
  lib/lesson.js       hybrid retrieval, coverage check, passage selection, section roles, figures, notes, timing
  lib/embed.js        embedding worker client (workers/embed.worker.js)
  db/supabase.js      Supabase backend      db/local.js  IndexedDB backend (local mode)
  views/              today, lists, item, library, reader, settings
supabase/migrations/001_init.sql     tables, row-level security, hybrid search function, private buckets
supabase/functions/connect-note/     optional Claude-written connecting notes
```

## Try it locally (no account needed)

```bash
npm install
```
```bash
npm run dev
```

With no Supabase settings the app runs in **local mode**: everything stays in that browser (IndexedDB), no password, no sync. Two small original sample books are in `samples/` (regenerate with `python3 tools/make_sample_pdfs.py`, needs PyMuPDF) — upload them in *Library* and add items such as “Dix-Hallpike and Epley for BPPV”, “Heart failure”, or “Kawasaki disease” (the last one is correctly reported as not covered).

## Deploy (GitHub Pages + Supabase)

1. **Supabase project** (free): create one at supabase.com.
   - SQL editor → run `supabase/migrations/001_init.sql`.
   - Authentication → Users → *Add user* with your email and a strong password.
   - Authentication → Sign In / Providers → **turn off “Allow new users to sign up”** (single-owner app).
   - Settings → API: copy the *Project URL* and the *anon public* key.
2. **GitHub repo**: push this folder. Settings → Pages → Source: **GitHub Actions**.
   Settings → Secrets and variables → Actions → **Variables**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `OWNER_EMAIL`.
   The anon key is designed to be public; row-level security restricts every row and file to the signed-in owner.
3. Push to `main` — `.github/workflows/deploy.yml` builds and publishes. Open the Pages URL, enter your password. On a phone: *Share → Add to Home Screen*.
4. *(Optional)* connecting notes written by Claude:
   ```bash
   supabase functions deploy connect-note
   ```
   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   ```
   Uses `claude-opus-5-5` at low effort by default; set `CLAUDE_MODEL` to change it. Without a key the app writes a plain note that only lists the cited pages. Either way the note is visually marked as generated.

## Using it well

- **Upload books on a laptop**, tab in front (browsers throttle background tabs; the app holds a wake lock). Indexing can be paused and resumed. Scanned PDFs without a text layer are rejected — OCR them first.
- Supabase free storage rejects files over 50 MB. Larger PDFs are still fully indexed (figures are pre-cropped), but the original isn't kept, so *Re-index/Resume* will need a re-upload.
- Free-tier space: roughly 30–40 MB of database per 4,000-page textbook, plus figure crops (~40 KB each) in storage.
- Multi-part topics work: “Dix-Hallpike **and** Epley **for** BPPV” is searched as the whole phrase plus each part.

## Known limits (v1)

- **Section detection** relies on the PDF outline plus font size/weight. Unusual layouts can mislabel headings; passages themselves stay verbatim. `debugPage()` / `debugWalk()` in `pdf-ingest.js` print how a page was read, for tuning.
- **Figures/tables** are always shown as cropped page images (the spec's fallback). Captions that drift away from their image are paired with the largest unused image on the page; vector-only figures use the blank space above the caption.
- **Relevance thresholds** in `lesson.js` (`COVER_REL`, `ABS_FLOOR`, margins) were calibrated on the sample books only. With a tiny library, *expanded* lessons for narrow topics can pull in loosely related passages; they should tighten as real textbooks give more on-topic material. Expect to adjust them after trying your own books.
- Section roles (What it is / Diagnosis / …) are assigned by heading keywords + embeddings and are sometimes approximate.
- The SQL migration and Supabase backend compile into the build but have not been run against a live Supabase project yet; local mode was tested end to end.
- Not in v1: quizzes, multiple users/sharing, notifications, native apps. The schema already carries `user_id` on every row with row-level security.

## Copyright

Your books are processed for your private use only. They are stored in private buckets, readable only by your account, and never published or shared.
