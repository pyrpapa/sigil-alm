import { supabase } from './supabase'

// Load a tracker and its whole configuration in one go.
export async function loadTracker(projectId, typeKey) {
  const { data: tracker, error } = await supabase
    .from('trackers')
    .select('id, project_id, type_key, name, description, next_number')
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
export function cleanSteps(steps) {
  return steps.map((s) =>
    s.kind === 'document'
      ? { kind: 'document', action: (s.action ?? '').trim(), fields: (s.fields ?? []).map((f) => f.trim()).filter(Boolean) }
      : { action: (s.action ?? '').trim(), expected: (s.expected ?? '').trim() },
  )
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
