#!/usr/bin/env node
// Laptop generator: turns tree requests in Supabase into nodes, using the owner's Claude
// subscription through the Claude Code CLI. Runs forever; install with `npm run generator:install`.
//
//   node tools/generator.mjs            # loop
//   node tools/generator.mjs --once     # drain the queue and exit
//
// Config: rounds/.env.local (SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_EMAIL, OWNER_PASSWORD, ROUNDS_MODEL)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { generate, levelLine } from './tree-gen.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(here, '..', '.env.local'));
const { SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_EMAIL, OWNER_PASSWORD } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !OWNER_EMAIL || !OWNER_PASSWORD || OWNER_PASSWORD.startsWith('PASTE')) {
  console.error('generator: fill in rounds/.env.local first (SUPABASE_URL, SUPABASE_ANON_KEY, OWNER_EMAIL, OWNER_PASSWORD).');
  process.exit(2);
}
const once = process.argv.includes('--once');
const PREBUILD_DEPTH = 2;     // roots are expanded this deep ahead of time
const IDLE_MS = 4000;         // poll interval when nothing is pending (realtime also wakes us)
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: true } });
{
  const { error } = await sb.auth.signInWithPassword({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
  if (error) { console.error('generator: sign-in failed:', error.message); process.exit(2); }
}
const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
let settings = {};
try { settings = (await sb.from('settings').select('*').maybeSingle()).data || {}; } catch { /* defaults */ }

let wake = () => {};
sb.channel('gen').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tree_requests' }, () => wake()).subscribe();
process.on('SIGTERM', () => process.exit(0));

log(`generator ready (${process.env.ROUNDS_MODEL || 'claude-sonnet-5-5'})`);
for (;;) {
  let did = false;
  try { did = await step(); } catch (e) { log('error:', e.message); await sleep(5000); }
  if (!did) {
    if (once) break;
    await Promise.race([sleep(IDLE_MS), new Promise((r) => (wake = r))]);
  }
}

async function step() {
  // 1. explicit requests first (someone is waiting on the phone)
  const [req] = check(await sb.from('tree_requests').select('*').eq('status', 'pending').order('created_at').limit(1));
  if (req) { await handle(req); return true; }
  // 2. then background work: items without a root, and shallow nodes under PREBUILD_DEPTH
  const items = check(await sb.from('items').select('id,title,note,status').eq('status', 'open'));
  const roots = check(await sb.from('tree_nodes').select('item_id').is('parent_id', null));
  const have = new Set(roots.map((r) => r.item_id));
  const missing = items.find((i) => !have.has(i.id));
  if (missing) { await buildRoot(missing); return true; }
  const [shallow] = check(await sb.from('tree_nodes').select('*').eq('children', 'none').eq('expandable', true).lt('depth', PREBUILD_DEPTH).order('created_at').limit(1));
  if (shallow) {
    const item = items.find((i) => i.id === shallow.item_id);
    if (item) { await expand(item, shallow); return true; }
  }
  return false;
}

async function handle(req) {
  check(await sb.from('tree_requests').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', req.id));
  try {
    const item = check(await sb.from('items').select('id,title,note').eq('id', req.item_id).single());
    if (req.node_id) {
      const node = check(await sb.from('tree_nodes').select('*').eq('id', req.node_id).single());
      if (node.children !== 'ready') await expand(item, node);
    } else {
      const roots = check(await sb.from('tree_nodes').select('id').eq('item_id', item.id).is('parent_id', null));
      if (!roots.length) await buildRoot(item);
    }
    check(await sb.from('tree_requests').update({ status: 'done', done_at: new Date().toISOString() }).eq('id', req.id));
  } catch (e) {
    log('request failed:', e.message);
    check(await sb.from('tree_requests').update({ status: 'error', error: e.message.slice(0, 500), done_at: new Date().toISOString() }).eq('id', req.id));
    if (req.node_id) await sb.from('tree_nodes').update({ children: 'none' }).eq('id', req.node_id);
  }
}

async function buildRoot(item) {
  log(`root: ${item.title}`);
  const g = await generate({ topic: item.title, note: item.note, level: levelLine(settings) }, null);
  const root = check(await sb.from('tree_nodes').insert({
    item_id: item.id, parent_id: null, depth: 0, ord: 0, label: item.title, text: g.root.summary,
    expandable: true, children: 'ready', topic_type: g.root.topic_type, model: g.model,
  }).select().single());
  check(await sb.from('tree_nodes').insert(g.nodes.map((n) => ({ item_id: item.id, parent_id: root.id, depth: 1, ...n, children: 'none', model: g.model }))));
}

async function expand(item, node) {
  log(`expand: ${item.title} > ${node.label}`);
  check(await sb.from('tree_nodes').update({ children: 'pending' }).eq('id', node.id));
  const all = check(await sb.from('tree_nodes').select('id,parent_id,label,text,depth').eq('item_id', item.id));
  const byId = new Map(all.map((n) => [n.id, n]));
  const ancestors = [];
  for (let p = byId.get(node.parent_id); p; p = byId.get(p.parent_id)) ancestors.unshift({ label: p.label, text: p.text });
  const siblings = all.filter((n) => n.parent_id === node.parent_id && n.id !== node.id).map((n) => ({ label: n.label }));
  const g = await generate({ topic: item.title, note: item.note, level: levelLine(settings) }, { node: { label: node.label, text: node.text, depth: node.depth }, ancestors, siblings });
  check(await sb.from('tree_nodes').insert(g.nodes.map((n) => ({ item_id: item.id, parent_id: node.id, depth: node.depth + 1, ...n, children: 'none', model: g.model }))));
  check(await sb.from('tree_nodes').update({ children: 'ready' }).eq('id', node.id));
}

function loadEnv(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no file: rely on the environment */ }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
