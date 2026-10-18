import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { formatTimestamp } from '../../lib/labels'

const KIND_LABELS = { tracker: 'Tracker', folder: 'Folder', item: 'Item' }

// Everything deleted in this project. Nothing here is ever destroyed; restoring brings
// a tracker, folder or item back with everything it took with it.
export default function ProjectTrash() {
  const { project, can } = useOutletContext()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [restoring, setRestoring] = useState(null)
  const [notice, setNotice] = useState('')

  const apply = useCallback(({ data, error }) => {
    if (error) setError(error.message)
    else setRows(data)
  }, [])
  const load = useCallback(() => supabase.rpc('project_trash', { p_project: project.id }).then(apply), [project.id, apply])

  useEffect(() => {
    let current = true
    supabase.rpc('project_trash', { p_project: project.id }).then((res) => current && apply(res))
    return () => {
      current = false
    }
  }, [project.id, apply])

  const canRestore = can('trash.manage')

  return (
    <div className="stack">
      <div className="card-head">
        <h2>Trash</h2>
      </div>
      <p className="muted small">
        Deleted trackers, folders and items stay here with their versions, signatures, links and history. They are never
        destroyed{canRestore ? ', and can be restored at any time' : '; an Admin can restore them'}.
      </p>

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {rows === null ? (
        <p className="muted">Loading trash…</p>
      ) : rows.length === 0 ? (
        <p className="muted">The trash is empty.</p>
      ) : (
        <div className="table-wrap">
          <table aria-label="Trash">
            <thead>
              <tr>
                <th>Deleted</th>
                <th>Items</th>
                <th>When</th>
                <th>Reason</th>
                {canRestore && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="muted small">{KIND_LABELS[r.kind]}</span>
                    <div>{r.label}</div>
                  </td>
                  <td>{r.item_count}</td>
                  <td className="small">
                    {formatTimestamp(r.deleted_at)}
                    <div className="muted">by {r.deleted_by_name}</div>
                  </td>
                  <td className="small">{r.reason}</td>
                  {canRestore && (
                    <td>
                      {restoring === r.id ? (
                        <RestoreForm
                          entry={r}
                          onCancel={() => setRestoring(null)}
                          onDone={() => {
                            setRestoring(null)
                            setNotice(`Restored: ${r.label}`)
                            load()
                          }}
                        />
                      ) : r.blocked ? (
                        <span className="trash-blocked">{r.blocked}</span>
                      ) : (
                        <button
                          type="button"
                          className="secondary small"
                          aria-label={`Restore ${r.label}`}
                          onClick={() => {
                            setNotice('')
                            setRestoring(r.id)
                          }}
                        >
                          Restore
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function RestoreForm({ entry, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return (
    <form
      className="form-inline"
      onSubmit={async (e) => {
        e.preventDefault()
        setSaving(true)
        setError('')
        const { error } = await supabase.rpc('restore_from_trash', { p_entry: entry.id, p_reason: reason.trim() || null })
        setSaving(false)
        if (error) setError(error.message)
        else onDone()
      }}
    >
      <label>
        Reason (optional)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="small" disabled={saving}>
          {saving ? 'Restoring…' : 'Restore'}
        </button>
        <button type="button" className="secondary small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
