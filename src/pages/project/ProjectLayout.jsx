import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

const PROJECT_COLUMNS = 'id, name, system_under_validation, status, planned_start, planned_end, repository_url, created_at, created_by'

async function fetchProject(projectId, userId) {
  const [projectRes, permsRes, roleRes] = await Promise.all([
    supabase.from('projects').select(PROJECT_COLUMNS).eq('id', projectId).maybeSingle(),
    supabase.rpc('my_project_permissions', { p_project: projectId }),
    supabase.from('project_members').select('role').eq('project_id', projectId).eq('user_id', userId).maybeSingle(),
  ])
  const failed = projectRes.error || permsRes.error || roleRes.error
  if (failed) return { state: 'error', error: failed.message }
  if (!projectRes.data) return { state: 'missing' }
  return { state: 'ready', project: projectRes.data, permissions: permsRes.data ?? [], role: roleRes.data?.role ?? null }
}

export default function ProjectLayout({ session }) {
  const { projectId } = useParams()
  const [project, setProject] = useState(null)
  const [permissions, setPermissions] = useState([])
  const [role, setRole] = useState(null)
  const [state, setState] = useState('loading') // loading | ready | missing | error
  const [error, setError] = useState('')
  const [reviewCount, setReviewCount] = useState(0)

  const apply = useCallback((result) => {
    setState(result.state)
    setError(result.error ?? '')
    if (result.project) setProject(result.project)
    if (result.permissions) setPermissions(result.permissions)
    if (result.role !== undefined) setRole(result.role)
  }, [])

  const userId = session.user.id
  const load = useCallback(() => fetchProject(projectId, userId).then(apply), [projectId, userId, apply])

  useEffect(() => {
    let current = true
    fetchProject(projectId, userId).then((result) => current && apply(result))
    return () => {
      current = false
    }
  }, [projectId, userId, apply])

  // How many of this project's items wait on me (to sign, or sent back to me), for the tab.
  const refreshReviews = useCallback(
    () =>
      supabase.rpc('my_review_queue').then(({ data }) => setReviewCount((data ?? []).filter((r) => r.project_id === projectId).length)),
    [projectId],
  )
  useEffect(() => {
    refreshReviews()
  }, [refreshReviews])

  // The project's name, subtitle and status show in the top bar (Layout), beside the logo.
  const { setCrumb } = useOutletContext() ?? {}
  useEffect(() => {
    if (project && setCrumb) setCrumb({ name: project.name, suv: project.system_under_validation, status: project.status })
  }, [project, setCrumb])
  useEffect(() => () => setCrumb?.(null), [setCrumb])

  if (state === 'loading') return <p className="muted">Loading project…</p>
  if (state === 'error')
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (state === 'missing')
    return (
      <section>
        <p>This project doesn't exist, or you're not a member of it.</p>
        <Link to="/">Back to projects</Link>
      </section>
    )

  const archived = project.status === 'archived'
  // can() hides buttons the user can't use; the database enforces the same rules regardless.
  const can = (permission) => permissions.includes(permission) && (!archived || permission === 'project.archive')

  return (
    <section>
      {archived && (
        <p className="notice" role="status">
          This project is archived. Its records are read-only.
        </p>
      )}

      <nav className="tabs" aria-label="Project sections">
        <NavLink to="." end>
          Overview
        </NavLink>
        <NavLink to="trackers">Trackers</NavLink>
        <NavLink to="reviews">
          Reviews
          {reviewCount > 0 && (
            <span className="tab-count" aria-label={`${reviewCount} waiting for you`}>
              {reviewCount}
            </span>
          )}
        </NavLink>
        <NavLink to="repository">Repository</NavLink>
        <NavLink to="members">Members</NavLink>
        <NavLink to="activity">Activity</NavLink>
        <NavLink to="trash">Trash</NavLink>
      </nav>

      <Outlet context={{ project, setProject, can, role, reload: load, userId, refreshReviews }} />
    </section>
  )
}
