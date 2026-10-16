-- Releases (SRS-048): drafts target a release, approval pins the exact version,
-- earlier releases keep theirs, carry forward, and complete releases are frozen.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}', extensions.crypt('alice-pw', extensions.gen_salt('bf'))),
  ('b2222222-2222-4222-8222-222222222222', 'asa@test.local',   '{"full_name": "Asa Associate"}', extensions.crypt('asa-pw', extensions.gen_salt('bf'))),
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
create function pg_temp.pinned(p_release text, p_item text) returns int language sql as $$
  select r.revision from public.release_pins p join public.item_revisions r on r.id = p.revision_id
  where p.release_id = pg_temp.item(p_release) and p.item_id = pg_temp.item(p_item)
$$;
-- Take a RISK item through review to Approved (Quinn signs, Alice moves).
create function pg_temp.approve(p_key text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
  perform transition_item(pg_temp.item(p_key), pg_temp.state('RISK', 'In Progress'));
  perform transition_item(pg_temp.item(p_key), pg_temp.state('RISK', 'In Review'));
  perform set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
  perform sign_item(pg_temp.item(p_key), 'quinn-pw');
  perform set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
  perform transition_item(pg_temp.item(p_key), pg_temp.state('RISK', 'Approved'));
end;
$$;

select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.project_id', (select (create_project('Release Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'asa@test.local', 'associate');
select add_project_member(current_setting('test.project_id')::uuid, 'quinn@test.local', 'qa');

select results_eq(
  $$ select name, is_final from tracker_states where tracker_id = pg_temp.tracker('REL') order by position $$,
  $$ values ('New', false), ('Active', false), ('Complete', true) $$,
  'A new project gets a REL tracker whose Complete state is final (SRS-048)');

select create_item(pg_temp.tracker('REL'), 'v1.0');
select create_item(pg_temp.tracker('REL'), 'v1.1');
select create_item(pg_temp.tracker('RISK'), 'Sign-in', '{"failure_mode": "Users sign in.", "severity": "High", "likelihood": "Low"}',
                   null, '[]', pg_temp.item('REL-001'));
select create_item(pg_temp.tracker('RISK'), 'Audit', '{"failure_mode": "Changes are audited.", "severity": "High", "likelihood": "Low"}',
                   null, '[]', pg_temp.item('REL-001'));

select throws_ok(
  $$ select create_item(pg_temp.tracker('RISK'), 'Bad target', '{"failure_mode": "x", "severity": "High", "likelihood": "Low"}',
                        null, '[]', pg_temp.item('RISK-001')) $$,
  '22023', null,
  'Only REL items can be a target release');

select pg_temp.approve('RISK-001');
select pg_temp.approve('RISK-002');
select is(pg_temp.pinned('REL-001', 'RISK-001'), 1, 'Approving a version pins it to its target release (SRS-048)');

select is(
  (select reason from audit_log where table_name = 'release_pins' and action = 'INSERT'
     and new_values ->> 'item_id' = pg_temp.item('RISK-001')::text),
  'Version 1 approved for REL-001',
  'Pinning is audited (SRS-028)');

-- v1.1 starts from v1.0, then SRS-001 changes for v1.1
select results_eq(
  $$ select carry_forward_release(pg_temp.item('REL-002'), pg_temp.item('REL-001')) $$,
  $$ values (2) $$,
  'A new release can carry forward an earlier release''s contents');

select start_revision(pg_temp.item('RISK-001'), 'Password rules for v1.1', pg_temp.item('REL-002'));
select results_eq(
  $$ select kind, item_key, revision from release_contents(pg_temp.item('REL-002')) where item_key = 'RISK-001' order by kind $$,
  $$ values ('draft', 'RISK-001', 2), ('pinned', 'RISK-001', 1) $$,
  'A release shows both what it contains and the drafts aimed at it');

select pg_temp.approve('RISK-001');
select results_eq(
  $$ select pg_temp.pinned('REL-001', 'RISK-001'), pg_temp.pinned('REL-002', 'RISK-001'), pg_temp.pinned('REL-002', 'RISK-002') $$,
  $$ values (1, 2, 1) $$,
  'Approval replaces the pin in its target release only; the earlier release keeps version 1 (SRS-048)');

-- Associate cannot manage releases ---------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
select throws_ok(
  $$ select unpin_from_release(pg_temp.item('REL-002'), pg_temp.item('RISK-002'), 'Not needed') $$,
  '42501', null,
  'Only roles with releases.manage can change release contents directly');
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);

select throws_ok(
  $$ select unpin_from_release(pg_temp.item('REL-002'), pg_temp.item('RISK-002'), '  ') $$,
  '23502', null,
  'Taking an item out of a release needs a reason');

select throws_ok(
  $$ insert into release_pins (project_id, release_id, item_id, revision_id)
     values (current_setting('test.project_id')::uuid, pg_temp.item('REL-002'), pg_temp.item('RISK-002'),
             (select head_revision_id from items where id = pg_temp.item('RISK-002'))) $$,
  '42501', null,
  'Release contents cannot be written by direct requests (SRS-006)');

-- Complete v1.0: frozen --------------------------------------------------------------------
select transition_item(pg_temp.item('REL-001'), pg_temp.state('REL', 'Active'));
select transition_item(pg_temp.item('REL-001'), pg_temp.state('REL', 'Complete'));

select throws_ok(
  $$ select unpin_from_release(pg_temp.item('REL-001'), pg_temp.item('RISK-002'), 'Mistake') $$,
  '42501', null,
  'A complete release''s contents cannot change (SRS-048)');

select throws_ok(
  $$ select start_revision(pg_temp.item('RISK-002'), 'Change', pg_temp.item('REL-001')) $$,
  '22023', null,
  'A complete release cannot be targeted');

select start_revision(pg_temp.item('RISK-002'), 'Wording for v1.1', pg_temp.item('REL-002'));
select throws_ok(
  $$ select set_target_release(pg_temp.item('RISK-002'), pg_temp.item('REL-001')) $$,
  '22023', null,
  'A draft cannot be retargeted to a complete release');
reset role;

select throws_ok(
  $$ delete from release_pins where release_id = pg_temp.item('REL-001') $$,
  '42501', null,
  'A complete release''s contents cannot change, even for the database owner (SRS-048)');

select throws_ok(
  $$ update release_pins set revision_id = (select head_revision_id from items where id = pg_temp.item('RISK-002'))
     where release_id = pg_temp.item('REL-002') and item_id = pg_temp.item('RISK-002') $$,
  '23514', 'Only approved versions can be pinned to a release',
  'Only approved versions can be in a release, whoever writes');

select results_eq(
  $$ select item_key, revision from release_contents(pg_temp.item('REL-001')) order by item_key $$,
  $$ values ('RISK-001', 1), ('RISK-002', 1) $$,
  'The complete release still shows exactly the versions it was released with (SRS-048)');

select * from finish();
rollback;
