import { atom } from 'nanostores'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'theme'

export const $theme = atom<Theme>('system')

export function initThemeFromStorage() {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') {
      $theme.set(v)
      applyThemeToDocument(v)
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
  applyThemeToDocument(t)
}

export function applyThemeToDocument(t: Theme) {
  if (typeof document === 'undefined') return
  const html = document.documentElement
  if (t === 'system') {
    html.removeAttribute('data-theme')
  } else {
    html.setAttribute('data-theme', t)
  }
  window.dispatchEvent(new Event('themechange'))
}

export function getEffectiveTheme(t: Theme): 'light' | 'dark' {
  if (t === 'dark' || t === 'light') return t
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}
