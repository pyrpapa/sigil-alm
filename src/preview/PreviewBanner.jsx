export default function PreviewBanner({ children }) {
  return (
    <p className="preview-banner" role="note">
      <strong>Preview</strong> with sample data. Nothing here is saved.{' '}
      {children ?? 'Real test execution arrives in Phase 3.'}
    </p>
  )
}
