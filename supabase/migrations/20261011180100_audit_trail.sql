-- Sigil Phase 2c: insert-only audit trail, written by database triggers.
-- SRS: 028 (audit every change), 029 (reason for change), 030 (immutable),
--      031 (captured in the database), 033 (UTC timestamps)

create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),   -- stored in UTC
  table_name text not null,
  record_id text not null,
  project_id uuid,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  changed_by uuid,            -- auth.uid(); null for migrations and system jobs
  changed_fields text[],      -- UPDATE only
  old_values jsonb,           -- UPDATE: changed fields only; DELETE: whole row
  new_values jsonb,           -- INSERT: whole row; UPDATE: changed fields only
  reason text
);

create index audit_log_record_idx on public.audit_log (table_name, record_id, occurred_at);
create index audit_log_project_idx on public.audit_log (project_id, occurred_at);

comment on table public.audit_log is
  'Insert-only. Rows are written only by audit triggers; no role can update or delete them.';

---------------------------------------------------------------------------
-- Generic trigger.
--   TG_ARGV[0]   = name of the column holding the project id ('' if none)
--   TG_ARGV[1..] = key column(s) that identify the record
-- Reason for change: taken from the session setting sigil.change_reason, or
-- from a change_reason column on the record (added to item tables in Phase 2d).
---------------------------------------------------------------------------
create function public.audit_log_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_changed text[];
  v_project_col text := tg_argv[0];
  v_record_id text;
  i int;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key)
      into v_changed
      from jsonb_each(v_new) n
     where n.key not in ('updated_at', 'change_reason')
       and n.value is distinct from v_old -> n.key;

    if v_changed is null then
      return null;   -- nothing meaningful changed (e.g. only updated_at)
    end if;

    select jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k)
      into v_old, v_new
      from unnest(v_changed) k;
  end if;

  v_record_id := '';
  for i in 1 .. tg_nargs - 1 loop
    v_record_id := v_record_id || case when i > 1 then ':' else '' end || coalesce(v_row ->> tg_argv[i], '');
  end loop;

  insert into public.audit_log
    (table_name, record_id, project_id, action, changed_by, changed_fields, old_values, new_values, reason)
  values (
    tg_table_name,
    v_record_id,
    case when v_project_col <> '' then (v_row ->> v_project_col)::uuid end,
    tg_op,
    (select auth.uid()),
    v_changed,
    v_old,
    v_new,
    coalesce(nullif(current_setting('sigil.change_reason', true), ''),
             case when tg_op <> 'DELETE' then to_jsonb(new) ->> 'change_reason' end)
  );

  return null;
end;
$$;

---------------------------------------------------------------------------
-- Immutability: nobody can change or remove audit entries.
-- 1) No privileges for API roles beyond SELECT.
-- 2) A trigger that rejects UPDATE, DELETE and TRUNCATE for every role,
--    including the table owner.
---------------------------------------------------------------------------
revoke all on public.audit_log from public, anon, authenticated, service_role;
grant select on public.audit_log to authenticated, service_role;

create function public.audit_log_is_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Audit entries cannot be modified or deleted' using errcode = '42501';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function public.audit_log_is_immutable();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.audit_log_is_immutable();

-- Who can read audit entries: members of the record's project; for records
-- outside a project, System Admins, or the user whose profile it is.
alter table public.audit_log enable row level security;

create policy "Members can read their project's audit trail"
  on public.audit_log for select to authenticated
  using (
    (project_id is not null and public.is_project_member(project_id))
    or (project_id is null and public.is_system_admin())
    or (table_name = 'profiles' and record_id = (select auth.uid())::text)
  );

---------------------------------------------------------------------------
-- Attach to every table created so far. New tables get the same trigger.
---------------------------------------------------------------------------
create trigger projects_audit
  after insert or update or delete on public.projects
  for each row execute function public.audit_log_change('id', 'id');

create trigger project_members_audit
  after insert or update or delete on public.project_members
  for each row execute function public.audit_log_change('project_id', 'project_id', 'user_id');

create trigger role_permissions_audit
  after insert or update or delete on public.role_permissions
  for each row execute function public.audit_log_change('project_id', 'project_id', 'role', 'permission');

create trigger profiles_audit
  after insert or update or delete on public.profiles
  for each row execute function public.audit_log_change('', 'id');
