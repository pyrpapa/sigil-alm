-- Access control tests: membership, roles, permissions and archiving.
-- Each test name ends with the SRS item it verifies. Run with: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(31);

-- Test users ----------------------------------------------------------------
-- alice: creates the project (Admin)   bob: Viewer   dave: Specialist
-- carol: not a member                  (passwords not needed at database level)
insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}'),
  ('b2222222-2222-4222-8222-222222222222', 'bob@test.local',   '{"full_name": "Bob Viewer"}'),
  ('c3333333-3333-4333-8333-333333333333', 'carol@test.local', '{"full_name": "Carol Outsider"}'),
  ('d4444444-4444-4444-8444-444444444444', 'dave@test.local',  '{"full_name": "Dave Specialist"}');

select is(
  (select full_name from profiles where id = 'a1111111-1111-4111-8111-111111111111'),
  'Alice Admin',
  'A profile with printed name is created for every new user (SRS-002)');

-- Alice creates a project ------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$ select create_project('Access Test', 'Sigil v1.0', '2026-11-01', '2026-12-15') $$,
  'A signed-in user can create a project with planned dates (SRS-009)');

select throws_ok(
  $$ insert into projects (name) values ('Direct insert') $$,
  '42501', null,
  'Projects cannot be inserted directly, only through create_project (SRS-009)');

select throws_ok(
  $$ select create_project('Bad dates', null, '2026-12-01', '2026-11-01') $$,
  '23514', null,
  'Planned end date cannot be before the start date (SRS-009)');

reset role;

select is(
  (select m.role::text from project_members m join projects p on p.id = m.project_id
    where p.name = 'Access Test' and m.user_id = 'a1111111-1111-4111-8111-111111111111'),
  'admin',
  'The creator becomes the project Admin (SRS-003)');

select is(
  (select count(*)::int from role_permissions rp join projects p on p.id = rp.project_id
    where p.name = 'Access Test'),
  (select count(*)::int from default_role_permissions),
  'Default role permissions are copied into the new project (SRS-005)');

-- Alice adds Bob (Viewer) and Dave (Specialist)
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$ insert into project_members (project_id, user_id, role, added_by)
     select id, 'b2222222-2222-4222-8222-222222222222', 'viewer', 'a1111111-1111-4111-8111-111111111111'
     from projects where name = 'Access Test' $$,
  'A project Admin can add members (SRS-012)');

select lives_ok(
  $$ insert into project_members (project_id, user_id, role, added_by)
     select id, 'd4444444-4444-4444-8444-444444444444', 'specialist', 'a1111111-1111-4111-8111-111111111111'
     from projects where name = 'Access Test' $$,
  'A project Admin can add members with any role (SRS-003, SRS-012)');

reset role;

-- Carol: not a member ---------------------------------------------------------
-- Remember the project id (as the test owner) so Carol can target it directly.
select set_config('test.project_id', (select id::text from projects where name = 'Access Test'), true);
select set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

select is((select count(*)::int from projects), 0,
  'A non-member cannot see the project (SRS-004)');

select is((select count(*)::int from project_members), 0,
  'A non-member cannot see the project''s members (SRS-004)');

select results_eq(
  $$ with u as (update projects set name = 'Hacked' where id = current_setting('test.project_id')::uuid returning 1) select count(*)::int from u $$,
  $$ values (0) $$,
  'A non-member cannot change the project, even with a direct API request (SRS-004, SRS-006)');

select throws_ok(
  $$ insert into project_members (project_id, user_id, role)
     values (current_setting('test.project_id')::uuid, 'c3333333-3333-4333-8333-333333333333', 'admin') $$,
  '42501', null,
  'A non-member cannot add themselves to a project (SRS-004)');

reset role;

-- Bob: Viewer ---------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select is((select count(*)::int from projects where name = 'Access Test'), 1,
  'A member can see the project (SRS-004)');

select throws_ok(
  $$ update projects set name = 'Renamed by viewer' where name = 'Access Test' $$,
  '42501', null,
  'A Viewer cannot edit the project (SRS-007)');

select throws_ok(
  $$ insert into project_members (project_id, user_id, role)
     select id, 'c3333333-3333-4333-8333-333333333333', 'viewer' from projects where name = 'Access Test' $$,
  '42501', null,
  'A Viewer cannot add members (SRS-007)');

select results_eq(
  $$ with d as (delete from projects where name = 'Access Test' returning 1) select count(*)::int from d $$,
  $$ values (0) $$,
  'Projects cannot be deleted (SRS-011)');

select throws_ok(
  $$ update profiles set is_system_admin = true where id = 'b2222222-2222-4222-8222-222222222222' $$,
  '42501', null,
  'A user cannot make themselves a System Admin (SRS-002)');

select lives_ok(
  $$ update profiles set full_name = 'Robert Viewer' where id = 'b2222222-2222-4222-8222-222222222222' $$,
  'A user can change their own printed name');

select results_eq(
  $$ with u as (update profiles set full_name = 'Not Alice' where id = 'a1111111-1111-4111-8111-111111111111' returning 1) select count(*)::int from u $$,
  $$ values (0) $$,
  'A user cannot change someone else''s name');

reset role;

-- Dave: Specialist ----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ update projects set status = 'archived' where name = 'Access Test' $$,
  '42501', null,
  'Only project Admins can archive a project (SRS-011)');

reset role;

-- Archiving (Alice) -----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ update projects set status = 'archived', name = 'Archive and rename' where name = 'Access Test' $$,
  '42501', null,
  'Archiving cannot be combined with other changes (SRS-011)');

select lives_ok(
  $$ update projects set status = 'archived' where name = 'Access Test' $$,
  'A project Admin can archive a project (SRS-011)');

select throws_ok(
  $$ update projects set name = 'Edited while archived' where name = 'Access Test' $$,
  '42501', null,
  'An archived project is read-only (SRS-011)');

select throws_ok(
  $$ insert into project_members (project_id, user_id, role)
     select id, 'c3333333-3333-4333-8333-333333333333', 'viewer' from projects where name = 'Access Test' $$,
  '42501', null,
  'Members cannot be added to an archived project (SRS-011)');

select lives_ok(
  $$ update projects set status = 'active' where name = 'Access Test' $$,
  'A project Admin can de-archive a project (SRS-011)');

select lives_ok(
  $$ update projects set name = 'Access Test' , system_under_validation = 'Sigil v1.1' where name = 'Access Test' $$,
  'A de-archived project can be edited again (SRS-011)');

-- Last Admin protection
select throws_ok(
  $$ update project_members set role = 'viewer'
     where user_id = 'a1111111-1111-4111-8111-111111111111' $$,
  '42501', null,
  'The last Admin cannot be demoted (SRS-012)');

select throws_ok(
  $$ delete from project_members where user_id = 'a1111111-1111-4111-8111-111111111111' $$,
  '42501', null,
  'The last Admin cannot be removed (SRS-012)');

select lives_ok(
  $$ delete from project_members where user_id = 'b2222222-2222-4222-8222-222222222222' $$,
  'A project Admin can remove a member (SRS-012)');

reset role;

select is(
  (select count(*)::int from project_members m join projects p on p.id = m.project_id
    where p.name = 'Access Test' and m.user_id = 'b2222222-2222-4222-8222-222222222222'),
  0,
  'The removed member is no longer in the project (SRS-012)');

-- Anonymous (not signed in) -----------------------------------------------------
set local role anon;

select is((select count(*)::int from projects), 0,
  'Visitors who are not signed in see no projects (SRS-001)');

reset role;

select * from finish();
rollback;
