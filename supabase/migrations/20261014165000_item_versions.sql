-- Sigil: versions with their own workflow (design note, decisions 1 and 2).
--
-- Until now an item had one current state, and changing an approved item meant
-- moving it back to In Progress, which took away the approved version that a
-- current release depends on. Now:
--   items           identity only: ID, tracker, folder, and pointers to its
--                   latest version (head) and latest approved version.
--   item_revisions  one row per version (v1, v2, …). Each version has its own
--                   title, values, workflow state, assignee and reason for change.
-- A version that reaches a final state (Approved, Complete, Closed) is approved
-- and can never change again, whoever asks. To change an approved item, a new
-- version is started from it (start_revision, reason required) while the
-- approved version stays approved and usable. Only one version can be open at a time.
-- Edits within an open version are counted (content_version); signatures record
-- the version and the edit they signed.
-- SRS: 014, 016, 020, 021, 022, 025, 026, 027, 028, 029

select set_config('sigil.change_reason', 'Versions with their own workflow introduced', true);

---------------------------------------------------------------------------
-- 1. Final states: where a version ends up approved. No moves out of them.
---------------------------------------------------------------------------
alter table public.tracker_states add column is_final boolean not null default false;

-- The default workflows' "reopen" moves are replaced by starting a new version.
delete from public.tracker_transitions t
using public.tracker_states s
where s.id = t.from_state_id
  and s.name in ('Approved', 'Complete', 'Closed') and s.locks_item and s.review_role is null;

update public.tracker_states set is_final = true
where name in ('Approved', 'Complete', 'Closed') and locks_item and review_role is null;

create or replace function public.enforce_tracker_state_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.tracker_id <> old.tracker_id then
    raise exception 'A state cannot move to another tracker' using errcode = '42501';
  end if;

  if new.is_initial then
    if new.name <> 'New' then
      raise exception 'The initial state is always called New' using errcode = '42501';
    end if;
    if new.review_role is not null or new.locks_item or new.is_retired or new.is_final then
      raise exception 'The New state cannot have a review gate, lock items, be final, or be retired' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.is_initial and not new.is_initial then
    raise exception 'The New state must stay the initial state' using errcode = '42501';
  end if;

  -- A state with a review gate always locks the item while it waits for review.
  if new.review_role is not null then
    new.locks_item := true;
  end if;

  if new.is_final then
    if new.review_role is not null then
      raise exception 'A final state cannot also be a review gate' using errcode = '42501';
    end if;
    new.locks_item := true;
    if tg_op = 'UPDATE' and not old.is_final
       and exists (select 1 from public.tracker_transitions t where t.from_state_id = new.id) then
      raise exception 'Remove the moves out of % before making it final', new.name using errcode = '42501';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.is_final and not new.is_final
     and exists (select 1 from public.item_revisions r where r.state_id = old.id) then
    raise exception 'Approved versions are in %, so it must stay final', old.name using errcode = '42501';
  end if;

  return new;
end;
$$;

create function public.enforce_transition_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.tracker_states s where s.id = new.from_state_id and s.is_final) then
    raise exception 'Nothing moves out of a final state; start a new version instead' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger tracker_transitions_rules before insert or update on public.tracker_transitions
  for each row execute function public.enforce_transition_rules();

---------------------------------------------------------------------------
-- 2. Versions
---------------------------------------------------------------------------
alter table public.items add constraint items_project_item_key unique (project_id, id);

create table public.item_revisions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null,
  project_id uuid not null,
  tracker_id uuid not null,
  revision int not null check (revision >= 1),
  title text not null check (char_length(title) between 1 and 300),
  values jsonb not null default '{}'::jsonb check (jsonb_typeof(values) = 'object'),
  state_id uuid not null,
  state_entered_at timestamptz not null default clock_timestamp(),
  content_version int not null default 1,
  content_by uuid not null references public.profiles (id),
  assignee uuid references public.profiles (id),
  version_reason text check (char_length(version_reason) <= 1000),
  approved_at timestamptz,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, item_id) references public.items (project_id, id) on delete restrict,
  foreign key (tracker_id, state_id) references public.tracker_states (tracker_id, id),
  unique (item_id, revision),
  unique (project_id, id),
  check (revision = 1 or coalesce(trim(version_reason), '') <> '')
);

create index item_revisions_item_idx on public.item_revisions (item_id, revision);
create index item_revisions_assignee_idx on public.item_revisions (assignee) where approved_at is null;

create trigger item_revisions_set_updated_at before update on public.item_revisions
  for each row execute function public.set_updated_at();

alter table public.items
  add column head_revision_id uuid,
  add column approved_revision_id uuid;

-- Every existing item becomes version 1 with its current content and state.
create trigger item_revisions_audit after insert or update or delete on public.item_revisions
  for each row execute function public.audit_log_change('project_id', 'id');

insert into public.item_revisions
  (item_id, project_id, tracker_id, revision, title, values, state_id, state_entered_at,
   content_version, content_by, assignee, approved_at, created_by, created_at, updated_at)
select i.id, i.project_id, i.tracker_id, 1, i.title, i.values, i.state_id, i.state_entered_at,
       i.version, i.version_by, i.created_by, case when s.is_final then i.updated_at end,
       i.created_by, i.created_at, i.updated_at
from public.items i
join public.tracker_states s on s.id = i.state_id;

update public.items i
   set head_revision_id = r.id,
       approved_revision_id = case when r.approved_at is not null then r.id end
  from public.item_revisions r
 where r.item_id = i.id;

alter table public.items
  add constraint items_head_revision_fk foreign key (head_revision_id)
    references public.item_revisions (id) deferrable initially deferred,
  add constraint items_approved_revision_fk foreign key (approved_revision_id)
    references public.item_revisions (id);

-- Content and state now live on versions.
alter table public.items
  drop column title,
  drop column values,
  drop column state_id,
  drop column version,
  drop column version_by,
  drop column state_entered_at;

alter table public.items alter column head_revision_id set not null;

comment on table public.item_versions is
  'Phase 2d per-edit snapshots, kept read-only for history. Replaced by item_revisions.';

-- Approved versions never change and versions are never deleted, whoever asks.
create function public.protect_item_revisions()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Item versions cannot be deleted' using errcode = '42501';
  end if;
  if exists (select 1 from public.tracker_states s where s.id = old.state_id and s.is_final) then
    raise exception 'Version % is approved and cannot change; start a new version instead', old.revision
      using errcode = '42501';
  end if;
  if new.item_id <> old.item_id or new.revision <> old.revision or new.project_id <> old.project_id then
    raise exception 'A version cannot move to another item' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger item_revisions_protect before update or delete on public.item_revisions
  for each row execute function public.protect_item_revisions();

-- Signatures name the version and the edit they signed.
alter table public.item_signatures add column revision_id uuid references public.item_revisions (id);
alter table public.item_signatures rename column item_version to content_version;

alter table public.item_signatures disable trigger item_signatures_permanent;
update public.item_signatures s set revision_id = r.id
  from public.item_revisions r where r.item_id = s.item_id and r.revision = 1;
alter table public.item_signatures enable trigger item_signatures_permanent;

alter table public.item_signatures alter column revision_id set not null;
create index item_signatures_revision_idx on public.item_signatures (revision_id, signed_at);

-- A state cannot be retired while open versions are in it.
create or replace function public.protect_states_in_use()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_retired and not old.is_retired
     and exists (select 1 from public.item_revisions r where r.state_id = new.id) then
    raise exception 'Items are in the state "%"; move them before retiring it', new.name using errcode = '42501';
  end if;
  return new;
end;
$$;

---------------------------------------------------------------------------
-- 3. What the app lists: each item with its latest version.
---------------------------------------------------------------------------
create view public.item_heads with (security_invoker = true) as
select i.id, i.project_id, i.tracker_id, i.number, i.item_key, i.folder_id, i.created_by, i.created_at,
       h.id as revision_id, h.revision, h.title, h.values, h.state_id, h.state_entered_at,
       h.content_version, h.content_by, h.assignee, h.version_reason, h.approved_at, h.updated_at,
       i.approved_revision_id, a.revision as approved_revision
from public.items i
join public.item_revisions h on h.id = i.head_revision_id
left join public.item_revisions a on a.id = i.approved_revision_id;

revoke all on public.item_heads from anon, authenticated;
grant select on public.item_heads to authenticated;

---------------------------------------------------------------------------
-- 4. Item actions. All changes go through these functions.
---------------------------------------------------------------------------
drop function public.create_item(uuid, text, jsonb, uuid);
drop function public.update_item(uuid, text, jsonb, uuid, text);
drop function public.transition_item(uuid, uuid, text);
drop function public.sign_item(uuid, text);
drop function public.item_review_done(uuid);

create function public.item_head(p_item uuid)
returns public.item_heads
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.item_heads where id = p_item;
$$;

-- Has the version's current stay in its state been signed, for its current content?
create function public.revision_review_done(p_revision uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.item_revisions r
    join public.item_signatures s
      on s.revision_id = r.id and s.state_id = r.state_id
     and s.content_version = r.content_version and s.signed_at >= r.state_entered_at
    where r.id = p_revision);
$$;

create function public.item_review_done(p_item uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.revision_review_done(head_revision_id) from public.items where id = p_item;
$$;

create function public.create_item(
  p_tracker uuid,
  p_title text,
  p_values jsonb default '{}'::jsonb,
  p_folder uuid default null
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
  v_rev uuid := gen_random_uuid();
begin
  select * into v_tracker from public.trackers where id = p_tracker;
  if not found or not public.can_modify_project(v_tracker.project_id, 'items.create') then
    raise exception 'You do not have permission to create items in this tracker' using errcode = '42501';
  end if;
  if coalesce(trim(p_title), '') = '' then
    raise exception '"Title" is required' using errcode = '23502';
  end if;

  v_values := public.validate_item_values(p_tracker, p_values);
  select id into v_state from public.tracker_states where tracker_id = p_tracker and is_initial;
  v_values := public.apply_state_actions(v_values, v_state, 'entry');

  update public.trackers set next_number = next_number + 1
   where id = p_tracker
  returning next_number - 1 into v_number;

  insert into public.items (id, project_id, tracker_id, number, item_key, folder_id, head_revision_id, created_by)
  values (v_item, v_tracker.project_id, p_tracker, v_number,
          v_tracker.type_key || '-' || lpad(v_number::text, 3, '0'), p_folder, v_rev, v_uid);

  insert into public.item_revisions
    (id, item_id, project_id, tracker_id, revision, title, values, state_id, content_by, assignee, created_by)
  values (v_rev, v_item, v_tracker.project_id, p_tracker, 1, trim(p_title), v_values, v_state, v_uid, v_uid, v_uid);

  return public.item_head(v_item);
end;
$$;

-- Lock the item's open version for a change; refuses approved and locked versions.
create function public.lock_open_revision(p_item uuid, p_permission text, p_what text)
returns public.item_revisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_rev public.item_revisions;
  v_state public.tracker_states;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, p_permission) then
    raise exception 'You do not have permission to % this item', p_what using errcode = '42501';
  end if;
  select * into v_rev from public.item_revisions where id = v_item.head_revision_id for update;
  select * into v_state from public.tracker_states where id = v_rev.state_id;
  if v_state.is_final then
    raise exception '% version % is %. Start a new version to change it.', v_item.item_key, v_rev.revision, v_state.name
      using errcode = '42501';
  end if;
  if v_state.locks_item then
    raise exception '% is % and cannot be changed. Move it back to an editable state first.', v_item.item_key, v_state.name
      using errcode = '42501';
  end if;
  return v_rev;
end;
$$;

-- Once a version has been reviewed (signed) in any review stage, later edits need a reason.
create function public.require_reason_if_reviewed(p_revision uuid, p_reason text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(trim(p_reason), '') = ''
     and exists (select 1 from public.item_signatures s where s.revision_id = p_revision) then
    raise exception 'A reason is required to change a version that has been reviewed before' using errcode = '23502';
  end if;
end;
$$;

-- Edit the open version. Folder changes are organisation, not content: see move_item.
create function public.update_item(
  p_item uuid,
  p_title text,
  p_values jsonb,
  p_folder uuid default null,
  p_reason text default null
)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_rev public.item_revisions;
  v_values jsonb;
  v_title text := trim(p_title);
begin
  v_rev := public.lock_open_revision(p_item, 'items.edit', 'edit');
  if coalesce(v_title, '') = '' then
    raise exception '"Title" is required' using errcode = '23502';
  end if;
  v_values := public.validate_item_values(v_rev.tracker_id, p_values);

  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  if v_title is distinct from v_rev.title or v_values is distinct from v_rev.values then
    perform public.require_reason_if_reviewed(v_rev.id, p_reason);
    update public.item_revisions
       set title = v_title, values = v_values,
           content_version = content_version + 1, content_by = v_uid
     where id = v_rev.id;
  end if;
  update public.items set folder_id = p_folder where id = p_item and folder_id is distinct from p_folder;
  perform set_config('sigil.change_reason', '', true);

  return public.item_head(p_item);
end;
$$;

-- Put an item in a folder (or none). Allowed in any state: it is not content.
create function public.move_item(p_item uuid, p_folder uuid)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, 'items.edit') then
    raise exception 'You do not have permission to move this item' using errcode = '42501';
  end if;
  update public.items set folder_id = p_folder where id = p_item and folder_id is distinct from p_folder;
  return public.item_head(p_item);
end;
$$;

-- Move the open version to another state, following the tracker's transitions.
create function public.transition_item(
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

  -- Review gate: until signed, the version can only go back to an editable state.
  if v_from.review_role is not null and v_to.locks_item and not public.revision_review_done(v_rev.id) then
    raise exception '% must be reviewed (%) by % before it can move to %',
      v_item.item_key, v_from.review_meaning, public.role_label(v_from.review_role), v_to.name using errcode = '42501';
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
  end if;
  perform set_config('sigil.change_reason', '', true);

  return public.item_head(p_item);
end;
$$;

-- Review the open version: password re-entered, the role the state requires,
-- and not the person who made the current content.
create function public.sign_item(p_item uuid, p_password text)
returns public.item_signatures
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_item public.items;
  v_rev public.item_revisions;
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
  select * into v_rev from public.item_revisions where id = v_item.head_revision_id for update;
  select * into v_state from public.tracker_states where id = v_rev.state_id;
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

  if v_rev.content_by = v_uid then
    raise exception 'You made the current version of %, so someone else must review it', v_item.item_key
      using errcode = '42501';
  end if;

  if public.revision_review_done(v_rev.id) then
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
    (item_id, project_id, revision_id, content_version, state_id, state_name, signer, signer_name, signer_role, meaning)
  values (p_item, v_item.project_id, v_rev.id, v_rev.content_version, v_state.id, v_state.name, v_uid, v_name, v_role,
          v_state.review_meaning)
  returning * into v_sig;
  return v_sig;
end;
$$;

-- Start a new version of an approved item. The approved version stays approved.
-- Fields set by the workflow (e.g. "Approved on") start empty in the new version.
create function public.start_revision(p_item uuid, p_reason text)
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

  v_values := v_head.values - array(
    select distinct a.field_key from public.tracker_state_actions a where a.tracker_id = v_head.tracker_id);
  select id into v_initial from public.tracker_states where tracker_id = v_head.tracker_id and is_initial;
  v_values := public.apply_state_actions(v_values, v_initial, 'entry');

  perform set_config('sigil.change_reason', 'New version ' || (v_head.revision + 1) || ': ' || trim(p_reason), true);
  insert into public.item_revisions
    (id, item_id, project_id, tracker_id, revision, title, values, state_id, content_by, assignee,
     version_reason, created_by)
  values (v_new, p_item, v_item.project_id, v_head.tracker_id, v_head.revision + 1, v_head.title, v_values,
          v_initial, v_uid, v_uid, trim(p_reason), v_uid);
  update public.items set head_revision_id = v_new where id = p_item;
  perform set_config('sigil.change_reason', '', true);

  return public.item_head(p_item);
end;
$$;

-- Give the open version to someone else to work on. They must be able to edit items.
create function public.assign_item(p_item uuid, p_user uuid, p_reason text default null)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_rev public.item_revisions;
  v_state public.tracker_states;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, 'items.edit') then
    raise exception 'You do not have permission to assign this item' using errcode = '42501';
  end if;
  select * into v_rev from public.item_revisions where id = v_item.head_revision_id for update;
  select * into v_state from public.tracker_states where id = v_rev.state_id;
  if v_state.is_final then
    raise exception 'Version % is approved; there is nothing to assign', v_rev.revision using errcode = '42501';
  end if;
  if p_user is not null and not exists (
       select 1 from public.project_members m
       join public.role_permissions rp on rp.project_id = m.project_id and rp.role = m.role
       where m.project_id = v_item.project_id and m.user_id = p_user and rp.permission = 'items.edit') then
    raise exception 'Items can only be assigned to project members who can edit them' using errcode = '22023';
  end if;

  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  update public.item_revisions set assignee = p_user where id = v_rev.id and assignee is distinct from p_user;
  perform set_config('sigil.change_reason', '', true);
  return public.item_head(p_item);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'create_item(uuid, text, jsonb, uuid)', 'update_item(uuid, text, jsonb, uuid, text)',
    'move_item(uuid, uuid)', 'transition_item(uuid, uuid, text)', 'sign_item(uuid, text)',
    'start_revision(uuid, text)', 'assign_item(uuid, uuid, text)',
    'item_review_done(uuid)', 'revision_review_done(uuid)', 'item_head(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['lock_open_revision(uuid, text, text)', 'require_reason_if_reviewed(uuid, text)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end;
$$;

---------------------------------------------------------------------------
-- 5. Row Level Security: members read; writes only through the functions.
---------------------------------------------------------------------------
alter table public.item_revisions enable row level security;
create policy "Members can view item versions" on public.item_revisions for select to authenticated
  using (public.is_project_member(project_id));
revoke insert, update, delete, truncate on public.item_revisions from anon, authenticated;

---------------------------------------------------------------------------
-- 6. Default workflows for new projects: final states, no reopening moves.
---------------------------------------------------------------------------
create or replace function public.seed_project_trackers(p_project uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_defaults constant jsonb := $json$
  [
    {"key": "SRS", "name": "Software Requirements", "flow": "document",
     "description": "What the system must do. Each item is one testable requirement.",
     "fields": [
       {"key": "requirement", "label": "Requirement", "type": "long_text", "required": true},
       {"key": "verification", "label": "Verification method", "type": "select", "required": true,
        "options": ["Test (automated)", "Test (manual)", "Inspection", "Analysis"]},
       {"key": "rationale", "label": "Rationale", "type": "long_text"},
       {"key": "approved_on", "label": "Approved on", "type": "date"}]},
    {"key": "SDS", "name": "Software Design", "flow": "document",
     "description": "How requirements are implemented.",
     "fields": [
       {"key": "design", "label": "Design", "type": "long_text", "required": true},
       {"key": "approved_on", "label": "Approved on", "type": "date"}]},
    {"key": "RISK", "name": "Risk Assessment", "flow": "document",
     "description": "Ways the system could fail, rated by severity and likelihood.",
     "fields": [
       {"key": "failure_mode", "label": "Failure mode", "type": "long_text", "required": true},
       {"key": "effect", "label": "Effect", "type": "long_text"},
       {"key": "severity", "label": "Severity", "type": "select", "required": true, "options": ["High", "Medium", "Low"]},
       {"key": "likelihood", "label": "Likelihood", "type": "select", "required": true, "options": ["High", "Medium", "Low"]},
       {"key": "risk_level", "label": "Risk level", "type": "select", "options": ["High", "Medium", "Low"]},
       {"key": "mitigation", "label": "Mitigation", "type": "long_text"},
       {"key": "approved_on", "label": "Approved on", "type": "date"}]},
    {"key": "TC", "name": "Test Cases", "flow": "document",
     "description": "Steps and expected results that verify requirements.",
     "fields": [
       {"key": "execution_type", "label": "Execution type", "type": "select", "required": true, "options": ["Manual", "Automated"]},
       {"key": "steps", "label": "Steps", "type": "steps", "required": true},
       {"key": "script_path", "label": "Script file", "type": "text",
        "help": "For automated tests: path of the test file in the repository"},
       {"key": "approved_on", "label": "Approved on", "type": "date"}]},
    {"key": "TR", "name": "Test Runs", "flow": "run",
     "description": "Executions of test cases, manual or from CI, with evidence.",
     "fields": [
       {"key": "test_case", "label": "Test case", "type": "text", "required": true},
       {"key": "result", "label": "Result", "type": "select", "required": true, "options": ["Passed", "Failed"]},
       {"key": "notes", "label": "Notes", "type": "long_text"},
       {"key": "executed_by", "label": "Executed by", "type": "user"},
       {"key": "executed_on", "label": "Executed on", "type": "date"}]},
    {"key": "DEV", "name": "Deviations", "flow": "deviation",
     "description": "Failures and unexpected results, investigated and resolved.",
     "fields": [
       {"key": "description", "label": "Description", "type": "long_text", "required": true},
       {"key": "impact", "label": "Impact", "type": "long_text"},
       {"key": "root_cause", "label": "Root cause", "type": "long_text"},
       {"key": "resolution", "label": "Resolution", "type": "long_text"},
       {"key": "closed_on", "label": "Closed on", "type": "date"}]}
  ]
  $json$;
  v_flows constant jsonb := $json$
  {
    "document": {
      "states": [
        {"name": "New", "initial": true},
        {"name": "In Progress"},
        {"name": "In Review", "review_role": "qa", "review_meaning": "Approved"},
        {"name": "Approved", "final": true}],
      "transitions": [
        ["New", "In Progress", false], ["In Progress", "In Review", false],
        ["In Review", "In Progress", true], ["In Review", "Approved", false]],
      "actions": [
        {"state": "Approved", "on": "entry", "field": "approved_on", "action": "set_today"}]},
    "run": {
      "states": [
        {"name": "New", "initial": true},
        {"name": "Executed", "review_role": "qa", "review_meaning": "Reviewed"},
        {"name": "Complete", "final": true}],
      "transitions": [
        ["New", "Executed", false], ["Executed", "New", true], ["Executed", "Complete", false]],
      "actions": [
        {"state": "Executed", "on": "entry", "field": "executed_by", "action": "set_current_user"},
        {"state": "Executed", "on": "entry", "field": "executed_on", "action": "set_today"}]},
    "deviation": {
      "states": [
        {"name": "New", "initial": true},
        {"name": "Investigating"},
        {"name": "Resolution Review", "review_role": "qa", "review_meaning": "Approved"},
        {"name": "Closed", "final": true}],
      "transitions": [
        ["New", "Investigating", false], ["Investigating", "Resolution Review", false],
        ["Resolution Review", "Investigating", true], ["Resolution Review", "Closed", false]],
      "actions": [
        {"state": "Closed", "on": "entry", "field": "closed_on", "action": "set_today"}]}
  }
  $json$;
  t jsonb;
  f jsonb;
  s jsonb;
  tr jsonb;
  a jsonb;
  flow jsonb;
  v_tracker uuid;
  i int;
begin
  for i in 0 .. jsonb_array_length(v_defaults) - 1 loop
    t := v_defaults -> i;
    if exists (select 1 from public.trackers where project_id = p_project and type_key = t ->> 'key') then
      continue;
    end if;

    insert into public.trackers (project_id, type_key, name, description, position)
    values (p_project, t ->> 'key', t ->> 'name', t ->> 'description', i)
    returning id into v_tracker;

    for f in select value from jsonb_array_elements(t -> 'fields') with ordinality as e(value, ord) order by ord loop
      insert into public.tracker_fields (tracker_id, key, label, field_type, options, required, help_text, position)
      values (v_tracker, f ->> 'key', f ->> 'label', (f ->> 'type')::public.field_type,
              coalesce(f -> 'options', '[]'::jsonb), coalesce((f ->> 'required')::boolean, false),
              f ->> 'help',
              (select count(*) from public.tracker_fields x where x.tracker_id = v_tracker));
    end loop;

    flow := v_flows -> (t ->> 'flow');

    for s in select value from jsonb_array_elements(flow -> 'states') with ordinality as e(value, ord) order by ord loop
      insert into public.tracker_states (tracker_id, name, position, is_initial, locks_item, is_final, review_role, review_meaning)
      values (v_tracker, s ->> 'name',
              (select count(*) from public.tracker_states x where x.tracker_id = v_tracker),
              coalesce((s ->> 'initial')::boolean, false),
              coalesce((s ->> 'locks')::boolean, false),
              coalesce((s ->> 'final')::boolean, false),
              (s ->> 'review_role')::public.project_role,
              s ->> 'review_meaning');
    end loop;

    for tr in select value from jsonb_array_elements(flow -> 'transitions') loop
      insert into public.tracker_transitions (tracker_id, from_state_id, to_state_id, requires_reason)
      select v_tracker, fs.id, ts.id, (tr ->> 2)::boolean
      from public.tracker_states fs, public.tracker_states ts
      where fs.tracker_id = v_tracker and fs.name = tr ->> 0
        and ts.tracker_id = v_tracker and ts.name = tr ->> 1;
    end loop;

    for a in select value from jsonb_array_elements(coalesce(flow -> 'actions', '[]'::jsonb)) loop
      insert into public.tracker_state_actions (tracker_id, state_id, on_event, field_key, action)
      select v_tracker, st.id, a ->> 'on', a ->> 'field', a ->> 'action'
      from public.tracker_states st
      where st.tracker_id = v_tracker and st.name = a ->> 'state';
    end loop;
  end loop;
end;
$$;

revoke execute on function public.seed_project_trackers(uuid) from public, anon, authenticated;

select set_config('sigil.change_reason', '', true);
