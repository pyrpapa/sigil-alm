// CSV import (SRS-047): parse a file and turn its rows into import rows for a
// tracker. Everything here is a convenience for the preview; the database checks
// every row again (import_items) before anything is created.

// RFC 4180 parser: quoted fields may contain commas, quotes ("") and line breaks.
export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '')
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}

const norm = (s) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

// Decide what each column of the file means for this tracker.
export function mapColumns(headers, config, linkTypes) {
  const fields = config.fields.filter((f) => !f.is_retired)
  const autoKeys = new Set(config.actions?.map((a) => a.field_key) ?? [])
  const outgoing = linkTypes.filter((t) => t.source_type_key === config.tracker.type_key && !t.is_retired)
  return headers.map((header) => {
    const h = norm(header)
    if (h === 'id') return { header, kind: 'ignore', label: 'ID', note: 'Ignored: Sigil numbers new items itself' }
    if (h === 'title') return { header, kind: 'title' }
    if (h === 'folder') return { header, kind: 'folder', note: 'Folders are created if needed' }
    if (h === 'release' && config.tracker.type_key !== 'REL')
      return { header, kind: 'release', label: 'Release', note: 'The release (e.g. REL-001) each item is for' }
    if (h === 'status' || h === 'state')
      return { header, kind: 'ignore', note: 'Imported items start in New; approval happens in Sigil' }
    let field = fields.find((f) => f.key === h || norm(f.label) === h)
    // An SRS "requirement" column becomes the ER list, one ER per line.
    if (!field && (h === 'requirement' || h === 'requirements' || h === 'ers'))
      field = fields.find((f) => f.field_type === 'statements')
    if (field && autoKeys.has(field.key)) return { header, kind: 'ignore', note: `${field.label} is set by the workflow` }
    if (field) {
      if (field.field_type === 'steps') return { header, kind: 'ignore', note: 'Test steps cannot be imported from CSV yet' }
      return { header, kind: 'field', field }
    }
    let type = outgoing.find((t) => t.key === h || norm(t.label) === h)
    if (!type && h.startsWith('linked_')) {
      const target = h.slice('linked_'.length).toUpperCase()
      const matches = outgoing.filter((t) => t.target_type_key === target)
      if (matches.length === 1) type = matches[0]
    }
    if (type) return { header, kind: 'link', linkType: type, note: `Links: ${config.tracker.type_key} ${type.label} ${type.target_type_key}` }
    return { header, kind: 'ignore', note: 'Not a field of this tracker' }
  })
}

// Text to ERs: one per line; lines starting with -, * or • stay inside the ER above.
export function splitStatements(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (/^[-*•]\s+/.test(t) && out.length) out[out.length - 1] += `\n${t}`
    else out.push(t)
  }
  return out.map((t, i) => ({ n: i + 1, text: t }))
}

// Dropdowns: exact, then case-insensitive, then a unique prefix ("H" -> "High").
function matchOption(options, raw) {
  if (options.includes(raw)) return raw
  const lower = raw.toLowerCase()
  const ci = options.find((o) => o.toLowerCase() === lower)
  if (ci) return ci
  const starts = options.filter((o) => o.toLowerCase().startsWith(lower))
  return starts.length === 1 ? starts[0] : raw
}

function convert(field, raw, members) {
  switch (field.field_type) {
    case 'number': {
      const n = Number(raw)
      return Number.isFinite(n) ? n : raw
    }
    case 'select':
      return matchOption(field.options, raw)
    case 'statements':
      return splitStatements(raw)
    case 'user': {
      const lower = raw.toLowerCase()
      const m = members.find((x) => x.email?.toLowerCase() === lower || x.full_name?.toLowerCase() === lower)
      return m ? m.user_id : raw
    }
    default:
      return raw
  }
}

// Link targets are separated by ; or new lines. Each is an ID (SRS-004) or an item's
// title; a list of IDs may also be separated by commas.
const KEY = /^[A-Za-z]+-\d+$/
export function splitTargets(raw) {
  return raw
    .split(/[;\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .flatMap((t) => (t.split(',').every((k) => KEY.test(k.trim())) ? t.split(',').map((k) => k.trim()) : [t]))
}
export const isItemKey = (t) => KEY.test(t)

// Build the rows sent to import_items.
export function buildImportRows(table, columns, members = []) {
  return table.map((cells, index) => {
    const row = { line: index + 2, values: {}, links: [] }
    columns.forEach((col, i) => {
      const raw = (cells[i] ?? '').replace(/\r\n?/g, '\n').trim()
      if (raw === '') return
      if (col.kind === 'title') row.title = raw
      else if (col.kind === 'folder') row.folder = raw
      else if (col.kind === 'release') row.release = raw
      else if (col.kind === 'field') row.values[col.field.key] = convert(col.field, raw, members)
      else if (col.kind === 'link')
        splitTargets(raw).forEach((target) => row.links.push({ type: col.linkType.key, target }))
    })
    return row
  })
}

// Parse and map in one step. Returns { columns, rows } or { error }.
export function prepareImport(text, config, linkTypes, members) {
  const table = parseCsv(text)
  if (table.length < 2) return { error: 'The file needs a header row and at least one row of data.' }
  const [headers, ...body] = table
  const columns = mapColumns(headers, config, linkTypes)
  if (!columns.some((c) => c.kind === 'title')) return { error: 'The file needs a "title" column.', columns }
  return { columns, rows: buildImportRows(body, columns, members) }
}

// Test steps as exported: one step per line, numbered.
//   1. Open the login page → The Sign in button is visible [SRS-004.1]
//   2. [Record] Record the test environment → Browser and version; Operating system
// "->" works as well as "→". A line that does not start with a number continues the
// step above it.
export function parseSteps(raw) {
  const steps = []
  const problems = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const m = line.match(/^\s*\d+[.)]\s*(.*)$/)
    if (!m) {
      const last = steps[steps.length - 1]
      if (!last) problems.push(`"${line.trim()}" is not a numbered step`)
      else if (last.kind === 'document') last.action += `\n${line.trim()}`
      else last.expected += `\n${line.trim()}`
      continue
    }
    let text = m[1].trim()
    const doc = /^\[record\]\s*/i.test(text)
    if (doc) text = text.replace(/^\[record\]\s*/i, '')
    let er
    const erMatch = text.match(/\s*\[([A-Za-z]+-\d+\.\d+)\]\s*$/)
    if (erMatch) {
      er = erMatch[1].toUpperCase()
      text = text.slice(0, erMatch.index)
    }
    const [action, ...rest] = text.split(/\s*(?:→|->)\s*/)
    const second = rest.join(' → ')
    if (doc)
      steps.push({
        kind: 'document',
        action: action.trim(),
        fields: second.split(';').map((f) => f.trim()).filter(Boolean),
        ...(er ? { er } : {}),
      })
    else steps.push({ action: action.trim(), expected: second.trim(), ...(er ? { er } : {}) })
  }
  return { steps, problems }
}

// Update existing items from a file exported by Sigil (or one like it): the id column
// says which item each row changes; title and field columns are applied; the rest
// (folder, state, version, links...) is ignored. Fields not in the file keep their values.
export function prepareUpdate(text, config, members) {
  const table = parseCsv(text)
  if (table.length < 2) return { error: 'The file needs a header row and at least one row of data.' }
  const [headers, ...body] = table
  const fields = config.fields.filter((f) => !f.is_retired)
  const autoKeys = new Set(config.actions?.map((a) => a.field_key) ?? [])
  const columns = headers.map((header) => {
    const h = norm(header)
    if (h === 'id') return { header, kind: 'key' }
    if (h === 'title') return { header, kind: 'title' }
    const field = fields.find((f) => f.key === h || norm(f.label) === h)
    if (field && !autoKeys.has(field.key)) return { header, kind: 'field', field }
    return { header, kind: 'ignore' }
  })
  if (!columns.some((c) => c.kind === 'key')) return { error: 'The file needs an "id" column saying which item each row updates.' }
  const rows = body
    .filter((cells) => cells.some((c) => c.trim()))
    .map((cells, index) => {
      const row = { line: index + 2, values: {}, problems: [] }
      columns.forEach((col, i) => {
        const raw = (cells[i] ?? '').replace(/\r\n?/g, '\n').trim()
        if (col.kind === 'key') row.key = raw.toUpperCase()
        else if (col.kind === 'title') row.title = raw
        else if (col.kind === 'field') {
          if (col.field.field_type === 'steps') {
            const { steps, problems } = parseSteps(raw)
            row.values[col.field.key] = steps
            row.problems.push(...problems)
          } else row.values[col.field.key] = raw === '' ? null : convert(col.field, raw, members)
        }
      })
      return row
    })
  return { columns, rows }
}
