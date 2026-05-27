//! `OpenCodeMod` — emits tab type changes when `ProcessInspectorMod` detects
//! or loses an `opencode` process.
//!
//! Mirrors `ClaudeCodeMod` and `CodexMod`. Display name flows on the event
//! so consumers (badges, notifications, status bar widgets) read it from
//! `TabMeta.agentDisplayName` rather than maintaining their own
//! `agent_id → display_name` lookup. Adding a new agent means one entry in
//! `AGENT_HOOK_CONFIGS` and nothing else.
//!
//! Emits:
//! - `tab_type_changed` `{ type: "agent", agent_id, display_name, cmd }` on detection
//! - `tab_type_changed` `{ type: "shell" }` on process exit

use crate::hook_config::config_for_agent_id;
use crate::mod_engine::{Mod, ModContext};

pub struct OpenCodeMod;

const AGENT_ID: &str = "open-code";

impl OpenCodeMod {
    pub fn new() -> Self {
        Self
    }
}

impl Mod for OpenCodeMod {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn on_agent_detected(&mut self, agent: &str, _cwd: &str, cmd: &str, ctx: &ModContext) {
        if agent != "open-code" {
            return;
        }
        let display_name = config_for_agent_id(AGENT_ID)
            .map(|c| c.agent_name)
            .unwrap_or("OpenCode");
        ctx.emit(
            "opencode",
            "tab_type_changed",
            serde_json::json!({
                "type": "agent",
                "agent_id": AGENT_ID,
                "display_name": display_name,
                "cmd": cmd,
            }),
        );
    }

    fn on_agent_cleared(&mut self, agent: &str, ctx: &ModContext) {
        if agent != "open-code" {
            return;
        }
        ctx.emit(
            "opencode",
            "tab_type_changed",
            serde_json::json!({ "type": "shell" }),
        );
    }
}