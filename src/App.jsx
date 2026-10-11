import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabase'
import Layout from './components/Layout'
import Login from './pages/Login'
import Projects from './pages/Projects'
import ProjectLayout from './pages/project/ProjectLayout'
import ProjectOverview from './pages/project/ProjectOverview'
import ProjectMembers from './pages/project/ProjectMembers'
import ProjectActivity from './pages/project/ProjectActivity'
import ProjectTrackers from './pages/project/ProjectTrackers'
import ProjectRepository from './pages/project/ProjectRepository'
import TrackerView from './preview/TrackerView'
import ItemView from './preview/ItemView'
import RunView from './preview/RunView'

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
          <Route path="/projects/:projectId" element={<ProjectLayout session={session} />}>
            <Route index element={<ProjectOverview />} />
            <Route path="trackers" element={<ProjectTrackers />} />
            {/* Preview screens on sample data until real trackers arrive (Phase 2d) */}
            <Route path="trackers/:trackerKey" element={<TrackerView />} />
            <Route path="trackers/:trackerKey/:itemKey" element={<ItemView />} />
            <Route path="trackers/:trackerKey/:itemKey/run" element={<RunView />} />
            <Route path="repository" element={<ProjectRepository />} />
            <Route path="members" element={<ProjectMembers />} />
            <Route path="activity" element={<ProjectActivity />} />
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
