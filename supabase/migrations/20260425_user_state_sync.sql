-- ng-package-compat: per-user state sync tables
--
-- Two small JSONB-blob tables backing SupabaseSyncService. We store the
-- whole list as one row per user instead of splitting each rule / favorite
-- into its own row because:
--   1. They're tiny (a typical user has < 50 rules, < 200 favorites).
--   2. The app reads/writes the entire collection every time.
--   3. RLS is much simpler with a single-row-per-user model.
--
-- Apply: paste into the Supabase SQL editor, or use `supabase db push`
-- if you've wired the CLI.

create table if not exists public.user_policies (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rules jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_favorites (
  user_id uuid primary key references auth.users(id) on delete cascade,
  names jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Snapshots are append-only — useful for the monitor digest "since last check"
-- comparison and for time-travel diffs in a future feature.
create table if not exists public.user_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_label text not null,
  captured_at timestamptz not null default now(),
  health_score int,
  payload jsonb not null,
  -- Lossy projection only — we don't store the full report.
  unique (user_id, project_label, captured_at)
);

create index if not exists user_snapshots_user_label_idx
  on public.user_snapshots (user_id, project_label, captured_at desc);

-- ---------- Row-level security ----------

alter table public.user_policies   enable row level security;
alter table public.user_favorites  enable row level security;
alter table public.user_snapshots  enable row level security;

-- Policies are "owner only" for all three tables. The RLS predicate matches
-- the JWT's `sub` claim against `user_id`.

drop policy if exists "user_policies_owner" on public.user_policies;
create policy "user_policies_owner" on public.user_policies
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_favorites_owner" on public.user_favorites;
create policy "user_favorites_owner" on public.user_favorites
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_snapshots_owner" on public.user_snapshots;
create policy "user_snapshots_owner" on public.user_snapshots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- Touch updated_at on every UPDATE ----------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_policies_touch on public.user_policies;
create trigger user_policies_touch
  before update on public.user_policies
  for each row execute procedure public.touch_updated_at();

drop trigger if exists user_favorites_touch on public.user_favorites;
create trigger user_favorites_touch
  before update on public.user_favorites
  for each row execute procedure public.touch_updated_at();
