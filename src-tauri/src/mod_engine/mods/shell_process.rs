use std::collections::HashMap;

use crate::mod_engine::{AsyncAgentSignaler, Mod, ModContext};
use tokio::sync::watch;

struct InspectorTabState {
    cwd_tx: watch::Sender<Option<String>>,
    handle: tokio::task::JoinHandle<()>,
}

/// Periodically scans for ALL direct children of the tab's shell process and
/// emits `process_info` events, enabling the status bar to show live metrics
/// (name, PID, memory, elapsed time, listening ports) for any running process —
/// not only claude/codex agent sessions.
///
/// Uses `ps -o ppid=` to detect processes by parent PID — correctly scoped to
/// only processes launched FROM this terminal tab.
///
/// Memory and CPU are aggregated across the process subtree (direct child +
/// its children) so launchers like `npx`, `bun run`, and `cargo run` report
/// accurate totals rather than just the wrapper process's footprint.
///
/// Port scanning also covers grandchildren so the actual listening server is
/// detected even when the launcher forks before binding.
///
/// Uses `ps -o args=` for command line args (sysinfo can't read cmd on macOS).
/// Uses `sysinfo` for CPU/memory metrics (fast, no subprocess).
/// Uses `lsof -iTCP` for listening port detection.
///
/// Agent detection (claude/codex) is retained via `diff_agent_pids` so
/// `ClaudeCodeMod` and `CodexMod` continue to work unchanged.
///
/// Scan interval: every 2 seconds while the tab is open.
pub struct ShellProcessMod {
    tabs: HashMap<String, InspectorTabState>,
}

impl ShellProcessMod {
    pub fn new() -> Self {
        Self { tabs: HashMap::new() }
    }
}

impl Mod for ShellProcessMod {
    fn id(&self) -> &'static str {
        "shell_process"
    }

    fn on_open(&mut self, ctx: &ModContext) {
        let shell_pid = ctx.shell_pid;
        let (cwd_tx, cwd_rx) = watch::channel::<Option<String>>(None);
        let emitter = ctx.async_emitter();
        let signaler = ctx.async_agent_signaler();

        let handle = tokio::spawn(async move {
            let mut prev_agents: HashMap<String, (u32, String)> = HashMap::new();
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(2));
            let cwd_rx = cwd_rx;

            loop {
                interval.tick().await;

                let cwd = cwd_rx.borrow().clone();
                let processes = scan_processes(shell_pid).await;

                emitter.emit(
                    "shell_process",
                    "process_info",
                    serde_json::json!({ "processes": processes }),
                );

                // Skip agent diffing until the CWD is known — avoids emitting
                // agent_detected with an empty CWD string on the first scan tick.
                if let Some(ref cwd) = cwd {
                    diff_agent_pids(&processes, &mut prev_agents, cwd, &signaler);
                }
            }
        });

        self.tabs.insert(ctx.tab_id.to_string(), InspectorTabState { cwd_tx, handle });
    }

    fn on_cwd_changed(&mut self, cwd: &str, ctx: &ModContext) {
        if let Some(state) = self.tabs.get(ctx.tab_id) {
            let _ = state.cwd_tx.send(Some(cwd.to_string()));
        }
    }

    fn on_close(&mut self, ctx: &ModContext) {
        if let Some(state) = self.tabs.remove(ctx.tab_id) {
            state.handle.abort();
        }
    }
}

/// Resolve a raw process name to a canonical agent ID.
///
/// On Linux, Node.js-based agents (Codex CLI, Claude Code) report their
/// process name as `node` or `node-mainthread` rather than the agent binary
/// name. This function normalises the name by inspecting the full command
/// string when the process name alone is ambiguous.
///
/// Matching rules:
///   - `"claude-code"` ← name is `"claude"` OR name starts with `"node"` and
///     the command contains evidence of Claude Code (argv[0] basename or a
///     path segment matching `"claude"`).
///   - `"codex"` ← name is `"codex"` OR name starts with `"node"` and the
///     command contains evidence of Codex (argv[0] basename or a path
///     segment matching `"codex"`).
///   - Otherwise returns the original name unchanged (shell processes etc.)
fn resolve_agent_name(name: &str, command: &str) -> String {
    if name == "claude" {
        return "claude-code".to_string();
    }
    if name == "codex" {
        return "codex".to_string();
    }
    if name.starts_with("node") {
        // Node.js wrapper scripts (e.g. /usr/local/bin/codex) exec the JS
        // runtime directly, so argv[0] becomes the node binary path and the
        // actual agent script appears later in the command.  Check argv[0]
        // basename first (handles `/usr/local/bin/codex`), then scan the rest
        // of the command for known agent path segments (handles
        // `/usr/local/bin/node .../codex.js`).
        let exe = command.split_whitespace().next().unwrap_or("");
        let exe_name = exe.rsplit('/').next().unwrap_or(exe);
        let exe_name = exe_name.rsplit('\\').next().unwrap_or(exe_name);
        if exe_name == "codex" {
            return "codex".to_string();
        }
        if exe_name == "claude" {
            return "claude-code".to_string();
        }
        // argv[0] is the node binary itself — check the remaining args for
        // agent script paths like ".../codex.js" or ".../claude/...".
        // We check EVERY path segment (not just the basename) so paths like
        // /usr/local/lib/node_modules/codex/dist/index.js are caught.
        for arg in command.split_whitespace().skip(1) {
            for segment in arg.split(|c: char| c == '/' || c == '\\') {
                if segment == "codex" || segment.starts_with("codex.") {
                    return "codex".to_string();
                }
                if segment == "claude" || segment.starts_with("claude.") {
                    return "claude-code".to_string();
                }
            }
        }
    }
    name.to_string()
}

fn diff_agent_pids(
    processes: &[serde_json::Value],
    prev_agents: &mut HashMap<String, (u32, String)>,
    cwd: &str,
    signaler: &AsyncAgentSignaler,
) {
    let mut current_agents: HashMap<String, (u32, String)> = HashMap::new();
    for proc in processes {
        let raw_name = proc.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let cmd = proc.get("command").and_then(|c| c.as_str()).unwrap_or("");
        let resolved = resolve_agent_name(raw_name, cmd);
        if resolved == "claude-code" || resolved == "codex" {
            if let Some(pid) = proc.get("pid").and_then(|p| p.as_u64()) {
                current_agents.insert(resolved, (pid as u32, cmd.to_string()));
            }
        }
    }

    // Detect clears: agent gone, or PID changed (restart).
    for (agent, (prev_pid, _prev_cmd)) in prev_agents.iter() {
        match current_agents.get(agent) {
            None => signaler.agent_cleared(agent),
            Some((curr_pid, _)) if curr_pid != prev_pid => { signaler.agent_cleared(agent); }
            _ => {}
        }
    }
    // Detect appearances: new agent, PID changed (restart), or command changed.
    for (agent, (curr_pid, cmd)) in &current_agents {
        match prev_agents.get(agent) {
            None => signaler.agent_detected(agent, cwd, cmd),
            Some((prev_pid, _prev_cmd)) if prev_pid != curr_pid => { signaler.agent_detected(agent, cwd, cmd); }
            Some((prev_pid, prev_cmd)) if prev_cmd != cmd => { signaler.agent_detected(agent, cwd, cmd); }
            _ => {}
        }
    }

    *prev_agents = current_agents;
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcessEntry {
    pid: u32,
    command: String,
    name: String,
    cpu_percent: f32,
    memory_kb: u64,
    elapsed_time: String,
    listening_ports: Vec<u16>,
}

/// Scan for all direct children of `shell_pid` that have been running for at
/// least 2 seconds, collecting aggregated metrics across the process subtree.
async fn scan_processes(shell_pid: u32) -> Vec<serde_json::Value> {
    if shell_pid == 0 {
        return Vec::new();
    }

    // Step 1: find all direct children of shell_pid
    let pids = find_children_of_shell(shell_pid).await;
    if pids.is_empty() {
        return Vec::new();
    }

    // Step 2: find grandchildren (launchers like npx, bun, cargo fork the real
    // work). We need them BEFORE getting args so we can fetch commands for the
    // full subtree — on Linux the agent often runs as a grandchild and its
    // command line (containing --model, -m, etc.) is the one we want to show.
    let grandchildren = find_grandchildren(&pids).await;

    // Build full PID list for args lookup (direct children + grandchildren).
    let mut all_pids = pids.clone();
    for (gc, _) in &grandchildren {
        all_pids.push(*gc);
    }
    let args_map = get_process_args(&all_pids).await;

    // Step 3: build the subtree attribution map (pid → root direct-child pid).
    // This single ps scan is shared by both metric aggregation and port scanning
    // so the system is only queried once per poll cycle for grandchildren.
    //
    // Many launchers (npx, bun run, cargo run) fork the real work as a child:
    //   shell → launcher (direct child) → server (grandchild)
    // Without grandchild attribution, memory shows only the launcher's footprint
    // and port scanning misses the server's bound port entirely.
    let mut attribution: HashMap<u32, u32> = pids.iter().map(|&p| (p, p)).collect();
    for (grandchild, parent) in &grandchildren {
        attribution.insert(*grandchild, *parent);
    }

    // Reverse attribution: direct child → its grandchildren. Used to find the
    // actual agent command when the direct child is a wrapper (e.g. npx).
    let mut child_to_grandchildren: HashMap<u32, Vec<u32>> = HashMap::new();
    for (gc, parent) in &grandchildren {
        child_to_grandchildren.entry(*parent).or_default().push(*gc);
    }

    // Step 4: get CPU/memory/elapsed via sysinfo (not Send — spawn_blocking).
    // Memory and CPU are summed across direct child + grandchildren so the
    // status bar reflects the full process tree footprint, not just the wrapper.
    let pids_clone = pids.clone();
    let attribution_clone = attribution.clone();
    let raw = tokio::task::spawn_blocking(move || {
        get_process_metrics(&pids_clone, &attribution_clone)
    })
    .await
    .unwrap_or_default();

    if raw.is_empty() {
        return Vec::new();
    }

    // Step 5: listening ports via lsof TCP, using the pre-built attribution map.
    let metric_pids: Vec<u32> = raw.iter().map(|p| p.0).collect();
    let ports_map = find_listening_ports_per_pid(&metric_pids, &attribution).await;

    raw.into_iter()
        .map(|(pid, name, cpu_percent, memory_kb, elapsed_time)| {
            let mut command = args_map.get(&pid).cloned().unwrap_or_default();
            let listening_ports = ports_map.get(&pid).cloned().unwrap_or_default();
            let resolved_name = resolve_agent_name(&name, &command);

            // On Linux, agents installed via npm/npx run as grandchildren of the
            // shell (e.g. shell → npx → actual-claude). The wrapper's command
            // doesn't include flags like --model. If a grandchild resolves to
            // the same agent, use its command so the status bar shows the real
            // invocation including any model flags.
            if resolved_name == "claude-code" || resolved_name == "codex" {
                if let Some(gcs) = child_to_grandchildren.get(&pid) {
                    for gc_pid in gcs {
                        if let Some(gc_cmd) = args_map.get(gc_pid) {
                            // We pass "node" as the name because on Linux
                            // grandchildren are typically node processes; the
                            // function does a comprehensive command-line search
                            // so it correctly resolves native binaries too.
                            let gc_resolved = resolve_agent_name("node", gc_cmd);
                            if gc_resolved == resolved_name {
                                command = gc_cmd.clone();
                                break;
                            }
                        }
                    }
                }
            }

            serde_json::to_value(ProcessEntry {
                pid,
                command,
                name: resolved_name,
                cpu_percent,
                memory_kb,
                elapsed_time,
                listening_ports,
            })
            .unwrap_or(serde_json::json!(null))
        })
        .collect()
}

/// Find PIDs of all direct children of `shell_pid`.
///
/// Uses `ps -ax -o pid=,ppid=,comm=` — fast (no file I/O), cross-platform
/// (macOS and Linux). Elapsed-time filtering happens in `get_process_metrics`
/// using sysinfo, which avoids any reliance on `ps` keyword availability
/// (`etimes` is Linux-only; macOS `ps` does not support it).
async fn find_children_of_shell(shell_pid: u32) -> Vec<u32> {
    let output = tokio::time::timeout(
        tokio::time::Duration::from_secs(2),
        tokio::process::Command::new("ps")
            .args(["-ax", "-o", "pid=,ppid=,comm="])
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok());

    let Some(output) = output else { return Vec::new() };
    let text = String::from_utf8_lossy(&output.stdout);

    let mut pids = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let pid: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        let ppid: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        // comm consumed but not used — any process name qualifies
        if parts.next().is_none() { continue; }

        if ppid == shell_pid {
            pids.push(pid);
        }
    }
    pids
}

/// Return (grandchild_pid, direct_child_pid) pairs for one level below `pids`.
///
/// One level of expansion covers the common launcher pattern:
///   shell → launcher → server
/// Deeper nesting (great-grandchildren) is not tracked — add another pass here
/// if needed.
async fn find_grandchildren(pids: &[u32]) -> Vec<(u32, u32)> {
    if pids.is_empty() {
        return Vec::new();
    }
    let output = tokio::time::timeout(
        tokio::time::Duration::from_secs(2),
        tokio::process::Command::new("ps")
            .args(["-ax", "-o", "pid=,ppid="])
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok());

    let Some(output) = output else { return Vec::new() };
    let text = String::from_utf8_lossy(&output.stdout);
    let parent_set: std::collections::HashSet<u32> = pids.iter().cloned().collect();

    let mut pairs = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let child: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        let ppid: u32 = match parts.next().and_then(|s| s.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        if parent_set.contains(&ppid) {
            pairs.push((child, ppid));
        }
    }
    pairs
}

/// Get full command + args for specific PIDs via `ps -o args=`.
/// sysinfo's `process.cmd()` always returns empty on macOS without entitlements.
async fn get_process_args(pids: &[u32]) -> HashMap<u32, String> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let pid_list = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
    let output = tokio::time::timeout(
        tokio::time::Duration::from_secs(2),
        tokio::process::Command::new("ps")
            .args(["-p", &pid_list, "-o", "pid=,args="])
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok());

    let Some(output) = output else { return HashMap::new() };
    let text = String::from_utf8_lossy(&output.stdout);

    let mut result = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Some(space) = line.find(char::is_whitespace) {
            if let Ok(pid) = line[..space].trim().parse::<u32>() {
                let cmd = line[space..].trim().to_string();
                result.insert(pid, cmd);
            }
        }
    }
    result
}

/// Read metrics for `direct_pids`, aggregating memory and CPU across the full
/// subtree described by `attribution` (pid → root direct-child pid).
///
/// - **name / elapsed**: taken from the direct child only (the process the user
///   invoked). The launcher's identity is what matters for display.
/// - **memory_kb**: sum of the direct child + all grandchildren. Reflects the
///   true memory footprint of the process tree.
/// - **cpu_percent**: sum across the subtree. May exceed 100% on multi-core
///   systems when the server is CPU-bound, which is accurate and expected.
///
/// Processes where the direct child has been running for less than 2 seconds
/// are excluded to prevent transient commands from flashing in the status bar.
/// (`etimes` is Linux-only; sysinfo start_time is used instead.)
fn get_process_metrics(
    direct_pids: &[u32],
    attribution: &HashMap<u32, u32>,
) -> Vec<(u32, String, f32, u64, String)> {
    use sysinfo::{Pid, ProcessesToUpdate, System};

    // Refresh sysinfo for every PID in the subtree at once.
    let all_pids: Vec<u32> = attribution.keys().cloned().collect();
    let sysinfo_pids: Vec<Pid> = all_pids.iter().map(|&p| Pid::from(p as usize)).collect();
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&sysinfo_pids), true);

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Collect raw per-pid data from sysinfo.
    // (pid, name, cpu_percent, memory_kb, elapsed_secs)
    let raw: HashMap<u32, (String, f32, u64, u64)> = all_pids
        .iter()
        .filter_map(|&pid| {
            let p = sys.process(Pid::from(pid as usize))?;
            let name = p.name().to_string_lossy().to_lowercase();
            let name = name.trim_end_matches('\0').to_string();
            Some((pid, (name, p.cpu_usage(), p.memory() / 1024, now_secs.saturating_sub(p.start_time()))))
        })
        .collect();

    // For each direct child, aggregate subtree memory + CPU.
    direct_pids
        .iter()
        .filter_map(|&root_pid| {
            let (name, _, _, elapsed_secs) = raw.get(&root_pid)?;

            // Skip transient commands — they will likely exit before the next poll.
            if *elapsed_secs < 2 {
                return None;
            }

            let mut total_memory_kb: u64 = 0;
            let mut total_cpu: f32 = 0.0;

            // Sum across every pid attributed to this root (includes grandchildren).
            for (&pid, &root) in attribution {
                if root == root_pid {
                    if let Some((_, cpu, mem, _)) = raw.get(&pid) {
                        total_memory_kb += mem;
                        total_cpu += cpu;
                    }
                }
            }

            let elapsed_time = format_elapsed(*elapsed_secs);
            Some((root_pid, name.clone(), total_cpu, total_memory_kb, elapsed_time))
        })
        .collect()
}

fn format_elapsed(secs: u64) -> String {
    if secs < 3600 {
        format!("{}:{:02}", secs / 60, secs % 60)
    } else if secs < 86400 {
        format!("{}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60)
    } else {
        format!("{}-{:02}:{:02}", secs / 86400, (secs % 86400) / 3600, (secs % 3600) / 60)
    }
}

/// Scan listening TCP ports for `direct_pids` using the pre-built `attribution`
/// map (pid → root direct-child pid) to include grandchildren without an extra
/// ps call.
///
/// Grandchild ports are attributed to the direct-child PID so the status bar
/// entry stays stable and correct.
async fn find_listening_ports_per_pid(
    direct_pids: &[u32],
    attribution: &HashMap<u32, u32>,
) -> HashMap<u32, Vec<u16>> {
    if direct_pids.is_empty() {
        return HashMap::new();
    }

    let all_pids: Vec<u32> = attribution.keys().cloned().collect();
    let pid_arg = all_pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");

    let output = tokio::time::timeout(
        tokio::time::Duration::from_secs(3),
        tokio::process::Command::new("lsof")
            .args(["-nP", "-a", "-p", &pid_arg, "-iTCP", "-sTCP:LISTEN", "-Fpn"])
            .output(),
    )
    .await
    .ok()
    .and_then(|r| r.ok());

    let Some(output) = output else { return HashMap::new() };
    let text = String::from_utf8_lossy(&output.stdout);

    let mut result: HashMap<u32, Vec<u16>> = HashMap::new();
    let mut current_attributed_pid: Option<u32> = None;

    for line in text.lines() {
        if let Some(pid_str) = line.strip_prefix('p') {
            // Resolve lsof's raw PID to the direct-child PID shown in the UI.
            current_attributed_pid = pid_str
                .parse::<u32>()
                .ok()
                .and_then(|raw| attribution.get(&raw).copied());
        } else if let Some(addr) = line.strip_prefix('n') {
            if let Some(pid) = current_attributed_pid {
                if let Some(port_str) = addr.rsplit(':').next() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        result.entry(pid).or_default().push(port);
                    }
                }
            }
        }
    }

    for ports in result.values_mut() {
        ports.sort_unstable();
        ports.dedup();
    }

    result
}
