-- Sigil Phase 2b: users, project membership and role permissions.
-- SRS: 002 (System Admin), 003 (roles), 004 (project access), 005 (role permissions),
--      006 (database enforcement), 007 (read-only roles), 009 (create project),
--      011 (archive), 012 (members)

---------------------------------------------------------------------------
-- Profiles: one per auth user. Printed name is used on signatures.
---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  full_name text not null default '' check (char_length(full_name) <= 200),
  is_system_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.profiles.is_system_admin is
  'System-level flag, separate from project roles. Only System Admins create user accounts.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create a profile automatically for every new auth user.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for users that already exist.
insert into public.profiles (id, full_name)
select u.id, coalesce(u.raw_user_meta_data ->> 'full_name', '')
from auth.users u
on conflict (id) do nothing;

---------------------------------------------------------------------------
-- Roles and permissions, stored as data.
---------------------------------------------------------------------------
create type public.project_role as enum
  ('admin', 'manager', 'val_specialist', 'val_associate', 'qa', 'viewer');

create table public.permissions (
  key text primary key,
  description text not null
);

insert into public.permissions (key, description) values
  ('project.edit',     'Edit project details'),
  ('project.archive',  'Archive or de-archive the project'),
  ('members.manage',   'Add and remove members and change their roles'),
  ('items.create',     'Create tracker items'),
  ('items.edit',       'Edit tracker items'),
  ('items.transition', 'Move tracker items between workflow states'),
  ('records.sign',     'Sign records at review gates'),
  ('runs.execute',     'Execute test runs'),
  ('runs.review',      'Review and sign executed test runs');

-- Template copied into each new project.
create table public.default_role_permissions (
  role public.project_role not null,
  permission text not null references public.permissions (key),
  primary key (role, permission)
);

insert into public.default_role_permissions (role, permission)
select 'admin'::public.project_role, key from public.permissions
union all
select 'manager', unnest(array['project.edit', 'items.create', 'items.edit', 'items.transition',
                               'records.sign', 'runs.execute', 'runs.review'])
union all
select 'val_specialist', unnest(array['items.create', 'items.edit', 'items.transition',
                                      'records.sign', 'runs.execute', 'runs.review'])
union all
select 'val_associate', unnest(array['items.create', 'items.edit', 'items.transition', 'runs.execute'])
union all
select 'qa', unnest(array['items.transition', 'records.sign', 'runs.review']);
-- viewer: no permissions (read-only)

---------------------------------------------------------------------------
-- Project membership and per-project role permissions.
---------------------------------------------------------------------------
alter table public.projects
  add column planned_start date,
  add column planned_end date,
  add constraint projects_planned_dates_check
    check (planned_end is null or planned_start is null or planned_end >= planned_start);

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  role public.project_role not null,
  added_by uuid references public.profiles (id),
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index project_members_user_idx on public.project_members (user_id);

create table public.role_permissions (
  project_id uuid not null references public.projects (id) on delete restrict,
  role public.project_role not null,
  permission text not null references public.permissions (key),
  primary key (project_id, role, permission)
);

-- Existing projects: creator becomes Admin, defaults copied in.
insert into public.project_members (project_id, user_id, role, added_by)
select p.id, p.created_by, 'admin', p.created_by
from public.projects p
join public.profiles pr on pr.id = p.created_by
on conflict do nothing;

insert into public.role_permissions (project_id, role, permission)
select p.id, d.role, d.permission
from public.projects p cross join public.default_role_permissions d
on conflict do nothing;

---------------------------------------------------------------------------
-- Helper functions used by policies. SECURITY DEFINER so they can read
-- membership without recursing through RLS; they only ever answer about
-- the calling user (auth.uid()).
---------------------------------------------------------------------------
create function public.is_system_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_system_admin from public.profiles p where p.id = (select auth.uid())),
    false);
$$;

create function public.is_project_member(p_project uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = p_project and m.user_id = (select auth.uid()));
$$;

create function public.has_project_permission(p_project uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members m
    join public.role_permissions rp
      on rp.project_id = m.project_id and rp.role = m.role
    where m.project_id = p_project
      and m.user_id = (select auth.uid())
      and rp.permission = p_permission);
$$;

-- Write checks: permission AND the project is not archived.
create function public.can_modify_project(p_project uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_project_permission(p_project, p_permission)
     and exists (select 1 from public.projects p
                 where p.id = p_project and p.status <> 'archived');
$$;

---------------------------------------------------------------------------
-- Creating a project: one atomic call that also makes the creator Admin and
-- copies the default role permissions. Direct inserts are no longer allowed.
---------------------------------------------------------------------------
create function public.create_project(
  p_name text,
  p_system_under_validation text default null,
  p_planned_start date default null,
  p_planned_end date default null
)
returns public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_project public.projects;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a project' using errcode = '42501';
  end if;

  insert into public.projects (name, system_under_validation, planned_start, planned_end, created_by)
  values (trim(p_name), nullif(trim(p_system_under_validation), ''), p_planned_start, p_planned_end, v_uid)
  returning * into v_project;

  insert into public.project_members (project_id, user_id, role, added_by)
  values (v_project.id, v_uid, 'admin', v_uid);

  insert into public.role_permissions (project_id, role, permission)
  select v_project.id, d.role, d.permission from public.default_role_permissions d;

  return v_project;
end;
$$;

revoke execute on function public.create_project(text, text, date, date) from public, anon;
grant execute on function public.create_project(text, text, date, date) to authenticated;

---------------------------------------------------------------------------
-- Project update rules: archived projects are read-only; only users with
-- project.archive can archive or de-archive (and only that, on its own).
---------------------------------------------------------------------------
create function public.enforce_project_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Migrations and the service role (no signed-in user) are not restricted here.
  if (select auth.uid()) is null then
    return new;
  end if;

  if new.id is distinct from old.id or new.created_by is distinct from old.created_by then
    raise exception 'A project''s id and creator cannot change' using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     and (old.status = 'archived' or new.status = 'archived') then
    if not public.has_project_permission(old.id, 'project.archive') then
      raise exception 'Only project Admins can archive or de-archive a project' using errcode = '42501';
    end if;
    if (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
      raise exception 'Archive or de-archive a project separately from other changes' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status = 'archived' then
    raise exception 'Archived projects are read-only' using errcode = '42501';
  end if;

  if not public.has_project_permission(old.id, 'project.edit') then
    raise exception 'You do not have permission to edit this project' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger projects_enforce_update
  before update on public.projects
  for each row execute function public.enforce_project_update();

-- A project must always keep at least one Admin.
create function public.protect_last_admin()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.user_id <> old.user_id) then
    raise exception 'Change a member''s role instead of moving the membership' using errcode = '42501';
  end if;

  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') and not exists (
       select 1 from public.project_members m
       where m.project_id = old.project_id and m.role = 'admin' and m.user_id <> old.user_id) then
    raise exception 'A project must keep at least one Admin' using errcode = '42501';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger project_members_protect_last_admin
  before update or delete on public.project_members
  for each row execute function public.protect_last_admin();

---------------------------------------------------------------------------
-- Row Level Security
---------------------------------------------------------------------------

-- Projects: replace the Phase 0.5 "creator only" policies with membership.
drop policy "Users can view their own projects" on public.projects;
drop policy "Users can create projects they own" on public.projects;
drop policy "Users can update their own projects" on public.projects;

create policy "Members can view their projects"
  on public.projects for select to authenticated
  using (public.is_project_member(id));

create policy "Members can update their projects (rules enforced by trigger)"
  on public.projects for update to authenticated
  using (public.is_project_member(id))
  with check (public.is_project_member(id));
-- No insert policy: projects are created through create_project().
-- No delete policy: projects are archived, never deleted.

-- Profiles: everyone signed in can read names (needed for members and signatures).
alter table public.profiles enable row level security;

create policy "Signed-in users can view profiles"
  on public.profiles for select to authenticated
  using (true);

create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Users may change only their own name: never the System Admin flag.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (full_name) on public.profiles to authenticated;

-- Members
alter table public.project_members enable row level security;

create policy "Members can view their project's members"
  on public.project_members for select to authenticated
  using (public.is_project_member(project_id));

create policy "Member managers can add members"
  on public.project_members for insert to authenticated
  with check (public.can_modify_project(project_id, 'members.manage'));

create policy "Member managers can change roles"
  on public.project_members for update to authenticated
  using (public.can_modify_project(project_id, 'members.manage'))
  with check (public.can_modify_project(project_id, 'members.manage'));

create policy "Member managers can remove members"
  on public.project_members for delete to authenticated
  using (public.can_modify_project(project_id, 'members.manage'));

-- Role permissions: readable by members; not editable in v1 (editing screens in v1.5).
alter table public.role_permissions enable row level security;

create policy "Members can view their project's role permissions"
  on public.role_permissions for select to authenticated
  using (public.is_project_member(project_id));

-- Reference data: read-only for signed-in users.
alter table public.permissions enable row level security;
create policy "Signed-in users can view permissions"
  on public.permissions for select to authenticated using (true);

alter table public.default_role_permissions enable row level security;
create policy "Signed-in users can view default role permissions"
  on public.default_role_permissions for select to authenticated using (true);
