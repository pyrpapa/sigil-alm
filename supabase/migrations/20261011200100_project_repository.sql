-- Sigil: link a project to the GitHub repository that holds its automated tests.
-- Brief: "Repository link in project settings"; supports SRS-039 (results API) later.

alter table public.projects
  add column repository_url text
    constraint projects_repository_url_check
    check (repository_url is null or repository_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$');

comment on column public.projects.repository_url is
  'GitHub repository with this project''s automated tests, e.g. https://github.com/owner/repo';

-- Runs with the caller's rights: project.edit permission and archive rules apply.
create function public.update_project_repository(
  p_project uuid,
  p_repository_url text,
  p_reason text default null
)
returns public.projects
language plpgsql
set search_path = ''
as $$
declare
  v_url text := nullif(regexp_replace(trim(coalesce(p_repository_url, '')), '(\.git)?/*$', ''), '');
  v_project public.projects;
begin
  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  update public.projects set repository_url = v_url
   where id = p_project
  returning * into v_project;
  perform set_config('sigil.change_reason', '', true);

  if v_project.id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  return v_project;
end;
$$;

revoke execute on function public.update_project_repository(uuid, text, text) from public, anon;
grant execute on function public.update_project_repository(uuid, text, text) to authenticated;
