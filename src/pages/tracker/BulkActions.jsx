import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { isEmpty } from '../../lib/trackers'
import FieldInput from '../../components/FieldInput'
import StateBadge from './StateBadge'

// Actions on several selected items at once. Each item still goes through its own
// database function (transition_item, update_item, set_target_release, pin_to_release,
// move_item, assign_item), one at a time, so every
// change is checked against permissions and the workflow and gets its own audit entry,
// exactly as if it had been done on the item page. Nothing here bypasses a rule; items
// the database refuses are listed with the reason. Signatures are never applied in bulk:
// an electronic signature is a deliberate act on one record version.
export default function BulkActions({
  can,
  config,
  items,
  stateById,
  folders,
  editors,
  members,
  releases,
  hub,
  exporting,
  onExport,
  onClear,
  onDone,
}) {
  const [mode, setMode] = useState(null) // 'move' | 'release' | 'field' | 'folder' | 'assign'
  const openReleases = releases.filter((r) => !r.complete)
  // A test case's release follows its requirement's, so releases are set on requirements.
  const releasable = config.tracker.type_key !== 'REL' && !(config.tracker.pair_tracker_id && !config.tracker.is_pair_primary)
  const toggleMode = (m) => setMode(mode === m ? null : m)
  const modeButton = (m, label) => (
    <button type="button" className={mode === m ? undefined : 'secondary'} aria-pressed={mode === m} onClick={() => toggleMode(m)}>
      {label}
    </button>
  )

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
        {canMove && modeButton('move', 'Move state…')}
        {(canEdit || can('releases.manage')) && openReleases.length > 0 && releasable && modeButton('release', 'Set release…')}
        {canEdit && modeButton('field', 'Edit field…')}
        {canEdit && folders.length > 0 && modeButton('folder', 'Move to folder…')}
        {canEdit && modeButton('assign', 'Assign…')}
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
      {mode === 'release' && (
        <BulkRelease
          can={can}
          items={items}
          releases={openReleases}
          hub={hub}
          onCancel={() => setMode(null)}
          onDone={(o) => finish('Set the release of', o)}
        />
      )}
      {mode === 'field' && (
        <BulkField
          config={config}
          items={items}
          stateById={stateById}
          members={members}
          onCancel={() => setMode(null)}
          onDone={(o) => finish('Updated', o)}
        />
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

// An open version targets a release and is recorded in it when approved; an approved
// version (with no newer draft) is put straight into the release. Both are the same
// calls the item and release pages make; for a requirement, the database moves its
// test case with it.
const headApproved = (i) => Boolean(i.approved_revision) && i.approved_revision === i.revision

function BulkRelease({ can, items, releases, hub, onCancel, onDone }) {
  const [release, setRelease] = useState(releases.length === 1 ? releases[0].id : '')
  const [reason, setReason] = useState('')
  const [progress, setProgress] = useState(0)
  const clearing = release === 'none'
  const canTarget = can('items.edit')
  const canPin = can('releases.manage')
  const open = items.filter((i) => !headApproved(i))
  const approved = items.filter(headApproved)
  const willTarget = canTarget ? open : []
  const willPin = canPin && !clearing ? approved : []
  const skipped = [
    ...(canTarget ? [] : open.map((i) => `${i.item_key} (you cannot edit items)`)),
    ...(clearing
      ? approved.map((i) => `${i.item_key} (approved; take it out on the release page, with a reason)`)
      : canPin
        ? []
        : approved.map((i) => `${i.item_key} (approved; adding it needs release management permission)`)),
  ]
  const total = willTarget.length + willPin.length
  const chosen = releases.find((r) => r.id === release)

  async function handleSubmit(e) {
    e.preventDefault()
    const target = clearing ? null : release
    const outcome = await runEach(
      [...willTarget, ...willPin],
      (item) =>
        headApproved(item)
          ? supabase.rpc('pin_to_release', { p_release: target, p_item: item.id, p_reason: reason.trim() || null })
          : supabase.rpc('set_target_release', { p_item: item.id, p_release: target, p_reason: reason.trim() || null }),
      setProgress,
    )
    onDone(outcome)
  }

  return (
    <form className="bulk-form" onSubmit={handleSubmit} aria-label="Set the release of selected items">
      <div className="form-row">
        <label>
          Release
          <select value={release} onChange={(e) => setRelease(e.target.value)} required autoFocus>
            <option value="">Choose a release</option>
            {releases.map((r) => (
              <option key={r.id} value={r.id}>
                {r.item_key} {r.title}
              </option>
            ))}
            {canTarget && <option value="none">No release (open versions only)</option>}
          </select>
        </label>
        <label className="grow">
          Reason (optional)
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
      </div>
      {release && (
        <div className="small stack-sm">
          {willTarget.length > 0 && (
            <p>
              {willTarget.length} open version{willTarget.length === 1 ? '' : 's'}{' '}
              {clearing ? 'will no longer target a release' : `will target ${chosen.item_key} ${chosen.title}, and be recorded in it when approved`}
              {hub && (willTarget.length === 1 ? ', with its test case' : ', with their test cases')}.
            </p>
          )}
          {willPin.length > 0 && (
            <p>
              {willPin.length} approved version{willPin.length === 1 ? '' : 's'} will be added to {chosen.item_key} {chosen.title} now
              {hub && (willPin.length === 1 ? ', with its approved test case' : ', with their approved test cases')}.
            </p>
          )}
          {skipped.length > 0 && <p className="muted">Skipped: {skipped.join(', ')}</p>}
        </div>
      )}
      <div className="actions">
        <button type="submit" disabled={!release || total === 0 || progress > 0}>
          {progress > 0 ? `Updating ${progress} of ${total}…` : `Set release for ${total} item${total === 1 ? '' : 's'}`}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={progress > 0}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// Set one field to the same value on every selected item. It is an ordinary edit of
// each item's open version (update_item), so locked and approved items are skipped,
// field validation runs per item, and an item that has been reviewed before needs a
// reason. Lists (ERs, test steps) and fields set by the workflow are not offered.
function BulkField({ config, items, stateById, members, onCancel, onDone }) {
  const autoKeys = new Set(config.actions.map((a) => a.field_key))
  const fields = config.fields.filter((f) => !f.is_retired && !autoKeys.has(f.key) && !['statements', 'steps'].includes(f.field_type))
  const [key, setKey] = useState('')
  const [value, setValue] = useState(null)
  const [reason, setReason] = useState('')
  const [progress, setProgress] = useState(0)
  const field = fields.find((f) => f.key === key)
  const editable = items.filter((i) => !stateById[i.state_id]?.locks_item && !headApproved(i))
  const locked = items.filter((i) => !editable.includes(i))
  const clearing = isEmpty(value)

  async function handleSubmit(e) {
    e.preventDefault()
    const outcome = await runEach(
      editable,
      (item) => {
        const values = { ...item.values }
        if (clearing) delete values[key]
        else values[key] = value
        return supabase.rpc('update_item', {
          p_item: item.id,
          p_title: item.title,
          p_values: values,
          p_folder: item.folder_id,
          p_reason: reason.trim() || null,
        })
      },
      setProgress,
    )
    onDone(outcome)
  }

  return (
    <form className="bulk-form" onSubmit={handleSubmit} aria-label="Edit a field on selected items">
      <div className="form-row">
        <label>
          Field
          <select
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setValue(null)
            }}
            required
            autoFocus
          >
            <option value="">Choose a field</option>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {field && (
          <div className="grow bulk-field-value">
            <FieldInput field={{ ...field, required: false }} value={value} onChange={setValue} members={members} />
          </div>
        )}
      </div>
      {field && (
        <label>
          Reason (required for items that have been reviewed before)
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
      )}
      {field && (
        <div className="small stack-sm">
          <p>
            {field.label} will be {clearing ? <strong>cleared</strong> : 'set'} on {editable.length} of {items.length} item
            {items.length === 1 ? '' : 's'}.{field.required && clearing && ' It is required, so the database will refuse to clear it.'}
          </p>
          {locked.length > 0 && (
            <p className="muted">
              Skipped, because they are locked: {locked.map((i) => `${i.item_key} (${stateById[i.state_id]?.name ?? '?'})`).join(', ')}. Start a
              new version, or move them back to an editable state, to change them.
            </p>
          )}
        </div>
      )}
      <div className="actions">
        <button type="submit" disabled={!field || editable.length === 0 || progress > 0}>
          {progress > 0 ? `Updating ${progress} of ${editable.length}…` : `Update ${editable.length} item${editable.length === 1 ? '' : 's'}`}
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
