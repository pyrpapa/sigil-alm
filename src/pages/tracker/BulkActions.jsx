import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import StateBadge from './StateBadge'

// Actions on several selected items at once. Each item still goes through its own
// database function (transition_item, move_item, assign_item), one at a time, so every
// change is checked against permissions and the workflow and gets its own audit entry,
// exactly as if it had been done on the item page. Nothing here bypasses a rule; items
// the database refuses are listed with the reason. Signatures are never applied in bulk:
// an electronic signature is a deliberate act on one record version.
export default function BulkActions({ can, config, items, stateById, folders, editors, hub, exporting, onExport, onClear, onDone }) {
  const [mode, setMode] = useState(null) // 'move' | 'folder' | 'assign'

  const canMove = can('items.transition')
  const canEdit = can('items.edit')

  function finish(action, outcome) {
    setMode(null)
    onDone({ action, ...outcome })
  }

  return (
    <div className="stack-sm">
      <div className="bulk-bar" role="region" aria-label="Bulk actions">
        <span className="bulk-count">{items.length} selected</span>
        {canMove && (
          <button type="button" className={mode === 'move' ? undefined : 'secondary'} onClick={() => setMode(mode === 'move' ? null : 'move')}>
            Move state…
          </button>
        )}
        {canEdit && folders.length > 0 && (
          <button type="button" className={mode === 'folder' ? undefined : 'secondary'} onClick={() => setMode(mode === 'folder' ? null : 'folder')}>
            Move to folder…
          </button>
        )}
        {canEdit && (
          <button type="button" className={mode === 'assign' ? undefined : 'secondary'} onClick={() => setMode(mode === 'assign' ? null : 'assign')}>
            Assign…
          </button>
        )}
        <button type="button" className="secondary" onClick={onExport} disabled={exporting}>
          {exporting ? 'Exporting…' : 'Export selected'}
        </button>
        <button type="button" className="link-button small" onClick={onClear}>
          Clear selection
        </button>
      </div>

      {mode === 'move' && (
        <BulkMove config={config} items={items} stateById={stateById} hub={hub} onCancel={() => setMode(null)} onDone={(o) => finish('Moved', o)} />
      )}
      {mode === 'folder' && <BulkFolder items={items} folders={folders} onCancel={() => setMode(null)} onDone={(o) => finish('Moved to folder', o)} />}
      {mode === 'assign' && (
        <BulkAssign items={items} stateById={stateById} editors={editors} onCancel={() => setMode(null)} onDone={(o) => finish('Assigned', o)} />
      )}
    </div>
  )
}

// Run one database call per item, in order, and collect what happened.
async function runEach(items, call, onProgress) {
  const okIds = []
  const ok = []
  const failed = []
  for (const [n, item] of items.entries()) {
    onProgress(n + 1)
    const { error } = await call(item)
    if (error) failed.push({ key: item.item_key, message: error.message })
    else {
      okIds.push(item.id)
      ok.push(item.item_key)
    }
  }
  return { okIds, ok, failed }
}

// The moves an item could make from its state, the way the item page offers them.
// Leaving a review state happens by signing or sending back (Needs Work), each one
// item at a time, so those are not offered here.
function movesFor(config, item, stateById) {
  const from = stateById[item.state_id]
  if (!from || from.review_role) return []
  return config.transitions
    .filter((t) => t.from_state_id === item.state_id)
    .map((t) => ({ ...t, to: stateById[t.to_state_id] }))
    .filter((t) => t.to && !t.to.is_retired && !t.to.is_rework)
}

function BulkMove({ config, items, stateById, hub, onCancel, onDone }) {
  const plans = items.map((i) => ({ item: i, moves: movesFor(config, i, stateById) }))
  const targets = config.states
    .filter((s) => !s.is_retired && plans.some((p) => p.moves.some((m) => m.to_state_id === s.id)))
    .sort((a, b) => a.position - b.position)
  const [target, setTarget] = useState(targets.length === 1 ? targets[0].id : '')
  const [reason, setReason] = useState('')
  const [progress, setProgress] = useState(0)

  const movable = plans.filter((p) => p.moves.some((m) => m.to_state_id === target))
  const skipped = plans.filter((p) => !p.moves.some((m) => m.to_state_id === target))
  const reasonRequired = movable.some((p) => p.moves.find((m) => m.to_state_id === target).requires_reason)
  const to = stateById[target]

  async function handleSubmit(e) {
    e.preventDefault()
    const outcome = await runEach(
      movable.map((p) => p.item),
      (item) => supabase.rpc('transition_item', { p_item: item.id, p_to_state: target, p_reason: reason.trim() || null }),
      setProgress,
    )
    onDone(outcome)
  }

  if (targets.length === 0)
    return (
      <div className="bulk-form">
        <p className="small">
          None of the selected items can be moved from here. Items in a review state move on when they are signed or sent back,
          one at a time, from the item page or the review dashboard.
        </p>
        <div className="actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    )

  return (
    <form className="bulk-form" onSubmit={handleSubmit} aria-label="Move selected items">
      <div className="form-row">
        <label>
          Move to
          <select value={target} onChange={(e) => setTarget(e.target.value)} required autoFocus>
            <option value="">Choose a state</option>
            {targets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {target && (
          <label className="grow">
            Reason{reasonRequired ? ' (required)' : ' (optional)'}
            <input value={reason} onChange={(e) => setReason(e.target.value)} required={reasonRequired} maxLength={500} />
          </label>
        )}
      </div>
      {to && (
        <div className="small stack-sm">
          <p>
            {movable.length} of {items.length} will move to <StateBadge state={to} />
            {hub && to.review_role && ', each with its test case'}.
            {to.review_role && ' They will be locked until reviewed; each review signature is still given one item at a time.'}
          </p>
          {skipped.length > 0 && (
            <p className="muted">
              Skipped, because their state has no move to {to.name}:{' '}
              {skipped.map((p) => `${p.item.item_key} (${stateById[p.item.state_id]?.name ?? '?'})`).join(', ')}
            </p>
          )}
        </div>
      )}
      <div className="actions">
        <button type="submit" disabled={!target || movable.length === 0 || progress > 0 || (reasonRequired && !reason.trim())}>
          {progress > 0 ? `Moving ${progress} of ${movable.length}…` : `Move ${movable.length} item${movable.length === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={progress > 0}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function BulkFolder({ items, folders, onCancel, onDone }) {
  const [folder, setFolder] = useState('')
  const [progress, setProgress] = useState(0)

  async function handleSubmit(e) {
    e.preventDefault()
    const outcome = await runEach(
      items,
      (item) => supabase.rpc('move_item', { p_item: item.id, p_folder: folder === 'none' ? null : folder }),
      setProgress,
    )
    onDone(outcome)
  }

  return (
    <form className="bulk-form" onSubmit={handleSubmit} aria-label="Move selected items to a folder">
      <div className="form-row">
        <label>
          Folder
          <select value={folder} onChange={(e) => setFolder(e.target.value)} required autoFocus>
            <option value="">Choose a folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
            <option value="none">No folder</option>
          </select>
        </label>
      </div>
      <div className="actions">
        <button type="submit" disabled={!folder || progress > 0}>
          {progress > 0 ? `Moving ${progress} of ${items.length}…` : `Move ${items.length} item${items.length === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={progress > 0}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function BulkAssign({ items, stateById, editors, onCancel, onDone }) {
  const [user, setUser] = useState('')
  const [reason, setReason] = useState('')
  const [progress, setProgress] = useState(0)
  // Only open versions have an assignee.
  const open = items.filter((i) => !stateById[i.state_id]?.is_final)
  const closed = items.length - open.length

  async function handleSubmit(e) {
    e.preventDefault()
    const outcome = await runEach(
      open,
      (item) => supabase.rpc('assign_item', { p_item: item.id, p_user: user === 'nobody' ? null : user, p_reason: reason.trim() || null }),
      setProgress,
    )
    onDone(outcome)
  }

  return (
    <form className="bulk-form" onSubmit={handleSubmit} aria-label="Assign selected items">
      <div className="form-row">
        <label>
          Assign to
          <select value={user} onChange={(e) => setUser(e.target.value)} required autoFocus>
            <option value="">Choose a member</option>
            {editors.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.full_name || m.email}
              </option>
            ))}
            <option value="nobody">Nobody</option>
          </select>
        </label>
        <label className="grow">
          Reason (optional)
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
      </div>
      {closed > 0 && <p className="small muted">{closed} selected item(s) are in a final state and have no assignee; they are skipped.</p>}
      <div className="actions">
        <button type="submit" disabled={!user || open.length === 0 || progress > 0}>
          {progress > 0 ? `Assigning ${progress} of ${open.length}…` : `Assign ${open.length} item${open.length === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={progress > 0}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// What a bulk action did: the items changed, and any the database refused, with why.
export function BulkResults({ results, onDismiss }) {
  const { action, ok, failed } = results
  return (
    <div className={`bulk-form bulk-result${failed.length ? ' has-errors' : ''}`} role="status">
      <p className="small">
        <strong>
          {action} {ok.length} item{ok.length === 1 ? '' : 's'}.
        </strong>{' '}
        {ok.length > 0 && <span className="muted">Each change is in the item's history.</span>}
      </p>
      {failed.length > 0 && (
        <div className="small stack-sm">
          <p className="error">
            {failed.length} item{failed.length === 1 ? ' was' : 's were'} not changed and stay selected:
          </p>
          <ul className="bulk-results">
            {failed.map((f) => (
              <li key={f.key}>
                <span className="prefix">{f.key}</span> {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="actions">
        <button type="button" className="link-button small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
