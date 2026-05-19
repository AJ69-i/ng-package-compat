-- ng-package-compat: community gotchas sync
--
-- Per-user storage for community-contributed "gotchas" (the notes the
-- "Contribute a gotcha" panel on the upgrade page produces). Mirrors the
-- single-row-per-user JSONB pattern of user_history / user_notes /
-- user_favorites — small payload, easy RLS, the whole list is read &
-- written together.
--
-- IMPORTANT: this is NOT the same as `public.user_notes`. That table
-- holds per-package private notes (the NotesService).
-- This one holds the user's *publicly-shareable-style* community
-- contributions (the CommunityGotchasService). Different shapes,
-- different lifecycle, separate tables.
--
-- Apply after the previous Supabase migrations.

create table if not exists public.user_gotchas (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  -- Each row is a CommunityNote shape:
  -- { id, pkg, ng, author?, body, createdAt, upvotes?, source: 'user' }
  notes      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- RLS ----------

alter table public.user_gotchas enable row level security;

drop policy if exists "user_gotchas_owner" on public.user_gotchas;
create policy "user_gotchas_owner" on public.user_gotchas
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- updated_at trigger ----------

drop trigger if exists user_gotchas_touch on public.user_gotchas;
create trigger user_gotchas_touch
  before update on public.user_gotchas
  for each row execute procedure public.touch_updated_at();
