-- The review dashboard: what waits for my signature, and what was sent back to me.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(8);

insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}', extensions.crypt('alice-pw', extensions.gen_salt('bf'))),
  ('b2222222-2222-4222-8222-222222222222', 'val@test.local',   '{"full_name": "Val Specialist"}', extensions.crypt('val-pw', extensions.gen_salt('bf'))),
  ('c3333333-3333-4333-8333-333333333333', 'quinn@test.local', '{"full_name": "Quinn QA"}', extensions.crypt('quinn-pw', extensions.gen_salt('bf'))),
  ('e5555555-5555-4555-8555-555555555555', 'oscar@test.local', '{"full_name": "Oscar Outsider"}', extensions.crypt('oscar-pw', extensions.gen_salt('bf')));

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
create function pg_temp.queue() returns text language sql as $$
  select coalesce(string_agg(kind || ':' || item_key || coalesce('+' || pair_key, '') || '@' || coalesce(release_key, '-'), ' '), '')
  from public.my_review_queue()
$$;

select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select set_config('test.project_id', (select (create_project('Queue Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'val@test.local', 'specialist');
select add_project_member(current_setting('test.project_id')::uuid, 'quinn@test.local', 'qa');
select create_item(pg_temp.tracker('REL'), 'v1.0');
select create_item(pg_temp.tracker('SRS'), 'Archiving', '{"verification": "Test (manual)", "ers": [{"n": 1, "text": "Archive"}]}',
                   null, '[]', pg_temp.item('REL-001'));
select update_item(pg_temp.item('TC-001'), 'Archiving test', '{"execution_type": "Manual", "steps": [
  {"action": "Archive", "expected": "Archived", "er": "SRS-001.1"}]}');
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'In Progress'));
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Ready for Review'));
select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'In Progress'));
select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'Ready for Review'));
select transition_item(pg_temp.item('SRS-001'), pg_temp.state('SRS', 'Val Review'));

select is(pg_temp.queue(), '', 'The author''s own work is not in their review queue');

select pg_temp.as_user('b2222222-2222-4222-8222-222222222222');
select is(pg_temp.queue(), 'review:SRS-001+TC-001@REL-001', 'Val sees the pair once, with its release');

select pg_temp.as_user('c3333333-3333-4333-8333-333333333333');
select is(pg_temp.queue(), '', 'QA does not see items waiting for another stage');

select pg_temp.as_user('b2222222-2222-4222-8222-222222222222');
select sign_and_advance(pg_temp.item('SRS-001'), 'val-pw');
select is(pg_temp.queue(), '', 'Once signed, it leaves Val''s queue');
select results_eq(
  $$ select s.name from item_heads h join tracker_states s on s.id = h.state_id
     where h.item_key in ('SRS-001', 'TC-001') and h.project_id = current_setting('test.project_id')::uuid $$,
  $$ values ('QA Review'), ('QA Review') $$,
  'Signing from the queue moves the pair on to the next stage');
select pg_temp.as_user('c3333333-3333-4333-8333-333333333333');
select is(pg_temp.queue(), 'review:SRS-001+TC-001@REL-001', 'and it appears in QA''s queue');

select pg_temp.as_user('c3333333-3333-4333-8333-333333333333');
select reject_item(pg_temp.item('SRS-001'), 'Not enough steps');
select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
select is(pg_temp.queue(), 'rework:SRS-001+TC-001@REL-001', 'What is sent back lands in the assignee''s Needs work queue');

select pg_temp.as_user('e5555555-5555-4555-8555-555555555555');
select is(pg_temp.queue(), '', 'Non-members see nothing (SRS-004)');
reset role;

select * from finish();
rollback;
