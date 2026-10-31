import { ROLE_LABELS } from '../../lib/labels'
import { STATE_KIND_LABELS, stateKind } from '../../lib/states'

// Badge for a workflow state, coloured by what kind of state it is (see lib/states).
// The dot and the hover text say the same thing as the colour, so colour is never
// the only signal.
export default function StateBadge({ state }) {
  if (!state) return null
  const kind = stateKind(state)
  const hint =
    kind === 'review' && state.review_role ? `Waiting for a ${ROLE_LABELS[state.review_role]} signature` : STATE_KIND_LABELS[kind]
  return (
    <span className={`badge state-badge state-${kind}`} title={hint}>
      <span className="state-dot" aria-hidden="true" />
      {state.name}
    </span>
  )
}
