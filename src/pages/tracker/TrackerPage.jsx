import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { loadLinkTypes, loadMembers, loadReleases, loadTracker } from '../../lib/trackers'
import { downloadCsv, exportItems } from '../../lib/csvExport'
import { formatTimestamp } from '../../lib/labels'
import ItemForm from './ItemForm'
import StateBadge from './StateBadge'
import BulkActions, { BulkResults } from './BulkActions'
import ItemPreview from './ItemPreview'
import TrashForm from '../../components/TrashForm'

// The list shows the local date; the full timestamp with its time zone is on hover.
const shortDate = (value) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const HEAD_COLUMNS =
  'id, item_key, number, title, values, state_id, folder_id, revision, approved_revision, assignee, target_release_id, pair_item_id, updated_at'

async function loadItems(trackerId) {
  const { data, error } = await supabase.from('item_heads').select(HEAD_COLUMNS).eq('tracker_id', trackerId).order('number')
  if (error) throw error
  return data
}

// A tracker, its items, and for a paired tracker (SRS + TC) the other half too, so the
// page can switch between requirements and test cases without loading again.
async function fetchAll(projectId, typeKey) {
  const config = await loadTracker(projectId, typeKey)
  if (!config) return { config: null }
  let pairKey = null
  if (config.tracker.pair_tracker_id) {
    const { data, error } = await supabase.from('trackers').select('type_key').eq('id', config.tracker.pair_tracker_id).single()
    if (error) throw error
    pairKey = data.type_key
  }
  // A test case's list lives on its requirement's page.
  if (pairKey && !config.tracker.is_pair_primary) return { config, redirectTo: pairKey }

  const [items, members, releases, pins, editRoles, pairConfig] = await Promise.all([
    loadItems(config.tracker.id),
    loadMembers(projectId),
    loadReleases(projectId),
    supabase.from('release_pins').select('release_id, item_id').eq('project_id', projectId),
    supabase.from('role_permissions').select('role').eq('project_id', projectId).eq('permission', 'items.edit'),
    pairKey ? loadTracker(projectId, pairKey) : null,
  ])
  for (const r of [pins, editRoles]) if (r.error) throw r.error
  const pair = pairConfig ? { config: pairConfig, items: await loadItems(pairConfig.tracker.id) } : null
  return {
    config,
    items,
    pair,
    members,
    editors: members.filter((m) => editRoles.data.some((r) => r.role === m.role)),
    releases,
    pins: pins.data,
  }
}

export default function TrackerPage() {
  const { project } = useOutletContext()
  const { typeKey } = useParams()
  const [params, setParams] = useSearchParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

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

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (!data) return <p className="muted">Loading tracker…</p>
  if (!data.config) return <p>No tracker called {typeKey} in this project.</p>
  if (data.redirectTo) return <Navigate to={`/projects/${project.id}/trackers/${data.redirectTo}?view=tc`} replace />

  const view = data.pair && params.get('view') === 'tc' ? 'tc' : 'main'
  const setView = (v) => setParams(v === 'tc' ? { view: 'tc' } : {}, { replace: true })
  return <TrackerList key={view} data={data} view={view} setView={setView} reload={reload} />
}

function TrackerList({ data, view, setView, reload }) {
  const { project, can } = useOutletContext()
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [folder, setFolder] = useState('')
  const [stateFilter, setStateFilter] = useState('')
  const [search, setSearch] = useState('')
  const [releaseFilter, setReleaseFilter] = useState('')
  const [newFolder, setNewFolder] = useState(null)
  const [exporting, setExporting] = useState(false)
  const [deletingFolder, setDeletingFolder] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [previewId, setPreviewId] = useState(null)
  const [bulkResults, setBulkResults] = useState(null)

  const { members, editors, releases, pins } = data
  const hub = Boolean(data.pair)
  // The side being listed, and the other half of the pair (if any).
  const listingPair = view === 'tc'
  const config = listingPair ? data.pair.config : data.config
  const items = listingPair ? data.pair.items : data.items
  const other = useMemo(
    () => (data.pair ? (listingPair ? { config: data.config, items: data.items } : data.pair) : null),
    [data, listingPair],
  )
  const typeKey = config.tracker.type_key
  // Folders belong to the requirements; test cases are filed with their requirement.
  const folders = data.config.folders

  const stateById = useMemo(() => Object.fromEntries(config.states.map((s) => [s.id, s])), [config])
  const otherStateById = useMemo(() => Object.fromEntries((other?.config.states ?? []).map((s) => [s.id, s])), [other])
  const otherById = useMemo(() => Object.fromEntries((other?.items ?? []).map((i) => [i.id, i])), [other])

  const folderOf = (i) => (listingPair ? otherById[i.pair_item_id]?.folder_id : i.folder_id)
  // In a release = pinned there, or an open draft aimed at it.
  const inRelease = (i) =>
    i.target_release_id === releaseFilter || pins.some((p) => p.release_id === releaseFilter && p.item_id === i.id)
  const q = search.trim().toLowerCase()
  const matchesExceptState = (i) =>
    (!folder || (folder === 'none' ? !folderOf(i) : folderOf(i) === folder)) &&
    (!releaseFilter || inRelease(i)) &&
    (!q || i.item_key.toLowerCase().includes(q) || i.title.toLowerCase().includes(q))
  const beforeState = items.filter(matchesExceptState)
  const shown = beforeState.filter((i) => !stateFilter || i.state_id === stateFilter)
  const selectedShown = shown.filter((i) => selected.has(i.id))
  const previewIndex = shown.findIndex((i) => i.id === previewId)
  const previewItem = previewIndex >= 0 ? shown[previewIndex] : null

  const base = `/projects/${project.id}/trackers/${typeKey}`
  const statementsField = config.fields.find((f) => f.field_type === 'statements' && !f.is_retired)
  const stepsField = config.fields.find((f) => f.field_type === 'steps' && !f.is_retired)
  const execField = config.fields.find((f) => f.key === 'execution_type' && !f.is_retired)
  const columnCount = 7 + (hub ? 1 : 0) + (statementsField ? 1 : 0) + (stepsField ? 1 : 0) + (execField ? 1 : 0)

  // Arrow keys move the preview through the list; Escape closes it.
  useEffect(() => {
    if (!previewItem) return
    function onKey(e) {
      if (e.target.closest?.('input, select, textarea, [contenteditable]')) return
      if (e.key === 'Escape') setPreviewId(null)
      else if (e.key === 'ArrowDown' && previewIndex < shown.length - 1) {
        e.preventDefault()
        setPreviewId(shown[previewIndex + 1].id)
      } else if (e.key === 'ArrowUp' && previewIndex > 0) {
        e.preventDefault()
        setPreviewId(shown[previewIndex - 1].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewItem, previewIndex, shown])

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allShownSelected = shown.length > 0 && selectedShown.length === shown.length
  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const i of shown) {
        if (allShownSelected) next.delete(i.id)
        else next.add(i.id)
      }
      return next
    })
  }

  // Export the given items (by default, those shown with the current filters).
  async function exportList(list) {
    setExporting(true)
    setError('')
    try {
      const text = await exportItems({
        config,
        items: list,
        members,
        states: config.states,
        folders: config.folders,
        partners: hub && !listingPair ? Object.fromEntries(data.pair.items.map((t) => [t.id, { ...t, state: otherStateById[t.state_id] }])) : {},
        linkTypes: await loadLinkTypes(project.id),
        releases,
      })
      const date = new Date().toISOString().slice(0, 10)
      downloadCsv(text, `${project.name}-${typeKey}-${date}.csv`.replace(/[^\w.-]+/g, '_'))
    } catch (e) {
      setError(e.message)
    }
    setExporting(false)
  }

  async function addFolder(e) {
    e.preventDefault()
    const { error } = await supabase.rpc('create_folder', { p_tracker: data.config.tracker.id, p_name: newFolder.trim() })
    if (error) setError(error.message)
    else {
      setNewFolder(null)
      reload()
    }
  }

  const otherCell = (i) => {
    const o = otherById[i.pair_item_id]
    if (!o) return <span className="muted">—</span>
    return (
      <span className="nowrap">
        <span className="prefix small">{o.item_key}</span>{' '}
        <span className="optional-col">
          <StateBadge state={otherStateById[o.state_id]} />
        </span>
      </span>
    )
  }

  return (
    <div className="stack">
      <div className="card-head">
        <h2>
          <Link to={`/projects/${project.id}/trackers`}>Trackers</Link> /{' '}
          <span className="prefix">{hub ? `${data.config.tracker.type_key} + ${data.pair.config.tracker.type_key}` : typeKey}</span>{' '}
          {hub ? 'Requirements & Test Cases' : config.tracker.name}
        </h2>
        <div className="actions">
          {can('trackers.configure') && (
            <Link className="button secondary-link" to={`${base}/config`}>
              Configure {hub ? typeKey : ''}
            </Link>
          )}
          {listingPair && can('items.edit') && (
            <Link className="button secondary-link" to={`${base}/import`}>
              Update from CSV
            </Link>
          )}
          <button type="button" className="secondary" onClick={() => exportList(shown)} disabled={exporting || shown.length === 0}>
            {exporting ? 'Exporting…' : `Export CSV (${shown.length})`}
          </button>
          {can('items.create') && !listingPair && (
            <Link className="button secondary-link" to={`${base}/import`}>
              Import CSV
            </Link>
          )}
          {can('items.create') && !creating && !listingPair && (
            <button type="button" onClick={() => setCreating(true)}>
              New {typeKey} item
            </button>
          )}
        </div>
      </div>

      {hub && (
        <nav className="tabs list-tabs" aria-label="Requirements or test cases">
          <button type="button" className={`tab${view === 'main' ? ' active' : ''}`} aria-pressed={view === 'main'} onClick={() => setView('main')}>
            Requirements ({data.items.length})
          </button>
          <button type="button" className={`tab${view === 'tc' ? ' active' : ''}`} aria-pressed={view === 'tc'} onClick={() => setView('tc')}>
            Test cases ({data.pair.items.length})
          </button>
        </nav>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

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
            {folders.map((f) => (
              <li key={f.id}>
                <button type="button" className={`folder${folder === f.id ? ' active' : ''}`} onClick={() => setFolder(f.id)}>
                  {f.name} <span className="muted">{items.filter((i) => folderOf(i) === f.id).length}</span>
                </button>
                {folder === f.id && can('trash.manage') && !listingPair && (
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
            {folders.length > 0 && (
              <li>
                <button type="button" className={`folder${folder === 'none' ? ' active' : ''}`} onClick={() => setFolder('none')}>
                  No folder <span className="muted">{items.filter((i) => !folderOf(i)).length}</span>
                </button>
              </li>
            )}
          </ul>
          {listingPair && folders.length > 0 && <p className="small muted">Test cases are filed with their requirement.</p>}
          {can('items.create') &&
            !listingPair &&
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

          <StateSummary states={config.states} items={beforeState} value={stateFilter} onChange={setStateFilter} />

          {selectedShown.length > 0 && (
            <BulkActions
              can={can}
              config={config}
              items={selectedShown}
              stateById={stateById}
              folders={listingPair ? [] : folders}
              editors={editors}
              members={members}
              releases={releases}
              hub={hub && !listingPair}
              exporting={exporting}
              onExport={() => exportList(selectedShown)}
              onClear={() => setSelected(new Set())}
              onDone={(outcome) => {
                setBulkResults(outcome)
                setSelected((prev) => new Set([...prev].filter((id) => !outcome.okIds.includes(id))))
                reload()
              }}
            />
          )}
          {bulkResults && <BulkResults results={bulkResults} onDismiss={() => setBulkResults(null)} />}

          <div className={`list-with-preview${previewItem ? ' open' : ''}`}>
            <div className="stack-sm">
              <div className="table-wrap">
                <table aria-label={`${typeKey} items`}>
                  <thead>
                    <tr>
                      <th className="select-col">
                        <input
                          type="checkbox"
                          aria-label={allShownSelected ? 'Clear selection' : `Select all ${shown.length} shown`}
                          checked={allShownSelected}
                          ref={(el) => el && (el.indeterminate = selectedShown.length > 0 && !allShownSelected)}
                          onChange={toggleAll}
                          disabled={shown.length === 0}
                        />
                      </th>
                      <th>ID</th>
                      <th>Title</th>
                      <th>State</th>
                      {hub && <th>{listingPair ? 'Requirement' : 'Test case'}</th>}
                      {statementsField && <th className="optional-col">ERs</th>}
                      {execField && <th className="optional-col">Execution</th>}
                      {stepsField && <th className="optional-col">Steps</th>}
                      <th className="optional-col">Version</th>
                      <th className="optional-col">Assignee</th>
                      <th className="optional-col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((i) => {
                      const state = stateById[i.state_id]
                      return (
                        <tr
                          key={i.id}
                          className={`${selected.has(i.id) ? 'selected' : ''}${previewId === i.id ? ' previewing' : ''}`.trim() || undefined}
                        >
                          <td className="select-col">
                            <input type="checkbox" aria-label={`Select ${i.item_key}`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                          </td>
                          <td className="nowrap">
                            <Link to={`${base}/${i.item_key}`}>{i.item_key}</Link>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="title-button"
                              aria-label={`Preview ${i.item_key} ${i.title}`}
                              aria-expanded={previewId === i.id}
                              onClick={() => setPreviewId(previewId === i.id ? null : i.id)}
                            >
                              {i.title}
                            </button>
                          </td>
                          <td>
                            <StateBadge state={state} />
                          </td>
                          {hub && <td>{otherCell(i)}</td>}
                          {statementsField && <td className="small nowrap optional-col">{(i.values?.[statementsField.key] ?? []).length || <span className="muted">—</span>}</td>}
                          {execField && <td className="small nowrap optional-col">{i.values?.[execField.key] ?? <span className="muted">—</span>}</td>}
                          {stepsField && <td className="small nowrap optional-col">{(i.values?.[stepsField.key] ?? []).length || <span className="muted">—</span>}</td>}
                          <td className="nowrap optional-col">
                            v{i.revision}
                            {i.approved_revision && i.approved_revision !== i.revision && (
                              <div className="muted small">v{i.approved_revision} approved</div>
                            )}
                          </td>
                          <td className="small optional-col">
                            {state?.is_final ? (
                              <span className="muted">—</span>
                            ) : (
                              (members.find((m) => m.user_id === i.assignee)?.full_name ?? <span className="muted">Nobody</span>)
                            )}
                          </td>
                          <td className="small muted nowrap optional-col" title={formatTimestamp(i.updated_at)}>
                            {shortDate(i.updated_at)}
                          </td>
                        </tr>
                      )
                    })}
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={columnCount} className="muted">
                          {items.length === 0 ? 'No items yet.' : 'No items match.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                Showing {shown.length} of {items.length}
                {selectedShown.length > 0 && ` · ${selectedShown.length} selected`} · Select a title to preview it
              </p>
            </div>

            {previewItem && (
              <ItemPreview
                key={previewItem.id}
                item={previewItem}
                config={config}
                state={stateById[previewItem.state_id]}
                partner={otherById[previewItem.pair_item_id]}
                partnerConfig={other?.config}
                partnerState={otherStateById[otherById[previewItem.pair_item_id]?.state_id]}
                folders={folders}
                folderId={folderOf(previewItem)}
                members={members}
                releases={releases}
                href={`${base}/${previewItem.item_key}`}
                position={`${previewIndex + 1} of ${shown.length}`}
                onClose={() => setPreviewId(null)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// One chip per state with how many items (matching the other filters) are in it.
// Choosing a chip filters by that state; choosing it again clears the filter.
function StateSummary({ states, items, value, onChange }) {
  const counts = {}
  for (const i of items) counts[i.state_id] = (counts[i.state_id] ?? 0) + 1
  const list = states.filter((s) => !s.is_retired || counts[s.id])
  if (items.length === 0) return null
  return (
    <div className="state-summary" role="group" aria-label="Items by state">
      {list.map((s) => (
        <button
          key={s.id}
          type="button"
          className={value === s.id ? 'active' : undefined}
          aria-pressed={value === s.id}
          onClick={() => onChange(value === s.id ? '' : s.id)}
        >
          <StateBadge state={s} />
          <span className="count">{counts[s.id] ?? 0}</span>
        </button>
      ))}
    </div>
  )
}
