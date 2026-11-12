/**
 * Pure helpers for the input tools: key-chord parsing and the model-facing
 * envelopes. No I/O, so both are unit-tested without touching a desktop.
 */
import { formatWindow } from './scene.js'

/** Modifier names and the virtual-key code each presses. */
const MODIFIERS = new Map(Object.entries({
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  win: 0x5B,
  meta: 0x5B,
  cmd: 0x5B,
}))

/** Named non-modifier keys: virtual-key code plus whether it is an extended key. */
const NAMED_KEYS = new Map(Object.entries({
  enter: [0x0D, false],
  return: [0x0D, false],
  tab: [0x09, false],
  esc: [0x1B, false],
  escape: [0x1B, false],
  space: [0x20, false],
  backspace: [0x08, false],
  delete: [0x2E, true],
  del: [0x2E, true],
  insert: [0x2D, true],
  ins: [0x2D, true],
  home: [0x24, true],
  end: [0x23, true],
  pageup: [0x21, true],
  pgup: [0x21, true],
  pagedown: [0x22, true],
  pgdn: [0x22, true],
  up: [0x26, true],
  down: [0x28, true],
  left: [0x25, true],
  right: [0x27, true],
  printscreen: [0x2C, true],
  prtsc: [0x2C, true],
  capslock: [0x14, false],
  numlock: [0x90, true],
  scrolllock: [0x91, false],
  pause: [0x13, false],
  apps: [0x5D, true],
  menu: [0x5D, true],
}))

/** Canonical spelling used in results, so `control+c` reports as `ctrl+c`. */
const MODIFIER_LABELS = new Map([
  ['ctrl', 'ctrl'], ['control', 'ctrl'],
  ['shift', 'shift'],
  ['alt', 'alt'],
  ['win', 'win'], ['meta', 'win'], ['cmd', 'win'],
])

/**
 * Resolve one key name to its virtual-key code.
 * @param {string} name lowercase key name
 * @returns {{ vk: number, extended: boolean } | undefined}
 */
export function keyToVirtualKey(name) {
  const named = NAMED_KEYS.get(name)
  if (named) return { vk: named[0], extended: named[1] }
  if (/^[a-z]$/.test(name)) return { vk: name.toUpperCase().charCodeAt(0), extended: false }
  if (/^[0-9]$/.test(name)) return { vk: 0x30 + Number(name), extended: false }
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(name)
  if (functionKey) return { vk: 0x6F + Number(functionKey[1]), extended: false }
  return undefined
}

/**
 * Parse one chord such as `ctrl+shift+esc` or `f5`.
 * @param {string} combo
 * @returns {{ modifierVks: number[], keyVk: number, extended: boolean, keys: string }}
 */
export function parseKeyCombo(combo) {
  const tokens = String(combo).split('+').map((token) => token.trim()).filter(Boolean)
  if (tokens.length === 0) throw new Error('keys must name at least one key, such as `enter` or `ctrl+c`')

  const keyName = tokens.pop().toLowerCase()
  const modifiers = []
  for (const token of tokens) {
    const name = token.toLowerCase()
    const label = MODIFIER_LABELS.get(name)
    if (label === undefined) {
      throw new Error(`"${token}" is not a modifier; use ctrl, shift, alt, or win`)
    }
    if (!modifiers.includes(label)) modifiers.push(label)
  }
  if (modifiers.length > 4) throw new Error('a chord may hold at most four modifiers')

  const key = keyToVirtualKey(keyName)
  if (key === undefined) {
    throw new Error(`unknown key "${keyName}"; use a letter, a digit, f1-f24, or one of: ${[...NAMED_KEYS.keys()].join(', ')}`)
  }

  return {
    modifierVks: modifiers.map((label) => MODIFIERS.get(label)),
    keyVk: key.vk,
    extended: key.extended,
    keys: [...modifiers, keyName].join('+'),
  }
}

/** One summary line per input action. */
function describeAction(value) {
  switch (value.action) {
    case 'move':
      return `moved the pointer to (${value.to.x}, ${value.to.y})`
    case 'click':
      return `clicked ${value.button}${value.count > 1 ? ` ${value.count} times` : ''} at (${value.at.x}, ${value.at.y})`
    case 'drag':
      return `dragged ${value.button} from (${value.from.x}, ${value.from.y}) to (${value.to.x}, ${value.to.y})`
    case 'scroll': {
      const direction = value.horizontal
        ? (value.delta > 0 ? 'right' : 'left')
        : (value.delta > 0 ? 'up' : 'down')
      const unit = Math.abs(value.delta) === 1 ? 'notch' : 'notches'
      return `scrolled ${Math.abs(value.delta)} ${unit} ${direction} at (${value.at.x}, ${value.at.y})`
    }
    case 'type':
      return `typed ${value.chars} character${value.chars === 1 ? '' : 's'}`
    case 'key':
      return `pressed ${value.keys}`
    default:
      return value.action
  }
}

/** Envelope for a completed input action. */
export function renderActionResult(value) {
  return [
    '<desktop-action>',
    `${describeAction(value)} · pointer (${value.pointer.x}, ${value.pointer.y})`,
    formatWindow('foreground', value.foreground),
    '</desktop-action>',
  ].join('\n')
}

/** How one window operation ended, in the past tense. */
function describeWindowOutcome(value) {
  switch (value.action) {
    case 'focus':
      return value.focused ? 'focused' : 'focus refused'
    case 'close':
      return value.closed ? 'closed' : 'close requested; a dialog may be waiting'
    case 'minimize':
      return 'minimized'
    case 'maximize':
      return 'maximized'
    case 'restore':
      return 'restored'
    default:
      return value.action
  }
}

/** Envelope for one window operation. */
export function renderWindowOp(value) {
  const title = value.window.title || value.window.className || 'window'
  const process = value.window.processName || value.window.className || 'unknown'
  return [
    '<desktop-action>',
    `${describeWindowOutcome(value)} · "${title}" (${process}, pid ${value.window.processId})`,
    formatWindow('foreground', value.foreground),
    '</desktop-action>',
  ].join('\n')
}

/** Envelope for the visible-window list. */
export function renderWindowList(value) {
  const lines = ['<desktop-windows>']
  if (value.windows.length === 0) lines.push('no visible window matched')
  value.windows.forEach((window, index) => {
    const flags = [
      window.minimized ? 'minimized' : '',
      window.foreground ? 'foreground' : '',
    ].filter(Boolean).join(', ')
    const process = window.processName || window.className || 'unknown'
    lines.push(
      `${index + 1}. ${window.hwnd} "${window.title}" — ${process} (pid ${window.processId}), `
      + `${window.width}x${window.height} at (${window.x}, ${window.y})${flags ? `, ${flags}` : ''}`,
    )
  })
  if (value.truncated) {
    lines.push(`showing ${value.windows.length} of ${value.total} matching windows; narrow the title filter to see others`)
  }
  lines.push('</desktop-windows>')
  return lines.join('\n')
}
