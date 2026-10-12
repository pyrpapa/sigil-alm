import { formatDate } from '../lib/labels'
import { isEmpty } from '../lib/trackers'

// Read-only display of one field value.
export default function FieldValue({ field, value, members = [] }) {
  if (isEmpty(value)) return <span className="muted">—</span>

  switch (field.field_type) {
    case 'date':
      return formatDate(value)
    case 'user': {
      const m = members.find((x) => x.user_id === value)
      return m ? m.full_name || m.email : <span className="muted">Former member</span>
    }
    case 'steps':
      return (
        <div className="table-wrap">
          <table aria-label={field.label}>
            <thead>
              <tr>
                <th>#</th>
                <th>Action</th>
                <th>Expected result / values to record</th>
              </tr>
            </thead>
            <tbody>
              {value.map((s, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
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
    case 'long_text':
      return <span className="prewrap">{value}</span>
    default:
      return String(value)
  }
}
