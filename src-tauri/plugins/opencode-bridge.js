/**
 * Agent Terminal bridge plugin for OpenCode.
 *
 * OpenCode uses a JavaScript plugin system (not file-based hooks like Claude
 * Code or Codex). This plugin is installed into ~/.config/opencode/plugins/
 * at app startup by the Rust hook_config module. It forwards OpenCode's plugin
 * events to agent-terminal's hook server, mapping event types to the names
 * that AgentTurnMod expects.
 *
 * Event mapping:
 *   OpenCode event type      →  AgentTurnMod event name
 *   ───────────────────────     ──────────────────────
 *   session.start            →  SessionStart
 *   session.end              →  SessionEnd
 *   message.start            →  UserPromptSubmit
 *   message.complete         →  Stop
 *   message.stop             →  Stop
 *   tool.call                →  PreToolUse
 *   tool.result              →  PostToolUse
 *   permission.request       →  PermissionRequest
 *   permission.response      →  PostToolUse
 *   status.awaiting          →  Notification (agent needs user input)
 *   status.idle              →  Stop (agent finished responding)
 *
 * Port selection: matches `identity::HOOK_PORT` — 47384 for prod, 47385 for
 * dev builds. The env var AGENT_TERMINAL_HOOK_PORT overrides when set (used
 * by dev instances). Falls back to 47384 (prod) if neither is available.
 *
 * The AGENT_TERMINAL_TAB_ID env var is injected by pty_manager into every
 * shell it spawns. When OpenCode is running outside agent-terminal, the env
 * var is unset and `tab_id` is omitted from the payload. AgentTurnMod's gate
 * drops the event, preventing cross-terminal noise.
 */

const AgentTerminalBridge = async () => {
  // Prod uses 47384, dev uses 47385 — see identity.rs HOOK_PORT.
  // AGENT_TERMINAL_HOOK_PORT override is for dev instances.
  const port = process.env.AGENT_TERMINAL_HOOK_PORT || "47384"
  const endpoint = `http://127.0.0.1:${port}/hook`

  /** Returns the first non-empty string from the candidates. */
  function firstString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value
    }
    return undefined
  }

  /**
   * Map OpenCode plugin event types to AgentTurnMod event names.
   *
   * OpenCode fires events with a `type` field. We normalize these to match
   * the event names that Claude Code and Codex already use, so AgentTurnMod's
   * `normalize_action()` can handle them with a single code path.
   */
  function mapEventType(event) {
    const type = (event?.type ?? event?.event ?? "").toString()

    const map = {
      "session.start": "SessionStart",
      "session.end": "SessionEnd",
      "message.start": "UserPromptSubmit",
      "message.complete": "Stop",
      "message.stop": "Stop",
      "tool.call": "PreToolUse",
      "tool.result": "PostToolUse",
      "permission.request": "PermissionRequest",
      "permission.response": "PostToolUse",
      "status.awaiting": "Notification",
      "status.idle": "Stop",
    }

    return map[type] ?? type
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
      event?.session_id,
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
      const mappedEvent = mapEventType(event)

      const payload = {
        agent: "open-code",
        event: mappedEvent,
        tab_id: process.env.AGENT_TERMINAL_TAB_ID || undefined,
        session_id: extractSessionId(event),
        cwd: event?.cwd || process.cwd(),
        tool_name: event?.toolName || event?.tool_name || event?.data?.toolName,
        message: extractMessage(event),
        prompt: event?.prompt || event?.data?.prompt,
        model: extractModel(event),
        transcript_path: event?.transcriptPath || event?.session?.transcriptPath,
        last_assistant_message:
          event?.lastAssistantMessage || event?.data?.lastAssistantMessage,
        fully_idle: event?.fullyIdle ?? event?.data?.fullyIdle,
        tool_call: event?.toolCall || event?.data?.toolCall,
      }

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
        // Silently fail — agent-terminal may not be running. The OpenCode
        // TUI must never block on a network request to our hook server.
      }
    },
  }
}

export { AgentTerminalBridge }
export default AgentTerminalBridge