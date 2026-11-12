import test from 'node:test'
import assert from 'node:assert/strict'
import {
  keyToVirtualKey,
  parseKeyCombo,
  renderActionResult,
  renderWindowList,
  renderWindowOp,
} from '../lib/control.js'

const foreground = {
  hwnd: '0x00090918',
  title: 'Untitled - Notepad',
  className: 'Notepad',
  processId: 42,
  processName: 'notepad',
}

const pointer = { x: 10, y: 20 }

test('key names resolve to virtual keys and extended keys', () => {
  assert.deepEqual(keyToVirtualKey('enter'), { vk: 0x0D, extended: false })
  assert.deepEqual(keyToVirtualKey('tab'), { vk: 0x09, extended: false })
  assert.deepEqual(keyToVirtualKey('delete'), { vk: 0x2E, extended: true })
  assert.deepEqual(keyToVirtualKey('left'), { vk: 0x25, extended: true })
  assert.deepEqual(keyToVirtualKey('a'), { vk: 65, extended: false })
  assert.deepEqual(keyToVirtualKey('0'), { vk: 0x30, extended: false })
  assert.deepEqual(keyToVirtualKey('f5'), { vk: 0x74, extended: false })
  assert.deepEqual(keyToVirtualKey('f24'), { vk: 0x87, extended: false })
  assert.equal(keyToVirtualKey('nope'), undefined)
})

test('parseKeyCombo normalizes modifiers, aliases and case', () => {
  assert.deepEqual(parseKeyCombo('ctrl+shift+Esc'), {
    modifierVks: [0x11, 0x10],
    keyVk: 0x1B,
    extended: false,
    keys: 'ctrl+shift+esc',
  })
  assert.deepEqual(parseKeyCombo(' control + C '), {
    modifierVks: [0x11],
    keyVk: 67,
    extended: false,
    keys: 'ctrl+c',
  })
  assert.deepEqual(parseKeyCombo('enter'), {
    modifierVks: [],
    keyVk: 0x0D,
    extended: false,
    keys: 'enter',
  })
  assert.deepEqual(parseKeyCombo('win+r'), {
    modifierVks: [0x5B],
    keyVk: 82,
    extended: false,
    keys: 'win+r',
  })
  assert.deepEqual(parseKeyCombo('Ctrl+ctrl+a').modifierVks, [0x11])
})

test('parseKeyCombo rejects shapes it cannot press', () => {
  assert.throws(() => parseKeyCombo(''), /at least one key/)
  assert.throws(() => parseKeyCombo('hyper+x'), /not a modifier/)
  assert.throws(() => parseKeyCombo('ctrl+nope'), /unknown key/)
})

test('renderActionResult summarizes each input action', () => {
  assert.match(
    renderActionResult({ action: 'move', to: { x: 1, y: 2 }, pointer, foreground }),
    /moved the pointer to \(1, 2\) · pointer \(10, 20\)/,
  )
  assert.match(
    renderActionResult({ action: 'click', button: 'left', count: 2, at: { x: 30, y: 40 }, pointer, foreground }),
    /clicked left 2 times at \(30, 40\)/,
  )
  assert.match(
    renderActionResult({ action: 'drag', button: 'left', from: { x: 1, y: 2 }, to: { x: 8, y: 9 }, steps: 12, pointer, foreground }),
    /dragged left from \(1, 2\) to \(8, 9\)/,
  )
  assert.match(
    renderActionResult({ action: 'scroll', delta: -3, horizontal: false, at: { x: 5, y: 6 }, pointer, foreground }),
    /scrolled 3 notches down at \(5, 6\)/,
  )
  assert.match(
    renderActionResult({ action: 'type', chars: 7, pointer, foreground }),
    /typed 7 characters/,
  )
  assert.match(
    renderActionResult({ action: 'key', keys: 'ctrl+s', pointer, foreground }),
    /pressed ctrl\+s · pointer \(10, 20\)/,
  )
  assert.match(
    renderActionResult({ action: 'type', chars: 1, pointer, foreground }),
    /typed 1 character ·/,
  )
})

test('renderActionResult always names the foreground window', () => {
  const text = renderActionResult({ action: 'move', to: { x: 0, y: 0 }, pointer, foreground })
  assert.match(text, /^<desktop-action>\n/)
  assert.match(text, /foreground: notepad \(pid 42\) "Untitled - Notepad"/)
  assert.match(text, /\n<\/desktop-action>$/)
})

test('renderWindowList renders handles, rects and flags', () => {
  const text = renderWindowList({
    action: 'list',
    windows: [
      {
        hwnd: '0x00090918', title: 'Untitled - Notepad', className: 'Notepad', processId: 42, processName: 'notepad',
        x: 1, y: 2, width: 800, height: 600, minimized: false, foreground: true,
      },
      {
        hwnd: '0x00050CB4', title: 'Console', className: 'ConsoleWindowClass', processId: 7, processName: 'conhost',
        x: -32000, y: -32000, width: 314, height: 50, minimized: true, foreground: false,
      },
    ],
    total: 2,
    truncated: false,
  })
  assert.match(text, /^<desktop-windows>\n/)
  assert.match(text, /1\. 0x00090918 "Untitled - Notepad" — notepad \(pid 42\), 800x600 at \(1, 2\), foreground/)
  assert.match(text, /2\. 0x00050CB4 "Console" — conhost \(pid 7\), 314x50 at \(-32000, -32000\), minimized/)
  assert.doesNotMatch(text, /showing/)
})

test('renderWindowList reports matches and truncation', () => {
  const empty = renderWindowList({ action: 'list', windows: [], total: 0, truncated: false })
  assert.match(empty, /no visible window matched/)

  const truncated = renderWindowList({
    action: 'list',
    windows: [],
    total: 12,
    truncated: true,
  })
  assert.match(truncated, /showing 0 of 12 matching windows/)
})

test('renderWindowOp reports outcome, subject and closure', () => {
  const focused = renderWindowOp({ action: 'focus', window: foreground, focused: true, closed: false, foreground })
  assert.match(focused, /focused · "Untitled - Notepad" \(notepad, pid 42\)/)

  const refused = renderWindowOp({ action: 'focus', window: foreground, focused: false, closed: false, foreground })
  assert.match(refused, /focus refused · "Untitled - Notepad"/)

  const minimized = renderWindowOp({ action: 'minimize', window: foreground, focused: false, closed: false, foreground })
  assert.match(minimized, /minimized · "Untitled - Notepad"/)

  const closed = renderWindowOp({ action: 'close', window: foreground, focused: false, closed: true, foreground })
  assert.match(closed, /closed · "Untitled - Notepad"/)

  const pending = renderWindowOp({ action: 'close', window: foreground, focused: false, closed: false, foreground })
  assert.match(pending, /close requested; a dialog may be waiting/)
})
