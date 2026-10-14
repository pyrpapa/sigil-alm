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
    if (h === 'id') return { header, kind: 'id', label: 'ID', note: 'Checked against the ID each row gets' }
    if (h === 'title') return { header, kind: 'title' }
    if (h === 'folder') return { header, kind: 'folder', note: 'Folders are created if needed' }
    if (h === 'status' || h === 'state')
      return { header, kind: 'ignore', note: 'Imported items start in New; approval happens in Sigil' }
    const field = fields.find((f) => f.key === h || norm(f.label) === h)
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
    case 'user': {
      const lower = raw.toLowerCase()
      const m = members.find((x) => x.email?.toLowerCase() === lower || x.full_name?.toLowerCase() === lower)
      return m ? m.user_id : raw
    }
    default:
      return raw
  }
}

// Build the rows sent to import_items.
export function buildImportRows(table, columns, members = []) {
  return table.map((cells, index) => {
    const row = { line: index + 2, values: {}, links: [] }
    columns.forEach((col, i) => {
      const raw = (cells[i] ?? '').replace(/\r\n?/g, '\n').trim()
      if (raw === '') return
      if (col.kind === 'id') row.id = raw
      else if (col.kind === 'title') row.title = raw
      else if (col.kind === 'folder') row.folder = raw
      else if (col.kind === 'field') row.values[col.field.key] = convert(col.field, raw, members)
      else if (col.kind === 'link')
        raw
          .split(/[;,\n]/)
          .map((t) => t.trim())
          .filter(Boolean)
          .forEach((target) => row.links.push({ type: col.linkType.key, target }))
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
