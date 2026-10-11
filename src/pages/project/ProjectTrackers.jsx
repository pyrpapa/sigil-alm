import { Link } from 'react-router-dom'
import PreviewBanner from '../../preview/PreviewBanner'
import { itemsFor, TRACKERS } from '../../preview/sampleData'

export default function ProjectTrackers() {
  return (
    <div className="stack">
      <PreviewBanner />
      <ul className="tracker-grid" aria-label="Trackers">
        {TRACKERS.map((t) => {
          const items = itemsFor(t.key)
          return (
            <li key={t.key}>
              <Link to={t.key} className="card tracker-card">
                <div className="tracker-card-head">
                  <span className="prefix">{t.key}</span>
                  <span className="muted small">{items.length} items</span>
                </div>
                <strong>{t.name}</strong>
                <span className="muted small">{t.description}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
