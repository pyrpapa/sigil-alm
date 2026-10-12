import { useCallback, useEffect, useState } from 'react'
import { Link, useOutletContext, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { fieldKeyFromLabel, loadMembers, loadTracker } from '../../lib/trackers'
import { ACTION_LABELS, FIELD_TYPE_LABELS, REVIEW_MEANINGS, REVIEW_ROLES, ROLE_LABELS } from '../../lib/labels'
import FieldInput from '../../components/FieldInput'

// Tracker configuration (Admins): fields, workflow states and moves, review gates,
// and state actions. Every change is recorded in the audit trail by the database.
export default function TrackerConfig() {
  const { project, can } = useOutletContext()
  const { typeKey } = useParams()
  const [config, setConfig] = useState(null)
  const [members, setMembers] = useState([])
  const [error, setError] = useState('')
  const [tab, setTab] = useState('fields')

  const fetchConfig = useCallback(async () => {
    const [c, m] = await Promise.all([loadTracker(project.id, typeKey), loadMembers(project.id)])
    return { c, m }
  }, [project.id, typeKey])

  const reload = useCallback(
    () =>
      fetchConfig().then(
        ({ c, m }) => {
          setConfig(c)
          setMembers(m)
        },
        (e) => setError(e.message),
      ),
    [fetchConfig],
  )

  useEffect(() => {
    let current = true
    fetchConfig().then(
      ({ c, m }) => {
        if (!current) return
        setConfig(c)
        setMembers(m)
      },
      (e) => current && setError(e.message),
    )
    return () => {
      current = false
    }
  }, [fetchConfig])

  // Run a change; show the database's message if it refuses.
  const run = useCallback(
    async (promise) => {
      setError('')
      const { error } = await promise
      if (error) {
        setError(error.message)
        return false
      }
      await reload()
      return true
    },
    [reload],
  )

  if (!config) return error ? <p className="error">{error}</p> : <p className="muted">Loading configuration…</p>
  if (!can('trackers.configure'))
    return <p>Only project Admins can configure trackers. You can view the workflow on any item.</p>

  const base = `/projects/${project.id}/trackers/${typeKey}`

  return (
    <div className="stack">
      <div className="card-head">
        <h2>
          <Link to={`/projects/${project.id}/trackers`}>Trackers</Link> / <Link to={base}>{typeKey}</Link> / Configuration
        </h2>
      </div>
      <p className="muted small">
        Changes apply immediately and are recorded in the project's Activity. Fields and states are retired rather than deleted, so
        existing items keep their history.
      </p>

      <nav className="tabs" aria-label="Configuration sections">
        {[
          ['fields', 'Fields'],
          ['workflow', 'Workflow'],
          ['actions', 'State actions'],
        ].map(([k, label]) => (
          <button key={k} type="button" className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </nav>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {tab === 'fields' && <FieldsConfig config={config} run={run} />}
      {tab === 'workflow' && <WorkflowConfig config={config} run={run} />}
      {tab === 'actions' && <ActionsConfig config={config} run={run} members={members} />}
    </div>
  )
}

/* ---------------------------------------------------------------- Fields */

function swapPositions(table, a, b) {
  return Promise.all([
    supabase.from(table).update({ position: b.position }).eq('id', a.id),
    supabase.from(table).update({ position: a.position }).eq('id', b.id),
  ]).then((results) => results.find((r) => r.error) ?? { error: null })
}

function FieldsConfig({ config, run }) {
  const fields = config.fields
  return (
    <div className="stack">
      <div className="table-wrap">
        <table aria-label="Fields">
          <thead>
            <tr>
              <th>Order</th>
              <th>Label</th>
              <th>Key</th>
              <th>Type</th>
              <th>Required</th>
              <th>Options / help</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f, i) => (
              <FieldRow key={f.id} field={f} prev={fields[i - 1]} next={fields[i + 1]} run={run} />
            ))}
          </tbody>
        </table>
      </div>
      <AddFieldForm config={config} run={run} />
    </div>
  )
}

function FieldRow({ field, prev, next, run }) {
  const [label, setLabel] = useState(field.label)
  const [options, setOptions] = useState(field.options.join(', '))
  const [help, setHelp] = useState(field.help_text ?? '')
  const parsedOptions = options
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const dirty =
    label.trim() !== field.label ||
    (help.trim() || null) !== (field.help_text || null) ||
    (field.field_type === 'select' && JSON.stringify(parsedOptions) !== JSON.stringify(field.options))

  const save = () =>
    run(
      supabase
        .from('tracker_fields')
        .update({
          label: label.trim(),
          help_text: help.trim() || null,
          ...(field.field_type === 'select' ? { options: parsedOptions } : {}),
        })
        .eq('id', field.id),
    )

  return (
    <tr className={field.is_retired ? 'retired' : ''}>
      <td className="nowrap">
        <button type="button" className="secondary small" disabled={!prev} onClick={() => run(swapPositions('tracker_fields', field, prev))} aria-label={`Move ${field.label} up`}>
          ↑
        </button>{' '}
        <button type="button" className="secondary small" disabled={!next} onClick={() => run(swapPositions('tracker_fields', field, next))} aria-label={`Move ${field.label} down`}>
          ↓
        </button>
      </td>
      <td>
        <input aria-label={`Label for ${field.key}`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
      </td>
      <td>
        <code>{field.key}</code>
      </td>
      <td className="nowrap">{FIELD_TYPE_LABELS[field.field_type]}</td>
      <td>
        <input
          type="checkbox"
          aria-label={`${field.label} required`}
          checked={field.required}
          onChange={(e) => run(supabase.from('tracker_fields').update({ required: e.target.checked }).eq('id', field.id))}
        />
      </td>
      <td>
        {field.field_type === 'select' && (
          <input aria-label={`Options for ${field.label}`} value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Comma-separated" />
        )}
        <input aria-label={`Help text for ${field.label}`} value={help} onChange={(e) => setHelp(e.target.value)} placeholder="Help text (optional)" />
        {dirty && (
          <button type="button" className="small" onClick={save} disabled={!label.trim()}>
            Save
          </button>
        )}
      </td>
      <td>
        <button
          type="button"
          className="secondary small"
          onClick={() => run(supabase.from('tracker_fields').update({ is_retired: !field.is_retired }).eq('id', field.id))}
        >
          {field.is_retired ? 'Restore' : 'Retire'}
        </button>
      </td>
    </tr>
  )
}

function AddFieldForm({ config, run }) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState('text')
  const [required, setRequired] = useState(false)
  const [options, setOptions] = useState('')
  const [help, setHelp] = useState('')
  const key = fieldKeyFromLabel(label || 'field')
  const taken = config.fields.some((f) => f.key === key)

  async function handleSubmit(e) {
    e.preventDefault()
    const ok = await run(
      supabase.from('tracker_fields').insert({
        tracker_id: config.tracker.id,
        key,
        label: label.trim(),
        field_type: type,
        required,
        help_text: help.trim() || null,
        options: type === 'select' ? options.split(',').map((o) => o.trim()).filter(Boolean) : [],
        position: Math.max(-1, ...config.fields.map((f) => f.position)) + 1,
      }),
    )
    if (ok) {
      setLabel('')
      setOptions('')
      setHelp('')
      setRequired(false)
    }
  }

  return (
    <form className="card form-inline" onSubmit={handleSubmit}>
      <h3>Add a field</h3>
      <div className="form-row">
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={100} />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(FIELD_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      {type === 'select' && (
        <label>
          Options (comma-separated)
          <input value={options} onChange={(e) => setOptions(e.target.value)} required placeholder="e.g. Must, Should, Could" />
        </label>
      )}
      <label>
        Help text (optional)
        <input value={help} onChange={(e) => setHelp(e.target.value)} />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required
      </label>
      <p className="muted small">
        Key: <code>{key}</code> {taken && <span className="error">already used, change the label</span>} · the key and type can't change later.
      </p>
      <div className="actions">
        <button type="submit" disabled={!label.trim() || taken}>
          Add field
        </button>
      </div>
    </form>
  )
}

/* ---------------------------------------------------------------- Workflow */

function WorkflowConfig({ config, run }) {
  const states = config.states
  const active = states.filter((s) => !s.is_retired)
  const moveOf = (from, to) => config.transitions.find((t) => t.from_state_id === from.id && t.to_state_id === to.id)

  return (
    <div className="stack">
      <section className="card">
        <h3>States</h3>
        <p className="muted small">
          Items start in New. A review gate means items entering that state wait for a signature from the chosen role before moving on to a
          locked or review state, and can't be edited while they wait. Locked states can't be edited until moved back.
        </p>
        <div className="table-wrap">
          <table aria-label="States">
            <thead>
              <tr>
                <th>Order</th>
                <th>Name</th>
                <th>Review gate</th>
                <th>Locks items</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {states.map((s, i) => (
                <StateRow key={s.id} state={s} prev={i > 1 ? states[i - 1] : null} next={!s.is_initial ? states[i + 1] : null} run={run} />
              ))}
            </tbody>
          </table>
        </div>
        <AddStateForm config={config} run={run} />
      </section>

      <section className="card">
        <h3>Allowed moves</h3>
        <p className="muted small">Tick a box to allow moving from the row's state to the column's state. "Reason" makes the user explain the move.</p>
        <div className="table-wrap">
          <table aria-label="Allowed moves" className="matrix">
            <thead>
              <tr>
                <th>From ↓ / To →</th>
                {active.map((to) => (
                  <th key={to.id}>{to.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {active.map((from) => (
                <tr key={from.id}>
                  <th scope="row">{from.name}</th>
                  {active.map((to) => {
                    if (from.id === to.id) return <td key={to.id} className="muted">—</td>
                    const m = moveOf(from, to)
                    return (
                      <td key={to.id}>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            aria-label={`Allow ${from.name} to ${to.name}`}
                            checked={Boolean(m)}
                            onChange={(e) =>
                              run(
                                e.target.checked
                                  ? supabase.from('tracker_transitions').insert({ tracker_id: config.tracker.id, from_state_id: from.id, to_state_id: to.id })
                                  : supabase.from('tracker_transitions').delete().eq('id', m.id),
                              )
                            }
                          />
                          allow
                        </label>
                        {m && (
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              aria-label={`Require reason for ${from.name} to ${to.name}`}
                              checked={m.requires_reason}
                              onChange={(e) => run(supabase.from('tracker_transitions').update({ requires_reason: e.target.checked }).eq('id', m.id))}
                            />
                            reason
                          </label>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function StateRow({ state, prev, next, run }) {
  const [name, setName] = useState(state.name)
  const update = (patch) => run(supabase.from('tracker_states').update(patch).eq('id', state.id))
  return (
    <tr className={state.is_retired ? 'retired' : ''}>
      <td className="nowrap">
        {!state.is_initial && (
          <>
            <button type="button" className="secondary small" disabled={!prev} onClick={() => run(swapPositions('tracker_states', state, prev))} aria-label={`Move ${state.name} up`}>
              ↑
            </button>{' '}
            <button type="button" className="secondary small" disabled={!next} onClick={() => run(swapPositions('tracker_states', state, next))} aria-label={`Move ${state.name} down`}>
              ↓
            </button>
          </>
        )}
      </td>
      <td>
        {state.is_initial ? (
          <strong>New</strong>
        ) : (
          <span className="inline-edit">
            <input aria-label={`Name of ${state.name}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            {name.trim() !== state.name && (
              <button type="button" className="small" disabled={!name.trim()} onClick={() => update({ name: name.trim() })}>
                Save
              </button>
            )}
          </span>
        )}
      </td>
      <td>
        {state.is_initial ? (
          <span className="muted small">Initial state</span>
        ) : (
          <span className="inline-edit">
            <select
              aria-label={`Review role for ${state.name}`}
              value={state.review_role ?? ''}
              onChange={(e) =>
                update(e.target.value ? { review_role: e.target.value, review_meaning: state.review_meaning ?? 'Approved' } : { review_role: null, review_meaning: null })
              }
            >
              <option value="">No review</option>
              {REVIEW_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]} must sign
                </option>
              ))}
            </select>
            {state.review_role && (
              <select aria-label={`Signature meaning for ${state.name}`} value={state.review_meaning} onChange={(e) => update({ review_meaning: e.target.value })}>
                {REVIEW_MEANINGS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            )}
          </span>
        )}
      </td>
      <td>
        <input
          type="checkbox"
          aria-label={`${state.name} locks items`}
          checked={state.locks_item}
          disabled={state.is_initial || Boolean(state.review_role)}
          title={state.review_role ? 'Review states always lock items' : undefined}
          onChange={(e) => update({ locks_item: e.target.checked })}
        />
      </td>
      <td>
        {!state.is_initial && (
          <button type="button" className="secondary small" onClick={() => update({ is_retired: !state.is_retired })}>
            {state.is_retired ? 'Restore' : 'Retire'}
          </button>
        )}
      </td>
    </tr>
  )
}

function AddStateForm({ config, run }) {
  const [name, setName] = useState('')
  const [reviewRole, setReviewRole] = useState('')
  const [meaning, setMeaning] = useState('Approved')
  const [locks, setLocks] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    const ok = await run(
      supabase.from('tracker_states').insert({
        tracker_id: config.tracker.id,
        name: name.trim(),
        position: Math.max(0, ...config.states.map((s) => s.position)) + 1,
        review_role: reviewRole || null,
        review_meaning: reviewRole ? meaning : null,
        locks_item: locks,
      }),
    )
    if (ok) {
      setName('')
      setReviewRole('')
      setLocks(false)
    }
  }

  return (
    <form className="form-inline add-state" onSubmit={handleSubmit}>
      <h4>Add a state</h4>
      <div className="form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        </label>
        <label>
          Review gate
          <select value={reviewRole} onChange={(e) => setReviewRole(e.target.value)}>
            <option value="">No review</option>
            {REVIEW_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]} must sign
              </option>
            ))}
          </select>
        </label>
        {reviewRole && (
          <label>
            Signature meaning
            <select value={meaning} onChange={(e) => setMeaning(e.target.value)}>
              {REVIEW_MEANINGS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={locks || Boolean(reviewRole)} disabled={Boolean(reviewRole)} onChange={(e) => setLocks(e.target.checked)} /> Locks items
      </label>
      <p className="muted small">After adding, tick the moves into and out of the new state below.</p>
      <div className="actions">
        <button type="submit" disabled={!name.trim()}>
          Add state
        </button>
      </div>
    </form>
  )
}

/* ---------------------------------------------------------------- Actions */

function ActionsConfig({ config, run, members }) {
  const stateName = (id) => config.states.find((s) => s.id === id)?.name
  const field = (key) => config.fields.find((f) => f.key === key)
  const display = (a) => {
    if (a.action !== 'set_value') return ACTION_LABELS[a.action]
    const f = field(a.field_key)
    const v = f?.field_type === 'user' ? (members.find((m) => m.user_id === a.value)?.full_name ?? a.value) : a.value
    return `Set to "${v}"`
  }

  return (
    <div className="stack">
      <p className="muted small">
        State actions set fields automatically when an item enters or leaves a state, for example "Approved on" = today on entering Approved.
        They don't create a new version, so they never invalidate a signature; they are recorded in the history.
      </p>
      <div className="table-wrap">
        <table aria-label="State actions">
          <thead>
            <tr>
              <th>State</th>
              <th>When</th>
              <th>Field</th>
              <th>Action</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {config.actions.map((a) => (
              <tr key={a.id}>
                <td>{stateName(a.state_id)}</td>
                <td>{a.on_event === 'entry' ? 'On entry' : 'On exit'}</td>
                <td>{field(a.field_key)?.label ?? a.field_key}</td>
                <td>{display(a)}</td>
                <td>
                  <button type="button" className="secondary small" onClick={() => run(supabase.from('tracker_state_actions').delete().eq('id', a.id))}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {config.actions.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No state actions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <AddActionForm config={config} run={run} members={members} />
    </div>
  )
}

const ACTIONS_FOR_TYPE = {
  text: ['set_value', 'set_today', 'set_current_user', 'clear'],
  long_text: ['set_value', 'clear'],
  number: ['set_value', 'clear'],
  date: ['set_value', 'set_today', 'clear'],
  select: ['set_value', 'clear'],
  user: ['set_value', 'set_current_user', 'clear'],
}

function AddActionForm({ config, run, members }) {
  const states = config.states.filter((s) => !s.is_retired)
  const fields = config.fields.filter((f) => !f.is_retired && f.field_type !== 'steps')
  const [stateId, setStateId] = useState(states[0]?.id ?? '')
  const [event, setEvent] = useState('entry')
  const [fieldKey, setFieldKey] = useState(fields[0]?.key ?? '')
  const [action, setAction] = useState('clear')
  const [value, setValue] = useState(null)
  const field = fields.find((f) => f.key === fieldKey)
  const allowed = field ? ACTIONS_FOR_TYPE[field.field_type] : []
  const actionValue = allowed.includes(action) ? action : allowed[0]

  async function handleSubmit(e) {
    e.preventDefault()
    const ok = await run(
      supabase.from('tracker_state_actions').insert({
        tracker_id: config.tracker.id,
        state_id: stateId,
        on_event: event,
        field_key: fieldKey,
        action: actionValue,
        value: actionValue === 'set_value' ? value : null,
      }),
    )
    if (ok) setValue(null)
  }

  if (fields.length === 0) return <p className="muted">Add a field first.</p>

  return (
    <form className="card form-inline" onSubmit={handleSubmit}>
      <h3>Add a state action</h3>
      <div className="form-row">
        <label>
          State
          <select value={stateId} onChange={(e) => setStateId(e.target.value)}>
            {states.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          When
          <select value={event} onChange={(e) => setEvent(e.target.value)}>
            <option value="entry">On entry</option>
            <option value="exit">On exit</option>
          </select>
        </label>
        <label>
          Field
          <select
            value={fieldKey}
            onChange={(e) => {
              setFieldKey(e.target.value)
              setValue(null)
            }}
          >
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Action
          <select value={actionValue} onChange={(e) => setAction(e.target.value)}>
            {allowed.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {actionValue === 'set_value' && field && (
        <FieldInput field={{ ...field, label: 'Value', required: true, help_text: null }} value={value} onChange={setValue} members={members} />
      )}
      <div className="actions">
        <button type="submit" disabled={!stateId || !fieldKey || (actionValue === 'set_value' && (value === null || value === ''))}>
          Add action
        </button>
      </div>
    </form>
  )
}
