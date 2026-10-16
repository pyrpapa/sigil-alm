import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatTimestamp } from '../lib/labels'

// A long random starting password the admin can pass on; the person changes it later.
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

// User accounts (SRS-002). Only System Admins create accounts; nothing is emailed.
// Tell the person their email and starting password; they can change it on their
// Account page. Add them to projects from each project's Members page.
export default function AdminUsers({ session }) {
  const [users, setUsers] = useState(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState(null)
  const [created, setCreated] = useState(null)

  const load = useCallback(
    () =>
      supabase.rpc('admin_list_users').then(({ data, error }) => {
        if (error) setError(error.message)
        else setUsers(data)
      }),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  async function toggleAdmin(u) {
    setError('')
    const { error } = await supabase.rpc('admin_set_system_admin', { p_user: u.id, p_on: !u.is_system_admin })
    if (error) setError(error.message)
    else load()
  }

  if (error && !users)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (!users) return <p className="muted">Loading users…</p>

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Users</h1>
        {!creating && (
          <button type="button" onClick={() => setCreating(true)}>
            New user
          </button>
        )}
      </div>
      <p className="muted small">
        Only System Admins create accounts. Nothing is emailed: give the person their email and starting password, and they can change
        the password on their Account page. Then add them to projects from each project's Members page.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {created && (
        <div className="review-status done" role="status">
          <strong>Account created for {created.name}.</strong> Sign-in email: <code>{created.email}</code> · starting password:{' '}
          <code>{created.password}</code>. Copy it now; it isn't shown again.{' '}
          <button type="button" className="secondary small" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      )}
      {creating && (
        <NewUserForm
          onCancel={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false)
            setCreated(c)
            load()
          }}
        />
      )}

      <div className="table-wrap">
        <table aria-label="Users">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Projects</th>
              <th>Last sign-in</th>
              <th>System Admin</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.full_name || <span className="muted">(no printed name)</span>}
                  {u.id === session.user.id && <span className="muted"> (you)</span>}
                </td>
                <td>{u.email}</td>
                <td>{u.projects}</td>
                <td className="small muted nowrap">{u.last_sign_in_at ? formatTimestamp(u.last_sign_in_at) : 'Never'}</td>
                <td>
                  <label className="checkbox">
                    <input type="checkbox" checked={u.is_system_admin} onChange={() => toggleAdmin(u)} aria-label={`${u.email} is a System Admin`} />
                    {u.is_system_admin ? 'Yes' : 'No'}
                  </label>
                </td>
                <td className="nowrap">
                  {resetting === u.id ? (
                    <ResetPassword
                      user={u}
                      onCancel={() => setResetting(null)}
                      onDone={(c) => {
                        setResetting(null)
                        setCreated(c)
                      }}
                    />
                  ) : (
                    <button type="button" className="secondary small" onClick={() => setResetting(u.id)}>
                      Reset password…
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function NewUserForm({ onCancel, onCreated }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState(generatePassword)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('admin_create_user', { p_email: email, p_full_name: name, p_password: password })
    setSaving(false)
    if (error) setError(error.message)
    else onCreated({ email: email.trim().toLowerCase(), name: name.trim(), password })
  }

  return (
    <form className="card form-inline" onSubmit={handleSubmit}>
      <h3>New user</h3>
      <div className="form-row">
        <label>
          Email (used to sign in)
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Printed name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </label>
      </div>
      <label>
        Starting password (at least 10 characters)
        <span className="inline-edit">
          <input value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
          <button type="button" className="secondary small" onClick={() => setPassword(generatePassword())}>
            Generate
          </button>
        </span>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || !email || !name.trim() || password.length < 10}>
          {saving ? 'Creating…' : 'Create user'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function ResetPassword({ user, onCancel, onDone }) {
  const [password, setPassword] = useState(generatePassword)
  const [error, setError] = useState('')
  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    const { error } = await supabase.rpc('admin_set_password', { p_user: user.id, p_password: password })
    if (error) setError(error.message)
    else onDone({ email: user.email, name: user.full_name || user.email, password })
  }
  return (
    <form className="inline-edit" onSubmit={handleSubmit}>
      <input aria-label={`New password for ${user.email}`} value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} />
      <button type="submit" className="small" disabled={password.length < 10}>
        Set
      </button>
      <button type="button" className="secondary small" onClick={onCancel}>
        Cancel
      </button>
      {error && <span className="error small">{error}</span>}
    </form>
  )
}
