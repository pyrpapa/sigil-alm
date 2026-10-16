-- Sigil: the review dashboard (design note, decision 8).
-- One query per signed-in user, across their projects:
--   review  versions waiting in a review stage that the user's role signs, that the
--           user did not write (independence), and that have not been signed yet
--   rework  versions in Needs Work assigned to the user
-- A requirement and its test case appear once, as a pair. Each row carries the
-- release the version is for, so the app can group by release.

create function public.my_review_queue()
returns table (
  kind text,
  project_id uuid,
  project_name text,
  item_id uuid,
  item_key text,
  type_key text,
  title text,
  revision int,
  approved_revision int,
  state text,
  pair_key text,
  release_id uuid,
  release_key text,
  release_title text,
  waiting_since timestamptz,
  rejection jsonb,
  open_comments int
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select (select auth.uid()) as uid),
  heads as (
    select i.id, i.project_id, i.item_key, i.pair_item_id, t.type_key, t.is_pair_primary, t.pair_tracker_id,
           r.id as revision_id, r.title, r.revision, r.state_entered_at, r.content_by, r.assignee, r.target_release_id,
           r.last_rejection, s.name as state, s.review_role, s.is_rework, a.revision as approved_revision
    from public.items i
    join public.trackers t on t.id = i.tracker_id
    join public.item_revisions r on r.id = i.head_revision_id
    join public.tracker_states s on s.id = r.state_id
    left join public.item_revisions a on a.id = i.approved_revision_id
    join public.project_members m on m.project_id = i.project_id and m.user_id = (select uid from me)
    join public.projects p on p.id = i.project_id and p.status <> 'archived'
    where (s.review_role is not null or s.is_rework)
      -- a pair is listed once, under its requirement
      and (i.pair_item_id is null or t.is_pair_primary)
  )
  select case when h.is_rework then 'rework' else 'review' end,
         h.project_id, p.name, h.id, h.item_key, h.type_key, h.title, h.revision, h.approved_revision, h.state,
         pr.item_key, rel.id, rel.item_key, relr.title, h.state_entered_at, h.last_rejection,
         (select count(*)::int from public.review_comments c
          where c.revision_id in (h.revision_id, pr.head_revision_id) and c.resolved_at is null)
  from heads h
  join public.projects p on p.id = h.project_id
  join public.project_members m on m.project_id = h.project_id and m.user_id = (select uid from me)
  left join public.items pr on pr.id = h.pair_item_id
  left join public.item_revisions prr on prr.id = pr.head_revision_id
  left join public.items rel on rel.id = h.target_release_id
  left join public.item_revisions relr on relr.id = rel.head_revision_id
  where (
      -- waiting for my signature
      not h.is_rework
      and m.role = h.review_role
      and public.has_project_permission(h.project_id, 'records.sign')
      and h.content_by <> (select uid from me)
      and (prr.content_by is null or prr.content_by <> (select uid from me))
      and not public.revision_review_done(h.revision_id)
    ) or (
      -- sent back to me
      h.is_rework and h.assignee = (select uid from me)
    )
  order by 1 desc, p.name, rel.item_key nulls last, h.state_entered_at;
$$;

revoke execute on function public.my_review_queue() from public, anon;
grant execute on function public.my_review_queue() to authenticated;

-- Sign the review and, when the stage has one way forward, move on to it in the same
-- step (Val Review → QA Review, QA Review → Approved). Either both happen or neither.
create function public.sign_and_advance(p_item uuid, p_password text)
returns public.item_heads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.items;
  v_next uuid;
  v_count int;
begin
  perform public.sign_item(p_item, p_password);
  select * into v_item from public.items where id = p_item;
  select min(t.to_state_id::text)::uuid, count(*) into v_next, v_count
  from public.item_revisions r
  join public.tracker_transitions t on t.from_state_id = r.state_id
  join public.tracker_states s on s.id = t.to_state_id and not s.is_rework and not s.is_retired
  where r.id = v_item.head_revision_id;
  if v_count = 1 and public.can_modify_project(v_item.project_id, 'items.transition') then
    perform public.transition_item(p_item, v_next);
  end if;
  return public.item_head(p_item);
end;
$$;

revoke execute on function public.sign_and_advance(uuid, text) from public, anon;
grant execute on function public.sign_and_advance(uuid, text) to authenticated;
