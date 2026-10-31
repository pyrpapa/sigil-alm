-- Putting an approved requirement into a release puts its test case in too.
-- A requirement and its test case are one pair: targeting a release (set_target_release)
-- and taking an item out of one (unpin_from_release) already move both. Adding an
-- approved version straight to a release (pin_to_release) pinned only the item named;
-- it now pins the partner's approved version as well, in the same transaction, so the
-- rule holds however the release is changed (release page, bulk action or API).

create or replace function public.pin_to_release(p_release uuid, p_item uuid, p_reason text default null)
returns public.release_pins
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_release public.items := public.check_release_manager(p_release);
  v_item public.items;
  v_partner public.items;
  v_pin public.release_pins;
begin
  select * into v_item from public.items where id = p_item and project_id = v_release.project_id;
  if not found then
    raise exception 'Item not found in this project' using errcode = 'P0002';
  end if;
  if v_item.approved_revision_id is null then
    raise exception '% has no approved version to put in a release', v_item.item_key using errcode = '22023';
  end if;
  perform set_config('sigil.change_reason', coalesce(p_reason, ''), true);
  insert into public.release_pins (project_id, release_id, item_id, revision_id, pinned_by)
  values (v_release.project_id, p_release, p_item, v_item.approved_revision_id, (select auth.uid()))
  on conflict (release_id, item_id)
  do update set revision_id = excluded.revision_id, pinned_by = excluded.pinned_by, pinned_at = now()
  returning * into v_pin;

  -- The other half of the pair goes with it, at its own approved version.
  if v_item.pair_item_id is not null then
    select * into v_partner from public.items where id = v_item.pair_item_id;
    if v_partner.approved_revision_id is not null then
      insert into public.release_pins (project_id, release_id, item_id, revision_id, pinned_by)
      values (v_release.project_id, p_release, v_partner.id, v_partner.approved_revision_id, (select auth.uid()))
      on conflict (release_id, item_id)
      do update set revision_id = excluded.revision_id, pinned_by = excluded.pinned_by, pinned_at = now();
    end if;
  end if;
  perform set_config('sigil.change_reason', '', true);
  return v_pin;
end;
$$;
