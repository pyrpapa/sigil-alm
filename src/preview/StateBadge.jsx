const TONES = {
  Approved: 'good',
  Complete: 'good',
  Passed: 'good',
  Recorded: 'good',
  'In Review': 'warn',
  'Pending review': 'warn',
  Investigating: 'warn',
  Failed: 'bad',
  'Blocked: script drift': 'bad',
  Covered: 'good',
  'Not covered': 'bad',
  High: 'bad',
  Medium: 'warn',
  Low: 'neutral',
  'Formal run': 'good',
  'Dry run': 'warn',
}

export default function StateBadge({ value }) {
  const tone = TONES[value] ?? (String(value).startsWith('Reviewed') ? 'good' : 'neutral')
  return <span className={`badge badge-${tone}`}>{value}</span>
}
