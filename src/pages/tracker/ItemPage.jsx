import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useOutletContext, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { isEmpty, loadErs, loadLinkTypes, loadMembers, loadReleases, loadTracker, releaseLabel } from '../../lib/trackers'
import { ACTION_LABELS, formatTimestamp, ROLE_LABELS } from '../../lib/labels'
import FieldValue from '../../components/FieldValue'
import ItemForm from './ItemForm'
import StateBadge from './StateBadge'

async function fetchItem(projectId, typeKey, itemKey) {
  const config = await loadTracker(projectId, typeKey)
  if (!config) return { missing: true }
  const { data: item, error } = await supabase
    .from('item_heads')
    .select('*')
    .eq('tracker_id', config.tracker.id)
    .eq('item_key', itemKey)
    .maybeSingle()
  if (error) throw error
  if (!item) return { missing: true }
  const [members, sigs, revisions, itemAudit, links, linkTypes, editRoles, releases, pins] = await Promise.all([
    loadMembers(projectId),
    supabase.from('item_signatures').select('*').eq('item_id', item.id).order('signed_at'),
    supabase.from('item_revisions').select('*').eq('item_id', item.id).order('revision', { ascending: false }),
    supabase
      .from('audit_log')
      .select('id, occurred_at, table_name, record_id, action, changed_by, changed_fields, old_values, new_values, reason')
      .eq('table_name', 'items')
      .eq('record_id', item.id),
    supabase.rpc('item_link_list', { p_item: item.id }),
    loadLinkTypes(projectId),
    supabase.from('role_permissions').select('role').eq('project_id', projectId).eq('permission', 'items.edit'),
    loadReleases(projectId),
    supabase.from('release_pins').select('release_id, revision_id').eq('item_id', item.id),
  ])
  for (const r of [sigs, revisions, itemAudit, links, editRoles, pins]) if (r.error) throw r.error
  const revisionIds = revisions.data.map((r) => r.id)
  const [revAudit, revLinks] = await Promise.all([
    supabase
      .from('audit_log')
      .select('id, occurred_at, table_name, record_id, action, changed_by, changed_fields, old_values, new_values, reason')
      .eq('table_name', 'item_revisions')
      .in('record_id', revisionIds),
    supabase.from('item_links').select('source_revision_id, link_type_id, target_item_id').in('source_revision_id', revisionIds),
  ])
  for (const r of [revAudit, revLinks]) if (r.error) throw r.error
  const targetIds = [...new Set(revLinks.data.map((l) => l.target_item_id))]
  const { data: targets, error: targetError } = targetIds.length
    ? await supabase.from('items').select('id, item_key').in('id', targetIds)
    : { data: [] }
  if (targetError) throw targetError
  const keyOf = Object.fromEntries(targets.map((t) => [t.id, t.item_key]))

  // ERs: coverage of this item's ERs, or the ERs this test case's steps can verify.
  const hasStatements = config.fields.some((f) => f.field_type === 'statements' && !f.is_retired)
  const hasSteps = config.fields.some((f) => f.field_type === 'steps' && !f.is_retired)
  const verified = links.data.filter((l) => l.direction === 'out' && l.link_type === 'verifies').map((l) => l.other_item_id)
  const [coverage, ers] = await Promise.all([
    hasStatements ? supabase.rpc('er_coverage', { p_item: item.id }) : { data: null },
    hasSteps ? loadErs(verified) : [],
  ])
  if (coverage.error) throw coverage.error
  const statementKeys = config.fields.filter((f) => f.field_type === 'statements').map((f) => f.key)
  const usedNumbers = revisions.data.flatMap((r) => statementKeys.flatMap((k) => (r.values[k] ?? []).map((s) => s.n)))
  const linksByRevision = {}
  for (const l of revLinks.data)
    (linksByRevision[l.source_revision_id] ??= []).push({ type: l.link_type_id, target: keyOf[l.target_item_id] })

  const [readiness, comments, pair] = await Promise.all([
    supabase.rpc('item_readiness', { p_item: item.id }),
    supabase.from('review_comments').select('*').eq('item_id', item.id).order('created_at'),
    item.pair_item_id
      ? supabase.from('items').select('id, item_key, tracker_id').eq('id', item.pair_item_id).maybeSingle()
      : { data: null },
  ])
  for (const r of [readiness, comments, pair]) if (r.error) throw r.error

  return {
    config,
    item,
    members,
    editors: members.filter((m) => editRoles.data.some((r) => r.role === m.role)),
    signatures: sigs.data,
    revisions: revisions.data,
    audit: [...itemAudit.data, ...revAudit.data].sort((a, b) => b.id - a.id),
    links: links.data,
    linksByRevision,
    linkTypes,
    releases,
    pins: pins.data,
    readiness: readiness.data.map((r) => (typeof r === 'string' ? r : r.problem)),
    comments: comments.data,
    pair: pair.data ? { ...pair.data, type_key: pair.data.item_key.split('-')[0] } : null,
    erContext: {
      itemKey: item.item_key,
      usedNumbers,
      coverage: coverage.data,
      ers,
      currentEr: hasSteps ? Object.fromEntries(ers.map((e) => [e.key, e.text])) : undefined,
    },
  }
}

// Derived facts about one item's current version, used by the workflow and sections.
function describeItem(data, userId) {
  const { config, item, signatures, revisions } = data
  const stateById = Object.fromEntries(config.states.map((s) => [s.id, s]))
  const state = stateById[item.state_id]
  const currentReview = signatures.find(
    (s) =>
      s.revision_id === item.revision_id &&
      s.state_id === item.state_id &&
      s.content_version === item.content_version &&
      new Date(s.signed_at) >= new Date(item.state_entered_at),
  )
  const approvedRev = revisions.find((r) => r.id === item.approved_revision_id)
  return {
    stateById,
    state,
    currentReview,
    approvedRev,
    awaitingReview: Boolean(state.review_role) && !currentReview,
    joint: (s) => Boolean(s && (s.review_role || s.is_rework || s.is_final)),
    moves: config.transitions
      .filter((t) => t.from_state_id === item.state_id)
      .map((t) => ({ ...t, to: stateById[t.to_state_id] }))
      .filter((t) => t.to && !t.to.is_retired)
      .sort((a, b) => a.to.position - b.to.position),
    reviewedBefore: signatures.some((s) => s.revision_id === item.revision_id),
    revisionNumber: Object.fromEntries(revisions.map((r) => [r.id, r.revision])),
    madeByMe: item.content_by === userId,
  }
}

export default function ItemPage() {
  const ctx = useOutletContext()
  const { project } = ctx
  const { typeKey, itemKey } = useParams()
  const [data, setData] = useState(null)
  const [pairData, setPairData] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const d = await fetchItem(project.id, typeKey, itemKey)
    // The requirement's page shows its test case too.
    const p = d.pair && d.config.tracker.is_pair_primary ? await fetchItem(project.id, d.pair.type_key, d.pair.item_key) : null
    return [d, p]
  }, [project.id, typeKey, itemKey])

  const reload = useCallback(
    () =>
      load().then(
        ([d, p]) => {
          setData(d)
          setPairData(p)
        },
        (e) => setError(e.message),
      ),
    [load],
  )

  useEffect(() => {
    let current = true
    load().then(
      ([d, p]) => {
        if (!current) return
        setData(d)
        setPairData(p)
      },
      (e) => current && setError(e.message),
    )
    return () => {
      current = false
    }
  }, [load])

  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    )
  if (!data) return <p className="muted">Loading item…</p>
  if (data.missing) return <p>Item {itemKey} not found.</p>

  // A paired test case lives on its requirement's page.
  if (data.pair && !data.config.tracker.is_pair_primary)
    return <Navigate to={`/projects/${project.id}/trackers/${data.pair.type_key}/${data.pair.item_key}#test-case`} replace />

  return <ItemView ctx={ctx} data={data} pairData={pairData} reload={reload} />
}

function ItemView({ ctx, data, pairData, reload }) {
  const { project, can, userId } = ctx
  const { typeKey } = useParams()
  const [editing, setEditing] = useState(null) // 'main' | 'pair'
  const [tab, setTab] = useState('details')

  const { config, item, members, links, linkTypes, releases, erContext } = data
  const d = useMemo(() => describeItem(data, userId), [data, userId])
  const p = useMemo(() => (pairData ? describeItem(pairData, userId) : null), [pairData, userId])
  const base = `/projects/${project.id}/trackers/${typeKey}`
  const isRelease = typeKey === 'REL'
  const paired = Boolean(pairData)
  const jointNow = paired && (d.joint(d.state) || d.joint(p.state))

  useEffect(() => {
    if (window.location.hash === '#test-case') document.getElementById('test-case')?.scrollIntoView()
  }, [])

  return (
    <div className="stack">
      <nav className="breadcrumb" aria-label="Item breadcrumb">
        <Link to={`/projects/${project.id}/trackers`}>Trackers</Link> <span aria-hidden="true">/</span>{' '}
        <Link to={base}>{typeKey}</Link> <span aria-hidden="true">/</span> <span>{item.item_key}</span>
      </nav>

      <div className="card-head">
        <div>
          <h2>
            <span className="prefix">{item.item_key}</span> {item.title}
          </h2>
          <span className="muted small">
            {paired && (
              <>
                With test case <a href="#test-case">{pairData.item.item_key}</a> ·{' '}
              </>
            )}
            Version {item.revision}
            {!d.state.is_final && d.approvedRev && ` · version ${d.approvedRev.revision} is approved`}
            {d.state.is_final && ' · approved'} · Updated {formatTimestamp(item.updated_at)}
          </span>
        </div>
        <StateBadge state={d.state} />
      </div>

      {paired && !jointNow ? (
        <PairAuthoring ctx={ctx} data={data} d={d} pairData={pairData} p={p} reload={reload} onEdit={setEditing} />
      ) : (
        <ItemWorkflow
          ctx={ctx}
          data={data}
          d={d}
          pairData={jointNow ? pairData : null}
          p={jointNow ? p : null}
          reload={reload}
          onEdit={() => setEditing('main')}
          onEditPair={() => setEditing('pair')}
          showRelease={!isRelease}
        />
      )}

      {(item.last_rejection || pairData?.item.last_rejection) && (d.state.is_rework || p?.state.is_rework) && (
        <RejectionNotice data={data} pairData={pairData} canResolve={can('items.edit')} onChanged={reload} />
      )}

      {editing && (
        <ItemForm
          config={editing === 'pair' ? pairData.config : config}
          members={members}
          item={editing === 'pair' ? pairData.item : item}
          context={editing === 'pair' ? pairData.erContext : erContext}
          requireReason={editing === 'pair' ? p.reviewedBefore : d.reviewedBefore}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
          }}
        />
      )}

      <nav className="tabs" aria-label="Item sections">
        {[
          ['details', 'Details'],
          ['signatures', `Signatures (${data.signatures.length + (pairData?.signatures.length ?? 0)})`],
          ['versions', `Versions (${data.revisions.length})`],
          ['history', 'History'],
        ].map(([key, label]) => (
          <button key={key} type="button" className={`tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'details' && (d.state.review_role || d.state.is_ready) && (
        <>
          <ChangesSince data={data} d={d} />
          {paired && <ChangesSince data={pairData} d={p} />}
        </>
      )}

      {tab === 'details' && (
        <>
          <ItemDetails ctx={ctx} data={data} d={d} heading={paired ? 'Requirement' : null} onMoved={reload} />
          {paired && (
            <section id="test-case" className="stack-sm">
              <div className="card-head">
                <h3>
                  Test case <span className="prefix">{pairData.item.item_key}</span> {pairData.item.title}
                </h3>
                <span className="muted small">
                  Version {pairData.item.revision} · <StateBadge state={p.state} />
                </span>
              </div>
              <ItemDetails ctx={ctx} data={pairData} d={p} onMoved={reload} hideReleases />
            </section>
          )}
          {isRelease ? (
            <ReleaseContents
              project={project}
              release={item}
              releases={releases}
              members={members}
              canManage={can('releases.manage') && !d.state.is_final}
              complete={d.state.is_final}
            />
          ) : (
            <Links
              project={project}
              item={item}
              links={paired ? links.filter((l) => l.other_item_id !== pairData.item.id) : links}
              linkTypes={linkTypes.filter((t) => !t.is_retired && (t.source_type_key === typeKey || t.target_type_key === typeKey))}
              outgoingTypes={linkTypes.filter((t) => !t.is_retired && t.source_type_key === typeKey)}
              canChange={can('items.edit') && !d.state.locks_item}
              locked={d.state.locks_item}
              requireReason={d.reviewedBefore}
              onChanged={reload}
            />
          )}
        </>
      )}

      {tab === 'signatures' && (
        <section className="stack">
          <SignatureList data={data} d={d} heading={paired ? item.item_key : null} />
          {paired && <SignatureList data={pairData} d={p} heading={pairData.item.item_key} />}
        </section>
      )}

      {tab === 'versions' && (
        <section className="stack">
          <VersionList data={data} d={d} />
          {paired && (
            <>
              <h3>Test case {pairData.item.item_key}</h3>
              <VersionList data={pairData} d={p} />
            </>
          )}
        </section>
      )}

      {tab === 'history' && (
        <section className="stack">
          {paired && <h3>Requirement {item.item_key}</h3>}
          <History
            audit={data.audit}
            signatures={data.signatures}
            config={config}
            members={members}
            stateById={d.stateById}
            revisionNumber={d.revisionNumber}
            folders={config.folders}
          />
          {paired && (
            <>
              <h3>Test case {pairData.item.item_key}</h3>
              <History
                audit={pairData.audit}
                signatures={pairData.signatures}
                config={pairData.config}
                members={members}
                stateById={p.stateById}
                revisionNumber={p.revisionNumber}
                folders={pairData.config.folders}
              />
            </>
          )}
        </section>
      )}
    </div>
  )
}

// The workflow card for one item, or for a pair once it is in review (moves, signatures
// and rejections then act on both).
function ItemWorkflow({ ctx, data, d, pairData, p, reload, onEdit, onEditPair, showRelease, compact = false, hideJoint = false }) {
  const { can, role } = ctx
  const { config, item, members, editors, releases } = data
  const [moving, setMoving] = useState(null)
  const [signing, setSigning] = useState(false)
  const [starting, setStarting] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const { state, awaitingReview, currentReview } = d
  const nameOf = (id) => members.find((m) => m.user_id === id)?.full_name || 'Former member'
  const openDraft = !state.is_final
  const keys = pairData ? `${item.item_key} and ${pairData.item.item_key}` : item.item_key
  const moves = d.moves.filter((m) => !(hideJoint && d.joint(m.to)))

  let signBlocker = null
  if (awaitingReview) {
    if (role !== state.review_role) signBlocker = `Only a project ${ROLE_LABELS[state.review_role]} can sign this review.`
    else if (!can('records.sign')) signBlocker = 'Your role cannot sign records in this project.'
    else if (d.madeByMe || p?.madeByMe) signBlocker = 'You made changes in this version, so someone else must review it.'
  }
  const done = () => {
    setMoving(null)
    setSigning(false)
    setStarting(false)
    setAssigning(false)
    reload()
  }

  return (
    <section className={`card workflow-card${compact ? ' compact' : ''}`} aria-label={compact ? `Workflow of ${item.item_key}` : 'Workflow'}>
      {!compact && (
        <ol className="state-path">
          {config.states
            .filter((s) => !s.is_retired && !(s.is_rework && !state.is_rework))
            .map((s) => (
              <li key={s.id} className={s.id === state.id ? 'current' : ''}>
                {s.name}
                {s.review_role && <span className="muted small"> · {ROLE_LABELS[s.review_role]}</span>}
              </li>
            ))}
        </ol>
      )}

      {state.is_final && (
        <div className="review-status done" role="status">
          <strong>
            Version {item.revision} {pairData ? `of ${keys} ` : ''}is {state.name.toLowerCase()}
          </strong>
          {item.approved_at && ` on ${formatTimestamp(item.approved_at)}`} and can't change. To change it, start a new version; version{' '}
          {item.revision} stays {state.name.toLowerCase()} until the new one replaces it.
        </div>
      )}

      {state.review_role && (
        <div className={`review-status ${awaitingReview ? 'pending' : 'done'}`} role="status">
          {awaitingReview ? (
            <>
              <strong>Waiting for {state.name}.</strong> A {ROLE_LABELS[state.review_role]} signs ({state.review_meaning}) or sends{' '}
              {keys} back. {pairData ? 'They' : 'It'} can't be edited while waiting.
            </>
          ) : (
            <>
              <strong>Reviewed.</strong> {currentReview.signer_name} signed {currentReview.meaning} on{' '}
              {formatTimestamp(currentReview.signed_at)}
              {pairData ? ` for ${keys}` : ` for version ${item.revision}`}.
            </>
          )}
        </div>
      )}

      {state.is_ready && !pairData && <p className="small muted">Ready for review and locked. Move back to In Progress to change it.</p>}

      <div className="workflow-actions">
        {awaitingReview && !signBlocker && !signing && (
          <button type="button" onClick={() => setSigning(true)}>
            Sign {state.name} ({state.review_meaning})…
          </button>
        )}
        {awaitingReview && signBlocker && <span className="muted small">{signBlocker}</span>}
        {can('items.transition') &&
          moves.map((m) => {
            const blocked = awaitingReview && m.to.locks_item && !m.to.is_rework
            if (m.to.is_rework && role !== state.review_role) return null
            return (
              <button
                key={m.id}
                type="button"
                className={m.to.is_rework ? 'secondary danger-outline' : 'secondary'}
                disabled={blocked}
                title={blocked ? 'Needs the review signature first' : undefined}
                onClick={() => setMoving(m)}
              >
                {m.to.is_rework ? `Send back (${m.to.name})…` : `Move to ${m.to.name}`}
              </button>
            )
          })}
        {!state.locks_item && can('items.edit') && onEdit && (
          <button type="button" className="secondary" onClick={onEdit}>
            {pairData ? `Edit ${item.item_key}` : 'Edit'}
          </button>
        )}
        {pairData && !p.state.locks_item && can('items.edit') && onEditPair && (
          <button type="button" className="secondary" onClick={onEditPair}>
            Edit {pairData.item.item_key}
          </button>
        )}
        {state.is_final && can('items.edit') && !starting && !compact && (
          <button type="button" onClick={() => setStarting(true)}>
            Start version {item.revision + 1}…
          </button>
        )}
      </div>

      {openDraft && !compact && (
        <div className="assignee small">
          Assigned to <strong>{item.assignee ? nameOf(item.assignee) : 'nobody'}</strong>
          {can('items.edit') && !assigning && (
            <button type="button" className="secondary small" onClick={() => setAssigning(true)}>
              Change
            </button>
          )}
          {showRelease && (
            <TargetRelease
              item={item}
              releases={releases}
              target={releases.find((r) => r.id === item.target_release_id)}
              canChange={can('items.edit')}
              onChanged={reload}
            />
          )}
        </div>
      )}

      {moving &&
        (moving.to.is_rework ? (
          <RejectForm data={data} pairData={pairData} from={state} to={moving.to} onCancel={() => setMoving(null)} onDone={done} />
        ) : (
          <MoveForm item={item} pairItem={pairData?.item} move={moving} from={state} config={config} onCancel={() => setMoving(null)} onDone={done} />
        ))}
      {signing && <SignForm item={item} pairItem={pairData?.item} state={state} onCancel={() => setSigning(false)} onDone={done} />}
      {starting && (
        <StartVersionForm item={item} pairItem={pairData?.item} releases={showRelease ? releases : []} onCancel={() => setStarting(false)} onDone={done} />
      )}
      {assigning && <AssignForm item={item} editors={editors} onCancel={() => setAssigning(false)} onDone={done} />}
    </section>
  )
}

// While a pair is being written, each part moves on its own up to Ready; then the
// pair is sent to review in one step (design note, decision 6).
function PairAuthoring({ ctx, data, d, pairData, p, reload, onEdit }) {
  const { can } = ctx
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const both = d.state.is_ready && p.state.is_ready
  const firstReview = d.moves.find((m) => m.to.review_role)?.to
  const problems = [...data.readiness.map((x) => [data.item.item_key, x]), ...pairData.readiness.map((x) => [pairData.item.item_key, x])]

  async function send() {
    setSending(true)
    setError('')
    const { error } = await supabase.rpc('transition_item', { p_item: data.item.id, p_to_state: firstReview.id })
    setSending(false)
    if (error) setError(error.message)
    else reload()
  }

  return (
    <section className="card workflow-card" aria-label="Workflow">
      <ol className="state-path">
        {data.config.states
          .filter((s) => !s.is_retired && !s.is_rework)
          .map((s) => (
            <li key={s.id} className={s.id === d.state.id || s.name === p.state.name ? 'current' : ''}>
              {s.name}
              {s.review_role && <span className="muted small"> · {ROLE_LABELS[s.review_role]}</span>}
            </li>
          ))}
      </ol>
      <div className="pair-rows">
        {[
          ['Requirement', data, d, () => onEdit('main')],
          ['Test case', pairData, p, () => onEdit('pair')],
        ].map(([label, x, dx, edit]) => (
          <div key={label} className="pair-row">
            <div className="pair-row-head">
              <strong>{label}</strong> <span className="prefix">{x.item.item_key}</span> <StateBadge state={dx.state} />
            </div>
            <ItemWorkflow ctx={ctx} data={x} d={dx} reload={reload} onEdit={edit} compact hideJoint />
            {!dx.state.is_ready && x.readiness.length === 0 && <p className="small ok-text">Checklist complete: can move to Ready for Review.</p>}
          </div>
        ))}
      </div>

      {problems.length > 0 && (
        <div className="checklist small">
          <strong>Before they can go to review:</strong>
          <ul>
            {problems.map(([key, text], i) => (
              <li key={i}>
                <span className="prefix">{key}</span> {text}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="workflow-actions">
        {can('items.transition') && firstReview && (
          <button type="button" disabled={!both || sending} onClick={send} title={both ? undefined : 'Both must be Ready for Review'}>
            {sending ? 'Sending…' : `Send both to ${firstReview.name}`}
          </button>
        )}
        {!both && <span className="muted small">Both the requirement and its test case must be Ready for Review.</span>}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ItemWorkflowFooter ctx={ctx} data={data} reload={reload} />
    </section>
  )
}

// Assignee and target release for the pair (both change together).
function ItemWorkflowFooter({ ctx, data, reload }) {
  const { can } = ctx
  const { item, members, editors, releases } = data
  const [assigning, setAssigning] = useState(false)
  return (
    <>
      <div className="assignee small">
        Assigned to <strong>{members.find((m) => m.user_id === item.assignee)?.full_name ?? 'nobody'}</strong>
        {can('items.edit') && !assigning && (
          <button type="button" className="secondary small" onClick={() => setAssigning(true)}>
            Change
          </button>
        )}
        <TargetRelease
          item={item}
          releases={releases}
          target={releases.find((r) => r.id === item.target_release_id)}
          canChange={can('items.edit')}
          onChanged={reload}
        />
      </div>
      {assigning && (
        <AssignForm
          item={item}
          editors={editors}
          onCancel={() => setAssigning(false)}
          onDone={() => {
            setAssigning(false)
            reload()
          }}
        />
      )}
    </>
  )
}

// Why the pair was sent back, and the reviewer's comments, until it goes back to review.
function RejectionNotice({ data, pairData, canResolve, onChanged }) {
  const r = data.item.last_rejection ?? pairData?.item.last_rejection
  const comments = [
    ...data.comments.filter((c) => c.revision_id === data.item.revision_id).map((c) => ({ ...c, key: data.item.item_key })),
    ...(pairData?.comments ?? []).filter((c) => c.revision_id === pairData.item.revision_id).map((c) => ({ ...c, key: pairData.item.item_key })),
  ].filter((c) => !r?.at || new Date(c.created_at) >= new Date(r.at) - 5000)
  async function resolve(id) {
    await supabase.rpc('resolve_review_comment', { p_comment: id })
    onChanged()
  }
  return (
    <section className="card rejection" role="alert" aria-label="Needs work">
      <strong>
        Sent back from {r?.from_state} by {r?.by_name ?? 'a reviewer'}
      </strong>{' '}
      <span className="muted small">{formatTimestamp(r?.at)}</span>
      <p className="rejection-reason">{r?.reason}</p>
      {comments.length > 0 && (
        <ul className="comment-list">
          {comments.map((c) => (
            <li key={c.id} className={c.resolved_at ? 'resolved' : ''}>
              <span className="prefix">{c.anchor?.startsWith(c.key) ? c.anchor : [c.key, c.anchor].filter(Boolean).join(' ')}</span> {c.body}
              {c.resolved_at ? (
                <span className="muted small"> · resolved</span>
              ) : (
                canResolve && (
                  <button type="button" className="secondary small" onClick={() => resolve(c.id)}>
                    Mark resolved
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Fix it, then send it back to the first review stage. Earlier sign-offs in this round no longer count.</p>
    </section>
  )
}

// Sending back: a reason is required; comments can be pinned to an ER or a step.
function RejectForm({ data, pairData, from, to, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [comments, setComments] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const anchors = [
    ...(data.erContext.coverage ?? []).filter((c, i, a) => a.findIndex((x) => x.er === c.er) === i).map((c) => [data.item.item_key, c.er]),
    ...((pairData?.item.values.steps ?? []).map((_, i) => [pairData.item.item_key, `Step ${i + 1}`]) ?? []),
  ]

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('reject_item', {
      p_item: data.item.id,
      p_reason: reason.trim(),
      p_comments: comments
        .filter((c) => c.body.trim())
        .map((c) => {
          const [key, anchor] = c.anchor ? c.anchor.split('|') : [data.item.item_key, '']
          return { item: key, anchor, body: c.body.trim() }
        }),
    })
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="form-inline move-form" onSubmit={handleSubmit}>
      <h3>
        Send {pairData ? `${data.item.item_key} and ${pairData.item.item_key}` : data.item.item_key} back from {from.name} to {to.name}
      </h3>
      <label>
        What needs to change (required)
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} />
      </label>
      {comments.map((c, i) => (
        <div key={i} className="comment-row">
          <select
            aria-label={`Comment ${i + 1} is about`}
            value={c.anchor}
            onChange={(e) => setComments(comments.map((x, j) => (j === i ? { ...x, anchor: e.target.value } : x)))}
          >
            <option value="">The whole item</option>
            {anchors.map(([key, a]) => (
              <option key={`${key}|${a}`} value={`${key}|${a}`}>
                {a.startsWith('Step') ? `${key} ${a}` : a}
              </option>
            ))}
          </select>
          <input
            aria-label={`Comment ${i + 1}`}
            value={c.body}
            onChange={(e) => setComments(comments.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))}
          />
          <button type="button" className="secondary small" onClick={() => setComments(comments.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="secondary small" onClick={() => setComments([...comments, { anchor: '', body: '' }])}>
          Add a comment on an ER or step
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="danger" disabled={saving || !reason.trim()}>
          {saving ? 'Sending back…' : 'Send back'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// One item's fields, releases and folder.
function ItemDetails({ ctx, data, d, heading, onMoved, hideReleases = false }) {
  const { project, can } = ctx
  const { config, item, members, releases, pins, erContext } = data
  const isRelease = config.tracker.type_key === 'REL'
  const fieldsShown = config.fields.filter((f) => !f.is_retired || !isEmpty(item.values[f.key]))
  return (
    <section className="card">
      {heading && <h3>{heading}</h3>}
      {item.version_reason && (
        <p className="small muted change-reason">
          Why version {item.revision}: {item.version_reason}
        </p>
      )}
      <dl className="details">
        {fieldsShown.map((f) => (
          <div key={f.id} className="details-row">
            <dt>
              {f.label}
              {f.is_retired && <span className="muted small"> (retired)</span>}
            </dt>
            <dd>
              <FieldValue field={f} value={item.values[f.key]} members={members} context={erContext} />
            </dd>
          </div>
        ))}
        {!isRelease && !hideReleases && (
          <div className="details-row">
            <dt>In releases</dt>
            <dd>
              {pins.length === 0 ? (
                <span className="muted">None yet</span>
              ) : (
                pins
                  .map((pin) => ({ pin, r: releases.find((x) => x.id === pin.release_id) }))
                  .map(({ pin, r }) => (
                    <span key={pin.release_id} className="release-pin">
                      <Link to={`/projects/${project.id}/trackers/REL/${r?.item_key}`}>{releaseLabel(r)}</Link>{' '}
                      <span className="muted small">version {d.revisionNumber[pin.revision_id]}</span>
                    </span>
                  ))
              )}
            </dd>
          </div>
        )}
        <div className="details-row">
          <dt>Folder</dt>
          <dd>
            <FolderPicker item={item} folders={config.folders} canMove={can('items.edit')} onMoved={onMoved} />
          </dd>
        </div>
      </dl>
    </section>
  )
}

function SignatureList({ data, d, heading }) {
  const { signatures } = data
  const counts = (s) =>
    s === d.currentReview || (d.approvedRev && s.revision_id === d.approvedRev.id && s.content_version === d.approvedRev.content_version)
  return (
    <section className="card">
      {heading && <h3>{heading}</h3>}
      {signatures.length === 0 ? (
        <p className="muted">No signatures yet.</p>
      ) : (
        <ul className="signature-list">
          {[...signatures].reverse().map((s) => (
            <li key={s.id} className={counts(s) ? '' : 'superseded'}>
              <strong>{s.signer_name}</strong> · {s.meaning} · {ROLE_LABELS[s.signer_role]}
              <div className="muted small">
                {formatTimestamp(s.signed_at)} · {s.state_name} · version {d.revisionNumber[s.revision_id]}
                {s === d.currentReview && ' · current review'}
                {!counts(s) && s.revision_id === data.item.revision_id && !d.state.is_final && ' · from an earlier round of review'}
                {!counts(s) && s.revision_id !== data.item.revision_id && ' · earlier version'}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function VersionList({ data, d }) {
  const { config, item, members, revisions, linksByRevision, linkTypes } = data
  const nameOf = (id) => members.find((m) => m.user_id === id)?.full_name || 'Former member'
  return revisions.map((v) => {
    const vState = d.stateById[v.state_id]
    const vLinks = linksByRevision[v.id] ?? []
    return (
      <details key={v.id} className="card version" open={v.id === item.revision_id}>
        <summary>
          <strong>Version {v.revision}</strong> <StateBadge state={vState} />
          {v.id === item.approved_revision_id && v.id !== item.revision_id && <span className="muted small"> approved version in use</span>}{' '}
          <span className="muted small">
            {v.approved_at ? `Approved ${formatTimestamp(v.approved_at)}` : `Started ${formatTimestamp(v.created_at)}`} · {nameOf(v.created_by)}
          </span>
        </summary>
        {v.version_reason && <p className="small muted change-reason">Why: {v.version_reason}</p>}
        <dl className="details">
          <div className="details-row">
            <dt>Title</dt>
            <dd>{v.title}</dd>
          </div>
          {config.fields
            .filter((f) => !isEmpty(v.values[f.key]))
            .map((f) => (
              <div key={f.id} className="details-row">
                <dt>{f.label}</dt>
                <dd>
                  <FieldValue field={f} value={v.values[f.key]} members={members} context={{ itemKey: item.item_key }} />
                </dd>
              </div>
            ))}
          {vLinks.length > 0 && (
            <div className="details-row">
              <dt>Links</dt>
              <dd>{vLinks.map((l) => `${linkTypes.find((t) => t.id === l.type)?.label ?? ''} ${l.target}`).join(', ')}</dd>
            </div>
          )}
        </dl>
      </details>
    )
  })
}

function StartVersionForm({ item, pairItem, releases, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const open = releases.filter((r) => !r.complete)
  const [release, setRelease] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('start_revision', { p_item: item.id, p_reason: reason.trim(), p_release: release || null })
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="form-inline move-form" onSubmit={handleSubmit}>
      <h3>
        Start version {item.revision + 1} of {item.item_key}
      </h3>
      <p className="small">
        Version {item.revision + 1} starts as a copy of version {item.revision}, in New, assigned to you
        {pairItem && `, together with a new version of ${pairItem.item_key}`}. Version {item.revision} stays approved and in use until
        version {item.revision + 1} is approved.
      </p>
      <label>
        Reason for the change (required)
        <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} autoFocus />
      </label>
      {open.length > 0 && (
        <label>
          For release
          <select value={release} onChange={(e) => setRelease(e.target.value)}>
            <option value="">No release yet</option>
            {open.map((r) => (
              <option key={r.id} value={r.id}>
                {releaseLabel(r)}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || !reason.trim()}>
          {saving ? 'Starting…' : `Start version ${item.revision + 1}`}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function AssignForm({ item, editors, onCancel, onDone }) {
  const [user, setUser] = useState(item.assignee ?? '')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('assign_item', { p_item: item.id, p_user: user || null, p_reason: reason.trim() || null })
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="form-inline move-form" onSubmit={handleSubmit}>
      <h3>Assign version {item.revision}</h3>
      <div className="form-row">
        <label>
          Assignee
          <select value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">Nobody</option>
            {editors.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.full_name || m.email} ({ROLE_LABELS[m.role]})
              </option>
            ))}
          </select>
        </label>
        <label>
          Reason (optional)
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || user === (item.assignee ?? '')}>
          {saving ? 'Saving…' : 'Assign'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// Folders organise items; moving one is allowed in any state (it isn't content).
function FolderPicker({ item, folders, canMove, onMoved }) {
  const [error, setError] = useState('')
  const name = folders.find((f) => f.id === item.folder_id)?.name
  if (!canMove || folders.length === 0) return name ?? <span className="muted">No folder</span>
  return (
    <>
      <select
        aria-label="Folder"
        value={item.folder_id ?? ''}
        onChange={async (e) => {
          const { error } = await supabase.rpc('move_item', { p_item: item.id, p_folder: e.target.value || null })
          if (error) setError(error.message)
          else onMoved()
        }}
      >
        <option value="">No folder</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {error && <span className="error small"> {error}</span>}
    </>
  )
}

function actionSummary(config, stateId, event) {
  return config.actions
    .filter((a) => a.state_id === stateId && a.on_event === event)
    .map((a) => {
      const field = config.fields.find((f) => f.key === a.field_key)
      const what = a.action === 'set_value' ? `set to "${a.value}"` : ACTION_LABELS[a.action].toLowerCase()
      return `${field?.label ?? a.field_key}: ${what}`
    })
}

function MoveForm({ item, pairItem, move, from, config, onCancel, onDone }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const effects = [...actionSummary(config, from.id, 'exit'), ...actionSummary(config, move.to.id, 'entry')]

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('transition_item', {
      p_item: item.id,
      p_to_state: move.to.id,
      p_reason: reason.trim() || null,
    })
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="form-inline move-form" onSubmit={handleSubmit}>
      <h3>
        Move {item.item_key}
        {pairItem && ` and ${pairItem.item_key}`} from {from.name} to {move.to.name}?
      </h3>
      {move.to.review_role && (
        <p className="small">
          {move.to.name} needs a {ROLE_LABELS[move.to.review_role]} review. The item will be locked until then.
        </p>
      )}
      {effects.length > 0 && (
        <p className="small muted">
          Automatically: {effects.join('; ')}.
        </p>
      )}
      <label>
        Reason{move.requires_reason ? ' (required)' : ' (optional)'}
        <input value={reason} onChange={(e) => setReason(e.target.value)} required={move.requires_reason} maxLength={500} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || (move.requires_reason && !reason.trim())}>
          {saving ? 'Moving…' : `Move to ${move.to.name}`}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// Electronic signature: the signer re-enters their password; the database checks it (SRS-023).
function SignForm({ item, pairItem, state, onCancel, onDone }) {
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await supabase.rpc('sign_and_advance', { p_item: item.id, p_password: password })
    setSaving(false)
    setPassword('')
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="form-inline signature-dialog" onSubmit={handleSubmit}>
      <h3>Electronic signature</h3>
      <p className="small">
        You are signing <strong>
          {item.item_key} version {item.revision}
          {pairItem && ` and ${pairItem.item_key} version ${pairItem.revision}`}
        </strong>{' '}
        in {state.name} with the meaning <strong>{state.review_meaning}</strong>. Your printed name, the date and time, and this
        meaning will be recorded and shown with the item. When this stage has one way forward, the item moves on as soon as you
        sign.
      </p>
      <label>
        Re-enter your password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving || !password}>
          {saving ? 'Signing…' : `Sign as ${state.review_meaning}`}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}


function History({ audit, signatures, config, members, stateById, revisionNumber, folders }) {
  const name = (id) => (id ? (members.find((m) => m.user_id === id)?.full_name ?? 'Unknown user') : 'System')
  const fieldLabel = (key) => config.fields.find((f) => f.key === key)?.label ?? key
  const show = (v) => (isEmpty(v) ? '(empty)' : Array.isArray(v) ? `${v.length} steps` : String(v))

  function describe(e) {
    const f = e.changed_fields ?? []
    if (e.table_name === 'items') {
      if (e.action === 'INSERT') return { what: 'Created', changes: [] }
      if (f.includes('folder_id')) {
        const folder = (id) => folders.find((x) => x.id === id)?.name ?? 'No folder'
        return { what: 'Moved to another folder', changes: [['Folder', folder(e.old_values.folder_id), folder(e.new_values.folder_id)]] }
      }
      return null // version pointers: shown by the version's own entries
    }
    const version = revisionNumber[e.record_id]
    if (e.action === 'INSERT') return version === 1 ? null : { what: `Started version ${version}`, changes: [] }
    const changes = []
    if (f.includes('title')) changes.push(['Title', e.old_values.title, e.new_values.title])
    if (f.includes('values')) {
      const o = e.old_values.values ?? {}
      const n = e.new_values.values ?? {}
      for (const k of new Set([...Object.keys(o), ...Object.keys(n)]))
        if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) changes.push([fieldLabel(k), show(o[k]), show(n[k])])
    }
    if (f.includes('state_id'))
      return {
        what: `Moved ${stateById[e.old_values.state_id]?.name ?? '?'} → ${stateById[e.new_values.state_id]?.name ?? '?'} (version ${version})`,
        changes,
      }
    if (f.includes('assignee'))
      return { what: `Assigned version ${version}`, changes: [['Assignee', name(e.old_values.assignee), name(e.new_values.assignee)]] }
    const link = e.reason?.match(/^(Link (?:added|removed): [^:]+)/)
    if (link && changes.length === 0) return { what: `${link[1]} (version ${version})`, changes }
    if (f.includes('content_version')) return { what: `Edited version ${version}`, changes }
    return { what: `Updated version ${version}`, changes }
  }

  const reasonOf = (e) =>
    e.reason
      ?.replace(/^Moved from .+? to .+?(: |$)/, '')
      .replace(/^Link (added|removed): [^:]+(: |$)/, '')
      .replace(/^New version \d+: /, '') || ''

  // Audit entries and signatures, newest first.
  const rows = [
    ...audit.map((e) => ({ ...e, d: describe(e), at: e.occurred_at })).filter((e) => e.d),
    ...signatures.map((s) => ({ signature: s, at: s.signed_at, id: `s${s.id}` })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at))

  return (
    <div className="table-wrap">
      <table aria-label="Item history">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Changes</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            if (e.signature) {
              const s = e.signature
              return (
                <tr key={`sig-${s.id}`} className="signature-row">
                  <td className="nowrap small">{formatTimestamp(s.signed_at)}</td>
                  <td>{s.signer_name}</td>
                  <td>
                    Signed: <strong>{s.meaning}</strong>
                  </td>
                  <td className="small muted">
                    {s.state_name} review · version {revisionNumber[s.revision_id]} · password re-entered
                  </td>
                  <td>
                    <span className="muted">—</span>
                  </td>
                </tr>
              )
            }
            const reason = reasonOf(e)
            return (
              <tr key={e.id}>
                <td className="nowrap small">{formatTimestamp(e.occurred_at)}</td>
                <td>{name(e.changed_by)}</td>
                <td>{e.d.what}</td>
                <td>
                  {e.d.changes.length === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <ul className="changes">
                      {e.d.changes.map(([label, from, to]) => (
                        <li key={label}>
                          <span className="muted">{label}:</span> <del>{from}</del> → <ins>{to}</ins>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{reason || <span className="muted">—</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Links to and from this item (SRS-019). Links belong to a version of the item they
// start from, so only those can be added or removed here, and only while it is editable.
function Links({ project, item, links, linkTypes, outgoingTypes, canChange, locked, requireReason, onChanged }) {
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(null)
  const groups = {}
  for (const l of links) (groups[`${l.direction}:${l.label}`] ??= { label: l.label, direction: l.direction, links: [] }).links.push(l)
  const sorted = Object.values(groups).sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1))

  if (linkTypes.length === 0) return null

  return (
    <section className="card stack-sm" aria-label="Links">
      <div className="card-head">
        <h3>Links</h3>
        {canChange && outgoingTypes.length > 0 && !adding && (
          <button type="button" className="secondary small" onClick={() => setAdding(true)}>
            Add link
          </button>
        )}
      </div>
      {sorted.length === 0 && <p className="muted small">No links yet.</p>}
      {sorted.map((g) => (
        <div key={`${g.direction}:${g.label}`}>
          <h4 className="small muted link-group">
            {item.item_key} {g.label}
          </h4>
          <ul className="link-list">
            {g.links.map((l) => (
              <li key={l.link_id} className="link-row">
                <span>
                  <Link to={`/projects/${project.id}/trackers/${l.other_type_key}/${l.other_item_key}`} className="prefix">
                    {l.other_item_key}
                  </Link>{' '}
                  {l.other_title} <span className="muted small">· {l.other_state}</span>
                </span>
                {l.direction === 'out' && canChange && removing?.link_id !== l.link_id && (
                  <button type="button" className="secondary small" onClick={() => setRemoving(l)}>
                    Remove
                  </button>
                )}
                {removing?.link_id === l.link_id && (
                  <LinkChange
                    title={`Remove link: ${item.item_key} ${l.label} ${l.other_item_key}?`}
                    submitLabel="Remove link"
                    requireReason={requireReason}
                    onCancel={() => setRemoving(null)}
                    onSubmit={(reason) => supabase.rpc('remove_item_link', { p_link: l.link_id, p_reason: reason })}
                    onDone={() => {
                      setRemoving(null)
                      onChanged()
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {adding && (
        <AddLink
          project={project}
          item={item}
          types={outgoingTypes}
          existing={links.filter((l) => l.direction === 'out')}
          requireReason={requireReason}
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            onChanged()
          }}
        />
      )}
      {outgoingTypes.length > 0 && (
        <p className="muted small">
          {locked
            ? `Version ${item.revision} of ${item.item_key} is locked, so its links can't change.`
            : `Links belong to version ${item.revision}; adding or removing one is recorded as an edit.`}
        </p>
      )}
    </section>
  )
}

function AddLink({ project, item, types, existing, requireReason, onCancel, onDone }) {
  const [typeKey, setTypeKey] = useState(types[0].key)
  const [targets, setTargets] = useState(null)
  const [target, setTarget] = useState('')
  const type = types.find((t) => t.key === typeKey)

  useEffect(() => {
    let current = true
    supabase
      .from('item_heads')
      .select('item_key, title, number')
      .eq('project_id', project.id)
      .like('item_key', `${type.target_type_key}-%`)
      .order('number')
      .then(({ data }) => current && setTargets(data ?? []))
    return () => {
      current = false
    }
  }, [project.id, type.target_type_key])

  const taken = new Set(existing.filter((l) => l.link_type === typeKey).map((l) => l.other_item_key))
  const options = (targets ?? []).filter((t) => !taken.has(t.item_key) && t.item_key !== item.item_key)

  return (
    <LinkChange
      title={`Add a link from ${item.item_key}`}
      submitLabel="Add link"
      requireReason={requireReason}
      canSubmit={Boolean(target)}
      onCancel={onCancel}
      onSubmit={(reason) =>
        supabase.rpc('add_item_link', { p_item: item.id, p_link_type: typeKey, p_target: target, p_reason: reason })
      }
      onDone={onDone}
    >
      <div className="form-row">
        <label>
          Link type
          <select
            value={typeKey}
            onChange={(e) => {
              setTypeKey(e.target.value)
              setTarget('')
              setTargets(null)
            }}
          >
            {types.map((t) => (
              <option key={t.key} value={t.key}>
                {item.item_key} {t.label} {t.target_type_key}
              </option>
            ))}
          </select>
        </label>
        <label>
          {type.target_type_key} item
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!targets}>
            <option value="">{targets ? (options.length ? 'Choose…' : `No ${type.target_type_key} items to link`) : 'Loading…'}</option>
            {options.map((t) => (
              <option key={t.item_key} value={t.item_key}>
                {t.item_key} {t.title}
              </option>
            ))}
          </select>
        </label>
      </div>
    </LinkChange>
  )
}

// Confirm a link change, with a reason (required once the item has been reviewed).
function LinkChange({ title, submitLabel, requireReason, canSubmit = true, onSubmit, onCancel, onDone, children }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { error } = await onSubmit(reason.trim() || null)
    setSaving(false)
    if (error) setError(error.message)
    else onDone()
  }

  return (
    <form className="form-inline link-form" onSubmit={handleSubmit}>
      <h4>{title}</h4>
      {children}
      <label>
        Reason{requireReason ? ' (required: this item has been reviewed before)' : ' (optional)'}
        <input value={reason} onChange={(e) => setReason(e.target.value)} required={requireReason} maxLength={500} />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="small" disabled={saving || !canSubmit || (requireReason && !reason.trim())}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="secondary small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// Which release the open version is for. When it is approved, it is pinned there.
function TargetRelease({ item, releases, target, canChange, onChanged }) {
  const [error, setError] = useState('')
  const open = releases.filter((r) => !r.complete || r.id === item.target_release_id)
  return (
    <span className="target-release">
      · For release{' '}
      {canChange && open.length > 0 ? (
        <select
          aria-label="Target release"
          value={item.target_release_id ?? ''}
          onChange={async (e) => {
            setError('')
            const { error } = await supabase.rpc('set_target_release', { p_item: item.id, p_release: e.target.value || null })
            if (error) setError(error.message)
            else onChanged()
          }}
        >
          <option value="">none</option>
          {open.map((r) => (
            <option key={r.id} value={r.id}>
              {releaseLabel(r)}
            </option>
          ))}
        </select>
      ) : (
        <strong>{target ? releaseLabel(target) : 'none'}</strong>
      )}
      {error && <span className="error"> {error}</span>}
    </span>
  )
}

// A release's contents: the approved versions pinned to it, and drafts aimed at it (SRS-048).
function ReleaseContents({ project, release, releases, members, canManage, complete }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const [from, setFrom] = useState('')
  const [addKey, setAddKey] = useState('')
  const [removing, setRemoving] = useState(null)
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(
    () =>
      supabase.rpc('release_contents', { p_release: release.id }).then(({ data, error }) => {
        if (error) setError(error.message)
        else setRows(data)
      }),
    [release.id],
  )
  useEffect(() => {
    load()
  }, [load])

  async function act(promise, done) {
    setError('')
    setNotice('')
    const { data, error } = await promise
    if (error) return setError(error.message)
    done?.(data)
    load()
  }

  const pinned = (rows ?? []).filter((r) => r.kind === 'pinned')
  const drafts = (rows ?? []).filter((r) => r.kind === 'draft')
  const byTracker = (list) => {
    const groups = {}
    for (const r of list) (groups[r.type_key] ??= []).push(r)
    return Object.entries(groups)
  }
  const itemLink = (r) => (
    <Link to={`/projects/${project.id}/trackers/${r.type_key}/${r.item_key}`} className="prefix">
      {r.item_key}
    </Link>
  )

  return (
    <section className="card stack-sm" aria-label="Release contents">
      <div className="card-head">
        <h3>What {release.item_key} contains</h3>
        <span className="muted small">
          {pinned.length} approved {pinned.length === 1 ? 'item' : 'items'} · {drafts.length} in progress
        </span>
      </div>
      {complete && <p className="small muted">This release is complete. Its contents are frozen and can never change.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="small" role="status">
          {notice}
        </p>
      )}
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {pinned.length === 0 && <p className="muted small">Nothing is in this release yet.</p>}
          {byTracker(pinned).map(([type, list]) => (
            <div key={type} className="table-wrap">
              <table aria-label={`${type} in ${release.item_key}`}>
                <thead>
                  <tr>
                    <th>{type}</th>
                    <th>Title (as released)</th>
                    <th>Version</th>
                    {canManage && <th />}
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.item_id}>
                      <td className="nowrap">{itemLink(r)}</td>
                      <td>{r.title}</td>
                      <td className="nowrap">
                        v{r.revision}
                        {r.latest_revision > r.revision && <div className="muted small">v{r.latest_revision} exists</div>}
                      </td>
                      {canManage && (
                        <td className="nowrap">
                          {removing === r.item_id ? (
                            <span className="inline-edit">
                              <input aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                              <button
                                type="button"
                                className="small"
                                disabled={!reason.trim()}
                                onClick={() =>
                                  act(supabase.rpc('unpin_from_release', { p_release: release.id, p_item: r.item_id, p_reason: reason.trim() }), () => {
                                    setRemoving(null)
                                    setReason('')
                                  })
                                }
                              >
                                Remove
                              </button>
                              <button type="button" className="secondary small" onClick={() => setRemoving(null)}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button type="button" className="secondary small" onClick={() => setRemoving(r.item_id)}>
                              Remove…
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {drafts.length > 0 && (
            <>
              <h4>In progress for this release</h4>
              <div className="table-wrap">
                <table aria-label={`In progress for ${release.item_key}`}>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Title</th>
                      <th>Version</th>
                      <th>State</th>
                      <th>Assignee</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drafts.map((r) => (
                      <tr key={r.item_id}>
                        <td className="nowrap">{itemLink(r)}</td>
                        <td>{r.title}</td>
                        <td>v{r.revision}</td>
                        <td>{r.state}</td>
                        <td className="small">{members.find((m) => m.user_id === r.assignee)?.full_name ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {canManage && (
        <div className="form-row release-tools">
          <form
            className="inline-edit"
            onSubmit={(e) => {
              e.preventDefault()
              act(supabase.rpc('carry_forward_release', { p_release: release.id, p_from: from }), (n) =>
                setNotice(`${n} ${n === 1 ? 'item' : 'items'} carried forward.`),
              )
            }}
          >
            <select aria-label="Carry forward from" value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">Carry forward from…</option>
              {releases
                .filter((r) => r.id !== release.id)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {releaseLabel(r)}
                  </option>
                ))}
            </select>
            <button type="submit" className="secondary small" disabled={!from}>
              Carry forward
            </button>
          </form>
          <form
            className="inline-edit"
            onSubmit={async (e) => {
              e.preventDefault()
              const { data: target } = await supabase
                .from('items')
                .select('id')
                .eq('project_id', project.id)
                .eq('item_key', addKey.trim().toUpperCase())
                .maybeSingle()
              if (!target) return setError(`No item ${addKey.trim().toUpperCase()} in this project`)
              act(supabase.rpc('pin_to_release', { p_release: release.id, p_item: target.id }), () => setAddKey(''))
            }}
          >
            <input aria-label="Item ID to add" placeholder="Add approved item, e.g. SRS-004" value={addKey} onChange={(e) => setAddKey(e.target.value)} />
            <button type="submit" className="secondary small" disabled={!addKey.trim()}>
              Add
            </button>
          </form>
        </div>
      )}
    </section>
  )
}

// What changed since the last approved version, so a re-review checks the change
// instead of re-reading everything (design note, decision 8).
function ChangesSince({ data, d }) {
  const { config, item } = data
  const before = d.approvedRev
  if (!before || before.id === item.revision_id) return null
  const show = (v) => (isEmpty(v) ? '(empty)' : String(v))
  const changes = []
  if (before.title !== item.title) changes.push(['Title', before.title, item.title])
  for (const f of config.fields) {
    const o = before.values[f.key]
    const n = item.values[f.key]
    if (JSON.stringify(o) === JSON.stringify(n)) continue
    if (f.field_type === 'statements') {
      const old = Object.fromEntries((o ?? []).map((s) => [s.n, s.text]))
      const now = Object.fromEntries((n ?? []).map((s) => [s.n, s.text]))
      for (const k of new Set([...Object.keys(old), ...Object.keys(now)])) {
        const key = `${item.item_key}.${k}`
        if (!(k in now)) changes.push([key, old[k], '(removed)'])
        else if (!(k in old)) changes.push([key, '(new)', now[k]])
        else if (old[k] !== now[k]) changes.push([key, old[k], now[k]])
      }
    } else if (f.field_type === 'steps') {
      const os = o ?? []
      const ns = n ?? []
      for (let i = 0; i < Math.max(os.length, ns.length); i++) {
        const a = os[i]
        const b = ns[i]
        const text = (s) => (s ? [s.er, s.action, s.expected ?? (s.fields ?? []).join(', ')].filter(Boolean).join(' · ') : '(none)')
        if (text(a) !== text(b)) changes.push([`Step ${i + 1}`, text(a), text(b)])
      }
    } else changes.push([f.label, show(o), show(n)])
  }
  return (
    <section className="card changes-since" aria-label={`Changes in ${item.item_key}`}>
      <h3>
        {item.item_key}: changes since version {before.revision}
      </h3>
      {changes.length === 0 ? (
        <p className="muted small">No content changes since version {before.revision}.</p>
      ) : (
        <ul className="changes">
          {changes.map(([label, from, to], i) => (
            <li key={i}>
              <span className="muted">{label}:</span> <del>{from}</del> → <ins>{to}</ins>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
