// Build-time configuration. Set these as GitHub Actions secrets/variables (see README)
// or in a local `.env` file. The anon key is safe to ship: row-level security protects data.
//
// If SUPABASE_URL is empty the app runs in LOCAL MODE: everything is stored in this
// browser's IndexedDB, nothing syncs, and no password is asked. Useful for trying it out.

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
// The single owner account. v1 shows only a password field; this email is fixed.
export const OWNER_EMAIL = import.meta.env.VITE_OWNER_EMAIL || '';

export const LOCAL_MODE = !SUPABASE_URL;

// Embedding model, run in the browser (free, no API cost). 384-dim vectors.
export const EMBED_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBED_DIM = 384;
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

// Reading speed used for time estimates (dense textbook prose).
export const WORDS_PER_MINUTE = 180;
export const SECONDS_PER_FIGURE = 30;

// Supabase free tier rejects uploads over 50 MB. Larger PDFs are still indexed,
// but the original file is not kept in storage (figures are pre-cropped anyway).
export const MAX_STORED_PDF_BYTES = 50 * 1024 * 1024;
