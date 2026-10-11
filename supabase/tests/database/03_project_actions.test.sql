-- Project page actions: members by email, edits and archiving with reasons.
-- Each test name ends with the SRS item it verifies. Run with: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}'),
  ('b2222222-2222-4222-8222-222222222222', 'Bob@Test.Local',   '{"full_name": "Bob Viewer"}'),
  ('c3333333-3333-4333-8333-333333333333', 'carol@test.local', '{"full_name": "Carol Outsider"}');

-- Alice creates a project
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.project_id', (select (create_project('Actions Test')).id::text), true);

select is(
  (select array_agg(p order by p) from my_project_permissions(current_setting('test.project_id')::uuid) p),
  (select array_agg(key order by key) from permissions),
  'An Admin''s own permission list includes every permission (SRS-005)');

select lives_ok(
  $$ select add_project_member(current_setting('test.project_id')::uuid, '  bob@test.local ', 'viewer', 'Needs read access for review') $$,
  'An Admin can add a member by email, ignoring case and spaces (SRS-012)');

select throws_ok(
  $$ select add_project_member(current_setting('test.project_id')::uuid, 'nobody@test.local', 'viewer') $$,
  'P0002', null,
  'Adding an email with no account is refused (SRS-002, SRS-012)');

select throws_ok(
  $$ select add_project_member(current_setting('test.project_id')::uuid, 'bob@test.local', 'qa') $$,
  '23505', null,
  'A user cannot be added to the same project twice (SRS-012)');

select results_eq(
  $$ select full_name, email, role::text, added_by_name
     from project_member_list(current_setting('test.project_id')::uuid) order by full_name $$,
  $$ values ('Alice Admin', 'alice@test.local', 'admin', 'Alice Admin'),
            ('Bob Viewer', 'Bob@Test.Local', 'viewer', 'Alice Admin') $$,
  'Members are listed with name, email, role and who added them (SRS-012)');

select lives_ok(
  $$ select update_project(current_setting('test.project_id')::uuid, 'Actions Test v2', 'Sigil v1.0',
                           '2026-11-01', '2026-12-01', 'Scope agreed') $$,
  'An Admin can edit the project with a reason (SRS-029)');

reset role;

select results_eq(
  $$ select changed_fields, reason from audit_log
     where table_name = 'projects' and action = 'UPDATE'
       and record_id = current_setting('test.project_id') $$,
  $$ values (array['name', 'planned_end', 'planned_start', 'system_under_validation'], 'Scope agreed') $$,
  'The edit and its reason are recorded in the audit trail (SRS-028, SRS-029)');

select is(
  (select reason from audit_log
    where table_name = 'project_members' and action = 'INSERT'
      and record_id = current_setting('test.project_id') || ':b2222222-2222-4222-8222-222222222222'),
  'Needs read access for review',
  'The reason for adding a member is recorded (SRS-012, SRS-029)');

-- Bob (Viewer) tries the same actions
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select is(
  (select count(*)::int from my_project_permissions(current_setting('test.project_id')::uuid)),
  0,
  'A Viewer has no permissions (SRS-007)');

select throws_ok(
  $$ select add_project_member(current_setting('test.project_id')::uuid, 'carol@test.local', 'admin') $$,
  '42501', null,
  'A Viewer cannot add members (SRS-007, SRS-012)');

select throws_ok(
  $$ select update_project(current_setting('test.project_id')::uuid, 'Viewer edit', null, null, null) $$,
  '42501', null,
  'A Viewer cannot edit the project (SRS-007)');

select throws_ok(
  $$ select set_project_archived(current_setting('test.project_id')::uuid, true, 'No') $$,
  '42501', null,
  'A Viewer cannot archive the project (SRS-011)');

reset role;

-- Carol (not a member) cannot see the member list
select set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

select is(
  (select count(*)::int from project_member_list(current_setting('test.project_id')::uuid)),
  0,
  'A non-member cannot list members or their emails (SRS-004)');

reset role;

-- Alice archives, changes a role, removes a member
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$ select update_member_role(current_setting('test.project_id')::uuid,
                               'b2222222-2222-4222-8222-222222222222', 'qa', 'Now doing QA review') $$,
  'An Admin can change a member''s role with a reason (SRS-012)');

select is(
  (select status from set_project_archived(current_setting('test.project_id')::uuid, true, 'Validation complete')),
  'archived',
  'An Admin can archive the project with a reason (SRS-011)');

select throws_ok(
  $$ select remove_project_member(current_setting('test.project_id')::uuid,
                                  'b2222222-2222-4222-8222-222222222222', 'Left team') $$,
  '42501', null,
  'Members cannot be removed while the project is archived (SRS-011)');

select is(
  (select status from set_project_archived(current_setting('test.project_id')::uuid, false, 'Re-opened for a fix')),
  'active',
  'An Admin can de-archive the project, which returns it to Active (SRS-011)');

reset role;

select * from finish();
rollback;
