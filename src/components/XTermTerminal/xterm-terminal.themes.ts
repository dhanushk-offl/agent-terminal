// xterm.js color palettes for `XTermTerminal`. Split out of the component
// file so the .tsx stays focused on React/lifecycle code and the file
// length lint cap has headroom.
//
// Palettes sourced from VS Code's terminal defaults
// (src/vs/workbench/contrib/terminal/browser/terminalConfiguration.ts, MIT).
//
// Deviations from upstream:
//   - `background` is set to `#0e0f10` / `#ffffff` so the terminal pane
//     matches the app's `--terminal-background` CSS variable and blends
//     with the surrounding chrome.
//   - `cursorAccent` follows the overridden background. cursorAccent is
//     drawn behind a block-style cursor and must equal the terminal bg
//     for the cursor character to invert cleanly; it's a derived value,
//     not an independent palette choice.
//
// Every other slot (foreground, cursor, ANSI 16, selection) is
// upstream-faithful.
//
// `selectionForeground` is load-bearing vs. the previous hand-rolled
// palette: without it, xterm.js leaves the glyph colour unchanged when
// a cell is selected, causing the WebGL renderer to re-rasterise glyphs
// with shifted contrast and producing a visible "font wobble" during
// selection.

import type { ITheme } from '@xterm/xterm'

export const DARK_THEME: ITheme = {
  background: '#0e0f10', // matches --terminal-background (dark)
  foreground: '#cccccc',
  cursor: '#aeafad',
  cursorAccent: '#0e0f10',
  selectionBackground: '#264f78',
  selectionForeground: '#ffffff',
  selectionInactiveBackground: '#3a3d41',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
}

export const LIGHT_THEME: ITheme = {
  background: '#fbfbfd', // matches --terminal-background (light)
  foreground: '#0f172a',
  cursor: '#0f172a',
  cursorAccent: '#fbfbfd',
  selectionBackground: '#c8ddff',
  selectionForeground: '#0f172a',
  selectionInactiveBackground: '#e6edf5',
  black: '#111827',
  red: '#b91c1c',
  green: '#0f8a3b',
  yellow: '#8f650e',
  blue: '#1651a8',
  magenta: '#9b2bb8',
  cyan: '#0f7d96',
  white: '#334155',
  brightBlack: '#475569',
  brightRed: '#dc2626',
  brightGreen: '#15803d',
  brightYellow: '#a16207',
  brightBlue: '#1d4ed8',
  brightMagenta: '#c026d3',
  brightCyan: '#0284c7',
  brightWhite: '#0f172a',
}

export const LIGHT_AGENT_THEME: ITheme = {
  ...LIGHT_THEME,
  background: 'rgba(251, 251, 253, 0.82)',
  cursorAccent: 'rgba(251, 251, 253, 0.82)',
  selectionBackground: 'rgba(200, 221, 255, 0.9)',
  selectionInactiveBackground: 'rgba(230, 237, 245, 0.88)',
}
