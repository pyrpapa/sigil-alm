import { useState } from 'react'

// Delete something to the project's trash: asks for a reason, then runs `onDelete(reason)`
// (a Supabase rpc promise). Nothing is destroyed; it can be restored from the Trash tab.
export default function TrashForm({ title, children, submitLabel = 'Move to trash', onDelete, onDone, onCancel }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await onDelete(reason.trim())
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="card form-inline trash-form" onSubmit={handleSubmit} aria-label={title}>
      <h3>{title}</h3>
      {children}
      <p className="muted small">It goes to the project's Trash, where an Admin can restore it with everything it had.</p>
      <label>
        Reason (required, recorded in the audit trail)
        <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="danger" disabled={saving || !reason.trim()}>
          {saving ? 'Deleting…' : submitLabel}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
