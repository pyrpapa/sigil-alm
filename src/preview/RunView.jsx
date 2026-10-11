import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import PreviewBanner from './PreviewBanner'
import StateBadge from './StateBadge'
import { getItem, itemPath, NEXT_RUN_KEY } from './sampleData'
import { formatTimestamp } from '../lib/labels'

// Manual test execution (SRS-035 to SRS-038): step by step, actual results,
// pass/fail, evidence, deviation on failure, then executor and reviewer signatures.
export default function RunView() {
  const { projectId, itemKey } = useParams()
  const tc = getItem(itemKey)
  const [steps, setSteps] = useState(() => (tc?.steps ?? []).map(() => ({ actual: '', outcome: null, evidence: [], deviation: false })))
  const [stage, setStage] = useState('executing') // executing | signing | done
  const [startedAt] = useState(() => new Date().toISOString())
  const [password, setPassword] = useState('')
  const [signedAt, setSignedAt] = useState(null)

  if (!tc || tc.tracker !== 'TC') return <p>Test case not found.</p>

  const formal = tc.state === 'Approved'
  const done = steps.filter((s) => s.outcome).length
  const failed = steps.filter((s) => s.outcome === 'Fail').length
  const allRecorded = done === steps.length
  const missingActual = steps.some((s) => s.outcome && !s.actual.trim())
  const overall = failed ? 'Failed' : 'Passed'

  function update(index, patch) {
    setSteps((current) => current.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  return (
    <div className="stack">
      <PreviewBanner>Runs are not saved. Real test execution arrives in Phase 3.</PreviewBanner>

      <nav className="breadcrumb" aria-label="Run breadcrumb">
        <Link to={`/projects/${projectId}/trackers/TC`}>TC</Link> <span aria-hidden="true">/</span>{' '}
        <Link to={itemPath(projectId, tc.key)}>{tc.key}</Link> <span aria-hidden="true">/</span> <span>New run</span>
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
      {!formal && (
        <p className="notice small">
          {tc.key} version {tc.version} isn't approved, so this is a dry run. It's kept for debugging and doesn't count toward coverage.
        </p>
      )}

      <ol className="run-steps">
        {tc.steps.map((step, i) => {
          const s = steps[i]
          const locked = stage !== 'executing'
          return (
            <li key={i} className={`card run-step${s.outcome ? ` outcome-${s.outcome.toLowerCase()}` : ''}`}>
              <div className="run-step-head">
                <strong>Step {i + 1}</strong>
                {s.outcome && <StateBadge value={s.outcome === 'Pass' ? 'Passed' : 'Failed'} />}
              </div>
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
              <label>
                Actual result
                <textarea rows={2} value={s.actual} disabled={locked} onChange={(e) => update(i, { actual: e.target.value })} placeholder="Describe what actually happened" />
              </label>
              <div className="run-step-actions">
                <label className="file-label">
                  Evidence
                  <input
                    type="file"
                    multiple
                    disabled={locked}
                    onChange={(e) => update(i, { evidence: [...s.evidence, ...[...e.target.files].map((f) => f.name)] })}
                  />
                </label>
                <div className="actions">
                  <button type="button" className={s.outcome === 'Pass' ? '' : 'secondary'} disabled={locked} onClick={() => update(i, { outcome: 'Pass', deviation: false })}>
                    Pass
                  </button>
                  <button type="button" className={s.outcome === 'Fail' ? 'danger' : 'secondary'} disabled={locked} onClick={() => update(i, { outcome: 'Fail' })}>
                    Fail
                  </button>
                </div>
              </div>
              {s.evidence.length > 0 && (
                <ul className="evidence-list small">
                  {s.evidence.map((name, j) => (
                    <li key={j}>📎 {name}</li>
                  ))}
                </ul>
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

      {stage === 'executing' && (
        <div className="card run-footer">
          <span>
            {allRecorded ? (
              <>
                Overall result: <StateBadge value={overall} />
              </>
            ) : (
              <span className="muted">Record a pass or fail for every step to finish.</span>
            )}
            {missingActual && <div className="error small">Enter an actual result for every recorded step.</div>}
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
            You are signing {NEXT_RUN_KEY} ({tc.key} version {tc.version}, {formal ? 'formal run' : 'dry run'}, result {overall}) with the meaning{' '}
            <strong>Executed</strong>.
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
          <Link to={itemPath(projectId, tc.key)}>Back to {tc.key}</Link>
        </div>
      )}
    </div>
  )
}
