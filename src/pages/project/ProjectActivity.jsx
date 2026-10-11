import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { FIELD_LABELS, formatTimestamp, ROLE_LABELS, STATUS_LABELS } from '../../lib/labels'

// The project's audit trail (SRS-028, SRS-032): who changed what, when, and why.
export default function ProjectActivity() {
  const { project } = useOutletContext()
  const [entries, setEntries] = useState([])
  const [names, setNames] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showPermissionSetup, setShowPermissionSetup] = useState(false)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('audit_log')
        .select('id, occurred_at, table_name, record_id, action, changed_by, changed_fields, old_values, new_values, reason')
        .eq('project_id', project.id)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(500)
      if (error) {
        setError(error.message)
        setLoading(false)
        return
      }
      // Look up printed names for everyone mentioned in these entries.
      const ids = new Set()
      for (const e of data) {
        if (e.changed_by) ids.add(e.changed_by)
        const userId = e.new_values?.user_id ?? e.old_values?.user_id
        if (userId) ids.add(userId)
        if (e.table_name === 'project_members') ids.add(e.record_id.split(':')[1])
      }
      if (ids.size) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', [...ids])
        setNames(Object.fromEntries((profiles ?? []).map((p) => [p.id, p.full_name || 'Unnamed user'])))
      }
      setEntries(data)
      setLoading(false)
    }
    load()
  }, [project.id])

  const visible = useMemo(
    () => entries.filter((e) => showPermissionSetup || e.table_name !== 'role_permissions'),
    [entries, showPermissionSetup],
  )
  const hiddenCount = entries.length - visible.length

  if (loading) return <p className="muted">Loading activity…</p>

  return (
    <div className="stack">
      <div className="card-head">
        <h2>Activity</h2>
        <label className="checkbox">
          <input type="checkbox" checked={showPermissionSetup} onChange={(e) => setShowPermissionSetup(e.target.checked)} />
          Show role permission entries {hiddenCount > 0 && `(${hiddenCount} hidden)`}
        </label>
      </div>
      <p className="muted small">
        Every change is recorded by the database itself and can't be edited or deleted. Times are shown in your local time zone.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap">
        <table aria-label="Audit trail">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Changes</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <tr key={e.id}>
                <td className="nowrap small">{formatTimestamp(e.occurred_at)}</td>
                <td>{e.changed_by ? names[e.changed_by] ?? 'Unknown user' : <span className="muted">System</span>}</td>
                <td>{describe(e, names)}</td>
                <td>
                  <Changes entry={e} />
                </td>
                <td>{e.reason || <span className="muted">—</span>}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No activity yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function describe(e, names) {
  const v = e.new_values ?? {}
  const o = e.old_values ?? {}
  if (e.table_name === 'projects') {
    if (e.action === 'INSERT') return 'Created the project'
    if (e.changed_fields?.includes('status')) {
      if (v.status === 'archived') return 'Archived the project'
      if (o.status === 'archived') return 'De-archived the project'
      return 'Changed the project status'
    }
    if (e.changed_fields?.length === 1 && e.changed_fields[0] === 'repository_url') {
      if (!o.repository_url) return 'Linked a repository'
      if (!v.repository_url) return 'Removed the repository link'
      return 'Changed the repository link'
    }
    return 'Edited project details'
  }
  if (e.table_name === 'project_members') {
    const memberId = e.record_id.split(':')[1]
    const who = names[memberId] ?? 'a user'
    if (e.action === 'INSERT') return `Added ${who} as ${ROLE_LABELS[v.role] ?? v.role}`
    if (e.action === 'DELETE') return `Removed ${who} (${ROLE_LABELS[o.role] ?? o.role})`
    return `Changed ${who}'s role`
  }
  if (e.table_name === 'role_permissions') {
    const [, role, permission] = e.record_id.split(':')
    if (e.action === 'INSERT') return `Granted "${permission}" to ${ROLE_LABELS[role] ?? role}`
    if (e.action === 'DELETE') return `Removed "${permission}" from ${ROLE_LABELS[role] ?? role}`
  }
  return `${e.action} on ${e.table_name}`
}

function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return '(empty)'
  if (field === 'role') return ROLE_LABELS[value] ?? value
  if (field === 'status') return STATUS_LABELS[value] ?? value
  return String(value)
}

function Changes({ entry }) {
  if (entry.action !== 'UPDATE' || !entry.changed_fields) return <span className="muted">—</span>
  return (
    <ul className="changes">
      {entry.changed_fields.map((f) => (
        <li key={f}>
          <span className="muted">{FIELD_LABELS[f] ?? f}:</span> <del>{formatValue(f, entry.old_values?.[f])}</del> →{' '}
          <ins>{formatValue(f, entry.new_values?.[f])}</ins>
        </li>
      ))}
    </ul>
  )
}
