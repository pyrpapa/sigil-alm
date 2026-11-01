import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { ROLE_LABELS, formatTimestamp } from '../../lib/labels'
import StateBadge from '../tracker/StateBadge'
import ReviewPanel from './ReviewPanel'

// A project's Reviews tab. Two queues, To review and Needs work. Each shows what waits on
// you by default; "Everyone" shows every item in that queue in this project, and who it
// waits on. Rows are grouped by tracker and show their release. A requirement and its test
// case are reviewed and signed together, so a pair is one row naming both. Click a row to
// review it in place: the pair opens below the row, side by side, with Sign and Send back.
const shortDate = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : ''

export default function ProjectReviews() {
  const { project, refreshReviews } = useOutletContext()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('review')
  const [scope, setScope] = useState('mine')
  const [openId, setOpenId] = useState(null)

  const load = useCallback(
    () =>
      supabase.rpc('project_review_board', { p_project: project.id }).then(({ data, error }) => {
        if (error) setError(error.message)
        else setRows(data ?? [])
      }),
    [project.id],
  )
  useEffect(() => {
    load()
  }, [load])

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (!rows) return <p className="muted">Loading reviews…</p>

  const inTab = rows.filter((r) => r.kind === tab)
  const mineInTab = inTab.filter((r) => r.for_me)
  const shown = scope === 'mine' ? mineInTab : inTab
  const count = (kind) => rows.filter((r) => r.kind === kind && (scope === 'everyone' || r.for_me)).length
  const everyone = scope === 'everyone'

  // tracker → rows (the database already sorts by tracker, then release, then age)
  const groups = []
  for (const r of shown) {
    let g = groups.find((x) => x.type_key === r.type_key)
    if (!g)
      groups.push(
        (g = {
          type_key: r.type_key,
          name: r.tracker_name,
          pair_name: r.pair_tracker_name,
          rows: [],
        }),
      )
    if (!g.pair_name && r.pair_tracker_name) g.pair_name = r.pair_tracker_name
    g.rows.push(r)
  }

  const itemUrl = (typeKey, key) => `/projects/${project.id}/trackers/${typeKey}/${key}`
  const ordered = groups.flatMap((g) => g.rows)
  const openIndex = ordered.findIndex((r) => r.item_id === openId)
  const toggle = (id) => setOpenId((cur) => (cur === id ? null : id))
  // After signing or sending back, the item leaves the list; open the one after it.
  const afterAction = () => {
    const next = ordered[openIndex + 1]?.item_id ?? null
    load().then(() => setOpenId(next))
    refreshReviews?.()
  }
  const columns = 6 + (everyone ? 1 : 0)

  return (
    <div className="stack">
      <div className="review-toolbar">
        <nav className="tabs list-tabs" aria-label="Review queues">
          <button
            type="button"
            className={`tab${tab === 'review' ? ' active' : ''}`}
            aria-pressed={tab === 'review'}
            onClick={() => {
              setTab('review')
              setOpenId(null)
            }}
          >
            To review ({count('review')})
          </button>
          <button
            type="button"
            className={`tab${tab === 'rework' ? ' active' : ''}`}
            aria-pressed={tab === 'rework'}
            onClick={() => {
              setTab('rework')
              setOpenId(null)
            }}
          >
            Needs work ({count('rework')})
          </button>
        </nav>
        <div className="segmented" role="group" aria-label="Whose items">
          <button type="button" className="tab" aria-pressed={!everyone} onClick={() => setScope('mine')}>
            Waiting on me
          </button>
          <button type="button" className="tab" aria-pressed={everyone} onClick={() => setScope('everyone')}>
            Everyone
          </button>
        </div>
      </div>

      {shown.length === 0 && (
        <p className="muted">
          {tab === 'review'
            ? everyone
              ? 'Nothing in this project is waiting for a review signature.'
              : 'Nothing in this project is waiting for your signature.'
            : everyone
              ? 'Nothing in this project has been sent back.'
              : 'Nothing in this project has been sent back to you.'}
          {!everyone && inTab.length > 0 && (
            <>
              {' '}
              <button type="button" className="link-button" onClick={() => setScope('everyone')}>
                Show everyone's ({inTab.length})
              </button>
            </>
          )}
        </p>
      )}

      {groups.map((g) => (
        <section key={g.type_key} className="review-group">
          <h3 className="review-group-head">
            {g.name}
            {g.pair_name && (
              <span className="pair-tag" title="A requirement and its test case are reviewed and signed together">
                + {g.pair_name} · reviewed as pairs
              </span>
            )}
            <span className="muted small">{g.rows.length}</span>
          </h3>
          <div className="table-wrap">
            <table aria-label={`${g.name} ${tab === 'review' ? 'to review' : 'needing work'}`}>
              <thead>
                <tr>
                  <th className="col-key">{g.pair_name ? 'Pair' : 'Item'}</th>
                  <th>Title</th>
                  <th className="col-state">State</th>
                  <th className="col-release">Release</th>
                  {everyone && <th className="col-who">Waiting on</th>}
                  <th className="col-since">Since</th>
                  <th className="col-actions" aria-label="Review" />
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r) => {
                  const url = itemUrl(r.type_key, r.item_key)
                  return (
                    <Fragment key={r.item_id}>
                      <tr
                        className={['review-row', everyone && r.for_me && 'is-mine', openId === r.item_id && 'is-open']
                          .filter(Boolean)
                          .join(' ')}
                        onClick={(e) => {
                          if (!e.target.closest('a, button')) toggle(r.item_id)
                        }}
                      >
                        <td className="nowrap">
                          {r.pair_key ? (
                            <span className="pair-keys" aria-label={`${r.item_key} paired with ${r.pair_key}`}>
                              <Link to={url} className="prefix">
                                {r.item_key}
                              </Link>
                              <span className="pair-join" aria-hidden="true">
                                ⇄
                              </span>
                              <Link to={itemUrl(r.pair_type_key, r.pair_key)} className="prefix">
                                {r.pair_key}
                              </Link>
                            </span>
                          ) : (
                            <Link to={url} className="prefix">
                              {r.item_key}
                            </Link>
                          )}
                        </td>
                        <td>
                          {r.title}
                          {r.pair_key && r.pair_title && (
                            <div className="muted small">
                              {r.pair_key}: {r.pair_title}
                            </div>
                          )}
                          {r.approved_revision && (
                            <div className="muted small">
                              Version {r.revision} · changes since version {r.approved_revision}
                            </div>
                          )}
                          {r.kind === 'rework' && r.rejection && (
                            <div className="small rejection-inline">
                              <strong>{r.rejection.by_name}:</strong> {r.rejection.reason}
                              {r.open_comments > 0 && ` · ${r.open_comments} open ${r.open_comments === 1 ? 'comment' : 'comments'}`}
                            </div>
                          )}
                        </td>
                        <td className="nowrap">
                          <StateBadge
                            state={{
                              name: r.state,
                              review_role: r.review_role,
                              is_rework: r.kind === 'rework',
                            }}
                          />
                        </td>
                        <td className="nowrap">
                          {r.release_key ? (
                            <Link to={itemUrl('REL', r.release_key)} className="badge release-badge" title={r.release_title}>
                              {r.release_key} {r.release_title}
                            </Link>
                          ) : (
                            <span className="muted small">No release</span>
                          )}
                        </td>
                        {everyone && (
                          <td className="nowrap small">
                            {r.kind === 'review'
                              ? `${ROLE_LABELS[r.review_role] ?? r.review_role} signature`
                              : r.assignee_name || 'Unassigned'}
                            {r.for_me && <span className="you-tag">You</span>}
                          </td>
                        )}
                        <td className="nowrap small muted" title={formatTimestamp(r.waiting_since)}>
                          {shortDate(r.waiting_since)}
                        </td>
                        <td className="actions-cell">
                          <button
                            type="button"
                            className={openId === r.item_id ? 'secondary small' : 'small'}
                            aria-expanded={openId === r.item_id}
                            onClick={() => toggle(r.item_id)}
                          >
                            {openId === r.item_id ? 'Close ▴' : r.kind === 'review' && r.for_me ? 'Review ▾' : 'View ▾'}
                          </button>
                        </td>
                      </tr>
                      {openId === r.item_id && (
                        <tr className="review-expand">
                          <td colSpan={columns}>
                            <ReviewPanel
                              row={r}
                              projectId={project.id}
                              itemUrl={itemUrl}
                              position={`${openIndex + 1} of ${ordered.length}`}
                              onPrev={openIndex > 0 ? () => setOpenId(ordered[openIndex - 1].item_id) : null}
                              onNext={openIndex < ordered.length - 1 ? () => setOpenId(ordered[openIndex + 1].item_id) : null}
                              onClose={() => setOpenId(null)}
                              onSigned={afterAction}
                              onSentBack={afterAction}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}
