-- The trash: trackers, folders and items are deleted to the trash with a reason and
-- can always be restored; nothing is destroyed. Release links must be removed first.
-- Trashed things are hidden and cannot change until restored. Pairs go together.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(32);

insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}', extensions.crypt('alice-pw', extensions.gen_salt('bf'))),
  ('b2222222-2222-4222-8222-222222222222', 'asa@test.local',   '{"full_name": "Asa Associate"}', extensions.crypt('asa-pw', extensions.gen_salt('bf'))),
  ('c3333333-3333-4333-8333-333333333333', 'quinn@test.local', '{"full_name": "Quinn QA"}', extensions.crypt('quinn-pw', extensions.gen_salt('bf')));

-- Lookups bypass row-level security (security definer) so trashed things can be found.
create function pg_temp.tracker(p_key text) returns uuid language sql security definer as $$
  select id from public.trackers where type_key = p_key and project_id = current_setting('test.project_id')::uuid
$$;
create function pg_temp.item(p_key text) returns uuid language sql security definer as $$
  select id from public.items where item_key = p_key and project_id = current_setting('test.project_id')::uuid
$$;
create function pg_temp.state(p_tracker text, p_name text) returns uuid language sql security definer as $$
  select id from public.tracker_states where tracker_id = pg_temp.tracker(p_tracker) and name = p_name
$$;
create function pg_temp.as_user(p_id text) returns void language sql as $$
  select null::void from (select set_config('request.jwt.claims', '{"sub": "' || p_id || '", "role": "authenticated"}', true)) x
$$;
-- What a member can see.
create function pg_temp.visible() returns text language sql as $$
  select coalesce(string_agg(item_key, ' ' order by item_key), '') from public.item_heads
  where project_id = current_setting('test.project_id')::uuid and item_key not like 'REL-%'
$$;
create function pg_temp.entry(p_label text) returns uuid language sql security definer as $$
  select id from public.trash_entries where label like p_label || '%' and restored_at is null
$$;
create function pg_temp.approve(p_key text) returns void language plpgsql as $$
begin
  perform pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
  perform transition_item(pg_temp.item(p_key), pg_temp.state('RISK', 'In Progress'));
  perform transition_item(pg_temp.item(p_key), pg_temp.state('RISK', 'In Review'));
  perform pg_temp.as_user('c3333333-3333-4333-8333-333333333333');
  perform sign_item(pg_temp.item(p_key), 'quinn-pw');
  perform pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
  perform transition_item(pg_temp.item(p_key), pg_temp.state('RISK', 'Approved'));
end;
$$;

select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
set local role authenticated;
select set_config('test.project_id', (select (create_project('Trash Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'asa@test.local', 'associate');
select add_project_member(current_setting('test.project_id')::uuid, 'quinn@test.local', 'qa');

select create_item(pg_temp.tracker('REL'), 'v1.0');
select create_item(pg_temp.tracker('RISK'), 'Sign-in', '{"failure_mode": "Users sign in.", "severity": "High", "likelihood": "Low"}');
select create_item(pg_temp.tracker('RISK'), 'Audit', '{"failure_mode": "Changes are audited.", "severity": "High", "likelihood": "Low"}',
                   null, '[]', pg_temp.item('REL-001'));

-- Who and why ----------------------------------------------------------------------------
select pg_temp.as_user('b2222222-2222-4222-8222-222222222222');
select throws_ok($$ select trash_item(pg_temp.item('RISK-001'), 'Not needed') $$, '42501', null,
  'Only roles with the trash permission (Admins by default) can delete');
select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
select throws_ok($$ select trash_item(pg_temp.item('RISK-001'), ' ') $$, '23502', null,
  'Deleting needs a reason');

-- An item ---------------------------------------------------------------------------------
select trash_item(pg_temp.item('RISK-001'), 'Duplicate of RISK-002');
select is(pg_temp.visible(), 'RISK-002', 'A deleted item disappears from the project');
select results_eq(
  $$ select kind, label, item_count, deleted_by_name, reason, blocked from project_trash(current_setting('test.project_id')::uuid) $$,
  $$ values ('item', 'RISK-001 Sign-in', 1, 'Alice Admin', 'Duplicate of RISK-002', null::text) $$,
  'It is listed in the project''s trash with who deleted it and why');
select throws_ok(
  $$ select update_item(pg_temp.item('RISK-001'), 'Changed', '{"failure_mode": "x", "severity": "High", "likelihood": "Low"}') $$,
  '42501', 'RISK-001 is in the trash; restore it before changing it',
  'Nothing in the trash can change');
select throws_ok(
  $$ select transition_item(pg_temp.item('RISK-001'), pg_temp.state('RISK', 'In Progress')) $$,
  '42501', null, 'or move through its workflow');

select restore_from_trash(pg_temp.entry('RISK-001'), 'Not a duplicate after all');
select is(pg_temp.visible(), 'RISK-001 RISK-002', 'Restoring brings the item back as it was');
select is((select count(*)::int from project_trash(current_setting('test.project_id')::uuid)), 0,
  'and takes it out of the trash');
reset role;
select results_eq(
  $$ select reason from audit_log where table_name = 'items' and record_id = pg_temp.item('RISK-001')::text
       and 'trash_entry_id' = any (changed_fields) order by id $$,
  $$ values ('Duplicate of RISK-002'), ('Not a duplicate after all') $$,
  'Deleting and restoring are in the audit trail with their reasons');
select results_eq(
  $$ select action, reason from audit_log where table_name = 'trash_entries' order by id $$,
  $$ values ('INSERT', 'Duplicate of RISK-002'), ('UPDATE', 'Not a duplicate after all') $$,
  'and so is the trash entry itself');
set local role authenticated;

-- Release links come off first --------------------------------------------------------------
select throws_ok($$ select trash_item(pg_temp.item('RISK-002'), 'Not needed') $$, '23503',
  'Remove the release links first: RISK-002 is planned for REL-001',
  'An item planned for a release cannot be deleted');
select set_target_release(pg_temp.item('RISK-002'), null);
select lives_ok($$ select trash_item(pg_temp.item('RISK-002'), 'Not needed') $$,
  'Once its release is cleared, it can be deleted');
select restore_from_trash(pg_temp.entry('RISK-002'));

select pg_temp.approve('RISK-001');
select pin_to_release(pg_temp.item('REL-001'), pg_temp.item('RISK-001'));
select throws_ok($$ select trash_item(pg_temp.item('RISK-001'), 'Not needed') $$, '23503',
  'Remove the release links first: RISK-001 is in REL-001',
  'Approved items can be deleted, but not while they are in a release');
select throws_ok($$ select trash_item(pg_temp.item('REL-001'), 'Not needed') $$, '23503',
  'Remove the release links first: REL-001 contains RISK-001',
  'A release cannot be deleted while it holds items');
select unpin_from_release(pg_temp.item('REL-001'), pg_temp.item('RISK-001'), 'Not part of v1.0');
select lives_ok($$ select trash_item(pg_temp.item('RISK-001'), 'Retired risk') $$,
  'Taken out of the release, the approved item can be deleted');
select lives_ok($$ select trash_item(pg_temp.item('REL-001'), 'Wrong release') $$,
  'and an empty release can be deleted');
select restore_from_trash(pg_temp.entry('RISK-001'));
select restore_from_trash(pg_temp.entry('REL-001'));

-- Pairs ---------------------------------------------------------------------------------
select create_item(pg_temp.tracker('SRS'), 'Archiving', '{"verification": "Test (manual)", "ers": [{"n": 1, "text": "User can archive"}]}');
select set_target_release(pg_temp.item('SRS-001'), pg_temp.item('REL-001'));
select is((select target_release_id from item_heads where id = pg_temp.item('TC-001')), pg_temp.item('REL-001'),
  'Planning a requirement for a release plans its test case too');
select set_target_release(pg_temp.item('SRS-001'), null);
select is((select target_release_id from item_heads where id = pg_temp.item('TC-001')), null,
  'and clearing it clears both');
select trash_item(pg_temp.item('SRS-001'), 'Out of scope');
select is(pg_temp.visible(), 'RISK-001 RISK-002', 'Deleting a requirement deletes its test case with it');
select is((select label from trash_entries where id = pg_temp.entry('SRS-001')), 'SRS-001 + TC-001 Archiving',
  'as one entry in the trash');
select restore_from_trash(pg_temp.entry('SRS-001'));
select is(pg_temp.visible(), 'RISK-001 RISK-002 SRS-001 TC-001', 'and they are restored together');

-- Folders ---------------------------------------------------------------------------------
select set_config('test.folder', (select (create_folder(pg_temp.tracker('RISK'), 'Old risks')).id::text), true);
select create_item(pg_temp.tracker('RISK'), 'Paper records', '{"failure_mode": "x", "severity": "Low", "likelihood": "Low"}',
                   current_setting('test.folder')::uuid);
select trash_item(pg_temp.item('RISK-003'), 'First pass');
select create_item(pg_temp.tracker('RISK'), 'Fax', '{"failure_mode": "x", "severity": "Low", "likelihood": "Low"}',
                   current_setting('test.folder')::uuid);
select trash_folder(current_setting('test.folder')::uuid, 'Folder no longer used');
select is((select count(*)::int from folders where tracker_id = pg_temp.tracker('RISK')), 0,
  'A deleted folder disappears');
select is(pg_temp.visible(), 'RISK-001 RISK-002 SRS-001 TC-001', 'with the items in it');
select is((select blocked from project_trash(current_setting('test.project_id')::uuid) where label like 'RISK-003%'),
  'Restore folder "Old risks" first',
  'An item deleted earlier from a deleted folder waits for its folder');
select create_folder(pg_temp.tracker('RISK'), 'Old risks');
select throws_ok($$ select restore_from_trash(pg_temp.entry('Folder "Old risks"')) $$, '42501',
  'A folder called "Old risks" exists again in that tracker; rename it first',
  'A folder is not restored over a newer folder with the same name');
select trash_folder((select id from folders where name = 'Old risks'), 'Made by mistake');
select restore_from_trash(pg_temp.entry('Folder "Old risks" in RISK'));
select is(pg_temp.visible(), 'RISK-001 RISK-002 RISK-004 SRS-001 TC-001',
  'Restoring the folder brings back what it took, not what was deleted before it');

-- Trackers --------------------------------------------------------------------------------
select set_target_release(pg_temp.item('RISK-004'), pg_temp.item('REL-001'));
select throws_ok($$ select trash_tracker(pg_temp.tracker('RISK'), 'Not used') $$, '23503', null,
  'A tracker cannot be deleted while any of its items has release links');
select set_target_release(pg_temp.item('RISK-004'), null);
select trash_tracker(pg_temp.tracker('RISK'), 'Risks kept elsewhere');
select is((select count(*)::int from trackers where type_key = 'RISK'), 0, 'A deleted tracker disappears');
select is(pg_temp.visible(), 'SRS-001 TC-001', 'with all of its items');
select throws_ok(
  $$ select create_item(pg_temp.tracker('RISK'), 'New', '{"failure_mode": "x", "severity": "Low", "likelihood": "Low"}') $$,
  '42501', null, 'and nothing can be added to it');
select trash_tracker(pg_temp.tracker('TC'), 'Testing elsewhere');
select is((select string_agg(type_key, ' ' order by type_key) from trackers where type_key in ('SRS', 'TC')), null,
  'Requirements and test cases are deleted together');
select restore_from_trash(pg_temp.entry('RISK '));
select restore_from_trash(pg_temp.entry('SRS + TC'));
select is(pg_temp.visible(), 'RISK-001 RISK-002 RISK-004 SRS-001 TC-001', 'Restoring a tracker brings back all its items');

select * from finish();
rollback;
