// The Sigil wordmark: the name in Space Grotesk (as outlines, so it needs no font), with a
// hollow ring over the first i (not run yet) and a green check over the second (passed).
// Letters and ring use the current text colour; the check uses --logo-green / --logo-check,
// so the mark follows the light and dark themes.
// compact: for the top bar and other small sizes, where the check becomes a plain dot.
const WORD =
  'M30.90 101.40Q22.80 101.40 16.60 98.50Q10.40 95.60 6.90 90.20Q3.40 84.80 3.40 77.20L3.40 74.40L16.40 74.40L16.40 77.20Q16.40 83.50 20.30 86.65Q24.20 89.80 30.90 89.80Q37.70 89.80 41.05 87.10Q44.40 84.40 44.40 80.20Q44.40 77.30 42.75 75.50Q41.10 73.70 37.95 72.55Q34.80 71.40 30.30 70.40L28 69.90Q20.80 68.30 15.65 65.85Q10.50 63.40 7.75 59.40Q5 55.40 5 49Q5 42.60 8.05 38.05Q11.10 33.50 16.65 31.05Q22.20 28.60 29.70 28.60Q37.20 28.60 43.05 31.15Q48.90 33.70 52.25 38.75Q55.60 43.80 55.60 51.40L55.60 54.40L42.60 54.40L42.60 51.40Q42.60 47.40 41.05 44.95Q39.50 42.50 36.60 41.35Q33.70 40.20 29.70 40.20Q23.70 40.20 20.85 42.45Q18 44.70 18 48.60Q18 51.20 19.35 53Q20.70 54.80 23.40 56Q26.10 57.20 30.30 58.10L32.60 58.60Q40.10 60.20 45.65 62.70Q51.20 65.20 54.30 69.30Q57.40 73.40 57.40 79.80Q57.40 86.20 54.15 91.05Q50.90 95.90 44.95 98.65Q39 101.40 30.90 101.40 M78.20 100L65.60 100L65.60 50.40L78.20 50.40 M87.80 75.40L87.80 73.80Q87.80 66 90.90 60.45Q94 54.90 99.15 51.95Q104.30 49 110.40 49Q117.20 49 120.70 51.40Q124.20 53.80 125.80 56.40L127.60 56.40L127.60 50.40L140 50.40L140 108.80Q140 113.90 137 116.95Q134 120 129 120L95.80 120L95.80 109L124.60 109Q127.40 109 127.40 106L127.40 93.10L125.60 93.10Q124.60 94.70 122.80 96.35Q121 98 118 99.10Q115 100.20 110.40 100.20Q104.30 100.20 99.15 97.25Q94 94.30 90.90 88.75Q87.80 83.20 87.80 75.40M114 89.20Q119.80 89.20 123.70 85.50Q127.60 81.80 127.60 75.10L127.60 74.10Q127.60 67.30 123.75 63.65Q119.90 60 114 60Q108.20 60 104.30 63.65Q100.40 67.30 100.40 74.10L100.40 75.10Q100.40 81.80 104.30 85.50Q108.20 89.20 114 89.20 M164.60 100L152 100L152 50.40L164.60 50.40 M189.20 100L176.60 100L176.60 30L189.20 30'

export default function Logo({ height = 28, compact = false, className }) {
  const width = (height * 199) / 104
  return (
    <svg
      className={className}
      viewBox="-1 22 199 104"
      width={width}
      height={height}
      role="img"
      aria-label="Sigil"
      style={{ display: 'block' }}
    >
      <path d={WORD} fill="currentColor" />
      <circle cx="71.9" cy="35.9" r={compact ? 8.4 : 8.2} fill="none" stroke="currentColor" strokeWidth={compact ? 4 : 2.8} />
      <circle cx="158.3" cy="35.9" r="9.5" fill="var(--logo-green)" />
      {!compact && (
        <path
          d="M153.7 36.2l3.2 3.2 6-6.4"
          fill="none"
          stroke="var(--logo-check)"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  )
}
