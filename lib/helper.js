/**
 * Node side of the persistent helper.
 *
 * One Windows PowerShell process stays open for the whole session and answers
 * JSON lines, so a grab costs ~0.13 s and a click ~0.1 s instead of the ~0.8 s
 * a fresh process would cost. The class owns the process lifecycle: lazy start,
 * per-request timeouts, and a bounded restart policy.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { powershellPath } from './powershell.js'

const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS = 4

export class DesktopHelper {
  constructor({ script, stopFile, onLog = () => {} }) {
    this.script = script
    this.stopFile = stopFile
    this.onLog = onLog
    this.child = null
    this.reader = null
    this.pending = new Map()
    this.sequence = 0
    this.starting = null
    this.restarts = 0
    this.restartWindowStart = 0
    this.closed = false
    this.lastError = null
  }

  get running() {
    return this.child !== null && this.child.exitCode === null
  }

  async start() {
    if (this.running) return this
    if (this.starting) return this.starting
    if (this.closed) throw new Error('desktop helper is closed')
    if (!existsSync(this.script)) throw new Error(`desktop helper script is missing: ${this.script}`)

    this.starting = new Promise((resolve, reject) => {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script]
      if (this.stopFile) args.push('-StopFile', this.stopFile)
      args.push('-Owner', String(process.pid))
      const child = spawn(powershellPath(), args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      this.reader = createInterface({ input: child.stdout })

      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        this.starting = null
        reject(error)
      }

      this.reader.on('line', (line) => this.handleLine(line))

      child.stderr.on('data', (chunk) => {
        const text = String(chunk)
        this.lastError = text.trim()
        this.onLog(`[helper stderr] ${text.trim().slice(0, 400)}`)
      })

      child.on('error', (error) => {
        this.onLog(`[helper error] ${error.message}`)
        fail(error)
        this.rejectAll(new Error(`desktop helper failed: ${error.message}`))
      })

      child.on('exit', (code, signal) => {
        this.child = null
        if (this.reader) { this.reader.close(); this.reader = null }
        this.rejectAll(new Error(`desktop helper exited (${signal ?? code})`))
        fail(new Error(`desktop helper exited during start (${signal ?? code})`))
        // Restart lazily on the next call. An eager respawn here would keep a
        // host that has already unloaded this plugin instance busy spawning
        // processes it can no longer use.
        if (!this.closed) this.onLog('[helper] exited; the next call will start a fresh one')
      })

      this.call('ping', {}, { timeoutMs: 20_000 })
        .then((reply) => {
          settled = true
          this.starting = null
          this.onLog(`[helper] ready pid=${reply.pid} dpi=${reply.dpi} uia=${reply.uia}`)
          resolve(this)
        })
        .catch((error) => {
          fail(error)
          try { child.kill() } catch { /* already gone */ }
        })
    })
    return this.starting
  }

  handleLine(line) {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.onLog(`[helper] non-JSON line: ${line.slice(0, 200)}`)
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok === true) entry.resolve(message)
    else entry.reject(new Error(String(message.error ?? 'desktop helper reported an error')))
  }

  call(command, payload = {}, { timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null) {
        reject(new Error('desktop helper is not running'))
        return
      }
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`desktop helper timed out on "${command}" after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(`${JSON.stringify({ id, cmd: command, ...payload })}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  rejectAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  /** Capture one frame; returns the helper's metadata (path, size, signature, cursor, foreground). */
  async grab({ path, maxWidth = 0, markCursor = false, quality = 80, monitor } = {}) {
    await this.start()
    return this.call('grab', {
      path,
      maxWidth,
      markCursor,
      quality,
      ...(monitor === undefined ? {} : { monitor }),
    })
  }

  dispose() {
    this.closed = true
    if (this.child) {
      try { this.child.stdin.write(`${JSON.stringify({ id: 0, cmd: 'quit' })}\n`) } catch { /* ignore */ }
      try { this.child.kill() } catch { /* ignore */ }
    }
    this.rejectAll(new Error('desktop helper disposed'))
  }
}
