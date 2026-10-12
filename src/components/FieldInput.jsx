// Input for one tracker field, chosen by the field's configured type (SRS-016).
export default function FieldInput({ field, value, onChange, members = [] }) {
  const id = `field-${field.key}`
  const label = (
    <span>
      {field.label}
      {field.required && <span className="required" aria-hidden="true"> *</span>}
    </span>
  )
  const help = field.help_text && <span className="muted small">{field.help_text}</span>

  if (field.field_type === 'steps') {
    return (
      <fieldset className="steps-editor">
        <legend>{label}</legend>
        {help}
        <StepsEditor steps={Array.isArray(value) ? value : []} onChange={onChange} />
      </fieldset>
    )
  }

  let control
  switch (field.field_type) {
    case 'long_text':
      control = <textarea id={id} rows={4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      break
    case 'number':
      control = (
        <input
          id={id}
          type="number"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      )
      break
    case 'date':
      control = <input id={id} type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />
      break
    case 'select':
      control = (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— Select —</option>
          {field.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )
      break
    case 'user':
      control = (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— Select a member —</option>
          {members.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.full_name || m.email}
            </option>
          ))}
        </select>
      )
      break
    default:
      control = <input id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
  }

  return (
    <label htmlFor={id}>
      {label}
      {control}
      {help}
    </label>
  )
}

// Two kinds of step (SRS-034, SRS-049):
//   verification  { action, expected }                  pass/fail against the expected result
//   documentation { kind: 'document', action, fields }  the tester records each named value
function StepsEditor({ steps, onChange }) {
  const update = (i, patch) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const move = (i, delta) => {
    const next = [...steps]
    const [s] = next.splice(i, 1)
    next.splice(i + delta, 0, s)
    onChange(next)
  }
  return (
    <div className="stack-sm">
      {steps.map((s, i) => {
        const isDoc = s.kind === 'document'
        const fields = s.fields ?? []
        return (
          <div key={i} className={`step-row${isDoc ? ' step-document' : ''}`}>
            <span className="step-number">{i + 1}</span>
            <label>
              <span>
                Action{isDoc && <span className="step-kind"> Documentation step</span>}
              </span>
              <textarea rows={2} value={s.action ?? ''} onChange={(e) => update(i, { action: e.target.value })} />
            </label>
            {isDoc ? (
              <fieldset className="record-fields">
                <legend>Values to record</legend>
                {fields.map((f, k) => (
                  <div key={k} className="record-field-row">
                    <input
                      aria-label={`Step ${i + 1} value ${k + 1}`}
                      value={f}
                      placeholder="e.g. Browser and version"
                      maxLength={200}
                      onChange={(e) => update(i, { fields: fields.map((x, j) => (j === k ? e.target.value : x)) })}
                    />
                    <button
                      type="button"
                      className="secondary small"
                      disabled={fields.length === 1}
                      onClick={() => update(i, { fields: fields.filter((_, j) => j !== k) })}
                      aria-label={`Remove value ${k + 1} from step ${i + 1}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div>
                  <button type="button" className="secondary small" disabled={fields.length >= 20} onClick={() => update(i, { fields: [...fields, ''] })}>
                    Add value
                  </button>
                </div>
              </fieldset>
            ) : (
              <label>
                Expected result
                <textarea rows={2} value={s.expected ?? ''} onChange={(e) => update(i, { expected: e.target.value })} />
              </label>
            )}
            <div className="step-tools">
              <button type="button" className="secondary small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}>
                ↑
              </button>
              <button
                type="button"
                className="secondary small"
                disabled={i === steps.length - 1}
                onClick={() => move(i, 1)}
                aria-label={`Move step ${i + 1} down`}
              >
                ↓
              </button>
              <button type="button" className="secondary small" onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>
                ✕
              </button>
            </div>
          </div>
        )
      })}
      <div className="actions">
        <button type="button" className="secondary small" onClick={() => onChange([...steps, { action: '', expected: '' }])}>
          Add step
        </button>
        <button type="button" className="secondary small" onClick={() => onChange([...steps, { kind: 'document', action: '', fields: [''] }])}>
          Add documentation step
        </button>
      </div>
    </div>
  )
}
