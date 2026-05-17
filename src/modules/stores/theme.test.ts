import { mock } from 'bun:test'

const terminalHandles = new Map<string, { applyAppTheme: () => void }>()

mock.module('@/modules/stores/$activeTerminal', () => ({
  $terminalHandles: {
    get: () => terminalHandles,
  },
}))

import { beforeEach, describe, expect, test } from 'bun:test'
import {
  $theme,
  applyThemeToDocument,
  initThemeFromStorage,
  setTheme,
} from '@/modules/stores/theme'

function installDomStubs() {
  const attributes = new Map<string, string>()
  const docEl = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value)
    },
    removeAttribute: (name: string) => {
      attributes.delete(name)
    },
  } as unknown as HTMLElement

  ;(
    globalThis as typeof globalThis & {
      document: Document
      localStorage: Storage
      window: Window
    }
  ).document = {
    documentElement: docEl,
  } as Document

  ;(
    globalThis as typeof globalThis & {
      localStorage: Storage
    }
  ).localStorage = {
    getItem: (key: string) => attributes.get(`ls:${key}`) ?? null,
    setItem: (key: string, value: string) => {
      attributes.set(`ls:${key}`, value)
    },
    removeItem: (key: string) => {
      attributes.delete(`ls:${key}`)
    },
    clear: () => {
      for (const key of [...attributes.keys()]) {
        if (key.startsWith('ls:')) attributes.delete(key)
      }
    },
    key: () => null,
    length: 0,
  } as Storage

  ;(
    globalThis as typeof globalThis & {
      window: Window
    }
  ).window = {
    matchMedia: () =>
      ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as MediaQueryList,
  } as Window

  return { attributes }
}

beforeEach(() => {
  terminalHandles.clear()
  $theme.set('system')
  installDomStubs()
})

describe('theme store', () => {
  test('setTheme applies the document theme and refreshes all open terminals', () => {
    const handle = { applyAppTheme: mock(() => {}) }
    terminalHandles.set('project:tab', handle)

    setTheme('dark')

    expect($theme.get()).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(handle.applyAppTheme).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('theme')).toBe('dark')
  })

  test('initThemeFromStorage restores the saved theme and refreshes terminals', () => {
    const handle = { applyAppTheme: mock(() => {}) }
    terminalHandles.set('project:tab', handle)
    localStorage.setItem('theme', 'light')

    initThemeFromStorage()

    expect($theme.get()).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(handle.applyAppTheme).toHaveBeenCalledTimes(1)
  })

  test('applyThemeToDocument removes the override for system mode', () => {
    applyThemeToDocument('system')

    expect(document.documentElement.getAttribute('data-theme')).toBeNull()
  })
})
