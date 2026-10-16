import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { formatTimestamp, ROLE_LABELS, ROLES } from '../../lib/labels'

export default function ProjectMembers() {
  const { project, can, userId } = useOutletContext()
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [pending, setPending] = useState(null) // { type: 'role' | 'remove', member, role? }

  const canManage = can('members.manage')

  const apply = useCallback(({ data, error }) => {
    if (error) setError(error.message)
    else setMembers(data)
    setLoading(false)
  }, [])

  const load = useCallback(
    () => supabase.rpc('project_member_list', { p_project: project.id }).then(apply),
    [project.id, apply],
  )

  useEffect(() => {
    let current = true
    supabase.rpc('project_member_list', { p_project: project.id }).then((res) => current && apply(res))
    return () => {
      current = false
    }
  }, [project.id, apply])

  async function afterChange() {
    setPending(null)
    setShowAdd(false)
    await load()
  }

  return (
    <div className="stack">
      <div className="card-head">
        <h2>Members</h2>
        {canManage && !showAdd && (
          <button type="button" onClick={() => setShowAdd(true)}>
            Add member
          </button>
        )}
      </div>

      {showAdd && <AddMemberForm projectId={project.id} onCancel={() => setShowAdd(false)} onAdded={afterChange} />}

      {pending && (
        <ConfirmChangeForm projectId={project.id} pending={pending} onCancel={() => setPending(null)} onDone={afterChange} />
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="muted">Loading members…</p>
      ) : (
        <div className="table-wrap">
          <table aria-label="Members">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Added</th>
                {canManage && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.user_id}>
                  <td>
                    {m.full_name || <span className="muted">No name set</span>}
                    {m.user_id === userId && <span className="muted"> (you)</span>}
                  </td>
                  <td>{m.email}</td>
                  <td>
                    {canManage ? (
                      <select
                        aria-label={`Role for ${m.full_name || m.email}`}
                        value={m.role}
                        onChange={(e) => setPending({ type: 'role', member: m, role: e.target.value })}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABELS[m.role]
                    )}
                  </td>
                  <td className="muted small">
                    {formatTimestamp(m.added_at)}
                    {m.added_by_name && <div>by {m.added_by_name}</div>}
                  </td>
                  {canManage && (
                    <td>
                      <button type="button" className="secondary small" onClick={() => setPending({ type: 'remove', member: m })}>
                        Remove
                      </button>
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

function AddMemberForm({ projectId, onCancel, onAdded }) {
  const [people, setPeople] = useState(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Everyone with a Sigil account who is not in this project yet.
  useEffect(() => {
    let current = true
    supabase.rpc('project_addable_users', { p_project: projectId }).then(({ data, error }) => {
      if (!current) return
      if (error) setError(error.message)
      else setPeople(data)
    })
    return () => {
      current = false
    }
  }, [projectId])

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('add_project_member', {
      p_project: projectId,
      p_email: email.trim(),
      p_role: role,
      p_reason: reason.trim() || null,
    })
    setSaving(false)
    if (error) setError(error.message)
    else onAdded()
  }

  return (
    <form className="card form-inline" onSubmit={handleSubmit}>
      <h3>Add member</h3>
      <p className="muted small">
        Choose from everyone with a Sigil account. Someone not listed needs an account first, created by a System Admin
        under Users.
      </p>
      <div className="form-row">
        <label>
          Person
          <select value={email} onChange={(e) => setEmail(e.target.value)} required disabled={!people?.length}>
            <option value="">
              {people === null ? 'Loading…' : people.length === 0 ? 'Everyone is already a member' : 'Choose a person'}
            </option>
            {(people ?? []).map((p) => (
              <option key={p.id} value={p.email}>
                {p.full_name ? `${p.full_name} (${p.email})` : p.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Reason (recorded in the audit trail)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || !email.trim()}>
          {saving ? 'Adding…' : 'Add member'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// Role changes and removals ask for a reason before they happen.
function ConfirmChangeForm({ projectId, pending, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const { member } = pending
  const who = member.full_name || member.email
  const isRemove = pending.type === 'remove'

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = isRemove
      ? await supabase.rpc('remove_project_member', { p_project: projectId, p_user: member.user_id, p_reason: reason.trim() })
      : await supabase.rpc('update_member_role', {
          p_project: projectId,
          p_user: member.user_id,
          p_role: pending.role,
          p_reason: reason.trim(),
        })
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="card form-inline" onSubmit={handleSubmit}>
      <h3>
        {isRemove
          ? `Remove ${who} from this project?`
          : `Change ${who}'s role from ${ROLE_LABELS[member.role]} to ${ROLE_LABELS[pending.role]}?`}
      </h3>
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
          {saving ? 'Saving…' : isRemove ? 'Remove member' : 'Change role'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
