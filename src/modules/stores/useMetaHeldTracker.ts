import { useEffect } from 'react'
import { Mod, type ModName } from '@/modules/keymap/keys'
import { $metaHeld } from '@/modules/stores/$keyboard'

/**
 * Returns true for the physical key that maps to the app's primary modifier:
 * Cmd on macOS, Ctrl elsewhere.
 */
export function isPrimaryModifierKey(
  e: Pick<KeyboardEvent, 'key'>,
  primary: ModName = Mod.Primary,
): boolean {
  return primary === Mod.Meta ? e.key === 'Meta' : e.key === 'Control'
}

/**
 * Mirrors physical primary-modifier state into `$metaHeld` so the sidebar can
 * show project-number badges while the matching project shortcut modifier is
 * held. The blur listener resets the flag if the window loses focus mid-hold,
 * preventing a stuck overlay.
 */
export function useMetaHeldTracker(): void {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isPrimaryModifierKey(e)) $metaHeld.set(true)
    }
    function onKeyUp(e: KeyboardEvent) {
      if (isPrimaryModifierKey(e)) $metaHeld.set(false)
    }
    function onBlur() {
      $metaHeld.set(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}
