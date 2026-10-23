import { useState } from 'react'
import { supabase } from '../lib/supabase'

// Sign-in only, no self-registration. Users are created by an admin
// (Supabase dashboard for now), which is how access is controlled in a GxP tool.
// A link with ?demo prefills the read-only demo account (Viewer role only;
// these credentials are public by design).
const isDemo = new URLSearchParams(window.location.search).has('demo')
const DEMO_EMAIL = import.meta.env.VITE_DEMO_EMAIL ?? ''
const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD ?? ''

export default function Login() {
  const [email, setEmail] = useState(isDemo ? DEMO_EMAIL : '')
  const [password, setPassword] = useState(isDemo ? DEMO_PASSWORD : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    setBusy(false)
  }

  return (
    <div className="login">
      <form className="card" onSubmit={handleSubmit}>
        <h1>Sigil</h1>
        <p className="muted">The automation-first validation ALM</p>

        {isDemo && (
          <p className="muted">Read-only demo account, on sample data. Just click Sign in.</p>
        )}

        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </label>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}