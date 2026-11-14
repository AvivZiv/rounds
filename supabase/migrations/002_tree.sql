-- Rounds — knowledge tree (v2). Run in the Supabase SQL editor after 001_init.sql.
-- Nodes are short generated paragraphs; requests are the queue the laptop generator works through.

create table public.tree_nodes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  item_id     uuid not null references public.items on delete cascade,
  parent_id   uuid references public.tree_nodes on delete cascade,
  depth       int not null default 0,
  ord         int not null default 0,
  label       text not null,            -- "Diagnosis", "Hypertonic saline", ...
  text        text not null,            -- 1-2 sentences
  expandable  boolean not null default true,
  children    text not null default 'none',   -- none | pending | ready
  topic_type  text,                     -- root only: disease | procedure | drug | approach | concept
  model       text,
  created_at  timestamptz not null default now()
);
create index on public.tree_nodes (item_id, parent_id, ord);

create table public.tree_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  item_id     uuid not null references public.items on delete cascade,
  node_id     uuid references public.tree_nodes on delete cascade,   -- null = build the root
  status      text not null default 'pending',   -- pending | running | done | error
  error       text,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  done_at     timestamptz
);
create index on public.tree_requests (status, created_at);

alter table public.tree_nodes enable row level security;
alter table public.tree_requests enable row level security;
create policy "own rows" on public.tree_nodes for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own rows" on public.tree_requests for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Node highlights (the lesson highlights table stays for the book reader).
create table public.node_marks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  node_id     uuid not null references public.tree_nodes on delete cascade,
  style       text not null default 'highlight',
  created_at  timestamptz not null default now(),
  unique (node_id)
);
alter table public.node_marks enable row level security;
create policy "own rows" on public.node_marks for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Let the phone wait for results without polling: enable realtime on these tables.
alter publication supabase_realtime add table public.tree_nodes;
alter publication supabase_realtime add table public.tree_requests;
