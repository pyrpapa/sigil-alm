import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { loadMembers, loadReleases, loadTracker } from '../../lib/trackers'
import { formatTimestamp } from '../../lib/labels'
import ItemForm from './ItemForm'
import StateBadge from './StateBadge'
import TrashForm from '../../components/TrashForm'

async function fetchAll(projectId, typeKey) {
  const config = await loadTracker(projectId, typeKey)
  if (!config) return { config: null }
  const [{ data: items, error }, members, releases, pins] = await Promise.all([
    supabase
      .from('item_heads')
      .select('id, item_key, number, title, state_id, folder_id, revision, approved_revision, assignee, target_release_id, pair_item_id, updated_at')
      .eq('tracker_id', config.tracker.id)
      .order('number'),
    loadMembers(projectId),
    loadReleases(projectId),
    supabase.from('release_pins').select('release_id, item_id').eq('project_id', projectId),
  ])
  if (error || pins.error) throw error || pins.error
  // The requirement list shows each requirement's test case alongside it.
  let partners = {}
  if (config.tracker.is_pair_primary) {
    const [{ data: tcs, error: e1 }, { data: tcStates, error: e2 }] = await Promise.all([
      supabase.from('item_heads').select('id, item_key, state_id').eq('tracker_id', config.tracker.pair_tracker_id),
      supabase.from('tracker_states').select('id, name, is_final, review_role, locks_item, is_ready, is_rework').eq('tracker_id', config.tracker.pair_tracker_id),
    ])
    if (e1 || e2) throw e1 || e2
    partners = Object.fromEntries(tcs.map((t) => [t.id, { ...t, state: tcStates.find((s) => s.id === t.state_id) }]))
  }
  return { config, items, members, releases, pins: pins.data, partners }
}

export default function TrackerPage() {
  const { project, can } = useOutletContext()
  const { typeKey } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [folder, setFolder] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [search, setSearch] = useState('')
  const [releaseFilter, setReleaseFilter] = useState('')
  const [newFolder, setNewFolder] = useState(null)
  const [deletingFolder, setDeletingFolder] = useState(null)

  const reload = useCallback(
    () => fetchAll(project.id, typeKey).then(setData, (e) => setError(e.message)),
    [project.id, typeKey],
  )

  useEffect(() => {
    let current = true
    fetchAll(project.id, typeKey).then(
      (d) => current && setData(d),
      (e) => current && setError(e.message),
    )
    return () => {
      current = false
    }
  }, [project.id, typeKey])

  const stateById = useMemo(() => Object.fromEntries((data?.config?.states ?? []).map((s) => [s.id, s])), [data])

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (!data) return <p className="muted">Loading tracker…</p>
  if (!data.config) return <p>No tracker called {typeKey} in this project.</p>

  const { config, items, members, releases, pins, partners } = data
  const hub = config.tracker.is_pair_primary
  // Test cases paired with requirements are created with them, not on their own.
  const secondary = Boolean(config.tracker.pair_tracker_id) && !config.tracker.is_pair_primary
  // In a release = pinned there, or an open draft aimed at it.
  const inRelease = (i) =>
    i.target_release_id === releaseFilter || pins.some((p) => p.release_id === releaseFilter && p.item_id === i.id)
  const q = search.trim().toLowerCase()
  const shown = items.filter(
    (i) =>
      (!folder || (folder === 'none' ? !i.folder_id : i.folder_id === folder)) &&
      (!stateFilter || i.state_id === stateFilter) &&
      (!releaseFilter || inRelease(i)) &&
      (!q || i.item_key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)),
  )
  const base = `/projects/${project.id}/trackers/${typeKey}`

  async function addFolder(e) {
    e.preventDefault()
    const { error } = await supabase.rpc('create_folder', { p_tracker: config.tracker.id, p_name: newFolder.trim() })
    if (error) setError(error.message)
    else {
      setNewFolder(null)
      reload()
    }
  }

  return (
    <div className="stack">
      <div className="card-head">
        <h2>
          <Link to={`/projects/${project.id}/trackers`}>Trackers</Link> / <span className="prefix">{config.tracker.type_key}</span>{' '}
          {hub ? 'Requirements & Test Cases' : config.tracker.name}
        </h2>
        <div className="actions">
          {can('trackers.configure') && (
            <Link className="button secondary-link" to={`${base}/config`}>
              Configure
            </Link>
          )}
          {secondary && <span className="muted small">Test cases are created with their requirement.</span>}
          {can('items.create') && !secondary && (
            <Link className="button secondary-link" to={`${base}/import`}>
              Import CSV
            </Link>
          )}
          {can('items.create') && !creating && !secondary && (
            <button type="button" onClick={() => setCreating(true)}>
              New {config.tracker.type_key} item
            </button>
          )}
        </div>
      </div>

      {creating && (
        <ItemForm
          config={config}
          members={members}
          releases={releases}
          onCancel={() => setCreating(false)}
          onSaved={(item) => navigate(`${base}/${item.item_key}`)}
        />
      )}

      <div className="tracker-layout">
        <aside className="folders" aria-label="Folders">
          <h3 className="small muted">Folders</h3>
          <ul>
            <li>
              <button type="button" className={`folder${folder === '' ? ' active' : ''}`} onClick={() => setFolder('')}>
                All items <span className="muted">{items.length}</span>
              </button>
            </li>
            {config.folders.map((f) => (
              <li key={f.id}>
                <button type="button" className={`folder${folder === f.id ? ' active' : ''}`} onClick={() => setFolder(f.id)}>
                  {f.name} <span className="muted">{items.filter((i) => i.folder_id === f.id).length}</span>
                </button>
                {folder === f.id && can('trash.manage') && (
                  <button
                    type="button"
                    className="link-button small muted"
                    aria-label={`Delete folder ${f.name}`}
                    onClick={() => setDeletingFolder(f)}
                  >
                    Delete folder…
                  </button>
                )}
              </li>
            ))}
            {config.folders.length > 0 && (
              <li>
                <button type="button" className={`folder${folder === 'none' ? ' active' : ''}`} onClick={() => setFolder('none')}>
                  No folder <span className="muted">{items.filter((i) => !i.folder_id).length}</span>
                </button>
              </li>
            )}
          </ul>
          {can('items.create') &&
            (newFolder === null ? (
              <button type="button" className="secondary small" onClick={() => setNewFolder('')}>
                + Folder
              </button>
            ) : (
              <form className="form-inline" onSubmit={addFolder}>
                <input aria-label="Folder name" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} autoFocus maxLength={100} />
                <div className="actions">
                  <button type="submit" className="small" disabled={!newFolder.trim()}>
                    Add
                  </button>
                  <button type="button" className="secondary small" onClick={() => setNewFolder(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ))}
        </aside>

        <div className="stack">
          {deletingFolder && (
            <TrashForm
              key={deletingFolder.id}
              title={`Delete folder "${deletingFolder.name}"?`}
              submitLabel="Delete folder"
              onDelete={(reason) => supabase.rpc('trash_folder', { p_folder: deletingFolder.id, p_reason: reason })}
              onDone={() => {
                setDeletingFolder(null)
                setFolder('')
                reload()
              }}
              onCancel={() => setDeletingFolder(null)}
            >
              <p>
                The folder and the {items.filter((i) => i.folder_id === deletingFolder.id).length} item(s) in it leave the tracker
                {hub ? ', with their test cases' : ''}. Items in a release, or planned for one, must be taken out of it first.
              </p>
            </TrashForm>
          )}
          <div className="filters">
            <label>
              Search
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ID or title" />
            </label>
            <label>
              State
              <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">All states</option>
                {config.states
                  .filter((s) => !s.is_retired)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
            {releases.length > 0 && typeKey !== 'REL' && (
              <label>
                Release
                <select value={releaseFilter} onChange={(e) => setReleaseFilter(e.target.value)}>
                  <option value="">All releases</option>
                  {releases.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.item_key} {r.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="table-wrap">
            <table aria-label={`${config.tracker.type_key} items`}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>State</th>
                  {hub && <th>Test case</th>}
                  <th>Version</th>
                  <th>Assignee</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id}>
                    <td className="nowrap">
                      <Link to={`${base}/${i.item_key}`}>{i.item_key}</Link>
                    </td>
                    <td>{i.title}</td>
                    <td>
                      <StateBadge state={stateById[i.state_id]} />
                    </td>
                    {hub && (
                      <td className="nowrap">
                        {partners[i.pair_item_id] ? (
                          <>
                            <span className="prefix small">{partners[i.pair_item_id].item_key}</span>{' '}
                            {partners[i.pair_item_id].state?.name !== stateById[i.state_id]?.name && <StateBadge state={partners[i.pair_item_id].state} />}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    )}
                    <td className="nowrap">
                      v{i.revision}
                      {i.approved_revision && i.approved_revision !== i.revision && (
                        <div className="muted small">v{i.approved_revision} approved</div>
                      )}
                    </td>
                    <td className="small">
                      {stateById[i.state_id]?.is_final ? (
                        <span className="muted">—</span>
                      ) : (
                        (members.find((m) => m.user_id === i.assignee)?.full_name ?? <span className="muted">Nobody</span>)
                      )}
                    </td>
                    <td className="small muted nowrap">{formatTimestamp(i.updated_at)}</td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={hub ? 7 : 6} className="muted">
                      {items.length === 0 ? 'No items yet.' : 'No items match.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Showing {shown.length} of {items.length}
          </p>
        </div>
      </div>
    </div>
  )
}
