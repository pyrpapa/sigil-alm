import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatDate, STATUS_LABELS } from '../lib/labels'

const PROJECT_COLUMNS = 'id, name, system_under_validation, status, planned_start, planned_end, created_at'


export default function Projects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [system, setSystem] = useState('')
  const [plannedStart, setPlannedStart] = useState('')
  const [plannedEnd, setPlannedEnd] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('projects')
        .select(PROJECT_COLUMNS)
        .order('created_at', { ascending: false })
      if (error) setError(error.message)
      else setProjects(data)
      setLoading(false)
    }
    load()
  }, [])

  function resetForm() {
    setName('')
    setSystem('')
    setPlannedStart('')
    setPlannedEnd('')
    setShowForm(false)
  }

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    // create_project also makes you the project Admin and sets up default role permissions.
    const { data, error } = await supabase.rpc('create_project', {
      p_name: name.trim(),
      p_system_under_validation: system.trim() || null,
      p_planned_start: plannedStart || null,
      p_planned_end: plannedEnd || null,
    })
    if (error) {
      setError(error.message)
    } else {
      setProjects((current) => [data, ...current])
      resetForm()
    }
    setSaving(false)
  }

  const datesInvalid = plannedStart && plannedEnd && plannedEnd < plannedStart

  return (
    <section>
      <div className="page-head">
        <h1>Projects</h1>
        {!showForm && (
          <button type="button" onClick={() => setShowForm(true)}>
            New project
          </button>
        )}
      </div>

      {showForm && (
        <form className="card form-inline" onSubmit={handleCreate}>
          <label>
            Project name
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </label>
          <label>
            System under validation
            <input value={system} onChange={(e) => setSystem(e.target.value)} placeholder="e.g. Sigil v1.0" />
          </label>
          <div className="form-row">
            <label>
              Planned start
              <input type="date" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} />
            </label>
            <label>
              Planned end
              <input type="date" value={plannedEnd} min={plannedStart || undefined} onChange={(e) => setPlannedEnd(e.target.value)} />
            </label>
          </div>
          {datesInvalid && <p className="error">Planned end must be on or after the planned start.</p>}
          <div className="actions">
            <button type="submit" disabled={saving || !name.trim() || datesInvalid}>
              {saving ? 'Creating…' : 'Create project'}
            </button>
            <button type="button" className="secondary" onClick={resetForm}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="muted">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="muted">No projects yet. Create the first one.</p>
      ) : (
        <ul className="project-list" aria-label="Projects">
          {projects.map((p) => (
            <li key={p.id} className="card project-card">
              <div>
                <Link to={`/projects/${p.id}`} className="project-link">
                  <strong>{p.name}</strong>
                </Link>
                {p.system_under_validation && <div className="muted">{p.system_under_validation}</div>}
                {(p.planned_start || p.planned_end) && (
                  <div className="muted small">
                    {formatDate(p.planned_start) ?? '?'} – {formatDate(p.planned_end) ?? '?'}
                  </div>
                )}
              </div>
              <span className={`status status-${p.status}`}>{STATUS_LABELS[p.status] ?? p.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
