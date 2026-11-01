import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import FieldValue from '../../components/FieldValue'
import { isEmpty } from '../../lib/trackers'

const WIDE = new Set(['statements', 'steps', 'long_text'])

// Load one item (and its pair partner) for review: latest values, the approved values to
// compare against, and the fields of each tracker.
async function loadReview(row, projectId) {
  const keys = [row.item_key, row.pair_key].filter(Boolean)
  const heads = await supabase.from('item_heads').select('*').eq('project_id', projectId).in('item_key', keys)
  if (heads.error) throw heads.error
  const trackerIds = [...new Set(heads.data.map((h) => h.tracker_id))]
  const approvedIds = heads.data.map((h) => h.approved_revision_id).filter(Boolean)
  const [fields, approved] = await Promise.all([
    supabase.from('tracker_fields').select('*').in('tracker_id', trackerIds).eq('is_retired', false).order('position').order('created_at'),
    approvedIds.length ? supabase.from('item_revisions').select('id, values').in('id', approvedIds) : { data: [] },
  ])
  for (const r of [fields, approved]) if (r.error) throw r.error
  const side = (key) => {
    const head = heads.data.find((h) => h.item_key === key)
    if (!head) return null
    const before = head.approved_revision_id ? approved.data.find((a) => a.id === head.approved_revision_id)?.values : null
    return {
      head,
      before,
      fields: fields.data.filter((f) => f.tracker_id === head.tracker_id),
    }
  }
  return {
    main: side(row.item_key),
    pair: row.pair_key ? side(row.pair_key) : null,
  }
}

// Review an item in place, below its row in the Reviews tab. A requirement and its test case
// are shown side by side, each ER lined up with the step that verifies it, with anything that
// is missing, not word-for-word, or changed since the approved version flagged. Sign or send
// back from the bar at the bottom, which stays in view while scrolling through a long pair.
export default function ReviewPanel({ row, projectId, itemUrl, position, onPrev, onNext, onClose, onSigned, onSentBack }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState(null) // null | 'sign' | 'reject'
  const ref = useRef(null)

  useEffect(() => {
    let current = true
    loadReview(row, projectId).then(
      (d) => current && setData(d),
      (e) => current && setError(e.message),
    )
    return () => {
      current = false
    }
  }, [row, projectId])

  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [row.item_id])

  const canAct = row.kind === 'review' && row.for_me

  return (
    <div
      className="review-panel"
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !mode) onClose()
      }}
    >
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted">Loading {row.item_key}…</p>}
      {data && (data.pair ? <PairView data={data} /> : <SingleView side={data.main} />)}

      <div className="review-bar">
        {mode === 'sign' && <SignForm row={row} onCancel={() => setMode(null)} onDone={onSigned} />}
        {mode === 'reject' && data && <RejectForm row={row} data={data} onCancel={() => setMode(null)} onDone={onSentBack} />}
        {!mode && (
          <>
            {canAct && (
              <>
                <button type="button" onClick={() => setMode('sign')}>
                  {row.pair_key ? 'Sign pair…' : 'Sign…'}
                </button>
                <button type="button" className="secondary" onClick={() => setMode('reject')} disabled={!data}>
                  Send back…
                </button>
              </>
            )}
            {!canAct && row.kind === 'review' && <span className="muted small">Not waiting on your signature.</span>}
            {row.kind === 'rework' && <span className="muted small">Sent back. Edit it on the full page.</span>}
            <span className="review-bar-links small">
              Full page:{' '}
              <Link to={itemUrl(row.type_key, row.item_key)} className="prefix">
                {row.item_key}
              </Link>
              {row.pair_key && (
                <>
                  {' · '}
                  <Link to={itemUrl(row.pair_type_key, row.pair_key)} className="prefix">
                    {row.pair_key}
                  </Link>
                </>
              )}
            </span>
            <span className="review-bar-nav">
              <span className="muted small">{position}</span>
              <button type="button" className="secondary small" onClick={onPrev} disabled={!onPrev} aria-label="Previous item">
                ↑ Previous
              </button>
              <button type="button" className="secondary small" onClick={onNext} disabled={!onNext} aria-label="Next item">
                ↓ Next
              </button>
              <button type="button" className="secondary small" onClick={onClose} aria-label="Close review">
                ✕
              </button>
            </span>
          </>
        )}
      </div>
    </div>
  )
}

// The short fields of an item (anything that is not an ER list, steps or long text).
function ShortFields({ side }) {
  const fields = side.fields.filter((f) => !WIDE.has(f.field_type) && !isEmpty(side.head.values?.[f.key]) && f.key !== 'approved_on')
  if (fields.length === 0) return null
  return (
    <dl className="details review-details">
      {fields.map((f) => (
        <Field key={f.id} label={f.label} changed={changed(side, f.key)}>
          <FieldValue field={f} value={side.head.values[f.key]} />
        </Field>
      ))}
    </dl>
  )
}

function LongFields({ side }) {
  const fields = side.fields.filter((f) => f.field_type === 'long_text' && !isEmpty(side.head.values?.[f.key]))
  return fields.map((f) => (
    <section key={f.id} className="stack-sm">
      <h5>
        {f.label}
        {changed(side, f.key) && <ChangedTag />}
      </h5>
      <FieldValue field={f} value={side.head.values[f.key]} />
    </section>
  ))
}

function Field({ label, changed, children }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {children}
        {changed && <ChangedTag />}
      </dd>
    </>
  )
}

const ChangedTag = ({ isNew }) => (
  <span className="badge badge-warn changed-tag" title={isNew ? 'Not in the approved version' : 'Different from the approved version'}>
    {isNew ? 'new' : 'changed'}
  </span>
)
const changed = (side, key) => side.before && JSON.stringify(side.before[key] ?? null) !== JSON.stringify(side.head.values?.[key] ?? null)

function SideHead({ label, side }) {
  return (
    <div className="review-side-head">
      <span className="eyebrow">{label}</span>
      <h4>
        <span className="prefix">{side.head.item_key}</span> {side.head.title}
      </h4>
      <span className="muted small">
        Version {side.head.revision}
        {side.head.approved_revision ? ` · compared with approved version ${side.head.approved_revision}` : ' · never approved'}
      </span>
    </div>
  )
}

// An item without a pair: every field, top to bottom.
function SingleView({ side }) {
  const wide = side.fields.filter((f) => (f.field_type === 'statements' || f.field_type === 'steps') && !isEmpty(side.head.values?.[f.key]))
  return (
    <div className="stack">
      <SideHead label="Item" side={side} />
      <ShortFields side={side} />
      <LongFields side={side} />
      {wide.map((f) => (
        <section key={f.id} className="stack-sm">
          <h5>
            {f.label}
            {changed(side, f.key) && <ChangedTag />}
          </h5>
          <FieldValue field={f} value={side.head.values[f.key]} context={{ itemKey: side.head.item_key }} />
        </section>
      ))}
    </div>
  )
}

// A requirement and its test case: details side by side, then one row per ER with the
// step(s) that verify it, then any steps not tied to an ER (setup, clean-up).
function PairView({ data }) {
  const { main, pair } = data
  if (!pair) return <SingleView side={main} />
  const srs = main
  const tc = pair
  const erField = srs.fields.find((f) => f.field_type === 'statements')
  const stepField = tc.fields.find((f) => f.field_type === 'steps')
  const ers = (erField && srs.head.values?.[erField.key]) || []
  const steps = (stepField && tc.head.values?.[stepField.key]) || []
  const oldErs = (erField && srs.before?.[erField.key]) || null
  const oldSteps = (stepField && tc.before?.[stepField.key]) || null

  const numbered = steps.map((s, i) => ({ ...s, no: i + 1 }))
  const erKey = (e) => `${srs.head.item_key}.${e.n}`
  const keys = new Set(ers.map(erKey))
  const loose = numbered.filter((s) => !s.er || !keys.has(s.er))
  const covered = ers.filter((e) => numbered.some((s) => s.er === erKey(e))).length
  const mismatched = numbered.filter((s) => {
    const e = ers.find((x) => erKey(x) === s.er)
    return e && s.kind !== 'document' && (s.expected ?? '').trim() !== (e.text ?? '').trim()
  }).length
  // null: unchanged (or nothing approved to compare with); 'new' or 'changed' otherwise
  const erChange = (e) => {
    if (!oldErs) return null
    const old = oldErs.find((o) => o.n === e.n)
    return !old ? 'new' : old.text !== e.text ? 'changed' : null
  }
  const stepChange = (s) => {
    if (!oldSteps) return null
    const old = oldSteps[s.no - 1]
    return !old ? 'new' : JSON.stringify(old) !== JSON.stringify(steps[s.no - 1]) ? 'changed' : null
  }

  return (
    <div className="stack">
      <div className="review-sides">
        <div className="stack-sm">
          <SideHead label="Requirement" side={srs} />
          <ShortFields side={srs} />
          <LongFields side={srs} />
        </div>
        <div className="stack-sm">
          <SideHead label="Test case" side={tc} />
          <ShortFields side={tc} />
          <LongFields side={tc} />
        </div>
      </div>

      <div className="review-checks">
        <span className={`badge ${covered === ers.length && ers.length > 0 ? 'badge-good' : 'badge-warn'}`}>
          {covered} of {ers.length} ERs have a step
        </span>
        <span className={`badge ${mismatched === 0 ? 'badge-good' : 'badge-warn'}`}>
          {mismatched === 0
            ? 'Expected results match the ERs word for word'
            : `${mismatched} expected ${mismatched === 1 ? 'result differs' : 'results differ'} from the ER`}
        </span>
        {loose.length > 0 && (
          <span className="badge">
            {loose.length} other {loose.length === 1 ? 'step' : 'steps'}
          </span>
        )}
      </div>

      <div className="table-wrap">
        <table className="er-step-table" aria-label={`${srs.head.item_key} ERs and ${tc.head.item_key} steps`}>
          <thead>
            <tr>
              <th className="col-er">
                {srs.head.item_key} · {erField?.label ?? 'ERs'}
              </th>
              <th className="col-step-no">Step</th>
              <th>{tc.head.item_key} · Action</th>
              <th>Expected result</th>
            </tr>
          </thead>
          <tbody>
            {ers.map((e) => {
              const matches = numbered.filter((s) => s.er === erKey(e))
              const rows = matches.length ? matches : [null]
              return rows.map((s, i) => (
                <tr key={`${e.n}-${s?.no ?? 'none'}`} className={!s ? 'is-missing' : undefined}>
                  {i === 0 && (
                    <td rowSpan={rows.length} className="er-cell">
                      <span className="er-key">{erKey(e)}</span>
                      <span className="prewrap">{e.text}</span>
                      {erChange(e) && <ChangedTag isNew={erChange(e) === 'new'} />}
                    </td>
                  )}
                  {s ? (
                    <StepCells step={s} er={e} change={stepChange(s)} />
                  ) : (
                    <td colSpan={3} className="warn-cell">
                      No step verifies this ER
                    </td>
                  )}
                </tr>
              ))
            })}
            {loose.map((s) => (
              <tr key={`loose-${s.no}`}>
                <td className="er-cell muted small">{s.er ? `${s.er} (not in this requirement)` : 'Not tied to an ER'}</td>
                <StepCells step={s} change={stepChange(s)} />
              </tr>
            ))}
            {ers.length === 0 && loose.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No ERs or steps written yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StepCells({ step, er, change }) {
  const doc = step.kind === 'document'
  const differs = er && !doc && (step.expected ?? '').trim() !== (er.text ?? '').trim()
  return (
    <>
      <td className="nowrap">
        {step.no}
        {change && <ChangedTag isNew={change === 'new'} />}
      </td>
      <td className="prewrap">{step.action}</td>
      <td className={`prewrap${differs ? ' warn-cell' : ''}`}>
        {doc ? (
          <>
            <span className="step-kind">Record</span>
            <ul className="record-list">
              {(step.fields ?? []).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </>
        ) : (
          step.expected
        )}
        {differs && <div className="small">Not word for word with the ER</div>}
      </td>
    </>
  )
}

// Sign and move on to the next stage, with the password re-entered (SRS-023).
function SignForm({ row, onCancel, onDone }) {
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('sign_and_advance', {
      p_item: row.item_id,
      p_password: password,
    })
    setSaving(false)
    setPassword('')
    if (error) setError(error.message)
    else onDone()
  }
  return (
    <form className="review-bar-form" onSubmit={handleSubmit}>
      <span className="small">
        Sign {row.item_key}
        {row.pair_key && ` and ${row.pair_key}`} ({row.state})
      </span>
      <input
        type="password"
        aria-label={`Password to sign ${row.item_key}`}
        placeholder="Your password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoFocus
      />
      <button type="submit" disabled={saving || !password}>
        {saving ? 'Signing…' : 'Sign'}
      </button>
      <button type="button" className="secondary" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="error small">{error}</span>}
    </form>
  )
}

// Send back: a reason is required; comments can be pinned to an ER or a step.
function RejectForm({ row, data, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [comments, setComments] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const erField = data.main.fields.find((f) => f.field_type === 'statements')
  const stepField = data.pair?.fields.find((f) => f.field_type === 'steps')
  const anchors = [
    ...((erField && data.main.head.values?.[erField.key]) || []).map((e) => [row.item_key, `${row.item_key}.${e.n}`]),
    ...((stepField && data.pair.head.values?.[stepField.key]) || []).map((_, i) => [row.pair_key, `Step ${i + 1}`]),
  ]

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('reject_item', {
      p_item: row.item_id,
      p_reason: reason.trim(),
      p_comments: comments
        .filter((c) => c.body.trim())
        .map((c) => {
          const [item, anchor] = c.anchor ? c.anchor.split('|') : [row.item_key, '']
          return { item, anchor, body: c.body.trim() }
        }),
    })
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="review-bar-form review-reject" onSubmit={handleSubmit}>
      <strong className="small">Send {row.pair_key ? `${row.item_key} and ${row.pair_key}` : row.item_key} back</strong>
      <label>
        What needs to change (required)
        <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} autoFocus />
      </label>
      {comments.map((c, i) => (
        <div key={i} className="comment-row">
          <select
            aria-label={`Comment ${i + 1} is about`}
            value={c.anchor}
            onChange={(e) => setComments(comments.map((x, j) => (j === i ? { ...x, anchor: e.target.value } : x)))}
          >
            <option value="">The whole item</option>
            {anchors.map(([key, a]) => (
              <option key={`${key}|${a}`} value={`${key}|${a}`}>
                {a.startsWith('Step') ? `${key} ${a}` : a}
              </option>
            ))}
          </select>
          <input
            aria-label={`Comment ${i + 1}`}
            value={c.body}
            onChange={(e) => setComments(comments.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))}
          />
          <button
            type="button"
            className="secondary small"
            onClick={() => setComments(comments.filter((_, j) => j !== i))}
            aria-label="Remove comment"
          >
            ✕
          </button>
        </div>
      ))}
      <div className="actions">
        <button type="button" className="secondary small" onClick={() => setComments([...comments, { anchor: '', body: '' }])}>
          Add a comment on an ER or step
        </button>
        <span className="spacer" />
        <button type="submit" disabled={saving || !reason.trim()}>
          {saving ? 'Sending…' : 'Send back'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
