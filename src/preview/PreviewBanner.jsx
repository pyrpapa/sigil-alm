export default function PreviewBanner({ children }) {
  return (
    <p className="preview-banner" role="note">
      <strong>Preview</strong> with sample data. Nothing here is saved.{' '}
      {children ?? 'Real trackers and items arrive in Phase 2d. SRS and RISK items come from docs/validation.'}
    </p>
  )
}
