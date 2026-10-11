-- Audit trail tests: every change recorded, nobody can alter or delete entries.
-- Each test name ends with the SRS item it verifies. Run with: npx supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}'),
  ('b2222222-2222-4222-8222-222222222222', 'bob@test.local',   '{"full_name": "Bob Viewer"}'),
  ('c3333333-3333-4333-8333-333333333333', 'carol@test.local', '{"full_name": "Carol Outsider"}');

select col_type_is('public', 'audit_log', 'occurred_at', 'timestamp with time zone',
  'Audit timestamps are stored with time zone (UTC) (SRS-033)');

-- Alice creates a project and adds Bob -------------------------------------------
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select create_project('Audit Test', 'Sigil v1.0');
insert into project_members (project_id, user_id, role, added_by)
select id, 'b2222222-2222-4222-8222-222222222222', 'viewer', 'a1111111-1111-4111-8111-111111111111'
from projects where name = 'Audit Test';
reset role;

select set_config('test.project_id', (select id::text from projects where name = 'Audit Test'), true);

select results_eq(
  $$ select action, changed_by::text, new_values ->> 'name'
     from audit_log where table_name = 'projects' and record_id = current_setting('test.project_id') $$,
  $$ values ('INSERT', 'a1111111-1111-4111-8111-111111111111', 'Audit Test') $$,
  'Creating a project is recorded with the user and the new values (SRS-028)');

select is(
  (select count(*)::int from audit_log
    where table_name = 'project_members' and action = 'INSERT'
      and record_id = current_setting('test.project_id') || ':b2222222-2222-4222-8222-222222222222'),
  1,
  'Adding a member is recorded in the audit trail (SRS-012, SRS-028)');

-- Alice renames the project, giving a reason
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('sigil.change_reason', 'Name agreed with QA', true);
update projects set name = 'Audit Test Renamed' where id = current_setting('test.project_id')::uuid;
select set_config('sigil.change_reason', '', true);
reset role;

select results_eq(
  $$ select changed_fields, old_values ->> 'name', new_values ->> 'name', reason
     from audit_log where table_name = 'projects' and action = 'UPDATE'
       and record_id = current_setting('test.project_id') $$,
  $$ values (array['name'], 'Audit Test', 'Audit Test Renamed', 'Name agreed with QA') $$,
  'An update records only the changed field, its old and new value, and the reason (SRS-028, SRS-029)');

-- An update that changes nothing is not recorded
select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
update projects set name = 'Audit Test Renamed' where id = current_setting('test.project_id')::uuid;
reset role;

select is(
  (select count(*)::int from audit_log where table_name = 'projects' and action = 'UPDATE'
     and record_id = current_setting('test.project_id')),
  1,
  'An update that changes nothing adds no audit entry (SRS-028)');

-- Profile changes are audited too
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;
update profiles set full_name = 'Robert Viewer' where id = 'b2222222-2222-4222-8222-222222222222';
reset role;

select results_eq(
  $$ select old_values ->> 'full_name', new_values ->> 'full_name', changed_by::text
     from audit_log where table_name = 'profiles' and action = 'UPDATE'
       and record_id = 'b2222222-2222-4222-8222-222222222222' $$,
  $$ values ('Bob Viewer', 'Robert Viewer', 'b2222222-2222-4222-8222-222222222222') $$,
  'Changing a printed name is recorded in the audit trail (SRS-028)');

-- Who can read the audit trail ---------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select cmp_ok(
  (select count(*)::int from audit_log where project_id = current_setting('test.project_id')::uuid),
  '>', 0,
  'Project members can read their project''s audit trail (SRS-032)');

-- Bob tries to tamper with the audit trail
select throws_ok(
  $$ update audit_log set reason = 'edited' $$,
  '42501', null,
  'A user cannot modify audit entries (SRS-030)');

select throws_ok(
  $$ delete from audit_log $$,
  '42501', null,
  'A user cannot delete audit entries (SRS-030)');

select throws_ok(
  $$ insert into audit_log (table_name, record_id, action) values ('projects', 'fake', 'INSERT') $$,
  '42501', null,
  'A user cannot write audit entries directly (SRS-031)');

reset role;

select set_config('request.jwt.claims', '{"sub": "c3333333-3333-4333-8333-333333333333", "role": "authenticated"}', true);
set local role authenticated;

select is(
  (select count(*)::int from audit_log where project_id = current_setting('test.project_id')::uuid),
  0,
  'A non-member cannot read the project''s audit trail (SRS-004)');

reset role;

-- Privileged roles cannot tamper either -------------------------------------------
set local role service_role;

select throws_ok(
  $$ update audit_log set reason = 'edited by service role' $$,
  '42501', null,
  'The service role cannot modify audit entries (SRS-030)');

select throws_ok(
  $$ delete from audit_log $$,
  '42501', null,
  'The service role cannot delete audit entries (SRS-030)');

reset role;

-- The database owner (used for migrations and admin access)
select throws_ok(
  $$ update audit_log set reason = 'edited by owner' $$,
  '42501', 'Audit entries cannot be modified or deleted',
  'Even the database owner cannot modify audit entries (SRS-030)');

select throws_ok(
  $$ delete from audit_log $$,
  '42501', 'Audit entries cannot be modified or deleted',
  'Even the database owner cannot delete audit entries (SRS-030)');

select throws_ok(
  $$ truncate audit_log $$,
  '42501', 'Audit entries cannot be modified or deleted',
  'Even the database owner cannot truncate the audit trail (SRS-030)');

-- Changes made outside the app are still captured (no user = system change)
select set_config('request.jwt.claims', '', true);  -- no signed-in user
update projects set system_under_validation = 'Changed by a direct database session'
 where id = current_setting('test.project_id')::uuid;

select results_eq(
  $$ select changed_by is null, new_values ->> 'system_under_validation'
     from audit_log where table_name = 'projects' and action = 'UPDATE'
       and record_id = current_setting('test.project_id')
       and changed_fields = array['system_under_validation'] $$,
  $$ values (true, 'Changed by a direct database session') $$,
  'Changes made directly in the database are captured too (SRS-031)');

select * from finish();
rollback;
