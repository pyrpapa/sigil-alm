import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatTimestamp } from '../lib/labels'

// My work across projects (design note, decision 8): what waits for my signature,
// and what was sent back to me, grouped by project and release. Sign from here
// one item at a time; to send something back, open it (comments go with the item).
export default function ReviewQueue() {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('review')
  const [signing, setSigning] = useState(null)

  const load = useCallback(
    () =>
      supabase.rpc('my_review_queue').then(({ data, error }) => {
        if (error) setError(error.message)
        else setRows(data)
      }),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (!rows) return <p className="muted">Loading your reviews…</p>

  const review = rows.filter((r) => r.kind === 'review')
  const rework = rows.filter((r) => r.kind === 'rework')
  const shown = tab === 'review' ? review : rework

  // project → release → rows
  const groups = []
  for (const r of shown) {
    let g = groups.find((x) => x.project_id === r.project_id)
    if (!g) groups.push((g = { project_id: r.project_id, project_name: r.project_name, releases: [] }))
    let rel = g.releases.find((x) => x.release_id === r.release_id)
    if (!rel) g.releases.push((rel = { release_id: r.release_id, label: r.release_key ? `${r.release_key} ${r.release_title}` : 'No release', rows: [] }))
    rel.rows.push(r)
  }

  return (
    <div className="stack">
      <div className="page-head">
        <h1>My reviews</h1>
      </div>
      <nav className="tabs" aria-label="Queues">
        <button type="button" className={`tab${tab === 'review' ? ' active' : ''}`} onClick={() => setTab('review')}>
          To review ({review.length})
        </button>
        <button type="button" className={`tab${tab === 'rework' ? ' active' : ''}`} onClick={() => setTab('rework')}>
          Needs work ({rework.length})
        </button>
      </nav>

      {shown.length === 0 && (
        <p className="muted">{tab === 'review' ? 'Nothing is waiting for your signature.' : 'Nothing has been sent back to you.'}</p>
      )}

      {groups.map((g) => (
        <section key={g.project_id} className="stack-sm">
          <h2>{g.project_name}</h2>
          {g.releases.map((rel) => (
            <div key={rel.release_id ?? 'none'} className="table-wrap">
              <table aria-label={`${g.project_name} ${rel.label}`}>
                <thead>
                  <tr>
                    <th colSpan={tab === 'review' ? 5 : 4}>{rel.label}</th>
                  </tr>
                </thead>
                <tbody>
                  {rel.rows.map((r) => {
                    const url = `/projects/${r.project_id}/trackers/${r.type_key}/${r.item_key}`
                    return (
                      <tr key={r.item_id}>
                        <td className="nowrap">
                          <Link to={url} className="prefix">
                            {r.item_key}
                          </Link>
                          {r.pair_key && <div className="muted small">with {r.pair_key}</div>}
                        </td>
                        <td>
                          {r.title}
                          {r.approved_revision && (
                            <div className="muted small">
                              Version {r.revision} · changes since version {r.approved_revision}
                            </div>
                          )}
                          {r.kind === 'rework' && r.rejection && (
                            <div className="small rejection-inline">
                              <strong>{r.rejection.by_name}:</strong> {r.rejection.reason}
                              {r.open_comments > 0 && ` · ${r.open_comments} open ${r.open_comments === 1 ? 'comment' : 'comments'}`}
                            </div>
                          )}
                        </td>
                        <td className="nowrap small">{r.state}</td>
                        <td className="nowrap small muted">since {formatTimestamp(r.waiting_since)}</td>
                        {tab === 'review' && (
                          <td className="nowrap">
                            {signing === r.item_id ? (
                              <QuickSign
                                row={r}
                                onCancel={() => setSigning(null)}
                                onDone={() => {
                                  setSigning(null)
                                  load()
                                }}
                              />
                            ) : (
                              <span className="actions">
                                <Link className="button secondary-link small" to={url}>
                                  Open
                                </Link>
                                <button type="button" className="small" onClick={() => setSigning(r.item_id)}>
                                  Sign…
                                </button>
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

// Sign and move on to the next stage, in one step, with the password re-entered (SRS-023).
function QuickSign({ row, onCancel, onDone }) {
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('sign_and_advance', { p_item: row.item_id, p_password: password })
    setSaving(false)
    setPassword('')
    if (error) setError(error.message)
    else onDone()
  }
  return (
    <form className="quick-sign" onSubmit={handleSubmit}>
      <span className="small">
        Sign {row.item_key}
        {row.pair_key && ` and ${row.pair_key}`} ({row.state})
      </span>
      <input type="password" aria-label={`Password to sign ${row.item_key}`} placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      <button type="submit" className="small" disabled={saving || !password}>
        {saving ? 'Signing…' : 'Sign'}
      </button>
      <button type="button" className="secondary small" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="error small">{error}</span>}
    </form>
  )
}
