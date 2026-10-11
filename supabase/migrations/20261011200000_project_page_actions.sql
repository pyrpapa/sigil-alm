-- Sigil: functions behind the project page.
-- Each change goes through one function call so a reason for the change can be
-- recorded in the same transaction as the change itself (picked up by the audit
-- trigger from the sigil.change_reason setting).
-- SRS: 011 (archive), 012 (members), 029 (reason for change), 032 (history view)

---------------------------------------------------------------------------
-- What can I do in this project? (used to show or hide buttons; the database
-- still enforces every rule on its own)
---------------------------------------------------------------------------
create function public.my_project_permissions(p_project uuid)
returns setof text
language sql
stable
set search_path = ''
as $$
  select rp.permission
  from public.project_members m
  join public.role_permissions rp on rp.project_id = m.project_id and rp.role = m.role
  where m.project_id = p_project and m.user_id = (select auth.uid());
$$;

---------------------------------------------------------------------------
-- Members, with email. Emails live in auth.users, which the app cannot read
-- directly, so this returns them only to members of the project.
---------------------------------------------------------------------------
create function public.project_member_list(p_project uuid)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role public.project_role,
  added_at timestamptz,
  added_by_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, p.full_name, u.email::text, m.role, m.added_at, ab.full_name
  from public.project_members m
  join public.profiles p on p.id = m.user_id
  join auth.users u on u.id = m.user_id
  left join public.profiles ab on ab.id = m.added_by
  where m.project_id = p_project
    and public.is_project_member(p_project)
  order by m.added_at;
$$;

---------------------------------------------------------------------------
-- Add a member by email. SECURITY DEFINER because it looks the email up in
-- auth.users; it checks the caller's permission itself before doing anything.
---------------------------------------------------------------------------
create function public.add_project_member(
  p_project uuid,
  p_email text,
  p_role public.project_role,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if not public.can_modify_project(p_project, 'members.manage') then
    raise exception 'You do not have permission to manage members of this project'
      using errcode = '42501';
  end if;

  select u.id into v_user
  from auth.users u
  where lower(u.email) = lower(trim(p_email));

  if v_user is null then
    raise exception 'No Sigil account uses that email. A System Admin must create the account first.'
      using errcode = 'P0002';
  end if;

  if exists (select 1 from public.project_members m
             where m.project_id = p_project and m.user_id = v_user) then
    raise exception 'That user is already a member of this project' using errcode = '23505';
  end if;

  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  insert into public.project_members (project_id, user_id, role, added_by)
  values (p_project, v_user, p_role, (select auth.uid()));
  perform set_config('sigil.change_reason', '', true);
end;
$$;

---------------------------------------------------------------------------
-- The remaining actions run with the caller's own rights (SECURITY INVOKER),
-- so Row Level Security and the project triggers apply exactly as they would
-- to a direct request.
---------------------------------------------------------------------------
create function public.update_member_role(
  p_project uuid,
  p_user uuid,
  p_role public.project_role,
  p_reason text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  update public.project_members set role = p_role
   where project_id = p_project and user_id = p_user;
  get diagnostics v_count = row_count;
  perform set_config('sigil.change_reason', '', true);

  if v_count = 0 then
    raise exception 'Member not found, or you do not have permission to change roles'
      using errcode = '42501';
  end if;
end;
$$;

create function public.remove_project_member(
  p_project uuid,
  p_user uuid,
  p_reason text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  delete from public.project_members
   where project_id = p_project and user_id = p_user;
  get diagnostics v_count = row_count;
  perform set_config('sigil.change_reason', '', true);

  if v_count = 0 then
    raise exception 'Member not found, or you do not have permission to remove members'
      using errcode = '42501';
  end if;
end;
$$;

create function public.update_project(
  p_project uuid,
  p_name text,
  p_system_under_validation text,
  p_planned_start date,
  p_planned_end date,
  p_reason text default null
)
returns public.projects
language plpgsql
set search_path = ''
as $$
declare
  v_project public.projects;
begin
  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  update public.projects
     set name = trim(p_name),
         system_under_validation = nullif(trim(p_system_under_validation), ''),
         planned_start = p_planned_start,
         planned_end = p_planned_end
   where id = p_project
  returning * into v_project;
  perform set_config('sigil.change_reason', '', true);

  if v_project.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  return v_project;
end;
$$;

-- Archive (read-only) or de-archive (back to Active).
create function public.set_project_archived(
  p_project uuid,
  p_archived boolean,
  p_reason text default null
)
returns public.projects
language plpgsql
set search_path = ''
as $$
declare
  v_project public.projects;
begin
  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  update public.projects
     set status = case when p_archived then 'archived' else 'active' end
   where id = p_project
  returning * into v_project;
  perform set_config('sigil.change_reason', '', true);

  if v_project.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  return v_project;
end;
$$;

---------------------------------------------------------------------------
-- Only signed-in users may call these.
---------------------------------------------------------------------------
revoke execute on function public.my_project_permissions(uuid) from public, anon;
revoke execute on function public.project_member_list(uuid) from public, anon;
revoke execute on function public.add_project_member(uuid, text, public.project_role, text) from public, anon;
revoke execute on function public.update_member_role(uuid, uuid, public.project_role, text) from public, anon;
revoke execute on function public.remove_project_member(uuid, uuid, text) from public, anon;
revoke execute on function public.update_project(uuid, text, text, date, date, text) from public, anon;
revoke execute on function public.set_project_archived(uuid, boolean, text) from public, anon;

grant execute on function public.my_project_permissions(uuid) to authenticated;
grant execute on function public.project_member_list(uuid) to authenticated;
grant execute on function public.add_project_member(uuid, text, public.project_role, text) to authenticated;
grant execute on function public.update_member_role(uuid, uuid, public.project_role, text) to authenticated;
grant execute on function public.remove_project_member(uuid, uuid, text) to authenticated;
grant execute on function public.update_project(uuid, text, text, date, date, text) to authenticated;
grant execute on function public.set_project_archived(uuid, boolean, text) to authenticated;
