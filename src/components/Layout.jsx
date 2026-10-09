import { Link, Outlet } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function Layout({ session }) {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          Sigil
        </Link>
        <div className="topbar-right">
          <span className="muted">{session.user.email}</span>
          <button type="button" className="secondary" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
