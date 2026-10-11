-- Repository link on a project.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(6);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}'),
  ('b2222222-2222-4222-8222-222222222222', 'bob@test.local',   '{"full_name": "Bob Viewer"}');

select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.project_id', (select (create_project('Repo Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'bob@test.local', 'viewer');

select is(
  (select repository_url from update_project_repository(current_setting('test.project_id')::uuid,
     ' https://github.com/pyrpapa/sigil-alm.git/ ', 'Link test repo')),
  'https://github.com/pyrpapa/sigil-alm',
  'A repository link is saved in a standard form (trailing .git and slash removed)');

select throws_ok(
  $$ select update_project_repository(current_setting('test.project_id')::uuid, 'https://evil.example.com/x/y') $$,
  '23514', null,
  'Only GitHub repository links are accepted');

select is(
  (select repository_url from update_project_repository(current_setting('test.project_id')::uuid, '', 'Unlink')),
  null,
  'An empty value removes the repository link');

reset role;

select is(
  (select reason from audit_log
    where table_name = 'projects' and action = 'UPDATE'
      and record_id = current_setting('test.project_id')
      and new_values ->> 'repository_url' = 'https://github.com/pyrpapa/sigil-alm'),
  'Link test repo',
  'Linking a repository is recorded in the audit trail with its reason (SRS-028, SRS-029)');

select set_config('request.jwt.claims', '{"sub": "b2222222-2222-4222-8222-222222222222", "role": "authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ select update_project_repository(current_setting('test.project_id')::uuid, 'https://github.com/a/b') $$,
  '42501', null,
  'A Viewer cannot change the repository link (SRS-007)');

reset role;

select has_column('public', 'projects', 'repository_url', 'Projects have a repository link column');

select * from finish();
rollback;
