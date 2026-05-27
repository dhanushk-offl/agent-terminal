import { listen } from '@tauri-apps/api/event'
import {
  type AgentTurnState,
  clearTabMeta,
  type GitInfo,
  type ProcessInfo,
  type TabStatus,
  type TabType,
  updateTabMeta,
} from '@/modules/stores/$tabMeta'

/* ---------------------------------------------------------------------------
 * done-linger timers
 *
 * When status flips to 'done' we stamp `doneAt` in the store and schedule a
 * single per-tab timer that clears it after 10s. Every TabStatusIcon then
 * derives its visual from `doneAt` directly, so the sidebar and the Cmd+P
 * palette can never disagree on whether the green dot is lit (the previous
 * per-instance setTimeout was the source of the bug).
 * -------------------------------------------------------------------------*/

const DONE_LINGER_MS = 10_000
const doneLingerTimers = new Map<string, ReturnType<typeof setTimeout>>()

function cancelDoneLinger(tabId: string): void {
  const t = doneLingerTimers.get(tabId)
  if (t) {
    clearTimeout(t)
    doneLingerTimers.delete(tabId)
  }
}

function scheduleDoneLinger(tabId: string): void {
  cancelDoneLinger(tabId)
  const t = setTimeout(() => {
    doneLingerTimers.delete(tabId)
    updateTabMeta(tabId, { doneAt: undefined })
  }, DONE_LINGER_MS)
  doneLingerTimers.set(tabId, t)
}

type ModEventPayload = {
  tabId: string
  modId: string
  event: string
  data: unknown
}

/* ---------------------------------------------------------------------------
 * Agent done-linger timers
 *
 * When an agent transitions to 'completed' we schedule an auto-clear timer
 * that transitions the badge back to 'idle'. Without this the green checkmark
 * would persist forever (agent sessions don't self-clear like shell tabs).
 *
 * Two things clear the timer:
 *   1. The timer itself fires (30s for agents — they're slower than shells)
 *   2. The user navigates to the tab (acknowledges the result immediately)
 *
 * This mirrors the shell-tab doneAt timer but for the agent lifecycle.
 * -------------------------------------------------------------------------*/

const AGENT_DONE_LINGER_MS = 30_000
const agentLingerTimers = new Map<string, ReturnType<typeof setTimeout>>()

function cancelAgentLinger(tabId: string): void {
  const t = agentLingerTimers.get(tabId)
  if (t) {
    clearTimeout(t)
    agentLingerTimers.delete(tabId)
  }
}

/**
 * Starts listening for `mod:event` events from the Rust MOD engine and
 * dispatches them into `$tabMeta`. Call once during app bootstrap, before render.
 *
 * Returns an unlisten function — call it to stop listening (e.g. in tests).
 */
export async function startModListener(): Promise<() => void> {
  return listen<ModEventPayload>('mod:event', (e) => {
    dispatch(e.payload)
  })
}

function handleTabTypeChanged(tabId: string, data: unknown): void {
  const {
    type,
    agent_id: agentId,
    display_name: agentDisplayName,
    cmd,
    model,
  } = data as {
    type: TabType
    agent_id?: string
    display_name?: string
    cmd?: string
    model?: string | null
  }
  if (type === 'shell') {
    updateTabMeta(tabId, {
      type,
      agentId: undefined,
      agentDisplayName: undefined,
      agentCmd: undefined,
      // Clear hook-driven state when the agent process exits.
      agentState: undefined,
      agentMessage: undefined,
      agentModel: undefined,
    })
  } else {
    // agentDisplayName comes from the per-agent mod (which sources it
    // from AGENT_HOOK_CONFIGS). We never look it up consumer-side —
    // adding a new agent must work with zero changes here.
    updateTabMeta(tabId, {
      type,
      agentId,
      agentDisplayName,
      agentCmd: cmd,
      agentModel: model ?? undefined,
    })
  }
}

function handleProcessInfo(
  tabId: string,
  data: { processes: ProcessInfo[] },
): void {
  const { processes } = data
  const ports = processes.flatMap((p) => p.listeningPorts ?? [])
  const patch: Partial<import('@/modules/stores/$tabMeta').TabMeta> = {
    processes,
    listeningPorts: [...new Set(ports)],
  }
  const agentProc = processes.find(
    (p) =>
      p.name === 'claude-code' || p.name === 'codex' || p.name === 'open-code',
  )
  if (agentProc) {
    patch.agentCmd = agentProc.command
    patch.agentDisplayName =
      agentProc.name === 'claude-code'
        ? 'Claude Code'
        : agentProc.name === 'codex'
          ? 'Codex CLI'
          : agentProc.name === 'open-code'
            ? 'OpenCode'
            : agentProc.name
  }
  updateTabMeta(tabId, patch)
}

function dispatch({
  tabId,
  modId: _modId,
  event,
  data,
}: ModEventPayload): void {
  // Guard against malformed payloads — Rust controls the emitter, but a
  // bad payload should never crash the global listener.
  if (data !== null && data !== undefined && typeof data !== 'object') return
  switch (event) {
    case 'status_changed': {
      const { status, exitCode } = data as {
        status: TabStatus
        exitCode?: number
      }
      if (status === 'done') {
        updateTabMeta(tabId, { status, exitCode, doneAt: Date.now() })
        scheduleDoneLinger(tabId)
      } else {
        // Any other transition (running, error, idle) cancels the linger
        // and clears the timestamp so the dot reflects the new status.
        cancelDoneLinger(tabId)
        updateTabMeta(tabId, { status, exitCode, doneAt: undefined })
      }
      break
    }
    case 'tab_type_changed':
      handleTabTypeChanged(tabId, data)
      break
    case 'cwd_changed': {
      const { cwd } = data as { cwd: string }
      updateTabMeta(tabId, { cwd })
      break
    }
    case 'git_info': {
      updateTabMeta(tabId, { git: (data as GitInfo) ?? undefined })
      break
    }
    case 'process_info':
      handleProcessInfo(tabId, data as { processes: ProcessInfo[] })
      break
    case 'listening_ports': {
      const { ports } = data as { ports: number[] }
      updateTabMeta(tabId, { listeningPorts: ports })
      break
    }
    case 'agent_state_changed': {
      const { state, message } = data as {
        state: AgentTurnState
        message?: string
      }
      cancelAgentLinger(tabId)

      if (state === 'completed') {
        updateTabMeta(tabId, { agentState: state, agentMessage: message })
        // Auto-clear the completed badge after 30s so it doesn't persist forever.
        // Shell tabs have `doneAt` with a 10s timeout; agents need longer
        // because their turns are more significant (users should notice them).
        const t = setTimeout(() => {
          agentLingerTimers.delete(tabId)
          updateTabMeta(tabId, { agentState: 'idle', agentMessage: undefined })
        }, AGENT_DONE_LINGER_MS)
        agentLingerTimers.set(tabId, t)
      } else if (state === 'idle') {
        // Idle clears transient turn UI, but the active model can remain valid
        // across OpenCode's busy/idle status stream. Process exit clears it in
        // `tab_type_changed` when the tab returns to shell.
        updateTabMeta(tabId, {
          agentState: 'idle',
          agentMessage: undefined,
        })
      } else {
        // in-progress / awaiting — clear any lingering completed state.
        updateTabMeta(tabId, { agentState: state, agentMessage: message })
      }
      break
    }
    case 'model_changed': {
      const { model } = data as { model: string }
      updateTabMeta(tabId, { agentModel: model })
      break
    }
    case 'closed': {
      // EchoMod fires this — used to GC stale tabMeta entries on tab close.
      cancelDoneLinger(tabId)
      cancelAgentLinger(tabId)
      clearTabMeta(tabId)
      break
    }
  }
}
