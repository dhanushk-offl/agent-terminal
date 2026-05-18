import { atom } from 'nanostores'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'agent-terminal:theme'
const LEGACY_KEY = 'theme'

export const $theme = atom<Theme>('system')

function resolveSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function migrateLegacyKey() {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy === 'light' || legacy === 'dark') {
      if (localStorage.getItem(KEY) === null) {
        localStorage.setItem(KEY, legacy)
      }
      localStorage.removeItem(LEGACY_KEY)
    }
  } catch {}
}

export function initThemeFromStorage() {
  migrateLegacyKey()
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') {
      $theme.set(v)
    }
  } catch {}
  applyThemeToDocument($theme.get())
}

export function setTheme(t: Theme) {
  try {
    if (t === 'system') {
      localStorage.removeItem(KEY)
    } else {
      localStorage.setItem(KEY, t)
    }
  } catch {}
  $theme.set(t)
  applyThemeToDocument(t)
}

export function applyThemeToDocument(t: Theme) {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  const resolved = t === 'system' ? resolveSystemTheme() : t
  html.setAttribute('data-theme', resolved)
}

export function getEffectiveTheme(t: Theme): 'light' | 'dark' {
  if (t === 'dark' || t === 'light') return t
  if (typeof window === 'undefined') return 'light'
  return resolveSystemTheme()
}

if (typeof window !== 'undefined') {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if ($theme.get() === 'system') {
        applyThemeToDocument('system')
      }
    })
}
