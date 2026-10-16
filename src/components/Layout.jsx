import { useCallback, useEffect, useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Layout({ session }) {
  const [profile, setProfile] = useState(null)

  const loadProfile = useCallback(
    () =>
      supabase
        .from('profiles')
        .select('full_name, is_system_admin')
        .eq('id', session.user.id)
        .maybeSingle()
        .then(({ data }) => setProfile(data)),
    [session.user.id],
  )
  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          Sigil
        </Link>
        <nav className="topbar-right" aria-label="Main">
          <Link to="/reviews">My reviews</Link>
          {profile?.is_system_admin && <Link to="/admin/users">Users</Link>}
          <Link to="/account" className="muted" title="Your account">
            {session.user.email}
          </Link>
          <button type="button" className="secondary" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </nav>
      </header>
      <main className="content">
        {profile && !profile.full_name?.trim() && (
          <p className="notice" role="status">
            Set your printed name on your <Link to="/account">account page</Link>; it's needed before you can sign anything.
          </p>
        )}
        <Outlet context={{ reloadProfile: loadProfile }} />
      </main>
    </div>
  )
}
