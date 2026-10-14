-- Sigil Phase 2e: links between tracker items (SRS-019), the basis of traceability.
--   link_types  what may link to what, per project, stored as data (SRS-015):
--                 TC   verifies         SRS
--                 RISK is mitigated by  SRS
--                 SDS  implements       SRS
--   item_links  one row per link, from a source item to a target item.
-- A link belongs to its source item (the downstream record: the test case, the
-- risk, the design). Adding or removing a link is a content change of that item:
-- it needs items.edit, is refused while the item is locked, needs a reason once
-- the item has been reviewed, and creates a new version. Every item version keeps
-- a snapshot of the item's links, so what was approved includes what it linked to.
-- SRS: 015, 019, 020, 025, 028, 029

---------------------------------------------------------------------------
-- Link types
---------------------------------------------------------------------------
create table public.link_types (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z_]{1,40}$'),
  source_type_key text not null,
  target_type_key text not null,
  label text not null check (char_length(label) between 1 and 60),          -- "verifies"
  reverse_label text not null check (char_length(reverse_label) between 1 and 60),  -- "verified by"
  is_retired boolean not null default false,
  created_at timestamptz not null default now(),
  unique (project_id, key),
  unique (project_id, id),
  foreign key (project_id, source_type_key) references public.trackers (project_id, type_key),
  foreign key (project_id, target_type_key) references public.trackers (project_id, type_key)
);

create function public.seed_project_link_types(p_project uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.link_types (project_id, key, source_type_key, target_type_key, label, reverse_label)
  select p_project, d.key, d.src, d.tgt, d.label, d.reverse_label
  from (values
    ('verifies',      'TC',   'SRS', 'verifies',        'verified by'),
    ('mitigated_by',  'RISK', 'SRS', 'is mitigated by', 'mitigates'),
    ('implements',    'SDS',  'SRS', 'implements',      'implemented by')
  ) as d (key, src, tgt, label, reverse_label)
  where exists (select 1 from public.trackers t where t.project_id = p_project and t.type_key = d.src)
    and exists (select 1 from public.trackers t where t.project_id = p_project and t.type_key = d.tgt)
  on conflict (project_id, key) do nothing;
$$;

revoke execute on function public.seed_project_link_types(uuid) from public, anon, authenticated;

-- New projects get their trackers and link types automatically.
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
  perform public.seed_project_link_types(v_project.id);

  return v_project;
end;
$$;

---------------------------------------------------------------------------
-- Links
---------------------------------------------------------------------------
-- Lets links reference (project, item) so both ends must be in the link's project.
alter table public.items add constraint items_project_item_key unique (project_id, id);

create table public.item_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  link_type_id uuid not null,
  source_item_id uuid not null,
  target_item_id uuid not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  foreign key (project_id, link_type_id) references public.link_types (project_id, id),
  foreign key (project_id, source_item_id) references public.items (project_id, id) on delete restrict,
  foreign key (project_id, target_item_id) references public.items (project_id, id) on delete restrict,
  unique (link_type_id, source_item_id, target_item_id),
  check (source_item_id <> target_item_id)
);

create index item_links_source_idx on public.item_links (source_item_id);
create index item_links_target_idx on public.item_links (target_item_id);

-- Both ends must be in the trackers the link type names; links are never edited
-- in place (remove and add instead), whoever makes the change.
create function public.enforce_item_link_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_type public.link_types;
  v_source text;
  v_target text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Links cannot be changed; remove the link and add a new one' using errcode = '42501';
  end if;

  select * into v_type from public.link_types where id = new.link_type_id;
  select t.type_key into v_source from public.items i join public.trackers t on t.id = i.tracker_id
   where i.id = new.source_item_id;
  select t.type_key into v_target from public.items i join public.trackers t on t.id = i.tracker_id
   where i.id = new.target_item_id;

  if v_type.is_retired then
    raise exception 'The link type "%" is retired', v_type.label using errcode = '42501';
  end if;
  if v_source is distinct from v_type.source_type_key or v_target is distinct from v_type.target_type_key then
    raise exception '"%" links go from % items to % items', v_type.label, v_type.source_type_key, v_type.target_type_key
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger item_links_rules before insert or update on public.item_links
  for each row execute function public.enforce_item_link_rules();

-- Item versions keep the item's links as they were at that version (SRS-020).
alter table public.item_versions
  add column links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array');

create function public.snapshot_item_links()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.links := coalesce((
    select jsonb_agg(jsonb_build_object('type', lt.key, 'target', t.item_key) order by lt.key, t.number, t.item_key)
    from public.item_links l
    join public.link_types lt on lt.id = l.link_type_id
    join public.items t on t.id = l.target_item_id
    where l.source_item_id = new.item_id), '[]'::jsonb);
  return new;
end;
$$;

create trigger item_versions_snapshot_links before insert on public.item_versions
  for each row execute function public.snapshot_item_links();

---------------------------------------------------------------------------
-- Internal: add one link from an item, by link type key and target item ID.
-- Checks the type and target with clear messages; callers check permissions.
---------------------------------------------------------------------------
create function public.insert_item_link(p_source public.items, p_link_type text, p_target text)
returns public.item_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type public.link_types;
  v_source_key text;
  v_target public.items;
  v_target_key text;
  v_link public.item_links;
begin
  select * into v_type from public.link_types
   where project_id = p_source.project_id and key = trim(p_link_type) and not is_retired;
  if not found then
    raise exception 'Unknown link type "%"', p_link_type using errcode = '22023';
  end if;

  select type_key into v_source_key from public.trackers where id = p_source.tracker_id;
  if v_source_key <> v_type.source_type_key then
    raise exception '% items cannot have "%" links', v_source_key, v_type.label using errcode = '22023';
  end if;

  select * into v_target from public.items
   where project_id = p_source.project_id and item_key = upper(trim(p_target));
  if not found then
    raise exception 'No item % in this project', upper(trim(coalesce(p_target, ''))) using errcode = '22023';
  end if;

  select type_key into v_target_key from public.trackers where id = v_target.tracker_id;
  if v_target_key <> v_type.target_type_key then
    raise exception '"%" links must point to % items, not %', v_type.label, v_type.target_type_key, v_target.item_key
      using errcode = '22023';
  end if;

  if exists (select 1 from public.item_links l
             where l.link_type_id = v_type.id and l.source_item_id = p_source.id and l.target_item_id = v_target.id) then
    raise exception '% already % %', p_source.item_key, v_type.label, v_target.item_key using errcode = '23505';
  end if;

  insert into public.item_links (project_id, link_type_id, source_item_id, target_item_id, created_by)
  values (p_source.project_id, v_type.id, p_source.id, v_target.id, (select auth.uid()))
  returning * into v_link;
  return v_link;
end;
$$;

revoke execute on function public.insert_item_link(public.items, text, text) from public, anon, authenticated;

---------------------------------------------------------------------------
-- create_item gains p_links: links set when the item is created are part of
-- version 1. [{"type": "verifies", "target": "SRS-001"}, ...]
---------------------------------------------------------------------------
drop function public.create_item(uuid, text, jsonb, uuid);

create function public.create_item(
  p_tracker uuid,
  p_title text,
  p_values jsonb default '{}'::jsonb,
  p_folder uuid default null,
  p_links jsonb default '[]'::jsonb
)
returns public.items
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
  v_item public.items;
  v_link jsonb;
begin
  select * into v_tracker from public.trackers where id = p_tracker;
  if not found or not public.can_modify_project(v_tracker.project_id, 'items.create') then
    raise exception 'You do not have permission to create items in this tracker' using errcode = '42501';
  end if;

  if p_links is not null and jsonb_typeof(p_links) <> 'array' then
    raise exception 'Links must be a list' using errcode = '22023';
  end if;

  v_values := public.validate_item_values(p_tracker, p_values);

  select id into v_state from public.tracker_states where tracker_id = p_tracker and is_initial;
  v_values := public.apply_state_actions(v_values, v_state, 'entry');

  update public.trackers set next_number = next_number + 1
   where id = p_tracker
  returning next_number - 1 into v_number;

  insert into public.items (project_id, tracker_id, number, item_key, title, state_id, folder_id,
                            values, version_by, created_by)
  values (v_tracker.project_id, p_tracker, v_number,
          v_tracker.type_key || '-' || lpad(v_number::text, 3, '0'),
          trim(p_title), v_state, p_folder, v_values, v_uid, v_uid)
  returning * into v_item;

  for v_link in select value from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) loop
    perform public.insert_item_link(v_item, v_link ->> 'type', v_link ->> 'target');
  end loop;

  insert into public.item_versions (item_id, version, title, values, created_by)
  values (v_item.id, 1, v_item.title, v_item.values, v_uid);

  return v_item;
end;
$$;

---------------------------------------------------------------------------
-- Adding and removing links: a content change of the source item.
---------------------------------------------------------------------------
-- Shared checks; returns the locked source item.
create function public.lock_item_for_link_change(p_item uuid, p_reason text)
returns public.items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_state public.tracker_states;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, 'items.edit') then
    raise exception 'You do not have permission to change this item''s links' using errcode = '42501';
  end if;

  select * into v_state from public.tracker_states where id = v_item.state_id;
  if v_state.locks_item then
    raise exception '% is % and its links cannot be changed. Move it back to an editable state first.',
      v_item.item_key, v_state.name using errcode = '42501';
  end if;

  if coalesce(trim(p_reason), '') = ''
     and exists (select 1 from public.item_signatures s where s.item_id = p_item) then
    raise exception 'A reason is required to change the links of an item that has been reviewed before'
      using errcode = '23502';
  end if;
  return v_item;
end;
$$;

-- New version of an item after its links changed (the trigger snapshots the links).
create function public.new_item_version_for_links(p_item uuid)
returns public.items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_item public.items;
begin
  update public.items set version = version + 1, version_by = v_uid
   where id = p_item
  returning * into v_item;

  insert into public.item_versions (item_id, version, title, values, created_by)
  values (v_item.id, v_item.version, v_item.title, v_item.values, v_uid);
  return v_item;
end;
$$;

create function public.add_item_link(
  p_item uuid,
  p_link_type text,
  p_target text,
  p_reason text default null
)
returns public.item_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_link public.item_links;
  v_label text;
begin
  v_item := public.lock_item_for_link_change(p_item, p_reason);

  select label into v_label from public.link_types
   where project_id = v_item.project_id and key = trim(p_link_type);
  perform set_config('sigil.change_reason',
    concat_ws(': ', 'Link added: ' || coalesce(v_label, p_link_type) || ' ' || upper(trim(coalesce(p_target, ''))),
              nullif(trim(p_reason), '')), true);

  v_link := public.insert_item_link(v_item, p_link_type, p_target);
  perform public.new_item_version_for_links(p_item);
  perform set_config('sigil.change_reason', '', true);
  return v_link;
end;
$$;

create function public.remove_item_link(p_link uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.item_links;
  v_label text;
  v_target text;
begin
  select * into v_link from public.item_links where id = p_link;
  if not found or not public.is_project_member(v_link.project_id) then
    raise exception 'Link not found' using errcode = 'P0002';
  end if;

  perform public.lock_item_for_link_change(v_link.source_item_id, p_reason);

  select lt.label, t.item_key into v_label, v_target
  from public.link_types lt, public.items t
  where lt.id = v_link.link_type_id and t.id = v_link.target_item_id;
  perform set_config('sigil.change_reason',
    concat_ws(': ', 'Link removed: ' || v_label || ' ' || v_target, nullif(trim(p_reason), '')), true);

  delete from public.item_links where id = p_link;
  perform public.new_item_version_for_links(v_link.source_item_id);
  perform set_config('sigil.change_reason', '', true);
end;
$$;

-- Every link of an item, both directions, for the item page: label is phrased
-- from this item's side ("verifies SRS-001" on the TC, "verified by TC-004" on the SRS).
create function public.item_link_list(p_item uuid)
returns table (
  link_id uuid,
  direction text,
  link_type text,
  label text,
  other_item_id uuid,
  other_item_key text,
  other_title text,
  other_type_key text,
  other_state text,
  created_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select l.id, 'out', lt.key, lt.label, o.id, o.item_key, o.title, t.type_key, s.name, l.created_at
  from public.item_links l
  join public.link_types lt on lt.id = l.link_type_id
  join public.items o on o.id = l.target_item_id
  join public.trackers t on t.id = o.tracker_id
  join public.tracker_states s on s.id = o.state_id
  where l.source_item_id = p_item
  union all
  select l.id, 'in', lt.key, lt.reverse_label, o.id, o.item_key, o.title, t.type_key, s.name, l.created_at
  from public.item_links l
  join public.link_types lt on lt.id = l.link_type_id
  join public.items o on o.id = l.source_item_id
  join public.trackers t on t.id = o.tracker_id
  join public.tracker_states s on s.id = o.state_id
  where l.target_item_id = p_item
  order by 2 desc, 4, 6;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'create_item(uuid, text, jsonb, uuid, jsonb)', 'add_item_link(uuid, text, text, text)',
    'remove_item_link(uuid, text)', 'item_link_list(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['lock_item_for_link_change(uuid, text)', 'new_item_version_for_links(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end;
$$;

---------------------------------------------------------------------------
-- Row Level Security: members read; links change only through the functions
-- above; link types are configuration seeded by the system (editing screens later).
---------------------------------------------------------------------------
alter table public.link_types enable row level security;
alter table public.item_links enable row level security;

create policy "Members can view link types" on public.link_types for select to authenticated
  using (public.is_project_member(project_id));
create policy "Members can view links" on public.item_links for select to authenticated
  using (public.is_project_member(project_id));

revoke insert, update, delete, truncate on public.link_types, public.item_links from anon, authenticated;

---------------------------------------------------------------------------
-- Audit
---------------------------------------------------------------------------
create trigger link_types_audit after insert or update or delete on public.link_types
  for each row execute function public.audit_log_change('project_id', 'id');
create trigger item_links_audit after insert or update or delete on public.item_links
  for each row execute function public.audit_log_change('project_id', 'id');

-- Existing projects get the default link types now.
select public.seed_project_link_types(id) from public.projects;
