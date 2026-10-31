import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import FieldValue from '../../components/FieldValue'
import { formatTimestamp } from '../../lib/labels'
import { isEmpty } from '../../lib/trackers'
import StateBadge from './StateBadge'

const WIDE = new Set(['statements', 'steps', 'long_text'])

// Read-only look at one item beside the tracker list: its state, key details and every
// field, plus the other half of an SRS/TC pair. Editing, moving and signing stay on the
// item page, which is one click away.
export default function ItemPreview({
  item,
  config,
  state,
  partner,
  partnerConfig,
  partnerState,
  folders,
  folderId,
  members,
  releases,
  href,
  position,
  onClose,
}) {
  const headingRef = useRef(null)
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const fields = config.fields.filter((f) => !f.is_retired && !isEmpty(item.values?.[f.key]))
  const short = fields.filter((f) => !WIDE.has(f.field_type))
  const wide = fields.filter((f) => WIDE.has(f.field_type))
  const partnerFields = partner
    ? partnerConfig.fields.filter((f) => !f.is_retired && !isEmpty(partner.values?.[f.key]) && f.key !== 'approved_on')
    : []
  const assignee = members.find((m) => m.user_id === item.assignee)
  const release = releases.find((r) => r.id === item.target_release_id)

  return (
    <aside className="item-preview" aria-label={`Preview of ${item.item_key}`}>
      <div className="item-preview-head">
        <div className="stack-sm">
          <h3 tabIndex={-1} ref={headingRef}>
            <span className="prefix">{item.item_key}</span> {item.title}
          </h3>
          <span className="muted small">{position} · ↑ ↓ to move, Esc to close</span>
        </div>
        <button type="button" className="secondary small" onClick={onClose} aria-label="Close preview">
          ✕
        </button>
      </div>

      <div className="actions">
        <StateBadge state={state} />
        <Link className="button small" to={href}>
          Open item
        </Link>
      </div>

      <dl className="details">
        <dt>Version</dt>
        <dd>
          {item.revision}
          {item.approved_revision && item.approved_revision !== item.revision && (
            <span className="muted"> · version {item.approved_revision} approved</span>
          )}
        </dd>
        {!state?.is_final && (
          <>
            <dt>Assignee</dt>
            <dd>{assignee ? assignee.full_name || assignee.email : <span className="muted">Nobody</span>}</dd>
          </>
        )}
        {folders.length > 0 && (
          <>
            <dt>Folder</dt>
            <dd>{folders.find((f) => f.id === folderId)?.name ?? <span className="muted">No folder</span>}</dd>
          </>
        )}
        {release && (
          <>
            <dt>For release</dt>
            <dd>
              {release.item_key} {release.title}
            </dd>
          </>
        )}
        {short.map((f) => (
          <FieldRow key={f.id} label={f.label}>
            <FieldValue field={f} value={item.values[f.key]} members={members} />
          </FieldRow>
        ))}
        <dt>Updated</dt>
        <dd>{formatTimestamp(item.updated_at)}</dd>
      </dl>

      {wide.map((f) => (
        <section key={f.id} className="stack-sm">
          <h4>{f.label}</h4>
          <FieldValue field={f} value={item.values[f.key]} members={members} context={{ itemKey: item.item_key }} />
        </section>
      ))}

      {partner && (
        <section className="stack-sm">
          <h4>
            {partnerConfig.tracker.is_pair_primary ? 'Requirement' : 'Test case'} <span className="prefix">{partner.item_key}</span>{' '}
            <StateBadge state={partnerState} />
          </h4>
          {partnerFields.length === 0 && <p className="muted small">Nothing written yet.</p>}
          {partnerFields.map((f) =>
            WIDE.has(f.field_type) ? (
              <FieldValue key={f.id} field={f} value={partner.values[f.key]} members={members} context={{ itemKey: partner.item_key }} />
            ) : (
              <p key={f.id} className="small">
                <span className="muted">{f.label}:</span> <FieldValue field={f} value={partner.values[f.key]} members={members} />
              </p>
            ),
          )}
        </section>
      )}
    </aside>
  )
}

function FieldRow({ label, children }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}
