/**
 * dsh-desktop-view — model-facing observation and input for the Windows desktop.
 *
 * Two read-only tools (`desktop_snapshot`, `desktop_cursor`) report screen state;
 * seven input tools (`desktop_move`, `desktop_click`, `desktop_drag`,
 * `desktop_scroll`, `desktop_type`, `desktop_key`, `desktop_window`) act on it.
 * Capture and input both run in short-lived Windows PowerShell helpers that
 * answer with one UTF-8 JSON document, so nothing parses localized console text.
 *
 * Tools are registered as raw JSON-Schema definitions and validate their own
 * arguments: an out-of-tree bundle cannot rely on resolving harness packages.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorIndexAt, renderScene } from './lib/scene.js'
import { parseKeyCombo, renderActionResult, renderWindowList, renderWindowOp } from './lib/control.js'
import { runPowerShellScript } from './lib/powershell.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPTURE_SCRIPT = join(HERE, 'scripts', 'capture.ps1')
const CONTROL_SCRIPT = join(HERE, 'scripts', 'control.ps1')
const SNAPSHOT_DIR = join(homedir(), '.dsh', 'desktop-view', 'snapshots')
const KEEP_SNAPSHOTS = 40
const CAPTURE_TIMEOUT_MS = 30_000
const CONTROL_TIMEOUT_MS = 30_000
const MAX_TYPE_CHARS = 4000

/* ------------------------------------------------------------------ schemas */

const POINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y'],
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
  },
}

/** A window the user can see: handle, title, class, and owning process. */
const WINDOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hwnd', 'title', 'className', 'processId', 'processName'],
  properties: {
    hwnd: { type: 'string' },
    title: { type: 'string' },
    className: { type: 'string' },
    processId: { type: 'integer' },
    processName: { type: 'string' },
  },
}

const MONITOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['index', 'x', 'y', 'width', 'height', 'primary'],
  properties: {
    index: { type: 'integer' },
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    primary: { type: 'boolean' },
  },
}

const RECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
  },
}

const REGION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height', 'kind'],
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    kind: { type: 'string' },
  },
}

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'width', 'height', 'sourceWidth', 'sourceHeight', 'scale', 'bytes'],
  properties: {
    path: { type: 'string' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    sourceWidth: { type: 'integer' },
    sourceHeight: { type: 'integer' },
    scale: { type: 'number' },
    bytes: { type: 'integer' },
  },
}

const ATTACHMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
}

const SNAPSHOT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'capturedAt', 'region', 'virtualScreen', 'monitors', 'dpiScale',
    'cursor', 'foregroundWindow', 'windowUnderCursor', 'image',
  ],
  properties: {
    capturedAt: { type: 'string' },
    region: REGION_SCHEMA,
    virtualScreen: RECT_SCHEMA,
    monitors: { type: 'array', items: MONITOR_SCHEMA },
    dpiScale: { type: 'number' },
    cursor: {
      type: 'object',
      additionalProperties: false,
      required: ['screenX', 'screenY', 'imageX', 'imageY', 'onImage', 'monitorIndex'],
      properties: {
        screenX: { type: 'integer' },
        screenY: { type: 'integer' },
        imageX: { type: 'integer' },
        imageY: { type: 'integer' },
        onImage: { type: 'boolean' },
        monitorIndex: { type: 'integer' },
      },
    },
    foregroundWindow: WINDOW_SCHEMA,
    windowUnderCursor: WINDOW_SCHEMA,
    image: IMAGE_SCHEMA,
    attachment: ATTACHMENT_SCHEMA,
  },
}

const CURSOR_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['capturedAt', 'region', 'virtualScreen', 'monitors', 'dpiScale', 'cursor', 'foregroundWindow', 'windowUnderCursor'],
  properties: {
    capturedAt: { type: 'string' },
    region: REGION_SCHEMA,
    virtualScreen: RECT_SCHEMA,
    monitors: { type: 'array', items: MONITOR_SCHEMA },
    dpiScale: { type: 'number' },
    cursor: {
      type: 'object',
      additionalProperties: false,
      required: ['screenX', 'screenY', 'monitorIndex'],
      properties: {
        screenX: { type: 'integer' },
        screenY: { type: 'integer' },
        monitorIndex: { type: 'integer' },
      },
    },
    foregroundWindow: WINDOW_SCHEMA,
    windowUnderCursor: WINDOW_SCHEMA,
  },
}

const WINDOW_LIST_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['hwnd', 'title', 'className', 'processId', 'processName', 'x', 'y', 'width', 'height', 'minimized', 'foreground'],
  properties: {
    hwnd: { type: 'string' },
    title: { type: 'string' },
    className: { type: 'string' },
    processId: { type: 'integer' },
    processName: { type: 'string' },
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    minimized: { type: 'boolean' },
    foreground: { type: 'boolean' },
  },
}

/**
 * One object root for both answers of `desktop_window`: a list, or one operation.
 * The branches are declared as optional properties rather than `oneOf` so the
 * schema stays an object root, which tool outputs are required to be.
 */
const WINDOW_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string' },
    windows: { type: 'array', items: WINDOW_LIST_ITEM },
    total: { type: 'integer' },
    truncated: { type: 'boolean' },
    window: WINDOW_SCHEMA,
    focused: { type: 'boolean' },
    closed: { type: 'boolean' },
    pointer: POINT_SCHEMA,
    foreground: WINDOW_SCHEMA,
  },
}

/** An input-action result: the action plus the state the desktop is left in. */
function actionOutput(properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'pointer', 'foreground', ...required],
    properties: {
      action: { type: 'string' },
      pointer: POINT_SCHEMA,
      foreground: WINDOW_SCHEMA,
      ...properties,
    },
  }
}

/* ------------------------------------------------------------------ helpers */

function assertWindows(what) {
  if (process.platform !== 'win32') {
    throw new Error(`${what} is implemented for Windows only; this host is ${process.platform}`)
  }
}

function assertControlEnabled() {
  assertWindows('desktop control')
  if (process.env.DSH_DESKTOP_CONTROL === 'off') {
    throw new Error('desktop control is disabled in this environment (DSH_DESKTOP_CONTROL=off)')
  }
}

function requireInteger(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`)
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return value
}

function optionalInteger(value, name, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  return requireInteger(value, name, min, max)
}

function timestampSlug() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
}

function pruneSnapshots(dir) {
  try {
    const names = readdirSync(dir).filter((name) => name.startsWith('desktop-') && name.endsWith('.png'))
    if (names.length <= KEEP_SNAPSHOTS) return
    const files = names
      .map((name) => {
        const path = join(dir, name)
        try {
          return { path, mtime: statSync(path).mtimeMs }
        } catch {
          return undefined
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.mtime - left.mtime)
    for (const file of files.slice(KEEP_SNAPSHOTS)) {
      try { rmSync(file.path, { force: true }) } catch { /* best effort */ }
    }
  } catch { /* pruning is optional */ }
}

function runCapture(options) {
  return runPowerShellScript({
    script: CAPTURE_SCRIPT,
    args: [
      '-Mode', options.mode,
      '-OutPng', options.pngPath ?? '',
      '-MonitorIndex', String(options.monitor ?? 0),
      '-MaxWidth', String(options.maxWidth ?? 0),
      '-MarkCursor', options.markCursor === false ? '0' : '1',
    ],
    signal: options.signal,
    timeoutMs: CAPTURE_TIMEOUT_MS,
  })
}

function runControl(request, signal, timeoutMs = CONTROL_TIMEOUT_MS) {
  return runPowerShellScript({ script: CONTROL_SCRIPT, request, signal, timeoutMs })
}

/** Whether the route that will receive this result accepts image content. */
async function routeAcceptsImages(ctx, exec) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.resolveModelInfo !== 'function') return false
  try {
    const routed = exec.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec.agent?.options?.provider
    const model = routed?.model ?? exec.agent?.options?.model
    if (typeof provider !== 'string' || typeof model !== 'string') return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/**
 * Persist the capture as a durable attachment and expose it in the result when
 * the calling route can render it. A route that cannot accept images keeps the
 * PNG path only, so a text-only model never breaks the request.
 */
async function attachCapture(ctx, exec, value) {
  const attachments = ctx.get('attachments')
  if (!attachments || typeof attachments.saveImage !== 'function') return
  if (!(await routeAcceptsImages(ctx, exec))) return
  let data
  try {
    data = readFileSync(value.image.path)
  } catch {
    return
  }
  try {
    const ref = await attachments.saveImage({
      data,
      mediaType: 'image/png',
      name: basename(value.image.path),
    })
    value.attachment = {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    }
  } catch {
    // Durable storage refused the capture (size or pixel limits): the PNG path
    // in the result still points at the exact capture.
  }
}

const TOOL_GUIDE = 'Coordinates are virtual-screen pixels from desktop_snapshot.'

/* ------------------------------------------------------------------ plugin */

export const inject = ['tools']

export function apply(ctx) {
  const register = (definition) => {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      console.error(`[desktop-view] ${definition.name} registration skipped: ${error instanceof Error ? error.message : error}`)
    }
  }

  /* ------------------------------------------------------------ read-only */

  register({
    name: 'desktop_snapshot',
    description: 'Capture the desktop and return the image with pointer geometry. Use it to see the screen as the user does: the current window, open dialogs, layout, and where the pointer is. Returns the capture (inlined when the model route accepts images, otherwise its absolute path), the pointer in screen and in-image coordinates, the monitor layout, and the titles of the foreground window and the window under the pointer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        monitor: {
          type: 'integer',
          description: 'Monitor number from `monitors` in a previous result. Omit to capture every monitor as one image.',
        },
        max_width: {
          type: 'integer',
          description: 'Downscale the capture to at most this width in pixels. Omit or 0 for native resolution; a smaller width costs fewer image tokens and less detail.',
        },
        mark_cursor: {
          type: 'boolean',
          description: 'Draw a ring at the pointer on the capture. Defaults to true; set false to see the screen unobstructed.',
        },
      },
    },
    output: {
      schema: SNAPSHOT_OUTPUT,
      render: (_args, value) => {
        const content = [{ type: 'text', text: renderScene(value, value.attachment !== undefined) }]
        if (value.attachment) content.push({ type: 'image', attachment: value.attachment })
        return content
      },
      presentationMeta: (_args, value) => ({ path: value.image.path }),
    },
    timeoutMs: CAPTURE_TIMEOUT_MS + 15_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: args?.monitor ? `Desktop snapshot (monitor ${args.monitor})` : 'Desktop snapshot',
      kind: 'read',
      rawInput: args,
    }),
    async execute(args, exec) {
      const monitor = optionalInteger(args?.monitor, 'monitor', undefined, 1, 64)
      const maxWidth = optionalInteger(args?.max_width, 'max_width', 0, 0, 16384)
      assertWindows('desktop observation')
      mkdirSync(SNAPSHOT_DIR, { recursive: true })
      pruneSnapshots(SNAPSHOT_DIR)
      const pngPath = join(SNAPSHOT_DIR, `desktop-${timestampSlug()}.png`)
      const scene = await runCapture({
        mode: 'snapshot',
        pngPath,
        monitor,
        maxWidth,
        markCursor: args?.mark_cursor !== false,
        signal: exec.signal,
      })
      const value = {
        ...scene,
        cursor: { ...scene.cursor, monitorIndex: monitorIndexAt(scene.monitors, scene.cursor.screenX, scene.cursor.screenY) },
      }
      delete value.ok
      delete value.mode
      await attachCapture(ctx, exec, value)
      return value
    },
  })

  register({
    name: 'desktop_cursor',
    description: 'Read the pointer position without capturing the screen. Returns the pointer in screen coordinates and its monitor, the monitor layout, and the titles and processes of the window under the pointer and the foreground window. Use it when only the pointer location, the target under it, or the active window matters.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: CURSOR_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderScene(value, false) }],
    },
    timeoutMs: CAPTURE_TIMEOUT_MS + 15_000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Desktop pointer', kind: 'read' }),
    async execute(_args, exec) {
      assertWindows('desktop observation')
      const scene = await runCapture({ mode: 'cursor', signal: exec.signal })
      const value = {
        ...scene,
        cursor: { screenX: scene.cursor.screenX, screenY: scene.cursor.screenY, monitorIndex: monitorIndexAt(scene.monitors, scene.cursor.screenX, scene.cursor.screenY) },
      }
      delete value.ok
      delete value.mode
      return value
    },
  })

  /* ---------------------------------------------------------------- input */

  register({
    name: 'desktop_move',
    description: `Move the pointer to a position without clicking. Use it to hover: reveal tooltips, open hover menus, or line up a drag start. ${TOOL_GUIDE}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: {
        x: { type: 'integer', description: `${TOOL_GUIDE} Screen x.` },
        y: { type: 'integer', description: 'Screen y.' },
      },
    },
    output: {
      schema: actionOutput({ to: POINT_SCHEMA }, ['to']),
      render: (_args, value) => [{ type: 'text', text: renderActionResult(value) }],
    },
    timeoutMs: CONTROL_TIMEOUT_MS,
    presentCall: (args) => ({ card: 'generic', title: `Move pointer to (${args?.x}, ${args?.y})`, kind: 'other' }),
    async execute(args, exec) {
      const x = requireInteger(args?.x, 'x', -100_000, 100_000)
      const y = requireInteger(args?.y, 'y', -100_000, 100_000)
      assertControlEnabled()
      const result = await runControl({ action: 'move', x, y }, exec.signal)
      return { action: 'move', to: { x, y }, pointer: result.pointer, foreground: result.foreground }
    },
  })

  register({
    name: 'desktop_click',
    description: `Click at a position, or at the pointer when coordinates are omitted. Use it to press buttons, menu items and links, or to place a text caret. Returns the pointer position and the window that ends up in front. ${TOOL_GUIDE}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'integer', description: `${TOOL_GUIDE} Omit x and y together to click where the pointer already is.` },
        y: { type: 'integer', description: 'Screen y; pair it with x.' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button. Defaults to left.',
        },
        count: {
          type: 'integer',
          description: 'Number of clicks, 1 to 5. Use 2 for a double-click and 3 for a triple-click. Defaults to 1.',
        },
      },
    },
    output: {
      schema: actionOutput({
        button: { type: 'string' },
        count: { type: 'integer' },
        at: POINT_SCHEMA,
      }, ['button', 'count', 'at']),
      render: (_args, value) => [{ type: 'text', text: renderActionResult(value) }],
    },
    timeoutMs: CONTROL_TIMEOUT_MS,
    presentCall: (args) => ({
      card: 'generic',
      title: args?.x === undefined ? `Click ${args?.button ?? 'left'}` : `Click ${args?.button ?? 'left'} at (${args?.x}, ${args?.y})`,
      kind: 'other',
    }),
    async execute(args, exec) {
      const hasX = args?.x !== undefined
      const hasY = args?.y !== undefined
      if (hasX !== hasY) throw new Error('give both x and y, or neither to click at the pointer')
      const button = args?.button ?? 'left'
      if (!['left', 'right', 'middle'].includes(button)) throw new Error('button must be left, right, or middle')
      const count = optionalInteger(args?.count, 'count', 1, 1, 5)
      const request = { action: 'click', button, count }
      if (hasX) {
        request.x = requireInteger(args.x, 'x', -100_000, 100_000)
        request.y = requireInteger(args.y, 'y', -100_000, 100_000)
      }
      assertControlEnabled()
      const result = await runControl(request, exec.signal)
      return { action: 'click', button, count, at: result.pointer, pointer: result.pointer, foreground: result.foreground }
    },
  })

  register({
    name: 'desktop_drag',
    description: `Press at a start point, move to an end point, and release. Use it to drag windows, sliders, scroll bars and selections, or to move files. A longer duration is smoother and more likely to trigger drag behavior. ${TOOL_GUIDE}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
      properties: {
        from_x: { type: 'integer', description: `${TOOL_GUIDE} Start x.` },
        from_y: { type: 'integer', description: 'Start y.' },
        to_x: { type: 'integer', description: 'End x.' },
        to_y: { type: 'integer', description: 'End y.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Defaults to left.' },
        duration_ms: { type: 'integer', description: 'How long the move takes, 0 to 5000 ms. Defaults to 350.' },
      },
    },
    output: {
      schema: actionOutput({
        button: { type: 'string' },
        from: POINT_SCHEMA,
        to: POINT_SCHEMA,
        steps: { type: 'integer' },
      }, ['button', 'from', 'to', 'steps']),
      render: (_args, value) => [{ type: 'text', text: renderActionResult(value) }],
    },
    timeoutMs: CONTROL_TIMEOUT_MS,
    presentCall: (args) => ({
      card: 'generic',
      title: `Drag to (${args?.to_x}, ${args?.to_y})`,
      kind: 'other',
    }),
    async execute(args, exec) {
      const fromX = requireInteger(args?.from_x, 'from_x', -100_000, 100_000)
      const fromY = requireInteger(args?.from_y, 'from_y', -100_000, 100_000)
      const toX = requireInteger(args?.to_x, 'to_x', -100_000, 100_000)
      const toY = requireInteger(args?.to_y, 'to_y', -100_000, 100_000)
      const button = args?.button ?? 'left'
      if (!['left', 'right', 'middle'].includes(button)) throw new Error('button must be left, right, or middle')
      const durationMs = optionalInteger(args?.duration_ms, 'duration_ms', 350, 0, 5000)
      const steps = Math.min(Math.max(Math.round(durationMs / 30), 4), 40)
      assertControlEnabled()
      const result = await runControl({
        action: 'drag', fromX, fromY, toX, toY, button, steps, durationMs,
      }, exec.signal)
      return {
        action: 'drag',
        button,
        from: { x: fromX, y: fromY },
        to: { x: toX, y: toY },
        steps,
        pointer: result.pointer,
        foreground: result.foreground,
      }
    },
  })

  register({
    name: 'desktop_scroll',
    description: `Scroll the wheel at a position, or at the pointer. Use it to scroll lists and pages, or to pan. Positive delta scrolls up, negative down; horizontal positive scrolls right. ${TOOL_GUIDE}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['delta'],
      properties: {
        delta: { type: 'integer', description: 'Wheel notches; one notch is a typical line step. Use 3 to 10 for a screenful. Positive scrolls up.' },
        x: { type: 'integer', description: `${TOOL_GUIDE} Omit x and y together to scroll where the pointer already is.` },
        y: { type: 'integer', description: 'Screen y; pair it with x.' },
        horizontal: { type: 'boolean', description: 'Scroll sideways instead of vertically. Defaults to false.' },
      },
    },
    output: {
      schema: actionOutput({
        delta: { type: 'integer' },
        horizontal: { type: 'boolean' },
        at: POINT_SCHEMA,
      }, ['delta', 'horizontal', 'at']),
      render: (_args, value) => [{ type: 'text', text: renderActionResult(value) }],
    },
    timeoutMs: CONTROL_TIMEOUT_MS,
    presentCall: (args) => ({ card: 'generic', title: `Scroll ${args?.delta}`, kind: 'other' }),
    async execute(args, exec) {
      const delta = requireInteger(args?.delta, 'delta', -100, 100)
      if (delta === 0) throw new Error('delta must be non-zero')
      const horizontal = args?.horizontal === true
      const hasX = args?.x !== undefined
      const hasY = args?.y !== undefined
      if (hasX !== hasY) throw new Error('give both x and y, or neither to scroll at the pointer')
      const request = { action: 'scroll', delta, horizontal }
      if (hasX) {
        request.x = requireInteger(args.x, 'x', -100_000, 100_000)
        request.y = requireInteger(args.y, 'y', -100_000, 100_000)
      }
      assertControlEnabled()
      const result = await runControl(request, exec.signal)
      return { action: 'scroll', delta, horizontal, at: result.pointer, pointer: result.pointer, foreground: result.foreground }
    },
  })

  register({
    name: 'desktop_type',
    description: 'Type text into the focused control as if from the keyboard. Focus the target first with desktop_click or desktop_window. Newlines press Enter and tabs press Tab; every other character is typed as Unicode, so non-Latin text works without changing keyboard layouts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: `Text to type. ${MAX_TYPE_CHARS} characters maximum.` },
        interval_ms: { type: 'integer', description: 'Delay between characters in milliseconds, 0 to 1000. Raise it for apps that drop fast input. Defaults to 8.' },
      },
    },
    output: {
      schema: actionOutput({ chars: { type: 'integer' } }, ['chars']),
      render: (_args, value) => [{ type: 'text', text: renderActionResult(value) }],
    },
    timeoutMs: 180_000,
    presentCall: (args) => ({
      card: 'generic',
      title: `Type ${typeof args?.text === 'string' ? args.text.length : 0} chars`,
      kind: 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      const text = args?.text
      if (typeof text !== 'string' || text.length === 0) throw new Error('text must be a non-empty string')
      if (text.length > MAX_TYPE_CHARS) {
        throw new Error(`text is limited to ${MAX_TYPE_CHARS} characters; split it into several calls`)
      }
      const intervalMs = optionalInteger(args?.interval_ms, 'interval_ms', 8, 0, 1000)
      const timeoutMs = Math.min(CONTROL_TIMEOUT_MS + text.length * intervalMs, 170_000)
      assertControlEnabled()
      const result = await runControl({ action: 'type', text, intervalMs }, exec.signal, timeoutMs)
      return { action: 'type', chars: result.chars, pointer: result.pointer, foreground: result.foreground }
    },
  })

  register({
    name: 'desktop_key',
    description: 'Press one key or a chord, such as `enter`, `esc`, `tab`, `ctrl+c`, `alt+tab`, `win+r`, or `ctrl+shift+esc`. Use it for shortcuts and for keys that cannot be expressed as text; type literal characters with desktop_type instead.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['keys'],
      properties: {
        keys: { type: 'string', description: 'One key, or a `+`-joined chord. Modifiers: ctrl, shift, alt, win. Keys: enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up, down, left, right, f1-f24, a-z, 0-9.' },
      },
    },
    output: {
      schema: actionOutput({ keys: { type: 'string' } }, ['keys']),
      render: (_args, value) => [{ type: 'text', text: renderActionResult(value) }],
    },
    timeoutMs: CONTROL_TIMEOUT_MS,
    presentCall: (args) => ({ card: 'generic', title: `Press ${args?.keys ?? ''}`, kind: 'other' }),
    async execute(args, exec) {
      const parsed = parseKeyCombo(args?.keys)
      assertControlEnabled()
      const result = await runControl({
        action: 'key',
        modifierVks: parsed.modifierVks,
        keyVk: parsed.keyVk,
        extended: parsed.extended,
      }, exec.signal)
      return { action: 'key', keys: parsed.keys, pointer: result.pointer, foreground: result.foreground }
    },
  })

  register({
    name: 'desktop_window',
    description: 'List the visible top-level windows, or focus, minimize, maximize, restore, or close one by title or handle. Use it to see what is open, to bring a window to the front before typing, or to close a dialog.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: {
          type: 'string',
          enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'close'],
          description: 'What to do. Defaults to list.',
        },
        title: {
          type: 'string',
          description: 'Window title substring, case-insensitive; the frontmost match wins. Filters the list when operation is list.',
        },
        hwnd: {
          type: 'string',
          description: 'Exact handle from a previous list, as a hex string such as 0x00090918. Use it when two windows share a title.',
        },
      },
    },
    output: {
      schema: WINDOW_OUTPUT,
      render: (_args, value) => [{
        type: 'text',
        text: value.action === 'list' ? renderWindowList(value) : renderWindowOp(value),
      }],
    },
    timeoutMs: CONTROL_TIMEOUT_MS,
    presentCall: (args) => ({
      card: 'generic',
      title: args?.operation && args.operation !== 'list' ? `Window ${args.operation}` : 'Visible windows',
      kind: 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      const operation = args?.operation ?? 'list'
      if (!['list', 'focus', 'minimize', 'maximize', 'restore', 'close'].includes(operation)) {
        throw new Error('operation must be list, focus, minimize, maximize, restore, or close')
      }
      const title = typeof args?.title === 'string' && args.title.trim().length > 0 ? args.title.trim() : undefined
      const hwnd = typeof args?.hwnd === 'string' && args.hwnd.trim().length > 0 ? args.hwnd.trim() : undefined
      if (operation !== 'list' && title === undefined && hwnd === undefined) {
        throw new Error('give title or hwnd to choose the window')
      }

      assertControlEnabled()

      if (operation === 'list') {
        const result = await runControl({ action: 'windows', ...(title === undefined ? {} : { filter: title }), limit: 60 }, exec.signal)
        return { action: 'list', windows: result.windows, total: result.total, truncated: result.truncated }
      }
      const result = await runControl({
        action: 'window',
        operation,
        ...(hwnd === undefined ? {} : { hwnd }),
        ...(title === undefined ? {} : { title }),
      }, exec.signal)
      return {
        action: operation,
        window: result.window,
        focused: result.focused === true,
        closed: result.closed === true,
        pointer: result.pointer,
        foreground: result.foreground,
      }
    },
  })
}
