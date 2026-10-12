-- Items through their workflow: IDs, validation, versions, locking, review gates,
-- signatures, state actions, reasons, and the audit trail.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(41);

insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}', extensions.crypt('alice-pw', extensions.gen_salt('bf'))),
  ('b2222222-2222-4222-8222-222222222222', 'sam@test.local',   '{"full_name": "Sam Specialist"}', extensions.crypt('sam-pw', extensions.gen_salt('bf'))),
  ('c3333333-3333-4333-8333-333333333333', 'quinn@test.local', '{"full_name": "Quinn QA"}', extensions.crypt('quinn-pw', extensions.gen_salt('bf'))),
  ('d4444444-4444-4444-8444-444444444444', 'vera@test.local',  '{"full_name": "Vera Viewer"}', extensions.crypt('vera-pw', extensions.gen_salt('bf')));

-- Look up a state of the SRS tracker by name.
create function pg_temp.srs_state(p_name text) returns uuid language sql as $$
  select s.id from public.tracker_states s join public.trackers t on t.id = s.tracker_id
  where t.type_key = 'SRS' and t.project_id = current_setting('test.project_id')::uuid and s.name = p_name
$$;

select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.project_id', (select (create_project('Workflow Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'sam@test.local', 'specialist');
select add_project_member(current_setting('test.project_id')::uuid, 'quinn@test.local', 'qa');
select add_project_member(current_setting('test.project_id')::uuid, 'vera@test.local', 'viewer');
select set_config('test.srs', (select id::text from trackers where type_key = 'SRS'
                                 and project_id = current_setting('test.project_id')::uuid), true);
select set_config('test.tc', (select id::text from trackers where type_key = 'TC'
                                and project_id = current_setting('test.project_id')::uuid), true);
reset role;

-- Sam creates items ------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ select create_item(current_setting('test.srs')::uuid, 'Missing requirement', '{"verification": "Inspection"}') $$,
  '23502', '"Requirement" is required',
  'Required fields must be filled in (SRS-016)');

select throws_ok(
  $$ select create_item(current_setting('test.srs')::uuid, 'Bad option',
       '{"requirement": "x", "verification": "Guesswork"}') $$,
  '22023', null,
  'Dropdown values must be one of the configured options (SRS-016)');

select throws_ok(
  $$ select create_item(current_setting('test.srs')::uuid, 'Unknown field',
       '{"requirement": "x", "verification": "Inspection", "colour": "blue"}') $$,
  '22023', null,
  'Values for fields that do not exist are refused (SRS-016)');

select throws_ok(
  $$ select create_item(current_setting('test.tc')::uuid, 'Bad steps',
       '{"execution_type": "Manual", "steps": [{"action": "Click", "expected": ""}]}') $$,
  '22023', null,
  'Every test step needs an action and an expected result');

-- Documentation steps (SRS-049) ------------------------------------------------------
select throws_ok(
  $$ select create_item(current_setting('test.tc')::uuid, 'No values to record',
       '{"execution_type": "Manual", "steps": [{"kind": "document", "action": "Record the environment", "fields": []}]}') $$,
  '22023', null,
  'A documentation step must name at least one value to record (SRS-049)');

select throws_ok(
  $$ select create_item(current_setting('test.tc')::uuid, 'Document with expected',
       '{"execution_type": "Manual", "steps": [{"kind": "document", "action": "Record", "expected": "Works", "fields": ["Browser"]}]}') $$,
  '22023', null,
  'A documentation step has no expected result (SRS-049)');

select throws_ok(
  $$ select create_item(current_setting('test.tc')::uuid, 'Duplicate values',
       '{"execution_type": "Manual", "steps": [{"kind": "document", "action": "Record", "fields": ["Browser", " browser "]}]}') $$,
  '22023', null,
  'Values to record must have unique names (SRS-049)');

select throws_ok(
  $$ select create_item(current_setting('test.tc')::uuid, 'Unknown kind',
       '{"execution_type": "Manual", "steps": [{"kind": "guess", "action": "Click", "expected": "Works"}]}') $$,
  '22023', null,
  'Unknown step kinds are refused');

select results_eq(
  $$ select jsonb_array_length(values -> 'steps') from create_item(current_setting('test.tc')::uuid, 'Mixed steps',
       '{"execution_type": "Manual", "steps": [
          {"kind": "document", "action": "Record the test environment", "fields": ["Browser and version", "Operating system"]},
          {"action": "Open the login page", "expected": "The Sign in button is visible"}]}') $$,
  $$ values (2) $$,
  'A test case can mix documentation and verification steps (SRS-049)');

select results_eq(
  $$ select item_key, version from create_item(current_setting('test.srs')::uuid, 'Sign-in required',
       '{"requirement": "Users must sign in.", "verification": "Test (automated)"}') $$,
  $$ values ('SRS-001', 1) $$,
  'The first SRS item is SRS-001, version 1 (SRS-014)');

select results_eq(
  $$ select item_key from create_item(current_setting('test.srs')::uuid, 'Second requirement',
       '{"requirement": "Something else.", "verification": "Inspection"}') $$,
  $$ values ('SRS-002') $$,
  'IDs increase within the tracker (SRS-014)');

select set_config('test.item', (select id::text from items where item_key = 'SRS-001'
                                  and project_id = current_setting('test.project_id')::uuid), true);

select is(
  (select state_id from items where id = current_setting('test.item')::uuid),
  pg_temp.srs_state('New'),
  'New items start in the New state');

select results_eq(
  $$ select version from update_item(current_setting('test.item')::uuid, 'Sign-in required',
       '{"requirement": "Users must sign in with email and password.", "verification": "Test (automated)"}') $$,
  $$ values (2) $$,
  'Editing content creates a new version (SRS-020)');

select is((select count(*)::int from item_versions where item_id = current_setting('test.item')::uuid), 2,
  'Every version is kept (SRS-020)');

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
       '{"requirement": "Changed.", "verification": "Test (automated)"}') $$,
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
  $$ select signer_name, meaning, item_version, state_name
     from sign_item(current_setting('test.item')::uuid, 'quinn-pw') $$,
  $$ values ('Quinn QA', 'Approved', 2, 'In Review') $$,
  'QA signs with printed name, meaning, version and state (SRS-022, SRS-024, SRS-026)');

select throws_ok(
  $$ select sign_item(current_setting('test.item')::uuid, 'quinn-pw') $$,
  '23505', null,
  'An item is reviewed once per stay in a review state');

reset role;

-- Sam moves it on --------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('Approved')) $$,
  'After review, the item can move to Approved (SRS-022)');

select results_eq(
  $$ select values ->> 'approved_on', version from items where id = current_setting('test.item')::uuid $$,
  $$ values (to_char(current_date, 'YYYY-MM-DD'), 2) $$,
  'Entering Approved sets "Approved on" to today without creating a new version');

select throws_ok(
  $$ select update_item(current_setting('test.item')::uuid, 'Edited when approved',
       '{"requirement": "Changed.", "verification": "Test (automated)"}') $$,
  '42501', null,
  'Approved items cannot be edited (SRS-025)');

select throws_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Progress')) $$,
  '23502', null,
  'Moving an approved item back needs a reason (SRS-029)');

select lives_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Progress'), 'Clarify wording') $$,
  'With a reason, an approved item can move back to In Progress (SRS-029)');

select ok(
  (select not (values ? 'approved_on') from items where id = current_setting('test.item')::uuid),
  'Entering In Progress clears "Approved on" (state action)');

select throws_ok(
  $$ select update_item(current_setting('test.item')::uuid, 'Sign-in required',
       '{"requirement": "Users must sign in with email and password before seeing data.", "verification": "Test (automated)"}') $$,
  '23502', null,
  'Once reviewed, any content change needs a reason (SRS-029)');

select results_eq(
  $$ select version from update_item(current_setting('test.item')::uuid, 'Sign-in required',
       '{"requirement": "Users must sign in with email and password before seeing data.", "verification": "Test (automated)"}',
       null, 'Clarified per QA comment') $$,
  $$ values (3) $$,
  'With a reason, the edit creates version 3 (SRS-020, SRS-029)');

select lives_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Review')) $$,
  'The item goes back for review');

select throws_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('Approved')) $$,
  '42501', null,
  'The earlier signature does not count for the new version: review restarts (SRS-026)');

select lives_ok(
  $$ select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Progress'), 'More changes needed') $$,
  'Without a review, the item can only go back to an editable state');

reset role;

-- Independence: the author of the current version cannot review it
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select update_member_role(current_setting('test.project_id')::uuid, 'b2222222-2222-4222-8222-222222222222', 'specialist');
select transition_item(current_setting('test.item')::uuid, pg_temp.srs_state('In Review'));
select update_member_role(current_setting('test.project_id')::uuid, 'b2222222-2222-4222-8222-222222222222', 'qa', 'Sam now covers QA');
reset role;

select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select sign_item(current_setting('test.item')::uuid, 'sam-pw') $$,
  '42501', null,
  'The author of the current version cannot review it, even with the right role (SRS-027)');
reset role;

-- Viewer and direct access ----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ select create_item(current_setting('test.srs')::uuid, 'Viewer item', '{"requirement": "x", "verification": "Inspection"}') $$,
  '42501', null,
  'A Viewer cannot create items (SRS-007)');

select throws_ok(
  $$ update items set title = 'Direct edit' where id = current_setting('test.item')::uuid $$,
  '42501', null,
  'Items cannot be changed by direct requests, only through the workflow functions (SRS-006)');

reset role;

-- Records that cannot be changed ------------------------------------------------------
select throws_ok(
  $$ update item_signatures set meaning = 'Reviewed' $$,
  '42501', null,
  'Even the database owner cannot alter a signature (SRS-026)');

select throws_ok(
  $$ update tracker_states set is_retired = true where id = pg_temp.srs_state('In Review') $$,
  '42501', null,
  'A state cannot be retired while items are in it');

select is(
  (select reason from audit_log where table_name = 'items' and action = 'UPDATE'
     and record_id = current_setting('test.item') and reason like 'Moved from Approved%'),
  'Moved from Approved to In Progress: Clarify wording',
  'State changes are audited with the move and the reason (SRS-028, SRS-029)');

select * from finish();
rollback;
