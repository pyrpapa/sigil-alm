import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// Your account: the printed name shown on your signatures, and your password.
export default function AccountPage({ session }) {
  const { reloadProfile } = useOutletContext() ?? {}
  const [profile, setProfile] = useState(null)
  const [name, setName] = useState('')
  const [nameMsg, setNameMsg] = useState('')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    supabase
      .from('profiles')
      .select('full_name, is_system_admin')
      .eq('id', session.user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else {
          setProfile(data)
          setName(data?.full_name ?? '')
        }
      })
  }, [session.user.id])

  async function saveName(e) {
    e.preventDefault()
    setError('')
    setNameMsg('')
    const { error } = await supabase.from('profiles').update({ full_name: name.trim() }).eq('id', session.user.id)
    if (error) setError(error.message)
    else {
      setNameMsg('Saved.')
      setProfile((p) => ({ ...p, full_name: name.trim() }))
      reloadProfile?.()
    }
  }

  async function changePassword(e) {
    e.preventDefault()
    setError('')
    setPwMsg('')
    const { error } = await supabase.rpc('change_my_password', { p_current: current, p_new: next })
    if (error) setError(error.message)
    else {
      setPwMsg('Password changed. Use it next time you sign in or sign.')
      setCurrent('')
      setNext('')
      setAgain('')
    }
  }

  if (!profile) return <p className="muted">Loading your account…</p>

  return (
    <div className="stack narrow">
      <h1>Your account</h1>
      <p className="muted">
        {session.user.email}
        {profile.is_system_admin && ' · System Admin'}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <form className="card form-inline" onSubmit={saveName}>
        <h3>Printed name</h3>
        <p className="small muted">Shown with every electronic signature you make, so use your full name.</p>
        <label>
          Printed name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </label>
        <div className="actions">
          <button type="submit" disabled={!name.trim() || name.trim() === profile.full_name}>
            Save name
          </button>
          {nameMsg && <span className="small ok-text">{nameMsg}</span>}
        </div>
      </form>

      <form className="card form-inline" onSubmit={changePassword}>
        <h3>Change password</h3>
        <label>
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </label>
        <label>
          New password (at least 10 characters)
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} autoComplete="new-password" />
        </label>
        <label>
          New password again
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} required autoComplete="new-password" />
        </label>
        {again && next !== again && <p className="small error">The new passwords don't match.</p>}
        <div className="actions">
          <button type="submit" disabled={!current || next.length < 10 || next !== again}>
            Change password
          </button>
          {pwMsg && (
            <span className="small ok-text" role="status">
              {pwMsg}
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
