-- A project's Reviews tab: everything waiting for a review signature or sent back for rework
-- in one project, for every member, not just the person looking. Each row says whether it is
-- waiting on the caller (for_me, the same rule as my_review_queue), so the tab can show
-- "Mine" by default and "Everyone" on request. A requirement and its test case are one pair
-- and are listed once, under the requirement, with the test case named alongside.

create or replace function public.project_review_board(p_project uuid)
returns table (
  kind text,
  for_me boolean,
  item_id uuid,
  item_key text,
  type_key text,
  tracker_name text,
  tracker_position int,
  title text,
  revision int,
  approved_revision int,
  state text,
  review_role public.project_role,
  pair_key text,
  pair_type_key text,
  pair_tracker_name text,
  pair_title text,
  release_id uuid,
  release_key text,
  release_title text,
  assignee_name text,
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
  my_role as (
    select m.role from public.project_members m
    where m.project_id = p_project and m.user_id = (select uid from me)
  ),
  heads as (
    select i.id, i.item_key, i.pair_item_id, t.type_key, t.name as tracker_name, t.position as tracker_position,
           r.id as revision_id, r.title, r.revision, r.state_entered_at, r.content_by, r.assignee, r.target_release_id,
           r.last_rejection, s.name as state, s.review_role, s.is_rework, a.revision as approved_revision
    from public.items i
    join public.trackers t on t.id = i.tracker_id
    join public.item_revisions r on r.id = i.head_revision_id
    join public.tracker_states s on s.id = r.state_id
    left join public.item_revisions a on a.id = i.approved_revision_id
    where i.project_id = p_project
      and (s.review_role is not null or s.is_rework)
      and i.trash_entry_id is null and t.trash_entry_id is null
      and (i.pair_item_id is null or t.is_pair_primary)
      -- members only (SRS-004)
      and exists (select 1 from my_role)
  )
  select case when h.is_rework then 'rework' else 'review' end,
         case
           when h.is_rework then h.assignee = (select uid from me)
           else (select role from my_role) = h.review_role
                and (select status from public.projects where id = p_project) <> 'archived'
                and public.has_project_permission(p_project, 'records.sign')
                and h.content_by <> (select uid from me)
                and (prr.content_by is null or prr.content_by <> (select uid from me))
                and not public.revision_review_done(h.revision_id)
         end,
         h.id, h.item_key, h.type_key, h.tracker_name, h.tracker_position, h.title, h.revision, h.approved_revision,
         h.state, h.review_role, pr.item_key, pt.type_key, pt.name, prr.title,
         rel.id, rel.item_key, relr.title, ap.full_name, h.state_entered_at, h.last_rejection,
         (select count(*)::int from public.review_comments c
          where c.revision_id in (h.revision_id, pr.head_revision_id) and c.resolved_at is null)
  from heads h
  left join public.items pr on pr.id = h.pair_item_id
  left join public.trackers pt on pt.id = pr.tracker_id
  left join public.item_revisions prr on prr.id = pr.head_revision_id
  left join public.items rel on rel.id = h.target_release_id
  left join public.item_revisions relr on relr.id = rel.head_revision_id
  left join public.profiles ap on ap.id = h.assignee
  order by h.tracker_position, h.tracker_name, rel.item_key nulls last, h.state_entered_at;
$$;

revoke execute on function public.project_review_board(uuid) from public, anon;
grant execute on function public.project_review_board(uuid) to authenticated;
