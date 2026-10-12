import { Link, useParams } from 'react-router-dom'
import PreviewBanner from './PreviewBanner'
import { itemsFor } from './sampleData'

// Entry point for the test execution preview (sample data, nothing saved).
export default function PreviewRuns() {
  const { projectId } = useParams()
  const manual = itemsFor('TC').filter((tc) => tc.executionType === 'Manual')
  return (
    <div className="stack">
      <PreviewBanner>Sample test cases; runs are not saved. Real test execution arrives in Phase 3.</PreviewBanner>
      <h2>Test run preview</h2>
      <p className="muted small">
        Try the manual test run screen: record actual results, pass or fail each step, attach evidence, open a deviation on a failure, and sign as
        executor.
      </p>
      <ul className="link-list">
        {manual.map((tc) => (
          <li key={tc.key}>
            <Link to={`/projects/${projectId}/preview/${tc.key}`}>
              <span className="prefix">{tc.key}</span> {tc.title}
            </Link>{' '}
            <span className="muted small">{tc.steps.length} steps</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
