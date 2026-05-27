import { describe, expect, test } from 'bun:test'
import { parseModelFlag } from '@/components/agent.helpers'

describe('parseModelFlag', () => {
  test('parses space-separated long model flag', () => {
    expect(parseModelFlag('opencode --model gpt-4-medium')).toBe('gpt-4-medium')
  })

  test('parses equals long model flag', () => {
    expect(parseModelFlag('opencode --model=gpt-4-medium')).toBe('gpt-4-medium')
  })

  test('parses short model flag', () => {
    expect(parseModelFlag('opencode -m gpt-4-medium')).toBe('gpt-4-medium')
  })
})
