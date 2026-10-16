-- Items through their workflow: IDs, validation, versions, locking, review gates,
-- signatures, new versions of approved items, assignees, reasons and the audit trail.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(50);

insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}', extensions.crypt('alice-pw', extensions.gen_salt('bf'))),
  ('b2222222-2222-4222-8222-222222222222', 'sam@test.local',   '{"full_name": "Sam Specialist"}', extensions.crypt('sam-pw', extensions.gen_salt('bf'))),
  ('c3333333-3333-4333-8333-333333333333', 'quinn@test.local', '{"full_name": "Quinn QA"}', extensions.crypt('quinn-pw', extensions.gen_salt('bf'))),
  ('d4444444-4444-4444-8444-444444444444', 'vera@test.local',  '{"full_name": "Vera Viewer"}', extensions.crypt('vera-pw', extensions.gen_salt('bf')));

-- Look up a state of the RISK tracker (the plain document workflow) by name.
create function pg_temp.srs_state(p_name text) returns uuid language sql as $$
  select s.id from public.tracker_states s join public.trackers t on t.id = s.tracker_id
  where t.type_key = 'RISK' and t.project_id = current_setting('test.project_id')::uuid and s.name = p_name
$$;
create function pg_temp.rev(p_version int) returns public.item_revisions language sql as $$
  select * from public.item_revisions where item_id = current_setting('test.item')::uuid and revision = p_version
$$;

select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.project_id', (select (create_project('Workflow Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'sam@test.local', 'specialist');
select add_project_member(current_setting('test.project_id')::uuid, 'quinn@test.local', 'qa');
select add_project_member(current_setting('test.project_id')::uuid, 'vera@test.local', 'viewer');
select set_config('test.srs', (select id::text from trackers where type_key = 'RISK'
                                 and project_id = current_setting('test.project_id')::uuid), true);
select set_config('test.tc', (select id::text from trackers where type_key = 'TC'
                                and project_id = current_setting('test.project_id')::uuid), true);
-- A requirement brings its test case (TC-001) with it; step checks run on that test case.
select create_item((select id from trackers where type_key = 'SRS' and project_id = current_setting('test.project_id')::uuid),
  'Sign-in', '{"verification": "Inspection", "ers": [{"n": 1, "text": "Users sign in"}]}');
select set_config('test.tc_item', (select id::text from items where item_key = 'TC-001'
                                     and project_id = current_setting('test.project_id')::uuid), true);
reset role;

-- Sam creates items ------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ select create_item(current_setting('test.srs')::uuid, 'Missing requirement', '{"severity": "High", "likelihood": "Low"}') $$,
  '23502', '"Failure mode" is required',
  'Required fields must be filled in (SRS-016)');

select throws_ok(
  $$ select create_item(current_setting('test.srs')::uuid, 'Bad option',
       '{"failure_mode": "x", "severity": "Huge", "likelihood": "Low"}') $$,
  '22023', null,
  'Dropdown values must be one of the configured options (SRS-016)');

select throws_ok(
  $$ select create_item(current_setting('test.srs')::uuid, 'Unknown field',
       '{"failure_mode": "x", "severity": "High", "likelihood": "Low", "colour": "blue"}') $$,
  '22023', null,
  'Values for fields that do not exist are refused (SRS-016)');

select throws_ok(
  $$ select update_item(current_setting('test.tc_item')::uuid, 'Bad steps',
       '{"execution_type": "Manual", "steps": [{"action": "Click", "expected": ""}]}') $$,
  '22023', null,
  'Every test step needs an action and an expected result');

-- Documentation steps (SRS-049) ------------------------------------------------------
select throws_ok(
  $$ select update_item(current_setting('test.tc_item')::uuid, 'No values to record',
       '{"execution_type": "Manual", "steps": [{"kind": "document", "action": "Record the environment", "fields": []}]}') $$,
  '22023', null,
  'A documentation step must name at least one value to record (SRS-049)');

select throws_ok(
  $$ select update_item(current_setting('test.tc_item')::uuid, 'Document with expected',
       '{"execution_type": "Manual", "steps": [{"kind": "document", "action": "Record", "expected": "Works", "fields": ["Browser"]}]}') $$,
  '22023', null,
  'A documentation step has no expected result (SRS-049)');

select throws_ok(
  $$ select update_item(current_setting('test.tc_item')::uuid, 'Duplicate values',
       '{"execution_type": "Manual", "steps": [{"kind": "document", "action": "Record", "fields": ["Browser", " browser "]}]}') $$,
  '22023', null,
  'Values to record must have unique names (SRS-049)');

select throws_ok(
  $$ select update_item(current_setting('test.tc_item')::uuid, 'Unknown kind',
       '{"execution_type": "Manual", "steps": [{"kind": "guess", "action": "Click", "expected": "Works"}]}') $$,
  '22023', null,
  'Unknown step kinds are refused');

select results_eq(
  $$ select jsonb_array_length(values -> 'steps') from update_item(current_setting('test.tc_item')::uuid, 'Mixed steps',
       '{"execution_type": "Manual", "steps": [
          {"kind": "document", "action": "Record the test environment", "fields": ["Browser and version", "Operating system"]},
          {"action": "Open the login page", "expected": "The Sign in button is visible"}]}') $$,
  $$ values (2) $$,
  'A test case can mix documentation and verification steps (SRS-049)');

select results_eq(
  $$ select item_key, revision, content_version, assignee::text from create_item(current_setting('test.srs')::uuid, 'Sign-in required',
       '{"failure_mode": "Users must sign in.", "severity": "High", "likelihood": "Low"}') $$,
  $$ values ('RISK-001', 1, 1, 'b2222222-2222-4222-8222-222222222222') $$,
  'The first RISK item is RISK-001, version 1, assigned to its author (SRS-014)');

select results_eq(
  $$ select item_key from create_item(current_setting('test.srs')::uuid, 'Second requirement',
       '{"failure_mode": "Something else.", "severity": "High", "likelihood": "Low"}') $$,
  $$ values ('RISK-002') $$,
  'IDs increase within the tracker (SRS-014)');

select set_config('test.item', (select id::text from items where item_key = 'RISK-001'
                                  and project_id = current_setting('test.project_id')::uuid), true);

select is((pg_temp.rev(1)).state_id, pg_temp.srs_state('New'), 'New items start in the New state');

select results_eq(
  $$ select revision, content_version from update_item(current_setting('test.item')::uuid, 'Sign-in required',
       '{"failure_mode": "Users must sign in with email and password.", "severity": "High", "likelihood": "Low"}') $$,
  $$ values (1, 2) $$,
  'Editing an open version counts the edit within that version (SRS-020)');

select throws_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('Approved')) $$,
  '42501', null,
  'Moves that the workflow does not define are refused (SRS-021)');

select lives_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Progress')) $$,
  'New can move to In Progress (SRS-021)');

select lives_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Review')) $$,
  'In Progress can move to In Review (SRS-021)');

select throws_ok(
  $$ select update_item(current_setting('test.item')::uuid, 'Edited in review',
       '{"failure_mode": "Changed.", "severity": "High", "likelihood": "Low"}') $$,
  '42501', null,
  'Items cannot be edited while waiting for review (SRS-025)');

select throws_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('Approved')) $$,
  '42501', null,
  'An item cannot leave a review state for Approved until it is reviewed (SRS-022)');

select throws_ok(
  $$ select sign_item(current_setting('test.item')::uuid, 'sam-pw') $$,
  '42501', null,
  'Only the role named by the review gate can sign (SRS-022)');

reset role;

-- Quinn (QA) reviews ----------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ select sign_item(current_setting('test.item')::uuid, 'wrong-password') $$,
  '28P01', null,
  'Signing requires the signer''s correct password (SRS-023)');

select is(
  (select count(*)::int from item_signatures where item_id = current_setting('test.item')::uuid),
  0,
  'A failed signing attempt records no signature (SRS-023)');

select results_eq(
  $$ select signer_name, meaning, revision_id = (pg_temp.rev(1)).id, content_version, state_name
     from sign_item(current_setting('test.item')::uuid, 'quinn-pw') $$,
  $$ values ('Quinn QA', 'Approved', true, 2, 'In Review') $$,
  'QA signs with printed name, meaning, version, edit and state (SRS-022, SRS-024, SRS-026)');

select throws_ok(
  $$ select sign_item(current_setting('test.item')::uuid, 'quinn-pw') $$,
  '23505', null,
  'An item is reviewed once per stay in a review state');

reset role;

-- Sam approves it --------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('Approved')) $$,
  'After review, the item can move to Approved (SRS-022)');

select results_eq(
  $$ select values ->> 'approved_on', approved_revision, revision from item_heads where id = current_setting('test.item')::uuid $$,
  $$ values (to_char(current_date, 'YYYY-MM-DD'), 1, 1) $$,
  'Entering Approved sets "Approved on" and makes version 1 the approved version');

select throws_ok(
  $$ select update_item(current_setting('test.item')::uuid, 'Edited when approved',
       '{"failure_mode": "Changed.", "severity": "High", "likelihood": "Low"}') $$,
  '42501', null,
  'Approved versions cannot be edited (SRS-025)');

select throws_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Progress'), 'Reopen') $$,
  '42501', null,
  'An approved version cannot be moved back; a new version is started instead');

select lives_ok(
  $$ select move_item(current_setting('test.item')::uuid,
       (select (create_folder(current_setting('test.srs')::uuid, 'Access')).id)) $$,
  'An approved item can still be filed in a folder: folders are not content (SRS-017)');

-- A new version for the next release ---------------------------------------------------
select throws_ok(
  $$ select start_revision(current_setting('test.item')::uuid, '  ') $$,
  '23502', null,
  'Starting a new version needs a reason (SRS-029)');

select results_eq(
  $$ select revision, approved_revision, (select name from tracker_states where id = state_id), values ? 'approved_on', version_reason
     from start_revision(current_setting('test.item')::uuid, 'Add password rules for v1.1') $$,
  $$ values (2, 1, 'New', false, 'Add password rules for v1.1') $$,
  'A new version starts in New with the reason, while version 1 stays approved (SRS-020)');

select throws_ok(
  $$ select start_revision(current_setting('test.item')::uuid, 'Another change') $$,
  '42501', null,
  'Only one version can be open at a time');

select update_item(current_setting('test.item')::uuid, 'Sign-in and password rules',
  '{"failure_mode": "Users must sign in with a password of at least 12 characters.", "severity": "High", "likelihood": "Low"}');

select results_eq(
  $$ select (pg_temp.rev(1)).title, (pg_temp.rev(1)).values ->> 'failure_mode', (pg_temp.rev(2)).title $$,
  $$ values ('Sign-in required', 'Users must sign in with email and password.', 'Sign-in and password rules') $$,
  'Editing the new version leaves the approved version exactly as it was (SRS-020, SRS-025)');

select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Progress'));
select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Review'));

select throws_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('Approved')) $$,
  '42501', null,
  'Version 1''s signature does not count for version 2: review starts again (SRS-026)');

select lives_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Progress'), 'More changes needed') $$,
  'Without a review, the version can only go back to an editable state');
reset role;

-- Quinn signs version 2, then Sam sends it back for more work
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Review'));
reset role;
select set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select sign_item(current_setting('test.item')::uuid, 'quinn-pw');
reset role;

select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Progress'), 'Wording');
select throws_ok(
  $$ select update_item(current_setting('test.item')::uuid, 'Sign-in and password rules',
       '{"failure_mode": "Users must sign in with a password of at least 14 characters.", "severity": "High", "likelihood": "Low"}') $$,
  '23502', null,
  'Once a version has been reviewed, further edits need a reason (SRS-029)');

select results_eq(
  $$ select content_version from update_item(current_setting('test.item')::uuid, 'Sign-in and password rules',
       '{"failure_mode": "Users must sign in with a password of at least 14 characters.", "severity": "High", "likelihood": "Low"}',
       null, 'QA asked for 14') $$,
  $$ values (3) $$,
  'With a reason, the edit is recorded on version 2');

-- Assignee
select throws_ok(
  $$ select assign_item(current_setting('test.item')::uuid, 'd4444444-4444-4444-8444-444444444444') $$,
  '22023', null,
  'Items can only be assigned to members who can edit them');

select results_eq(
  $$ select assignee::text from assign_item(current_setting('test.item')::uuid, 'a1111111-1111-4111-8111-111111111111', 'Alice to finish') $$,
  $$ values ('a1111111-1111-4111-8111-111111111111') $$,
  'The open version can be reassigned');

select is(
  (select reason from audit_log where table_name = 'item_revisions' and record_id = (pg_temp.rev(2)).id::text
     and 'assignee' = any(changed_fields)),
  'Alice to finish',
  'Reassignment is audited with its reason (SRS-028)');
reset role;

-- Independence: the author of the current content cannot review it
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Review'));
select update_member_role(current_setting('test.project_id')::uuid, 'b2222222-2222-4222-8222-222222222222', 'qa', 'Sam now covers QA');
reset role;

select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select sign_item(current_setting('test.item')::uuid, 'sam-pw') $$,
  '42501', null,
  'The author of the current content cannot review it, even with the right role (SRS-027)');
reset role;

-- Viewer and direct access ----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ select create_item(current_setting('test.srs')::uuid, 'Viewer item', '{"failure_mode": "x", "severity": "High", "likelihood": "Low"}') $$,
  '42501', null,
  'A Viewer cannot create items (SRS-007)');

select throws_ok(
  $$ select start_revision(current_setting('test.item')::uuid, 'Viewer change') $$,
  '42501', null,
  'A Viewer cannot start a new version (SRS-007)');

select throws_ok(
  $$ update item_revisions set title = 'Direct edit' where item_id = current_setting('test.item')::uuid $$,
  '42501', null,
  'Versions cannot be changed by direct requests, only through the workflow functions (SRS-006)');

reset role;

-- Records that cannot be changed, even by the database owner ------------------------
select throws_ok(
  $$ update item_revisions set title = 'Rewritten' where id = (pg_temp.rev(1)).id $$,
  '42501', null,
  'An approved version cannot be changed by anyone (SRS-025)');

select throws_ok(
  $$ delete from item_revisions where id = (pg_temp.rev(2)).id $$,
  '42501', null,
  'Versions cannot be deleted by anyone');

select throws_ok(
  $$ update item_signatures set meaning = 'Reviewed' $$,
  '42501', null,
  'Even the database owner cannot alter a signature (SRS-026)');

select throws_ok(
  $$ update tracker_states set is_retired = true where id = pg_temp.srs_state('In Review') $$,
  '42501', null,
  'A state cannot be retired while items are in it');

select throws_ok(
  $$ insert into tracker_transitions (tracker_id, from_state_id, to_state_id)
     values (current_setting('test.srs')::uuid, pg_temp.srs_state('Approved'), pg_temp.srs_state('In Progress')) $$,
  '42501', null,
  'Nothing can be configured to move out of a final state');

select is(
  (select reason from audit_log where table_name = 'item_revisions' and action = 'UPDATE'
     and record_id = (pg_temp.rev(2)).id::text and reason like 'Moved from In Review to In Progress: Wording'),
  'Moved from In Review to In Progress: Wording',
  'State changes are audited with the move and the reason (SRS-028, SRS-029)');

select is(
  (select reason from audit_log where table_name = 'item_revisions' and action = 'INSERT'
     and record_id = (pg_temp.rev(2)).id::text),
  'New version 2: Add password rules for v1.1',
  'Starting a version is audited with its reason (SRS-028)');

select * from finish();
rollback;
