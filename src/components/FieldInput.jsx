// Input for one tracker field, chosen by the field's configured type (SRS-016).
// context: { itemKey, usedNumbers } for ER lists; { ers, currentEr } for test steps.
import { stepsForErs } from '../lib/trackers'
export default function FieldInput({ field, value, onChange, members = [], context = {} }) {
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
        <StepsEditor steps={Array.isArray(value) ? value : []} onChange={onChange} ers={context.ers ?? []} currentEr={context.currentEr ?? {}} />
      </fieldset>
    )
  }

  if (field.field_type === 'statements') {
    return (
      <fieldset className="steps-editor">
        <legend>{label}</legend>
        {help}
        <StatementsEditor
          statements={Array.isArray(value) ? value : []}
          onChange={onChange}
          itemKey={context.itemKey}
          usedNumbers={context.usedNumbers ?? []}
        />
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
// ERs (requirement statements). Numbers are permanent: a new ER always takes the
// next number above any the item has used, in any version.
function StatementsEditor({ statements, onChange, itemKey, usedNumbers }) {
  const nextNumber = Math.max(0, ...usedNumbers, ...statements.map((s) => s.n)) + 1
  const update = (i, text) => onChange(statements.map((s, j) => (j === i ? { ...s, text } : s)))
  const move = (i, delta) => {
    const next = [...statements]
    const [s] = next.splice(i, 1)
    next.splice(i + delta, 0, s)
    onChange(next)
  }
  return (
    <div className="stack-sm">
      {statements.map((s, i) => (
        <div key={s.n} className="er-row">
          <span className="er-key">{itemKey ? `${itemKey}.${s.n}` : `ER ${s.n}`}</span>
          <textarea aria-label={`ER ${s.n}`} rows={2} value={s.text} onChange={(e) => update(i, e.target.value)} />
          <div className="step-tools">
            <button type="button" className="secondary small" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ER ${s.n} up`}>
              ↑
            </button>
            <button
              type="button"
              className="secondary small"
              disabled={i === statements.length - 1}
              onClick={() => move(i, 1)}
              aria-label={`Move ER ${s.n} down`}
            >
              ↓
            </button>
            <button type="button" className="secondary small" onClick={() => onChange(statements.filter((_, j) => j !== i))} aria-label={`Remove ER ${s.n}`}>
              ✕
            </button>
          </div>
        </div>
      ))}
      <div className="actions">
        <button type="button" className="secondary small" onClick={() => onChange([...statements, { n: nextNumber, text: '' }])}>
          Add ER
        </button>
      </div>
      {usedNumbers.some((n) => !statements.some((s) => s.n === n)) && (
        <p className="muted small">Removed ERs keep their numbers; they are never reused.</p>
      )}
    </div>
  )
}

function StepsEditor({ steps, onChange, ers, currentEr }) {
  const update = (i, patch) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  // ERs of the requirement that no step verifies yet.
  const uncovered = ers.filter((e) => !steps.some((s) => s.er === e.key))
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
            {ers.length > 0 && (
              <ErPicker step={s} ers={ers} currentText={currentEr[s.er]} onChange={(patch) => update(i, patch)} n={i + 1} />
            )}
          </div>
        )
      })}
      <div className="actions">
        {uncovered.length > 0 && steps.length > 0 && (
          <button type="button" className="small" onClick={() => onChange([...steps, ...stepsForErs(uncovered)])}>
            Add a step for each ER without one ({uncovered.length})
          </button>
        )}
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

// Which ER a step verifies, and whether the ER has been reworded since the step was written.
function ErPicker({ step, ers, currentText, onChange, n }) {
  const stale = step.er && step.er_text && currentText !== undefined && step.er_text !== currentText && !step.er_confirm
  const missing = step.er && currentText === undefined
  return (
    <div className="er-picker">
      <label>
        Verifies ER
        <select
          aria-label={`ER verified by step ${n}`}
          value={step.er ?? ''}
          onChange={(e) => onChange({ er: e.target.value || undefined, er_text: undefined, er_confirm: undefined })}
        >
          <option value="">None (setup step)</option>
          {ers.map((er) => (
            <option key={er.key} value={er.key}>
              {er.key}: {er.text.length > 70 ? `${er.text.slice(0, 70)}…` : er.text}
            </option>
          ))}
        </select>
      </label>
      {missing && <p className="error small">{step.er} is no longer in the requirement. Choose another ER.</p>}
      {stale && (
        <div className="er-stale small">
          <strong>{step.er} was reworded</strong> since this step was written.
          <div>
            Was: <del>{step.er_text}</del>
          </div>
          <div>
            Now: <ins>{currentText}</ins>
          </div>
          <button type="button" className="secondary small" onClick={() => onChange({ er_confirm: true })}>
            Step still fits the new wording
          </button>
        </div>
      )}
      {step.er_confirm && <p className="muted small">Will be marked as checked against the new wording when you save.</p>}
    </div>
  )
}
