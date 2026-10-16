import { useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

// Test runs will live under each test case, on its requirement's page (Phase 3).
// Until then their tracker isn't shown as a place of its own.
const HIDDEN = new Set(['TR'])

export default function ProjectTrackers() {
  const { project, can } = useOutletContext()
  const [trackers, setTrackers] = useState(null)
  const [counts, setCounts] = useState({})
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    Promise.all([
      supabase
        .from('trackers')
        .select('id, type_key, name, description, pair_tracker_id, is_pair_primary')
        .eq('project_id', project.id)
        .order('position'),
      supabase.from('items').select('tracker_id').eq('project_id', project.id),
    ]).then(([t, i]) => {
      if (!current) return
      if (t.error || i.error) return setError((t.error || i.error).message)
      const c = {}
      for (const row of i.data) c[row.tracker_id] = (c[row.tracker_id] ?? 0) + 1
      setCounts(c)
      setTrackers(t.data)
    })
    return () => {
      current = false
    }
  }, [project.id])

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (!trackers) return <p className="muted">Loading trackers…</p>

  const plural = (n, word) => `${n} ${n === 1 ? word : `${word}s`}`
  // A requirement tracker and its test cases are one hub; the test case tracker has no card of its own.
  const shown = trackers.filter((t) => !HIDDEN.has(t.type_key) && !(t.pair_tracker_id && !t.is_pair_primary))

  return (
    <div className="stack">
      <ul className="tracker-grid" aria-label="Trackers">
        {shown.map((t) => {
          const pair = t.is_pair_primary ? trackers.find((x) => x.id === t.pair_tracker_id) : null
          return (
            <li key={t.id} className={`card tracker-card${pair ? ' hub-card' : ''}`}>
              <Link to={t.type_key} className="tracker-card-link">
                <div className="tracker-card-head">
                  <span className="prefix">
                    {t.type_key}
                    {pair && ` + ${pair.type_key}`}
                  </span>
                  <span className="muted small">
                    {pair ? `${plural(counts[t.id] ?? 0, 'requirement')} · ${plural(counts[pair.id] ?? 0, 'test case')}` : plural(counts[t.id] ?? 0, 'item')}
                  </span>
                </div>
                <strong>{pair ? 'Requirements & Test Cases' : t.name}</strong>
                <span className="muted small">
                  {pair
                    ? 'Each requirement and its test case, written, reviewed and approved together on one page.'
                    : t.description}
                </span>
              </Link>
              {pair && (
                <Link to={pair.type_key} className="small config-link">
                  All test cases
                </Link>
              )}
              {can('trackers.configure') && (
                <Link to={`${t.type_key}/config`} className="small config-link">
                  Configure fields and workflow
                </Link>
              )}
              {pair && can('trackers.configure') && (
                <Link to={`${pair.type_key}/config`} className="small config-link">
                  Configure test case fields
                </Link>
              )}
            </li>
          )
        })}
      </ul>
      <p className="muted small">
        Test runs will appear under each test case once test execution is built. Want to see where it's heading?{' '}
        <Link to="../preview">Open the test run preview</Link> (sample data).
      </p>
    </div>
  )
}
