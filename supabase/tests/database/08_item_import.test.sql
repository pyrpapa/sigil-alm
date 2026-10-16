-- Importing items (SRS-047, RISK-011): preview before anything is created, every row
-- validated like a normal item, all-or-nothing import, IDs kept, no duplicates.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(19);

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-4111-8111-111111111111', 'alice@test.local', '{"full_name": "Alice Admin"}'),
  ('d4444444-4444-4444-8444-444444444444', 'vera@test.local',  '{"full_name": "Vera Viewer"}');

create function pg_temp.tracker(p_key text) returns uuid language sql as $$
  select id from public.trackers where type_key = p_key and project_id = current_setting('test.project_id')::uuid
$$;

select set_config('request.jwt.claims', '{"sub": "a1111111-1111-4111-8111-111111111111", "role": "authenticated"}', true);
set local role authenticated;
select set_config('test.project_id', (select (create_project('Import Test')).id::text), true);
select add_project_member(current_setting('test.project_id')::uuid, 'vera@test.local', 'viewer');

select set_config('test.srs_rows', $json$[
  {"id": "SRS-001", "folder": "Access", "title": "Sign-in required",
   "values": {"ers": [{"n": 1, "text": "Users sign in."}], "verification": "Test (automated)", "rationale": "Identified users only."}},
  {"id": "SRS-002", "folder": "Access", "title": "No self-registration",
   "values": {"ers": [{"n": 1, "text": "Only System Admins create accounts."}], "verification": "Test (automated)"}},
  {"id": "SRS-003", "folder": "Projects", "title": "Create project",
   "values": {"ers": [{"n": 1, "text": "Users can create projects."}], "verification": "Inspection"}}
]$json$, true);

-- Preview -----------------------------------------------------------------------------
select is(
  (select jsonb_path_query_array(import_items(pg_temp.tracker('SRS'), current_setting('test.srs_rows')::jsonb, false), '$.rows[*].item_key')),
  '["SRS-001", "SRS-002", "SRS-003"]'::jsonb,
  'The preview shows the ID each row will get (SRS-047)');

select results_eq(
  $$ select (select count(*)::int from items where project_id = current_setting('test.project_id')::uuid),
            (select count(*)::int from folders where tracker_id = pg_temp.tracker('SRS')),
            (select next_number from trackers where id = pg_temp.tracker('SRS')) $$,
  $$ values (0, 0, 1) $$,
  'A preview creates no items or folders and uses up no IDs (SRS-047)');

select set_config('test.bad_rows', $json$[
  {"id": "SRS-001", "title": "Fine", "values": {"ers": [{"n": 1, "text": "x"}], "verification": "Inspection"}},
  {"id": "SRS-002", "title": "No requirement", "values": {"verification": "Inspection"}},
  {"id": "SRS-003", "title": "Bad option", "values": {"ers": [{"n": 1, "text": "x"}], "verification": "Guesswork"}},
  {"id": "SRS-004", "title": "", "values": {"ers": [{"n": 1, "text": "x"}], "verification": "Inspection"}},
  {"id": "SRS-005", "title": "Unknown column", "values": {"ers": [{"n": 1, "text": "x"}], "verification": "Inspection", "colour": "blue"}},
  {"id": "SRS-006", "title": "Also fine", "values": {"ers": [{"n": 1, "text": "y"}], "verification": "Analysis"}}
]$json$, true);

select is(
  (select jsonb_path_query_array(import_items(pg_temp.tracker('SRS'), current_setting('test.bad_rows')::jsonb, false),
                                 '$.rows[*].errors[0]')),
  '["\"Requirements\" is required", "\"Verification method\" must be one of the listed options", "\"Title\" is required", "Unknown field \"colour\""]'::jsonb,
  'Every invalid row is reported with the same checks as creating an item by hand (SRS-016, SRS-047)');

select is(
  (select import_items(pg_temp.tracker('SRS'), current_setting('test.bad_rows')::jsonb, false) -> 'rows' -> 5 ->> 'item_key'),
  'SRS-006',
  'Rows after an invalid row still show the ID they would get');

-- Import -------------------------------------------------------------------------------
select results_eq(
  $$ select (r ->> 'committed')::boolean, (r ->> 'error_count')::int,
            (select count(*)::int from items where project_id = current_setting('test.project_id')::uuid)
     from import_items(pg_temp.tracker('SRS'), current_setting('test.bad_rows')::jsonb, true) r $$,
  $$ values (false, 4, 0) $$,
  'An import with any invalid row creates nothing, not even the valid rows (RISK-011)');

select is(
  (select (import_items(pg_temp.tracker('SRS'), current_setting('test.srs_rows')::jsonb, true, 'srs-v1.csv') ->> 'committed')::boolean),
  true,
  'A valid file imports');

select results_eq(
  $$ select i.item_key, i.title, f.name, s.name, i.revision, i.values ->> 'rationale'
     from item_heads i join tracker_states s on s.id = i.state_id left join folders f on f.id = i.folder_id
     where i.tracker_id = pg_temp.tracker('SRS') order by i.number $$,
  $$ values ('SRS-001', 'Sign-in required', 'Access', 'New', 1, 'Identified users only.'),
            ('SRS-002', 'No self-registration', 'Access', 'New', 1, null),
            ('SRS-003', 'Create project', 'Projects', 'New', 1, null) $$,
  'Imported items keep their IDs, titles, values and folders, and start in New at version 1');

select is((select count(*)::int from folders where tracker_id = pg_temp.tracker('SRS')), 2,
  'Folders named in the file are created once each');

select is(
  (select count(*)::int from item_revisions r where r.tracker_id in (pg_temp.tracker('SRS'), pg_temp.tracker('TC'))),
  6,
  'Each imported requirement and the test case that comes with it has its first version (SRS-020)');

select is(
  (select array_agg(distinct reason) from audit_log where table_name = 'items' and action = 'INSERT'
     and project_id = current_setting('test.project_id')::uuid),
  array['Imported from srs-v1.csv'],
  'Imported items are audited with where they came from (SRS-028)');

-- No duplicates ---------------------------------------------------------------------------
select is(
  (select import_items(pg_temp.tracker('SRS'), current_setting('test.srs_rows')::jsonb, true) -> 'rows' -> 0 -> 'errors' ->> 0),
  'The file says SRS-001 but this row would become SRS-004. Import into an empty tracker, with rows in ID order.',
  'Importing the same file twice is refused instead of creating duplicates (RISK-011)');

select is((select count(*)::int from items where tracker_id = pg_temp.tracker('SRS')), 3,
  'The refused import created nothing');

select is(
  (select import_items(pg_temp.tracker('SRS'),
     '[{"title": "No ID column", "values": {"ers": [{"n": 1, "text": "z"}], "verification": "Inspection"}}]'::jsonb, false) -> 'rows' -> 0 ->> 'item_key'),
  'SRS-004',
  'Without an ID column, rows take the next free IDs');

-- RISK with links to the imported requirements ----------------------------------------------
select is(
  (select import_items(pg_temp.tracker('RISK'),
     '[{"id": "RISK-001", "title": "Unknown requirement", "values": {"failure_mode": "x", "severity": "High", "likelihood": "Low"},
        "links": [{"type": "mitigated_by", "target": "SRS-001"}, {"type": "mitigated_by", "target": "SRS-099"}]}]'::jsonb, false)
     -> 'rows' -> 0 -> 'errors' ->> 0),
  'No item SRS-099 in this project',
  'A link to a requirement that does not exist is reported on its row');

select is(
  (select (import_items(pg_temp.tracker('RISK'),
     '[{"id": "RISK-001", "title": "Access beyond role", "values": {"failure_mode": "A user reads another project.",
        "severity": "High", "likelihood": "Medium", "risk_level": "High"},
        "links": [{"type": "mitigated_by", "target": "SRS-001"}, {"type": "mitigated_by", "target": "SRS-002"}]}]'::jsonb,
     true, 'risk-v1.csv') ->> 'committed')::boolean),
  true,
  'RISK items import with their links');

select results_eq(
  $$ select direction, label, other_item_key from item_link_list(
       (select id from items where item_key = 'SRS-002' and project_id = current_setting('test.project_id')::uuid)) $$,
  $$ values ('in', 'mitigates', 'RISK-001'), ('in', 'verified by', 'TC-002') $$,
  'Imported links show on the requirement, next to its test case (SRS-019)');

select is(
  (select string_agg(t.item_key, ', ' order by t.item_key) from item_links l
   join item_heads i on i.revision_id = l.source_revision_id join items t on t.id = l.target_item_id
   where i.item_key = 'RISK-001' and i.project_id = current_setting('test.project_id')::uuid),
  'SRS-001, SRS-002',
  'Imported links are part of the item''s first version (SRS-020)');

select throws_ok(
  $$ select import_items(pg_temp.tracker('SRS'), '[]'::jsonb, false) $$,
  '22023', 'There are no rows to import',
  'An empty file is refused');
reset role;

-- Viewer --------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub": "d4444444-4444-4444-8444-444444444444", "role": "authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select import_items(pg_temp.tracker('SRS'), current_setting('test.srs_rows')::jsonb, false) $$,
  '42501', null,
  'A Viewer cannot import, not even a preview (SRS-007)');
reset role;

select * from finish();
rollback;
