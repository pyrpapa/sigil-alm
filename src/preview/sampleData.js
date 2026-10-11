// PREVIEW ONLY. Sample data for the tracker and test run mockups.
// SRS and RISK come from the real draft files in docs/validation; test cases,
// runs, design items and deviations are invented examples. Nothing here is saved.
// Real trackers and items arrive in Phase 2d.
import srsCsv from '../../docs/validation/srs-v1.csv?raw'
import riskCsv from '../../docs/validation/risk-v1.csv?raw'

// Small CSV parser: quoted fields, escaped quotes ("") and line breaks inside quotes.
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') inQuotes = false
      else field += c
    } else if (c === '"') inQuotes = true
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
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  const [header, ...data] = rows.filter((r) => r.some((v) => v !== ''))
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').replace(/\r/g, '')])))
}

export const TRACKERS = [
  { key: 'SRS', name: 'Software Requirements', description: 'What the system must do. Each item is one testable requirement.' },
  { key: 'SDS', name: 'Software Design', description: 'How requirements are implemented.' },
  { key: 'RISK', name: 'Risk Assessment', description: 'Ways the system could fail, rated by severity and likelihood.' },
  { key: 'TC', name: 'Test Cases', description: 'Steps and expected results that verify requirements.' },
  { key: 'TR', name: 'Test Runs', description: 'Executions of test cases, manual or from CI, with evidence.' },
  { key: 'DEV', name: 'Deviations', description: 'Failures and unexpected results, investigated and resolved.' },
]

const PEOPLE = {
  david: 'David Crosby',
  qa: 'Jordan Reyes (QA)',
  ci: 'GitHub Actions',
}

const SHA_V1 = '3f9c2e1'
const SHA_V2 = 'a81d4b7'
const SHA_DRIFT = 'c07e5f2'

// --- SRS and RISK from the real draft files ----------------------------------
// Statuses are overridden for a few items so the preview shows the full lifecycle.
const SRS_STATE_OVERRIDES = {
  'SRS-001': 'Approved',
  'SRS-004': 'Approved',
  'SRS-006': 'Approved',
  'SRS-009': 'In Review',
  'SRS-011': 'Approved',
  'SRS-030': 'Approved',
  'SRS-031': 'Approved',
}

const srsItems = parseCsv(srsCsv).map((r) => ({
  key: r.id,
  tracker: 'SRS',
  title: r.title,
  folder: r.folder,
  state: SRS_STATE_OVERRIDES[r.id] ?? r.status,
  version: SRS_STATE_OVERRIDES[r.id] === 'Approved' ? 2 : 1,
  fields: { Requirement: r.requirement, Verification: r.verification, Rationale: r.rationale },
  links: [],
}))

const riskItems = parseCsv(riskCsv).map((r) => ({
  key: r.id,
  tracker: 'RISK',
  title: r.failure_mode,
  folder: `${r.risk_level} risk`,
  state: r.status,
  version: 1,
  riskLevel: r.risk_level,
  fields: {
    'Failure mode': r.failure_mode,
    Effect: r.effect,
    Severity: r.severity,
    Likelihood: r.likelihood,
    'Risk level': r.risk_level,
    Mitigation: r.mitigation,
  },
  links: r.linked_srs.split(';').map((s) => ({ type: 'mitigates', to: s.trim() })),
}))

// --- Invented examples ----------------------------------------------------------
const tcItems = [
  {
    key: 'TC-001',
    title: 'Signed-out visitor is sent to the login page',
    folder: 'Access',
    state: 'Approved',
    version: 2,
    executionType: 'Automated',
    script: { file: 'tests/smoke.spec.js', tag: '@TC-001', pinnedSha: SHA_V2 },
    links: [{ type: 'verifies', to: 'SRS-001' }],
    steps: [
      { action: 'Open the application root URL while signed out', expected: 'Browser is redirected to /login' },
      { action: 'Inspect the login page', expected: 'Sigil heading, Email field, Password field and Sign in button are visible' },
    ],
  },
  {
    key: 'TC-002',
    title: 'Invalid credentials are rejected',
    folder: 'Access',
    state: 'In Review',
    version: 3,
    executionType: 'Automated',
    script: { file: 'tests/smoke.spec.js', tag: '@TC-002', pinnedSha: SHA_V1 },
    links: [{ type: 'verifies', to: 'SRS-001' }],
    steps: [
      { action: 'Enter an unknown email and wrong password, then select Sign in', expected: 'An error message saying the credentials are invalid is shown' },
      { action: 'Check the current page', expected: 'User stays on /login and is not signed in' },
    ],
  },
  {
    key: 'TC-003',
    title: 'Non-member cannot see or change a project',
    folder: 'Access',
    state: 'Approved',
    version: 1,
    executionType: 'Automated',
    script: { file: 'supabase/tests/database/01_access.test.sql', tag: '@TC-003', pinnedSha: SHA_V2 },
    links: [
      { type: 'verifies', to: 'SRS-004' },
      { type: 'verifies', to: 'SRS-006' },
    ],
    steps: [
      { action: 'As a user who is not a member, query the projects list', expected: 'The project is not returned' },
      { action: 'As the same user, send a direct API request to rename the project', expected: 'No rows are changed' },
      { action: 'As the same user, try to add themselves as a member', expected: 'The request is refused with a permission error' },
    ],
  },
  {
    key: 'TC-004',
    title: 'Archived project is read-only',
    folder: 'Projects',
    state: 'Approved',
    version: 1,
    executionType: 'Manual',
    links: [{ type: 'verifies', to: 'SRS-011' }],
    steps: [
      { action: 'Sign in as a project Admin and open the project Overview', expected: 'Archive project section is visible' },
      { action: 'Select Archive…, enter a reason and confirm', expected: 'Status changes to Archived and a read-only notice is shown' },
      { action: 'Try to edit the project details', expected: 'Edit details is not available' },
      { action: 'Open the Activity tab', expected: 'An "Archived the project" entry shows your name, the time and the reason' },
      { action: 'Select De-archive…, enter a reason and confirm', expected: 'Status returns to Active and editing is available again' },
    ],
  },
  {
    key: 'TC-005',
    title: 'Audit entries cannot be modified or deleted',
    folder: 'Audit trail',
    state: 'Approved',
    version: 1,
    executionType: 'Automated',
    script: { file: 'supabase/tests/database/02_audit_trail.test.sql', tag: '@TC-005', pinnedSha: SHA_V2 },
    links: [
      { type: 'verifies', to: 'SRS-030' },
      { type: 'verifies', to: 'SRS-031' },
    ],
    steps: [
      { action: 'As a project member, try to update an audit entry', expected: 'Refused with a permission error' },
      { action: 'As the service role, try to delete audit entries', expected: 'Refused with a permission error' },
      { action: 'As the database owner, try to update, delete and truncate', expected: 'Each is refused: "Audit entries cannot be modified or deleted"' },
    ],
  },
  {
    key: 'TC-006',
    title: 'Create a project with planned dates',
    folder: 'Projects',
    state: 'Draft',
    version: 1,
    executionType: 'Manual',
    links: [{ type: 'verifies', to: 'SRS-009' }],
    steps: [
      { action: 'Select New project and enter a name, system, start and end date', expected: 'Create project is enabled' },
      { action: 'Set the end date before the start date', expected: 'A validation message is shown and Create project is disabled' },
      { action: 'Fix the dates and select Create project', expected: 'The project appears in the list with its dates and Planning status' },
    ],
  },
].map((tc) => ({ ...tc, tracker: 'TC', fields: { 'Execution type': tc.executionType } }))

const trItems = [
  { key: 'TR-001', tc: 'TC-001', tcVersion: 1, runType: 'Dry run', source: 'CI', result: 'Failed', sha: '1b2c3d4', by: PEOPLE.ci, at: '2026-10-09T14:12:00Z', review: 'Not required' },
  { key: 'TR-002', tc: 'TC-001', tcVersion: 1, runType: 'Dry run', source: 'CI', result: 'Passed', sha: SHA_V1, by: PEOPLE.ci, at: '2026-10-09T15:40:00Z', review: 'Not required' },
  { key: 'TR-003', tc: 'TC-001', tcVersion: 2, runType: 'Formal', source: 'CI', result: 'Passed', sha: SHA_V2, by: PEOPLE.ci, at: '2026-10-10T16:05:00Z', review: `Reviewed by ${PEOPLE.qa}` },
  { key: 'TR-004', tc: 'TC-001', tcVersion: 2, runType: 'Formal', source: 'CI', result: 'Passed', sha: SHA_V2, by: PEOPLE.ci, at: '2026-10-11T13:22:00Z', review: 'Pending review' },
  { key: 'TR-005', tc: 'TC-002', tcVersion: 2, runType: 'Formal', source: 'CI', result: 'Passed', sha: SHA_DRIFT, by: PEOPLE.ci, at: '2026-10-11T13:22:00Z', review: 'Blocked: script drift', drift: true },
  { key: 'TR-006', tc: 'TC-003', tcVersion: 1, runType: 'Formal', source: 'CI', result: 'Passed', sha: SHA_V2, by: PEOPLE.ci, at: '2026-10-11T13:22:00Z', review: `Reviewed by ${PEOPLE.qa}` },
  { key: 'TR-007', tc: 'TC-004', tcVersion: 1, runType: 'Formal', source: 'Manual', result: 'Failed', by: PEOPLE.david, at: '2026-10-11T10:02:00Z', review: `Reviewed by ${PEOPLE.qa}`, failedStep: 4 },
  { key: 'TR-008', tc: 'TC-005', tcVersion: 1, runType: 'Formal', source: 'CI', result: 'Passed', sha: SHA_V2, by: PEOPLE.ci, at: '2026-10-11T13:22:00Z', review: `Reviewed by ${PEOPLE.qa}` },
].map((tr) => ({
  ...tr,
  tracker: 'TR',
  title: `${tr.tc} ${tr.runType.toLowerCase()} (${tr.source})`,
  folder: tr.runType,
  state: tr.review.startsWith('Reviewed') ? 'Complete' : tr.review === 'Not required' ? 'Complete' : 'Pending review',
  version: 1,
  fields: {
    'Test case': `${tr.tc} (version ${tr.tcVersion})`,
    'Run type': tr.runType,
    Source: tr.source,
    Result: tr.result,
    'Commit SHA': tr.sha ?? '—',
    'Executed by': tr.by,
    Review: tr.review,
  },
  links: [{ type: 'executes', to: tr.tc }],
}))

const sdsItems = [
  { key: 'SDS-001', title: 'Audit trail written by database triggers', folder: 'Architecture', state: 'Approved', links: [{ type: 'implements', to: 'SRS-030' }, { type: 'implements', to: 'SRS-031' }], fields: { Design: 'A generic trigger on every table writes old and new values to an insert-only audit_log table. UPDATE, DELETE and TRUNCATE on audit_log are rejected by a trigger for every role, including the owner.' } },
  { key: 'SDS-002', title: 'Membership-based Row Level Security', folder: 'Architecture', state: 'Approved', links: [{ type: 'implements', to: 'SRS-004' }, { type: 'implements', to: 'SRS-006' }], fields: { Design: 'Every table has RLS enabled. Policies call is_project_member() and can_modify_project(), which read project_members and role_permissions for the signed-in user.' } },
  { key: 'SDS-003', title: 'Automated results API', folder: 'Automation', state: 'Draft', links: [{ type: 'implements', to: 'SRS-039' }, { type: 'implements', to: 'SRS-040' }], fields: { Design: 'A Supabase Edge Function receives Playwright results with a per-project API key, matches each @TC tag to a test case and creates TR items.' } },
].map((s) => ({ ...s, tracker: 'SDS', version: 1 }))

const devItems = [
  {
    key: 'DEV-001',
    tracker: 'DEV',
    title: 'Activity time shown in the wrong time zone',
    folder: 'Open',
    state: 'Investigating',
    version: 1,
    fields: {
      Description: 'TC-004 step 4 (sample): on a test laptop set to UTC+1, the Activity entry showed the time without converting to the local time zone.',
      Impact: 'Reviewers could misread the order of events; the stored UTC timestamp is correct.',
      'Root cause': 'Under investigation.',
      Resolution: '—',
    },
    links: [
      { type: 'raised by', to: 'TR-007' },
      { type: 'affects', to: 'TC-004' },
      { type: 'affects', to: 'SRS-011' },
      { type: 'affects', to: 'SRS-033' },
    ],
  },
]

export const ITEMS = [...srsItems, ...sdsItems, ...riskItems, ...tcItems, ...trItems, ...devItems]

export const SIGNATURES = {
  'SRS-001': [{ by: PEOPLE.david, meaning: 'Authored', at: '2026-10-11T12:30:00Z', version: 2 }, { by: PEOPLE.qa, meaning: 'Approved', at: '2026-10-11T14:05:00Z', version: 2 }],
  'TC-001': [
    { by: PEOPLE.david, meaning: 'Authored', at: '2026-10-09T13:00:00Z', version: 1, superseded: true },
    { by: PEOPLE.qa, meaning: 'Approved', at: '2026-10-09T15:50:00Z', version: 1, superseded: true },
    { by: PEOPLE.david, meaning: 'Authored', at: '2026-10-10T15:30:00Z', version: 2 },
    { by: PEOPLE.qa, meaning: 'Approved', at: '2026-10-10T15:58:00Z', version: 2 },
  ],
  'TC-004': [{ by: PEOPLE.david, meaning: 'Authored', at: '2026-10-10T09:00:00Z', version: 1 }, { by: PEOPLE.qa, meaning: 'Approved', at: '2026-10-10T11:20:00Z', version: 1 }],
}

export function itemPath(projectId, key) {
  const item = ITEMS.find((i) => i.key === key)
  return item ? `/projects/${projectId}/trackers/${item.tracker}/${key}` : '#'
}

export function getItem(key) {
  return ITEMS.find((i) => i.key === key)
}

export function itemsFor(trackerKey) {
  return ITEMS.filter((i) => i.tracker === trackerKey)
}

export function runsFor(tcKey) {
  return trItems.filter((r) => r.tc === tcKey)
}

// Links pointing at this item from other items (shown as "linked from").
export function backlinks(key) {
  return ITEMS.flatMap((i) => i.links.filter((l) => l.to === key).map((l) => ({ type: l.type, from: i.key })))
}

// Latest formal run per linked test case, for the coverage panel on SRS items.
export function coverageFor(srsKey) {
  const tcs = tcItems.filter((tc) => tc.links.some((l) => l.to === srsKey))
  return tcs.map((tc) => {
    const formal = runsFor(tc.key).filter((r) => r.runType === 'Formal')
    return { tc, latest: formal[formal.length - 1] ?? null }
  })
}

export const NEXT_RUN_KEY = 'TR-009'
