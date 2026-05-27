/**
 * Agent Terminal bridge plugin for OpenCode.
 *
 * OpenCode uses a JavaScript plugin system (not file-based hooks like Claude
 * Code or Codex). This plugin is installed into ~/.config/opencode/plugins/
 * at app startup by the Rust hook_config module.
 *
 * ── OpenCode Event Types (from @opencode-ai/sdk) ──────────────────────────
 *
 * The plugin receives an `event` object with a `type` field. The critical
 * events for agent state tracking are:
 *
 *   session.status   → { status: { type: "busy"|"idle"|"retry" } }
 *                      busy   = agent is generating (maps to InProgress)
 *                      idle   = agent finished turn  (maps to Completed)
 *                      retry   = agent retrying after error
 *
 *   permission.updated → { id, type, title, sessionID, messageID, callID }
 *                      agent needs user approval (maps to Awaiting)
 *
 *   permission.replied → { sessionID, permissionID, response }
 *                      user responded to approval (maps to InProgress)
 *
 *   session.idle      → { sessionID }
 *                      agent went idle (maps to Idle — session-level heartbeat)
 *
 *   session.created   → { sessionID }
 *                      new session started (maps to SessionStart)
 *
 *   session.deleted   → { sessionID }
 *                      session removed (maps to SessionEnd)
 *
 *   message.updated  → { info: { role, ... } }
 *                      message content changed (extracts last assistant text)
 *
 * The `event` hook function is called for EVERY event type. We map the
 * relevant ones to AgentTurnMod event names and POST them to the hook server.
 * Irrelevant events are silently ignored (no POST, no error).
 *
 * ── Port selection ───────────────────────────────────────────────────────────
 *
 * Prod uses 47384, dev uses 47385 — see identity.rs HOOK_PORT.
 * AGENT_TERMINAL_HOOK_PORT overrides when set (for dev instances).
 * Falls back to 47384 (prod) if neither is available.
 */

const AgentTerminalBridge = async () => {
  const port = process.env.AGENT_TERMINAL_HOOK_PORT || "47384"
  const endpoint = `http://127.0.0.1:${port}/hook`

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value
    }
    return undefined
  }

  /**
   * Map an OpenCode plugin event to one or more AgentTurnMod payloads.
   *
   * Returns an array because a single OpenCode event (e.g. permission.updated)
   * can produce the payload AND a state change. Most events map to a single
   * payload; some are ignored entirely.
   */
  function mapEvent(event) {
    const type = (event?.type ?? "").toString()
    const sessionId = firstString(
      event?.sessionID,
      event?.session_id,
      event?.properties?.sessionID,
    )
    const payloadBase = {
      agent: "open-code",
      tab_id: process.env.AGENT_TERMINAL_TAB_ID || undefined,
      session_id: sessionId,
      cwd: event?.properties?.cwd || event?.cwd || process.cwd(),
    }

    switch (type) {
      // ── Session lifecycle ────────────────────────────────────────────
      case "session.created":
        return [{ ...payloadBase, event: "SessionStart" }]

      case "session.idle":
        // OpenCode fires session.idle when the agent finishes responding.
        // This is our "turn complete" signal — more reliable than message.updated
        // because it only fires when the entire turn is done.
        return [{ ...payloadBase, event: "Stop" }]

      // ── Agent status ─────────────────────────────────────────────────
      case "session.status": {
        const status = event?.properties?.status ?? event?.status
        const statusType = (status?.type ?? "").toString()
        if (statusType === "busy") {
          return [{ ...payloadBase, event: "UserPromptSubmit" }]
        }
        if (statusType === "idle") {
          return [{ ...payloadBase, event: "Stop" }]
        }
        if (statusType === "retry") {
          // Retry means the agent is about to retry — still in progress
          return [{ ...payloadBase, event: "UserPromptSubmit" }]
        }
        return [] // Unknown status subtype
      }

      // ── Permission requests (the "awaiting" state) ──────────────────
      case "permission.updated": {
        // OpenCode fires permission.updated when the agent needs user approval
        // for a tool call (e.g. running a shell command). This is the
        // "awaiting user input" state.
        const title = firstString(
          event?.properties?.title,
          event?.title,
          event?.description,
        )
        const toolName = firstString(
          event?.properties?.toolName,
          event?.properties?.tool_name,
        )
        return [{
          ...payloadBase,
          event: "PermissionRequest",
          tool_name: toolName,
          message: title,
        }]
      }

      case "permission.replied":
        // User responded to a permission request — agent resumes generating.
        return [{ ...payloadBase, event: "UserPromptSubmit" }]

      // ── Message lifecycle ─────────────────────────────────────────────
      case "message.updated": {
        const info = event?.properties?.info ?? event?.info
        if (!info) return []

        const role = (info?.role ?? "").toString()
        // Only care about assistant messages for "complete" content.
        // User messages are handled by session.status/busy.
        if (role === "assistant") {
          const text = firstString(
            info?.summary?.body,
            info?.text,
          )
          return [{
            ...payloadBase,
            event: "Notification",
            last_assistant_message: text,
          }]
        }
        return []
      }

      // ── Message parts (streaming text) ───────────────────────────────
      case "message.part.updated":
        // Streaming part update — we don't need these for state tracking.
        // The UI gets visual feedback from the terminal output directly.
        return []

      // ── Tool execution ────────────────────────────────────────────────
      case "command.execute.before":
      case "tool.execute.before":
        return [{ ...payloadBase, event: "PreToolUse", tool_name: event?.properties?.tool ?? event?.tool }]

      case "tool.execute.after":
        return [{ ...payloadBase, event: "PostToolUse" }]

      // ── Environment ───────────────────────────────────────────────────
      case "shell.env":
        // shell.env is for injecting env vars into agent shells — we use
        // AGENT_TERMINAL_TAB_ID for that (injected by pty_manager). Skip.
        return []

      // ── Session end ──────────────────────────────────────────────────
      case "session.deleted":
        return [{ ...payloadBase, event: "SessionEnd" }]

      // ── Session updated ──────────────────────────────────────────────
      case "session.updated":
        // Title/model changes etc. Not state-relevant for badges.
        return []

      // ── File/lsp/vcs events ──────────────────────────────────────────
      case "file.edited":
      case "file.watcher.updated":
      case "lsp.updated":
      case "lsp.client.diagnostics":
      case "vcs.branch.updated":
      case "todo.updated":
        return []

      // ── TUI-specific events ──────────────────────────────────────────
      case "tui.prompt.append":
      case "tui.command.execute":
      case "tui.toast.show":
        return []

      // ── PTY / server events ──────────────────────────────────────────
      case "pty.created":
      case "pty.updated":
      case "pty.exited":
      case "pty.deleted":
      case "server.instance.disposed":
      case "server.connected":
        return []

      // ── Installation events ───────────────────────────────────────────
      case "installation.updated":
      case "installation.update-available":
        return []

      // ── Compaction ──────────────────────────────────────────────────
      case "session.compacted":
        return []

      // ── Unknown event type ───────────────────────────────────────────
      default:
        // Don't silently drop — forward with the raw type so AgentTurnMod
        // can match it via normalisation if it becomes relevant later.
        return [{ ...payloadBase, event: type }]
    }
  }

  return {
    event: async ({ event }) => {
      const payloads = mapEvent(event)
      for (const payload of payloads) {
        // Remove undefined values so serde deserialization doesn't choke.
        Object.keys(payload).forEach((k) => {
          if (payload[k] === undefined) delete payload[k]
        })

        try {
          await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        } catch {
          // Silently fail — agent-terminal may not be running.
        }
      }
    },
  }
}

export { AgentTerminalBridge }
export default AgentTerminalBridge