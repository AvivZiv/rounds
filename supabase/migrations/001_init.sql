-- Rounds Study Companion — schema v1
-- Run this once in the Supabase SQL editor (or `supabase db push`).
-- Every table carries user_id and is protected by row-level security, so the
-- data model is already multi-user ready even though v1 has a single owner.

create extension if not exists vector;

-- ---------------------------------------------------------------- lists
create table public.lists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  position    double precision not null default 0,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- books
create table public.books (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  title            text not null,
  file_path        text,                 -- object path in the private "books" bucket (null if too large to store)
  file_size        bigint,
  page_count       int,
  processed_pages  int not null default 0,
  status           text not null default 'pending',   -- pending | processing | ready | error
  error            text,
  body_font_size   real,
  created_at       timestamptz not null default now()
);

create table public.book_sections (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  book_id     uuid not null references public.books on delete cascade,
  level       int not null,              -- 1 = chapter, 2 = section, 3 = subsection
  title       text not null,
  page_start  int not null,
  ord         int not null
);
create index on public.book_sections (book_id, ord);

-- A chunk is one or more original paragraphs, quoted verbatim.
create table public.chunks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  book_id       uuid not null references public.books on delete cascade,
  ord           int not null,            -- reading order inside the book
  chapter       text,
  section       text,
  section_key   text,                    -- stable id of the (sub)section this chunk sits in
  page_start    int not null,
  page_end      int not null,
  text          text not null,
  word_count    int not null,
  embedding     vector(384),
  fts           tsvector generated always as (to_tsvector('english', coalesce(section,'') || ' ' || text)) stored
);
create index on public.chunks (book_id, ord);
create index on public.chunks (book_id, section_key);
create index on public.chunks using gin (fts);
create index on public.chunks using hnsw (embedding vector_cosine_ops);

create table public.figures (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  book_id     uuid not null references public.books on delete cascade,
  page        int not null,
  kind        text not null,             -- figure | table
  label       text,                      -- e.g. "25-3"
  caption     text,
  image_path  text not null,             -- object path in the private "figures" bucket
  width       int,
  height      int,
  section_key text
);
create index on public.figures (book_id, page);

-- ---------------------------------------------------------------- items
create table public.items (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid() references auth.users on delete cascade,
  list_id            uuid references public.lists on delete set null,
  title              text not null,
  note               text,
  deadline           date,
  depth              text not null default 'basic',        -- basic | expanded
  preferred_book_id  uuid references public.books on delete set null,
  position           double precision not null default 0,
  status             text not null default 'open',         -- open | done
  done_at            timestamptz,
  review_date        date,
  est_basic_min      real,
  est_expanded_min   real,
  coverage           text,                                  -- covered | none | null(unknown)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on public.items (user_id, list_id, position);

create table public.lessons (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  item_id     uuid not null references public.items on delete cascade,
  depth       text not null,
  content     jsonb not null,
  library_sig text,                      -- which books/versions it was built from
  built_at    timestamptz not null default now(),
  unique (item_id, depth)
);

create table public.highlights (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  lesson_id   uuid not null references public.lessons on delete cascade,
  chunk_id    text not null,
  start_off   int not null,
  end_off     int not null,
  style       text not null default 'highlight',   -- highlight | underline
  created_at  timestamptz not null default now()
);
create index on public.highlights (lesson_id);

create table public.settings (
  user_id          uuid primary key default auth.uid() references auth.users on delete cascade,
  career_interest  text,
  emphasis         text[] not null default '{}',
  theme            text not null default 'auto',
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS
do $$
declare t text;
begin
  foreach t in array array['lists','books','book_sections','chunks','figures','items','lessons','highlights','settings']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- hybrid search
-- Combines vector similarity with Postgres full-text search via reciprocal-rank fusion.
create or replace function public.match_chunks(
  query_embedding vector(384),
  query_text      text,
  match_count     int default 60,
  book_filter     uuid[] default null
) returns table (
  id uuid, book_id uuid, ord int, chapter text, section text, section_key text,
  page_start int, page_end int, text text, word_count int,
  similarity real, keyword_rank real, score real
)
language sql stable security invoker as $$
  with sem as (
    select c.id, 1 - (c.embedding <=> query_embedding) as sim,
           row_number() over (order by c.embedding <=> query_embedding) as r
    from public.chunks c
    where c.user_id = auth.uid() and (book_filter is null or c.book_id = any(book_filter))
    order by c.embedding <=> query_embedding
    limit match_count * 2
  ),
  kw as (
    select c.id, ts_rank_cd(c.fts, q) as kr,
           row_number() over (order by ts_rank_cd(c.fts, q) desc) as r
    from public.chunks c, websearch_to_tsquery('english', query_text) q
    where c.user_id = auth.uid() and c.fts @@ q
      and (book_filter is null or c.book_id = any(book_filter))
    order by kr desc
    limit match_count * 2
  ),
  fused as (
    select coalesce(sem.id, kw.id) as id,
           coalesce(1.0/(60+sem.r),0) + coalesce(1.0/(60+kw.r),0) as rrf
    from sem full outer join kw on sem.id = kw.id
  )
  select c.id, c.book_id, c.ord, c.chapter, c.section, c.section_key, c.page_start, c.page_end,
         c.text, c.word_count,
         (1 - (c.embedding <=> query_embedding))::real as similarity,
         coalesce((select kr from kw where kw.id = c.id), 0)::real as keyword_rank,
         f.rrf::real as score
  from fused f join public.chunks c on c.id = f.id
  order by f.rrf desc
  limit match_count;
$$;

-- Fetch chunks with their embeddings for given sections (used to expand context around hits).
create or replace function public.section_chunks(keys text[])
returns setof public.chunks
language sql stable security invoker as $$
  select * from public.chunks where user_id = auth.uid() and section_key = any(keys) order by book_id, ord;
$$;

-- ---------------------------------------------------------------- storage
-- Two PRIVATE buckets. Nothing here is ever public; the app reads via short-lived signed URLs.
insert into storage.buckets (id, name, public) values ('books', 'books', false) on conflict do nothing;
insert into storage.buckets (id, name, public) values ('figures', 'figures', false) on conflict do nothing;

create policy "own files read"   on storage.objects for select using (bucket_id in ('books','figures') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files write"  on storage.objects for insert with check (bucket_id in ('books','figures') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files update" on storage.objects for update using (bucket_id in ('books','figures') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own files delete" on storage.objects for delete using (bucket_id in ('books','figures') and (storage.foldername(name))[1] = auth.uid()::text);
