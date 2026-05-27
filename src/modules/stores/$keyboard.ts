import { atom } from 'nanostores'

/**
 * True while the app's primary modifier is physically held down.
 * On macOS this is Cmd (Meta); on Linux/Windows this is Ctrl.
 * Drives the project-number overlay in the sidebar so users can see which
 * Primary+N shortcut maps to which project before pressing the digit.
 */
export const $metaHeld = atom<boolean>(false)
