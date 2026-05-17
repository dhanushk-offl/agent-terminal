import { atom } from 'nanostores'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'theme'

export const $theme = atom<Theme>('system')

export function initThemeFromStorage() {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') {
      $theme.set(v)
    }
  } catch {
    // ignore
  }
}

export function setTheme(t: Theme) {
  try {
    if (t === 'system') {
      localStorage.removeItem(KEY)
    } else {
      localStorage.setItem(KEY, t)
    }
  } catch {
    // ignore
  }
  $theme.set(t)
}

export function applyThemeToDocument(t: Theme) {
  const html = document.documentElement
  if (t === 'system') {
    html.removeAttribute('data-theme')
  } else {
    html.setAttribute('data-theme', t)
  }
}
