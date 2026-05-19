-- ng-package-compat: Supabase migration completeness check
--
-- Diagnostic-only query (NOT a migration). Paste into the Supabase
-- SQL Editor and Run. Returns one row per user-data table the app
-- syncs to. Every status must read 'ok'.
--
-- Tables verified (with the migration that owns each):
--   public.user_policies         — synced rule sets               (20260425)
--   public.user_favorites        — starred packages               (20260425)
--   public.user_snapshots        — captured project diffs         (20260425)
--   public.teams                 — team workspaces                (20260425b)
--   public.team_members          — RBAC membership rows           (20260425b)
--   public.org_policy_templates  — team-shared rule presets       (20260425b)
--   public.user_history          — recent searches                (20260427)
--   public.user_notes            — per-package private notes      (20260427)
--   public.user_gotchas          — community-contributed notes    (20260430)
--
-- Possible statuses:
--   ok            — table exists AND row-level security is enabled
--   MISSING TABLE — corresponding migration hasn't been applied
--   RLS OFF       — table exists but RLS is disabled (security issue;
--                    re-run the migration that owns this table)
--
-- Run this AFTER applying every migration in supabase/migrations/.
-- Re-run any time you suspect a migration drifted out of sync, e.g.
-- after restoring a database backup or switching projects.

with expected as (
  select unnest(array[
    'user_policies',
    'user_favorites',
    'user_snapshots',
    'user_history',
    'user_notes',
    'user_gotchas',
    'teams',
    'team_members',
    'org_policy_templates'
  ]) as table_name
)
select
  e.table_name,
  case when t.table_name is null then 'MISSING TABLE'
       when not p.rowsecurity   then 'RLS OFF'
       else 'ok'
  end as status
from expected e
left join information_schema.tables t
  on t.table_schema = 'public' and t.table_name = e.table_name
left join pg_tables p
  on p.schemaname = 'public' and p.tablename = e.table_name
order by e.table_name;
