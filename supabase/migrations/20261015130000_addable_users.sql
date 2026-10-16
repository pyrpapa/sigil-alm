-- Sigil: choose a new project member from a list instead of typing their email.
-- Someone who manages a project's members sees every Sigil account that is not yet a
-- member of that project (name and email only). Nobody else gets the list.

create function public.project_addable_users(p_project uuid)
returns table (id uuid, email text, full_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_modify_project(p_project, 'members.manage') then
    raise exception 'You do not have permission to manage members of this project' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, p.full_name
    from auth.users u
    join public.profiles p on p.id = u.id
    where not exists (select 1 from public.project_members m where m.project_id = p_project and m.user_id = u.id)
    order by p.full_name, u.email;
end;
$$;

revoke execute on function public.project_addable_users(uuid) from public, anon;
grant execute on function public.project_addable_users(uuid) to authenticated;
