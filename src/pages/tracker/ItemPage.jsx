import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useOutletContext, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { isEmpty, loadLinkTypes, loadMembers, loadTracker } from '../../lib/trackers'
import { ACTION_LABELS, formatTimestamp, ROLE_LABELS } from '../../lib/labels'
import FieldValue from '../../components/FieldValue'
import ItemForm from './ItemForm'
import StateBadge from './StateBadge'

async function fetchItem(projectId, typeKey, itemKey) {
  const config = await loadTracker(projectId, typeKey)
  if (!config) return { missing: true }
  const { data: item, error } = await supabase
    .from('items')
    .select('*')
    .eq('tracker_id', config.tracker.id)
    .eq('item_key', itemKey)
    .maybeSingle()
  if (error) throw error
  if (!item) return { missing: true }
  const [members, sigs, versions, audit, links, linkTypes] = await Promise.all([
    loadMembers(projectId),
    supabase.from('item_signatures').select('*').eq('item_id', item.id).order('signed_at'),
    supabase.from('item_versions').select('*').eq('item_id', item.id).order('version', { ascending: false }),
    supabase
      .from('audit_log')
      .select('id, occurred_at, action, changed_by, changed_fields, old_values, new_values, reason')
      .eq('table_name', 'items')
      .eq('record_id', item.id)
      .order('id', { ascending: false }),
    supabase.rpc('item_link_list', { p_item: item.id }),
    loadLinkTypes(projectId),
  ])
  for (const r of [sigs, versions, audit, links]) if (r.error) throw r.error
  return {
    config,
    item,
    members,
    signatures: sigs.data,
    versions: versions.data,
    audit: audit.data,
    links: links.data,
    linkTypes,
  }
}

export default function ItemPage() {
  const { project, can, role, userId } = useOutletContext()
  const { typeKey, itemKey } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(null) // transition being confirmed
  const [signing, setSigning] = useState(false)
  const [tab, setTab] = useState('details')

  const reload = useCallback(
    () => fetchItem(project.id, typeKey, itemKey).then(setData, (e) => setError(e.message)),
    [project.id, typeKey, itemKey],
  )

  useEffect(() => {
    let current = true
    fetchItem(project.id, typeKey, itemKey).then(
      (d) => current && setData(d),
      (e) => current && setError(e.message),
    )
    return () => {
      current = false
    }
  }, [project.id, typeKey, itemKey])

  const stateById = useMemo(() => Object.fromEntries((data?.config?.states ?? []).map((s) => [s.id, s])), [data])

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (!data) return <p className="muted">Loading item…</p>
  if (data.missing) return <p>Item {itemKey} not found.</p>

  const { config, item, members, signatures, versions, audit, links, linkTypes } = data
  const state = stateById[item.state_id]
  const base = `/projects/${project.id}/trackers/${typeKey}`

  // Review gate status for the current stay in this state (SRS-022, SRS-026).
  const currentReview = signatures.find(
    (s) => s.state_id === item.state_id && s.item_version === item.version && new Date(s.signed_at) >= new Date(item.state_entered_at),
  )
  const awaitingReview = Boolean(state.review_role) && !currentReview
  const moves = config.transitions
    .filter((t) => t.from_state_id === item.state_id)
    .map((t) => ({ ...t, to: stateById[t.to_state_id] }))
    .filter((t) => t.to && !t.to.is_retired)
    .sort((a, b) => a.to.position - b.to.position)

  let signBlocker = null
  if (awaitingReview) {
    if (role !== state.review_role) signBlocker = `Only a project ${ROLE_LABELS[state.review_role]} can sign this review.`
    else if (!can('records.sign')) signBlocker = 'Your role cannot sign records in this project.'
    else if (item.version_by === userId) signBlocker = 'You made the current version, so someone else must review it.'
  }

  const fieldsShown = config.fields.filter((f) => !f.is_retired || !isEmpty(item.values[f.key]))

  return (
    <div className="stack">
      <nav className="breadcrumb" aria-label="Item breadcrumb">
        <Link to={`/projects/${project.id}/trackers`}>Trackers</Link> <span aria-hidden="true">/</span>{' '}
        <Link to={base}>{typeKey}</Link> <span aria-hidden="true">/</span> <span>{item.item_key}</span>
      </nav>

      <div className="card-head">
        <div>
          <h2>
            <span className="prefix">{item.item_key}</span> {item.title}
          </h2>
          <span className="muted small">
            Version {item.version} · Updated {formatTimestamp(item.updated_at)}
          </span>
        </div>
        <StateBadge state={state} />
      </div>

      {/* Workflow: path, review gate, and allowed moves */}
      <section className="card workflow-card" aria-label="Workflow">
        <ol className="state-path">
          {config.states
            .filter((s) => !s.is_retired)
            .map((s) => (
              <li key={s.id} className={s.id === state.id ? 'current' : ''}>
                {s.name}
                {s.review_role && <span className="muted small"> · {ROLE_LABELS[s.review_role]} review</span>}
              </li>
            ))}
        </ol>

        {state.review_role && (
          <div className={`review-status ${awaitingReview ? 'pending' : 'done'}`} role="status">
            {awaitingReview ? (
              <>
                <strong>Waiting for review.</strong> A {ROLE_LABELS[state.review_role]} must sign ({state.review_meaning}) before{' '}
                {item.item_key} can move forward. It can't be edited while it waits; to change it, send it back.
              </>
            ) : (
              <>
                <strong>Reviewed.</strong> {currentReview.signer_name} signed {currentReview.meaning} on{' '}
                {formatTimestamp(currentReview.signed_at)} for version {currentReview.item_version}.
              </>
            )}
          </div>
        )}

        <div className="workflow-actions">
          {awaitingReview && !signBlocker && !signing && (
            <button type="button" onClick={() => setSigning(true)}>
              Sign review ({state.review_meaning})…
            </button>
          )}
          {awaitingReview && signBlocker && <span className="muted small">{signBlocker}</span>}
          {can('items.transition') &&
            moves.map((m) => {
              const blocked = awaitingReview && m.to.locks_item
              return (
                <button
                  key={m.id}
                  type="button"
                  className="secondary"
                  disabled={blocked}
                  title={blocked ? 'Needs the review signature first' : undefined}
                  onClick={() => setMoving(m)}
                >
                  Move to {m.to.name}
                </button>
              )
            })}
          {!state.locks_item && can('items.edit') && !editing && (
            <button type="button" className="secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {state.locks_item && !state.review_role && <span className="muted small">{state.name} items are locked. Move back to edit.</span>}
        </div>

        {moving && (
          <MoveForm
            item={item}
            move={moving}
            from={state}
            config={config}
            onCancel={() => setMoving(null)}
            onDone={() => {
              setMoving(null)
              reload()
            }}
          />
        )}
        {signing && (
          <SignForm
            item={item}
            state={state}
            onCancel={() => setSigning(false)}
            onDone={() => {
              setSigning(false)
              reload()
            }}
          />
        )}
      </section>

      {editing && (
        <ItemForm
          config={config}
          members={members}
          item={item}
          requireReason={signatures.length > 0}
          onCancel={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            reload()
          }}
        />
      )}

      <nav className="tabs" aria-label="Item sections">
        {[
          ['details', 'Details'],
          ['signatures', `Signatures (${signatures.length})`],
          ['versions', `Versions (${versions.length})`],
          ['history', 'History'],
        ].map(([key, label]) => (
          <button key={key} type="button" className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'details' && (
        <section className="card">
          <dl className="details">
            {fieldsShown.map((f) => (
              <div key={f.id} className="details-row">
                <dt>
                  {f.label}
                  {f.is_retired && <span className="muted small"> (retired)</span>}
                </dt>
                <dd>
                  <FieldValue field={f} value={item.values[f.key]} members={members} />
                </dd>
              </div>
            ))}
            {item.folder_id && (
              <div className="details-row">
                <dt>Folder</dt>
                <dd>{config.folders.find((f) => f.id === item.folder_id)?.name}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      {tab === 'details' && (
        <Links
          project={project}
          item={item}
          links={links}
          linkTypes={linkTypes.filter((t) => !t.is_retired && (t.source_type_key === typeKey || t.target_type_key === typeKey))}
          outgoingTypes={linkTypes.filter((t) => !t.is_retired && t.source_type_key === typeKey)}
          canChange={can('items.edit') && !state.locks_item}
          locked={state.locks_item}
          requireReason={signatures.length > 0}
          onChanged={reload}
        />
      )}

      {tab === 'signatures' && (
        <section className="card">
          {signatures.length === 0 ? (
            <p className="muted">No signatures yet.</p>
          ) : (
            <ul className="signature-list">
              {[...signatures].reverse().map((s) => {
                const current = s.item_version === item.version && s.state_id === item.state_id && s === currentReview
                return (
                  <li key={s.id} className={s.item_version === item.version ? '' : 'superseded'}>
                    <strong>{s.signer_name}</strong> · {s.meaning} · {ROLE_LABELS[s.signer_role]}
                    <div className="muted small">
                      {formatTimestamp(s.signed_at)} · {s.state_name} · version {s.item_version}
                      {s.item_version !== item.version && ' · does not apply to the current version'}
                      {current && ' · current review'}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {tab === 'versions' && (
        <section className="stack">
          {versions.map((v) => (
            <details key={v.version} className="card version" open={v.version === item.version}>
              <summary>
                <strong>Version {v.version}</strong>
                {v.version === item.version && <span className="muted"> (current)</span>}{' '}
                <span className="muted small">
                  {formatTimestamp(v.created_at)} · {members.find((m) => m.user_id === v.created_by)?.full_name ?? 'Unknown'}
                </span>
              </summary>
              <dl className="details">
                <div className="details-row">
                  <dt>Title</dt>
                  <dd>{v.title}</dd>
                </div>
                {config.fields
                  .filter((f) => !isEmpty(v.values[f.key]))
                  .map((f) => (
                    <div key={f.id} className="details-row">
                      <dt>{f.label}</dt>
                      <dd>
                        <FieldValue field={f} value={v.values[f.key]} members={members} />
                      </dd>
                    </div>
                  ))}
                {v.links?.length > 0 && (
                  <div className="details-row">
                    <dt>Links</dt>
                    <dd>
                      {v.links
                        .map((l) => `${linkTypes.find((t) => t.key === l.type)?.label ?? l.type} ${l.target}`)
                        .join(', ')}
                    </dd>
                  </div>
                )}
              </dl>
            </details>
          ))}
        </section>
      )}

      {tab === 'history' && <History audit={audit} signatures={signatures} config={config} members={members} stateById={stateById} />}
    </div>
  )
}

function actionSummary(config, stateId, event) {
  return config.actions
    .filter((a) => a.state_id === stateId && a.on_event === event)
    .map((a) => {
      const field = config.fields.find((f) => f.key === a.field_key)
      const what = a.action === 'set_value' ? `set to "${a.value}"` : ACTION_LABELS[a.action].toLowerCase()
      return `${field?.label ?? a.field_key}: ${what}`
    })
}

function MoveForm({ item, move, from, config, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const effects = [...actionSummary(config, from.id, 'exit'), ...actionSummary(config, move.to.id, 'entry')]

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('transition_item', {
      p_item: item.id,
      p_to_state: move.to.id,
      p_reason: reason.trim() || null,
    })
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="form-inline move-form" onSubmit={handleSubmit}>
      <h3>
        Move {item.item_key} from {from.name} to {move.to.name}?
      </h3>
      {move.to.review_role && (
        <p className="small">
          {move.to.name} needs a {ROLE_LABELS[move.to.review_role]} review. The item will be locked until then.
        </p>
      )}
      {effects.length > 0 && (
        <p className="small muted">
          Automatically: {effects.join('; ')}.
        </p>
      )}
      <label>
        Reason{move.requires_reason ? ' (required)' : ' (optional)'}
        <input value={reason} onChange={(e) => setReason(e.target.value)} required={move.requires_reason} maxLength={500} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || (move.requires_reason && !reason.trim())}>
          {saving ? 'Moving…' : `Move to ${move.to.name}`}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// Electronic signature: the signer re-enters their password; the database checks it (SRS-023).
function SignForm({ item, state, onCancel, onDone }) {
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('sign_item', { p_item: item.id, p_password: password })
    setSaving(false)
    setPassword('')
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="form-inline signature-dialog" onSubmit={handleSubmit}>
      <h3>Electronic signature</h3>
      <p className="small">
        You are signing <strong>
          {item.item_key} version {item.version}
        </strong>{' '}
        in {state.name} with the meaning <strong>{state.review_meaning}</strong>. Your printed name, the date and time, and this
        meaning will be recorded and shown with the item.
      </p>
      <label>
        Re-enter your password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || !password}>
          {saving ? 'Signing…' : `Sign as ${state.review_meaning}`}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function History({ audit, signatures, config, members, stateById }) {
  const name = (id) => (id ? (members.find((m) => m.user_id === id)?.full_name ?? 'Unknown user') : 'System')
  const fieldLabel = (key) => config.fields.find((f) => f.key === key)?.label ?? key

  function describe(e) {
    if (e.action === 'INSERT') return { what: 'Created', changes: [] }
    const changes = []
    const f = e.changed_fields ?? []
    if (f.includes('title')) changes.push(['Title', e.old_values.title, e.new_values.title])
    if (f.includes('values')) {
      const o = e.old_values.values ?? {}
      const n = e.new_values.values ?? {}
      for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
        if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) {
          const show = (v) => (isEmpty(v) ? '(empty)' : Array.isArray(v) ? `${v.length} steps` : String(v))
          changes.push([fieldLabel(k), show(o[k]), show(n[k])])
        }
      }
    }
    if (f.includes('folder_id')) changes.push(['Folder', 'changed', ''])
    if (f.includes('state_id')) {
      return {
        what: `Moved ${stateById[e.old_values.state_id]?.name ?? '?'} → ${stateById[e.new_values.state_id]?.name ?? '?'}`,
        changes,
      }
    }
    const link = e.reason?.match(/^(Link (?:added|removed): [^:]+)/)
    if (f.includes('version') && link && changes.length === 0) return { what: `${link[1]} (version ${e.new_values.version})`, changes }
    if (f.includes('version')) return { what: `Edited (version ${e.new_values.version})`, changes }
    return { what: 'Updated', changes }
  }

  // Audit entries and signatures, newest first.
  const rows = [
    ...audit.map((e) => ({ ...e, at: e.occurred_at })),
    ...signatures.map((s) => ({ signature: s, at: s.signed_at, id: `s${s.id}` })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at))

  return (
    <div className="table-wrap">
      <table aria-label="Item history">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Changes</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            if (e.signature) {
              const s = e.signature
              return (
                <tr key={`sig-${s.id}`} className="signature-row">
                  <td className="nowrap small">{formatTimestamp(s.signed_at)}</td>
                  <td>{s.signer_name}</td>
                  <td>
                    Signed: <strong>{s.meaning}</strong>
                  </td>
                  <td className="small muted">
                    {s.state_name} review · version {s.item_version} · password re-entered
                  </td>
                  <td>
                    <span className="muted">—</span>
                  </td>
                </tr>
              )
            }
            const d = describe(e)
            const reason = e.reason?.replace(/^Moved from .+? to .+?(: |$)/, '').replace(/^Link (added|removed): [^:]+(: |$)/, '') || ''
            return (
              <tr key={e.id}>
                <td className="nowrap small">{formatTimestamp(e.occurred_at)}</td>
                <td>{name(e.changed_by)}</td>
                <td>{d.what}</td>
                <td>
                  {d.changes.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <ul className="changes">
                      {d.changes.map(([label, from, to]) => (
                        <li key={label}>
                          <span className="muted">{label}:</span> <del>{from}</del> → <ins>{to}</ins>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{reason || <span className="muted">—</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Links to and from this item (SRS-019). Links belong to the item they start from,
// so only those can be added or removed here, and only while this item is editable.
function Links({ project, item, links, linkTypes, outgoingTypes, canChange, locked, requireReason, onChanged }) {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(null)
  const groups = {}
  for (const l of links) (groups[`${l.direction}:${l.label}`] ??= { label: l.label, direction: l.direction, links: [] }).links.push(l)
  const sorted = Object.values(groups).sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1))

  if (linkTypes.length === 0) return null

  return (
    <section className="card stack-sm" aria-label="Links">
      <div className="card-head">
        <h3>Links</h3>
        {canChange && outgoingTypes.length > 0 && !adding && (
          <button type="button" className="secondary small" onClick={() => setAdding(true)}>
            Add link
          </button>
        )}
      </div>
      {sorted.length === 0 && <p className="muted small">No links yet.</p>}
      {sorted.map((g) => (
        <div key={`${g.direction}:${g.label}`}>
          <h4 className="small muted link-group">
            {item.item_key} {g.label}
          </h4>
          <ul className="link-list">
            {g.links.map((l) => (
              <li key={l.link_id} className="link-row">
                <span>
                  <Link to={`/projects/${project.id}/trackers/${l.other_type_key}/${l.other_item_key}`} className="prefix">
                    {l.other_item_key}
                  </Link>{' '}
                  {l.other_title} <span className="muted small">· {l.other_state}</span>
                </span>
                {l.direction === 'out' && canChange && removing?.link_id !== l.link_id && (
                  <button type="button" className="secondary small" onClick={() => setRemoving(l)}>
                    Remove
                  </button>
                )}
                {removing?.link_id === l.link_id && (
                  <LinkChange
                    title={`Remove link: ${item.item_key} ${l.label} ${l.other_item_key}?`}
                    submitLabel="Remove link"
                    requireReason={requireReason}
                    onCancel={() => setRemoving(null)}
                    onSubmit={(reason) => supabase.rpc('remove_item_link', { p_link: l.link_id, p_reason: reason })}
                    onDone={() => {
                      setRemoving(null)
                      onChanged()
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {adding && (
        <AddLink
          project={project}
          item={item}
          types={outgoingTypes}
          existing={links.filter((l) => l.direction === 'out')}
          requireReason={requireReason}
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            onChanged()
          }}
        />
      )}
      {outgoingTypes.length > 0 && (
        <p className="muted small">
          {locked
            ? `${item.item_key} is locked, so its links can't change. Move it back to an editable state first.`
            : `Adding or removing a link creates a new version of ${item.item_key}.`}
        </p>
      )}
    </section>
  )
}

function AddLink({ project, item, types, existing, requireReason, onCancel, onDone }) {
  const [typeKey, setTypeKey] = useState(types[0].key)
  const [targets, setTargets] = useState(null)
  const [target, setTarget] = useState('')
  const type = types.find((t) => t.key === typeKey)

  useEffect(() => {
    let current = true
    supabase
      .from('items')
      .select('item_key, title, number')
      .eq('project_id', project.id)
      .like('item_key', `${type.target_type_key}-%`)
      .order('number')
      .then(({ data }) => current && setTargets(data ?? []))
    return () => {
      current = false
    }
  }, [project.id, type.target_type_key])

  const taken = new Set(existing.filter((l) => l.link_type === typeKey).map((l) => l.other_item_key))
  const options = (targets ?? []).filter((t) => !taken.has(t.item_key) && t.item_key !== item.item_key)

  return (
    <LinkChange
      title={`Add a link from ${item.item_key}`}
      submitLabel="Add link"
      requireReason={requireReason}
      canSubmit={Boolean(target)}
      onCancel={onCancel}
      onSubmit={(reason) =>
        supabase.rpc('add_item_link', { p_item: item.id, p_link_type: typeKey, p_target: target, p_reason: reason })
      }
      onDone={onDone}
    >
      <div className="form-row">
        <label>
          Link type
          <select
            value={typeKey}
            onChange={(e) => {
              setTypeKey(e.target.value)
              setTarget('')
              setTargets(null)
            }}
          >
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {item.item_key} {t.label} {t.target_type_key}
              </option>
            ))}
          </select>
        </label>
        <label>
          {type.target_type_key} item
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!targets}>
            <option value="">{targets ? (options.length ? 'Choose…' : `No ${type.target_type_key} items to link`) : 'Loading…'}</option>
            {options.map((t) => (
              <option key={t.item_key} value={t.item_key}>
                {t.item_key} {t.title}
              </option>
            ))}
          </select>
        </label>
      </div>
    </LinkChange>
  )
}

// Confirm a link change, with a reason (required once the item has been reviewed).
function LinkChange({ title, submitLabel, requireReason, canSubmit = true, onSubmit, onCancel, onDone, children }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await onSubmit(reason.trim() || null)
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="form-inline link-form" onSubmit={handleSubmit}>
      <h4>{title}</h4>
      {children}
      <label>
        Reason{requireReason ? ' (required: this item has been reviewed before)' : ' (optional)'}
        <input value={reason} onChange={(e) => setReason(e.target.value)} required={requireReason} maxLength={500} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="small" disabled={saving || !canSubmit || (requireReason && !reason.trim())}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="secondary small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
