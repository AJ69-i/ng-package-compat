-- ng-package-compat: personal-data sync
--
-- Three new "single-row-per-user JSONB blob" tables for the user's
-- personal workspace: search history, the favorites watchlist (already
-- exists separately, but we standardize the storage shape here), and
-- per-package notes. Same pattern as user_policies / user_favorites /
-- user_snapshots: keep RLS owner-only, touch updated_at on every UPDATE.
--
-- Apply after the previous Supabase migrations.

create table if not exists public.user_history (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  items      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_notes (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  notes      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- RLS ----------

alter table public.user_history enable row level security;
alter table public.user_notes   enable row level security;

drop policy if exists "user_history_owner" on public.user_history;
create policy "user_history_owner" on public.user_history
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_notes_owner" on public.user_notes;
create policy "user_notes_owner" on public.user_notes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- updated_at trigger ----------

drop trigger if exists user_history_touch on public.user_history;
create trigger user_history_touch
  before update on public.user_history
  for each row execute procedure public.touch_updated_at();

drop trigger if exists user_notes_touch on public.user_notes;
create trigger user_notes_touch
  before update on public.user_notes
  for each row execute procedure public.touch_updated_at();
