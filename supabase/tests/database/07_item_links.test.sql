-- Links between items (SRS-019): link types as data, both ends checked, links owned
-- by a version of their source item, locking, reasons, visibility and the audit trail.
-- RISK "is mitigated by" SRS is used for the general rules; a paired test case's
-- "verifies" link to its own requirement is fixed.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(29);

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
create function pg_temp.rev(p_key text, p_version int) returns uuid language sql as $$
  select r.id from public.item_revisions r where r.item_id = pg_temp.item(p_key) and r.revision = p_version
$$;
create function pg_temp.links(p_key text, p_version int) returns text language sql as $$
  select string_agg(lt.key || ' ' || t.item_key, ', ' order by t.item_key)
  from public.item_links l join public.link_types lt on lt.id = l.link_type_id join public.items t on t.id = l.target_item_id
  where l.source_revision_id = pg_temp.rev(p_key, p_version)
$$;
create function pg_temp.state(p_tracker text, p_name text) returns uuid language sql as $$
  select s.id from public.tracker_states s where s.tracker_id = pg_temp.tracker(p_tracker) and s.name = p_name
$$;
create function pg_temp.srs(p_title text) returns void language sql as $$
  select null from public.create_item(pg_temp.tracker('SRS'), p_title,
    '{"verification": "Test (automated)", "ers": [{"n": 1, "text": "Something testable"}]}')
$$;
create function pg_temp.risk(p_title text, p_links jsonb default '[]') returns void language sql as $$
  select null from public.create_item(pg_temp.tracker('RISK'), p_title,
    '{"failure_mode": "Something fails", "severity": "High", "likelihood": "Medium"}', null, p_links)
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
                   'Elsewhere', '{"verification": "Inspection", "ers": [{"n": 1, "text": "x"}]}');

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

select pg_temp.srs('Sign-in required');
select pg_temp.srs('Project list');
select pg_temp.srs('Audit trail');

select pg_temp.risk('Unauthorised access', '[{"type": "mitigated_by", "target": "srs-001"}]');
select is(pg_temp.links('RISK-001', 1), 'mitigated_by SRS-001',
  'Links given when an item is created belong to version 1 (SRS-019, SRS-020)');

select throws_ok(
  $$ select pg_temp.risk('Bad target', '[{"type": "mitigated_by", "target": "SRS-999"}]') $$,
  '22023', 'No item SRS-999 in this project',
  'A link to an item that does not exist is refused');

select throws_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'TC-001') $$,
  '22023', '"is mitigated by" links must point to SRS items, not TC-001',
  'A link must point to the tracker its type names (SRS-019)');

select throws_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'verifies', 'SRS-002') $$,
  '22023', 'RISK items cannot have "verifies" links',
  'A link must start from the tracker its type names (SRS-019)');

select throws_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'covers', 'SRS-002') $$,
  '22023', 'Unknown link type "covers"',
  'Only configured link types can be used (SRS-015)');

select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'SRS-002');
select results_eq(
  $$ select revision, content_version from item_heads where id = pg_temp.item('RISK-001') $$,
  $$ values (1, 2) $$,
  'Adding a link is an edit of the open version (SRS-019, SRS-020)');

select throws_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'SRS-002') $$,
  '23505', 'RISK-001 already is mitigated by SRS-002',
  'The same link cannot be added twice');

select results_eq(
  $$ select direction, label, other_item_key from item_link_list(pg_temp.item('SRS-002')) order by other_item_key $$,
  $$ values ('in', 'mitigates', 'RISK-001'), ('in', 'verified by', 'TC-002') $$,
  'The target item shows each link, phrased from its side (SRS-019)');

select results_eq(
  $$ select direction, label, other_item_key, other_title from item_link_list(pg_temp.item('RISK-001')) $$,
  $$ values ('out', 'is mitigated by', 'SRS-001', 'Sign-in required'), ('out', 'is mitigated by', 'SRS-002', 'Project list') $$,
  'The source item shows each link too (SRS-019)');

-- Paired test cases ------------------------------------------------------------------
select is(pg_temp.links('TC-001', 1), 'verifies SRS-001', 'A requirement''s test case verifies it from the start');

select throws_ok(
  $$ select add_item_link(pg_temp.item('TC-001'), 'verifies', 'SRS-002') $$,
  '42501', 'TC-001 verifies only its own requirement',
  'A paired test case verifies only its own requirement');

select throws_ok(
  $$ select remove_item_link((select id from item_links where source_revision_id = pg_temp.rev('TC-001', 1))) $$,
  '42501', null,
  'The link between a test case and its requirement cannot be removed');

-- A locked target is fine: the link changes the source, not the target.
select transition_item(pg_temp.item('SRS-003'), pg_temp.state('SRS', 'In Progress'));
select transition_item(pg_temp.item('SRS-003'), pg_temp.state('SRS', 'Ready for Review'));
select lives_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'SRS-003') $$,
  'An item can link to a locked item; the locked item does not change');
select results_eq(
  $$ select revision, content_version from item_heads where id = pg_temp.item('SRS-003') $$,
  $$ values (1, 1) $$,
  'Linking to an item does not change the target');

-- Review and approve the risk, then try to change its links --------------------------
select transition_item(pg_temp.item('RISK-001'), pg_temp.state('RISK', 'In Progress'));
select transition_item(pg_temp.item('RISK-001'), pg_temp.state('RISK', 'In Review'));
select throws_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'SRS-002') $$,
  '42501', null,
  'Links cannot change while the item waits for review (SRS-019, SRS-025)');
reset role;

select set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select sign_item(pg_temp.item('RISK-001'), 'quinn-pw');
reset role;

select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select transition_item(pg_temp.item('RISK-001'), pg_temp.state('RISK', 'Approved'));
select throws_ok(
  $$ select remove_item_link((select l.id from item_links l where l.source_revision_id = pg_temp.rev('RISK-001', 1)
                                and l.target_item_id = pg_temp.item('SRS-002'))) $$,
  '42501', null,
  'An approved version''s links cannot change (SRS-019, SRS-025)');

select start_revision(pg_temp.item('RISK-001'), 'SRS-002 no longer mitigates this');
select is(pg_temp.links('RISK-001', 2), 'mitigated_by SRS-001, mitigated_by SRS-002, mitigated_by SRS-003',
  'A new version starts with the links of the approved version');

select remove_item_link((select l.id from item_links l where l.source_revision_id = pg_temp.rev('RISK-001', 2)
                           and l.target_item_id = pg_temp.item('SRS-002')));
select results_eq(
  $$ select pg_temp.links('RISK-001', 1), pg_temp.links('RISK-001', 2) $$,
  $$ values ('mitigated_by SRS-001, mitigated_by SRS-002, mitigated_by SRS-003', 'mitigated_by SRS-001, mitigated_by SRS-003') $$,
  'The approved version keeps the links it was approved with (SRS-020, SRS-026)');

select throws_ok(
  $$ select remove_item_link((select l.id from item_links l where l.source_revision_id = pg_temp.rev('RISK-001', 1)
                                and l.target_item_id = pg_temp.item('SRS-001'))) $$,
  '42501', 'That link belongs to an earlier version and cannot change',
  'Links of an earlier version cannot be removed through the new one');

-- Once version 2 has been reviewed, link changes need a reason
select transition_item(pg_temp.item('RISK-001'), pg_temp.state('RISK', 'In Progress'));
select transition_item(pg_temp.item('RISK-001'), pg_temp.state('RISK', 'In Review'));
reset role;
select set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;
select sign_item(pg_temp.item('RISK-001'), 'quinn-pw');
reset role;
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
select transition_item(pg_temp.item('RISK-001'), pg_temp.state('RISK', 'In Progress'), 'Rework');

select throws_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'SRS-002') $$,
  '23502', null,
  'Once a version has been reviewed, a link change needs a reason (SRS-029)');

select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'SRS-002', 'Still needed after all');

select throws_ok(
  $$ insert into item_links (project_id, link_type_id, source_revision_id, target_item_id, created_by)
     values (current_setting('test.project_id')::uuid,
             (select id from link_types where key = 'mitigated_by' and project_id = current_setting('test.project_id')::uuid),
             pg_temp.rev('RISK-001', 2), pg_temp.item('SRS-001'), 'b2222222-2222-4222-8222-222222222222') $$,
  '42501', null,
  'Links cannot be written by direct requests, only through the link functions (SRS-006)');
reset role;

-- Database rules hold for everyone, including the database owner -------------------
select throws_ok(
  $$ insert into item_links (project_id, link_type_id, source_revision_id, target_item_id, created_by)
     values (current_setting('test.project_id')::uuid,
             (select id from link_types where key = 'mitigated_by' and project_id = current_setting('test.project_id')::uuid),
             pg_temp.rev('RISK-001', 2),
             (select id from items where project_id = current_setting('test.other_project')::uuid and item_key = 'SRS-001'),
             'b2222222-2222-4222-8222-222222222222') $$,
  '23503', null,
  'A link can never point into another project, even when written directly (SRS-004)');

select throws_ok(
  $$ delete from item_links where source_revision_id = pg_temp.rev('RISK-001', 1) $$,
  '42501', null,
  'An approved version''s links cannot be removed, even by the database owner (SRS-025)');

select throws_ok(
  $$ update item_links set created_at = now() where source_revision_id = pg_temp.rev('RISK-001', 2) $$,
  '42501', null,
  'Links are never edited in place');

select is(
  (select reason from audit_log where table_name = 'item_revisions' and action = 'UPDATE'
     and record_id = pg_temp.rev('RISK-001', 2)::text and reason like 'Link added:%'),
  'Link added: is mitigated by SRS-002: Still needed after all',
  'The version''s own history shows the link change and its reason (SRS-029, SRS-032)');

-- Visibility -------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select add_item_link(pg_temp.item('RISK-001'), 'mitigated_by', 'SRS-001') $$,
  '42501', null,
  'A Viewer cannot add links (SRS-007)');
select ok((select count(*) from item_links) > 0, 'A Viewer can see the project''s links');
reset role;

select set_config('request.jwt.claims', '{"sub": "e5555555-5555-4555-8555-555555555555", "role": "authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from item_links) + (select count(*)::int from link_types), 0,
  'A non-member cannot see links or link types (SRS-004)');
reset role;

select * from finish();
rollback;
