-- Sigil: ERs, requirement statements as objects (design note, decision 4).
-- An SRS version holds its requirement as a numbered list of statements (ERs):
--   "ers": [{"n": 1, "text": "..."}, {"n": 2, "text": "..."}]
-- shown as SRS-011.1, SRS-011.2. A number is never reused for a different
-- statement: a new ER always gets a number above every number the item has used.
-- An ER removed in a later version simply isn't in that version (retired).
-- A TC step names the ER it verifies ("er": "SRS-011.3"). The database records the
-- ER's wording at the time the step was written ("er_text"), so if the ER is
-- reworded later the step is flagged as written against old wording.
-- Coverage ("6 of 6 ERs covered") is computed, never typed in.
-- SRS: 015, 016, 019, 034

select set_config('sigil.change_reason', 'Requirements split into numbered statements (ERs)', true);

---------------------------------------------------------------------------
-- Validation: statements fields, and the ER a step verifies.
---------------------------------------------------------------------------
create or replace function public.validate_item_values(p_tracker uuid, p_values jsonb)
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
  v_stmt jsonb;
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
      when 'statements' then
        if jsonb_typeof(v_val) <> 'array' then
          raise exception '"%" must be a list of statements', v_field.label using errcode = '22023';
        end if;
        for v_stmt in select value from jsonb_array_elements(v_val) loop
          if jsonb_typeof(v_stmt) <> 'object' or jsonb_typeof(v_stmt -> 'n') <> 'number'
             or (v_stmt ->> 'n')::numeric <> floor((v_stmt ->> 'n')::numeric) or (v_stmt ->> 'n')::numeric < 1 then
            raise exception 'Every statement in "%" needs a whole number from 1 up', v_field.label using errcode = '22023';
          end if;
          if coalesce(trim(v_stmt ->> 'text'), '') = '' or char_length(v_stmt ->> 'text') > 4000 then
            raise exception 'Statement % in "%" needs text (up to 4,000 characters)', v_stmt ->> 'n', v_field.label
              using errcode = '22023';
          end if;
        end loop;
        if (select count(distinct (e ->> 'n')::int) from jsonb_array_elements(v_val) e) <> jsonb_array_length(v_val) then
          raise exception 'Statement numbers in "%" must be unique', v_field.label using errcode = '22023';
        end if;
        v_val := (select jsonb_agg(jsonb_build_object('n', (e ->> 'n')::int, 'text', trim(e ->> 'text')) order by ord)
                  from jsonb_array_elements(v_val) with ordinality as x(e, ord));
      when 'steps' then
        if jsonb_typeof(v_val) <> 'array' then
          raise exception '"%" must be a list of steps', v_field.label using errcode = '22023';
        end if;
        for v_step in select value from jsonb_array_elements(v_val) loop
          if jsonb_typeof(v_step) <> 'object' or coalesce(trim(v_step ->> 'action'), '') = '' then
            raise exception 'Every step in "%" needs an action', v_field.label using errcode = '22023';
          end if;
          if v_step ? 'er' and v_step -> 'er' <> 'null'::jsonb
             and coalesce(v_step ->> 'er', '') !~ '^[A-Z]{2,6}-\d{3,}\.\d+$' then
            raise exception 'A step''s ER must look like SRS-011.3' using errcode = '22023';
          end if;
          case coalesce(v_step ->> 'kind', 'verify')
            when 'verify' then
              if coalesce(trim(v_step ->> 'expected'), '') = '' then
                raise exception 'Every verification step in "%" needs an expected result', v_field.label using errcode = '22023';
              end if;
            when 'document' then
              if coalesce(trim(v_step ->> 'expected'), '') <> '' then
                raise exception 'A documentation step in "%" records values instead of having an expected result', v_field.label using errcode = '22023';
              end if;
              if jsonb_typeof(v_step -> 'fields') is distinct from 'array'
                 or jsonb_array_length(v_step -> 'fields') = 0
                 or jsonb_array_length(v_step -> 'fields') > 20 then
                raise exception 'A documentation step in "%" needs between 1 and 20 values to record', v_field.label using errcode = '22023';
              end if;
              if exists (select 1 from jsonb_array_elements(v_step -> 'fields') f(v)
                         where jsonb_typeof(f.v) <> 'string' or trim(f.v #>> '{}') = '' or char_length(f.v #>> '{}') > 200)
                 or (select count(distinct lower(trim(f.v #>> '{}'))) from jsonb_array_elements(v_step -> 'fields') f(v))
                    <> jsonb_array_length(v_step -> 'fields') then
                raise exception 'Values to record in "%" need unique names (up to 200 characters)', v_field.label using errcode = '22023';
              end if;
            else
              raise exception 'Unknown step kind "%" in "%"', v_step ->> 'kind', v_field.label using errcode = '22023';
          end case;
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

---------------------------------------------------------------------------
-- The current wording of an ER ("SRS-011.3"), from the SRS item's latest version.
---------------------------------------------------------------------------
create function public.er_text(p_project uuid, p_er text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s ->> 'text'
  from public.items i
  join public.item_revisions r on r.id = i.head_revision_id
  join public.tracker_fields f on f.tracker_id = i.tracker_id and f.field_type = 'statements' and not f.is_retired
  cross join lateral jsonb_array_elements(coalesce(r.values -> f.key, '[]'::jsonb)) s
  where i.project_id = p_project
    and i.item_key = split_part(p_er, '.', 1)
    and (s ->> 'n')::int = split_part(p_er, '.', 2)::int
  limit 1;
$$;

-- Numbers are never reused, and steps record the ER wording they were written against.
create function public.enforce_er_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_field record;
  v_max int;
  v_new_n int;
  v_steps jsonb;
  v_old_steps jsonb;
  v_out jsonb;
  v_step jsonb;
  v_text text;
  v_keep jsonb;
  v_project uuid := new.project_id;
begin
  if tg_op = 'UPDATE' and new.values is not distinct from old.values then
    return new;
  end if;

  for v_field in select f.key, f.field_type, f.label from public.tracker_fields f
                 where f.tracker_id = new.tracker_id and f.field_type in ('statements', 'steps') loop
    if v_field.field_type = 'statements' then
      select max((s ->> 'n')::int) into v_max
      from public.item_revisions r
      cross join lateral jsonb_array_elements(coalesce(r.values -> v_field.key, '[]'::jsonb)) s
      where r.item_id = new.item_id and r.id <> new.id;

      for v_new_n in
        select (s ->> 'n')::int from jsonb_array_elements(coalesce(new.values -> v_field.key, '[]'::jsonb)) s
        where not exists (
          select 1 from public.item_revisions r
          cross join lateral jsonb_array_elements(coalesce(r.values -> v_field.key, '[]'::jsonb)) o
          where r.item_id = new.item_id and r.id <> new.id and (o ->> 'n')::int = (s ->> 'n')::int)
      loop
        if v_new_n <= coalesce(v_max, 0) then
          raise exception 'ER number % was used by an earlier version of this item; new ERs are numbered from %',
            v_new_n, coalesce(v_max, 0) + 1 using errcode = '23514';
        end if;
      end loop;

    else
      v_steps := new.values -> v_field.key;
      if v_steps is null or jsonb_typeof(v_steps) <> 'array' then
        continue;
      end if;
      -- A new version copies its steps as they were; the wording they were written
      -- against stays until someone changes or re-confirms the step.
      if tg_op = 'INSERT' and new.revision > 1 then
        continue;
      end if;
      v_old_steps := case when tg_op = 'UPDATE' then coalesce(old.values -> v_field.key, '[]'::jsonb) else '[]'::jsonb end;
      v_out := '[]'::jsonb;
      for v_step in select value from jsonb_array_elements(v_steps) loop
        if coalesce(v_step ->> 'er', '') = '' then
          v_out := v_out || jsonb_build_array(v_step - 'er_text' - 'er_confirm' - 'er');
          continue;
        end if;
        -- An unchanged step keeps the wording it was written against.
        select o into v_keep from jsonb_array_elements(v_old_steps) o
         where (o - 'er_text') = (v_step - 'er_text' - 'er_confirm') limit 1;
        if v_keep is not null and not coalesce((v_step ->> 'er_confirm')::boolean, false) then
          v_out := v_out || jsonb_build_array(v_keep);
          continue;
        end if;
        v_text := public.er_text(v_project, v_step ->> 'er');
        if v_text is null then
          raise exception '% does not exist', v_step ->> 'er' using errcode = '22023';
        end if;
        v_out := v_out || jsonb_build_array(v_step - 'er_confirm' || jsonb_build_object('er_text', v_text));
      end loop;
      new.values := jsonb_set(new.values, array[v_field.key], v_out);
    end if;
  end loop;
  return new;
end;
$$;

create trigger item_revisions_er_rules before insert or update on public.item_revisions
  for each row execute function public.enforce_er_rules();

---------------------------------------------------------------------------
-- Coverage of an SRS item's ERs by the steps of the test cases that verify it.
-- stale = the step was written against different wording than the ER has now.
---------------------------------------------------------------------------
create function public.er_coverage(p_item uuid)
returns table (
  n int,
  er text,
  text text,
  tc_item_id uuid,
  tc_key text,
  step_no int,
  stale boolean
)
language sql
stable
set search_path = ''
as $$
  with srs as (
    select i.id, i.item_key, i.project_id, r.values, f.key as field
    from public.items i
    join public.item_revisions r on r.id = i.head_revision_id
    join public.tracker_fields f on f.tracker_id = i.tracker_id and f.field_type = 'statements' and not f.is_retired
    where i.id = p_item
  ),
  ers as (
    select (s ->> 'n')::int as n, srs.item_key || '.' || (s ->> 'n') as er, s ->> 'text' as text, ord
    from srs cross join lateral jsonb_array_elements(coalesce(srs.values -> srs.field, '[]'::jsonb)) with ordinality as x(s, ord)
  ),
  steps as (
    select tc.id as tc_item_id, tc.item_key as tc_key, st.ord::int as step_no, st.s ->> 'er' as er, st.s ->> 'er_text' as er_text
    from public.item_links l
    join public.link_types lt on lt.id = l.link_type_id and lt.key = 'verifies'
    join public.items tc on tc.head_revision_id = l.source_revision_id
    join public.item_revisions tr on tr.id = tc.head_revision_id
    join public.tracker_fields tf on tf.tracker_id = tc.tracker_id and tf.field_type = 'steps' and not tf.is_retired
    cross join lateral jsonb_array_elements(coalesce(tr.values -> tf.key, '[]'::jsonb)) with ordinality as st(s, ord)
    where l.target_item_id = p_item
  )
  select ers.n, ers.er, ers.text, steps.tc_item_id, steps.tc_key, steps.step_no,
         steps.er_text is distinct from ers.text and steps.tc_key is not null
  from ers left join steps on steps.er = ers.er
  order by ers.ord, steps.tc_key, steps.step_no;
$$;

revoke execute on function public.er_coverage(uuid) from public, anon;
grant execute on function public.er_coverage(uuid) to authenticated;
revoke execute on function public.er_text(uuid, text) from public, anon, authenticated;

---------------------------------------------------------------------------
-- SRS trackers: the requirement becomes a list of ERs.
-- Existing projects: a new "Requirements" statements field replaces the old text
-- field, which is retired (approved versions keep their text exactly as approved).
-- Open versions are converted: one ER per line; lines starting with "-", "*" or "•"
-- belong to the ER above them (a list inside one statement).
---------------------------------------------------------------------------
create function public.split_statements(p_text text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_line text;
  v_list text[] := '{}';
begin
  foreach v_line in array regexp_split_to_array(coalesce(p_text, ''), E'\\r?\\n') loop
    v_line := trim(v_line);
    if v_line = '' then
      continue;
    end if;
    if v_line ~ '^[-*•]\s+' and cardinality(v_list) > 0 then
      v_list[cardinality(v_list)] := v_list[cardinality(v_list)] || E'\n' || v_line;
    else
      v_list := v_list || v_line;
    end if;
  end loop;
  return coalesce((select jsonb_agg(jsonb_build_object('n', ord, 'text', t) order by ord)
                   from unnest(v_list) with ordinality as u(t, ord)), '[]'::jsonb);
end;
$$;

insert into public.tracker_fields (tracker_id, key, label, field_type, required, help_text, position)
select f.tracker_id, 'ers', 'Requirements', 'statements', true,
       'One testable statement per ER. Each ER gets a permanent ID such as SRS-011.3.', f.position
from public.tracker_fields f
join public.trackers t on t.id = f.tracker_id
where t.type_key = 'SRS' and f.key = 'requirement' and not f.is_retired
  and not exists (select 1 from public.tracker_fields x where x.tracker_id = f.tracker_id and x.key = 'ers');

update public.tracker_fields f set is_retired = true, required = false
from public.trackers t
where t.id = f.tracker_id and t.type_key = 'SRS' and f.key = 'requirement' and not f.is_retired;

update public.item_revisions r
   set values = (r.values - 'requirement') || jsonb_build_object('ers', public.split_statements(r.values ->> 'requirement')),
       content_version = r.content_version + 1
from public.trackers t, public.tracker_states s
where t.id = r.tracker_id and t.type_key = 'SRS' and s.id = r.state_id and not s.is_final
  and r.values ? 'requirement';

-- New projects: SRS starts with the statements field.
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
     "description": "What the system must do. Each requirement is a set of numbered, testable statements (ERs).",
     "fields": [
       {"key": "ers", "label": "Requirements", "type": "statements", "required": true,
        "help": "One testable statement per ER. Each ER gets a permanent ID such as SRS-011.3."},
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
