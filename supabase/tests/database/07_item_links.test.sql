-- Links between items (SRS-019): link types as data, both ends checked, links owned
-- and versioned by their source item, locking, reasons, visibility and the audit trail.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(32);

insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}', extensions.crypt('alice-pw', extensions.gen_salt('bf'))),
  ('b2222222-2222-4222-8222-222222222222', 'sam@test.local',   '{"full_name": "Sam Specialist"}', extensions.crypt('sam-pw', extensions.gen_salt('bf'))),
  ('c3333333-3333-4333-8333-333333333333', 'quinn@test.local', '{"full_name": "Quinn QA"}', extensions.crypt('quinn-pw', extensions.gen_salt('bf'))),
  ('d4444444-4444-4444-8444-444444444444', 'vera@test.local',  '{"full_name": "Vera Viewer"}', extensions.crypt('vera-pw', extensions.gen_salt('bf'))),
  ('e5555555-5555-4555-8555-555555555555', 'oscar@test.local', '{"full_name": "Oscar Outsider"}', extensions.crypt('oscar-pw', extensions.gen_salt('bf')));

create function pg_temp.tracker(p_key text) returns uuid language sql as $$
  select id from public.trackers where type_key = p_key and project_id = current_setting('test.project_id')::uuid
$$;
create function pg_temp.item(p_key text) returns uuid language sql as $$
  select id from public.items where item_key = p_key and project_id = current_setting('test.project_id')::uuid
$$;
create function pg_temp.state(p_tracker text, p_name text) returns uuid language sql as $$
  select s.id from public.tracker_states s where s.tracker_id = pg_temp.tracker(p_tracker) and s.name = p_name
$$;

-- Alice sets up the project ----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.project_id', (select (create_project('Links Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'sam@test.local', 'specialist');
select add_project_member(current_setting('test.project_id')::uuid, 'quinn@test.local', 'qa');
select add_project_member(current_setting('test.project_id')::uuid, 'vera@test.local', 'viewer');
-- A second project with its own SRS-001, to prove links never cross projects.
select set_config('test.other_project', (select (create_project('Other Project')).id::text), true);
select create_item((select id from trackers where type_key = 'SRS' and project_id = current_setting('test.other_project')::uuid),
                   'Elsewhere', '{"requirement": "x", "verification": "Inspection"}');

select results_eq(
  $$ select key, source_type_key, target_type_key, label, reverse_label from link_types
     where project_id = current_setting('test.project_id')::uuid order by key $$,
  $$ values ('implements', 'SDS', 'SRS', 'implements', 'implemented by'),
            ('mitigated_by', 'RISK', 'SRS', 'is mitigated by', 'mitigates'),
            ('verifies', 'TC', 'SRS', 'verifies', 'verified by') $$,
  'A new project gets the default link types, stored as data (SRS-015, SRS-019)');
reset role;

-- Sam authors items and links -------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select create_item(pg_temp.tracker('SRS'), 'Sign-in required', '{"requirement": "Users sign in.", "verification": "Test (automated)"}');
select create_item(pg_temp.tracker('SRS'), 'Project list', '{"requirement": "Members see their projects.", "verification": "Test (automated)"}');
select create_item(pg_temp.tracker('SRS'), 'Audit trail', '{"requirement": "Every change is audited.", "verification": "Test (automated)"}');
select create_item(pg_temp.tracker('RISK'), 'Unauthorised access',
  '{"failure_mode": "A non-member reads records.", "severity": "High", "likelihood": "Medium"}');

select create_item(pg_temp.tracker('TC'), 'Sign-in test',
  '{"execution_type": "Automated", "steps": [{"action": "Open the app signed out", "expected": "The sign-in page is shown"}]}',
  null, '[{"type": "verifies", "target": "srs-001"}]');
select results_eq(
  $$ select version, links from item_versions where item_id = pg_temp.item('TC-001') $$,
  $$ values (1, '[{"type": "verifies", "target": "SRS-001"}]'::jsonb) $$,
  'Links given when an item is created are part of version 1 (SRS-019, SRS-020)');

select throws_ok(
  $$ select create_item(pg_temp.tracker('TC'), 'Bad target',
       '{"execution_type": "Manual", "steps": [{"action": "a", "expected": "b"}]}', null,
       '[{"type": "verifies", "target": "SRS-999"}]') $$,
  '22023', 'No item SRS-999 in this project',
  'A link to an item that does not exist is refused');

select throws_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'verifies', 'RISK-001') $$,
  '22023', '"verifies" links must point to SRS items, not RISK-001',
  'A link must point to the tracker its type names (SRS-019)');

select throws_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'mitigated_by', 'SRS-002') $$,
  '22023', 'TC items cannot have "is mitigated by" links',
  'A link must start from the tracker its type names (SRS-019)');

select throws_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'covers', 'SRS-002') $$,
  '22023', 'Unknown link type "covers"',
  'Only configured link types can be used (SRS-015)');

select add_item_link(pg_temp.item('TC-001'), 'verifies', 'SRS-002');
select is((select version from items where id = pg_temp.item('TC-001')), 2,
  'Adding a link creates a new version of the item it starts from (SRS-019, SRS-020)');

select is(
  (select links from item_versions where item_id = pg_temp.item('TC-001') and version = 2),
  '[{"type": "verifies", "target": "SRS-001"}, {"type": "verifies", "target": "SRS-002"}]'::jsonb,
  'The new version keeps a snapshot of the item''s links (SRS-020)');

select throws_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'verifies', 'SRS-002') $$,
  '23505', 'TC-001 already verifies SRS-002',
  'The same link cannot be added twice');

select throws_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'verifies', 'SRS-001') $$,
  '23505', null,
  'A link given at creation also counts as existing');

select lives_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'SRS-002') $$,
  'A RISK item can be linked to the requirement that mitigates it');

select results_eq(
  $$ select direction, label, other_item_key from item_link_list(pg_temp.item('SRS-002')) order by other_item_key $$,
  $$ values ('in', 'mitigates', 'RISK-001'), ('in', 'verified by', 'TC-001') $$,
  'The target item shows each link, phrased from its side (SRS-019)');

select results_eq(
  $$ select direction, label, other_item_key, other_title from item_link_list(pg_temp.item('TC-001')) $$,
  $$ values ('out', 'verifies', 'SRS-001', 'Sign-in required'), ('out', 'verifies', 'SRS-002', 'Project list') $$,
  'The source item shows each link too (SRS-019)');

-- A locked target is fine: the link changes the source, not the target.
select transition_item(pg_temp.item('SRS-003'), pg_temp.state('SRS', 'In Progress'));
select transition_item(pg_temp.item('SRS-003'), pg_temp.state('SRS', 'In Review'));
select lives_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'verifies', 'SRS-003') $$,
  'An item can link to a locked item; the locked item does not change');
select is((select version from items where id = pg_temp.item('SRS-003')), 1,
  'Linking to an item does not create a version of the target');

select throws_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'verifies', 'SRS-001'::text || '; drop table items') $$,
  '22023', null,
  'Link targets are looked up by ID, never interpreted');

-- Review the TC, then try to change its links -----------------------------------------
select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'In Progress'));
select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'In Review'));
select throws_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'verifies', 'SRS-002') $$,
  '42501', null,
  'Links cannot change while the item waits for review (SRS-019, SRS-025)');
reset role;

select set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select sign_item(pg_temp.item('TC-001'), 'quinn-pw');
select throws_ok(
  $$ select remove_item_link((select id from item_links where source_item_id = pg_temp.item('TC-001') limit 1)) $$,
  '42501', null,
  'QA cannot change links: it needs permission to edit items (SRS-007)');
reset role;

select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'Approved'));
select throws_ok(
  $$ select remove_item_link((select l.id from item_links l where l.source_item_id = pg_temp.item('TC-001')
                                and l.target_item_id = pg_temp.item('SRS-002'))) $$,
  '42501', null,
  'An approved item''s links cannot change (SRS-019, SRS-025)');

select transition_item(pg_temp.item('TC-001'), pg_temp.state('TC', 'In Progress'), 'SRS-002 is verified elsewhere');
select throws_ok(
  $$ select remove_item_link((select l.id from item_links l where l.source_item_id = pg_temp.item('TC-001')
                                and l.target_item_id = pg_temp.item('SRS-002'))) $$,
  '23502', null,
  'Once reviewed, a link change needs a reason (SRS-029)');

select lives_ok(
  $$ select remove_item_link((select l.id from item_links l where l.source_item_id = pg_temp.item('TC-001')
                                and l.target_item_id = pg_temp.item('SRS-002')), 'Covered by its own test case') $$,
  'With a reason, the link is removed');

select results_eq(
  $$ select v.version, v.links from items i join item_versions v on v.item_id = i.id and v.version = i.version
     where i.id = pg_temp.item('TC-001') $$,
  $$ values (4, '[{"type": "verifies", "target": "SRS-001"}, {"type": "verifies", "target": "SRS-003"}]'::jsonb) $$,
  'Removing a link creates a new version without it (SRS-020)');

select is(
  (select links from item_versions where item_id = pg_temp.item('TC-001') and version = 3),
  '[{"type": "verifies", "target": "SRS-001"}, {"type": "verifies", "target": "SRS-002"}, {"type": "verifies", "target": "SRS-003"}]'::jsonb,
  'The version that was approved still shows the links it was approved with (SRS-020, SRS-026)');

select throws_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'verifies', 'SRS-001', 'Re-adding') $$,
  '23505', null,
  'A link that exists cannot be added again after other changes');

select throws_ok(
  $$ insert into item_links (project_id, link_type_id, source_item_id, target_item_id, created_by)
     select project_id, (select id from link_types where key = 'verifies' and project_id = current_setting('test.project_id')::uuid),
            pg_temp.item('TC-001'), pg_temp.item('SRS-002'), 'b2222222-2222-4222-8222-222222222222'
     from items where id = pg_temp.item('TC-001') $$,
  '42501', null,
  'Links cannot be written by direct requests, only through the link functions (SRS-006)');
reset role;

-- Database rules hold for everyone, including the database owner -------------------
select throws_ok(
  $$ insert into item_links (project_id, link_type_id, source_item_id, target_item_id, created_by)
     values (current_setting('test.project_id')::uuid,
             (select id from link_types where key = 'verifies' and project_id = current_setting('test.project_id')::uuid),
             pg_temp.item('TC-001'),
             (select id from items where project_id = current_setting('test.other_project')::uuid),
             'b2222222-2222-4222-8222-222222222222') $$,
  '23503', null,
  'A link can never point into another project, even when written directly (SRS-004)');

select throws_ok(
  $$ update item_links set created_at = now() where source_item_id = pg_temp.item('TC-001') $$,
  '42501', null,
  'Links are never edited in place');

select is(
  (select reason from audit_log where table_name = 'item_links' and action = 'DELETE'
     and project_id = current_setting('test.project_id')::uuid),
  'Link removed: verifies SRS-002: Covered by its own test case',
  'Removing a link is audited with what was removed and why (SRS-028, SRS-029)');

select is(
  (select count(*)::int from audit_log where table_name = 'items' and action = 'UPDATE'
     and record_id = pg_temp.item('TC-001')::text and reason like 'Link added: verifies SRS-002%'),
  1,
  'The item''s own history shows the link change (SRS-032)');

-- Visibility -------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'SRS-001') $$,
  '42501', null,
  'A Viewer cannot add links (SRS-007)');
select is((select count(*)::int from item_links), 3, 'A Viewer can see the project''s links');
reset role;

select set_config('request.jwt.claims', '{"sub": "e5555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from item_links) + (select count(*)::int from link_types), 0,
  'A non-member cannot see links or link types (SRS-004)');
reset role;

select * from finish();
rollback;
