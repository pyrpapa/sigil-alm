-- Roles and tracker configuration: defaults, who can change them, and the rules
-- the database enforces on every change.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(20);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}'),
  ('b2222222-2222-4222-8222-222222222222', 'sam@test.local',   '{"full_name": "Sam Specialist"}'),
  ('c3333333-3333-4333-8333-333333333333', 'vera@test.local',  '{"full_name": "Vera Viewer"}'),
  ('d4444444-4444-4444-8444-444444444444', 'oscar@test.local', '{"full_name": "Oscar Outsider"}');

select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.project_id', (select (create_project('Config Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'sam@test.local', 'specialist');
select add_project_member(current_setting('test.project_id')::uuid, 'vera@test.local', 'viewer');
select set_config('test.srs', (select id::text from trackers where type_key = 'SRS'
                                 and project_id = current_setting('test.project_id')::uuid), true);

-- Roles --------------------------------------------------------------------------
select throws_ok(
  $$ select add_project_member(current_setting('test.project_id')::uuid, 'oscar@test.local', 'manager') $$,
  '23514', null,
  'The retired Manager role can no longer be assigned');

select ok(
  'trackers.configure' in (select my_project_permissions(current_setting('test.project_id')::uuid)),
  'Admins can configure trackers');

-- Defaults -----------------------------------------------------------------------
select results_eq(
  $$ select type_key from trackers where project_id = current_setting('test.project_id')::uuid order by position $$,
  $$ values ('SRS'), ('SDS'), ('RISK'), ('TC'), ('TR'), ('DEV'), ('REL') $$,
  'A new project gets the default trackers, including releases (SRS-013)');

select results_eq(
  $$ select name, is_initial, review_role::text, locks_item from tracker_states
     where tracker_id = current_setting('test.srs')::uuid order by position $$,
  $$ values ('New', true, null::text, false), ('In Progress', false, null, false),
            ('Ready for Review', false, null, true), ('Val Review', false, 'specialist', true),
            ('QA Review', false, 'qa', true), ('Needs Work', false, null, false), ('Approved', false, null, true) $$,
  'The default SRS workflow: Ready for Review, then Val and QA review gates, with Needs Work (SRS-015, SRS-022)');

-- Admin changes configuration --------------------------------------------------------
select lives_ok(
  $$ insert into tracker_fields (tracker_id, key, label, field_type, options, position)
     values (current_setting('test.srs')::uuid, 'priority', 'Priority', 'select', '["Must", "Should", "Could"]', 10) $$,
  'An Admin can add a custom field (SRS-015)');

select throws_ok(
  $$ update tracker_fields set key = 'prio' where tracker_id = current_setting('test.srs')::uuid and key = 'priority' $$,
  '42501', null,
  'A field''s key cannot change once created');

select throws_ok(
  $$ update tracker_fields set field_type = 'text' where tracker_id = current_setting('test.srs')::uuid and key = 'priority' $$,
  '42501', null,
  'A field''s type cannot change once created');

select throws_ok(
  $$ insert into tracker_fields (tracker_id, key, label, field_type)
     values (current_setting('test.srs')::uuid, 'empty_choice', 'Empty choice', 'select') $$,
  '23514', null,
  'A dropdown field needs at least one option');

select results_eq(
  $$ insert into tracker_states (tracker_id, name, position, review_role, review_meaning)
     values (current_setting('test.srs')::uuid, 'Peer Review', 5, 'specialist', 'Verified')
     returning locks_item $$,
  $$ values (true) $$,
  'A state with a review gate always locks items while they wait for review');

select throws_ok(
  $$ update tracker_states set review_role = 'qa', review_meaning = 'Approved'
     where tracker_id = current_setting('test.srs')::uuid and is_initial $$,
  '42501', null,
  'The New state cannot have a review gate');

select throws_ok(
  $$ update tracker_states set name = 'Draft' where tracker_id = current_setting('test.srs')::uuid and is_initial $$,
  '42501', null,
  'The initial state is always called New');

select throws_ok(
  $$ update tracker_states set review_role = 'viewer', review_meaning = 'Reviewed'
     where tracker_id = current_setting('test.srs')::uuid and name = 'In Progress' $$,
  '23514', null,
  'Viewers cannot be required as reviewers');

select lives_ok(
  $$ insert into tracker_transitions (tracker_id, from_state_id, to_state_id)
     select current_setting('test.srs')::uuid, f.id, t.id from tracker_states f, tracker_states t
     where f.tracker_id = current_setting('test.srs')::uuid and f.name = 'In Progress'
       and t.tracker_id = current_setting('test.srs')::uuid and t.name = 'Peer Review' $$,
  'An Admin can add a transition (SRS-021)');

select throws_ok(
  $$ insert into tracker_state_actions (tracker_id, state_id, on_event, field_key, action)
     select current_setting('test.srs')::uuid, id, 'entry', 'rationale', 'set_today'
     from tracker_states where tracker_id = current_setting('test.srs')::uuid and name = 'Approved' $$,
  '23514', null,
  'Today''s date can only be set on a date or text field');

select lives_ok(
  $$ insert into tracker_state_actions (tracker_id, state_id, on_event, field_key, action, value)
     select current_setting('test.srs')::uuid, id, 'exit', 'priority', 'set_value', '"Must"'
     from tracker_states where tracker_id = current_setting('test.srs')::uuid and name = 'New' $$,
  'An Admin can add an on-exit action that sets a field value');

reset role;

select is(
  (select changed_by::text from audit_log where table_name = 'tracker_fields' and action = 'INSERT'
     and project_id = current_setting('test.project_id')::uuid and new_values ->> 'key' = 'priority'),
  'a1111111-1111-4111-8111-111111111111',
  'Configuration changes are recorded in the audit trail with who made them (SRS-028)');

-- Sam (Specialist) cannot configure --------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ insert into tracker_fields (tracker_id, key, label, field_type)
     values (current_setting('test.srs')::uuid, 'sneaky', 'Sneaky', 'text') $$,
  '42501', null,
  'A Specialist cannot add fields');

select results_eq(
  $$ with d as (delete from tracker_transitions where tracker_id = current_setting('test.srs')::uuid returning 1)
     select count(*)::int from d $$,
  $$ values (0) $$,
  'A Specialist cannot remove transitions');

reset role;

-- Visibility -----------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from trackers), 7, 'A Viewer can see the project''s trackers');
reset role;

select set_config('request.jwt.claims', '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from tracker_states), 0, 'A non-member cannot see any tracker configuration (SRS-004)');
reset role;

select * from finish();
rollback;
