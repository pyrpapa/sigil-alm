import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { formatDate, formatTimestamp, STATUS_LABELS } from '../../lib/labels'

export default function ProjectOverview() {
  const { project, setProject, can } = useOutletContext()
  const [editing, setEditing] = useState(false)
  const [archiving, setArchiving] = useState(false)

  const archived = project.status === 'archived'

  return (
    <div className="stack">
      {editing ? (
        <EditProjectForm
          project={project}
          onCancel={() => setEditing(false)}
          onSaved={(updated) => {
            setProject(updated)
            setEditing(false)
          }}
        />
      ) : (
        <div className="card">
          <div className="card-head">
            <h2>Details</h2>
            {can('project.edit') && (
              <button type="button" className="secondary" onClick={() => setEditing(true)}>
                Edit details
              </button>
            )}
          </div>
          <dl className="details">
            <dt>Name</dt>
            <dd>{project.name}</dd>
            <dt>System under validation</dt>
            <dd>{project.system_under_validation || <span className="muted">Not set</span>}</dd>
            <dt>Planned start</dt>
            <dd>{formatDate(project.planned_start) || <span className="muted">Not set</span>}</dd>
            <dt>Planned end</dt>
            <dd>{formatDate(project.planned_end) || <span className="muted">Not set</span>}</dd>
            <dt>Status</dt>
            <dd>{STATUS_LABELS[project.status] ?? project.status}</dd>
            <dt>Created</dt>
            <dd>{formatTimestamp(project.created_at)}</dd>
          </dl>
        </div>
      )}

      {can('project.archive') && (
        <div className="card">
          <div className="card-head">
            <h2>{archived ? 'De-archive project' : 'Archive project'}</h2>
          </div>
          <p className="muted">
            {archived
              ? 'De-archiving makes the project editable again and sets its status to Active.'
              : 'Archiving makes every record in this project read-only. Projects are never deleted.'}
          </p>
          {archiving ? (
            <ArchiveForm
              project={project}
              archived={archived}
              onCancel={() => setArchiving(false)}
              onDone={(updated) => {
                setProject(updated)
                setArchiving(false)
              }}
            />
          ) : (
            <button type="button" className="secondary" onClick={() => setArchiving(true)}>
              {archived ? 'De-archive…' : 'Archive…'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function EditProjectForm({ project, onCancel, onSaved }) {
  const [name, setName] = useState(project.name)
  const [system, setSystem] = useState(project.system_under_validation ?? '')
  const [plannedStart, setPlannedStart] = useState(project.planned_start ?? '')
  const [plannedEnd, setPlannedEnd] = useState(project.planned_end ?? '')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const datesInvalid = plannedStart && plannedEnd && plannedEnd < plannedStart

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { data, error } = await supabase.rpc('update_project', {
      p_project: project.id,
      p_name: name.trim(),
      p_system_under_validation: system.trim() || null,
      p_planned_start: plannedStart || null,
      p_planned_end: plannedEnd || null,
      p_reason: reason.trim() || null,
    })
    setSaving(false)
    if (error) setError(error.message)
    else onSaved(data)
  }

  return (
    <form className="card form-inline" onSubmit={handleSubmit}>
      <h2>Edit details</h2>
      <label>
        Project name
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
      </label>
      <label>
        System under validation
        <input value={system} onChange={(e) => setSystem(e.target.value)} />
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
      <label>
        Reason for change (recorded in the audit trail)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      {datesInvalid && <p className="error">Planned end must be on or after the planned start.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || !name.trim() || datesInvalid}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function ArchiveForm({ project, archived, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { data, error } = await supabase.rpc('set_project_archived', {
      p_project: project.id,
      p_archived: !archived,
      p_reason: reason.trim(),
    })
    setSaving(false)
    if (error) setError(error.message)
    else onDone(data)
  }

  return (
    <form className="form-inline" onSubmit={handleSubmit}>
      <label>
        Reason (required, recorded in the audit trail)
        <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || !reason.trim()}>
          {saving ? 'Saving…' : archived ? 'De-archive project' : 'Archive project'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
