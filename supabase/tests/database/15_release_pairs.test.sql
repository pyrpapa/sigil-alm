-- A requirement and its test case share a release: targeting a release, adding an
-- approved version to one, and taking it out again all move the pair together, however
-- the change is made (item page, release page, bulk action on the tracker list, or API).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(6);

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
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select null::void from (select set_config('request.jwt.claims', '{"sub": "' || p_id || '", "role": "authenticated"}', true)) x
$$;
-- What a release holds, as 'SRS-001 v1, TC-001 v1'.
create function pg_temp.contents(p_release text) returns text language sql as $$
  select coalesce(string_agg(i.item_key || ' v' || r.revision, ', ' order by i.item_key), '')
  from public.release_pins p join public.items i on i.id = p.item_id join public.item_revisions r on r.id = p.revision_id
  where p.release_id = pg_temp.item(p_release)
$$;
-- The release each half of pair 1 is aimed at.
create function pg_temp.targets() returns text language sql as $$
  select string_agg(h.item_key || '>' || coalesce(rel.item_key, '-'), ' ' order by h.item_key)
  from public.item_heads h left join public.items rel on rel.id = h.target_release_id
  where h.item_key in ('SRS-001', 'TC-001') and h.project_id = current_setting('test.project_id')::uuid
$$;

select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select set_config('test.project_id', (select (create_project('Release Pair Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'val@test.local', 'specialist');
select add_project_member(current_setting('test.project_id')::uuid, 'quinn@test.local', 'qa');
select create_item(pg_temp.tracker('REL'), 'v1.0');
select create_item(pg_temp.tracker('REL'), 'v1.1');

-- A requirement with its test case written
select create_item(pg_temp.tracker('SRS'), 'Archiving', '{"verification": "Test (manual)", "ers": [{"n": 1, "text": "User is able to archive a project"}]}');
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'In Progress'));
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Ready for Review'));
select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'In Progress'));
select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual", "steps": [
  {"action": "Archive the project", "expected": "User is able to archive a project", "er": "SRS-001.1"}]}');
select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'Ready for Review'));

-- Targeting: aiming the requirement at a release aims its test case there too
select set_target_release(pg_temp.item('SRS-001'), pg_temp.item('REL-001'));
select is(pg_temp.targets(), 'SRS-001>REL-001 TC-001>REL-001', 'Targeting a requirement at a release targets its test case too');

select set_target_release(pg_temp.item('SRS-001'), null);
select is(pg_temp.targets(), 'SRS-001>- TC-001>-', 'Clearing the requirement''s target clears its test case''s too');

-- Approve the pair with no target, so nothing is pinned yet
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Val Review'));
select pg_temp.as_user('b2222222-2222-4222-8222-222222222222');
select sign_item(pg_temp.item('SRS-001'), 'val-pw');
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'QA Review'));
select pg_temp.as_user('c3333333-3333-4333-8333-333333333333');
select sign_item(pg_temp.item('SRS-001'), 'quinn-pw');
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Approved'));
select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
select is(pg_temp.contents('REL-002'), '', 'Approved with no target release: no release holds the pair yet');

-- Adding the approved requirement to a release adds its approved test case
select pin_to_release(pg_temp.item('REL-002'), pg_temp.item('SRS-001'), 'Bulk: in scope for v1.1');
select is(pg_temp.contents('REL-002'), 'SRS-001 v1, TC-001 v1', 'Adding an approved requirement to a release adds its test case at its approved version');

select results_eq(
  $$ select count(*)::int from audit_log a join release_pins p on p.id::text = a.record_id::text
     where a.table_name = 'release_pins' and p.release_id = pg_temp.item('REL-002') and a.reason = 'Bulk: in scope for v1.1' $$,
  $$ values (2) $$,
  'Both pins are audited with the reason given');

-- Taking the requirement out takes its test case out too (already the rule; kept as a check)
select unpin_from_release(pg_temp.item('REL-002'), pg_temp.item('SRS-001'), 'Moved to a later release');
select is(pg_temp.contents('REL-002'), '', 'Taking the requirement out of a release takes its test case out too');
reset role;

select * from finish();
rollback;
