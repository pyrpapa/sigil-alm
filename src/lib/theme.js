// Dark / Light / System. Dark is the default until a person picks something else on their
// account page. The choice is a per-browser convenience, kept in localStorage; "system"
// follows the computer's setting. index.html applies it before the page draws, so there is
// no flash of the wrong theme.
const KEY = 'sigil-theme'
export const DEFAULT_THEME = 'dark'

export const THEMES = [
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['system', 'System'],
]

const valid = (value) => value === 'light' || value === 'dark' || value === 'system'

export function getTheme() {
  try {
    const value = localStorage.getItem(KEY)
    return valid(value) ? value : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

export function setTheme(value) {
  const root = document.documentElement
  if (value === 'light' || value === 'dark') root.dataset.theme = value
  else delete root.dataset.theme
  try {
    localStorage.setItem(KEY, valid(value) ? value : DEFAULT_THEME)
  } catch {
    // Storage blocked (private window): the choice lasts until the page is reloaded.
  }
}
