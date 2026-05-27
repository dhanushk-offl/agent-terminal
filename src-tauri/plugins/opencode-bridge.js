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
 * pty_manager injects AGENT_TERMINAL_HOOK_PORT into every shell environment.
 * This matches the port our hook server actually listens on (47384 for prod,
 * 47385 for dev — see identity.rs HOOK_PORT). Fallback: 47384 (prod) if
 * the env var is not set.
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
   * OpenCode fires events with a `type` field. We normalize these to match
   * the event names that Claude Code and Codex already use, so AgentTurnMod's
   * `normalize_action()` can handle them with a single code path.
   *
   * Both dotted OpenCode types ("session.start") and already-mapped names
   * ("SessionStart") are handled — the latter for forwards compatibility if
   * a future plugin or bridge sends pre-mapped names.
   */
  function mapEvent(event) {
    const type = (event?.type ?? event?.event ?? "").toString()

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

      // ── Agent generating ──────────────────────────────────────────
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
          return [{ ...payloadBase, event: "UserPromptSubmit" }]
        }
        return [] // Unknown status subtype
      }

      // ── Permission requests (the "awaiting" state) ──────────────────
      case "permission.updated": {
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
        return [{ ...payloadBase, event: "UserPromptSubmit" }]

      // ── Message lifecycle ─────────────────────────────────────────────
      case "message.updated": {
        const info = event?.properties?.info ?? event?.info
        if (!info) return []

        const role = (info?.role ?? "").toString()
        if (role === "assistant") {
          const text = firstString(info?.summary?.body, info?.text)
          return [{
            ...payloadBase,
            event: "Notification",
            last_assistant_message: text,
          }]
        }
        return []
      }

      // ── Message parts (streaming text) — skip for state tracking ─────
      case "message.part.updated":
      case "message.removed":
        return []

      // ── Tool execution ────────────────────────────────────────────────
      case "command.execute.before":
      case "tool.execute.before":
        return [{ ...payloadBase, event: "PreToolUse", tool_name: event?.properties?.tool || event?.tool }]

      case "tool.execute.after":
        return [{ ...payloadBase, event: "PostToolUse" }]

      // ── Environment injection — skip entirely ─────────────────────────
      case "shell.env":
        return []

      // ── Session end ──────────────────────────────────────────────────
      case "session.deleted":
        return [{ ...payloadBase, event: "SessionEnd" }]

      // ── Session update ──────────────────────────────────────────────
      case "session.updated":
      case "session.compacted":
        return []

      // ── File/lsp/vcs events — skip ──────────────────────────────────
      case "file.edited":
      case "file.watcher.updated":
      case "lsp.updated":
      case "lsp.client.diagnostics":
      case "vcs.branch.updated":
      case "todo.updated":
        return []

      // ── TUI-specific events — skip ──────────────────────────────────
      case "tui.prompt.append":
      case "tui.command.execute":
      case "tui.toast.show":
        return []

      // ── PTY / server events — skip ──────────────────────────────────
      case "pty.created":
      case "pty.updated":
      case "pty.exited":
      case "pty.deleted":
      case "server.instance.disposed":
      case "server.connected":
        return []

      // ── Installation events — skip ───────────────────────────────────
      case "installation.updated":
      case "installation.update-available":
        return []

      // ── Unknown event type ───────────────────────────────────────────
      default:
        return [{ ...payloadBase, event: type }]
    }
  }

  function extractModel(event) {
    return firstString(
      event?.model,
      event?.activeModel,
      event?.session?.model,
      event?.session?.activeModel,
      event?.data?.model,
      event?.data?.activeModel,
      event?.settings?.model,
    )
  }

  function extractMessage(event) {
    return firstString(
      event?.message,
      event?.prompt,
      event?.reason,
      event?.status,
      event?.state,
      event?.statusMessage,
      event?.description,
      event?.data?.message,
      event?.data?.prompt,
      event?.data?.reason,
    )
  }

  function extractSessionId(event) {
    return firstString(
      event?.sessionID,
      event?.sessionId,
      event?.conversationId,
      event?.session?.id,
      event?.session?.sessionId,
      event?.session?.conversationId,
      event?.id,
    )
  }

  return {
    event: async ({ event }) => {
      const payloads = mapEvent(event)

      for (const payload of payloads) {
        // Remove undefined values so serde deserialization doesn't choke on
        // JSON null vs absent field mismatches.
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