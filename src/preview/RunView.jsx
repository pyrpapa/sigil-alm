import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import PreviewBanner from './PreviewBanner'
import StateBadge from './StateBadge'
import ScreenRecorder from './ScreenRecorder'
import { getItem, NEXT_RUN_KEY } from './sampleData'
import { formatTimestamp } from '../lib/labels'

// Manual test execution (SRS-035 to SRS-038, SRS-049, SRS-050): step by step,
// pass/fail or recorded values, deviation on failure, evidence for the whole run
// (files and screen recordings), then the executor's signature.
export default function RunView() {
  const { projectId, itemKey } = useParams()
  const tc = getItem(itemKey)
  const [steps, setSteps] = useState(() =>
    (tc?.steps ?? []).map(() => ({ actual: '', autoFilled: false, values: {}, outcome: null, deviation: false })),
  )
  const [evidence, setEvidence] = useState([]) // { id, name, size, kind: 'file' | 'recording', url?, step: '' | index }
  const [stage, setStage] = useState('executing') // executing | signing | done
  const [startedAt] = useState(() => new Date().toISOString())
  const [password, setPassword] = useState('')
  const [signedAt, setSignedAt] = useState(null)

  if (!tc || tc.tracker !== 'TC') return <p>Test case not found.</p>

  const formal = tc.state === 'Approved'
  const locked = stage !== 'executing'
  const done = steps.filter((s) => s.outcome).length
  const failed = steps.filter((s) => s.outcome === 'Fail').length
  const allRecorded = done === steps.length
  const needReason = steps.map((s, i) => (s.outcome === 'Fail' && !s.actual.trim() ? i + 1 : null)).filter(Boolean)
  const missingActual = needReason.length > 0
  const overall = failed ? 'Failed' : 'Passed'

  function update(index, patch) {
    setSteps((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  // Pass on a verification step: the actual result matched the expected result, so it is
  // filled in from the expected result unless the tester already typed something (SRS-035).
  function pass(i) {
    const s = steps[i]
    if (s.actual.trim()) update(i, { outcome: 'Pass', deviation: false })
    else update(i, { outcome: 'Pass', deviation: false, actual: tc.steps[i].expected, autoFilled: true })
  }

  // Fail: anything filled in automatically is cleared so the tester describes what really happened.
  function fail(i) {
    const s = steps[i]
    update(i, { outcome: 'Fail', ...(s.autoFilled ? { actual: '', autoFilled: false } : {}) })
    // Put the cursor straight into the failure description.
    requestAnimationFrame(() => document.getElementById(`actual-${i}`)?.focus())
  }

  function addEvidence(items) {
    setEvidence((cur) => [...cur, ...items.map((e) => ({ id: crypto.randomUUID(), step: '', ...e }))])
  }

  function removeEvidence(id) {
    setEvidence((cur) => {
      const e = cur.find((x) => x.id === id)
      if (e?.url) URL.revokeObjectURL(e.url)
      return cur.filter((x) => x.id !== id)
    })
  }

  return (
    <div className="stack">
      <PreviewBanner>Sample test cases; runs and evidence are not saved. Real test execution arrives in Phase 3.</PreviewBanner>

      <nav className="breadcrumb" aria-label="Run breadcrumb">
        <Link to={`/projects/${projectId}/preview`}>Test run preview</Link> <span aria-hidden="true">/</span> <span>{tc.key} new run</span>
      </nav>

      <div className="card run-header">
        <div>
          <h2>
            Executing <span className="prefix">{tc.key}</span> {tc.title}
          </h2>
          <span className="muted small">
            Test case version {tc.version} · Started {formatTimestamp(startedAt)} · Run {NEXT_RUN_KEY}
          </span>
        </div>
        <div className="run-meta">
          <StateBadge value={formal ? 'Formal run' : 'Dry run'} />
          <span className="muted small">
            {done} of {steps.length} steps recorded
          </span>
        </div>
      </div>
      {!locked && <ScreenRecorder fileName={`${NEXT_RUN_KEY}-screen-recording`} onRecorded={(rec) => addEvidence([rec])} />}
      {!formal && (
        <p className="notice small">
          {tc.key} version {tc.version} isn't approved, so this is a dry run. It's kept for debugging and doesn't count toward coverage.
        </p>
      )}

      <ol className="run-steps">
        {tc.steps.map((step, i) => {
          const s = steps[i]
          const isDoc = step.kind === 'document'
          const missingValues = isDoc && step.fields.some((f) => !(s.values[f] ?? '').trim())
          const badge = s.outcome === 'Fail' ? 'Failed' : s.outcome ? (isDoc ? 'Recorded' : 'Passed') : null
          return (
            <li key={i} className={`card run-step${s.outcome ? ` outcome-${s.outcome.toLowerCase()}` : ''}`}>
              <div className="run-step-head">
                <strong>
                  Step {i + 1}
                  {isDoc && <span className="step-kind"> Documentation</span>}
                </strong>
                {badge && <StateBadge value={badge} />}
              </div>

              {isDoc ? (
                <>
                  <div>
                    <div className="muted small">Action</div>
                    {step.action}
                  </div>
                  <div className="record-grid">
                    {step.fields.map((f) => (
                      <label key={f}>
                        {f}
                        <input
                          value={s.values[f] ?? ''}
                          disabled={locked}
                          onChange={(e) => update(i, { values: { ...s.values, [f]: e.target.value } })}
                        />
                      </label>
                    ))}
                  </div>
                  {s.outcome === 'Fail' && (
                    <ActualResult index={i} step={s} locked={locked} onChange={(v) => update(i, { actual: v })} />
                  )}
                  <div className="run-step-actions end">
                    <div className="actions">
                      <button
                        type="button"
                        className={s.outcome === 'Pass' ? '' : 'secondary'}
                        disabled={locked || missingValues}
                        title={missingValues ? 'Fill in every value first' : undefined}
                        onClick={() => update(i, { outcome: 'Pass', deviation: false })}
                      >
                        Recorded
                      </button>
                      <button type="button" className={s.outcome === 'Fail' ? 'danger' : 'secondary'} disabled={locked} onClick={() => fail(i)}>
                        Fail
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="run-step-grid">
                    <div>
                      <div className="muted small">Action</div>
                      {step.action}
                    </div>
                    <div>
                      <div className="muted small">Expected result</div>
                      {step.expected}
                    </div>
                  </div>
                  <ActualResult index={i} step={s} locked={locked} onChange={(v) => update(i, { actual: v, autoFilled: false })} />
                  <div className="run-step-actions end">
                    <div className="actions">
                      <button type="button" className={s.outcome === 'Pass' ? '' : 'secondary'} disabled={locked} onClick={() => pass(i)}>
                        Pass
                      </button>
                      <button type="button" className={s.outcome === 'Fail' ? 'danger' : 'secondary'} disabled={locked} onClick={() => fail(i)}>
                        Fail
                      </button>
                    </div>
                  </div>
                </>
              )}

              {s.outcome === 'Fail' && (
                <div className="notice small">
                  {s.deviation ? (
                    <>Deviation DEV-002 will be opened and linked to this step, {NEXT_RUN_KEY}, {tc.key} and the requirements it verifies.</>
                  ) : (
                    <>
                      This step failed. A deviation should be opened so the failure is investigated.{' '}
                      <button type="button" className="secondary small" disabled={locked} onClick={() => update(i, { deviation: true })}>
                        Open deviation
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>

      <section className="card stack-sm" aria-labelledby="evidence-heading">
        <h3 id="evidence-heading">Evidence</h3>
        <p className="muted small">
          Attach screenshots, exports or a screen recording for the whole run. Optionally say which step a file supports.
        </p>
        {evidence.length > 0 && (
          <ul className="evidence-list" aria-label="Attached evidence">
            {evidence.map((e) => (
              <li key={e.id} className="evidence-item">
                <div className="evidence-main">
                  <span>
                    {e.kind === 'recording' ? '🎥' : '📎'} {e.name} <span className="muted small">{formatSize(e.size)}</span>
                  </span>
                  {e.kind === 'recording' && e.url && <video src={e.url} controls className="evidence-video" aria-label={`Preview of ${e.name}`} />}
                </div>
                <div className="evidence-tools">
                  <label className="inline-label small">
                    Supports
                    <select
                      value={e.step}
                      disabled={locked}
                      onChange={(ev) => setEvidence((cur) => cur.map((x) => (x.id === e.id ? { ...x, step: ev.target.value } : x)))}
                    >
                      <option value="">Whole run</option>
                      {tc.steps.map((_, i) => (
                        <option key={i} value={i}>
                          Step {i + 1}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!locked && (
                    <button type="button" className="secondary small" onClick={() => removeEvidence(e.id)} aria-label={`Remove ${e.name}`}>
                      ✕
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!locked && (
          <label className="file-label">
            Attach files
            <input
              type="file"
              multiple
              onChange={(e) => {
                addEvidence([...e.target.files].map((f) => ({ name: f.name, size: f.size, kind: 'file' })))
                e.target.value = ''
              }}
            />
          </label>
        )}
      </section>

      {stage === 'executing' && (
        <div className="card run-footer">
          <span>
            {allRecorded ? (
              <>
                Overall result: <StateBadge value={overall} />
              </>
            ) : (
              <span className="muted">Record every step to finish.</span>
            )}
            {missingActual && (
              <div className="error small">
                Describe what actually happened for failed step{needReason.length > 1 ? 's' : ''} {needReason.join(', ')}.
              </div>
            )}
            {allRecorded && evidence.length === 0 && <div className="muted small">No evidence attached.</div>}
          </span>
          <button type="button" disabled={!allRecorded || missingActual} onClick={() => setStage('signing')}>
            Finish and sign…
          </button>
        </div>
      )}

      {stage === 'signing' && (
        <form
          className="card form-inline signature-dialog"
          onSubmit={(e) => {
            e.preventDefault()
            setSignedAt(new Date().toISOString())
            setStage('done')
          }}
        >
          <h3>Executor signature</h3>
          <p className="small">
            You are signing {NEXT_RUN_KEY} ({tc.key} version {tc.version}, {formal ? 'formal run' : 'dry run'}, result {overall},{' '}
            {evidence.length === 1 ? '1 evidence file' : `${evidence.length} evidence files`}) with the meaning <strong>Executed</strong>.
          </p>
          <label>
            Re-enter your password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          <div className="actions">
            <button type="submit" disabled={!password}>
              Sign as Executed
            </button>
            <button type="button" className="secondary" onClick={() => setStage('executing')}>
              Back
            </button>
          </div>
        </form>
      )}

      {stage === 'done' && (
        <div className="card">
          <h3>
            {NEXT_RUN_KEY} recorded (preview) <StateBadge value={overall} />
          </h3>
          <p className="small">
            Executed and signed by you at {formatTimestamp(signedAt)}. Next, a different user reviews the results and evidence and signs as
            Reviewed. Until then the run shows as <StateBadge value="Pending review" /> on {tc.key}.
          </p>
          <Link to={`/projects/${projectId}/preview`}>Back to the preview</Link>
        </div>
      )}
    </div>
  )
}

// Actual result box. On a failed step it becomes a required failure description:
// red outline, a "required" label and a message until something is entered.
function ActualResult({ index, step, locked, onChange }) {
  const failed = step.outcome === 'Fail'
  const needed = failed && !step.actual.trim()
  const id = `actual-${index}`
  return (
    <label htmlFor={id} className={needed ? 'needs-reason' : undefined}>
      <span>
        {failed ? 'What actually happened?' : 'Actual result'}
        {failed && <span className="required"> * required for a failed step</span>}
        {step.autoFilled && <span className="muted small"> · filled in from the expected result</span>}
      </span>
      <textarea
        id={id}
        rows={failed ? 3 : 2}
        value={step.actual}
        disabled={locked}
        aria-invalid={needed || undefined}
        aria-describedby={needed ? `${id}-msg` : undefined}
        onChange={(e) => onChange(e.target.value)}
        placeholder={failed ? 'Describe what you saw instead of the expected result' : 'Leave blank and select Pass if it matched the expected result'}
      />
      {needed && (
        <span id={`${id}-msg`} className="error small">
          Enter the failure reason. The run can't be finished until every failed step has one.
        </span>
      )}
    </label>
  )
}

function formatSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
