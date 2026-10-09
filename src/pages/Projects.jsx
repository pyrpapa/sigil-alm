import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Projects() {
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [system, setSystem] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('projects')
        .select('id, name, system_under_validation, status, created_at')
        .order('created_at', { ascending: false })
      if (error) setError(error.message)
      else setProjects(data)
      setLoading(false)
    }
    load()
  }, [])

  async function handleCreate(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { data, error } = await supabase
      .from('projects')
      .insert({ name: name.trim(), system_under_validation: system.trim() || null })
      .select('id, name, system_under_validation, status, created_at')
      .single()
    if (error) {
      setError(error.message)
    } else {
      setProjects((current) => [data, ...current])
      setName('')
      setSystem('')
      setShowForm(false)
    }
    setSaving(false)
  }

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
          <div className="actions">
            <button type="submit" disabled={saving || !name.trim()}>
              {saving ? 'Creating…' : 'Create project'}
            </button>
            <button type="button" className="secondary" onClick={() => setShowForm(false)}>
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
            <li key={p.id} className="card">
              <div>
                <strong>{p.name}</strong>
                {p.system_under_validation && <div className="muted">{p.system_under_validation}</div>}
              </div>
              <span className={`status status-${p.status}`}>{p.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
