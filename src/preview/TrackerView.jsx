import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import PreviewBanner from './PreviewBanner'
import StateBadge from './StateBadge'
import { itemsFor, runsFor, TRACKERS } from './sampleData'

// Extra column per tracker type.
const EXTRA_COLUMN = {
  SRS: { label: 'Verification', value: (i) => i.fields.Verification },
  RISK: { label: 'Risk level', value: (i) => <StateBadge value={i.riskLevel} /> },
  TC: {
    label: 'Last formal run',
    value: (i) => {
      const formal = runsFor(i.key).filter((r) => r.runType === 'Formal')
      const last = formal[formal.length - 1]
      return last ? <StateBadge value={last.result} /> : <span className="muted">Not run</span>
    },
  },
  TR: { label: 'Result', value: (i) => <StateBadge value={i.result} /> },
}

export default function TrackerView() {
  const { projectId, trackerKey } = useParams()
  const tracker = TRACKERS.find((t) => t.key === trackerKey)
  const items = useMemo(() => itemsFor(trackerKey), [trackerKey])
  const folders = useMemo(() => [...new Set(items.map((i) => i.folder))], [items])
  const states = useMemo(() => [...new Set(items.map((i) => i.state))], [items])

  const [folder, setFolder] = useState('')
  const [state, setState] = useState('')
  const [search, setSearch] = useState('')

  if (!tracker) return <p>Unknown tracker.</p>

  const q = search.trim().toLowerCase()
  const shown = items.filter(
    (i) =>
      (!folder || i.folder === folder) &&
      (!state || i.state === state) &&
      (!q || i.key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q) || Object.values(i.fields ?? {}).some((v) => String(v).toLowerCase().includes(q))),
  )
  const extra = EXTRA_COLUMN[trackerKey]

  return (
    <div className="stack">
      <PreviewBanner />
      <div className="card-head">
        <h2>
          <Link to={`/projects/${projectId}/trackers`}>Trackers</Link> / {tracker.key}: {tracker.name}
        </h2>
        <button type="button" disabled title="Arrives with real trackers in Phase 2d">
          New {tracker.key} item
        </button>
      </div>

      <div className="tracker-layout">
        <aside className="folders" aria-label="Folders">
          <h3 className="small muted">Folders</h3>
          <ul>
            <li>
              <button type="button" className={`folder${folder === '' ? ' active' : ''}`} onClick={() => setFolder('')}>
                All items <span className="muted">{items.length}</span>
              </button>
            </li>
            {folders.map((f) => (
              <li key={f}>
                <button type="button" className={`folder${folder === f ? ' active' : ''}`} onClick={() => setFolder(f)}>
                  {f} <span className="muted">{items.filter((i) => i.folder === f).length}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="stack">
          <div className="filters">
            <label>
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ID, title or text" />
            </label>
            <label>
              State
              <select value={state} onChange={(e) => setState(e.target.value)}>
                <option value="">All states</option>
                {states.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <button type="button" className="secondary" disabled title="Export arrives in Phase 3">
              Export…
            </button>
          </div>

          <div className="table-wrap">
            <table aria-label={`${tracker.key} items`}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>Folder</th>
                  <th>State</th>
                  {extra && <th>{extra.label}</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.key}>
                    <td className="nowrap">
                      <Link to={`/projects/${projectId}/trackers/${trackerKey}/${i.key}`}>{i.key}</Link>
                    </td>
                    <td>{i.title}</td>
                    <td className="muted">{i.folder}</td>
                    <td>
                      <StateBadge value={i.state} />
                    </td>
                    {extra && <td>{extra.value(i)}</td>}
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={extra ? 5 : 4} className="muted">
                      No items match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Showing {shown.length} of {items.length}
          </p>
        </div>
      </div>
    </div>
  )
}
