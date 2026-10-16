-- User accounts (SRS-002): only System Admins create accounts and reset passwords;
-- users change their own password; every change is audited; never zero System Admins.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

insert into auth.users (id, email, raw_user_meta_data, encrypted_password) values
  ('a1111111-1111-4111-8111-111111111111', 'admin@test.local', '{"full_name": "Ada Admin"}', extensions.crypt('admin-pass-1', extensions.gen_salt('bf'))),
  ('b2222222-2222-4222-8222-222222222222', 'bob@test.local',   '{"full_name": "Bob User"}', extensions.crypt('bob-pass-123', extensions.gen_salt('bf')));
update profiles set is_system_admin = (id = 'a1111111-1111-4111-8111-111111111111');

create function pg_temp.as_user(p_id text) returns void language sql as $$
  select null::void from (select set_config('request.jwt.claims', '{"sub": "' || p_id || '", "role": "authenticated"}', true)) x
$$;

set local role authenticated;

-- Not a System Admin ---------------------------------------------------------------
select pg_temp.as_user('b2222222-2222-4222-8222-222222222222');
select throws_ok($$ select admin_create_user('eve@test.local', 'Eve', 'eve-password-1') $$, '42501', null,
  'Users who are not System Admins cannot create accounts (SRS-002)');
select throws_ok($$ select * from admin_list_users() $$, '42501', null, 'or list accounts');
select throws_ok($$ select admin_set_system_admin('b2222222-2222-4222-8222-222222222222', true) $$, '42501', null,
  'or make themselves System Admin');
select throws_ok($$ update profiles set is_system_admin = true where id = 'b2222222-2222-4222-8222-222222222222' $$, '42501', null,
  'or set the System Admin flag directly');

-- System Admin ------------------------------------------------------------------------
select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
select throws_ok($$ select admin_create_user('eve@test.local', 'Eve', 'short') $$, '22023', 'Passwords need at least 10 characters',
  'Starting passwords need at least 10 characters');
select throws_ok($$ select admin_create_user('eve@test.local', '  ', 'eve-password-1') $$, '23502', null,
  'A printed name is required');
select set_config('test.eve', admin_create_user(' Eve@Test.local ', 'Eve Example', 'eve-password-1')::text, true);
select results_eq(
  $$ select email, full_name, is_system_admin from admin_list_users() where id = current_setting('test.eve')::uuid $$,
  $$ values ('eve@test.local', 'Eve Example', false) $$,
  'A System Admin creates an account with an email, printed name and password');
select throws_ok($$ select admin_create_user('EVE@test.local', 'Eve Again', 'eve-password-1') $$, '23505', null,
  'An email can only have one account');
reset role;
select ok(
  (select encrypted_password = extensions.crypt('eve-password-1', encrypted_password) from auth.users
   where id = current_setting('test.eve')::uuid),
  'The new person can sign in with the password they were given');
set local role authenticated;

select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
select admin_set_password(current_setting('test.eve')::uuid, 'eve-new-password');
select throws_ok($$ select admin_set_system_admin('a1111111-1111-4111-8111-111111111111', false) $$, '42501', null,
  'There is always at least one System Admin');

-- The user changes their own password ----------------------------------------------
select pg_temp.as_user(current_setting('test.eve'));
select throws_ok($$ select change_my_password('wrong-password', 'eve-chosen-password') $$, '28P01', null,
  'Changing your password needs your current password');
select lives_ok($$ select change_my_password('eve-new-password', 'eve-chosen-password') $$,
  'A user can change their own password');
reset role;

select ok(
  (select encrypted_password = extensions.crypt('eve-chosen-password', encrypted_password) from auth.users
   where id = current_setting('test.eve')::uuid),
  'The new password works');
select results_eq(
  $$ select changed_by::text, reason from audit_log where table_name = 'profiles' and record_id = current_setting('test.eve')
     and 'password' = any(changed_fields) order by id $$,
  $$ values ('a1111111-1111-4111-8111-111111111111', 'Password reset by a System Admin'),
            (current_setting('test.eve'), 'Changed by the user') $$,
  'Password changes are audited, without the password (SRS-028)');

-- Picking a new project member from a list -----------------------------------------
-- (Only this file's accounts are checked: the database may also hold seed.sql's users.)
set local role authenticated;
select pg_temp.as_user('a1111111-1111-4111-8111-111111111111');
select set_config('test.project', (select (create_project('Members Test')).id::text), true);
select results_eq(
  $$ select email from project_addable_users(current_setting('test.project')::uuid) where email like '%@test.local' order by email $$,
  $$ values ('bob@test.local'), ('eve@test.local') $$,
  'Someone managing a project lists every account that is not yet a member');
select add_project_member(current_setting('test.project')::uuid, 'bob@test.local', 'viewer');
select results_eq(
  $$ select email from project_addable_users(current_setting('test.project')::uuid) where email like '%@test.local' $$,
  $$ values ('eve@test.local') $$,
  'Members already in the project drop off the list');
select pg_temp.as_user('b2222222-2222-4222-8222-222222222222');
select throws_ok($$ select * from project_addable_users(current_setting('test.project')::uuid) $$, '42501', null,
  'Members who cannot manage members do not get the list');
reset role;

select * from finish();
rollback;
