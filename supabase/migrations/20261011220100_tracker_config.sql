-- Sigil Phase 2d: trackers and their configuration, stored as data.
-- Each project gets six trackers (SRS, SDS, RISK, TC, TR, DEV). Each tracker has:
--   fields       what an item holds (defaults plus custom fields; retired, never deleted)
--   states       the workflow; "New" is always the initial state
--   transitions  which moves between states are allowed (optionally needing a reason)
--   review gates a state can require a signature from a role before the item may leave it;
--                items in a review state cannot be edited
--   actions      on entering or leaving a state, set a field automatically
-- Project Admins (trackers.configure) edit configuration; every change is audited.
-- SRS: 013 (default trackers), 015 (configuration as data), 016 (generated forms),
--      021 (defined transitions), 022 (signature-required transitions)

create type public.field_type as enum
  ('text', 'long_text', 'number', 'date', 'select', 'user', 'steps');

create table public.trackers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete restrict,
  type_key text not null check (type_key ~ '^[A-Z]{2,6}$'),
  name text not null check (char_length(name) between 1 and 100),
  description text,
  position int not null default 0,
  next_number int not null default 1,
  created_at timestamptz not null default now(),
  unique (project_id, type_key),
  unique (project_id, id)
);

create table public.tracker_fields (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.trackers (id) on delete restrict,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label text not null check (char_length(label) between 1 and 100),
  field_type public.field_type not null,
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  required boolean not null default false,
  help_text text,
  position int not null default 0,
  is_retired boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tracker_id, key)
);

create table public.tracker_states (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.trackers (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 60),
  position int not null default 0,
  is_initial boolean not null default false,
  locks_item boolean not null default false,
  review_role public.project_role,
  review_meaning text check (review_meaning in ('Reviewed', 'Approved', 'Executed', 'Verified')),
  is_retired boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tracker_id, id),
  unique (tracker_id, name),
  check ((review_role is null) = (review_meaning is null)),
  check (review_role is null or review_role not in ('viewer', 'manager'))
);

create unique index tracker_states_one_initial on public.tracker_states (tracker_id) where is_initial;

create table public.tracker_transitions (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.trackers (id) on delete restrict,
  from_state_id uuid not null,
  to_state_id uuid not null,
  requires_reason boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (tracker_id, from_state_id) references public.tracker_states (tracker_id, id),
  foreign key (tracker_id, to_state_id) references public.tracker_states (tracker_id, id),
  unique (from_state_id, to_state_id),
  check (from_state_id <> to_state_id)
);

create table public.tracker_state_actions (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null references public.trackers (id) on delete restrict,
  state_id uuid not null,
  on_event text not null check (on_event in ('entry', 'exit')),
  field_key text not null,
  action text not null check (action in ('set_value', 'set_today', 'set_current_user', 'clear')),
  value jsonb,
  created_at timestamptz not null default now(),
  foreign key (tracker_id, state_id) references public.tracker_states (tracker_id, id),
  foreign key (tracker_id, field_key) references public.tracker_fields (tracker_id, key),
  unique (state_id, on_event, field_key),
  check ((action = 'set_value') = (value is not null))
);

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------
create function public.tracker_project(p_tracker uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select project_id from public.trackers where id = p_tracker;
$$;

-- Can the caller change this tracker's configuration?
create function public.can_configure_tracker(p_tracker uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.can_modify_project(public.tracker_project(p_tracker), 'trackers.configure');
$$;

---------------------------------------------------------------------------
-- Configuration rules that the database enforces whoever makes the change.
---------------------------------------------------------------------------
create function public.enforce_tracker_field_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.key <> old.key or new.tracker_id <> old.tracker_id then
      raise exception 'A field''s key cannot change once created' using errcode = '42501';
    end if;
    if new.field_type <> old.field_type then
      raise exception 'A field''s type cannot change once created; retire it and add a new field' using errcode = '42501';
    end if;
  end if;
  if new.field_type = 'select' and jsonb_array_length(new.options) = 0 then
    raise exception 'A dropdown field needs at least one option' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger tracker_fields_rules
  before insert or update on public.tracker_fields
  for each row execute function public.enforce_tracker_field_rules();

create function public.enforce_tracker_state_rules()
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
    if new.review_role is not null or new.locks_item or new.is_retired then
      raise exception 'The New state cannot have a review gate, lock items, or be retired' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.is_initial and not new.is_initial then
    raise exception 'The New state must stay the initial state' using errcode = '42501';
  end if;

  -- A state with a review gate always locks the item while it waits for review.
  if new.review_role is not null then
    new.locks_item := true;
  end if;

  return new;
end;
$$;

create trigger tracker_states_rules
  before insert or update on public.tracker_states
  for each row execute function public.enforce_tracker_state_rules();

create function public.enforce_state_action_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_type public.field_type;
begin
  select f.field_type into v_type
  from public.tracker_fields f
  where f.tracker_id = new.tracker_id and f.key = new.field_key;

  if new.action = 'set_today' and v_type not in ('date', 'text') then
    raise exception 'Today''s date can only be set on a date or text field' using errcode = '23514';
  end if;
  if new.action = 'set_current_user' and v_type not in ('user', 'text') then
    raise exception 'The current user can only be set on a user or text field' using errcode = '23514';
  end if;
  if new.action = 'set_value' and v_type = 'steps' then
    raise exception 'Test steps cannot be set by a state action' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger tracker_state_actions_rules
  before insert or update on public.tracker_state_actions
  for each row execute function public.enforce_state_action_rules();

---------------------------------------------------------------------------
-- Default configuration for a project's trackers.
---------------------------------------------------------------------------
create function public.seed_project_trackers(p_project uuid)
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
  -- Workflows: states (in order) and allowed moves [from, to, requires_reason].
  v_flows constant jsonb := $json$
  {
    "document": {
      "states": [
        {"name": "New", "initial": true},
        {"name": "In Progress"},
        {"name": "In Review", "review_role": "qa", "review_meaning": "Approved"},
        {"name": "Approved", "locks": true}],
      "transitions": [
        ["New", "In Progress", false], ["In Progress", "In Review", false],
        ["In Review", "In Progress", true], ["In Review", "Approved", false],
        ["Approved", "In Progress", true]],
      "actions": [
        {"state": "Approved", "on": "entry", "field": "approved_on", "action": "set_today"},
        {"state": "In Progress", "on": "entry", "field": "approved_on", "action": "clear"}]},
    "run": {
      "states": [
        {"name": "New", "initial": true},
        {"name": "Executed", "review_role": "qa", "review_meaning": "Reviewed"},
        {"name": "Complete", "locks": true}],
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
        {"name": "Closed", "locks": true}],
      "transitions": [
        ["New", "Investigating", false], ["Investigating", "Resolution Review", false],
        ["Resolution Review", "Investigating", true], ["Resolution Review", "Closed", false],
        ["Closed", "Investigating", true]],
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
      insert into public.tracker_states (tracker_id, name, position, is_initial, locks_item, review_role, review_meaning)
      values (v_tracker, s ->> 'name',
              (select count(*) from public.tracker_states x where x.tracker_id = v_tracker),
              coalesce((s ->> 'initial')::boolean, false),
              coalesce((s ->> 'locks')::boolean, false),
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

-- New projects get their trackers automatically.
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

  return v_project;
end;
$$;

-- Existing projects get their trackers now.
select public.seed_project_trackers(id) from public.projects;

---------------------------------------------------------------------------
-- Row Level Security: members read; Admins (trackers.configure) change config.
-- Trackers themselves are created only by the system. Nothing is deleted except
-- transitions and state actions, which are pure configuration (and audited).
---------------------------------------------------------------------------
alter table public.trackers enable row level security;
alter table public.tracker_fields enable row level security;
alter table public.tracker_states enable row level security;
alter table public.tracker_transitions enable row level security;
alter table public.tracker_state_actions enable row level security;

create policy "Members can view trackers" on public.trackers for select to authenticated
  using (public.is_project_member(project_id));
create policy "Configurers can rename trackers" on public.trackers for update to authenticated
  using (public.can_modify_project(project_id, 'trackers.configure'))
  with check (public.can_modify_project(project_id, 'trackers.configure'));

-- next_number is managed by the system only.
revoke update on public.trackers from authenticated;
grant update (name, description, position) on public.trackers to authenticated;

create policy "Members can view fields" on public.tracker_fields for select to authenticated
  using (public.is_project_member(public.tracker_project(tracker_id)));
create policy "Configurers can add fields" on public.tracker_fields for insert to authenticated
  with check (public.can_configure_tracker(tracker_id));
create policy "Configurers can change fields" on public.tracker_fields for update to authenticated
  using (public.can_configure_tracker(tracker_id)) with check (public.can_configure_tracker(tracker_id));

create policy "Members can view states" on public.tracker_states for select to authenticated
  using (public.is_project_member(public.tracker_project(tracker_id)));
create policy "Configurers can add states" on public.tracker_states for insert to authenticated
  with check (public.can_configure_tracker(tracker_id));
create policy "Configurers can change states" on public.tracker_states for update to authenticated
  using (public.can_configure_tracker(tracker_id)) with check (public.can_configure_tracker(tracker_id));

create policy "Members can view transitions" on public.tracker_transitions for select to authenticated
  using (public.is_project_member(public.tracker_project(tracker_id)));
create policy "Configurers can add transitions" on public.tracker_transitions for insert to authenticated
  with check (public.can_configure_tracker(tracker_id));
create policy "Configurers can change transitions" on public.tracker_transitions for update to authenticated
  using (public.can_configure_tracker(tracker_id)) with check (public.can_configure_tracker(tracker_id));
create policy "Configurers can remove transitions" on public.tracker_transitions for delete to authenticated
  using (public.can_configure_tracker(tracker_id));

create policy "Members can view state actions" on public.tracker_state_actions for select to authenticated
  using (public.is_project_member(public.tracker_project(tracker_id)));
create policy "Configurers can add state actions" on public.tracker_state_actions for insert to authenticated
  with check (public.can_configure_tracker(tracker_id));
create policy "Configurers can change state actions" on public.tracker_state_actions for update to authenticated
  using (public.can_configure_tracker(tracker_id)) with check (public.can_configure_tracker(tracker_id));
create policy "Configurers can remove state actions" on public.tracker_state_actions for delete to authenticated
  using (public.can_configure_tracker(tracker_id));

---------------------------------------------------------------------------
-- Audit every configuration change.
---------------------------------------------------------------------------
create trigger trackers_audit after insert or update or delete on public.trackers
  for each row execute function public.audit_log_change('project_id', 'id');

-- Config rows carry tracker_id, not project_id: a small wrapper resolves the project.
create function public.audit_tracker_config_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_old jsonb;
  v_new jsonb;
  v_changed text[];
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;

  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into v_changed
      from jsonb_each(v_new) n where n.value is distinct from v_old -> n.key;
    if v_changed is null then return null; end if;
    select jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k)
      into v_old, v_new from unnest(v_changed) k;
  end if;

  insert into public.audit_log
    (table_name, record_id, project_id, action, changed_by, changed_fields, old_values, new_values, reason)
  values (tg_table_name, v_row ->> 'id', public.tracker_project((v_row ->> 'tracker_id')::uuid),
          tg_op, (select auth.uid()), v_changed, v_old, v_new,
          nullif(current_setting('sigil.change_reason', true), ''));
  return null;
end;
$$;

create trigger tracker_fields_audit after insert or update or delete on public.tracker_fields
  for each row execute function public.audit_tracker_config_change();
create trigger tracker_states_audit after insert or update or delete on public.tracker_states
  for each row execute function public.audit_tracker_config_change();
create trigger tracker_transitions_audit after insert or update or delete on public.tracker_transitions
  for each row execute function public.audit_tracker_config_change();
create trigger tracker_state_actions_audit after insert or update or delete on public.tracker_state_actions
  for each row execute function public.audit_tracker_config_change();
