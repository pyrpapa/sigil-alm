import { supabase } from './supabase'

// Load a tracker and its whole configuration in one go.
export async function loadTracker(projectId, typeKey) {
  const { data: tracker, error } = await supabase
    .from('trackers')
    .select('id, project_id, type_key, name, description, next_number, pair_tracker_id, is_pair_primary')
    .eq('project_id', projectId)
    .eq('type_key', typeKey)
    .maybeSingle()
  if (error) throw error
  if (!tracker) return null

  const [fields, states, transitions, actions, folders] = await Promise.all([
    supabase.from('tracker_fields').select('*').eq('tracker_id', tracker.id).order('position').order('created_at'),
    supabase.from('tracker_states').select('*').eq('tracker_id', tracker.id).order('position').order('created_at'),
    supabase.from('tracker_transitions').select('*').eq('tracker_id', tracker.id),
    supabase.from('tracker_state_actions').select('*').eq('tracker_id', tracker.id).order('created_at'),
    supabase.from('folders').select('*').eq('tracker_id', tracker.id).order('position').order('name'),
  ])
  for (const res of [fields, states, transitions, actions, folders]) if (res.error) throw res.error

  return {
    tracker,
    fields: fields.data,
    states: states.data,
    transitions: transitions.data,
    actions: actions.data,
    folders: folders.data,
  }
}

export async function loadLinkTypes(projectId) {
  const { data, error } = await supabase.from('link_types').select('*').eq('project_id', projectId).order('key')
  if (error) throw error
  return data
}

// The project's releases (items of the REL tracker), each marked complete or not.
export async function loadReleases(projectId) {
  const { data: tracker, error } = await supabase
    .from('trackers')
    .select('id')
    .eq('project_id', projectId)
    .eq('type_key', 'REL')
    .maybeSingle()
  if (error) throw error
  if (!tracker) return []
  const [items, states] = await Promise.all([
    supabase.from('item_heads').select('id, item_key, title, state_id, number').eq('tracker_id', tracker.id).order('number'),
    supabase.from('tracker_states').select('id, name, is_final').eq('tracker_id', tracker.id),
  ])
  for (const r of [items, states]) if (r.error) throw r.error
  return items.data.map((i) => {
    const s = states.data.find((x) => x.id === i.state_id)
    return { id: i.id, item_key: i.item_key, title: i.title, state: s?.name, complete: Boolean(s?.is_final) }
  })
}

export const releaseLabel = (r) => (r ? `${r.item_key} ${r.title}` : '')

export async function loadMembers(projectId) {
  const { data, error } = await supabase.rpc('project_member_list', { p_project: projectId })
  if (error) throw error
  return data
}

export function isEmpty(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

// Turn a label into a field key: "Approved on" -> "approved_on".
export function fieldKeyFromLabel(label) {
  const key = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return /^[a-z]/.test(key) ? key : `f_${key}`.slice(0, 40)
}

// Tidies test steps before saving: trims text and drops blank "values to record" rows.
// The ER a step verifies goes with it; the database records the ER's wording itself.
export function cleanSteps(steps) {
  return steps.map((s) => {
    const er = s.er ? { er: s.er, ...(s.er_confirm ? { er_confirm: true } : {}) } : {}
    return s.kind === 'document'
      ? { kind: 'document', action: (s.action ?? '').trim(), fields: (s.fields ?? []).map((f) => f.trim()).filter(Boolean), ...er }
      : { action: (s.action ?? '').trim(), expected: (s.expected ?? '').trim(), ...er }
  })
}

// ERs of the given items' latest versions, as { key: 'SRS-011.3', text }.
export async function loadErs(itemIds) {
  if (itemIds.length === 0) return []
  const [heads, fields] = await Promise.all([
    supabase.from('item_heads').select('id, item_key, tracker_id, values, number').in('id', itemIds).order('number'),
    supabase.from('tracker_fields').select('tracker_id, key').eq('field_type', 'statements').eq('is_retired', false),
  ])
  for (const r of [heads, fields]) if (r.error) throw r.error
  return heads.data.flatMap((h) => {
    const f = fields.data.find((x) => x.tracker_id === h.tracker_id)
    return (f ? (h.values[f.key] ?? []) : []).map((s) => ({ key: `${h.item_key}.${s.n}`, text: s.text }))
  })
}

// What is still missing from a list of steps, as short messages (empty when complete).
export function stepProblems(steps) {
  const problems = []
  steps.forEach((s, i) => {
    if (!(s.action ?? '').trim()) problems.push(`step ${i + 1} action`)
    if (s.kind === 'document') {
      if (!(s.fields ?? []).some((f) => f.trim())) problems.push(`step ${i + 1} values to record`)
    } else if (!(s.expected ?? '').trim()) problems.push(`step ${i + 1} expected result`)
  })
  return problems
}

// A starting step for each ER: the expected result is the ER, the action is left to the author.
export const stepsForErs = (ers) => ers.map((e) => ({ action: '', expected: e.text, er: e.key }))
