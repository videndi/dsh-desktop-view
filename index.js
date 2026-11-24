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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorIndexAt, renderScene } from './lib/scene.js'
import { parseKeyCombo, renderActionResult, renderElementAction, renderFind, renderUiTree, renderWait, renderWindowList, renderWindowOp } from './lib/control.js'
import { runPowerShellScript } from './lib/powershell.js'
import { DesktopHelper } from './lib/helper.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CAPTURE_SCRIPT = join(HERE, 'scripts', 'capture.ps1')
const CONTROL_SCRIPT = join(HERE, 'scripts', 'control.ps1')
const HELPER_SCRIPT = join(HERE, 'scripts', 'helper.ps1')
const DATA_DIR = join(homedir(), '.dsh', 'desktop-view')
const SNAPSHOT_DIR = join(DATA_DIR, 'snapshots')
const LIVE_DIR = join(DATA_DIR, 'live')
const STOP_FILE = join(DATA_DIR, 'STOP')
const KEEP_SNAPSHOTS = 40
const CAPTURE_TIMEOUT_MS = 30_000
const CONTROL_TIMEOUT_MS = 30_000
const MAX_TYPE_CHARS = 4000
const LIVE_INTERVAL_MS = 300
const LIVE_MAX_WIDTH = 480
const LIVE_IDLE_MS = 120_000
const MAX_ACTIONS_PER_SECOND = 12

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

const LIVE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['capturedAt', 'region', 'virtualScreen', 'monitors', 'dpiScale', 'cursor', 'foregroundWindow', 'windowUnderCursor', 'changed'],
  properties: {
    ...SNAPSHOT_OUTPUT.properties,
    changed: { type: 'boolean' },
    waited_ms: { type: 'integer' },
  },
}

const WAIT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['waited_ms', 'reason'],
  properties: {
    waited_ms: { type: 'integer' },
    reason: { type: 'string' },
    found: { type: 'boolean' },
    stable: { type: 'boolean' },
    signature: { type: 'string' },
    window: {
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
    },
  },
}

const UI_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type', 'automationId', 'className', 'x', 'y', 'width', 'height', 'enabled', 'focusable', 'offscreen', 'depth', 'patterns'],
  properties: {
    name: { type: 'string' },
    type: { type: 'string' },
    automationId: { type: 'string' },
    className: { type: 'string' },
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    enabled: { type: 'boolean' },
    focusable: { type: 'boolean' },
    offscreen: { type: 'boolean' },
    depth: { type: 'integer' },
    patterns: { type: 'array', items: { type: 'string' } },
    value: { type: 'string' },
    toggle: { type: 'string' },
  },
}

/** Compact element description for find/click-by-name results. */
const ELEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'type', 'automationId', 'className', 'x', 'y', 'width', 'height', 'enabled', 'patterns'],
  properties: {
    name: { type: 'string' },
    type: { type: 'string' },
    automationId: { type: 'string' },
    className: { type: 'string' },
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    enabled: { type: 'boolean' },
    focusable: { type: 'boolean' },
    offscreen: { type: 'boolean' },
    patterns: { type: 'array', items: { type: 'string' } },
    value: { type: 'string' },
    toggle: { type: 'string' },
  },
}

const FIND_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['found'],
  properties: {
    found: { type: 'boolean' },
    node: ELEMENT_SCHEMA,
    candidates: { type: 'array', items: ELEMENT_SCHEMA },
  },
}

const ELEMENT_ACTION_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['how', 'node'],
  properties: {
    how: { type: 'string' },
    node: ELEMENT_SCHEMA,
    text: { type: 'string' },
    pointer: POINT_SCHEMA,
    foreground: WINDOW_SCHEMA,
  },
}

const UI_TREE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['count', 'nodes'],
  properties: {
    count: { type: 'integer' },
    nodes: { type: 'array', items: UI_NODE_SCHEMA },
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

/* -------------------------------------------------- persistent desktop helper */

let helperInstance = null
let liveTimer = null
let liveFrame = null
let liveBusy = false
let liveLastUse = 0
let lastReturnedFingerprint = null
const actionTimestamps = []

function desktopHelper() {
  if (!helperInstance) {
    helperInstance = new DesktopHelper({
      script: HELPER_SCRIPT,
      stopFile: STOP_FILE,
      onLog: (message) => console.error(`[desktop-view] ${message}`),
    })
  }
  return helperInstance
}

function delay(ms) {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.() })
}

/**
 * A 32x18 grayscale fingerprint comes back with every grab. Comparing distances
 * instead of hashes is what lets "stable" survive an animated wallpaper or a
 * pet that redraws itself several times a second.
 */
function decodeFingerprint(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return null
  try { return Buffer.from(base64, 'base64') } catch { return null }
}

function fingerprintDistance(left, right) {
  if (!left || !right || left.length !== right.length) return Number.POSITIVE_INFINITY
  let total = 0
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index])
  return total / left.length
}

const CHANGE_THRESHOLD = 4
const STABLE_THRESHOLD = 2.5

function localIso() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** Refuse bursts: a runaway loop must not machine-gun the desktop. */
function throttle() {
  const now = Date.now()
  while (actionTimestamps.length > 0 && now - actionTimestamps[0] > 1000) actionTimestamps.shift()
  if (actionTimestamps.length >= MAX_ACTIONS_PER_SECOND) {
    throw new Error(`rate limit reached: ${MAX_ACTIONS_PER_SECOND} desktop actions per second; pause before continuing`)
  }
  actionTimestamps.push(now)
}

function assertNotStopped() {
  if (existsSync(STOP_FILE)) {
    throw new Error(`emergency stop is on: delete ${STOP_FILE} to allow desktop control again`)
  }
}

/* ----------------------------------------------------------------- live view */

function previewPagePath() {
  return join(LIVE_DIR, 'index.html')
}

function writePreviewPage() {
  const html = `<!doctype html>
<html lang="zh"><meta charset="utf-8"><title>desktop-view · live</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#070d18; color:#93a7c4; font:14px/1.5 system-ui, "Microsoft YaHei", sans-serif; }
  header { padding:10px 16px; display:flex; gap:12px; align-items:baseline; border-bottom:1px solid #1b2740; }
  strong { color:#e8eefc; font-weight:600; }
  img { display:block; width:100%; height:auto; background:#0b1220; }
  footer { padding:8px 16px; font-family: Consolas, monospace; font-size:12px; color:#5f7396; }
</style>
<header><strong>桌面视图 · 实时预览</strong><span>每 300 ms 刷新</span></header>
<img id="frame" alt="desktop" src="latest.jpg">
<footer id="meta"></footer>
<script>
  const img = document.getElementById('frame')
  const meta = document.getElementById('meta')
  let misses = 0
  setInterval(() => {
    img.src = 'latest.jpg?t=' + Date.now()
    meta.textContent = new Date().toLocaleTimeString() + (misses ? ' · 等待助手' : '')
  }, 300)
  img.onerror = () => { misses += 1 }
  img.onload = () => { misses = 0 }
</script>
</html>`
  try {
    mkdirSync(LIVE_DIR, { recursive: true })
    writeFileSync(previewPagePath(), html, 'utf8')
  } catch { /* preview is a convenience */ }
}

async function liveTick() {
  if (liveBusy) return
  if (liveTimer && Date.now() - liveLastUse > LIVE_IDLE_MS) {
    clearInterval(liveTimer)
    liveTimer = null
    return
  }
  liveBusy = true
  try {
    const frame = await desktopHelper().grab({
      path: join(LIVE_DIR, 'latest.jpg'),
      maxWidth: LIVE_MAX_WIDTH,
      quality: 65,
    })
    liveFrame = { ...frame, at: Date.now() }
  } catch { /* keep the previous frame */ }
  finally { liveBusy = false }
}

async function ensureLive() {
  liveLastUse = Date.now()
  if (liveTimer) return
  writePreviewPage()
  liveTimer = setInterval(() => { liveTick().catch(() => {}) }, LIVE_INTERVAL_MS)
  liveTimer.unref?.()
  await liveTick()
}

/* --------------------------------------------------------------- capture --- */

async function captureScene(options) {
  const instance = await desktopHelper().start()
  if (options.mode === 'cursor') {
    const info = await instance.call('info')
    const under = await instance.call('windowAt', { x: info.pointer.x, y: info.pointer.y })
    return {
      capturedAt: localIso(),
      region: {
        x: info.virtualScreen.x, y: info.virtualScreen.y,
        width: info.virtualScreen.width, height: info.virtualScreen.height,
        kind: 'virtual-desktop',
      },
      virtualScreen: info.virtualScreen,
      monitors: info.monitors,
      dpiScale: Math.round((info.dpi / 96) * 1000) / 1000,
      cursor: {
        screenX: info.pointer.x, screenY: info.pointer.y,
        imageX: info.pointer.x, imageY: info.pointer.y, onImage: true,
      },
      foregroundWindow: info.foreground,
      windowUnderCursor: under.window,
    }
  }

  const frame = await instance.grab({
    path: options.pngPath,
    maxWidth: options.maxWidth ?? 0,
    markCursor: options.markCursor !== false,
    quality: 88,
    ...(options.monitor ? { monitor: options.monitor } : {}),
  })
  const info = await instance.call('info')
  const under = await instance.call('windowAt', { x: frame.cursor.x, y: frame.cursor.y })
  const scale = frame.sourceWidth > 0 ? Math.round((frame.width / frame.sourceWidth) * 10000) / 10000 : 1
  const onImage = frame.cursor.x >= frame.region.x && frame.cursor.x < frame.region.x + frame.region.width
    && frame.cursor.y >= frame.region.y && frame.cursor.y < frame.region.y + frame.region.height
  return {
    capturedAt: localIso(),
    region: {
      x: frame.region.x, y: frame.region.y, width: frame.region.width, height: frame.region.height,
      kind: options.monitor ? `monitor ${options.monitor}` : 'virtual-desktop',
    },
    virtualScreen: info.virtualScreen,
    monitors: info.monitors,
    dpiScale: Math.round((info.dpi / 96) * 1000) / 1000,
    cursor: {
      screenX: frame.cursor.x,
      screenY: frame.cursor.y,
      imageX: Math.round((frame.cursor.x - frame.region.x) * scale),
      imageY: Math.round((frame.cursor.y - frame.region.y) * scale),
      onImage,
    },
    foregroundWindow: frame.foreground,
    windowUnderCursor: under.window,
    image: {
      path: options.pngPath,
      width: frame.width,
      height: frame.height,
      sourceWidth: frame.sourceWidth,
      sourceHeight: frame.sourceHeight,
      scale,
      bytes: frame.bytes,
    },
  }
}

async function runCapture(options) {
  try {
    return await captureScene(options)
  } catch (error) {
    console.error(`[desktop-view] persistent helper capture failed (${error.message}); falling back to the one-shot helper`)
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
}

async function runControl(request, signal, timeoutMs = CONTROL_TIMEOUT_MS) {
  try {
    const instance = await desktopHelper().start()
    const reply = await instance.call(request.action, { ...request }, { timeoutMs })
    if (request.action === 'type') reply.chars = reply.typed
    return reply
  } catch (error) {
    if (signal?.aborted) throw error
    console.error(`[desktop-view] persistent helper input failed (${error.message}); falling back to the one-shot helper`)
    return runPowerShellScript({ script: CONTROL_SCRIPT, request, signal, timeoutMs })
  }
}

const INTERACTIVE_TYPES = new Set([
  'Button', 'Edit', 'ComboBox', 'CheckBox', 'RadioButton', 'MenuItem', 'ListItem',
  'TabItem', 'Hyperlink', 'TreeItem', 'Slider', 'Spinner', 'MenuItem',
])

/** Controls worth showing by default: the ones an action could land on. */
function isInteractiveNode(node) {
  if (node.depth <= 1) return true
  if (Array.isArray(node.patterns) && node.patterns.length > 0) return true
  return INTERACTIVE_TYPES.has(node.type)
}

/** Shared addressing payload for the element tools. */
function elementQuery(args) {
  const payload = {
    depth: optionalInteger(args?.depth, 'depth', 6, 1, 8),
    max: optionalInteger(args?.max, 'max', 400, 1, 400),
  }
  if (args?.hwnd) payload.hwnd = String(args.hwnd)
  else if (args?.title) payload.title = String(args.title)
  if (args?.x !== undefined || args?.y !== undefined) {
    payload.x = requireInteger(args?.x, 'x', -100_000, 100_000)
    payload.y = requireInteger(args?.y, 'y', -100_000, 100_000)
  }
  if (args?.name) payload.name = String(args.name)
  if (args?.automation_id) payload.automationId = String(args.automation_id)
  if (args?.type) payload.type = String(args.type)
  return payload
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
  // A reload must not leave the previous helper (and its live timer) running.
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null }
      if (helperInstance) { helperInstance.dispose(); helperInstance = null }
      liveFrame = null
      lastReturnedFingerprint = null
    })
  }

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
      assertNotStopped()
      throttle()
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
      assertNotStopped()
      throttle()
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
      assertNotStopped()
      throttle()
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
      assertNotStopped()
      throttle()
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
      assertNotStopped()
      throttle()
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
      assertNotStopped()
      throttle()
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
      assertNotStopped()
      throttle()

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

  /* ------------------------------------------------------------- live view */

  register({
    name: 'desktop_live',
    description: 'Look at the screen now, served by the always-on helper (about 0.2 s instead of the 0.7 s a cold capture costs), so it can be called in a loop while working. With until "change" and wait_ms it waits until the picture actually changes before answering — that is how a click gets confirmed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_width: { type: 'integer', description: 'Downscale to at most this width. Omit for 960; 0 keeps native resolution.' },
        only_if_changed: { type: 'boolean', description: 'When the screen is identical to the last frame returned, answer with state only and no image. Defaults to true.' },
        mark_cursor: { type: 'boolean', description: 'Draw a ring at the pointer. Defaults to true.' },
        until: { type: 'string', enum: ['change'], description: 'Wait until the screen changes before returning. Needs wait_ms.' },
        wait_ms: { type: 'integer', description: 'Upper bound for the wait, 0 to 30000 ms. Defaults to 0.' },
      },
    },
    output: {
      schema: LIVE_OUTPUT,
      render: (_args, value) => {
        const content = [{ type: 'text', text: renderScene(value, value.attachment !== undefined) }]
        if (value.attachment) content.push({ type: 'image', attachment: value.attachment })
        return content
      },
      presentationMeta: (_args, value) => ({ path: value.image.path }),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: args?.until === 'change' ? 'Desktop live (waiting for change)' : 'Desktop live', kind: 'read' }),
    async execute(args, exec) {
      assertWindows('desktop observation')
      mkdirSync(SNAPSHOT_DIR, { recursive: true })
      const maxWidth = optionalInteger(args?.max_width, 'max_width', 960, 0, 3840)
      const waitMs = optionalInteger(args?.wait_ms, 'wait_ms', 0, 0, 30_000)
      await ensureLive()
      const before = decodeFingerprint(liveFrame?.fingerprint)
      const started = Date.now()
      let changed = false
      if (args?.until === 'change' && waitMs > 0) {
        while (Date.now() - started < waitMs) {
          await delay(100)
          const now = decodeFingerprint(liveFrame?.fingerprint)
          if (now && fingerprintDistance(before, now) > CHANGE_THRESHOLD) { changed = true; break }
        }
      } else if (waitMs > 0) {
        await delay(waitMs)
      }
      // Unchanged screen: answer with state only, no pixels. That is the single
      // biggest token saving in a loop, and the frame adds nothing when the
      // picture is byte-identical to the one just returned.
      const currentPrint = decodeFingerprint(liveFrame?.fingerprint)
      const unchanged = lastReturnedFingerprint !== null && currentPrint !== null
        && fingerprintDistance(lastReturnedFingerprint, currentPrint) < STABLE_THRESHOLD
      if (args?.only_if_changed !== false && unchanged) {
        const info = await desktopHelper().call('info')
        const under = await desktopHelper().call('windowAt', { x: info.pointer.x, y: info.pointer.y })
        const region = { x: info.virtualScreen.x, y: info.virtualScreen.y, width: info.virtualScreen.width, height: info.virtualScreen.height, kind: 'virtual-desktop' }
        return {
          capturedAt: localIso(),
          region,
          virtualScreen: info.virtualScreen,
          monitors: info.monitors,
          dpiScale: Math.round((info.dpi / 96) * 1000) / 1000,
          cursor: { screenX: info.pointer.x, screenY: info.pointer.y, imageX: info.pointer.x, imageY: info.pointer.y, onImage: true },
          foregroundWindow: info.foreground,
          windowUnderCursor: under.window,
          changed: false,
          waited_ms: Date.now() - started,
        }
      }
      pruneSnapshots(SNAPSHOT_DIR)
      const pngPath = join(SNAPSHOT_DIR, `live-${timestampSlug()}.png`)
      const scene = await runCapture({ mode: 'snapshot', pngPath, maxWidth, markCursor: args?.mark_cursor !== false })
      const value = {
        ...scene,
        cursor: { ...scene.cursor, monitorIndex: monitorIndexAt(scene.monitors, scene.cursor.screenX, scene.cursor.screenY) },
        changed,
        waited_ms: Date.now() - started,
      }
      lastReturnedFingerprint = currentPrint
      await attachCapture(ctx, exec, value)
      return value
    },
  })

  register({
    name: 'desktop_wait',
    description: 'Wait for something to be ready before acting. Give title to wait until a window whose title contains it exists, or stable_ms to wait until the screen stops changing (for example after a click). Returns what happened and how long it took, so the next step starts from a settled screen instead of a guess.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Window title substring, case-insensitive. When set, waits for such a window instead of for stability.' },
        stable_ms: { type: 'integer', description: 'How long the screen must stay unchanged, 0 to 30000 ms. Defaults to 400 when no title is given.' },
        timeout_ms: { type: 'integer', description: 'Give up after this long, 200 to 120000 ms. Defaults to 10000.' },
      },
    },
    output: { schema: WAIT_OUTPUT, render: (_args, value) => [{ type: 'text', text: renderWait(value) }] },
    timeoutMs: 130_000,
    presentCall: (args) => ({ card: 'generic', title: args?.title ? `Wait for window "${args.title}"` : 'Wait for a stable screen', kind: 'other' }),
    async execute(args, exec) {
      assertWindows('desktop observation')
      const title = typeof args?.title === 'string' && args.title.trim().length > 0 ? args.title.trim() : undefined
      const timeoutMs = optionalInteger(args?.timeout_ms, 'timeout_ms', 10_000, 200, 120_000)
      const stableMs = optionalInteger(args?.stable_ms, 'stable_ms', title ? 0 : 400, 0, 30_000)
      const started = Date.now()
      const instance = await desktopHelper().start()

      if (title) {
        while (Date.now() - started < timeoutMs) {
          const reply = await instance.call('windows', { filter: title, limit: 5 })
          if (reply.windows.length > 0) {
            return { waited_ms: Date.now() - started, reason: 'window', found: true, window: reply.windows[0] }
          }
          await delay(150)
        }
        return { waited_ms: Date.now() - started, reason: 'window', found: false }
      }

      let last = null
      let since = Date.now()
      while (Date.now() - started < timeoutMs) {
        const frame = await instance.grab({ path: join(LIVE_DIR, 'wait.jpg'), maxWidth: 320, quality: 60 })
        const print = decodeFingerprint(frame.fingerprint)
        if (!last || fingerprintDistance(last, print) > STABLE_THRESHOLD) {
          last = print
          since = Date.now()
        } else if (Date.now() - since >= stableMs) {
          return { waited_ms: Date.now() - started, reason: 'stable', stable: true, signature: frame.signature }
        }
        await delay(120)
      }
      return { waited_ms: Date.now() - started, reason: 'stable', stable: false, signature: last ? String(liveFrame?.signature ?? '') : '' }
    },
  })

  register({
    name: 'desktop_ui_tree',
    description: 'List the controls Windows exposes for a window or a point, with the actions each one supports. Interactive controls only by default; set interactive_only false to see the whole tree.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Window title substring. Ignored when hwnd or a point is given.' },
        hwnd: { type: 'string', description: 'Exact window handle from desktop_window, as a hex string.' },
        x: { type: 'integer', description: 'Screen x of a point; pair it with y to inspect only that element subtree.' },
        y: { type: 'integer', description: 'Screen y; pair it with x.' },
        depth: { type: 'integer', description: 'How deep to walk, 1 to 8. Defaults to 3.' },
        max: { type: 'integer', description: 'Maximum nodes to return, 1 to 400. Defaults to 60.' },
        interactive_only: { type: 'boolean', description: 'Keep only controls that can be acted on. Defaults to true.' },
      },
    },
    output: { schema: UI_TREE_OUTPUT, render: (_args, value) => [{ type: 'text', text: renderUiTree(value) }] },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: args?.title ? `UI tree: ${args.title}` : 'UI tree', kind: 'read' }),
    async execute(args, exec) {
      assertWindows('desktop observation')
      const hasPoint = args?.x !== undefined || args?.y !== undefined
      if (hasPoint && (args?.x === undefined || args?.y === undefined)) {
        throw new Error('give both x and y, or neither')
      }
      const payload = {
        depth: optionalInteger(args?.depth, 'depth', 3, 1, 8),
        max: optionalInteger(args?.max, 'max', 60, 1, 400),
      }
      if (args?.hwnd) payload.hwnd = String(args.hwnd)
      else if (args?.title) payload.title = String(args.title)
      if (hasPoint) {
        payload.x = requireInteger(args.x, 'x', -100_000, 100_000)
        payload.y = requireInteger(args.y, 'y', -100_000, 100_000)
      }
      const instance = await desktopHelper().start()
      const reply = await instance.call('uia', payload, { timeoutMs: 30_000 })
      const nodes = args?.interactive_only === false ? reply.nodes : reply.nodes.filter(isInteractiveNode)
      return { count: nodes.length, nodes }
    },
  })

  register({
    name: 'desktop_find',
    description: 'Find one control by name, automation id or type inside a window, so the next step can act on the control itself. On no match it returns a short list of the interactive controls that are there.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Window title substring. Ignored when hwnd or a point is given.' },
        hwnd: { type: 'string', description: 'Exact window handle from desktop_window.' },
        x: { type: 'integer', description: 'Screen x of a point; pair it with y to search only that element subtree.' },
        y: { type: 'integer', description: 'Screen y; pair it with x.' },
        name: { type: 'string', description: 'Visible label, matched case-insensitively as a substring.' },
        automation_id: { type: 'string', description: 'Exact automation id, when the control exposes one.' },
        type: { type: 'string', description: 'Control type such as Button, Edit, MenuItem, TabItem.' },
        depth: { type: 'integer', description: 'How deep to search, 1 to 8. Defaults to 6.' },
        max: { type: 'integer', description: 'Maximum elements visited, 1 to 400. Defaults to 400.' },
      },
    },
    output: { schema: FIND_OUTPUT, render: (_args, value) => [{ type: 'text', text: renderFind(value) }] },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: args?.name ? `Find "${args.name}"` : 'Find a control', kind: 'read' }),
    async execute(args, exec) {
      assertWindows('desktop observation')
      if (!args?.name && !args?.automation_id && !args?.type) {
        throw new Error('give name, automation_id or type to identify the control')
      }
      const instance = await desktopHelper().start()
      const payload = elementQuery(args)
      const reply = await instance.call('uiaFind', payload, { timeoutMs: 30_000 })
      if (reply.found) return { found: true, node: reply.node }
      const tree = await instance.call('uia', { ...payload, depth: Math.min(payload.depth, 4), max: 120 }, { timeoutMs: 30_000 })
      const candidates = tree.nodes.filter(isInteractiveNode).slice(0, 8)
      return { found: false, candidates }
    },
  })

  register({
    name: 'desktop_click_element',
    description: 'Activate a control by name, automation id or type — invoke, toggle, select or expand, whichever it supports — so no coordinate is needed. Falls back to a click at the control rectangle only for controls that expose no action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'Window title substring. Ignored when hwnd or a point is given.' },
        hwnd: { type: 'string', description: 'Exact window handle from desktop_window.' },
        x: { type: 'integer', description: 'Screen x of a point; pair it with y to search only that element subtree.' },
        y: { type: 'integer', description: 'Screen y; pair it with x.' },
        name: { type: 'string', description: 'Visible label, matched case-insensitively as a substring.' },
        automation_id: { type: 'string', description: 'Exact automation id, when the control exposes one.' },
        type: { type: 'string', description: 'Control type such as Button, Edit, MenuItem, TabItem.' },
        depth: { type: 'integer', description: 'How deep to search, 1 to 8. Defaults to 6.' },
        max: { type: 'integer', description: 'Maximum elements visited, 1 to 400. Defaults to 400.' },
      },
    },
    output: { schema: ELEMENT_ACTION_OUTPUT, render: (args, value) => [{ type: 'text', text: renderElementAction('clicked', value) }] },
    timeoutMs: 60_000,
    presentCall: (args) => ({ card: 'generic', title: args?.name ? `Click "${args.name}"` : 'Click a control', kind: 'other' }),
    async execute(args, exec) {
      assertWindows('desktop input')
      assertControlEnabled()
      assertNotStopped()
      throttle()
      if (!args?.name && !args?.automation_id && !args?.type) {
        throw new Error('give name, automation_id or type to identify the control')
      }
      const instance = await desktopHelper().start()
      const reply = await instance.call('uiaInvoke', elementQuery(args), { timeoutMs: 30_000 })
      return { how: reply.how, node: reply.node, pointer: reply.pointer, foreground: reply.foreground }
    },
  })

  register({
    name: 'desktop_set_text',
    description: 'Put text into a field identified by name, automation id or type: value pattern where the control supports it, typing where it does not.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        title: { type: 'string', description: 'Window title substring. Ignored when hwnd or a point is given.' },
        hwnd: { type: 'string', description: 'Exact window handle from desktop_window.' },
        x: { type: 'integer', description: 'Screen x of a point; pair it with y to search only that element subtree.' },
        y: { type: 'integer', description: 'Screen y; pair it with x.' },
        name: { type: 'string', description: 'Visible label, matched case-insensitively as a substring.' },
        automation_id: { type: 'string', description: 'Exact automation id, when the control exposes one.' },
        type: { type: 'string', description: 'Control type such as Edit or Document.' },
        text: { type: 'string', description: 'Text to put in the field; replaces its current contents.' },
        depth: { type: 'integer', description: 'How deep to search, 1 to 8. Defaults to 6.' },
        max: { type: 'integer', description: 'Maximum elements visited, 1 to 400. Defaults to 400.' },
      },
    },
    output: { schema: ELEMENT_ACTION_OUTPUT, render: (args, value) => [{ type: 'text', text: renderElementAction('filled', value) }] },
    timeoutMs: 60_000,
    presentCall: (args) => ({ card: 'generic', title: 'Fill a field', kind: 'other' }),
    async execute(args, exec) {
      assertWindows('desktop input')
      assertControlEnabled()
      assertNotStopped()
      throttle()
      if (typeof args?.text !== 'string' || args.text.length === 0) throw new Error('text must not be empty')
      const instance = await desktopHelper().start()
      const reply = await instance.call('uiaSetValue', { ...elementQuery(args), text: args.text }, { timeoutMs: 30_000 })
      return { how: reply.how, node: reply.node, text: reply.text, pointer: reply.pointer, foreground: reply.foreground }
    },
  })
}
