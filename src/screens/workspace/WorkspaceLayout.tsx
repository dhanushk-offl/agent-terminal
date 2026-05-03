import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Sidebar } from '@/components/Sidebar/Sidebar'
import { StatusBar } from '@/components/StatusBar/StatusBar'
import { TerminalSearchBar } from '@/components/TerminalSearchBar/TerminalSearchBar'
import { $activeSearch, openSearch } from '@/modules/stores/$activeSearch'
import { $activeTerminalHandle } from '@/modules/stores/$activeTerminal'
import { popClosedTab } from '@/modules/stores/$closedTabs'
import {
  decreaseFontSize,
  increaseFontSize,
  resetFontSize,
} from '@/modules/stores/$fontSize'
import { $metaHeld } from '@/modules/stores/$keyboard'
import {
  $activeProjectId,
  $activeTabId,
  navigateToProject,
  navigateToTab,
  onTabRemoved,
} from '@/modules/stores/$navigation'
import { $projects, addTab, removeTab } from '@/modules/stores/$projects'
import { WorkspaceView } from '@/screens/workspace/WorkspaceView'

/* ---------------------------------------------------------------------------
 * WorkspaceLayout
 * -------------------------------------------------------------------------*/

export function WorkspaceLayout() {
  const projects = useStore($projects)
  const activeProjectId = useStore($activeProjectId)

  // Lazy-mount projects: only render WorkspaceView once a project becomes active.
  // Already-mounted projects stay rendered and are CSS-hidden when inactive.
  const [mountedProjects, setMountedProjects] = useState<Set<string>>(
    () => new Set(activeProjectId ? [activeProjectId] : []),
  )

  useEffect(() => {
    if (activeProjectId) {
      setMountedProjects((prev) => {
        if (prev.has(activeProjectId)) return prev
        return new Set([...prev, activeProjectId])
      })
    }
  }, [activeProjectId])

  // Recovery: if the active project was removed, fall back to the first remaining one.
  useEffect(() => {
    const exists = projects.some((p) => p.id === activeProjectId)
    if (!exists && projects.length > 0) {
      navigateToProject(projects[0].id)
    }
  }, [projects, activeProjectId])

  // Track whether Cmd is physically held so the sidebar can show project-number
  // badges. The blur listener resets the flag if the window loses focus while
  // Cmd is held — prevents the overlay from getting stuck.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Meta') $metaHeld.set(true)
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === 'Meta') $metaHeld.set(false)
    }
    function onBlur() {
      $metaHeld.set(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // enableOnFormTags is required because xterm uses a hidden <textarea> to
  // capture keyboard input. Without it react-hotkeys-hook silently ignores
  // all key events while the terminal has focus.
  const hotkeyOpts = { preventDefault: true, enableOnFormTags: true } as const

  // ⌘T — new tab in the active project
  useHotkeys(
    'meta+t',
    () => {
      const projectId = $activeProjectId.get()
      const newTab = addTab(projectId)
      if (newTab) navigateToTab(projectId, newTab.id)
    },
    hotkeyOpts,
  )

  // ⌘W — close the active tab (pinned tabs are protected)
  useHotkeys(
    'meta+w',
    () => {
      const projectId = $activeProjectId.get()
      const tabId = $activeTabId.get()[projectId] ?? ''
      if (!tabId) return
      const project = $projects.get().find((p) => p.id === projectId)
      const tab = project?.tabs.find((t) => t.id === tabId)
      if (tab?.pinned) return
      onTabRemoved(projectId, tabId)
      removeTab(projectId, tabId)
    },
    hotkeyOpts,
  )

  // ⌘⇧] — cycle to the next tab in the active project (wraps around)
  useHotkeys(
    'meta+shift+]',
    () => {
      const projectId = $activeProjectId.get()
      const project = $projects.get().find((p) => p.id === projectId)
      if (!project || project.tabs.length < 2) return
      const tabId = $activeTabId.get()[projectId]
      const idx = project.tabs.findIndex((t) => t.id === tabId)
      const next = project.tabs[(idx + 1) % project.tabs.length]
      if (next) navigateToTab(projectId, next.id)
    },
    hotkeyOpts,
  )

  // ⌘⇧[ — cycle to the previous tab in the active project (wraps around)
  useHotkeys(
    'meta+shift+[',
    () => {
      const projectId = $activeProjectId.get()
      const project = $projects.get().find((p) => p.id === projectId)
      if (!project || project.tabs.length < 2) return
      const tabId = $activeTabId.get()[projectId]
      const idx = project.tabs.findIndex((t) => t.id === tabId)
      const prev =
        project.tabs[(idx - 1 + project.tabs.length) % project.tabs.length]
      if (prev) navigateToTab(projectId, prev.id)
    },
    hotkeyOpts,
  )

  // ⌘1–9 — switch to project N in sidebar display order (pinned first).
  // Diverges from iTerm2/Ghostty (which use Cmd+1..9 for tab N) — agent-terminal
  // is project-centric so number-jump operates at the project layer; tab nav
  // is via Cmd+Shift+]/[ cycling. Projects beyond 9 have no shortcut.
  useHotkeys(
    [
      'meta+1',
      'meta+2',
      'meta+3',
      'meta+4',
      'meta+5',
      'meta+6',
      'meta+7',
      'meta+8',
      'meta+9',
    ],
    (e) => {
      const n = Number.parseInt(e.key, 10) - 1
      const allProjects = $projects.get()
      const ordered = [
        ...allProjects.filter((p) => p.pinned),
        ...allProjects.filter((p) => !p.pinned),
      ]
      const target = ordered[n]
      if (target) navigateToProject(target.id)
    },
    hotkeyOpts,
  )

  // ⌘= / ⌘+ — increase font size. Bind both because on US keyboards `⌘+`
  // requires Shift+`=`, so depending on layout the browser fires either
  // event. iTerm2/Ghostty bind both for the same reason.
  useHotkeys(['meta+=', 'meta+plus'], () => increaseFontSize(), hotkeyOpts)
  // ⌘- — decrease font size
  useHotkeys('meta+-', () => decreaseFontSize(), hotkeyOpts)
  // ⌘0 — reset font size to default
  useHotkeys('meta+0', () => resetFontSize(), hotkeyOpts)

  // ⌘K — clear screen + scrollback in the active terminal
  useHotkeys('meta+k', () => $activeTerminalHandle.get()?.clear(), hotkeyOpts)

  // ⌘A — select all in the active terminal
  useHotkeys(
    'meta+a',
    () => $activeTerminalHandle.get()?.selectAll(),
    hotkeyOpts,
  )

  // ⌘⇧T — reopen the last closed tab in its original project
  useHotkeys(
    'meta+shift+t',
    () => {
      const closed = popClosedTab()
      if (!closed) return
      const project = $projects.get().find((p) => p.id === closed.projectId)
      if (!project) return // project itself was deleted; drop silently
      const newTab = addTab(closed.projectId, closed.cwd)
      if (!newTab) return
      // addTab generates a fresh dedupe-safe label; restore the original.
      const updated = $projects.get().map((p) =>
        p.id !== closed.projectId
          ? p
          : {
              ...p,
              tabs: p.tabs.map((t) =>
                t.id === newTab.id ? { ...t, label: closed.label } : t,
              ),
            },
      )
      $projects.set(updated)
      navigateToTab(closed.projectId, newTab.id)
    },
    hotkeyOpts,
  )

  // ⌘F — open the find overlay over the active terminal
  useHotkeys(
    'meta+f',
    () => {
      const projectId = $activeProjectId.get()
      const tabId = $activeTabId.get()[projectId] ?? ''
      if (!tabId) return
      openSearch(`${projectId}:${tabId}`)
    },
    hotkeyOpts,
  )

  // ⌘G / ⌘⇧G — find next / previous (only meaningful while bar is open)
  useHotkeys(
    'meta+g',
    () => {
      if ($activeSearch.get()) $activeTerminalHandle.get()?.searchNext()
    },
    hotkeyOpts,
  )
  useHotkeys(
    'meta+shift+g',
    () => {
      if ($activeSearch.get()) $activeTerminalHandle.get()?.searchPrevious()
    },
    hotkeyOpts,
  )

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-background">
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="relative min-w-0 flex-1">
          {projects.map((project) => {
            if (!mountedProjects.has(project.id)) return null
            return (
              <div
                key={project.id}
                className="absolute inset-0 flex flex-col"
                style={{
                  display: project.id === activeProjectId ? 'flex' : 'none',
                }}
              >
                <WorkspaceView project={project} />
              </div>
            )
          })}
          {/* Find-in-scrollback overlay floats over the active terminal,
              regardless of which project/tab is visible. */}
          <TerminalSearchBar />
        </div>
      </div>
      <StatusBar />
    </div>
  )
}
