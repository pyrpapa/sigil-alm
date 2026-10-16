-- Sigil: the SRS/TC pair and its review workflow (design note, decisions 5, 6, 7).
--
-- Pairing: every SRS item has exactly one test case with the same number
-- (SRS-011 ↔ TC-011), created with it and linked to it ("TC-011 verifies SRS-011").
-- They are separate records (own IDs, versions, signatures) shown on one page.
--
-- Workflow (states are configuration; these flags give them meaning):
--   New → In Progress → Ready for Review      each item on its own
--   Ready for Review   (is_ready)             entering it runs the item's checklist; locked
--   Val Review → QA Review → Approved         the pair moves together, one review action
--                                             records one signature per record
--   Needs Work         (is_rework)            any review stage can send the pair back, with a
--                                             reason; only that stage's reviewer can; editable;
--                                             it can only go back to the first review stage,
--                                             where earlier sign-offs no longer count
-- Checklists (item_readiness):
--   SRS: at least one ER; required fields filled.
--   TC:  required fields filled; every ER of its SRS has a step verifying it; no step
--        names an ER the SRS no longer has; no step was written against old ER wording.
-- Rejections record the reason on the version, and reviewers can pin comments to an
-- ER or step (review_comments).
-- SRS: 019, 021, 022, 023, 027, 029, 034

select set_config('sigil.change_reason', 'SRS and TC paired, with a shared review workflow', true);

---------------------------------------------------------------------------
-- 1. Configuration: pairs of trackers, Ready and Needs Work states.
---------------------------------------------------------------------------
alter table public.trackers
  add column pair_tracker_id uuid references public.trackers (id),
  add column is_pair_primary boolean not null default false;

alter table public.tracker_states
  add column is_ready boolean not null default false,
  add column is_rework boolean not null default false,
  add constraint tracker_states_kind_check check (
    (is_ready::int + is_rework::int + is_final::int + (review_role is not null)::int) <= 1);

-- trackers.pair_* are set by the system only.
revoke update on public.trackers from authenticated;
grant update (name, description, position) on public.trackers to authenticated;

-- Ready locks the item; Needs Work stays editable.
create or replace function public.enforce_tracker_state_kinds()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_ready then
    new.locks_item := true;
  end if;
  if new.is_rework then
    new.locks_item := false;
  end if;
  if (new.is_ready or new.is_rework) and new.is_initial then
    raise exception 'The New state cannot be a Ready or Needs Work state' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger tracker_states_kinds before insert or update on public.tracker_states
  for each row execute function public.enforce_tracker_state_kinds();

-- The first review stage of a tracker: where Needs Work returns to.
create function public.first_review_state(p_tracker uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.tracker_states
  where tracker_id = p_tracker and review_role is not null and not is_retired
  order by position, created_at limit 1;
$$;

-- Out of Needs Work, only to the first review stage.
create or replace function public.enforce_transition_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_from public.tracker_states;
begin
  select * into v_from from public.tracker_states where id = new.from_state_id;
  if v_from.is_final then
    raise exception 'Nothing moves out of a final state; start a new version instead' using errcode = '42501';
  end if;
  if v_from.is_rework and new.to_state_id is distinct from public.first_review_state(new.tracker_id) then
    raise exception 'Items leave % only for the first review stage', v_from.name using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Reshape a tracker's workflow into the pair workflow, keeping existing states
-- (and the items in them) where the names match. "In Review" becomes "QA Review".
create function public.apply_pair_workflow(p_tracker uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_states constant jsonb := $json$
  [
    {"name": "New"},
    {"name": "In Progress"},
    {"name": "Ready for Review", "ready": true},
    {"name": "Val Review", "review_role": "specialist", "review_meaning": "Reviewed"},
    {"name": "QA Review", "review_role": "qa", "review_meaning": "Approved"},
    {"name": "Needs Work", "rework": true},
    {"name": "Approved", "final": true}
  ]
  $json$;
  v_moves constant jsonb := $json$
  [
    ["New", "In Progress", false], ["In Progress", "Ready for Review", false],
    ["Ready for Review", "In Progress", false], ["Ready for Review", "Val Review", false],
    ["Val Review", "QA Review", false], ["Val Review", "Needs Work", true],
    ["QA Review", "Approved", false], ["QA Review", "Needs Work", true],
    ["Needs Work", "Val Review", false]
  ]
  $json$;
  s jsonb;
  m jsonb;
  i int := 0;
begin
  update public.tracker_states set name = 'QA Review'
   where tracker_id = p_tracker and name = 'In Review'
     and not exists (select 1 from public.tracker_states x where x.tracker_id = p_tracker and x.name = 'QA Review');

  delete from public.tracker_transitions where tracker_id = p_tracker;

  for s in select value from jsonb_array_elements(v_states) loop
    if not exists (select 1 from public.tracker_states where tracker_id = p_tracker and name = s ->> 'name') then
      insert into public.tracker_states (tracker_id, name, position) values (p_tracker, s ->> 'name', i);
    end if;
    update public.tracker_states
       set position = i,
           is_retired = false,
           is_ready = coalesce((s ->> 'ready')::boolean, false),
           is_rework = coalesce((s ->> 'rework')::boolean, false),
           review_role = (s ->> 'review_role')::public.project_role,
           review_meaning = s ->> 'review_meaning',
           locks_item = coalesce((s ->> 'ready')::boolean, false) or s ? 'review_role' or coalesce((s ->> 'final')::boolean, false)
     where tracker_id = p_tracker and name = s ->> 'name' and not is_initial and not is_final;
    update public.tracker_states set position = i where tracker_id = p_tracker and name = s ->> 'name';
    i := i + 1;
  end loop;
  -- Other states keep their place after the standard ones.
  update public.tracker_states x set position = i + x.position
   where x.tracker_id = p_tracker
     and x.name not in (select e ->> 'name' from jsonb_array_elements(v_states) e);

  for m in select value from jsonb_array_elements(v_moves) loop
    insert into public.tracker_transitions (tracker_id, from_state_id, to_state_id, requires_reason)
    select p_tracker, f.id, t.id, (m ->> 2)::boolean
    from public.tracker_states f, public.tracker_states t
    where f.tracker_id = p_tracker and f.name = m ->> 0 and t.tracker_id = p_tracker and t.name = m ->> 1;
  end loop;
end;
$$;

revoke execute on function public.apply_pair_workflow(uuid) from public, anon, authenticated;

---------------------------------------------------------------------------
-- 2. Paired items, rejections and review comments.
---------------------------------------------------------------------------
alter table public.items add column pair_item_id uuid unique references public.items (id);
alter table public.item_revisions add column last_rejection jsonb;

create or replace view public.item_heads with (security_invoker = true) as
select i.id, i.project_id, i.tracker_id, i.number, i.item_key, i.folder_id, i.created_by, i.created_at,
       h.id as revision_id, h.revision, h.title, h.values, h.state_id, h.state_entered_at,
       h.content_version, h.content_by, h.assignee, h.version_reason, h.approved_at, h.updated_at,
       i.approved_revision_id, a.revision as approved_revision, h.target_release_id,
       i.pair_item_id, h.last_rejection
from public.items i
join public.item_revisions h on h.id = i.head_revision_id
left join public.item_revisions a on a.id = i.approved_revision_id;

create table public.review_comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  item_id uuid not null,
  revision_id uuid not null,
  anchor text check (char_length(anchor) <= 40),    -- "SRS-011.4", "Step 3", or none
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz,
  foreign key (project_id, item_id) references public.items (project_id, id),
  foreign key (project_id, revision_id) references public.item_revisions (project_id, id)
);

create index review_comments_revision_idx on public.review_comments (revision_id, created_at);

alter table public.review_comments enable row level security;
create policy "Members can view review comments" on public.review_comments for select to authenticated
  using (public.is_project_member(project_id));
revoke insert, update, delete, truncate on public.review_comments from anon, authenticated;

create trigger review_comments_audit after insert or update or delete on public.review_comments
  for each row execute function public.audit_log_change('project_id', 'id');

create function public.review_comments_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Review comments cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - 'resolved_by' - 'resolved_at') is distinct from (to_jsonb(old) - 'resolved_by' - 'resolved_at') then
    raise exception 'Review comments cannot be edited; add another comment instead' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger review_comments_protect before update or delete on public.review_comments
  for each row execute function public.review_comments_rules();

-- The paired TC's "verifies" link is fixed: it points at its SRS and stays.
create function public.enforce_pair_link_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_row public.item_links := coalesce(new, old);
  v_item public.items;
  v_type text;
begin
  select lt.key into v_type from public.link_types lt where lt.id = v_row.link_type_id;
  if v_type <> 'verifies' then
    return coalesce(new, old);
  end if;
  select i.* into v_item from public.items i join public.item_revisions r on r.item_id = i.id
   where r.id = v_row.source_revision_id;
  if v_item.pair_item_id is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' and new.target_item_id <> v_item.pair_item_id then
    raise exception '% verifies only its own requirement', v_item.item_key using errcode = '42501';
  end if;
  if tg_op = 'DELETE' and old.target_item_id = v_item.pair_item_id
     and exists (select 1 from public.item_revisions r where r.id = old.source_revision_id) then
    raise exception 'The link between % and its requirement cannot be removed', v_item.item_key using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger item_links_pair_rules before insert or delete on public.item_links
  for each row execute function public.enforce_pair_link_rules();

---------------------------------------------------------------------------
-- 3. Checklists.
---------------------------------------------------------------------------
create function public.item_readiness(p_item uuid)
returns table (problem text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_rev public.item_revisions;
  v_field public.tracker_fields;
  v_pair public.items;
  v_pair_rev public.item_revisions;
  v_stmt_key text;
  v_steps_key text;
  v_er record;
  v_step record;
  v_ers jsonb;
begin
  select * into v_item from public.items where id = p_item;
  if not found or not public.is_project_member(v_item.project_id) then
    return;
  end if;
  select * into v_rev from public.item_revisions where id = v_item.head_revision_id;

  for v_field in select * from public.tracker_fields f
                 where f.tracker_id = v_item.tracker_id and f.required and not f.is_retired order by f.position loop
    if not (v_rev.values ? v_field.key) then
      problem := '"' || v_field.label || '" is required';
      return next;
    end if;
  end loop;

  select key into v_stmt_key from public.tracker_fields
   where tracker_id = v_item.tracker_id and field_type = 'statements' and not is_retired limit 1;
  if v_stmt_key is not null and jsonb_array_length(coalesce(v_rev.values -> v_stmt_key, '[]'::jsonb)) = 0 then
    problem := 'Add at least one ER';
    return next;
  end if;

  -- A paired test case must cover its requirement's ERs, against their current wording.
  select key into v_steps_key from public.tracker_fields
   where tracker_id = v_item.tracker_id and field_type = 'steps' and not is_retired limit 1;
  if v_steps_key is not null and v_item.pair_item_id is not null then
    select * into v_pair from public.items where id = v_item.pair_item_id;
    select * into v_pair_rev from public.item_revisions where id = v_pair.head_revision_id;
    select f.key into v_stmt_key from public.tracker_fields f
     where f.tracker_id = v_pair.tracker_id and f.field_type = 'statements' and not f.is_retired limit 1;
    v_ers := coalesce(v_pair_rev.values -> v_stmt_key, '[]'::jsonb);

    for v_er in select v_pair.item_key || '.' || (e ->> 'n') as key from jsonb_array_elements(v_ers) e loop
      if not exists (select 1 from jsonb_array_elements(coalesce(v_rev.values -> v_steps_key, '[]'::jsonb)) s
                     where s ->> 'er' = v_er.key) then
        problem := v_er.key || ' has no test step verifying it';
        return next;
      end if;
    end loop;

    for v_step in
      select ord, s ->> 'er' as er, s ->> 'er_text' as er_text,
             (select e ->> 'text' from jsonb_array_elements(v_ers) e
              where v_pair.item_key || '.' || (e ->> 'n') = s ->> 'er') as current_text
      from jsonb_array_elements(coalesce(v_rev.values -> v_steps_key, '[]'::jsonb)) with ordinality as x(s, ord)
      where s ->> 'er' is not null
    loop
      if v_step.current_text is null then
        problem := 'Step ' || v_step.ord || ' verifies ' || v_step.er || ', which the requirement no longer has';
        return next;
      elsif v_step.er_text is distinct from v_step.current_text then
        problem := 'Step ' || v_step.ord || ' was written against old wording of ' || v_step.er;
        return next;
      end if;
    end loop;
  end if;
end;
$$;

---------------------------------------------------------------------------
-- 4. Creating a pair.
---------------------------------------------------------------------------
-- Internal: create the test case that goes with a new SRS item.
create function public.create_pair_partner(p_item uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_rev public.item_revisions;
  v_tracker public.trackers;
  v_number int;
  v_state uuid;
  v_new uuid := gen_random_uuid();
  v_new_rev uuid := gen_random_uuid();
begin
  select * into v_item from public.items where id = p_item;
  select * into v_rev from public.item_revisions where id = v_item.head_revision_id;
  select * into v_tracker from public.trackers
   where id = (select pair_tracker_id from public.trackers where id = v_item.tracker_id);

  -- Same number as the requirement when it is free (SRS-011 ↔ TC-011).
  v_number := case when exists (select 1 from public.items where tracker_id = v_tracker.id and number = v_item.number)
                   then v_tracker.next_number else v_item.number end;
  update public.trackers set next_number = greatest(next_number, v_number + 1) where id = v_tracker.id;
  select id into v_state from public.tracker_states where tracker_id = v_tracker.id and is_initial;

  insert into public.items (id, project_id, tracker_id, number, item_key, folder_id, head_revision_id, created_by, pair_item_id)
  values (v_new, v_item.project_id, v_tracker.id, v_number, v_tracker.type_key || '-' || lpad(v_number::text, 3, '0'),
          null, v_new_rev, v_item.created_by, p_item);
  insert into public.item_revisions
    (id, item_id, project_id, tracker_id, revision, title, values, state_id, content_by, assignee, created_by,
     target_release_id)
  values (v_new_rev, v_new, v_item.project_id, v_tracker.id, 1, v_rev.title, '{}'::jsonb, v_state,
          v_rev.content_by, v_rev.assignee, v_item.created_by, v_rev.target_release_id);
  update public.items set pair_item_id = v_new where id = p_item;

  insert into public.item_links (project_id, link_type_id, source_revision_id, target_item_id, created_by)
  select v_item.project_id, lt.id, v_new_rev, p_item, v_item.created_by
  from public.link_types lt where lt.project_id = v_item.project_id and lt.key = 'verifies';
  return v_new;
end;
$$;

revoke execute on function public.create_pair_partner(uuid) from public, anon, authenticated;

create or replace function public.create_item(
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
  if v_tracker.pair_tracker_id is not null and not v_tracker.is_pair_primary then
    raise exception '% items are created with their requirement: create the SRS item and its % comes with it',
      v_tracker.type_key, v_tracker.type_key using errcode = '42501';
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

  if v_tracker.is_pair_primary then
    perform public.create_pair_partner(v_item);
  end if;

  return public.item_head(v_item);
end;
$$;

---------------------------------------------------------------------------
-- 5. Moving through the workflow, alone or as a pair.
---------------------------------------------------------------------------
create function public.is_joint_state(p_state public.tracker_states)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_state.review_role is not null or p_state.is_rework or p_state.is_final;
$$;

-- Internal: every check for one item's move. Raises on the first problem.
create function public.check_move(
  p_item public.items, p_rev public.item_revisions,
  p_from public.tracker_states, p_to public.tracker_states, p_reason text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_move public.tracker_transitions;
  v_release record;
  v_role public.project_role;
  v_problems text;
begin
  if p_from.is_final then
    raise exception '% version % is %. Start a new version to change it.', p_item.item_key, p_rev.revision, p_from.name
      using errcode = '42501';
  end if;
  select * into v_move from public.tracker_transitions where from_state_id = p_from.id and to_state_id = p_to.id;
  if p_to.id is null or p_to.is_retired or v_move.id is null then
    raise exception 'Moving % from % to that state is not allowed by its workflow', p_item.item_key, p_from.name
      using errcode = '42501';
  end if;
  if (v_move.requires_reason or p_to.is_rework) and coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to move % from % to %', p_item.item_key, p_from.name, p_to.name
      using errcode = '23502';
  end if;

  -- Sending back for rework is the reviewer's decision.
  if p_to.is_rework and p_from.review_role is not null then
    select m.role into v_role from public.project_members m
     where m.project_id = p_item.project_id and m.user_id = (select auth.uid());
    if v_role is distinct from p_from.review_role then
      raise exception 'Only the % reviewer can send % back from %', public.role_label(p_from.review_role),
        p_item.item_key, p_from.name using errcode = '42501';
    end if;
  end if;

  if p_from.review_role is not null and p_to.locks_item and not p_to.is_rework
     and not public.revision_review_done(p_rev.id) then
    raise exception '% must be reviewed (%) by % before it can move to %',
      p_item.item_key, p_from.review_meaning, public.role_label(p_from.review_role), p_to.name using errcode = '42501';
  end if;

  if p_to.is_final and p_rev.target_release_id is not null then
    select * into v_release from public.release_info(p_rev.target_release_id);
    if v_release.is_complete then
      raise exception '% is complete, so version % cannot be approved into it. Choose another target release first.',
        v_release.item_key, p_rev.revision using errcode = '42501';
    end if;
  end if;

  -- Checklists: entering Ready, and entering review from Ready or Needs Work.
  if p_to.is_ready or (p_to.review_role is not null and (p_from.is_ready or p_from.is_rework)) then
    select string_agg(problem, '; ') into v_problems from public.item_readiness(p_item.id);
    if v_problems is not null then
      raise exception '% is not ready for review: %', p_item.item_key, v_problems using errcode = '23514';
    end if;
  end if;
end;
$$;

-- Internal: apply one item's move (state actions, approval, release pin, rejection).
create function public.apply_move(
  p_item public.items, p_rev public.item_revisions,
  p_from public.tracker_states, p_to public.tracker_states, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_values jsonb;
  v_uid uuid := (select auth.uid());
  v_release_key text;
begin
  v_values := public.apply_state_actions(p_rev.values, p_from.id, 'exit');
  v_values := public.apply_state_actions(v_values, p_to.id, 'entry');

  perform set_config('sigil.change_reason',
    concat_ws(': ', 'Moved from ' || p_from.name || ' to ' || p_to.name, nullif(trim(p_reason), '')), true);
  update public.item_revisions
     set state_id = p_to.id,
         state_entered_at = clock_timestamp(),
         values = v_values,
         approved_at = case when p_to.is_final then clock_timestamp() end,
         last_rejection = case
           when p_to.is_rework then jsonb_build_object(
             'reason', trim(p_reason), 'by', v_uid, 'from_state', p_from.name, 'at', clock_timestamp(),
             'by_name', (select full_name from public.profiles where id = v_uid))
           else last_rejection end
   where id = p_rev.id;

  if p_to.is_final then
    update public.items set approved_revision_id = p_rev.id where id = p_item.id;
    if p_rev.target_release_id is not null then
      select item_key into v_release_key from public.items where id = p_rev.target_release_id;
      perform set_config('sigil.change_reason', 'Version ' || p_rev.revision || ' approved for ' || v_release_key, true);
      insert into public.release_pins (project_id, release_id, item_id, revision_id, pinned_by)
      values (p_item.project_id, p_rev.target_release_id, p_item.id, p_rev.id, v_uid)
      on conflict (release_id, item_id)
      do update set revision_id = excluded.revision_id, pinned_by = excluded.pinned_by, pinned_at = now();
    end if;
  end if;
  perform set_config('sigil.change_reason', '', true);
end;
$$;

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
  v_pair public.items;
  v_pair_rev public.item_revisions;
  v_pair_from public.tracker_states;
  v_pair_to public.tracker_states;
  v_joint boolean;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.can_modify_project(v_item.project_id, 'items.transition') then
    raise exception 'You do not have permission to change this item''s state' using errcode = '42501';
  end if;
  select * into v_rev from public.item_revisions where id = v_item.head_revision_id for update;
  select * into v_from from public.tracker_states where id = v_rev.state_id;
  select * into v_to from public.tracker_states where id = p_to_state and tracker_id = v_rev.tracker_id;

  v_joint := v_item.pair_item_id is not null and v_to.id is not null
             and (public.is_joint_state(v_from) or public.is_joint_state(v_to));
  if v_joint then
    select * into v_pair from public.items where id = v_item.pair_item_id for update;
    select * into v_pair_rev from public.item_revisions where id = v_pair.head_revision_id for update;
    select * into v_pair_from from public.tracker_states where id = v_pair_rev.state_id;
    select * into v_pair_to from public.tracker_states where tracker_id = v_pair_rev.tracker_id and name = v_to.name;
    if v_pair_from.name <> v_from.name then
      raise exception '% and % move to % together, and % is %. Both must be % first.',
        v_item.item_key, v_pair.item_key, v_to.name, v_pair.item_key, v_pair_from.name, v_from.name
        using errcode = '42501';
    end if;
  end if;

  perform public.check_move(v_item, v_rev, v_from, v_to, p_reason);
  if v_joint then
    perform public.check_move(v_pair, v_pair_rev, v_pair_from, v_pair_to, p_reason);
  end if;

  perform public.apply_move(v_item, v_rev, v_from, v_to, p_reason);
  if v_joint then
    perform public.apply_move(v_pair, v_pair_rev, v_pair_from, v_pair_to, p_reason);
  end if;

  return public.item_head(p_item);
end;
$$;

-- Send back for rework, with optional comments pinned to an ER or step:
-- [{"item": "TC-011", "anchor": "Step 3", "body": "..."}]  ("item" defaults to this item)
create function public.reject_item(p_item uuid, p_reason text, p_comments jsonb default '[]'::jsonb)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_rework uuid;
  v_c jsonb;
  v_target public.items;
begin
  select * into v_item from public.items where id = p_item;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  select t.to_state_id into v_rework
  from public.item_revisions r
  join public.tracker_transitions t on t.from_state_id = r.state_id
  join public.tracker_states s on s.id = t.to_state_id and s.is_rework
  where r.id = v_item.head_revision_id limit 1;
  if v_rework is null then
    raise exception '% cannot be sent back from its current state', v_item.item_key using errcode = '42501';
  end if;

  perform public.transition_item(p_item, v_rework, p_reason);

  for v_c in select value from jsonb_array_elements(coalesce(p_comments, '[]'::jsonb)) loop
    if coalesce(trim(v_c ->> 'body'), '') = '' then
      continue;
    end if;
    select * into v_target from public.items
     where id = case when upper(coalesce(v_c ->> 'item', '')) in ('', v_item.item_key) then v_item.id else v_item.pair_item_id end;
    if v_c ? 'item' and upper(v_c ->> 'item') not in (v_item.item_key, coalesce(v_target.item_key, '')) then
      raise exception 'Comments can only be on % or its pair', v_item.item_key using errcode = '22023';
    end if;
    insert into public.review_comments (project_id, item_id, revision_id, anchor, body, created_by)
    values (v_target.project_id, v_target.id, v_target.head_revision_id, nullif(trim(v_c ->> 'anchor'), ''),
            trim(v_c ->> 'body'), (select auth.uid()));
  end loop;

  return public.item_head(p_item);
end;
$$;

-- The author marks a comment as dealt with.
create function public.resolve_review_comment(p_comment uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c public.review_comments;
begin
  select * into v_c from public.review_comments where id = p_comment;
  if not found or not public.can_modify_project(v_c.project_id, 'items.edit') then
    raise exception 'You do not have permission to resolve this comment' using errcode = '42501';
  end if;
  update public.review_comments set resolved_by = (select auth.uid()), resolved_at = now()
   where id = p_comment and resolved_at is null;
end;
$$;

---------------------------------------------------------------------------
-- 6. Signing: one action, one signature per record of the pair.
---------------------------------------------------------------------------
create or replace function public.sign_item(p_item uuid, p_password text)
returns public.item_signatures
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_item public.items;
  v_role public.project_role;
  v_name text;
  v_hash text;
  v_sig public.item_signatures;
  v_first public.item_signatures;
  v_target public.items;
  v_rev public.item_revisions;
  v_state public.tracker_states;
  v_targets uuid[];
  v_id uuid;
begin
  select * into v_item from public.items where id = p_item for update;
  if not found or not public.is_project_member(v_item.project_id) then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  select m.role into v_role from public.project_members m
   where m.project_id = v_item.project_id and m.user_id = v_uid;

  v_targets := array[v_item.id];
  if v_item.pair_item_id is not null then
    select s.* into v_state from public.item_revisions r join public.tracker_states s on s.id = r.state_id
     where r.id = v_item.head_revision_id;
    if v_state.review_role is not null then
      v_targets := v_targets || v_item.pair_item_id;
    end if;
  end if;

  -- Check everything before recording anything.
  foreach v_id in array v_targets loop
    select * into v_target from public.items where id = v_id for update;
    select * into v_rev from public.item_revisions where id = v_target.head_revision_id;
    select * into v_state from public.tracker_states where id = v_rev.state_id;
    if v_state.review_role is null then
      raise exception '% is not waiting for a review', v_target.item_key using errcode = '42501';
    end if;
    if v_role is distinct from v_state.review_role
       or not public.can_modify_project(v_item.project_id, 'records.sign') then
      raise exception 'Only a project % can sign the review for %', public.role_label(v_state.review_role), v_state.name
        using errcode = '42501';
    end if;
    if v_rev.content_by = v_uid then
      raise exception 'You made the current version of %, so someone else must review it', v_target.item_key
        using errcode = '42501';
    end if;
    if public.revision_review_done(v_rev.id) then
      raise exception '% has already been reviewed in %', v_target.item_key, v_state.name using errcode = '23505';
    end if;
  end loop;

  select u.encrypted_password into v_hash from auth.users u where u.id = v_uid;
  if v_hash is null or p_password is null or extensions.crypt(p_password, v_hash) <> v_hash then
    raise exception 'Password incorrect. The signature was not recorded.' using errcode = '28P01';
  end if;
  select nullif(trim(p.full_name), '') into v_name from public.profiles p where p.id = v_uid;
  if v_name is null then
    raise exception 'Set your printed name in your profile before signing' using errcode = '23502';
  end if;

  foreach v_id in array v_targets loop
    select * into v_target from public.items where id = v_id;
    select * into v_rev from public.item_revisions where id = v_target.head_revision_id;
    select * into v_state from public.tracker_states where id = v_rev.state_id;
    insert into public.item_signatures
      (item_id, project_id, revision_id, content_version, state_id, state_name, signer, signer_name, signer_role, meaning)
    values (v_target.id, v_target.project_id, v_rev.id, v_rev.content_version, v_state.id, v_state.name, v_uid, v_name,
            v_role, v_state.review_meaning)
    returning * into v_sig;
    if v_first.id is null then
      v_first := v_sig;
    end if;
  end loop;
  return v_first;
end;
$$;

---------------------------------------------------------------------------
-- 7. Starting versions, assigning and targeting act on the whole pair.
---------------------------------------------------------------------------
create function public.start_one_revision(p_item uuid, p_reason text, p_release uuid)
returns void
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
  select * into v_head from public.item_revisions where id = v_item.head_revision_id;
  select * into v_state from public.tracker_states where id = v_head.state_id;
  if not v_state.is_final then
    raise exception '% already has an open version (version %, %). Finish it before starting another.',
      v_item.item_key, v_head.revision, v_state.name using errcode = '42501';
  end if;

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
end;
$$;

create or replace function public.start_revision(p_item uuid, p_reason text, p_release uuid default null)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
begin
  select * into v_item from public.items where id = p_item;
  if not found or not public.can_modify_project(v_item.project_id, 'items.edit') then
    raise exception 'You do not have permission to start a new version of this item' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required to start a new version' using errcode = '23502';
  end if;
  perform public.check_target_release(v_item.project_id, p_release);

  perform public.start_one_revision(p_item, p_reason, p_release);
  if v_item.pair_item_id is not null then
    perform public.start_one_revision(v_item.pair_item_id, p_reason, p_release);
  end if;
  return public.item_head(p_item);
end;
$$;

create or replace function public.assign_item(p_item uuid, p_user uuid, p_reason text default null)
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
  update public.item_revisions r set assignee = p_user
  from public.items i
  where i.id in (p_item, v_item.pair_item_id) and r.id = i.head_revision_id and r.approved_at is null
    and r.assignee is distinct from p_user;
  perform set_config('sigil.change_reason', '', true);
  return public.item_head(p_item);
end;
$$;

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
  update public.item_revisions r set target_release_id = p_release
  from public.items i
  where i.id in (p_item, v_item.pair_item_id) and r.id = i.head_revision_id and r.approved_at is null
    and r.target_release_id is distinct from p_release;
  perform set_config('sigil.change_reason', '', true);
  return public.item_head(p_item);
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'item_readiness(uuid)', 'reject_item(uuid, text, jsonb)', 'resolve_review_comment(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'check_move(public.items, public.item_revisions, public.tracker_states, public.tracker_states, text)',
    'apply_move(public.items, public.item_revisions, public.tracker_states, public.tracker_states, text)',
    'start_one_revision(uuid, text, uuid)', 'first_review_state(uuid)']
  loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end;
$$;

---------------------------------------------------------------------------
-- 8. Set up pairs: new projects, and every existing project now.
---------------------------------------------------------------------------
create function public.setup_srs_tc_pair(p_project uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_srs uuid;
  v_tc uuid;
  v_item record;
begin
  select id into v_srs from public.trackers where project_id = p_project and type_key = 'SRS';
  select id into v_tc from public.trackers where project_id = p_project and type_key = 'TC';
  if v_srs is null or v_tc is null then
    return;
  end if;
  update public.trackers set pair_tracker_id = v_tc, is_pair_primary = true where id = v_srs;
  update public.trackers set pair_tracker_id = v_srs, is_pair_primary = false where id = v_tc;
  perform public.apply_pair_workflow(v_srs);
  perform public.apply_pair_workflow(v_tc);

  -- Existing requirements get their test case.
  for v_item in select id from public.items where tracker_id = v_srs and pair_item_id is null order by number loop
    perform public.create_pair_partner(v_item.id);
  end loop;
end;
$$;

revoke execute on function public.setup_srs_tc_pair(uuid) from public, anon, authenticated;

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
  perform public.setup_srs_tc_pair(v_project.id);

  return v_project;
end;
$$;

select public.setup_srs_tc_pair(id) from public.projects;

select set_config('sigil.change_reason', '', true);
