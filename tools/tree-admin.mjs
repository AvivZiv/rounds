#!/usr/bin/env node
// Maintenance for the knowledge tree, run as the owner (uses .env.local).
//   node tools/tree-admin.mjs status      # items, roots, nodes, pending requests
//   node tools/tree-admin.mjs dedupe      # remove duplicate sibling branches (same parent + label), keeping the oldest
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(path.join(here, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { error } = await sb.auth.signInWithPassword({ email: process.env.OWNER_EMAIL, password: process.env.OWNER_PASSWORD });
if (error) { console.error('sign-in failed:', error.message); process.exit(2); }
const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const cmd = process.argv[2] || 'status';
const items = check(await sb.from('items').select('id,title,status'));
const nodes = [];
for (let from = 0; ; from += 1000) { // the API returns at most 1000 rows per call
  const page = check(await sb.from('tree_nodes').select('id,item_id,parent_id,label,depth,children,created_at').order('created_at').range(from, from + 999));
  nodes.push(...page); if (page.length < 1000) break;
}

if (cmd === 'status') {
  const roots = nodes.filter((n) => !n.parent_id);
  const reqs = check(await sb.from('tree_requests').select('status'));
  console.log(`items: ${items.length} (${items.filter((i) => i.status === 'open').length} open)`);
  console.log(`roots: ${roots.length}, nodes: ${nodes.length}, pending nodes: ${nodes.filter((n) => n.children === 'pending').length}`);
  console.log(`requests: ${JSON.stringify(reqs.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}))}`);
  for (const it of items.filter((i) => i.status === 'open')) {
    const mine = nodes.filter((n) => n.item_id === it.id);
    console.log(`  ${mine.some((n) => !n.parent_id) ? '✓' : '…'} ${it.title.slice(0, 50)} — ${mine.length} nodes, depth ${Math.max(0, ...mine.map((n) => n.depth))}`);
  }
}

if (cmd === 'dedupe') {
  // Duplicates: siblings with the same label. Keep the oldest; delete the rest (children cascade).
  const cutoff = Date.now() - 2 * 60 * 1000; // leave anything being generated right now alone
  const groups = new Map();
  for (const n of nodes) { const k = `${n.parent_id || 'root:' + n.item_id}|${n.label.toLowerCase()}`; (groups.get(k) || groups.set(k, []).get(k)).push(n); }
  const victims = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const d of g.slice(1)) if (new Date(d.created_at).getTime() < cutoff) victims.push(d);
  }
  // Also: duplicate roots for one item -> keep oldest root (its subtree), drop the others.
  console.log(`duplicate branches to remove: ${victims.length}`);
  for (const v of victims) console.log(`  - ${items.find((i) => i.id === v.item_id)?.title.slice(0, 40)} > ${v.label} (depth ${v.depth})`);
  if (victims.length) check(await sb.from('tree_nodes').delete().in('id', victims.map((v) => v.id)));
  console.log('done');
}
