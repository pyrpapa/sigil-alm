// Display names for values stored in the database.

export const ROLE_LABELS = {
  admin: 'Admin',
  specialist: 'Specialist',
  associate: 'Associate',
  qa: 'QA',
  viewer: 'Viewer',
}

export const ROLES = Object.keys(ROLE_LABELS)

// Roles that can be required to sign a review gate (not Viewer).
export const REVIEW_ROLES = ['qa', 'specialist', 'associate', 'admin']

export const REVIEW_MEANINGS = ['Approved', 'Reviewed', 'Verified', 'Executed']

export const FIELD_TYPE_LABELS = {
  text: 'Short text',
  long_text: 'Long text',
  number: 'Number',
  date: 'Date',
  select: 'Dropdown',
  user: 'Project member',
  steps: 'Test steps',
}

export const ACTION_LABELS = {
  set_value: 'Set to a value',
  set_today: "Set to today's date",
  set_current_user: 'Set to the current user',
  clear: 'Clear the field',
}

export const STATUS_LABELS = {
  planning: 'Planning',
  active: 'Active',
  complete: 'Complete',
  archived: 'Archived',
}

export const FIELD_LABELS = {
  name: 'Name',
  system_under_validation: 'System under validation',
  planned_start: 'Planned start',
  planned_end: 'Planned end',
  status: 'Status',
  role: 'Role',
  full_name: 'Printed name',
  is_system_admin: 'System Admin',
  repository_url: 'Repository',
}

// Calendar dates (no time of day): format without shifting time zones.
export function formatDate(value) {
  if (!value) return null
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// Timestamps are stored in UTC and shown in the viewer's local time with the zone (SRS-033).
export function formatTimestamp(value) {
  if (!value) return ''
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  })
}
