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

/** Keywords the harness enforces for tool output schemas; anything else is rejected at registration. */
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

test('registers exactly the two read-only tools', () => {
  assert.deepEqual([...tools.keys()].sort(), ['desktop_cursor', 'desktop_snapshot'])
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

test('parameter defaults and descriptions are documented on the parameters', () => {
  const { properties } = tools.get('desktop_snapshot').parameters
  assert.deepEqual(Object.keys(properties).sort(), ['mark_cursor', 'max_width', 'monitor'])
  assert.equal(properties.mark_cursor.type, 'boolean')
  assert.equal(properties.monitor.type, 'integer')
  assert.equal(properties.max_width.type, 'integer')
  for (const [name, property] of Object.entries(properties)) {
    assert.ok(property.description.length > 10, `${name} needs a description`)
  }
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
    foregroundWindow: { title: 'T', className: 'C', processId: 1, processName: 'app' },
    windowUnderCursor: { title: 'T', className: 'C', processId: 1, processName: 'app' },
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

test('snapshot rejects an invalid monitor argument before touching the desktop', async () => {
  const exec = { signal: new AbortController().signal }
  await assert.rejects(tools.get('desktop_snapshot').execute({ monitor: 0 }, exec), /monitor must be a positive integer/)
  await assert.rejects(tools.get('desktop_snapshot').execute({ max_width: -1 }, exec), /max_width must be a non-negative integer/)
})

test('capture is refused off Windows', { skip: process.platform === 'win32' }, async () => {
  const exec = { signal: new AbortController().signal }
  await assert.rejects(tools.get('desktop_snapshot').execute({}, exec), /Windows only/)
  await assert.rejects(tools.get('desktop_cursor').execute({}, exec), /Windows only/)
})
