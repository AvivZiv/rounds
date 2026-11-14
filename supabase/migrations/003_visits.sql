-- Rounds — study trail. Run in the Supabase SQL editor after 002_tree.sql.
-- Records which nodes you have opened, so the Map shows where you went.
alter table public.tree_nodes
  add column if not exists visited_at  timestamptz,
  add column if not exists visit_count int not null default 0;
