import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { FIELD_LABELS, formatTimestamp, ROLE_LABELS, STATUS_LABELS } from '../../lib/labels'

// The project's audit trail (SRS-028, SRS-032): who changed what, when, and why.
export default function ProjectActivity() {
  const { project } = useOutletContext()
  const [entries, setEntries] = useState([])
  const [names, setNames] = useState({})
  const [keys, setKeys] = useState({ items: {}, trackers: {} })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showConfig, setShowConfig] = useState(false)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('audit_log')
        .select('id, occurred_at, table_name, record_id, action, changed_by, changed_fields, old_values, new_values, reason')
        .eq('project_id', project.id)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1000)
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
      const [{ data: items }, { data: trackers }] = await Promise.all([
        supabase.from('items').select('id, item_key').eq('project_id', project.id),
        supabase.from('trackers').select('id, type_key').eq('project_id', project.id),
      ])
      setKeys({
        items: Object.fromEntries((items ?? []).map((i) => [i.id, i.item_key])),
        trackers: Object.fromEntries((trackers ?? []).map((t) => [t.id, t.type_key])),
      })
      setEntries(data)
      setLoading(false)
    }
    load()
  }, [project.id])

  const visible = useMemo(
    () => entries.filter((e) => showConfig || !CONFIG_TABLES.has(e.table_name)),
    [entries, showConfig],
  )
  const hiddenCount = entries.length - visible.length

  if (loading) return <p className="muted">Loading activity…</p>

  return (
    <div className="stack">
      <div className="card-head">
        <h2>Activity</h2>
        <label className="checkbox">
          <input type="checkbox" checked={showConfig} onChange={(e) => setShowConfig(e.target.checked)} />
          Show configuration changes {hiddenCount > 0 && `(${hiddenCount} hidden)`}
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
                <td>{describe(e, names, keys)}</td>
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

const CONFIG_TABLES = new Set(['role_permissions', 'trackers', 'tracker_fields', 'tracker_states', 'tracker_transitions', 'tracker_state_actions'])

const CONFIG_NOUNS = {
  tracker_fields: 'field',
  tracker_states: 'state',
  tracker_transitions: 'allowed move',
  tracker_state_actions: 'state action',
  folders: 'folder',
}

function describe(e, names, keys) {
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
  if (e.table_name === 'items') {
    const key = keys.items[e.record_id] ?? v.item_key ?? 'an item'
    if (e.action === 'INSERT') return `Created ${key}`
    if (e.changed_fields?.includes('state_id')) return `Moved ${key}` + (e.reason ? ` (${e.reason.replace(/^Moved /, '').split(':')[0]})` : '')
    if (e.changed_fields?.includes('version')) return `Edited ${key} (version ${v.version})`
    return `Updated ${key}`
  }
  if (e.table_name === 'item_signatures') {
    return `${v.signer_name ?? 'Someone'} signed ${keys.items[v.item_id] ?? 'an item'} as ${v.meaning} (${v.state_name}, version ${v.item_version})`
  }
  if (e.table_name === 'trackers') {
    if (e.action === 'INSERT') return `Set up the ${v.type_key} tracker`
    return `Changed the ${keys.trackers[e.record_id] ?? ''} tracker`
  }
  if (CONFIG_NOUNS[e.table_name]) {
    const noun = CONFIG_NOUNS[e.table_name]
    const tracker = keys.trackers[v.tracker_id ?? o.tracker_id]
    const label = v.label ?? v.name ?? o.label ?? o.name ?? ''
    const where = tracker ? ` in ${tracker}` : ''
    if (e.action === 'INSERT') return `Added ${noun}${label ? ` "${label}"` : ''}${where}`
    if (e.action === 'DELETE') return `Removed ${noun}${label ? ` "${label}"` : ''}${where}`
    return `Changed a ${noun}${where}`
  }
  return `${e.action} on ${e.table_name}`
}

function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return '(empty)'
  if (field === 'role') return ROLE_LABELS[value] ?? value
  if (field === 'status') return STATUS_LABELS[value] ?? value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Item content changes are shown in full on the item's History tab.
const HIDDEN_FIELDS = new Set(['values', 'version', 'version_by', 'state_id', 'state_entered_at', 'folder_id', 'position', 'next_number'])

function Changes({ entry }) {
  if (entry.action !== 'UPDATE' || !entry.changed_fields) return <span className="muted">—</span>
  const shown = entry.changed_fields.filter((f) => !HIDDEN_FIELDS.has(f))
  if (shown.length === 0) return <span className="muted small">{entry.table_name === 'items' ? 'See the item\'s history' : '—'}</span>
  return (
    <ul className="changes">
      {shown.map((f) => (
        <li key={f}>
          <span className="muted">{FIELD_LABELS[f] ?? f}:</span> <del>{formatValue(f, entry.old_values?.[f])}</del> →{' '}
          <ins>{formatValue(f, entry.new_values?.[f])}</ins>
        </li>
      ))}
    </ul>
  )
}
