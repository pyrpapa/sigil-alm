import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { cleanSteps, isEmpty } from '../../lib/trackers'
import { prepareUpdate } from '../../lib/csvImport'

// Update existing items from CSV: export the tracker, edit the file (e.g. write the test
// steps), and bring it back. Each row is matched to an item by its id; only the title and
// fields in the file change. Rows that change nothing are skipped. Every update is a normal
// edit, recorded in the audit trail with the file name as the reason.
export default function UpdateImport({ config, members, base, typeKey }) {
  const [file, setFile] = useState(null) // { name, rows }
  const [plan, setPlan] = useState(null) // [{ row, head, title, values, changes, errors }]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(null) // { updated, failed: [{ key, message }] }

  const stepKeys = new Set(config.fields.filter((f) => f.field_type === 'steps').map((f) => f.key))
  const comparable = (key, v) => JSON.stringify(stepKeys.has(key) && Array.isArray(v) ? cleanSteps(v) : (v ?? null))

  async function handleFile(e) {
    const chosen = e.target.files?.[0]
    e.target.value = ''
    if (!chosen) return
    setError('')
    setPlan(null)
    setDone(null)
    const prepared = prepareUpdate(await chosen.text(), config, members)
    if (prepared.error) {
      setError(prepared.error)
      return
    }
    setFile({ name: chosen.name, ...prepared })
    setBusy(true)
    const [{ data: heads, error: e1 }, { data: states, error: e2 }] = await Promise.all([
      supabase.from('item_heads').select('id, item_key, title, values, folder_id, state_id').eq('tracker_id', config.tracker.id),
      supabase.from('tracker_states').select('id, name, locks_item').eq('tracker_id', config.tracker.id),
    ])
    setBusy(false)
    if (e1 || e2) {
      setError((e1 || e2).message)
      return
    }
    setPlan(
      prepared.rows.map((row) => {
        const head = heads.find((h) => h.item_key === row.key)
        const errors = [...row.problems]
        if (!head) return { row, errors: [row.key ? `${row.key} is not in ${typeKey}` : 'No id'], changes: [] }
        const state = states.find((s) => s.id === head.state_id)
        if (state?.locks_item) errors.push(`${head.item_key} is ${state.name} and cannot be edited`)
        const title = row.title || head.title
        const values = { ...head.values }
        for (const [k, v] of Object.entries(row.values)) {
          if (isEmpty(v)) delete values[k]
          else values[k] = stepKeys.has(k) ? cleanSteps(v) : v
        }
        const changes = [
          ...(title !== head.title ? ['Title'] : []),
          ...config.fields
            .filter((f) => comparable(f.key, values[f.key]) !== comparable(f.key, head.values[f.key]))
            .map((f) => f.label),
        ]
        return { row, head, title, values, changes, errors }
      }),
    )
  }

  async function handleUpdate() {
    setBusy(true)
    setError('')
    let updated = 0
    const failed = []
    for (const p of plan.filter((x) => x.changes.length && !x.errors.length)) {
      const { error } = await supabase.rpc('update_item', {
        p_item: p.head.id,
        p_title: p.title,
        p_values: p.values,
        p_folder: p.head.folder_id,
        p_reason: `Updated from ${file.name}`,
      })
      if (error) failed.push({ key: p.head.item_key, message: error.message })
      else updated++
    }
    setBusy(false)
    setDone({ updated, failed })
    setPlan(null)
  }

  const toUpdate = (plan ?? []).filter((p) => p.changes.length && !p.errors.length)
  const withErrors = (plan ?? []).filter((p) => p.errors.length)

  return (
    <div className="stack">
      <nav className="breadcrumb" aria-label="Import breadcrumb">
        <Link to={base.replace(/\/[^/]+$/, '')}>Trackers</Link> <span aria-hidden="true">/</span> <Link to={base}>{typeKey}</Link>{' '}
        <span aria-hidden="true">/</span> <span>Update from CSV</span>
      </nav>
      <h2>
        Update <span className="prefix">{typeKey}</span> items from CSV
      </h2>

      <section className="card stack-sm">
        <p className="small">
          {typeKey} items are created with their requirement, so this updates existing ones. Export {typeKey} from the tracker
          page, edit the file, and choose it here. Each row is matched by its <code>id</code>; the <code>title</code> and field
          columns ({config.fields.filter((f) => !f.is_retired).map((f) => f.label).join(', ')}) are applied and everything else is
          ignored. Steps go one per line: <code>1. action → expected [SRS-004.1]</code>, or{' '}
          <code>2. [Record] action → value; value</code> for a documentation step.
        </p>
        <label>
          Choose a CSV file
          <input type="file" accept=".csv,text/csv" onChange={handleFile} disabled={busy} />
        </label>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {busy && <p className="muted">{plan ? 'Updating…' : 'Checking rows…'}</p>}

      {done && (
        <section className={`card review-status ${done.failed.length ? 'pending' : 'done'}`} role="status">
          <strong>Updated {done.updated} items</strong> from {file.name}.{' '}
          {done.failed.length > 0 && (
            <>
              {done.failed.length} could not be updated:
              <ul>
                {done.failed.map((f) => (
                  <li key={f.key}>
                    {f.key}: {f.message}
                  </li>
                ))}
              </ul>
            </>
          )}
          <Link to={base}>Go to the {typeKey} tracker</Link>
        </section>
      )}

      {plan && (
        <>
          <div className={`review-status ${withErrors.length ? 'pending' : 'done'}`} role="status">
            <strong>
              {toUpdate.length} of {plan.length} rows change something.
            </strong>{' '}
            {withErrors.length > 0 && `${withErrors.length} rows have problems and will be skipped. `}
            Nothing has changed yet.
          </div>
          <div className="table-wrap">
            <table aria-label="Update preview">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>ID</th>
                  <th>Changes</th>
                </tr>
              </thead>
              <tbody>
                {plan.map((p) => (
                  <tr key={p.row.line} className={p.errors.length ? 'row-error' : ''}>
                    <td className="muted">{p.row.line}</td>
                    <td className="nowrap">
                      <span className="prefix">{p.row.key}</span>
                    </td>
                    <td className="small">
                      {p.errors.length ? (
                        p.errors.join('; ')
                      ) : p.changes.length ? (
                        p.changes.join(', ')
                      ) : (
                        <span className="muted">No changes</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button type="button" onClick={handleUpdate} disabled={busy || toUpdate.length === 0}>
              Update {toUpdate.length} items
            </button>
          </div>
        </>
      )}
    </div>
  )
}
