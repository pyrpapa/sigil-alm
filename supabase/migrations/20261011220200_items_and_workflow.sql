-- Sigil Phase 2d: tracker items, versions, folders, review signatures, and the
-- functions that move items through their workflow.
-- All item changes go through the functions below, which check permissions and
-- workflow rules; direct writes to these tables are refused by Row Level Security.
-- SRS: 014 (unique IDs), 016 (generated forms / required fields), 017 (folders),
--      020 (versioning), 021 (defined transitions), 022 (review gates),
--      023 (re-authentication), 025 (locked items), 026 (signatures bound to
--      versions), 027 (independent review), 029 (reason for change)

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.trackers (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 100),
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (tracker_id, name),
  unique (tracker_id, id)
);

create table public.items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  tracker_id uuid not null,
  number int not null,
  item_key text not null,
  title text not null check (char_length(title) between 1 and 300),
  state_id uuid not null,
  folder_id uuid,
  values jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  version int not null default 1,
  version_by uuid not null references public.profiles (id),
  state_entered_at timestamptz not null default now(),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, tracker_id) references public.trackers (project_id, id),
  foreign key (tracker_id, state_id) references public.tracker_states (tracker_id, id),
  foreign key (tracker_id, folder_id) references public.folders (tracker_id, id),
  unique (tracker_id, number),
  unique (project_id, item_key)
);

create index items_tracker_idx on public.items (tracker_id, number);

create trigger items_set_updated_at before update on public.items
  for each row execute function public.set_updated_at();

-- Every content version of every item, kept forever.
create table public.item_versions (
  item_id uuid not null references public.items (id) on delete restrict,
  version int not null,
  title text not null,
  values jsonb not null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  primary key (item_id, version)
);

-- Review signatures. Insert-only; each is bound to the item version and the
-- state entry it reviewed, so later edits visibly break it.
create table public.item_signatures (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete restrict,
  project_id uuid not null references public.projects (id) on delete restrict,
  item_version int not null,
  state_id uuid not null references public.tracker_states (id),
  state_name text not null,
  signer uuid not null references public.profiles (id),
  signer_name text not null,
  signer_role public.project_role not null,
  meaning text not null,
  signed_at timestamptz not null default clock_timestamp()
);

create index item_signatures_item_idx on public.item_signatures (item_id, signed_at);

create function public.signatures_are_permanent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Signatures and item versions cannot be modified or deleted' using errcode = '42501';
end;
$$;

create trigger item_signatures_permanent before update or delete on public.item_signatures
  for each row execute function public.signatures_are_permanent();
create trigger item_signatures_no_truncate before truncate on public.item_signatures
  for each statement execute function public.signatures_are_permanent();
create trigger item_versions_permanent before update or delete on public.item_versions
  for each row execute function public.signatures_are_permanent();
create trigger item_versions_no_truncate before truncate on public.item_versions
  for each statement execute function public.signatures_are_permanent();

-- A state cannot be retired while items are in it.
create function public.protect_states_in_use()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_retired and not old.is_retired
     and exists (select 1 from public.items i where i.state_id = new.id) then
    raise exception 'Items are in the state "%"; move them before retiring it', new.name using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger tracker_states_in_use before update on public.tracker_states
  for each row execute function public.protect_states_in_use();

-- Display name for a role, for messages.
create function public.role_label(p_role public.project_role)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'admin' then 'Admin' when 'specialist' then 'Specialist' when 'associate' then 'Associate'
    when 'qa' then 'QA' when 'viewer' then 'Viewer' else p_role::text end;
$$;

---------------------------------------------------------------------------
-- Field validation: checks values against the tracker's field configuration.
-- Returns the cleaned values (empty values removed).
---------------------------------------------------------------------------
create function public.validate_item_values(p_tracker uuid, p_values jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_clean jsonb := '{}'::jsonb;
  v_field public.tracker_fields;
  v_key text;
  v_val jsonb;
  v_step jsonb;
begin
  if p_values is null then
    p_values := '{}'::jsonb;
  end if;
  if jsonb_typeof(p_values) <> 'object' then
    raise exception 'Field values must be an object' using errcode = '22023';
  end if;

  for v_key, v_val in select key, value from jsonb_each(p_values) loop
    select * into v_field from public.tracker_fields f
     where f.tracker_id = p_tracker and f.key = v_key;
    if not found then
      raise exception 'Unknown field "%"', v_key using errcode = '22023';
    end if;

    -- Empty values are simply left out.
    if v_val = 'null'::jsonb or v_val = '""'::jsonb or v_val = '[]'::jsonb then
      continue;
    end if;
    if jsonb_typeof(v_val) = 'string' and trim(v_val #>> '{}') = '' then
      continue;
    end if;

    case v_field.field_type
      when 'text', 'long_text' then
        if jsonb_typeof(v_val) <> 'string' or char_length(v_val #>> '{}') > 20000 then
          raise exception '"%" must be text (up to 20,000 characters)', v_field.label using errcode = '22023';
        end if;
      when 'number' then
        if jsonb_typeof(v_val) <> 'number' then
          raise exception '"%" must be a number', v_field.label using errcode = '22023';
        end if;
      when 'date' then
        if jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception '"%" must be a date (YYYY-MM-DD)', v_field.label using errcode = '22023';
        end if;
        perform (v_val #>> '{}')::date;
      when 'select' then
        if not (v_field.options @> jsonb_build_array(v_val)) then
          raise exception '"%" must be one of the listed options', v_field.label using errcode = '22023';
        end if;
      when 'user' then
        if jsonb_typeof(v_val) <> 'string'
           or (v_val #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or not exists (select 1 from public.project_members m
                          where m.project_id = public.tracker_project(p_tracker)
                            and m.user_id = (v_val #>> '{}')::uuid) then
          raise exception '"%" must be a member of this project', v_field.label using errcode = '22023';
        end if;
      when 'steps' then
        if jsonb_typeof(v_val) <> 'array' then
          raise exception '"%" must be a list of steps', v_field.label using errcode = '22023';
        end if;
        for v_step in select value from jsonb_array_elements(v_val) loop
          if jsonb_typeof(v_step) <> 'object'
             or coalesce(trim(v_step ->> 'action'), '') = ''
             or coalesce(trim(v_step ->> 'expected'), '') = '' then
            raise exception 'Every step in "%" needs an action and an expected result', v_field.label using errcode = '22023';
          end if;
        end loop;
    end case;

    v_clean := v_clean || jsonb_build_object(v_key, v_val);
  end loop;

  for v_field in select * from public.tracker_fields f
                 where f.tracker_id = p_tracker and f.required and not f.is_retired loop
    if not (v_clean ? v_field.key) then
      raise exception '"%" is required', v_field.label using errcode = '23502';
    end if;
  end loop;

  return v_clean;
end;
$$;

-- State actions: fields set automatically on entering or leaving a state.
create function public.apply_state_actions(p_values jsonb, p_state uuid, p_event text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  v jsonb := p_values;
  v_uid uuid := (select auth.uid());
begin
  for a in
    select sa.field_key, sa.action, sa.value, f.field_type
    from public.tracker_state_actions sa
    join public.tracker_fields f on f.tracker_id = sa.tracker_id and f.key = sa.field_key
    where sa.state_id = p_state and sa.on_event = p_event and not f.is_retired
  loop
    v := case a.action
      when 'clear' then v - a.field_key
      when 'set_value' then v || jsonb_build_object(a.field_key, a.value)
      when 'set_today' then v || jsonb_build_object(a.field_key, to_char(current_date, 'YYYY-MM-DD'))
      when 'set_current_user' then
        case when v_uid is null then v
             when a.field_type = 'user' then v || jsonb_build_object(a.field_key, v_uid::text)
             else v || jsonb_build_object(a.field_key,
                    (select p.full_name from public.profiles p where p.id = v_uid))
        end
    end;
  end loop;
  return v;
end;
$$;

---------------------------------------------------------------------------
-- Item actions
---------------------------------------------------------------------------
create function public.create_item(
  p_tracker uuid,
  p_title text,
  p_values jsonb default '{}'::jsonb,
  p_folder uuid default null
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
begin
  select * into v_tracker from public.trackers where id = p_tracker;
  if not found or not public.can_modify_project(v_tracker.project_id, 'items.create') then
    raise exception 'You do not have permission to create items in this tracker' using errcode = '42501';
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

  insert into public.item_versions (item_id, version, title, values, created_by)
  values (v_item.id, 1, v_item.title, v_item.values, v_uid);

  return v_item;
end;
$$;

-- Edit an item's content. Not allowed while the item is in a locked or review state.
-- A content change creates a new version, which is what signatures are bound to.
create function public.update_item(
  p_item uuid,
  p_title text,
  p_values jsonb,
  p_folder uuid default null,
  p_reason text default null
)
returns public.items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_item public.items;
  v_state public.tracker_states;
  v_values jsonb;
  v_title text := trim(p_title);
  v_content_changed boolean;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, 'items.edit') then
    raise exception 'You do not have permission to edit this item' using errcode = '42501';
  end if;

  select * into v_state from public.tracker_states where id = v_item.state_id;
  if v_state.locks_item then
    raise exception '% is % and cannot be edited. Move it back to an editable state first.',
      v_item.item_key, v_state.name using errcode = '42501';
  end if;

  v_values := public.validate_item_values(v_item.tracker_id, p_values);
  v_content_changed := v_title is distinct from v_item.title or v_values is distinct from v_item.values;

  if not v_content_changed and p_folder is not distinct from v_item.folder_id then
    return v_item;   -- nothing to do
  end if;

  -- Once an item has been approved, every later content change needs a reason.
  if v_content_changed and coalesce(trim(p_reason), '') = ''
     and exists (select 1 from public.item_signatures s where s.item_id = p_item) then
    raise exception 'A reason is required to change an item that has been reviewed before'
      using errcode = '23502';
  end if;

  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  update public.items
     set title = v_title,
         values = v_values,
         folder_id = p_folder,
         version = case when v_content_changed then version + 1 else version end,
         version_by = case when v_content_changed then v_uid else version_by end
   where id = p_item
  returning * into v_item;
  perform set_config('sigil.change_reason', '', true);

  if v_content_changed then
    insert into public.item_versions (item_id, version, title, values, created_by)
    values (v_item.id, v_item.version, v_item.title, v_item.values, v_uid);
  end if;

  return v_item;
end;
$$;

-- Is the item's current stay in its state reviewed (signed for this version)?
create function public.item_review_done(p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.items i
    join public.item_signatures s
      on s.item_id = i.id and s.state_id = i.state_id
     and s.item_version = i.version and s.signed_at >= i.state_entered_at
    where i.id = p_item);
$$;

-- Move an item to another state, following the tracker's transitions.
create function public.transition_item(
  p_item uuid,
  p_to_state uuid,
  p_reason text default null
)
returns public.items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_from public.tracker_states;
  v_to public.tracker_states;
  v_move public.tracker_transitions;
  v_values jsonb;
  v_reason text;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, 'items.transition') then
    raise exception 'You do not have permission to change this item''s state' using errcode = '42501';
  end if;

  select * into v_from from public.tracker_states where id = v_item.state_id;
  select * into v_to from public.tracker_states where id = p_to_state and tracker_id = v_item.tracker_id;
  select * into v_move from public.tracker_transitions
   where from_state_id = v_from.id and to_state_id = p_to_state;

  if v_to.id is null or v_to.is_retired or v_move.id is null then
    raise exception 'Moving from % to that state is not allowed by this tracker''s workflow', v_from.name
      using errcode = '42501';
  end if;

  if v_move.requires_reason and coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to move from % to %', v_from.name, v_to.name using errcode = '23502';
  end if;

  -- Review gate: until the review is signed, the item can only go back to an
  -- editable state for rework (which restarts the review), never forward to a
  -- locked or review state.
  if v_from.review_role is not null and v_to.locks_item and not public.item_review_done(p_item) then
    raise exception '% must be reviewed (%) by % before it can move to %',
      v_item.item_key, v_from.review_meaning, public.role_label(v_from.review_role), v_to.name using errcode = '42501';
  end if;

  v_values := public.apply_state_actions(v_item.values, v_from.id, 'exit');
  v_values := public.apply_state_actions(v_values, v_to.id, 'entry');

  v_reason := concat_ws(': ', 'Moved from ' || v_from.name || ' to ' || v_to.name, nullif(trim(p_reason), ''));
  perform set_config('sigil.change_reason', v_reason, true);
  update public.items
     set state_id = v_to.id,
         state_entered_at = clock_timestamp(),
         values = v_values
   where id = p_item
  returning * into v_item;
  perform set_config('sigil.change_reason', '', true);

  return v_item;
end;
$$;

-- Review an item in a review state: the signer re-enters their password, must hold
-- the role the state requires, and must not be the author of the current version.
create function public.sign_item(p_item uuid, p_password text)
returns public.item_signatures
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_item public.items;
  v_state public.tracker_states;
  v_role public.project_role;
  v_name text;
  v_hash text;
  v_sig public.item_signatures;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.is_project_member(v_item.project_id) then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  select * into v_state from public.tracker_states where id = v_item.state_id;
  if v_state.review_role is null then
    raise exception '% is not waiting for a review', v_item.item_key using errcode = '42501';
  end if;

  select m.role into v_role from public.project_members m
   where m.project_id = v_item.project_id and m.user_id = v_uid;
  if v_role is distinct from v_state.review_role
     or not public.can_modify_project(v_item.project_id, 'records.sign') then
    raise exception 'Only a project % can sign the review for %', public.role_label(v_state.review_role), v_state.name
      using errcode = '42501';
  end if;

  if v_item.version_by = v_uid then
    raise exception 'You made the current version of %, so someone else must review it', v_item.item_key
      using errcode = '42501';
  end if;

  if public.item_review_done(p_item) then
    raise exception '% has already been reviewed in %', v_item.item_key, v_state.name using errcode = '23505';
  end if;

  select u.encrypted_password into v_hash from auth.users u where u.id = v_uid;
  if v_hash is null or p_password is null or extensions.crypt(p_password, v_hash) <> v_hash then
    raise exception 'Password incorrect. The signature was not recorded.' using errcode = '28P01';
  end if;

  select nullif(trim(p.full_name), '') into v_name from public.profiles p where p.id = v_uid;
  if v_name is null then
    raise exception 'Set your printed name in your profile before signing' using errcode = '23502';
  end if;

  insert into public.item_signatures
    (item_id, project_id, item_version, state_id, state_name, signer, signer_name, signer_role, meaning)
  values (p_item, v_item.project_id, v_item.version, v_state.id, v_state.name, v_uid, v_name, v_role,
          v_state.review_meaning)
  returning * into v_sig;

  return v_sig;
end;
$$;

-- Folders: anyone who can create items can add one.
create function public.create_folder(p_tracker uuid, p_name text)
returns public.folders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_folder public.folders;
begin
  if not public.can_modify_project(public.tracker_project(p_tracker), 'items.create') then
    raise exception 'You do not have permission to add folders here' using errcode = '42501';
  end if;
  insert into public.folders (tracker_id, name, position)
  values (p_tracker, trim(p_name), (select count(*) from public.folders where tracker_id = p_tracker))
  returning * into v_folder;
  return v_folder;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'validate_item_values(uuid, jsonb)', 'apply_state_actions(jsonb, uuid, text)',
    'create_item(uuid, text, jsonb, uuid)', 'update_item(uuid, text, jsonb, uuid, text)',
    'item_review_done(uuid)', 'transition_item(uuid, uuid, text)', 'sign_item(uuid, text)',
    'create_folder(uuid, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end;
$$;

-- apply_state_actions is internal.
revoke execute on function public.apply_state_actions(jsonb, uuid, text) from authenticated;

---------------------------------------------------------------------------
-- Row Level Security: members read; all writes go through the functions above.
---------------------------------------------------------------------------
alter table public.folders enable row level security;
alter table public.items enable row level security;
alter table public.item_versions enable row level security;
alter table public.item_signatures enable row level security;

create policy "Members can view folders" on public.folders for select to authenticated
  using (public.is_project_member(public.tracker_project(tracker_id)));
create policy "Members can view items" on public.items for select to authenticated
  using (public.is_project_member(project_id));
create policy "Members can view item versions" on public.item_versions for select to authenticated
  using (exists (select 1 from public.items i where i.id = item_id and public.is_project_member(i.project_id)));
create policy "Members can view signatures" on public.item_signatures for select to authenticated
  using (public.is_project_member(project_id));

revoke insert, update, delete, truncate on public.folders, public.items, public.item_versions, public.item_signatures
  from anon, authenticated;

---------------------------------------------------------------------------
-- Audit
---------------------------------------------------------------------------
create trigger items_audit after insert or update or delete on public.items
  for each row execute function public.audit_log_change('project_id', 'id');
create trigger item_signatures_audit after insert on public.item_signatures
  for each row execute function public.audit_log_change('project_id', 'id');
create trigger folders_audit after insert or update or delete on public.folders
  for each row execute function public.audit_tracker_config_change();
