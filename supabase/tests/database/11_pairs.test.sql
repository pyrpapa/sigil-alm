-- The SRS/TC pair: created together, checklists, sent to review together, one signature
-- per record, rejection by the stage's reviewer with a reason, Needs Work back to the
-- first review stage only, and earlier sign-offs superseded.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(21);

insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}', extensions.crypt('alice-pw', extensions.gen_salt('bf'))),
  ('b2222222-2222-4222-8222-222222222222', 'val@test.local',   '{"full_name": "Val Specialist"}', extensions.crypt('val-pw', extensions.gen_salt('bf'))),
  ('c3333333-3333-4333-8333-333333333333', 'quinn@test.local', '{"full_name": "Quinn QA"}', extensions.crypt('quinn-pw', extensions.gen_salt('bf')));

create function pg_temp.tracker(p_key text) returns uuid language sql as $$
  select id from public.trackers where type_key = p_key and project_id = current_setting('test.project_id')::uuid
$$;
create function pg_temp.item(p_key text) returns uuid language sql as $$
  select id from public.items where item_key = p_key and project_id = current_setting('test.project_id')::uuid
$$;
create function pg_temp.state(p_tracker text, p_name text) returns uuid language sql as $$
  select id from public.tracker_states where tracker_id = pg_temp.tracker(p_tracker) and name = p_name
$$;
create function pg_temp.states() returns text language sql as $$
  select string_agg(i.item_key || ':' || s.name, ' ' order by i.item_key)
  from public.item_heads i join public.tracker_states s on s.id = i.state_id
  where i.item_key in ('SRS-001', 'TC-001') and i.project_id = current_setting('test.project_id')::uuid
$$;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select null::void from (select set_config('request.jwt.claims', '{"sub": "' || p_id || '", "role": "authenticated"}', true)) x
$$;

select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select set_config('test.project_id', (select (create_project('Pair Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'val@test.local', 'specialist');
select add_project_member(current_setting('test.project_id')::uuid, 'quinn@test.local', 'qa');

-- Created together ---------------------------------------------------------------------
select create_item(pg_temp.tracker('SRS'), 'Archiving', '{"verification": "Test (manual)", "ers": [
  {"n": 1, "text": "User is able to archive a project"}, {"n": 2, "text": "Archived projects are read-only"}]}');

select results_eq(
  $$ select tc.item_key, tc.title, tc.pair_item_id = srs.id, srs.pair_item_id = tc.id
     from item_heads tc, item_heads srs where tc.id = pg_temp.item('TC-001') and srs.id = pg_temp.item('SRS-001') $$,
  $$ values ('TC-001', 'Archiving', true, true) $$,
  'Creating a requirement creates its test case with the same number (SRS-001 and TC-001)');

select throws_ok(
  $$ select create_item(pg_temp.tracker('TC'), 'Loose test', '{"execution_type": "Manual", "steps": [{"action": "a", "expected": "b"}]}') $$,
  '42501', null,
  'Test cases cannot be created on their own');

-- Each moves to Ready on its own, through its checklist ----------------------------------
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'In Progress'));
select lives_ok(
  $$ select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Ready for Review')) $$,
  'The requirement can be Ready while its test case is still being written');

select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'In Progress'));
select throws_ok(
  $$ select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'Ready for Review')) $$,
  '23514', 'TC-001 is not ready for review: "Execution type" is required; "Steps" is required; SRS-001.1 has no test step verifying it; SRS-001.2 has no test step verifying it',
  'A test case cannot be Ready until its fields are filled and every ER has a step');

select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual", "steps": [
  {"action": "Archive the project", "expected": "It shows Archived", "er": "SRS-001.1"}]}');
select throws_ok(
  $$ select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Val Review')) $$,
  '42501', null,
  'The pair goes to review together only when both are Ready');

select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual", "steps": [
  {"action": "Archive the project", "expected": "It shows Archived", "er": "SRS-001.1"},
  {"action": "Try to edit an item", "expected": "Editing is refused", "er": "SRS-001.2"}]}');
select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'Ready for Review'));

select throws_ok(
  $$ select update_item(pg_temp.item('TC-001'), 'Changed in Ready', '{"execution_type": "Manual", "steps": [
       {"action": "x", "expected": "y", "er": "SRS-001.1"}, {"action": "x", "expected": "y", "er": "SRS-001.2"}]}') $$,
  '42501', null,
  'Ready is locked: move back to In Progress to change it');

select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Val Review'));
select is(pg_temp.states(), 'SRS-001:Val Review TC-001:Val Review', 'Sending one sends both to Val Review');

-- One review action, one signature per record ----------------------------------------------
select pg_temp.as_user('c3333333-3333-4333-8333-333333333333');
select throws_ok(
  $$ select sign_item(pg_temp.item('SRS-001'), 'quinn-pw') $$,
  '42501', null,
  'Val Review is signed by a Specialist, not QA');
select throws_ok(
  $$ select reject_item(pg_temp.item('SRS-001'), 'Not mine to reject') $$,
  '42501', null,
  'Only the stage''s reviewer can send the pair back');

select pg_temp.as_user('b2222222-2222-4222-8222-222222222222');
select sign_item(pg_temp.item('TC-001'), 'val-pw');
select results_eq(
  $$ select i.item_key, s.state_name, s.meaning from item_signatures s join items i on i.id = s.item_id
     where s.project_id = current_setting('test.project_id')::uuid order by i.item_key $$,
  $$ values ('SRS-001', 'Val Review', 'Reviewed'), ('TC-001', 'Val Review', 'Reviewed') $$,
  'Signing either one records a signature on both, each bound to its own version (SRS-022, SRS-026)');

select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'QA Review'));
select is(pg_temp.states(), 'SRS-001:QA Review TC-001:QA Review', 'The pair moves on to QA Review together');

-- QA rejects: reason required, comments pinned to an ER or step ---------------------------
select pg_temp.as_user('c3333333-3333-4333-8333-333333333333');
select throws_ok(
  $$ select reject_item(pg_temp.item('SRS-001'), '  ') $$,
  '23502', null,
  'Sending back needs a reason');

select reject_item(pg_temp.item('SRS-001'), 'Step 2 does not check the audit entry',
  '[{"item": "TC-001", "anchor": "Step 2", "body": "Also check the audit trail shows the change"},
    {"anchor": "SRS-001.2", "body": "Say read-only for all roles"}]');
select is(pg_temp.states(), 'SRS-001:Needs Work TC-001:Needs Work', 'Rejection sends both to Needs Work');

select results_eq(
  $$ select h.last_rejection ->> 'reason', h.last_rejection ->> 'by_name', h.last_rejection ->> 'from_state'
     from item_heads h where h.id = pg_temp.item('TC-001') $$,
  $$ values ('Step 2 does not check the audit entry', 'Quinn QA', 'QA Review') $$,
  'The reason, who rejected and from which stage are kept with each version');

select results_eq(
  $$ select i.item_key, c.anchor, c.body from review_comments c join items i on i.id = c.item_id order by i.item_key $$,
  $$ values ('SRS-001', 'SRS-001.2', 'Say read-only for all roles'), ('TC-001', 'Step 2', 'Also check the audit trail shows the change') $$,
  'Review comments are pinned to the ER or step they are about');

-- Needs Work: editable, then only back to the first review stage ---------------------------
select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
select lives_ok(
  $$ select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual", "steps": [
       {"action": "Archive the project", "expected": "It shows Archived", "er": "SRS-001.1"},
       {"action": "Try to edit an item", "expected": "Editing is refused and the audit trail shows the attempt", "er": "SRS-001.2"}]}',
       null, 'QA comment on step 2') $$,
  'Needs Work can be edited (with a reason, since it has been reviewed)');

select throws_ok(
  $$ select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'QA Review')) $$,
  '42501', null,
  'Needs Work cannot go straight back to QA Review');

select throws_ok(
  $$ insert into tracker_transitions (tracker_id, from_state_id, to_state_id)
     values (pg_temp.tracker('SRS'), pg_temp.state('SRS', 'Needs Work'), pg_temp.state('SRS', 'QA Review')) $$,
  '42501', null,
  'The workflow cannot even be configured to skip the first review stage after rework');
reset role;

select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Val Review'));
select throws_ok(
  $$ select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'QA Review')) $$,
  '42501', null,
  'Val''s earlier sign-off no longer counts: Val signs again (SRS-026)');

-- Val signs again, QA approves ----------------------------------------------------------------
select pg_temp.as_user('b2222222-2222-4222-8222-222222222222');
select sign_item(pg_temp.item('SRS-001'), 'val-pw');
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'QA Review'));
select pg_temp.as_user('c3333333-3333-4333-8333-333333333333');
select sign_item(pg_temp.item('SRS-001'), 'quinn-pw');
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Approved'));
select is(pg_temp.states(), 'SRS-001:Approved TC-001:Approved', 'The pair is approved together');

select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
select start_revision(pg_temp.item('SRS-001'), 'Reword for v1.1');
select results_eq(
  $$ select r.revision, s.name from item_heads r join tracker_states s on s.id = r.state_id
     where r.id = pg_temp.item('TC-001') $$,
  $$ values (2, 'New') $$,
  'Starting a new version of the requirement starts one of its test case too');
reset role;

select * from finish();
rollback;
