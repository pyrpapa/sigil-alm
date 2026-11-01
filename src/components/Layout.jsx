import { useCallback, useEffect, useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { STATUS_LABELS } from '../lib/labels'
import Logo from './Logo'

export default function Layout({ session }) {
  const [profile, setProfile] = useState(null)
  // A project page puts its name here, beside the logo, instead of a header of its own.
  const [crumb, setCrumb] = useState(null)

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
        <div className="topbar-left">
          <Link to="/" className="brand" aria-label="Sigil home">
            <Logo height={34} compact />
          </Link>
          {crumb && (
            <nav className="topbar-crumbs" aria-label="Breadcrumb">
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
              <Link to="/" className="crumb-link">
                Projects
              </Link>
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
              <h1 className="topbar-project">{crumb.name}</h1>
              {crumb.suv && <span className="topbar-suv">{crumb.suv}</span>}
              <span className={`status status-${crumb.status}`}>{STATUS_LABELS[crumb.status] ?? crumb.status}</span>
            </nav>
          )}
        </div>
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
        <Outlet context={{ reloadProfile: loadProfile, setCrumb }} />
      </main>
    </div>
  )
}
