// Badge for a workflow state: review states amber, locked states green, others neutral.
export default function StateBadge({ state }) {
  if (!state) return null
  const tone = state.review_role ? 'warn' : state.locks_item ? 'good' : 'neutral'
  return <span className={`badge badge-${tone}`}>{state.name}</span>
}
