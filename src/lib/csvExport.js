import { supabase } from './supabase'

// Export a tracker's items (their latest versions) as CSV: one row per item, its ID,
// folder, title, state and version, every field, the paired test case for requirements,
// and the items it links to. ERs are listed one per line with their numbers
// (SRS-004.1 ...), test steps one per line.

const cell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'

function fieldText(field, value, itemKey, members) {
  if (value == null || value === '') return ''
  switch (field.field_type) {
    case 'statements':
      return (value ?? []).map((s) => `${itemKey}.${s.n} ${s.text}`).join('\n')
    case 'steps':
      return (value ?? [])
        .map((s, i) =>
          s.kind === 'document'
            ? `${i + 1}. [Record] ${s.action} → ${(s.fields ?? []).join('; ')}`
            : `${i + 1}. ${s.action} → ${s.expected}${s.er ? ` [${s.er}]` : ''}`,
        )
        .join('\n')
    case 'user':
      return members.find((m) => m.user_id === value)?.full_name ?? value
    default:
      return Array.isArray(value) ? value.join('; ') : value
  }
}

export async function exportItems({ config, items, members, states, folders, partners, linkTypes, releases }) {
  const ids = items.map((i) => i.id)
  const { data: heads, error } = ids.length
    ? await supabase.from('item_heads').select('id, revision_id, values').in('id', ids)
    : { data: [] }
  if (error) throw error
  const headById = Object.fromEntries(heads.map((h) => [h.id, h]))

  // Outgoing links of each latest version, by link type.
  const revIds = heads.map((h) => h.revision_id)
  const { data: links, error: linkError } = revIds.length
    ? await supabase.from('item_links').select('source_revision_id, link_type_id, target_item_id').in('source_revision_id', revIds)
    : { data: [] }
  if (linkError) throw linkError
  const targetIds = [...new Set(links.map((l) => l.target_item_id))]
  const { data: targets } = targetIds.length
    ? await supabase.from('items').select('id, item_key').in('id', targetIds)
    : { data: [] }
  const keyOf = Object.fromEntries((targets ?? []).map((t) => [t.id, t.item_key]))
  // The link between a requirement and its own test case is shown as the test_case column.
  const partnerIds = new Set(items.map((i) => i.pair_item_id).filter(Boolean))
  const shownLinks = links.filter((l) => !partnerIds.has(l.target_item_id))
  const types = linkTypes.filter(
    (t) => !t.is_retired && t.source_type_key === config.tracker.type_key && shownLinks.some((l) => l.link_type_id === t.id),
  )

  const fields = config.fields.filter((f) => !f.is_retired || items.some((i) => headById[i.id]?.values?.[f.key] != null))
  const hub = config.tracker.is_pair_primary
  const header = [
    'id', 'folder', 'title', 'state', 'version', 'approved_version',
    ...(hub ? ['test_case', 'test_case_state'] : []),
    'release',
    ...fields.map((f) => f.label),
    ...types.map((t) => `${t.label} ${t.target_type_key}`),
  ]
  const stateName = (id) => states.find((s) => s.id === id)?.name ?? ''
  const rows = items.map((i) => {
    const values = headById[i.id]?.values ?? {}
    const own = shownLinks.filter((l) => l.source_revision_id === headById[i.id]?.revision_id)
    const partner = partners[i.pair_item_id]
    return [
      i.item_key,
      folders.find((f) => f.id === i.folder_id)?.name ?? '',
      i.title,
      stateName(i.state_id),
      i.revision,
      i.approved_revision ?? '',
      ...(hub ? [partner?.item_key ?? '', partner?.state?.name ?? ''] : []),
      releases.find((r) => r.id === i.target_release_id)?.item_key ?? '',
      ...fields.map((f) => fieldText(f, values[f.key], i.item_key, members)),
      ...types.map((t) =>
        own
          .filter((l) => l.link_type_id === t.id)
          .map((l) => keyOf[l.target_item_id])
          .filter(Boolean)
          .join('; '),
      ),
    ]
  })
  return toCsv([header, ...rows])
}

export function downloadCsv(text, filename) {
  // The byte-order mark makes Excel read the file as UTF-8.
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
