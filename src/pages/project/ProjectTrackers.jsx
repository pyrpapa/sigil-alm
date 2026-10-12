import { useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

export default function ProjectTrackers() {
  const { project, can } = useOutletContext()
  const [trackers, setTrackers] = useState(null)
  const [counts, setCounts] = useState({})
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    Promise.all([
      supabase.from('trackers').select('id, type_key, name, description').eq('project_id', project.id).order('position'),
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

  return (
    <div className="stack">
      <ul className="tracker-grid" aria-label="Trackers">
        {trackers.map((t) => (
          <li key={t.id} className="card tracker-card">
            <Link to={t.type_key} className="tracker-card-link">
              <div className="tracker-card-head">
                <span className="prefix">{t.type_key}</span>
                <span className="muted small">
                  {counts[t.id] ?? 0} {counts[t.id] === 1 ? 'item' : 'items'}
                </span>
              </div>
              <strong>{t.name}</strong>
              <span className="muted small">{t.description}</span>
            </Link>
            {can('trackers.configure') && (
              <Link to={`${t.type_key}/config`} className="small config-link">
                Configure fields and workflow
              </Link>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">
        Want to see where test execution is heading? <Link to="../preview">Open the test run preview</Link> (sample data).
      </p>
    </div>
  )
}
