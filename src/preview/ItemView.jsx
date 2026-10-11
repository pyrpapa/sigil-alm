import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import PreviewBanner from './PreviewBanner'
import StateBadge from './StateBadge'
import { backlinks, coverageFor, getItem, itemPath, ITEMS, runsFor, SIGNATURES } from './sampleData'
import { formatTimestamp } from '../lib/labels'

export default function ItemView() {
  const { projectId, trackerKey, itemKey } = useParams()
  const item = getItem(itemKey)
  const [signatures, setSignatures] = useState(SIGNATURES[itemKey] ?? [])
  const [state, setState] = useState(item?.state)
  const [signing, setSigning] = useState(null) // meaning being signed

  if (!item) return <p>Item not found.</p>

  const related = [...item.links.map((l) => ({ type: l.type, key: l.to, dir: 'to' })), ...backlinks(item.key).map((l) => ({ type: l.type, key: l.from, dir: 'from' }))]

  return (
    <div className="stack">
      <PreviewBanner />
      <nav className="breadcrumb" aria-label="Item breadcrumb">
        <Link to={`/projects/${projectId}/trackers`}>Trackers</Link> <span aria-hidden="true">/</span>{' '}
        <Link to={`/projects/${projectId}/trackers/${trackerKey}`}>{trackerKey}</Link> <span aria-hidden="true">/</span> <span>{item.key}</span>
      </nav>

      <div className="card-head">
        <div>
          <h2>
            <span className="prefix">{item.key}</span> {item.title}
          </h2>
          <span className="muted small">
            Version {item.version} · Folder: {item.folder}
          </span>
        </div>
        <StateBadge value={state} />
      </div>

      <WorkflowBar state={state} onSign={setSigning} />

      {signing && (
        <SignatureDialog
          item={item}
          meaning={signing}
          onCancel={() => setSigning(null)}
          onSigned={(sig) => {
            setSignatures((s) => [...s, sig])
            if (sig.meaning === 'Approved') setState('Approved')
            if (sig.meaning === 'Reviewed') setState('In Review')
            setSigning(null)
          }}
        />
      )}

      <div className="item-grid">
        <div className="stack">
          {item.fields && (
            <section className="card">
              <h3>Details</h3>
              <dl className="details">
                {Object.entries(item.fields).map(([k, v]) => (
                  <div key={k} className="details-row">
                    <dt>{k}</dt>
                    <dd className="prewrap">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {item.tracker === 'TC' && <TestCasePanels projectId={projectId} tc={item} />}
          {item.tracker === 'SRS' && <CoveragePanel projectId={projectId} srsKey={item.key} />}
        </div>

        <div className="stack">
          <section className="card">
            <h3>Links</h3>
            {related.length === 0 ? (
              <p className="muted small">No links yet.</p>
            ) : (
              <ul className="link-list">
                {related.map((l, i) => (
                  <li key={i}>
                    <span className="muted small">{l.dir === 'to' ? l.type : `${l.type} (from)`}</span>{' '}
                    <Link to={itemPath(projectId, l.key)}>{l.key}</Link>{' '}
                    <span className="small">{getItem(l.key)?.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h3>Signatures</h3>
            {signatures.length === 0 ? (
              <p className="muted small">Not signed yet.</p>
            ) : (
              <ul className="signature-list">
                {signatures.map((s, i) => (
                  <li key={i} className={s.superseded ? 'superseded' : ''}>
                    <strong>{s.by}</strong> · {s.meaning}
                    <div className="muted small">
                      {formatTimestamp(s.at)} · version {s.version}
                      {s.superseded && ' · does not apply to the current version'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

// Review gates: transitions that require an electronic signature (SRS-022, SRS-023).
function WorkflowBar({ state, onSign }) {
  return (
    <div className="workflow-bar">
      <span className="muted small">Workflow:</span>
      {['Draft', 'In Review', 'Approved'].map((s, i) => (
        <span key={s} className={`step${s === state ? ' current' : ''}`}>
          {i > 0 && <span aria-hidden="true">→ </span>}
          {s}
        </span>
      ))}
      <span className="spacer" />
      {state === 'Draft' && (
        <button type="button" className="secondary small" onClick={() => onSign('Reviewed')}>
          Send for review…
        </button>
      )}
      {state === 'In Review' && (
        <button type="button" className="small" onClick={() => onSign('Approved')}>
          Approve…
        </button>
      )}
      {state === 'Approved' && (
        <button type="button" className="secondary small" disabled title="Moving back to In Progress requires a reason (SRS-029)">
          Revise…
        </button>
      )}
    </div>
  )
}

function SignatureDialog({ item, meaning, onCancel, onSigned }) {
  const [password, setPassword] = useState('')
  function handleSubmit(e) {
    e.preventDefault()
    onSigned({ by: 'You (preview)', meaning, at: new Date().toISOString(), version: item.version })
  }
  return (
    <form className="card form-inline signature-dialog" onSubmit={handleSubmit}>
      <h3>Electronic signature</h3>
      <p className="small">
        You are signing <strong>{item.key} version {item.version}</strong> with the meaning <strong>{meaning}</strong>. Your printed
        name, the date and time, and this meaning will be recorded with the signature.
      </p>
      <label>
        Re-enter your password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
      </label>
      <p className="muted small">Preview: the password isn't checked and nothing is saved.</p>
      <div className="actions">
        <button type="submit" disabled={!password}>
          Sign as {meaning}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function TestCasePanels({ projectId, tc }) {
  const runs = runsFor(tc.key)
  const versions = [...new Set(runs.map((r) => r.tcVersion))].sort((a, b) => b - a)

  return (
    <>
      <section className="card">
        <h3>Steps</h3>
        <div className="table-wrap">
          <table aria-label="Test steps">
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
                <th>Expected result</th>
              </tr>
            </thead>
            <tbody>
              {tc.steps.map((s, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{s.action}</td>
                  <td>{s.expected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Execution</h3>
          {tc.executionType === 'Manual' ? (
            <Link className="button" to={`${itemPath(projectId, tc.key)}/run`}>
              Run this test
            </Link>
          ) : (
            <span className="muted small">Runs automatically from CI</span>
          )}
        </div>
        {tc.script && (
          <dl className="details compact">
            <dt>Script</dt>
            <dd>
              <code>{tc.script.file}</code>
            </dd>
            <dt>Tag</dt>
            <dd>
              <code>{tc.script.tag}</code>
            </dd>
            <dt>Pinned commit</dt>
            <dd>
              <code>{tc.script.pinnedSha}</code> <span className="muted small">(set when this version was approved)</span>
            </dd>
          </dl>
        )}
        {tc.state !== 'Approved' && (
          <p className="notice small">This version isn't approved yet, so any run now is recorded as a dry run and doesn't count toward coverage.</p>
        )}
      </section>

      <section className="card">
        <h3>Runs</h3>
        {runs.length === 0 && <p className="muted small">No runs yet.</p>}
        {versions.map((v) => (
          <div key={v} className="run-group">
            <h4 className="small">
              Test case version {v}
              {v === tc.version && <span className="muted"> (current)</span>}
            </h4>
            <div className="table-wrap">
              <table aria-label={`Runs for version ${v}`}>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Type</th>
                    <th>Result</th>
                    <th>Commit</th>
                    <th>Executed</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {runs
                    .filter((r) => r.tcVersion === v)
                    .slice()
                    .reverse()
                    .map((r) => (
                      <tr key={r.key}>
                        <td className="nowrap">
                          <Link to={itemPath(projectId, r.key)}>{r.key}</Link>
                        </td>
                        <td>
                          {r.runType}
                          <div className="muted small">{r.source}</div>
                        </td>
                        <td>
                          <StateBadge value={r.result} />
                        </td>
                        <td>
                          {r.sha ? <code>{r.sha}</code> : <span className="muted">—</span>}
                          {r.drift && <div className="error small">Differs from pinned {tc.script?.pinnedSha}</div>}
                        </td>
                        <td className="small">
                          {r.by}
                          <div className="muted">{formatTimestamp(r.at)}</div>
                        </td>
                        <td>
                          <StateBadge value={r.review} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <button type="button" className="secondary small" disabled title="Export arrives in Phase 3">
          Export test case with runs…
        </button>
      </section>
    </>
  )
}

// Coverage rule (SRS-045): covered only if every linked test case has a passing,
// reviewed formal run and no linked deviation is open.
function CoveragePanel({ projectId, srsKey }) {
  const rows = coverageFor(srsKey)
  const openDeviation = ITEMS.some((i) => i.tracker === 'DEV' && i.state !== 'Closed' && i.links.some((l) => l.to === srsKey))
  const covered = rows.length > 0 && !openDeviation && rows.every((r) => r.latest && r.latest.result === 'Passed' && r.latest.review.startsWith('Reviewed'))

  return (
    <section className="card">
      <div className="card-head">
        <h3>Coverage</h3>
        <StateBadge value={covered ? 'Covered' : 'Not covered'} />
      </div>
      {rows.length === 0 ? (
        <p className="muted small">No test cases verify this requirement yet.</p>
      ) : (
        <ul className="link-list">
          {rows.map(({ tc, latest }) => (
            <li key={tc.key}>
              <Link to={itemPath(projectId, tc.key)}>{tc.key}</Link> <span className="small">{tc.title}</span>{' '}
              {latest ? (
                <>
                  <StateBadge value={latest.result} /> <span className="muted small">{latest.review}</span>
                </>
              ) : (
                <span className="muted small">no formal run</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {openDeviation && <p className="error small">An open deviation is linked to this requirement.</p>}
    </section>
  )
}
