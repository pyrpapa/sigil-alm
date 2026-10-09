import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabase'
import Layout from './components/Layout'
import Login from './pages/Login'
import Projects from './pages/Projects'

export default function App() {
  // undefined = still checking, null = signed out, object = signed in
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => setSession(newSession))
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return <p className="loading">Loading…</p>

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />

        {/* Everything inside this route requires a signed-in user */}
        <Route element={session ? <Layout session={session} /> : <Navigate to="/login" replace />}>
          <Route path="/" element={<Projects />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
