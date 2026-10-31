// Light / Dark / System. The choice is a per-browser convenience, kept in localStorage;
// "system" (the default) follows the computer's setting. index.html applies the saved
// choice before the page draws, so there is no flash of the wrong theme.
const KEY = 'sigil-theme'

export const THEMES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
]

export function getTheme() {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function setTheme(value) {
  const root = document.documentElement
  if (value === 'light' || value === 'dark') root.dataset.theme = value
  else delete root.dataset.theme
  try {
    if (value === 'light' || value === 'dark') localStorage.setItem(KEY, value)
    else localStorage.removeItem(KEY)
  } catch {
    // Storage blocked (private window): the choice lasts until the page is reloaded.
  }
}
