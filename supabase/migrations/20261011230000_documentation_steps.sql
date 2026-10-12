-- Test steps come in two kinds (SRS-049):
--   verify   : action + expected result (the existing shape; "kind" may be left out)
--   document : action + a list of named values the tester records during the run,
--              for example "Browser and version". No expected result.
-- Existing steps have no "kind", so they stay valid as verification steps.
-- Only the steps check changes; the rest of the function is unchanged.

create or replace function public.validate_item_values(p_tracker uuid, p_values jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_clean jsonb := '{}'::jsonb;
  v_field public.tracker_fields;
  v_key text;
  v_val jsonb;
  v_step jsonb;
begin
  if p_values is null then
    p_values := '{}'::jsonb;
  end if;
  if jsonb_typeof(p_values) <> 'object' then
    raise exception 'Field values must be an object' using errcode = '22023';
  end if;

  for v_key, v_val in select key, value from jsonb_each(p_values) loop
    select * into v_field from public.tracker_fields f
     where f.tracker_id = p_tracker and f.key = v_key;
    if not found then
      raise exception 'Unknown field "%"', v_key using errcode = '22023';
    end if;

    -- Empty values are simply left out.
    if v_val = 'null'::jsonb or v_val = '""'::jsonb or v_val = '[]'::jsonb then
      continue;
    end if;
    if jsonb_typeof(v_val) = 'string' and trim(v_val #>> '{}') = '' then
      continue;
    end if;

    case v_field.field_type
      when 'text', 'long_text' then
        if jsonb_typeof(v_val) <> 'string' or char_length(v_val #>> '{}') > 20000 then
          raise exception '"%" must be text (up to 20,000 characters)', v_field.label using errcode = '22023';
        end if;
      when 'number' then
        if jsonb_typeof(v_val) <> 'number' then
          raise exception '"%" must be a number', v_field.label using errcode = '22023';
        end if;
      when 'date' then
        if jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception '"%" must be a date (YYYY-MM-DD)', v_field.label using errcode = '22023';
        end if;
        perform (v_val #>> '{}')::date;
      when 'select' then
        if not (v_field.options @> jsonb_build_array(v_val)) then
          raise exception '"%" must be one of the listed options', v_field.label using errcode = '22023';
        end if;
      when 'user' then
        if jsonb_typeof(v_val) <> 'string'
           or (v_val #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           or not exists (select 1 from public.project_members m
                          where m.project_id = public.tracker_project(p_tracker)
                            and m.user_id = (v_val #>> '{}')::uuid) then
          raise exception '"%" must be a member of this project', v_field.label using errcode = '22023';
        end if;
      when 'steps' then
        if jsonb_typeof(v_val) <> 'array' then
          raise exception '"%" must be a list of steps', v_field.label using errcode = '22023';
        end if;
        for v_step in select value from jsonb_array_elements(v_val) loop
          if jsonb_typeof(v_step) <> 'object' or coalesce(trim(v_step ->> 'action'), '') = '' then
            raise exception 'Every step in "%" needs an action', v_field.label using errcode = '22023';
          end if;
          case coalesce(v_step ->> 'kind', 'verify')
            when 'verify' then
              -- Verification step: the tester compares what happens with the expected result.
              if coalesce(trim(v_step ->> 'expected'), '') = '' then
                raise exception 'Every verification step in "%" needs an expected result', v_field.label using errcode = '22023';
              end if;
            when 'document' then
              -- Documentation step: no expected result; the tester records the named values.
              if coalesce(trim(v_step ->> 'expected'), '') <> '' then
                raise exception 'A documentation step in "%" records values instead of having an expected result', v_field.label using errcode = '22023';
              end if;
              if jsonb_typeof(v_step -> 'fields') is distinct from 'array'
                 or jsonb_array_length(v_step -> 'fields') = 0
                 or jsonb_array_length(v_step -> 'fields') > 20 then
                raise exception 'A documentation step in "%" needs between 1 and 20 values to record', v_field.label using errcode = '22023';
              end if;
              if exists (select 1 from jsonb_array_elements(v_step -> 'fields') f(v)
                         where jsonb_typeof(f.v) <> 'string' or trim(f.v #>> '{}') = '' or char_length(f.v #>> '{}') > 200)
                 or (select count(distinct lower(trim(f.v #>> '{}'))) from jsonb_array_elements(v_step -> 'fields') f(v))
                    <> jsonb_array_length(v_step -> 'fields') then
                raise exception 'Values to record in "%" need unique names (up to 200 characters)', v_field.label using errcode = '22023';
              end if;
            else
              raise exception 'Unknown step kind "%" in "%"', v_step ->> 'kind', v_field.label using errcode = '22023';
          end case;
        end loop;
    end case;

    v_clean := v_clean || jsonb_build_object(v_key, v_val);
  end loop;

  for v_field in select * from public.tracker_fields f
                 where f.tracker_id = p_tracker and f.required and not f.is_retired loop
    if not (v_clean ? v_field.key) then
      raise exception '"%" is required', v_field.label using errcode = '23502';
    end if;
  end loop;

  return v_clean;
end;
$$;
