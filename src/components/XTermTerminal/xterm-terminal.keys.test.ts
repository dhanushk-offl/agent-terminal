import { describe, expect, test } from 'bun:test'
import { handleKeyEvent } from '@/components/XTermTerminal/xterm-terminal.keys'

function keyEvent(
  patch: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'key'>,
): KeyboardEvent {
  return {
    altKey: false,
    code: '',
    ctrlKey: false,
    key: patch.key,
    metaKey: false,
    shiftKey: false,
    type: 'keydown',
    ...patch,
  } as KeyboardEvent
}

describe('handleKeyEvent', () => {
  test('lets Linux primary quick switcher shortcut bubble to the app layer', () => {
    let writes = 0
    const handledByXterm = handleKeyEvent(
      keyEvent({ ctrlKey: true, code: 'KeyP', key: 'p' }),
      { isAgent: false, onData: () => writes++ },
    )

    expect(handledByXterm).toBe(false)
    expect(writes).toBe(0)
  })

  test('keeps terminal-owned ctrl chords in xterm', () => {
    const handledByXterm = handleKeyEvent(
      keyEvent({ ctrlKey: true, code: 'KeyC', key: 'c' }),
      { isAgent: false, onData: () => {} },
    )

    expect(handledByXterm).toBe(true)
  })
})
