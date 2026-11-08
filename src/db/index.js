import { LOCAL_MODE } from '../config.js';

// Picks the backend once. Supabase code is only loaded when configured.
export const db = LOCAL_MODE
  ? (await import('./local.js')).local
  : (await import('./supabase.js')).supabase;
