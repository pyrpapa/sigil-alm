import { useState } from 'react'
import { THEMES, getTheme, setTheme } from '../lib/theme'

// Light, dark, or follow the computer's setting. Shown on the account page.
export default function ThemeSwitch() {
  const [theme, setChoice] = useState(getTheme)
  return (
    <label>
      Theme
      <select
        value={theme}
        onChange={(e) => {
          setTheme(e.target.value)
          setChoice(e.target.value)
        }}
      >
        {THEMES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  )
}
