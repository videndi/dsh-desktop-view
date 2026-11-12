import test from 'node:test'
import assert from 'node:assert/strict'
import { monitorIndexAt, formatRect, formatWindow, renderScene } from '../lib/scene.js'

const snapshotValue = {
  capturedAt: '2026-01-02T03:04:05+08:00',
  region: { x: -2560, y: 0, width: 4480, height: 1440, kind: 'virtual-desktop' },
  virtualScreen: { x: -2560, y: 0, width: 4480, height: 1440 },
  monitors: [
    { index: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true },
    { index: 2, x: -2560, y: 0, width: 2560, height: 1440, primary: false },
  ],
  dpiScale: 1.5,
  cursor: { screenX: 100, screenY: 200, imageX: 50, imageY: 100, onImage: true, monitorIndex: 1 },
  foregroundWindow: { title: 'Untitled - Notepad', className: 'Notepad', processId: 42, processName: 'notepad' },
  windowUnderCursor: { title: '', className: 'WorkerW', processId: 7, processName: 'explorer' },
  image: {
    path: 'C:\\Users\\me\\.dsh\\desktop-view\\snapshots\\desktop-1.png',
    width: 2240,
    height: 720,
    sourceWidth: 4480,
    sourceHeight: 1440,
    scale: 0.5,
    bytes: 123456,
  },
}

test('formatRect and formatWindow render the documented shapes', () => {
  assert.equal(formatRect({ x: -2560, y: 0, width: 2560, height: 1440 }), '2560x1440 at (-2560, 0)')
  assert.equal(
    formatWindow('foreground', { title: 'A', className: 'C', processId: 9, processName: 'app' }),
    'foreground: app (pid 9) "A"',
  )
  assert.equal(
    formatWindow('under pointer', { title: '', className: 'WorkerW', processId: 0, processName: '' }),
    'under pointer: WorkerW',
  )
})

test('monitorIndexAt handles negative origins and outside points', () => {
  const monitors = snapshotValue.monitors
  assert.equal(monitorIndexAt(monitors, 100, 100), 1)
  assert.equal(monitorIndexAt(monitors, -100, 100), 2)
  assert.equal(monitorIndexAt(monitors, -2560, 0), 2)
  assert.equal(monitorIndexAt(monitors, 1920, 0), 0)
  assert.equal(monitorIndexAt(monitors, 0, 5000), 0)
})

test('renderScene names the capture, the downscale, monitors and both windows', () => {
  const text = renderScene(snapshotValue, false)
  assert.match(text, /^<desktop>\n/)
  assert.match(text, /captured: 2026-01-02T03:04:05\+08:00/)
  assert.match(text, /region: virtual-desktop — 4480x1440 at \(-2560, 0\)/)
  assert.match(text, /downscaled from 4480x1440/)
  assert.match(text, /pointer: screen \(100, 200\) · image \(50, 100\) · monitor 1/)
  assert.match(text, /- 1: 1920x1080 at \(0, 0\) primary/)
  assert.match(text, /- 2: 2560x1440 at \(-2560, 0\)\n/)
  assert.match(text, /foreground: notepad \(pid 42\) "Untitled - Notepad"/)
  assert.match(text, /under pointer: explorer \(pid 7\)/)
  assert.match(text, /display scale: 150%/)
  assert.match(text, /pixels: not inlined/)
  assert.match(text, /\n<\/desktop>$/)
})

test('renderScene drops the inlining hint when the image is attached', () => {
  assert.doesNotMatch(renderScene(snapshotValue, true), /pixels: not inlined/)
})

test('renderScene reports a pointer outside the captured region', () => {
  const value = {
    ...snapshotValue,
    cursor: { screenX: 100, screenY: 200, imageX: 0, imageY: 0, onImage: false, monitorIndex: 1 },
  }
  assert.match(renderScene(value, false), /pointer: screen \(100, 200\) · outside the captured region · monitor 1/)
})

test('renderScene omits image lines for a pointer-only observation', () => {
  const value = {
    capturedAt: '2026-01-02T03:04:05+08:00',
    region: { x: 0, y: 0, width: 1920, height: 1080, kind: 'virtual-desktop' },
    virtualScreen: { x: 0, y: 0, width: 1920, height: 1080 },
    monitors: [{ index: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true }],
    dpiScale: 1,
    cursor: { screenX: 10, screenY: 20, monitorIndex: 1 },
    foregroundWindow: { title: '', className: '', processId: 0, processName: '' },
    windowUnderCursor: { title: '', className: '', processId: 0, processName: '' },
  }
  const text = renderScene(value, false)
  assert.doesNotMatch(text, /^image:/m)
  assert.doesNotMatch(text, /pixels:/)
  assert.doesNotMatch(text, /display scale/)
  assert.match(text, /pointer: screen \(10, 20\) · monitor 1/)
})
