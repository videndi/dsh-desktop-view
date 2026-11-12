/**
 * Pure presentation and geometry helpers for dsh-desktop-view.
 *
 * Nothing here touches the filesystem, spawns a process, or reads the clock, so
 * the model-facing envelope and the pointer/host geometry can be unit-tested
 * without a desktop.
 */

/**
 * Index of the monitor containing a virtual-screen point.
 * @param {Array<{index: number, x: number, y: number, width: number, height: number}>} monitors
 * @param {number} x
 * @param {number} y
 * @returns {number} the 1-based monitor index, or 0 when the point is outside every monitor.
 */
export function monitorIndexAt(monitors, x, y) {
  for (const monitor of monitors) {
    if (x >= monitor.x && x < monitor.x + monitor.width && y >= monitor.y && y < monitor.y + monitor.height) {
      return monitor.index
    }
  }
  return 0
}

/** Render a rectangle as `WxH at (x, y)`. */
export function formatRect(rect) {
  return `${rect.width}x${rect.height} at (${rect.x}, ${rect.y})`
}

/** Render one window as `name: process (pid N) "title"`. */
export function formatWindow(name, window) {
  const process = window.processName || window.className || 'unknown'
  const id = window.processId > 0 ? ` (pid ${window.processId})` : ''
  const title = window.title ? ` "${window.title}"` : ''
  return `${name}: ${process}${id}${title}`
}

/**
 * Build the model-facing text envelope for one observation.
 * @param {object} value - the tool result value (snapshot or pointer).
 * @param {boolean} hasAttachment - whether an image block accompanies this text.
 * @returns {string} the envelope.
 */
export function renderScene(value, hasAttachment) {
  const lines = ['<desktop>', `captured: ${value.capturedAt}`]
  lines.push(`region: ${value.region.kind} — ${formatRect(value.region)}`)
  if (value.image) {
    const scaled = value.image.width !== value.image.sourceWidth
      ? `, downscaled from ${value.image.sourceWidth}x${value.image.sourceHeight}`
      : ''
    lines.push(`image: ${value.image.path} (${value.image.width}x${value.image.height}${scaled})`)
  }
  const pointer = [`screen (${value.cursor.screenX}, ${value.cursor.screenY})`]
  if (value.image) {
    pointer.push(value.cursor.onImage
      ? `image (${value.cursor.imageX}, ${value.cursor.imageY})`
      : 'outside the captured region')
  }
  if (value.cursor.monitorIndex > 0) pointer.push(`monitor ${value.cursor.monitorIndex}`)
  lines.push(`pointer: ${pointer.join(' · ')}`)
  lines.push('monitors:')
  for (const monitor of value.monitors) {
    lines.push(`  - ${monitor.index}: ${formatRect(monitor)}${monitor.primary ? ' primary' : ''}`)
  }
  lines.push(formatWindow('foreground', value.foregroundWindow))
  lines.push(formatWindow('under pointer', value.windowUnderCursor))
  if (value.dpiScale !== 1) lines.push(`display scale: ${Math.round(value.dpiScale * 100)}%`)
  if (value.image && !hasAttachment) {
    lines.push('pixels: not inlined on this route — the image path above is the exact capture; use an image reader on it when pixels matter')
  }
  lines.push('</desktop>')
  return lines.join('\n')
}
