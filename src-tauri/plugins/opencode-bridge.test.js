import { describe, expect, test } from 'bun:test'
import AgentTerminalBridge from './opencode-bridge.js'

async function capturePosts(event) {
  const oldFetch = globalThis.fetch
  // biome-ignore lint/style/noProcessEnv: Tests simulate the PTY env consumed by the OpenCode plugin.
  const env = process.env
  const oldTabId = env.AGENT_TERMINAL_TAB_ID
  const oldPort = env.AGENT_TERMINAL_HOOK_PORT
  const posts = []

  env.AGENT_TERMINAL_TAB_ID = 'tab-opencode'
  env.AGENT_TERMINAL_HOOK_PORT = '49999'
  globalThis.fetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) })
    return new Response(null, { status: 200 })
  }

  try {
    const plugin = await AgentTerminalBridge()
    await plugin.event({ event })
    return posts
  } finally {
    globalThis.fetch = oldFetch
    if (oldTabId === undefined) {
      delete env.AGENT_TERMINAL_TAB_ID
    } else {
      env.AGENT_TERMINAL_TAB_ID = oldTabId
    }
    if (oldPort === undefined) {
      delete env.AGENT_TERMINAL_HOOK_PORT
    } else {
      env.AGENT_TERMINAL_HOOK_PORT = oldPort
    }
  }
}

describe('OpenCode bridge', () => {
  test('forwards model from session.updated properties.info', async () => {
    const posts = await capturePosts({
      type: 'session.updated',
      properties: {
        info: {
          id: 'session-1',
          modelID: 'gpt-4-medium',
        },
      },
    })

    expect(posts).toHaveLength(1)
    expect(posts[0].body).toMatchObject({
      agent: 'open-code',
      event: 'ModelChanged',
      model: 'gpt-4-medium',
      session_id: 'session-1',
      tab_id: 'tab-opencode',
    })
  })

  test('forwards model from session.status payloads', async () => {
    const posts = await capturePosts({
      type: 'session.status',
      properties: {
        sessionID: 'session-2',
        status: {
          type: 'busy',
          modelID: 'claude-sonnet-4-5',
        },
      },
    })

    expect(posts).toHaveLength(1)
    expect(posts[0].body).toMatchObject({
      event: 'UserPromptSubmit',
      model: 'claude-sonnet-4-5',
      session_id: 'session-2',
    })
  })
})
