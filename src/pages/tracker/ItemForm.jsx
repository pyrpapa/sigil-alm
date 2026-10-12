import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import FieldInput from '../../components/FieldInput'
import { cleanSteps, isEmpty, stepProblems } from '../../lib/trackers'

// Generated from the tracker's field configuration (SRS-016). Used to create and to edit.
export default function ItemForm({ config, members, item = null, requireReason = false, onCancel, onSaved }) {
  // Fields filled in by state actions (e.g. "Approved on") are set by the workflow, not typed in.
  const autoKeys = new Set(config.actions.map((a) => a.field_key))
  const fields = config.fields.filter((f) => !autoKeys.has(f.key) && (!f.is_retired || !isEmpty(item?.values?.[f.key])))
  const autoLabels = config.fields.filter((f) => autoKeys.has(f.key) && !f.is_retired).map((f) => f.label)
  const [title, setTitle] = useState(item?.title ?? '')
  const [values, setValues] = useState(item?.values ?? {})
  const [folder, setFolder] = useState(item?.folder_id ?? '')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const missing = [
    ...fields.filter((f) => f.required && !f.is_retired && isEmpty(values[f.key])).map((f) => f.label),
    ...fields.filter((f) => f.field_type === 'steps' && Array.isArray(values[f.key])).flatMap((f) => stepProblems(values[f.key])),
  ]

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const stepKeys = new Set(config.fields.filter((f) => f.field_type === 'steps').map((f) => f.key))
    const clean = Object.fromEntries(
      Object.entries(values)
        .map(([k, v]) => [k, stepKeys.has(k) && Array.isArray(v) ? cleanSteps(v) : v])
        .filter(([, v]) => !isEmpty(v)),
    )
    const { data, error } = item
      ? await supabase.rpc('update_item', {
          p_item: item.id,
          p_title: title.trim(),
          p_values: clean,
          p_folder: folder || null,
          p_reason: reason.trim() || null,
        })
      : await supabase.rpc('create_item', {
          p_tracker: config.tracker.id,
          p_title: title.trim(),
          p_values: clean,
          p_folder: folder || null,
        })
    setSaving(false)
    if (error) setError(error.message)
    else onSaved(data)
  }

  return (
    <form className="card form-inline item-form" onSubmit={handleSubmit}>
      <h3>{item ? `Edit ${item.item_key}` : `New ${config.tracker.type_key} item`}</h3>
      <label>
        <span>
          Title<span className="required" aria-hidden="true"> *</span>
        </span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} />
      </label>

      {fields.map((f) => (
        <FieldInput
          key={f.id}
          field={f}
          members={members}
          value={values[f.key]}
          onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))}
        />
      ))}

      {config.folders.length > 0 && (
        <label>
          Folder
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">No folder</option>
            {config.folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {item && (
        <label>
          Reason for change{requireReason ? ' (required: this item has been reviewed before)' : ' (recorded in the audit trail)'}
          <input value={reason} onChange={(e) => setReason(e.target.value)} required={requireReason} maxLength={500} />
        </label>
      )}

      {autoLabels.length > 0 && <p className="muted small">Set automatically by the workflow: {autoLabels.join(', ')}.</p>}
      {missing.length > 0 && <p className="muted small">Still needed: {missing.join(', ')}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || !title.trim() || missing.length > 0 || (requireReason && !reason.trim())}>
          {saving ? 'Saving…' : item ? 'Save changes' : 'Create item'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
