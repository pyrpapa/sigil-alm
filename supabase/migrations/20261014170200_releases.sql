-- Sigil: releases (design note, decision 3).
-- A release is an item in the project's REL tracker (REL-001 "v1.0"). Items take
-- part in a release at a specific version:
--   * a draft version can target a release; when it is approved, that version is
--     pinned to the release (replacing any earlier version of the item there);
--   * earlier releases keep the version they pinned;
--   * a new release can carry forward another release's pins, so unchanged items
--     are "in v1.1 at version 3" without relinking anything;
--   * once a release is Complete (a final state), its pins can never change: it is
--     the baseline of what was released (SRS-048).
-- SRS: 015, 020, 028, 048

select set_config('sigil.change_reason', 'Releases introduced', true);

---------------------------------------------------------------------------
-- Permission to manage what is in a release.
---------------------------------------------------------------------------
insert into public.permissions (key, description)
values ('releases.manage', 'Pin items to releases, remove them, and carry a release forward');

insert into public.default_role_permissions (role, permission)
values ('admin', 'releases.manage'), ('specialist', 'releases.manage');

insert into public.role_permissions (project_id, role, permission)
select p.id, r.role, 'releases.manage'
from public.projects p cross join (values ('admin'::public.project_role), ('specialist')) r (role)
on conflict do nothing;

---------------------------------------------------------------------------
-- The REL tracker.
---------------------------------------------------------------------------
create function public.seed_release_tracker(p_project uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker uuid;
begin
  if exists (select 1 from public.trackers where project_id = p_project and type_key = 'REL') then
    return;
  end if;

  insert into public.trackers (project_id, type_key, name, description, position)
  values (p_project, 'REL', 'Releases',
          'Releases of the system. Each release records which version of each item it contains.',
          (select coalesce(max(position), -1) + 1 from public.trackers where project_id = p_project))
  returning id into v_tracker;

  insert into public.tracker_fields (tracker_id, key, label, field_type, position) values
    (v_tracker, 'description', 'Description', 'long_text', 0),
    (v_tracker, 'target_date', 'Target date', 'date', 1),
    (v_tracker, 'completed_on', 'Completed on', 'date', 2);

  insert into public.tracker_states (tracker_id, name, position, is_initial, is_final) values
    (v_tracker, 'New', 0, true, false),
    (v_tracker, 'Active', 1, false, false),
    (v_tracker, 'Complete', 2, false, true);

  insert into public.tracker_transitions (tracker_id, from_state_id, to_state_id, requires_reason)
  select v_tracker, f.id, t.id, false
  from public.tracker_states f, public.tracker_states t
  where f.tracker_id = v_tracker and t.tracker_id = v_tracker
    and ((f.name = 'New' and t.name = 'Active') or (f.name = 'Active' and t.name = 'Complete'));

  insert into public.tracker_state_actions (tracker_id, state_id, on_event, field_key, action)
  select v_tracker, id, 'entry', 'completed_on', 'set_today'
  from public.tracker_states where tracker_id = v_tracker and name = 'Complete';
end;
$$;

revoke execute on function public.seed_release_tracker(uuid) from public, anon, authenticated;

create or replace function public.create_project(
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

  perform public.seed_project_trackers(v_project.id);
  perform public.seed_release_tracker(v_project.id);
  perform public.seed_project_link_types(v_project.id);

  return v_project;
end;
$$;

select public.seed_release_tracker(id) from public.projects;

-- Is this item a release, and is it complete?
create function public.release_info(p_release uuid, out is_release boolean, out is_complete boolean, out item_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.type_key = 'REL', s.is_final, i.item_key
  from public.items i
  join public.trackers t on t.id = i.tracker_id
  join public.item_revisions r on r.id = i.head_revision_id
  join public.tracker_states s on s.id = r.state_id
  where i.id = p_release;
$$;

---------------------------------------------------------------------------
-- Drafts target a release; releases pin versions.
---------------------------------------------------------------------------
alter table public.item_revisions add column target_release_id uuid;
alter table public.item_revisions
  add constraint item_revisions_target_release_fk foreign key (project_id, target_release_id)
    references public.items (project_id, id);

create or replace view public.item_heads with (security_invoker = true) as
select i.id, i.project_id, i.tracker_id, i.number, i.item_key, i.folder_id, i.created_by, i.created_at,
       h.id as revision_id, h.revision, h.title, h.values, h.state_id, h.state_entered_at,
       h.content_version, h.content_by, h.assignee, h.version_reason, h.approved_at, h.updated_at,
       i.approved_revision_id, a.revision as approved_revision, h.target_release_id
from public.items i
join public.item_revisions h on h.id = i.head_revision_id
left join public.item_revisions a on a.id = i.approved_revision_id;

create table public.release_pins (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  release_id uuid not null,
  item_id uuid not null,
  revision_id uuid not null,
  pinned_by uuid references public.profiles (id),
  pinned_at timestamptz not null default now(),
  foreign key (project_id, release_id) references public.items (project_id, id),
  foreign key (project_id, item_id) references public.items (project_id, id),
  foreign key (project_id, revision_id) references public.item_revisions (project_id, id),
  unique (release_id, item_id),
  check (release_id <> item_id)
);

create index release_pins_item_idx on public.release_pins (item_id);

-- Rules that hold whoever makes the change.
create function public.enforce_release_pin_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_row public.release_pins := coalesce(new, old);
  v_release record;
  v_rev public.item_revisions;
begin
  select * into v_release from public.release_info(v_row.release_id);
  if not coalesce(v_release.is_release, false) then
    raise exception 'Items can only be pinned to items in the REL tracker' using errcode = '23514';
  end if;
  if v_release.is_complete then
    raise exception '% is complete; what it contains can no longer change', v_release.item_key using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;

  select * into v_rev from public.item_revisions where id = new.revision_id;
  if v_rev.item_id <> new.item_id then
    raise exception 'A pinned version must belong to the pinned item' using errcode = '23514';
  end if;
  if v_rev.approved_at is null then
    raise exception 'Only approved versions can be pinned to a release' using errcode = '23514';
  end if;
  if exists (select 1 from public.items i join public.trackers t on t.id = i.tracker_id
             where i.id = new.item_id and t.type_key = 'REL') then
    raise exception 'A release cannot be pinned to a release' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger release_pins_rules before insert or update or delete on public.release_pins
  for each row execute function public.enforce_release_pin_rules();

create trigger release_pins_audit after insert or update or delete on public.release_pins
  for each row execute function public.audit_log_change('project_id', 'id');

alter table public.release_pins enable row level security;
create policy "Members can view release contents" on public.release_pins for select to authenticated
  using (public.is_project_member(project_id));
revoke insert, update, delete, truncate on public.release_pins from anon, authenticated;

-- Internal: check a release can be targeted.
create function public.check_target_release(p_project uuid, p_release uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_release record;
begin
  if p_release is null then
    return;
  end if;
  select r.* into v_release from public.release_info(p_release) r
   where exists (select 1 from public.items i where i.id = p_release and i.project_id = p_project);
  if not coalesce(v_release.is_release, false) then
    raise exception 'The target release must be an item of this project''s REL tracker' using errcode = '22023';
  end if;
  if v_release.is_complete then
    raise exception '% is complete; choose a release that is still open', v_release.item_key using errcode = '22023';
  end if;
end;
$$;

---------------------------------------------------------------------------
-- Functions: create, start a version, set the target, approve (pin).
---------------------------------------------------------------------------
drop function public.create_item(uuid, text, jsonb, uuid, jsonb);

create function public.create_item(
  p_tracker uuid,
  p_title text,
  p_values jsonb default '{}'::jsonb,
  p_folder uuid default null,
  p_links jsonb default '[]'::jsonb,
  p_release uuid default null
)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_tracker public.trackers;
  v_state uuid;
  v_number int;
  v_values jsonb;
  v_item uuid := gen_random_uuid();
  v_rev public.item_revisions;
  v_link jsonb;
begin
  select * into v_tracker from public.trackers where id = p_tracker;
  if not found or not public.can_modify_project(v_tracker.project_id, 'items.create') then
    raise exception 'You do not have permission to create items in this tracker' using errcode = '42501';
  end if;
  if coalesce(trim(p_title), '') = '' then
    raise exception '"Title" is required' using errcode = '23502';
  end if;
  if p_links is not null and jsonb_typeof(p_links) <> 'array' then
    raise exception 'Links must be a list' using errcode = '22023';
  end if;
  perform public.check_target_release(v_tracker.project_id, p_release);

  v_values := public.validate_item_values(p_tracker, p_values);
  select id into v_state from public.tracker_states where tracker_id = p_tracker and is_initial;
  v_values := public.apply_state_actions(v_values, v_state, 'entry');

  update public.trackers set next_number = next_number + 1
   where id = p_tracker
  returning next_number - 1 into v_number;

  insert into public.items (id, project_id, tracker_id, number, item_key, folder_id, head_revision_id, created_by)
  values (v_item, v_tracker.project_id, p_tracker, v_number,
          v_tracker.type_key || '-' || lpad(v_number::text, 3, '0'), p_folder, gen_random_uuid(), v_uid);

  insert into public.item_revisions
    (id, item_id, project_id, tracker_id, revision, title, values, state_id, content_by, assignee, created_by,
     target_release_id)
  select head_revision_id, v_item, v_tracker.project_id, p_tracker, 1, trim(p_title), v_values, v_state,
         v_uid, v_uid, v_uid, p_release
  from public.items where id = v_item
  returning * into v_rev;

  for v_link in select value from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    perform public.insert_item_link(v_rev, v_link ->> 'type', v_link ->> 'target');
  end loop;

  return public.item_head(v_item);
end;
$$;

drop function public.start_revision(uuid, text);

create function public.start_revision(p_item uuid, p_reason text, p_release uuid default null)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_item public.items;
  v_head public.item_revisions;
  v_state public.tracker_states;
  v_initial uuid;
  v_values jsonb;
  v_new uuid := gen_random_uuid();
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, 'items.edit') then
    raise exception 'You do not have permission to start a new version of this item' using errcode = '42501';
  end if;
  select * into v_head from public.item_revisions where id = v_item.head_revision_id;
  select * into v_state from public.tracker_states where id = v_head.state_id;
  if not v_state.is_final then
    raise exception '% already has an open version (version %, %). Finish it before starting another.',
      v_item.item_key, v_head.revision, v_state.name using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to start a new version' using errcode = '23502';
  end if;
  perform public.check_target_release(v_item.project_id, p_release);

  v_values := v_head.values - array(
    select distinct a.field_key from public.tracker_state_actions a where a.tracker_id = v_head.tracker_id);
  select id into v_initial from public.tracker_states where tracker_id = v_head.tracker_id and is_initial;
  v_values := public.apply_state_actions(v_values, v_initial, 'entry');

  perform set_config('sigil.change_reason', 'New version ' || (v_head.revision + 1) || ': ' || trim(p_reason), true);
  insert into public.item_revisions
    (id, item_id, project_id, tracker_id, revision, title, values, state_id, content_by, assignee,
     version_reason, created_by, target_release_id)
  values (v_new, p_item, v_item.project_id, v_head.tracker_id, v_head.revision + 1, v_head.title, v_values,
          v_initial, v_uid, v_uid, trim(p_reason), v_uid, p_release);

  insert into public.item_links (project_id, link_type_id, source_revision_id, target_item_id, created_by)
  select project_id, link_type_id, v_new, target_item_id, v_uid
  from public.item_links where source_revision_id = v_head.id;

  update public.items set head_revision_id = v_new where id = p_item;
  perform set_config('sigil.change_reason', '', true);

  return public.item_head(p_item);
end;
$$;

-- Which release the open version is for. Metadata, not content: allowed in any open state.
create function public.set_target_release(p_item uuid, p_release uuid, p_reason text default null)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_rev public.item_revisions;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, 'items.edit') then
    raise exception 'You do not have permission to change this item' using errcode = '42501';
  end if;
  select * into v_rev from public.item_revisions where id = v_item.head_revision_id for update;
  if v_rev.approved_at is not null then
    raise exception 'Version % is approved; start a new version to target another release', v_rev.revision
      using errcode = '42501';
  end if;
  perform public.check_target_release(v_item.project_id, p_release);

  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  update public.item_revisions set target_release_id = p_release
   where id = v_rev.id and target_release_id is distinct from p_release;
  perform set_config('sigil.change_reason', '', true);
  return public.item_head(p_item);
end;
$$;

-- Approving a version pins it to its target release.
create or replace function public.transition_item(
  p_item uuid,
  p_to_state uuid,
  p_reason text default null
)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_rev public.item_revisions;
  v_from public.tracker_states;
  v_to public.tracker_states;
  v_move public.tracker_transitions;
  v_values jsonb;
  v_release record;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, 'items.transition') then
    raise exception 'You do not have permission to change this item''s state' using errcode = '42501';
  end if;
  select * into v_rev from public.item_revisions where id = v_item.head_revision_id for update;

  select * into v_from from public.tracker_states where id = v_rev.state_id;
  select * into v_to from public.tracker_states where id = p_to_state and tracker_id = v_rev.tracker_id;
  select * into v_move from public.tracker_transitions
   where from_state_id = v_from.id and to_state_id = p_to_state;

  if v_from.is_final then
    raise exception '% version % is %. Start a new version to change it.', v_item.item_key, v_rev.revision, v_from.name
      using errcode = '42501';
  end if;
  if v_to.id is null or v_to.is_retired or v_move.id is null then
    raise exception 'Moving from % to that state is not allowed by this tracker''s workflow', v_from.name
      using errcode = '42501';
  end if;
  if v_move.requires_reason and coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to move from % to %', v_from.name, v_to.name using errcode = '23502';
  end if;
  if v_from.review_role is not null and v_to.locks_item and not public.revision_review_done(v_rev.id) then
    raise exception '% must be reviewed (%) by % before it can move to %',
      v_item.item_key, v_from.review_meaning, public.role_label(v_from.review_role), v_to.name using errcode = '42501';
  end if;
  if v_to.is_final and v_rev.target_release_id is not null then
    select * into v_release from public.release_info(v_rev.target_release_id);
    if v_release.is_complete then
      raise exception '% is complete, so version % cannot be approved into it. Choose another target release first.',
        v_release.item_key, v_rev.revision using errcode = '42501';
    end if;
  end if;

  v_values := public.apply_state_actions(v_rev.values, v_from.id, 'exit');
  v_values := public.apply_state_actions(v_values, v_to.id, 'entry');

  perform set_config('sigil.change_reason',
    concat_ws(': ', 'Moved from ' || v_from.name || ' to ' || v_to.name, nullif(trim(p_reason), '')), true);
  update public.item_revisions
     set state_id = v_to.id,
         state_entered_at = clock_timestamp(),
         values = v_values,
         approved_at = case when v_to.is_final then clock_timestamp() end
   where id = v_rev.id;
  if v_to.is_final then
    update public.items set approved_revision_id = v_rev.id where id = p_item;
    if v_rev.target_release_id is not null then
      perform set_config('sigil.change_reason',
        'Version ' || v_rev.revision || ' approved for ' || v_release.item_key, true);
      insert into public.release_pins (project_id, release_id, item_id, revision_id, pinned_by)
      values (v_item.project_id, v_rev.target_release_id, p_item, v_rev.id, (select auth.uid()))
      on conflict (release_id, item_id)
      do update set revision_id = excluded.revision_id, pinned_by = excluded.pinned_by, pinned_at = now();
    end if;
  end if;
  perform set_config('sigil.change_reason', '', true);

  return public.item_head(p_item);
end;
$$;

---------------------------------------------------------------------------
-- Managing release contents directly.
---------------------------------------------------------------------------
create function public.check_release_manager(p_release uuid)
returns public.items
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_release public.items;
begin
  select * into v_release from public.items where id = p_release;
  if not found or not public.can_modify_project(v_release.project_id, 'releases.manage') then
    raise exception 'You do not have permission to change what is in this release' using errcode = '42501';
  end if;
  return v_release;
end;
$$;

-- Pin an item's approved version (e.g. items approved before releases existed).
create function public.pin_to_release(p_release uuid, p_item uuid, p_reason text default null)
returns public.release_pins
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_release public.items := public.check_release_manager(p_release);
  v_item public.items;
  v_pin public.release_pins;
begin
  select * into v_item from public.items where id = p_item and project_id = v_release.project_id;
  if not found then
    raise exception 'Item not found in this project' using errcode = 'P0002';
  end if;
  if v_item.approved_revision_id is null then
    raise exception '% has no approved version to put in a release', v_item.item_key using errcode = '22023';
  end if;
  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  insert into public.release_pins (project_id, release_id, item_id, revision_id, pinned_by)
  values (v_release.project_id, p_release, p_item, v_item.approved_revision_id, (select auth.uid()))
  on conflict (release_id, item_id)
  do update set revision_id = excluded.revision_id, pinned_by = excluded.pinned_by, pinned_at = now()
  returning * into v_pin;
  perform set_config('sigil.change_reason', '', true);
  return v_pin;
end;
$$;

create function public.unpin_from_release(p_release uuid, p_item uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_release public.items := public.check_release_manager(p_release);
begin
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to take an item out of a release' using errcode = '23502';
  end if;
  perform set_config('sigil.change_reason', trim(p_reason), true);
  delete from public.release_pins where release_id = p_release and item_id = p_item;
  if not found then
    raise exception 'That item is not in this release' using errcode = 'P0002';
  end if;
  perform set_config('sigil.change_reason', '', true);
end;
$$;

-- Start a release from another: every item pinned there and not yet here is pinned
-- here at the same version. Returns how many items were carried forward.
create function public.carry_forward_release(p_release uuid, p_from uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_release public.items := public.check_release_manager(p_release);
  v_from record;
  v_count int;
begin
  select * into v_from from public.release_info(p_from);
  if not coalesce(v_from.is_release, false)
     or not exists (select 1 from public.items where id = p_from and project_id = v_release.project_id) then
    raise exception 'Carry forward from a release of this project' using errcode = '22023';
  end if;
  if p_from = p_release then
    raise exception 'A release cannot carry itself forward' using errcode = '22023';
  end if;

  perform set_config('sigil.change_reason', 'Carried forward from ' || v_from.item_key, true);
  insert into public.release_pins (project_id, release_id, item_id, revision_id, pinned_by)
  select project_id, p_release, item_id, revision_id, (select auth.uid())
  from public.release_pins src
  where src.release_id = p_from
    and not exists (select 1 from public.release_pins x where x.release_id = p_release and x.item_id = src.item_id);
  get diagnostics v_count = row_count;
  perform set_config('sigil.change_reason', '', true);
  return v_count;
end;
$$;

-- What a release contains: pinned versions, and open drafts aimed at it.
create function public.release_contents(p_release uuid)
returns table (
  kind text,
  item_id uuid,
  item_key text,
  type_key text,
  number int,
  title text,
  revision int,
  state text,
  latest_revision int,
  assignee uuid
)
language sql
stable
set search_path = ''
as $$
  select 'pinned', i.id, i.item_key, t.type_key, i.number, r.title, r.revision, s.name, h.revision, null::uuid
  from public.release_pins p
  join public.items i on i.id = p.item_id
  join public.trackers t on t.id = i.tracker_id
  join public.item_revisions r on r.id = p.revision_id
  join public.tracker_states s on s.id = r.state_id
  join public.item_revisions h on h.id = i.head_revision_id
  where p.release_id = p_release
  union all
  select 'draft', i.id, i.item_key, t.type_key, i.number, h.title, h.revision, s.name, h.revision, h.assignee
  from public.items i
  join public.item_revisions h on h.id = i.head_revision_id
  join public.trackers t on t.id = i.tracker_id
  join public.tracker_states s on s.id = h.state_id
  where h.target_release_id = p_release and h.approved_at is null
  order by 4, 5, 1 desc;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'create_item(uuid, text, jsonb, uuid, jsonb, uuid)', 'start_revision(uuid, text, uuid)',
    'set_target_release(uuid, uuid, text)', 'pin_to_release(uuid, uuid, text)',
    'unpin_from_release(uuid, uuid, text)', 'carry_forward_release(uuid, uuid)', 'release_contents(uuid)',
    'release_info(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['check_target_release(uuid, uuid)', 'check_release_manager(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end;
$$;

---------------------------------------------------------------------------
-- Import: a "release" column names the release each new item is for.
---------------------------------------------------------------------------
create or replace function public.import_items(
  p_tracker uuid,
  p_rows jsonb,
  p_commit boolean default false,
  p_source text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers;
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_errors int := 0;
  v_item public.item_heads;
  v_folder uuid;
  v_folder_name text;
  v_release uuid;
  v_release_key text;
  v_expected text;
  v_key text;
  v_message text;
  i int;
begin
  select * into v_tracker from public.trackers where id = p_tracker;
  if not found or not public.can_modify_project(v_tracker.project_id, 'items.create') then
    raise exception 'You do not have permission to create items in this tracker' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'There are no rows to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2,000 rows at a time' using errcode = '22023';
  end if;

  perform set_config('sigil.change_reason',
    'Imported from ' || coalesce(nullif(trim(p_source), ''), 'a file'), true);

  -- Everything below is undone unless it is a real import with no errors.
  begin
    for i in 0 .. jsonb_array_length(p_rows) - 1 loop
      v_row := p_rows -> i;
      v_key := null;
      v_message := null;
      v_expected := upper(nullif(trim(v_row ->> 'id'), ''));

      begin
        if jsonb_typeof(v_row) <> 'object' then
          raise exception 'Row is not a record' using errcode = '22023';
        end if;
        if coalesce(trim(v_row ->> 'title'), '') = '' then
          raise exception '"Title" is required' using errcode = '23502';
        end if;
        if char_length(trim(v_row ->> 'title')) > 300 then
          raise exception '"Title" is longer than 300 characters' using errcode = '22023';
        end if;

        v_folder := null;
        v_folder_name := nullif(trim(v_row ->> 'folder'), '');
        if v_folder_name is not null then
          select id into v_folder from public.folders where tracker_id = p_tracker and name = v_folder_name;
          if v_folder is null then
            insert into public.folders (tracker_id, name, position)
            values (p_tracker, v_folder_name, (select count(*) from public.folders where tracker_id = p_tracker))
            returning id into v_folder;
          end if;
        end if;

        v_release := null;
        v_release_key := upper(nullif(trim(v_row ->> 'release'), ''));
        if v_release_key is not null then
          select id into v_release from public.items
           where project_id = v_tracker.project_id and item_key = v_release_key;
          if v_release is null then
            raise exception 'No release % in this project', v_release_key using errcode = '22023';
          end if;
        end if;

        v_item := public.create_item(p_tracker, v_row ->> 'title', coalesce(v_row -> 'values', '{}'::jsonb),
                                     v_folder, coalesce(v_row -> 'links', '[]'::jsonb), v_release);
        v_key := v_item.item_key;

        if v_expected is not null and v_expected <> v_item.item_key then
          raise exception 'The file says % but this row would become %. Import into an empty tracker, with rows in ID order.',
            v_expected, v_item.item_key using errcode = '22023';
        end if;
      exception when others then
        v_message := sqlerrm;
        v_errors := v_errors + 1;
        -- Keep numbering in step so the rows after a bad row still show the IDs they would get.
        update public.trackers set next_number = next_number + 1 where id = p_tracker
        returning v_tracker.type_key || '-' || lpad((next_number - 1)::text, 3, '0') into v_key;
      end;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row', i + 1, 'item_key', v_key,
        'errors', case when v_message is null then '[]'::jsonb else jsonb_build_array(v_message) end));
    end loop;

    if not p_commit or v_errors > 0 then
      raise exception 'import not committed' using errcode = 'SGRB1';
    end if;
  exception when sqlstate 'SGRB1' then
    null;   -- rolled back: nothing from this import remains
  end;

  perform set_config('sigil.change_reason', '', true);

  return jsonb_build_object(
    'committed', p_commit and v_errors = 0,
    'error_count', v_errors,
    'rows', v_results);
end;
$$;

select set_config('sigil.change_reason', '', true);
