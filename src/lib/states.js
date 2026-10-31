// What kind of workflow state an item is in, from the state's configuration flags.
// Used for badge colours and the state summary on tracker pages, so a list shows at a
// glance which items are drafts, waiting for review, sent back or approved.
//   new         the starting state
//   progress    being written (editable)
//   ready       finished by its author, locked, waiting to be sent to review
//   review      waiting for a review signature
//   rework      sent back by a reviewer (Needs Work)
//   done        final (approved, closed, complete)
//   locked      any other locked state
export function stateKind(state) {
  if (!state) return 'progress'
  if (state.is_rework) return 'rework'
  if (state.review_role) return 'review'
  if (state.is_final) return 'done'
  if (state.is_ready) return 'ready'
  if (state.is_initial) return 'new'
  if (state.locks_item) return 'locked'
  return 'progress'
}

export const STATE_KIND_LABELS = {
  new: 'Not started',
  progress: 'Being written',
  ready: 'Ready, locked until sent to review',
  review: 'Waiting for a review signature',
  rework: 'Sent back by a reviewer',
  done: 'Final',
  locked: 'Locked',
}
