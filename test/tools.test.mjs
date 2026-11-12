import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** Collect the definitions registered through a stub context. */
function registeredTools() {
  const tools = new Map()
  apply({
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: () => undefined,
  })
  return tools
}

/** Keywords the harness enforces for tool schemas; anything else is rejected at registration. */
const ALLOWED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])

/** Walk a schema and fail on any keyword outside the supported subset. */
function assertSchemaSubset(node, path = 'schema') {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return
  for (const [key, value] of Object.entries(node)) {
    assert.ok(ALLOWED_KEYWORDS.has(key), `${path}.${key} is outside the enforced JSON-schema subset`)
    if (key === 'properties') {
      for (const [name, child] of Object.entries(value)) assertSchemaSubset(child, `${path}.properties.${name}`)
    } else if (key === 'items' || key === 'oneOf') {
      const children = Array.isArray(value) ? value : [value]
      children.forEach((child, index) => assertSchemaSubset(child, `${path}.${key}[${index}]`))
    } else if (key === 'required') {
      assert.ok(Array.isArray(value) && value.every((name) => typeof name === 'string'), `${path}.required must be a string array`)
    }
  }
}

const tools = registeredTools()
const exec = { signal: new AbortController().signal }

const OBSERVE = ['desktop_cursor', 'desktop_snapshot']
const INPUT = ['desktop_click', 'desktop_drag', 'desktop_key', 'desktop_move', 'desktop_scroll', 'desktop_type', 'desktop_window']

test('registers the two observation tools and the seven input tools', () => {
  assert.deepEqual([...tools.keys()].sort(), [...OBSERVE, ...INPUT].sort())
  for (const [name, definition] of tools) {
    assert.match(name, /^[a-z][a-z0-9_]*$/)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 60, `${name} needs a model-facing description`)
    assert.equal(definition.parameters.type, 'object', `${name} parameters must be an object root`)
    assert.equal(definition.output.schema.type, 'object', `${name} output must be an object root`)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('every schema stays inside the enforced keyword subset', () => {
  for (const [name, definition] of tools) {
    assertSchemaSubset(definition.parameters, `${name}.parameters`)
    assertSchemaSubset(definition.output.schema, `${name}.output.schema`)
  }
})

test('input tools leave the desktop in a reported state', () => {
  for (const name of INPUT) {
    if (name === 'desktop_window') continue
    const { required } = tools.get(name).output.schema
    assert.ok(required.includes('action'), `${name} must report the action`)
    assert.ok(required.includes('pointer'), `${name} must report the pointer afterwards`)
    assert.ok(required.includes('foreground'), `${name} must report the foreground window afterwards`)
  }
  const windowProperties = Object.keys(tools.get('desktop_window').output.schema.properties)
  for (const branch of ['windows', 'total', 'truncated', 'window', 'focused', 'closed', 'pointer', 'foreground']) {
    assert.ok(windowProperties.includes(branch), `desktop_window must describe "${branch}"`)
  }
})

test('parameter defaults and descriptions are documented on the parameters', () => {
  const { properties } = tools.get('desktop_snapshot').parameters
  assert.deepEqual(Object.keys(properties).sort(), ['mark_cursor', 'max_width', 'monitor'])
  for (const [name, property] of Object.entries(properties)) {
    assert.ok(property.description.length > 10, `${name} needs a description`)
  }

  const click = tools.get('desktop_click').parameters.properties
  assert.deepEqual(click.button.enum, ['left', 'right', 'middle'])
  assert.match(click.x.description, /Omit x and y together/)

  const window = tools.get('desktop_window').parameters.properties
  assert.deepEqual(window.operation.enum, ['list', 'focus', 'minimize', 'maximize', 'restore', 'close'])
})

test('snapshot renders text plus an image block only when one is attached', () => {
  const tool = tools.get('desktop_snapshot')
  const base = {
    capturedAt: '2026-01-02T03:04:05+08:00',
    region: { x: 0, y: 0, width: 100, height: 50, kind: 'monitor 1' },
    virtualScreen: { x: 0, y: 0, width: 100, height: 50 },
    monitors: [{ index: 1, x: 0, y: 0, width: 100, height: 50, primary: true }],
    dpiScale: 2,
    cursor: { screenX: 10, screenY: 20, imageX: 10, imageY: 20, onImage: true, monitorIndex: 1 },
    foregroundWindow: { hwnd: '0x1', title: 'T', className: 'C', processId: 1, processName: 'app' },
    windowUnderCursor: { hwnd: '0x2', title: 'T', className: 'C', processId: 1, processName: 'app' },
    image: { path: 'C:\\shot.png', width: 100, height: 50, sourceWidth: 100, sourceHeight: 50, scale: 1, bytes: 10 },
  }

  const textOnly = tool.output.render({}, base)
  assert.deepEqual(textOnly.map((block) => block.type), ['text'])

  const attachment = {
    attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 10, width: 100, height: 50, name: 'shot.png',
  }
  const withImage = tool.output.render({}, { ...base, attachment })
  assert.deepEqual(withImage.map((block) => block.type), ['text', 'image'])
  assert.deepEqual(withImage[1].attachment, attachment)
})

test('window tool renders a list and an operation differently', () => {
  const windowTool = tools.get('desktop_window')
  const list = windowTool.output.render({}, {
    action: 'list',
    windows: [{
      hwnd: '0x00090918', title: 'Untitled - Notepad', className: 'Notepad', processId: 42, processName: 'notepad',
      x: 1, y: 2, width: 800, height: 600, minimized: false, foreground: true,
    }],
    total: 1,
    truncated: false,
  })
  assert.match(list[0].text, /^<desktop-windows>/)

  const op = windowTool.output.render({}, {
    action: 'focus',
    window: { hwnd: '0x00090918', title: 'Untitled - Notepad', className: 'Notepad', processId: 42, processName: 'notepad' },
    focused: true,
    closed: false,
    pointer: { x: 10, y: 20 },
    foreground: { hwnd: '0x00090918', title: 'Untitled - Notepad', className: 'Notepad', processId: 42, processName: 'notepad' },
  })
  assert.match(op[0].text, /^<desktop-action>/)
})

test('input tools reject invalid arguments before touching the desktop', async () => {
  await assert.rejects(tools.get('desktop_move').execute({ x: 'a', y: 2 }, exec), /must be an integer/)
  await assert.rejects(tools.get('desktop_click').execute({ x: 1 }, exec), /give both x and y/)
  await assert.rejects(tools.get('desktop_click').execute({ button: 'sideways' }, exec), /left, right, or middle/)
  await assert.rejects(tools.get('desktop_click').execute({ count: 9 }, exec), /count must be between 1 and 5/)
  await assert.rejects(tools.get('desktop_drag').execute({ from_x: 1, from_y: 2, to_x: 3 }, exec), /must be an integer/)
  await assert.rejects(tools.get('desktop_scroll').execute({ delta: 0 }, exec), /non-zero/)
  await assert.rejects(tools.get('desktop_scroll').execute({ delta: 3, x: 1 }, exec), /give both x and y/)
  await assert.rejects(tools.get('desktop_type').execute({ text: '' }, exec), /non-empty/)
  await assert.rejects(tools.get('desktop_type').execute({ text: 'x'.repeat(4001) }, exec), /limited to 4000/)
  await assert.rejects(tools.get('desktop_key').execute({ keys: 'hyper+x' }, exec), /not a modifier/)
  await assert.rejects(tools.get('desktop_key').execute({ keys: 'ctrl+nope' }, exec), /unknown key/)
  await assert.rejects(tools.get('desktop_window').execute({ operation: 'explode' }, exec), /operation must be/)
  await assert.rejects(tools.get('desktop_window').execute({ operation: 'close' }, exec), /give title or hwnd/)
  await assert.rejects(tools.get('desktop_window').execute({ operation: 'focus' }, exec), /give title or hwnd/)
  await assert.rejects(tools.get('desktop_snapshot').execute({ monitor: 0 }, exec), /monitor must be between/)
  await assert.rejects(tools.get('desktop_snapshot').execute({ max_width: -1 }, exec), /max_width must be between/)
})

test('capture and input are refused off Windows', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(tools.get('desktop_snapshot').execute({}, exec), /Windows only/)
  await assert.rejects(tools.get('desktop_cursor').execute({}, exec), /Windows only/)
  await assert.rejects(tools.get('desktop_move').execute({ x: 1, y: 1 }, exec), /Windows only/)
  await assert.rejects(tools.get('desktop_click').execute({}, exec), /Windows only/)
  await assert.rejects(tools.get('desktop_type').execute({ text: 'hi' }, exec), /Windows only/)
  await assert.rejects(tools.get('desktop_window').execute({ operation: 'list' }, exec), /Windows only/)
})
