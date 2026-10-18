import { useEffect, useState } from 'react'
import { Link, useOutletContext, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { loadLinkTypes, loadMembers, loadTracker } from '../../lib/trackers'
import { isItemKey, prepareImport } from '../../lib/csvImport'
import UpdateImport from './UpdateImport'

// Import items from CSV (SRS-047): choose a file, check the preview, then import.
// The preview is the database's own check, so what it shows is exactly what the
// import will do; nothing is created until every row is valid.
export default function ImportPage() {
  const { project, can } = useOutletContext()
  const { typeKey } = useParams()
  const [setup, setSetup] = useState(null)
  const [error, setError] = useState('')
  const [file, setFile] = useState(null) // { name, columns, rows }
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)

  useEffect(() => {
    let current = true
    Promise.all([loadTracker(project.id, typeKey), loadLinkTypes(project.id), loadMembers(project.id)]).then(
      ([config, linkTypes, members]) => current && setSetup({ config, linkTypes, members }),
      (e) => current && setError(e.message),
    )
    return () => {
      current = false
    }
  }, [project.id, typeKey])

  if (error && !setup)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (!setup) return <p className="muted">Loading tracker…</p>
  if (!setup.config) return <p>No tracker called {typeKey} in this project.</p>

  const { config } = setup
  const base = `/projects/${project.id}/trackers/${typeKey}`
  // Test cases are created with their requirement: their CSV updates existing ones.
  if (config.tracker.pair_tracker_id && !config.tracker.is_pair_primary)
    return can('items.edit') ? (
      <UpdateImport config={config} members={setup.members} base={base} typeKey={typeKey} />
    ) : (
      <p className="notice">Your role cannot edit items in this project.</p>
    )

  async function runImport(rows, commit, name) {
    const { data, error } = await supabase.rpc('import_items', {
      p_tracker: config.tracker.id,
      p_rows: rows.map((r) => ({ title: r.title, folder: r.folder, release: r.release, values: r.values, links: r.links })),
      p_commit: commit,
      p_source: name,
    })
    if (error) throw error
    return data
  }

  async function handleFile(e) {
    const chosen = e.target.files?.[0]
    e.target.value = ''
    if (!chosen) return
    setError('')
    setPreview(null)
    setDone(null)
    const prepared = prepareImport(await chosen.text(), config, setup.linkTypes, setup.members)
    setFile({ name: chosen.name, ...prepared })
    if (prepared.error) return
    setBusy(true)
    try {
      await resolveTitles(prepared.rows)
      setFile({ name: chosen.name, ...prepared })
      setPreview(await runImport(prepared.rows, false, chosen.name))
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  // Links given by title become the item's ID (titles are matched ignoring case).
  async function resolveTitles(rows) {
    const byTitle = {}
    const types = [...new Set(rows.flatMap((r) => r.links.filter((l) => !isItemKey(l.target)).map((l) => l.type)))]
    for (const typeKeyOfLink of types) {
      const target = setup.linkTypes.find((t) => t.key === typeKeyOfLink)?.target_type_key
      if (!target || byTitle[target]) continue
      const { data: tracker } = await supabase.from('trackers').select('id').eq('project_id', project.id).eq('type_key', target).maybeSingle()
      const { data: items } = tracker ? await supabase.from('item_heads').select('item_key, title').eq('tracker_id', tracker.id) : { data: [] }
      const map = {}
      for (const i of items ?? []) {
        const t = i.title.trim().toLowerCase()
        map[t] = map[t] && map[t] !== i.item_key ? null : i.item_key // null: title used twice
      }
      byTitle[target] = map
    }
    for (const r of rows)
      r.links = r.links.map((l) => {
        if (isItemKey(l.target)) return l
        const target = setup.linkTypes.find((t) => t.key === l.type)?.target_type_key
        const key = byTitle[target]?.[l.target.trim().toLowerCase()]
        return key ? { ...l, target: key, title: l.target } : l
      })
  }

  async function handleImport() {
    setBusy(true)
    setError('')
    try {
      const result = await runImport(file.rows, true, file.name)
      if (result.committed) setDone(result)
      else setPreview(result)
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  const results = preview?.rows ?? []
  const autoKeys = new Set(config.actions.map((a) => a.field_key))
  const importable = config.fields.filter((f) => !f.is_retired && f.field_type !== 'steps' && !autoKeys.has(f.key))
  const outgoing = setup.linkTypes.filter((t) => t.source_type_key === typeKey && !t.is_retired)
  const folderCount = new Set((file?.rows ?? []).map((r) => r.folder).filter(Boolean)).size

  return (
    <div className="stack">
      <nav className="breadcrumb" aria-label="Import breadcrumb">
        <Link to={`/projects/${project.id}/trackers`}>Trackers</Link> <span aria-hidden="true">/</span>{' '}
        <Link to={base}>{typeKey}</Link> <span aria-hidden="true">/</span> <span>Import</span>
      </nav>
      <h2>
        Import <span className="prefix">{typeKey}</span> items from CSV
      </h2>

      {!can('items.create') ? (
        <p className="notice">Your role cannot create items in this project.</p>
      ) : done ? (
        <section className="card review-status done" role="status">
          <strong>Imported {done.rows.length} items</strong> from {file.name}: {done.rows[0].item_key} to{' '}
          {done.rows[done.rows.length - 1].item_key}. They start in New. <Link to={base}>Go to the {typeKey} tracker</Link>
        </section>
      ) : (
        <section className="card stack-sm">
          <p className="small">
            The first row names the columns: <code>title</code> (required), this tracker's fields by key or label (
            {importable.map((f) => f.key).join(', ')}), and optionally <code>folder</code>
            {typeKey !== 'REL' && (
              <>
                , <code>release</code>
              </>
            )}
            {outgoing.length > 0 && (
              <>
                , and link columns ({outgoing.map((t) => `${t.key} or linked_${t.target_type_key.toLowerCase()}`).join(', ')}: the
                IDs or titles of the items to link, separated by <code>;</code>)
              </>
            )}
            . Sigil numbers new items itself, after the tracker's existing items; an <code>id</code> column is ignored.
          </p>
          <label className="file-label">
            Choose a CSV file
            <input type="file" accept=".csv,text/csv" onChange={handleFile} disabled={busy} />
          </label>
        </section>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {file?.error && (
        <p className="error" role="alert">
          {file.name}: {file.error}
        </p>
      )}

      {file?.columns && !done && (
        <section className="card">
          <h3>Columns in {file.name}</h3>
          <ul className="column-map">
            {file.columns.map((c, i) => (
              <li key={i} className={c.kind === 'ignore' ? 'ignored' : ''}>
                <code>{c.header || '(blank)'}</code> →{' '}
                {c.kind === 'field' ? c.field.label : c.kind === 'link' ? `Link (${c.linkType.label})` : c.kind === 'ignore' ? 'Not imported' : c.label ?? c.kind[0].toUpperCase() + c.kind.slice(1)}
                {c.note && <span className="muted small"> · {c.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {busy && <p className="muted">Checking rows…</p>}

      {preview && !done && (
        <>
          <div className={`review-status ${preview.error_count ? 'pending' : 'done'}`} role="status">
            {preview.error_count ? (
              <>
                <strong>
                  {preview.error_count} of {results.length} rows have problems.
                </strong>{' '}
                Nothing has been created. Fix the file and choose it again.
              </>
            ) : (
              <>
                <strong>All {results.length} rows are valid.</strong> Importing creates {results[0]?.item_key} to{' '}
                {results[results.length - 1]?.item_key}
                {folderCount > 0 && ` in ${folderCount} folders`}.
              </>
            )}
          </div>

          {!preview.error_count && (
            <div className="actions">
              <button type="button" onClick={handleImport} disabled={busy}>
                {busy ? 'Importing…' : `Import ${results.length} items`}
              </button>
            </div>
          )}

          <div className="table-wrap">
            <table aria-label="Import preview">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Will be</th>
                  <th>Title</th>
                  <th>Folder</th>
                  <th>Links</th>
                  <th>Check</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const row = file.rows[i]
                  return (
                    <tr key={r.row} className={r.errors.length ? 'row-error' : ''}>
                      <td className="muted">{row.line}</td>
                      <td className="nowrap">
                        <span className="prefix">{r.item_key}</span>
                      </td>
                      <td>{row.title || <span className="muted">(none)</span>}</td>
                      <td>{row.folder}</td>
                      <td className="small">{row.links.map((l) => l.target).join(', ')}</td>
                      <td>
                        {r.errors.length ? (
                          <span className="error small">{r.errors.join('; ')}</span>
                        ) : (
                          <span className="badge badge-good">OK</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
