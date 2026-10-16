-- ERs (requirement statements): numbering that is never reused, test steps that name
-- the ER they verify, computed coverage, and flags when an ER is reworded.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

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
create function pg_temp.coverage(p_key text) returns text language sql as $$
  select string_agg(er || '=' || coalesce(tc_key || '#' || step_no, 'none') || case when stale then '(stale)' else '' end, ' ' order by n, step_no)
  from public.er_coverage(pg_temp.item(p_key))
$$;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select null::void from (select set_config('request.jwt.claims', '{"sub": "' || p_id || '", "role": "authenticated"}', true)) x
$$;
-- Take an SRS item and its test case through Ready, Val review and QA review to Approved.
create function pg_temp.approve_pair(p_srs text, p_tc text) returns void language plpgsql as $$
begin
  perform pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
  perform transition_item(pg_temp.item(p_srs), pg_temp.state('SRS', 'In Progress'));
  perform transition_item(pg_temp.item(p_srs), pg_temp.state('SRS', 'Ready for Review'));
  perform transition_item(pg_temp.item(p_tc), pg_temp.state('TC', 'In Progress'));
  perform transition_item(pg_temp.item(p_tc), pg_temp.state('TC', 'Ready for Review'));
  perform transition_item(pg_temp.item(p_srs), pg_temp.state('SRS', 'Val Review'));
  perform pg_temp.as_user('b2222222-2222-4222-8222-222222222222');
  perform sign_item(pg_temp.item(p_srs), 'val-pw');
  perform transition_item(pg_temp.item(p_srs), pg_temp.state('SRS', 'QA Review'));
  perform pg_temp.as_user('c3333333-3333-4333-8333-333333333333');
  perform sign_item(pg_temp.item(p_srs), 'quinn-pw');
  perform transition_item(pg_temp.item(p_srs), pg_temp.state('SRS', 'Approved'));
  perform pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
end;
$$;

select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select set_config('test.project_id', (select (create_project('ER Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'val@test.local', 'specialist');
select add_project_member(current_setting('test.project_id')::uuid, 'quinn@test.local', 'qa');

select throws_ok(
  $$ select create_item(pg_temp.tracker('SRS'), 'Dupes', '{"verification": "Inspection",
       "ers": [{"n": 1, "text": "One"}, {"n": 1, "text": "Again"}]}') $$,
  '22023', null,
  'ER numbers within an SRS item are unique');

select throws_ok(
  $$ select create_item(pg_temp.tracker('SRS'), 'Empty', '{"verification": "Inspection", "ers": [{"n": 1, "text": "  "}]}') $$,
  '22023', null,
  'Every ER needs text');

select create_item(pg_temp.tracker('SRS'), 'Archiving', '{"verification": "Test (automated)", "ers": [
  {"n": 1, "text": "User is unable to delete a project"},
  {"n": 2, "text": "User is able to archive a project"},
  {"n": 3, "text": "Archived projects are read-only"}]}');

select throws_ok(
  $$ select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual",
       "steps": [{"action": "Delete", "expected": "Refused", "er": "SRS-001.9"}]}') $$,
  '22023', 'SRS-001.9 does not exist',
  'A step can only verify an ER that exists');

select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual", "steps": [
  {"action": "Try to delete the project", "expected": "There is no delete option", "er": "SRS-001.1"},
  {"action": "Archive the project", "expected": "The project shows Archived", "er": "SRS-001.2"}]}');

select is(
  (select values -> 'steps' -> 0 ->> 'er_text' from item_heads where id = pg_temp.item('TC-001')),
  'User is unable to delete a project',
  'A step records the wording of the ER it was written against');

select is(pg_temp.coverage('SRS-001'), 'SRS-001.1=TC-001#1 SRS-001.2=TC-001#2 SRS-001.3=none',
  'Coverage is computed: which step verifies each ER, and which ERs have none');

-- Cover ER 3, approve the pair, then change the requirement in version 2 --------------
select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual", "steps": [
  {"action": "Try to delete the project", "expected": "There is no delete option", "er": "SRS-001.1"},
  {"action": "Archive the project", "expected": "The project shows Archived", "er": "SRS-001.2"},
  {"action": "Try to edit an item", "expected": "Editing is refused", "er": "SRS-001.3"}]}');
select pg_temp.approve_pair('SRS-001', 'TC-001');
select start_revision(pg_temp.item('SRS-001'), 'Archive wording');

select update_item(pg_temp.item('SRS-001'), 'Archiving', '{"verification": "Test (automated)", "ers": [
  {"n": 1, "text": "User is unable to delete a project"},
  {"n": 2, "text": "Only project Admins are able to archive a project"},
  {"n": 4, "text": "User is able to de-archive a project"}]}');

select is(pg_temp.coverage('SRS-001'), 'SRS-001.1=TC-001#1 SRS-001.2=TC-001#2(stale) SRS-001.4=none',
  'A reworded ER flags the step written against the old wording; a removed ER drops out; a new ER is uncovered');

select throws_ok(
  $$ select update_item(pg_temp.item('SRS-001'), 'Archiving', '{"verification": "Test (automated)", "ers": [
       {"n": 1, "text": "x"}, {"n": 4, "text": "y"}, {"n": 4, "text": "Duplicate"}]}') $$,
  '22023', null,
  'A version cannot hold two ERs with the same number');

-- Editing another step leaves the stale step flagged
select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual", "steps": [
  {"action": "Try to delete the project", "expected": "There is no delete option at all", "er": "SRS-001.1"},
  {"action": "Archive the project", "expected": "The project shows Archived", "er": "SRS-001.2",
   "er_text": "Only project Admins are able to archive a project"},
  {"action": "Try to edit an item", "expected": "Editing is refused", "er": "SRS-001.3"}]}');
select is(pg_temp.coverage('SRS-001'), 'SRS-001.1=TC-001#1 SRS-001.2=TC-001#2(stale) SRS-001.4=none',
  'The flag cannot be cleared by sending new wording from the app; only the database records it');

select is(
  (select string_agg(problem, ' | ') from item_readiness(pg_temp.item('TC-001'))),
  'SRS-001.4 has no test step verifying it | Step 2 was written against old wording of SRS-001.2 | Step 3 verifies SRS-001.3, which the requirement no longer has',
  'The test case''s checklist lists uncovered ERs, steps against old wording and steps for removed ERs');

-- Confirm step 2 without changing it, cover ER 4, drop the step for ER 3
select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual", "steps": [
  {"action": "Try to delete the project", "expected": "There is no delete option at all", "er": "SRS-001.1"},
  {"action": "Archive the project", "expected": "The project shows Archived", "er": "SRS-001.2", "er_confirm": true},
  {"action": "De-archive it", "expected": "The project is active again", "er": "SRS-001.4"}]}');
select is(pg_temp.coverage('SRS-001'), 'SRS-001.1=TC-001#1 SRS-001.2=TC-001#2 SRS-001.4=TC-001#3',
  'The author can confirm a step still fits the new wording without rewriting it; every ER is covered');
select is((select count(*)::int from item_readiness(pg_temp.item('TC-001'))), 0, 'The test case''s checklist is clear');

-- Numbers are never reused -------------------------------------------------------------
select create_item(pg_temp.tracker('SRS'), 'Gaps', '{"verification": "Inspection", "ers": [{"n": 1, "text": "One"}, {"n": 3, "text": "Three"}]}');
select update_item(pg_temp.item('TC-002'), 'Gaps test', '{"execution_type": "Manual", "steps": [
  {"action": "a", "expected": "b", "er": "SRS-002.1"}, {"action": "c", "expected": "d", "er": "SRS-002.3"}]}');
select pg_temp.approve_pair('SRS-002', 'TC-002');
select start_revision(pg_temp.item('SRS-002'), 'More');

select throws_ok(
  $$ select update_item(pg_temp.item('SRS-002'), 'Gaps', '{"verification": "Inspection",
       "ers": [{"n": 1, "text": "One"}, {"n": 2, "text": "A new statement"}, {"n": 3, "text": "Three"}]}') $$,
  '23514', 'ER number 2 was used by an earlier version of this item; new ERs are numbered from 4',
  'A new ER cannot take a number at or below one the item has already used');

select lives_ok(
  $$ select update_item(pg_temp.item('SRS-002'), 'Gaps', '{"verification": "Inspection",
       "ers": [{"n": 1, "text": "One"}, {"n": 4, "text": "A new statement"}]}') $$,
  'New ERs continue from the highest number used, and removed ones simply drop out');
reset role;

select is(
  split_statements(E'User is able to assign these roles:\n- Admin\n- QA\n\nUser is unable to assign Manager'),
  '[{"n": 1, "text": "User is able to assign these roles:\n- Admin\n- QA"}, {"n": 2, "text": "User is unable to assign Manager"}]'::jsonb,
  'Converting text: one ER per line, with bulleted lines kept inside the ER above them');

select * from finish();
rollback;
