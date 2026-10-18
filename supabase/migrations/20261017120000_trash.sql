-- Sigil: the trash.
-- Trackers, folders and items can be deleted, but nothing is ever destroyed: a
-- deletion moves them to the project's trash, from where they can be restored with
-- everything they had (versions, signatures, links, history). The trash is never
-- emptied. Deleting and restoring need a reason and are recorded in the audit trail.
--
-- One deletion = one trash entry. Everything it took goes back together on restore:
--   * a tracker (with its pair: SRS and TC go together) and so all of its items;
--   * a folder, with the items in it (and their paired test cases or requirements);
--   * an item, with its pair partner.
-- Things deleted separately earlier keep their own entry.
--
-- An item must have no ties to a release when it is deleted: take it out of every
-- release it is in and clear the release its open draft is for. A release itself
-- can only be deleted when nothing is in it or aimed at it. Releases that are
-- complete can never change, so their items stay.
--
-- Trashed things disappear from every list and page; they cannot be changed until
-- restored.

select set_config('sigil.change_reason', 'Trash introduced', true);

---------------------------------------------------------------------------
-- Permission: Admins by default.
---------------------------------------------------------------------------
insert into public.permissions (key, description)
values ('trash.manage', 'Delete trackers, folders and items to the trash, and restore them');

insert into public.default_role_permissions (role, permission) values ('admin', 'trash.manage');

insert into public.role_permissions (project_id, role, permission)
select p.id, 'admin', 'trash.manage' from public.projects p
on conflict do nothing;

---------------------------------------------------------------------------
-- Trash entries.
---------------------------------------------------------------------------
create table public.trash_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  kind text not null check (kind in ('tracker', 'folder', 'item')),
  label text not null,
  item_count int not null default 0,
  deleted_by uuid not null references public.profiles (id),
  deleted_at timestamptz not null default now(),
  reason text not null check (char_length(trim(reason)) between 1 and 500),
  restored_by uuid references public.profiles (id),
  restored_at timestamptz,
  restore_reason text
);

create index trash_entries_project_idx on public.trash_entries (project_id, deleted_at desc);

create trigger trash_entries_audit after insert or update or delete on public.trash_entries
  for each row execute function public.audit_log_change('project_id', 'id');

alter table public.trash_entries enable row level security;
create policy "Members can view the trash" on public.trash_entries for select to authenticated
  using (public.is_project_member(project_id));
revoke insert, update, delete, truncate on public.trash_entries from anon, authenticated;

alter table public.trackers add column trash_entry_id uuid references public.trash_entries (id);
alter table public.folders add column trash_entry_id uuid references public.trash_entries (id);
alter table public.items add column trash_entry_id uuid references public.trash_entries (id);

create index trackers_trash_idx on public.trackers (trash_entry_id) where trash_entry_id is not null;
create index folders_trash_idx on public.folders (trash_entry_id) where trash_entry_id is not null;
create index items_trash_idx on public.items (trash_entry_id) where trash_entry_id is not null;

-- A deleted folder's name can be used again.
alter table public.folders drop constraint folders_tracker_id_name_key;
create unique index folders_live_name_key on public.folders (tracker_id, name) where trash_entry_id is null;

---------------------------------------------------------------------------
-- Hide trashed things from everyone (the trash page reads them through
-- project_trash below).
---------------------------------------------------------------------------
create function public.tracker_in_trash(p_tracker uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select trash_entry_id is not null from public.trackers where id = p_tracker), false);
$$;

drop policy "Members can view trackers" on public.trackers;
create policy "Members can view trackers" on public.trackers for select to authenticated
  using (public.is_project_member(project_id) and trash_entry_id is null);

drop policy "Members can view folders" on public.folders;
create policy "Members can view folders" on public.folders for select to authenticated
  using (public.is_project_member(public.tracker_project(tracker_id)) and trash_entry_id is null
         and not public.tracker_in_trash(tracker_id));

drop policy "Members can view items" on public.items;
create policy "Members can view items" on public.items for select to authenticated
  using (public.is_project_member(project_id) and trash_entry_id is null and not public.tracker_in_trash(tracker_id));

---------------------------------------------------------------------------
-- Nothing in the trash can change until it is restored.
---------------------------------------------------------------------------
create function public.check_not_trashed(p_item uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  select i.item_key into v_key
  from public.items i join public.trackers t on t.id = i.tracker_id
  where i.id = p_item and (i.trash_entry_id is not null or t.trash_entry_id is not null);
  if v_key is not null then
    raise exception '% is in the trash; restore it before changing it', v_key using errcode = '42501';
  end if;
end;
$$;

create function public.refuse_trashed_item_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  case tg_table_name
    when 'items' then
      if tg_op = 'INSERT' then
        if public.tracker_in_trash(new.tracker_id) then
          raise exception 'That tracker is in the trash; restore it before adding items' using errcode = '42501';
        end if;
      elsif old.trash_entry_id is not distinct from new.trash_entry_id then
        -- any change other than moving to / restoring from the trash
        perform public.check_not_trashed(new.id);
      end if;
      if new.folder_id is not null and (tg_op = 'INSERT' or new.folder_id is distinct from old.folder_id)
         and exists (select 1 from public.folders where id = new.folder_id and trash_entry_id is not null) then
        raise exception 'That folder is in the trash' using errcode = '42501';
      end if;
    when 'item_links' then
      perform public.check_not_trashed((select item_id from public.item_revisions where id = new.source_revision_id));
      perform public.check_not_trashed(new.target_item_id);
    when 'release_pins' then
      perform public.check_not_trashed(new.item_id);
      perform public.check_not_trashed(new.release_id);
    else
      perform public.check_not_trashed(new.item_id);
  end case;
  return new;
end;
$$;

create trigger items_refuse_trashed before insert or update on public.items
  for each row execute function public.refuse_trashed_item_change();
create trigger item_revisions_refuse_trashed before insert or update on public.item_revisions
  for each row execute function public.refuse_trashed_item_change();
create trigger item_signatures_refuse_trashed before insert on public.item_signatures
  for each row execute function public.refuse_trashed_item_change();
create trigger item_links_refuse_trashed before insert on public.item_links
  for each row execute function public.refuse_trashed_item_change();
create trigger review_comments_refuse_trashed before insert or update on public.review_comments
  for each row execute function public.refuse_trashed_item_change();
create trigger release_pins_refuse_trashed before insert or update on public.release_pins
  for each row execute function public.refuse_trashed_item_change();

---------------------------------------------------------------------------
-- Release ties that stop a deletion, as readable sentences ('SRS-011 is in REL-001').
---------------------------------------------------------------------------
create function public.release_ties(p_items uuid[])
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct msg order by msg), '{}') from (
    -- pinned in a release
    select i.item_key || ' is in ' || r.item_key as msg
    from public.release_pins p
    join public.items i on i.id = p.item_id
    join public.items r on r.id = p.release_id
    where p.item_id = any (p_items)
    union all
    -- an open draft aimed at a release
    select i.item_key || ' is planned for ' || r.item_key
    from public.items i
    join public.item_revisions h on h.id = i.head_revision_id
    join public.items r on r.id = h.target_release_id
    where i.id = any (p_items) and h.approved_at is null
    union all
    -- a release that still holds items
    select r.item_key || ' contains ' || i.item_key
    from public.release_pins p
    join public.items r on r.id = p.release_id
    join public.items i on i.id = p.item_id
    where p.release_id = any (p_items) and not (p.item_id = any (p_items))
    union all
    -- a release that open drafts are aimed at
    select i.item_key || ' is planned for ' || r.item_key
    from public.items i
    join public.item_revisions h on h.id = i.head_revision_id
    join public.items r on r.id = h.target_release_id
    where r.id = any (p_items) and h.approved_at is null and not (i.id = any (p_items))
      and i.trash_entry_id is null and not public.tracker_in_trash(i.tracker_id)
  ) t;
$$;

create function public.refuse_release_ties(p_items uuid[])
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ties text[] := public.release_ties(p_items);
begin
  if cardinality(v_ties) > 0 then
    raise exception 'Remove the release links first: %',
      array_to_string(v_ties[1:5], '; ') || case when cardinality(v_ties) > 5
        then format(' (and %s more)', cardinality(v_ties) - 5) else '' end
      using errcode = '23503';
  end if;
end;
$$;

create function public.require_trash_manager(p_project uuid, p_reason text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.can_modify_project(p_project, 'trash.manage') then
    raise exception 'You do not have permission to delete or restore in this project' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '23502';
  end if;
  return (select auth.uid());
end;
$$;

---------------------------------------------------------------------------
-- Delete.
---------------------------------------------------------------------------
create function public.trash_item(p_item uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_pair public.items;
  v_title text;
  v_ids uuid[];
  v_entry uuid;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.is_project_member(v_item.project_id) then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  perform public.require_trash_manager(v_item.project_id, p_reason);
  perform public.check_not_trashed(p_item);
  v_ids := array[v_item.id];
  if v_item.pair_item_id is not null then
    select * into v_pair from public.items where id = v_item.pair_item_id for update;
    v_ids := v_ids || v_pair.id;
  end if;
  perform public.refuse_release_ties(v_ids);

  select title into v_title from public.item_revisions where id = v_item.head_revision_id;
  perform set_config('sigil.change_reason', trim(p_reason), true);
  insert into public.trash_entries (project_id, kind, label, item_count, deleted_by, reason)
  values (v_item.project_id, 'item',
          v_item.item_key || coalesce(' + ' || v_pair.item_key, '') || ' ' || v_title,
          cardinality(v_ids), (select auth.uid()), trim(p_reason))
  returning id into v_entry;

  update public.items set trash_entry_id = v_entry where id = any (v_ids);
  perform set_config('sigil.change_reason', '', true);
  return v_entry;
end;
$$;

create function public.trash_folder(p_folder uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_folder public.folders;
  v_tracker public.trackers;
  v_ids uuid[];
  v_entry uuid;
begin
  select * into v_folder from public.folders where id = p_folder for update;
  select * into v_tracker from public.trackers where id = v_folder.tracker_id;
  if v_folder.id is null or not public.is_project_member(v_tracker.project_id) then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
  perform public.require_trash_manager(v_tracker.project_id, p_reason);
  if v_folder.trash_entry_id is not null or v_tracker.trash_entry_id is not null then
    raise exception 'That folder is already in the trash' using errcode = '42501';
  end if;

  -- the folder's items, with their pair partners
  select coalesce(array_agg(distinct x), '{}') into v_ids from (
    select i.id as x from public.items i where i.folder_id = p_folder and i.trash_entry_id is null
    union all
    select i.pair_item_id from public.items i
    where i.folder_id = p_folder and i.trash_entry_id is null and i.pair_item_id is not null
  ) t;
  perform public.refuse_release_ties(v_ids);

  perform set_config('sigil.change_reason', trim(p_reason), true);
  insert into public.trash_entries (project_id, kind, label, item_count, deleted_by, reason)
  values (v_tracker.project_id, 'folder', format('Folder "%s" in %s', v_folder.name, v_tracker.type_key),
          cardinality(v_ids), (select auth.uid()), trim(p_reason))
  returning id into v_entry;

  update public.folders set trash_entry_id = v_entry where id = p_folder;
  update public.items set trash_entry_id = v_entry where id = any (v_ids);
  perform set_config('sigil.change_reason', '', true);
  return v_entry;
end;
$$;

create function public.trash_tracker(p_tracker uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers;
  v_trackers uuid[];
  v_label text;
  v_ids uuid[];
  v_entry uuid;
begin
  select * into v_tracker from public.trackers where id = p_tracker for update;
  if not found or not public.is_project_member(v_tracker.project_id) then
    raise exception 'Tracker not found' using errcode = 'P0002';
  end if;
  perform public.require_trash_manager(v_tracker.project_id, p_reason);
  if v_tracker.trash_entry_id is not null then
    raise exception 'That tracker is already in the trash' using errcode = '42501';
  end if;

  -- requirements and test cases go together
  v_trackers := array_remove(array[v_tracker.id, v_tracker.pair_tracker_id], null);
  select string_agg(type_key, ' + ' order by is_pair_primary desc, type_key) || ' ' ||
         case when v_tracker.pair_tracker_id is null then v_tracker.name else 'Requirements & Test Cases' end
    into v_label
  from public.trackers where id = any (v_trackers);

  select coalesce(array_agg(id), '{}') into v_ids
  from public.items where tracker_id = any (v_trackers) and trash_entry_id is null;
  perform public.refuse_release_ties(v_ids);

  perform set_config('sigil.change_reason', trim(p_reason), true);
  insert into public.trash_entries (project_id, kind, label, item_count, deleted_by, reason)
  values (v_tracker.project_id, 'tracker', v_label, cardinality(v_ids), (select auth.uid()), trim(p_reason))
  returning id into v_entry;

  update public.trackers set trash_entry_id = v_entry where id = any (v_trackers);
  perform set_config('sigil.change_reason', '', true);
  return v_entry;
end;
$$;

---------------------------------------------------------------------------
-- Restore.
---------------------------------------------------------------------------

-- Why an entry cannot be restored right now (null when it can).
create function public.trash_restore_blocker(p_entry uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_entry public.trash_entries;
  v_msg text;
begin
  select * into v_entry from public.trash_entries where id = p_entry;
  if v_entry.restored_at is not null then
    return 'Already restored';
  end if;
  -- the tracker an item or folder lives in is itself in the trash
  select 'Restore the ' || t.type_key || ' tracker first' into v_msg
  from public.trackers t
  where t.trash_entry_id is not null and t.trash_entry_id <> p_entry
    and (t.id in (select tracker_id from public.items where trash_entry_id = p_entry)
         or t.id in (select tracker_id from public.folders where trash_entry_id = p_entry))
  limit 1;
  if v_msg is not null then
    return v_msg;
  end if;
  -- the folder an item is in is itself in the trash
  select format('Restore folder "%s" first', f.name) into v_msg
  from public.items i join public.folders f on f.id = i.folder_id
  where i.trash_entry_id = p_entry and f.trash_entry_id is not null and f.trash_entry_id <> p_entry
  limit 1;
  if v_msg is not null then
    return v_msg;
  end if;
  -- a live folder now has the same name
  select format('A folder called "%s" exists again in that tracker; rename it first', f.name) into v_msg
  from public.folders f
  where f.trash_entry_id = p_entry
    and exists (select 1 from public.folders o where o.tracker_id = f.tracker_id and o.name = f.name and o.trash_entry_id is null)
  limit 1;
  return v_msg;
end;
$$;

create function public.restore_from_trash(p_entry uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.trash_entries;
  v_blocker text;
begin
  select * into v_entry from public.trash_entries where id = p_entry for update;
  if not found or not public.is_project_member(v_entry.project_id) then
    raise exception 'Not found in the trash' using errcode = 'P0002';
  end if;
  perform public.require_trash_manager(v_entry.project_id, coalesce(nullif(trim(p_reason), ''), 'Restored'));
  v_blocker := public.trash_restore_blocker(p_entry);
  if v_blocker is not null then
    raise exception '%', v_blocker using errcode = '42501';
  end if;

  perform set_config('sigil.change_reason', coalesce(nullif(trim(p_reason), ''), 'Restored from the trash'), true);
  update public.trackers set trash_entry_id = null where trash_entry_id = p_entry;
  update public.folders set trash_entry_id = null where trash_entry_id = p_entry;
  update public.items set trash_entry_id = null where trash_entry_id = p_entry;
  update public.trash_entries
     set restored_by = (select auth.uid()), restored_at = now(), restore_reason = nullif(trim(p_reason), '')
   where id = p_entry;
  perform set_config('sigil.change_reason', '', true);
end;
$$;

-- The project's trash, newest first, with who deleted what and whether it can be
-- restored now.
create function public.project_trash(p_project uuid)
returns table (
  id uuid,
  kind text,
  label text,
  item_count int,
  deleted_by uuid,
  deleted_by_name text,
  deleted_at timestamptz,
  reason text,
  blocked text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_project_member(p_project) then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  return query
    select e.id, e.kind, e.label, e.item_count, e.deleted_by, p.full_name, e.deleted_at, e.reason,
           public.trash_restore_blocker(e.id)
    from public.trash_entries e
    left join public.profiles p on p.id = e.deleted_by
    where e.project_id = p_project and e.restored_at is null
    order by e.deleted_at desc;
end;
$$;

---------------------------------------------------------------------------
-- Release links, for both halves of a pair.
---------------------------------------------------------------------------

-- Setting (or clearing) the release a draft is for also sets it on the pair partner's
-- open draft, so a requirement and its test case are always planned together.
create or replace function public.set_target_release(p_item uuid, p_release uuid, p_reason text default null)
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
  if v_item.pair_item_id is not null then
    update public.item_revisions r set target_release_id = p_release
      from public.items p
     where p.id = v_item.pair_item_id and r.id = p.head_revision_id
       and r.approved_at is null and r.target_release_id is distinct from p_release;
  end if;
  perform set_config('sigil.change_reason', '', true);
  return public.item_head(p_item);
end;
$$;

-- Taking an item out of a release also takes out its pair partner.
create or replace function public.unpin_from_release(p_release uuid, p_item uuid, p_reason text)
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
  delete from public.release_pins
   where release_id = p_release and item_id = (select pair_item_id from public.items where id = p_item);
  perform set_config('sigil.change_reason', '', true);
end;
$$;

---------------------------------------------------------------------------
-- The review dashboard leaves out anything in the trash.
---------------------------------------------------------------------------
create or replace function public.my_review_queue()
returns table (
  kind text,
  project_id uuid,
  project_name text,
  item_id uuid,
  item_key text,
  type_key text,
  title text,
  revision int,
  approved_revision int,
  state text,
  pair_key text,
  release_id uuid,
  release_key text,
  release_title text,
  waiting_since timestamptz,
  rejection jsonb,
  open_comments int
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select (select auth.uid()) as uid),
  heads as (
    select i.id, i.project_id, i.item_key, i.pair_item_id, t.type_key, t.is_pair_primary, t.pair_tracker_id,
           r.id as revision_id, r.title, r.revision, r.state_entered_at, r.content_by, r.assignee, r.target_release_id,
           r.last_rejection, s.name as state, s.review_role, s.is_rework, a.revision as approved_revision
    from public.items i
    join public.trackers t on t.id = i.tracker_id
    join public.item_revisions r on r.id = i.head_revision_id
    join public.tracker_states s on s.id = r.state_id
    left join public.item_revisions a on a.id = i.approved_revision_id
    join public.project_members m on m.project_id = i.project_id and m.user_id = (select uid from me)
    join public.projects p on p.id = i.project_id and p.status <> 'archived'
    where (s.review_role is not null or s.is_rework)
      and i.trash_entry_id is null and t.trash_entry_id is null
      -- a pair is listed once, under its requirement
      and (i.pair_item_id is null or t.is_pair_primary)
  )
  select case when h.is_rework then 'rework' else 'review' end,
         h.project_id, p.name, h.id, h.item_key, h.type_key, h.title, h.revision, h.approved_revision, h.state,
         pr.item_key, rel.id, rel.item_key, relr.title, h.state_entered_at, h.last_rejection,
         (select count(*)::int from public.review_comments c
          where c.revision_id in (h.revision_id, pr.head_revision_id) and c.resolved_at is null)
  from heads h
  join public.projects p on p.id = h.project_id
  join public.project_members m on m.project_id = h.project_id and m.user_id = (select uid from me)
  left join public.items pr on pr.id = h.pair_item_id
  left join public.item_revisions prr on prr.id = pr.head_revision_id
  left join public.items rel on rel.id = h.target_release_id
  left join public.item_revisions relr on relr.id = rel.head_revision_id
  where (
      -- waiting for my signature
      not h.is_rework
      and m.role = h.review_role
      and public.has_project_permission(h.project_id, 'records.sign')
      and h.content_by <> (select uid from me)
      and (prr.content_by is null or prr.content_by <> (select uid from me))
      and not public.revision_review_done(h.revision_id)
    ) or (
      -- sent back to me
      h.is_rework and h.assignee = (select uid from me)
    )
  order by 1 desc, p.name, rel.item_key nulls last, h.state_entered_at;
$$;

---------------------------------------------------------------------------
-- Grants.
---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'trash_item(uuid, text)', 'trash_folder(uuid, text)', 'trash_tracker(uuid, text)',
    'restore_from_trash(uuid, text)', 'project_trash(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'tracker_in_trash(uuid)', 'check_not_trashed(uuid)', 'release_ties(uuid[])', 'refuse_release_ties(uuid[])',
    'require_trash_manager(uuid, text)', 'trash_restore_blocker(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
  end loop;
  -- used by the row-level policies above
  grant execute on function public.tracker_in_trash(uuid) to authenticated;
end;
$$;

select set_config('sigil.change_reason', '', true);
