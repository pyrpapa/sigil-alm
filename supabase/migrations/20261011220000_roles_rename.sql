-- Sigil Phase 2d: project roles become Admin, Specialist, Associate, QA, Viewer.
-- Manager is retired: existing Managers become Specialists. Postgres cannot drop
-- an enum value, so 'manager' stays in the type but can no longer be assigned.
-- Adds the trackers.configure permission (Admin) for tracker configuration.

alter type public.project_role rename value 'val_specialist' to 'specialist';
alter type public.project_role rename value 'val_associate' to 'associate';

select set_config('sigil.change_reason', 'Manager role retired; Managers become Specialists', true);

update public.project_members set role = 'specialist' where role = 'manager';
delete from public.role_permissions where role = 'manager';
delete from public.default_role_permissions where role = 'manager';

select set_config('sigil.change_reason', '', true);

alter table public.project_members
  add constraint project_members_role_not_retired check (role <> 'manager');
alter table public.role_permissions
  add constraint role_permissions_role_not_retired check (role <> 'manager');
alter table public.default_role_permissions
  add constraint default_role_permissions_role_not_retired check (role <> 'manager');

-- New permission: change a tracker's fields, states, transitions and review gates.
insert into public.permissions (key, description)
values ('trackers.configure', 'Configure trackers: fields, workflow states, transitions and review gates');

insert into public.default_role_permissions (role, permission)
values ('admin', 'trackers.configure');

select set_config('sigil.change_reason', 'New permission trackers.configure granted to Admin', true);
insert into public.role_permissions (project_id, role, permission)
select p.id, 'admin', 'trackers.configure' from public.projects p
on conflict do nothing;
select set_config('sigil.change_reason', '', true);
