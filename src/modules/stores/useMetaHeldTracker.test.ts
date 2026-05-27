import { describe, expect, test } from 'bun:test'
import { Mod } from '@/modules/keymap/keys'
import { isPrimaryModifierKey } from '@/modules/stores/useMetaHeldTracker'

describe('isPrimaryModifierKey', () => {
  test('uses Meta for macOS primary shortcuts', () => {
    expect(isPrimaryModifierKey({ key: 'Meta' }, Mod.Meta)).toBe(true)
    expect(isPrimaryModifierKey({ key: 'Control' }, Mod.Meta)).toBe(false)
  })

  test('uses Control for Linux and Windows primary shortcuts', () => {
    expect(isPrimaryModifierKey({ key: 'Control' }, Mod.Ctrl)).toBe(true)
    expect(isPrimaryModifierKey({ key: 'Meta' }, Mod.Ctrl)).toBe(false)
  })
})
