//! Agent Terminal shell integration scripts.
//!
//! These scripts are written to `~/.config/<NAMESPACE>/` (see `identity::NAMESPACE`
//! — `agent-terminal` for prod builds, `agent-terminal-dev` for dev builds) on
//! first launch and injected into each new PTY session via ZDOTDIR (zsh) or
//! --init-file (bash). They emit OSC 7 (cwd) and OSC 133 (shell marks) sequences
//! that the MOD engine parses to track directories and process lifecycle.

// zsh dotfile load order (login shell):
//   /etc/zshenv → $ZDOTDIR/.zshenv → /etc/zprofile → $ZDOTDIR/.zprofile →
//   /etc/zshrc → $ZDOTDIR/.zshrc → /etc/zlogin → $ZDOTDIR/.zlogin
//
// We redirect ZDOTDIR to ~/.config/<NAMESPACE>/zsh/, which means by default
// zsh would NOT load the user's real .zshenv / .zprofile / .zshrc. We supply
// shim files in our ZDOTDIR that source the user's real ones — otherwise PATH
// (set in .zshenv / .zprofile / via Homebrew's path_helper) is missing in
// production GUI launches where launchd starts the app with a minimal env.

const ZSH_ZSHENV_SHIM: &str = r#"# Agent Terminal — load the user's real .zshenv if present
export ZDOTDIR_ORIG="${ZDOTDIR_ORIG:-$HOME}"
[[ -f "$ZDOTDIR_ORIG/.zshenv" ]] && source "$ZDOTDIR_ORIG/.zshenv"
"#;

const ZSH_ZPROFILE_SHIM: &str = r#"# Agent Terminal — load the user's real .zprofile if present
export ZDOTDIR_ORIG="${ZDOTDIR_ORIG:-$HOME}"
[[ -f "$ZDOTDIR_ORIG/.zprofile" ]] && source "$ZDOTDIR_ORIG/.zprofile"
"#;

const ZSH_SCRIPT: &str = r#"# Agent Terminal shell integration
# Source the user's real .zshrc first
export ZDOTDIR_ORIG="${ZDOTDIR_ORIG:-$HOME}"
[[ -f "$ZDOTDIR_ORIG/.zshrc" ]] && source "$ZDOTDIR_ORIG/.zshrc"

# OSC 7 — emit cwd on every prompt
_at_osc7() { printf '\033]7;file://%s%s\007' "${HOST:-localhost}" "$PWD"; }

# OSC 133 — shell integration marks
_at_osc133_exit() { printf '\033]133;D;%s\007' "$?"; }
_at_osc133_prompt() { printf '\033]133;A\007'; }
_at_osc133_preexec() { printf '\033]133;B\007'; }

precmd_functions=(_at_osc133_exit _at_osc7 _at_osc133_prompt ${precmd_functions[@]})
preexec_functions=(_at_osc133_preexec ${preexec_functions[@]})
"#;

const BASH_SCRIPT: &str = r#"# Agent Terminal shell integration
# 
# This script creates a "native" bash experience by:
# 1. Setting up environment variables (TERM, LANG, COLORTERM)
# 2. Loading the user's PATH via path_helper + common package managers
# 3. Sourcing .bash_profile and .bashrc to preserve user config
# 4. Registering OSC 7 (cwd tracking) and OSC 133 (shell marks) hooks
# 5. Using function-based hook preservation instead of fragile string concat

# ─── Environment Setup ───────────────────────────────────────────────────
# On macOS, launchd starts GUI apps with a minimal env (no TERM, no user PATH).
# Without TERM, bash can't initialize readline and the user sees doubled
# keystrokes. Without user PATH, every brewed binary fails with "command not found".
# TERM is set here; PATH is loaded by path_helper and the sourced rc files.

export TERM="${TERM:-xterm-256color}"
export COLORTERM="truecolor"
if [[ -z "$LANG" ]]; then
    export LANG="en_US.UTF-8"
fi

# ─── Path Setup (macOS Homebrew + Linux Package Managers) ────────────────
# ZSH loads PATH via /etc/zprofile (login shell). BASH via --init-file skips
# this. We emulate login shell PATH setup across both platforms:
#
# macOS:  /usr/libexec/path_helper loads Homebrew + system bins
# Linux:  /etc/profile + /etc/bashrc handle Homebrew, conda, system bins, etc.

# macOS path_helper (loads Homebrew, system paths)
if [[ -f /usr/libexec/path_helper ]]; then
    eval "$(/usr/libexec/path_helper -s)"
fi

# Linux /etc/profile (loads system-wide path setup, distro package managers)
# This is sourced by login shells but NOT by --init-file, so we do it here.
# It sets up things like /usr/local/sbin, /usr/local/bin, etc. from distro.
if [[ -f /etc/profile ]]; then
    source /etc/profile 2>/dev/null || true
fi

# Common package manager paths (universal fallback)
# These are added if path_helper or /etc/profile didn't already add them.
# Ensures npm, python3, cargo binaries work even with non-standard installs.
[[ -d "$HOME/.cargo/bin" ]] && PATH="$HOME/.cargo/bin:$PATH"
[[ -d "$HOME/.local/bin" ]] && PATH="$HOME/.local/bin:$PATH"
[[ -d "$HOME/.npm-global/bin" ]] && PATH="$HOME/.npm-global/bin:$PATH"
[[ -d "$HOME/.rbenv/bin" ]] && PATH="$HOME/.rbenv/bin:$PATH"
[[ -d "$HOME/.pyenv/bin" ]] && PATH="$HOME/.pyenv/bin:$PATH"
[[ -d "/usr/local/go/bin" ]] && PATH="/usr/local/go/bin:$PATH"

# ─── Login Shell Config (.bash_profile) ──────────────────────────────────
# ZSH loads .zprofile (login-only settings) as part of its multi-stage init.
# BASH via --init-file skips this. We source .bash_profile explicitly to get:
# - Vi mode (set -o vi), emacs mode, or other shell options
# - Machine-specific PATH/env setup
# - fzf, nvm, pyenv, or other manager initialization
# 
# Note: bash standards say --init-file should act like a login shell would,
# so sourcing .bash_profile here is correcting for that semantic gap.

if [[ -f "$HOME/.bash_profile" ]]; then
    source "$HOME/.bash_profile"
elif [[ -f "$HOME/.profile" ]]; then
    # Fallback to POSIX .profile if .bash_profile doesn't exist
    source "$HOME/.profile"
fi

# ─── Interactive Config (.bashrc) ────────────────────────────────────────
# Source the user's .bashrc to load:
# - Aliases (ll, la, grep with color, etc.)
# - Functions (custom helpers, cd wrappers, etc.)
# - Shell options (shopt: nocaseglob, extglob, etc.)
# - Prompt customization (PS1, PS2, etc.)
#
# This is where most user customization lives. We source it with error
# handling so integration doesn't silently break if .bashrc has issues.

if [[ -f "$HOME/.bashrc" ]]; then
    # Source with timeout to prevent hanging if .bashrc is slow
    # (e.g., nvm.sh can be slow on first run). Non-zero exit is swallowed
    # so the terminal doesn't crash — the user just loses that part of config.
    timeout 3 source "$HOME/.bashrc" 2>/dev/null || true
fi

# ─── OSC Helpers ──────────────────────────────────────────────────────────
# These emit terminal escape sequences that Agent Terminal's MOD engine parses:
# 
# OSC 7 (Operating System Command 7) — cwd tracking
#   Emitted at every prompt, tells the terminal what directory we're in.
#   This lets Agent Terminal track working directory across tabs and sessions.
#
# OSC 133 — shell integration marks (iTerm2, VS Code, etc. convention)
#   D: exit status (fired AFTER command exits, carries exit code)
#   A: ready for next command (fired BEFORE showing prompt)
#   B: command starting (fired BEFORE command executes)
#   These marks let the MOD engine track process lifecycle and command boundaries.

_at_osc7() {
    # Emit current directory as OSC 7 file:// URL
    printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$PWD"
}

_at_osc133_exit() {
    # Emit exit status after command completes. Called FIRST in PROMPT_COMMAND
    # so we capture the true $? before any subsequent function runs.
    printf '\033]133;D;%s\007' "$?"
}

_at_osc133_prompt() {
    # Signal that prompt is about to display (all previous commands complete)
    printf '\033]133;A\007'
}

_at_osc133_preexec() {
    # Signal that command is about to execute. Called via DEBUG trap.
    # We use a wrapper (_at_preexec) to skip debug output from certain contexts.
    printf '\033]133;B\007'
}

# ─── Hook Preservation (Function-Based Pattern) ──────────────────────────
# BASH's PROMPT_COMMAND is a string that gets eval'd. Naively concatenating
# our hooks into it breaks if the user's existing PROMPT_COMMAND contains
# special chars (nested semicolons, $(...), etc.). Instead, we:
#
# 1. Save the user's original PROMPT_COMMAND in _AT_USER_PROMPT_COMMAND
# 2. Create wrapper functions that call our hooks then the user's function
# 3. Set PROMPT_COMMAND to call only our wrapper
#
# This avoids string parsing and is safe across all special characters.

_AT_USER_PROMPT_COMMAND="${PROMPT_COMMAND:-}"

_at_prompt_wrapper() {
    # Called by PROMPT_COMMAND. Runs our hooks, then the user's original.
    # Order matters: capture exit status FIRST, before anything else runs.
    _at_osc133_exit
    _at_osc7
    _at_osc133_prompt
    
    # Run user's original PROMPT_COMMAND if it exists
    if [[ -n "${_AT_USER_PROMPT_COMMAND}" ]]; then
        eval "${_AT_USER_PROMPT_COMMAND}"
    fi
}

# Install our wrapper as PROMPT_COMMAND
PROMPT_COMMAND="_at_prompt_wrapper"

# ─── Preexec Emulation (DEBUG Trap) ──────────────────────────────────────
# BASH doesn't have zsh's native preexec hook. We use the DEBUG trap, which
# fires before every command. However, it also fires inside functions and
# loops (on every line), which can pollute output and hurt performance.
#
# We use a wrapper that fires on top-level commands only by checking if
# BASH_SUBSHELL is 0 (not inside $(...) or pipe) and if this isn't a
# function call (FUNCNAME[-1] != source).
#
# This is an approximation—not perfect like zsh's preexec, but good enough
# to track command execution for the MOD engine without spam.

_at_preexec() {
    # Only fire on top-level commands (not inside functions or subshells)
    if [[ "${BASH_SUBSHELL}" -eq 0 ]] && [[ "${FUNCNAME[-1]}" != "source" ]]; then
        _at_osc133_preexec
    fi
}

trap '_at_preexec' DEBUG
"#;

/// Write shell integration scripts to `~/.config/<NAMESPACE>/`.
///
/// This is called once at application startup. If it fails (e.g. the directory
/// can't be created), the error is logged but the app continues — shell
/// integration is best-effort.
pub fn setup_shell_integration() -> Result<(), String> {
    let config_dir = dirs::home_dir()
        .ok_or_else(|| "cannot determine home directory".to_string())?
        .join(".config")
        .join(crate::identity::NAMESPACE);

    // zsh: ZDOTDIR points to this directory. We write shims for .zshenv,
    // .zprofile, .zshrc — each sources the user's real file if present.
    // This is critical in production GUI launches: launchd starts agent-terminal
    // with a minimal environment (no Homebrew/fnm PATH, etc.), and PATH is
    // typically set in .zshenv / .zprofile rather than .zshrc.
    let zsh_dir = config_dir.join("zsh");
    std::fs::create_dir_all(&zsh_dir)
        .map_err(|e| format!("failed to create zsh config dir: {e}"))?;
    std::fs::write(zsh_dir.join(".zshenv"), ZSH_ZSHENV_SHIM)
        .map_err(|e| format!("failed to write zsh .zshenv shim: {e}"))?;
    std::fs::write(zsh_dir.join(".zprofile"), ZSH_ZPROFILE_SHIM)
        .map_err(|e| format!("failed to write zsh .zprofile shim: {e}"))?;
    std::fs::write(zsh_dir.join(".zshrc"), ZSH_SCRIPT)
        .map_err(|e| format!("failed to write zsh integration script: {e}"))?;

    // bash: sourced via --init-file
    std::fs::write(config_dir.join("bash-integration.bash"), BASH_SCRIPT)
        .map_err(|e| format!("failed to write bash integration script: {e}"))?;

    Ok(())
}
