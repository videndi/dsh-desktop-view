/**
 * dsh-desktop-view — model-facing observation of the Windows desktop.
 *
 * `desktop_snapshot` captures the screen (all monitors or one) and returns the
 * image together with pointer geometry and window titles; `desktop_cursor`
 * reads the pointer alone. Capture itself runs in a short-lived Windows
 * PowerShell helper (scripts/capture.ps1) that writes one UTF-8 JSON document,
 * so nothing here parses localized console output and no bytes leave the
 * machine. Tools are registered as raw JSON-Schema definitions: an
 * out-of-tree bundle cannot rely on resolving the harness packages.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorIndexAt, renderScene } from './lib/scene.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPTURE_SCRIPT = join(HERE, 'scripts', 'capture.ps1')
const SNAPSHOT_DIR = join(homedir(), '.dsh', 'desktop-view', 'snapshots')
const KEEP_SNAPSHOTS = 40
const CAPTURE_TIMEOUT_MS = 30_000

/** The pointer and monitor geometry shared by both tools. */
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

/** A window the user can see: title, class, and owning process. */
const WINDOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'className', 'processId', 'processName'],
  properties: {
    title: { type: 'string' },
    className: { type: 'string' },
    processId: { type: 'integer' },
    processName: { type: 'string' },
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

/** Windows PowerShell is the one interpreter every supported desktop ships. */
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir
  if (root) {
    const bundled = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(bundled)) return bundled
  }
  return 'powershell.exe'
}

function assertWindows() {
  if (process.platform !== 'win32') {
    throw new Error('desktop observation is implemented for Windows only; this host is ' + process.platform)
  }
}

function assertScript() {
  if (!existsSync(CAPTURE_SCRIPT)) {
    throw new Error(`desktop capture helper is missing: ${CAPTURE_SCRIPT}`)
  }
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

/**
 * Run the helper once and return its JSON document.
 * @param {{mode: 'snapshot'|'cursor', pngPath?: string, monitor?: number, maxWidth?: number, markCursor?: boolean, signal?: AbortSignal}} options
 */
function runCapture(options) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error('aborted'))
      return
    }
    const jsonPath = join(
      tmpdir(),
      `dsh-desktop-view-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    )
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', CAPTURE_SCRIPT,
      '-Mode', options.mode,
      '-OutJson', jsonPath,
      '-OutPng', options.pngPath ?? '',
      '-MonitorIndex', String(options.monitor ?? 0),
      '-MaxWidth', String(options.maxWidth ?? 0),
      '-MarkCursor', options.markCursor === false ? '0' : '1',
    ]
    let settled = false
    let stderr = ''
    const child = spawn(powershellPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })

    const finish = (settle, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', onAbort)
      settle(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new Error(`desktop capture timed out after ${CAPTURE_TIMEOUT_MS} ms`))
    }, CAPTURE_TIMEOUT_MS)
    const onAbort = () => {
      child.kill()
      finish(reject, options.signal?.reason ?? new Error('desktop capture aborted'))
    }
    options.signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      finish(reject, new Error(`cannot start Windows PowerShell (${powershellPath()}): ${error.message}`))
    })
    child.on('close', (code) => {
      let payload
      try {
        payload = JSON.parse(readFileSync(jsonPath, 'utf8'))
      } catch { /* fall through to stderr */ }
      try { rmSync(jsonPath, { force: true }) } catch { /* optional cleanup */ }
      if (payload && payload.ok === true) {
        finish(resolve, payload)
        return
      }
      const detail = (payload && typeof payload.error === 'string' && payload.error)
        || stderr.trim().slice(-600)
        || `capture helper exited with code ${code}`
      finish(reject, new Error(detail))
    })
  })
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

export const inject = ['tools']

export function apply(ctx) {
  const register = (definition) => {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      console.error(`[desktop-view] ${definition.name} registration skipped: ${error instanceof Error ? error.message : error}`)
    }
  }

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
      const monitor = args?.monitor
      if (monitor !== undefined && (!Number.isInteger(monitor) || monitor < 1)) {
        throw new Error('monitor must be a positive integer from the monitors list')
      }
      const maxWidthRaw = args?.max_width
      if (maxWidthRaw !== undefined && (!Number.isInteger(maxWidthRaw) || maxWidthRaw < 0)) {
        throw new Error('max_width must be a non-negative integer')
      }
      assertWindows()
      assertScript()
      mkdirSync(SNAPSHOT_DIR, { recursive: true })
      pruneSnapshots(SNAPSHOT_DIR)
      const pngPath = join(SNAPSHOT_DIR, `desktop-${timestampSlug()}.png`)
      const scene = await runCapture({
        mode: 'snapshot',
        pngPath,
        monitor,
        maxWidth: maxWidthRaw ?? 0,
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
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: CURSOR_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderScene(value, false) }],
    },
    timeoutMs: CAPTURE_TIMEOUT_MS + 15_000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'Desktop pointer', kind: 'read' }),
    async execute(_args, exec) {
      assertWindows()
      assertScript()
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
}
