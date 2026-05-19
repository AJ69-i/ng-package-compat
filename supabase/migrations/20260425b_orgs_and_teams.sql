-- ng-package-compat: org policy templates + team RBAC (features #88, #89)
--
-- Apply after 20260425_user_state_sync.sql.

-- ---------- Teams ----------

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 64),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]+$'),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'member')),
  added_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create index if not exists team_members_user_idx on public.team_members (user_id);

-- ---------- Policy templates (org-shared) ----------

create table if not exists public.org_policy_templates (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  name text not null check (length(name) between 1 and 64),
  description text,
  rules jsonb not null default '[]'::jsonb,
  is_public boolean not null default false,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists org_policy_team_idx on public.org_policy_templates (team_id);
create index if not exists org_policy_public_idx
  on public.org_policy_templates (is_public) where is_public;

-- ---------- RLS ----------

alter table public.teams                 enable row level security;
alter table public.team_members          enable row level security;
alter table public.org_policy_templates  enable row level security;

-- Members can read teams they belong to.
drop policy if exists "teams_member_read" on public.teams;
create policy "teams_member_read" on public.teams for select using (
  exists (
    select 1 from public.team_members tm
    where tm.team_id = teams.id and tm.user_id = auth.uid()
  )
);

drop policy if exists "teams_admin_write" on public.teams;
create policy "teams_admin_write" on public.teams for all using (
  exists (
    select 1 from public.team_members tm
    where tm.team_id = teams.id and tm.user_id = auth.uid() and tm.role = 'admin'
  )
) with check (
  exists (
    select 1 from public.team_members tm
    where tm.team_id = teams.id and tm.user_id = auth.uid() and tm.role = 'admin'
  )
);

drop policy if exists "team_members_self_read" on public.team_members;
create policy "team_members_self_read" on public.team_members for select
  using (user_id = auth.uid() or
    exists (
      select 1 from public.team_members me
      where me.team_id = team_members.team_id and me.user_id = auth.uid()
    ));

drop policy if exists "team_members_admin_write" on public.team_members;
create policy "team_members_admin_write" on public.team_members for all using (
  exists (
    select 1 from public.team_members admin
    where admin.team_id = team_members.team_id
      and admin.user_id = auth.uid()
      and admin.role = 'admin'
  )
);

-- Templates: public ones readable by anyone, team ones readable by members.
drop policy if exists "templates_read" on public.org_policy_templates;
create policy "templates_read" on public.org_policy_templates for select using (
  is_public = true or
  (team_id is not null and exists (
    select 1 from public.team_members tm
    where tm.team_id = org_policy_templates.team_id and tm.user_id = auth.uid()
  ))
);

drop policy if exists "templates_write" on public.org_policy_templates;
create policy "templates_write" on public.org_policy_templates for all using (
  team_id is not null and exists (
    select 1 from public.team_members tm
    where tm.team_id = org_policy_templates.team_id
      and tm.user_id = auth.uid()
      and tm.role = 'admin'
  )
);

-- ---------- updated_at trigger ----------

drop trigger if exists org_policy_touch on public.org_policy_templates;
create trigger org_policy_touch
  before update on public.org_policy_templates
  for each row execute procedure public.touch_updated_at();
