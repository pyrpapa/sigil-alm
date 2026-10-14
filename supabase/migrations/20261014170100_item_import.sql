-- Sigil Phase 2e: import tracker items in bulk (SRS-047, RISK-011).
-- import_items checks every row exactly as create_item would, then either
--   preview (p_commit = false): reports the ID each row would get and every
--     row's errors, and creates nothing; or
--   import  (p_commit = true):  creates all rows, or none if any row is invalid.
-- Rows are JSON built by the app from a CSV file:
--   {"id": "SRS-001", "title": "...", "folder": "Access",
--    "values": {"requirement": "...", ...}, "links": [{"type": "mitigated_by", "target": "SRS-004"}]}
-- "id" is optional. When given it must equal the ID Sigil assigns, so a file
-- imported twice, or into a tracker that already has items, is refused instead
-- of creating duplicates or renumbered requirements. Folders are created by name.

create function public.import_items(
  p_tracker uuid,
  p_rows jsonb,
  p_commit boolean default false,
  p_source text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracker public.trackers;
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_errors int := 0;
  v_item public.items;
  v_folder uuid;
  v_folder_name text;
  v_expected text;
  v_key text;
  v_message text;
  i int;
begin
  select * into v_tracker from public.trackers where id = p_tracker;
  if not found or not public.can_modify_project(v_tracker.project_id, 'items.create') then
    raise exception 'You do not have permission to create items in this tracker' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'There are no rows to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    raise exception 'Import at most 2,000 rows at a time' using errcode = '22023';
  end if;

  perform set_config('sigil.change_reason',
    'Imported from ' || coalesce(nullif(trim(p_source), ''), 'a file'), true);

  -- Everything below is undone unless it is a real import with no errors.
  begin
    for i in 0 .. jsonb_array_length(p_rows) - 1 loop
      v_row := p_rows -> i;
      v_key := null;
      v_message := null;
      v_expected := upper(nullif(trim(v_row ->> 'id'), ''));

      begin
        if jsonb_typeof(v_row) <> 'object' then
          raise exception 'Row is not a record' using errcode = '22023';
        end if;
        if coalesce(trim(v_row ->> 'title'), '') = '' then
          raise exception '"Title" is required' using errcode = '23502';
        end if;
        if char_length(trim(v_row ->> 'title')) > 300 then
          raise exception '"Title" is longer than 300 characters' using errcode = '22023';
        end if;

        v_folder := null;
        v_folder_name := nullif(trim(v_row ->> 'folder'), '');
        if v_folder_name is not null then
          select id into v_folder from public.folders where tracker_id = p_tracker and name = v_folder_name;
          if v_folder is null then
            insert into public.folders (tracker_id, name, position)
            values (p_tracker, v_folder_name, (select count(*) from public.folders where tracker_id = p_tracker))
            returning id into v_folder;
          end if;
        end if;

        v_item := public.create_item(p_tracker, v_row ->> 'title', coalesce(v_row -> 'values', '{}'::jsonb),
                                     v_folder, coalesce(v_row -> 'links', '[]'::jsonb));
        v_key := v_item.item_key;

        if v_expected is not null and v_expected <> v_item.item_key then
          raise exception 'The file says % but this row would become %. Import into an empty tracker, with rows in ID order.',
            v_expected, v_item.item_key using errcode = '22023';
        end if;
      exception when others then
        v_message := sqlerrm;
        v_errors := v_errors + 1;
        -- Keep numbering in step so the rows after a bad row still show the IDs they would get.
        update public.trackers set next_number = next_number + 1 where id = p_tracker
        returning v_tracker.type_key || '-' || lpad((next_number - 1)::text, 3, '0') into v_key;
      end;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'row', i + 1, 'item_key', v_key,
        'errors', case when v_message is null then '[]'::jsonb else jsonb_build_array(v_message) end));
    end loop;

    if not p_commit or v_errors > 0 then
      raise exception 'import not committed' using errcode = 'SGRB1';
    end if;
  exception when sqlstate 'SGRB1' then
    null;   -- rolled back: nothing from this import remains
  end;

  perform set_config('sigil.change_reason', '', true);

  return jsonb_build_object(
    'committed', p_commit and v_errors = 0,
    'error_count', v_errors,
    'rows', v_results);
end;
$$;

revoke execute on function public.import_items(uuid, jsonb, boolean, text) from public, anon;
grant execute on function public.import_items(uuid, jsonb, boolean, text) to authenticated;
