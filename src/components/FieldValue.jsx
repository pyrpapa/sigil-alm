import { formatDate } from '../lib/labels'
import { isEmpty } from '../lib/trackers'

// Read-only display of one field value.
// context: { itemKey, coverage } for ER lists; { currentEr } for test steps.
export default function FieldValue({ field, value, members = [], context = {} }) {
  if (isEmpty(value)) return <span className="muted">—</span>

  switch (field.field_type) {
    case 'date':
      return formatDate(value)
    case 'user': {
      const m = members.find((x) => x.user_id === value)
      return m ? m.full_name || m.email : <span className="muted">Former member</span>
    }
    case 'statements':
      return <Statements value={value} itemKey={context.itemKey} coverage={context.coverage} />
    case 'steps': {
      const showEr = value.some((s) => s.er)
      return (
        <div className="table-wrap">
          <table aria-label={field.label}>
            <thead>
              <tr>
                <th>#</th>
                {showEr && <th>Verifies</th>}
                <th>Action</th>
                <th>Expected result / values to record</th>
              </tr>
            </thead>
            <tbody>
              {value.map((s, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  {showEr && (
                    <td className="nowrap small">
                      {s.er ?? <span className="muted">—</span>}
                      {s.er && context.currentEr && context.currentEr[s.er] === undefined && (
                        <div className="error">no longer in the requirement</div>
                      )}
                      {s.er && context.currentEr?.[s.er] !== undefined && s.er_text !== context.currentEr[s.er] && (
                        <div className="badge badge-warn" title={`Written against: ${s.er_text}`}>
                          ER reworded
                        </div>
                      )}
                    </td>
                  )}
                  <td className="prewrap">{s.action}</td>
                  <td className="prewrap">
                    {s.kind === 'document' ? (
                      <>
                        <span className="step-kind">Record</span>
                        <ul className="record-list">
                          {(s.fields ?? []).map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      s.expected
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'long_text':
      return <span className="prewrap">{value}</span>
    default:
      return String(value)
  }
}

// ERs with their permanent IDs and, when known, which test step verifies each.
function Statements({ value, itemKey, coverage }) {
  const byEr = {}
  for (const c of coverage ?? []) (byEr[c.er] ??= []).push(c)
  const covered = coverage ? value.filter((s) => (byEr[`${itemKey}.${s.n}`] ?? []).some((c) => c.tc_key)).length : null
  return (
    <div className="stack-sm">
      {coverage && (
        <span className={`badge ${covered === value.length ? 'badge-good' : 'badge-warn'} coverage-badge`}>
          {covered} of {value.length} ERs covered by test steps
        </span>
      )}
      <ol className="er-list">
        {value.map((s) => {
          const key = itemKey ? `${itemKey}.${s.n}` : `ER ${s.n}`
          const steps = (byEr[key] ?? []).filter((c) => c.tc_key)
          return (
            <li key={s.n}>
              <span className="er-key">{key}</span>
              <span className="prewrap">{s.text}</span>
              {coverage && (
                <span className="er-cover small">
                  {steps.length === 0 ? (
                    <span className="badge badge-warn">Not covered</span>
                  ) : (
                    steps.map((c) => (
                      <span key={`${c.tc_key}-${c.step_no}`} className={`badge ${c.stale ? 'badge-warn' : 'badge-good'}`}>
                        {c.tc_key} step {c.step_no}
                        {c.stale && ' · step written against old wording'}
                      </span>
                    ))
                  )}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
