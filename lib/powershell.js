/**
 * The one place that talks to Windows PowerShell.
 *
 * Each call starts a short-lived `powershell.exe`, hands it a JSON request file
 * (when the script takes one), and reads back a JSON result file. Console text
 * is never parsed, so localized Windows output cannot break the plugin.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Windows PowerShell is the one interpreter every supported desktop ships. */
export function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir
  if (root) {
    const bundled = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (existsSync(bundled)) return bundled
  }
  return 'powershell.exe'
}

let sequence = 0

function scratchPath(suffix) {
  sequence += 1
  return join(tmpdir(), `dsh-desktop-view-${process.pid}-${Date.now()}-${sequence}.${suffix}`)
}

/**
 * Run one helper script and return its JSON answer.
 * @param {{script: string, args?: string[], request?: unknown, signal?: AbortSignal, timeoutMs?: number}} options
 * @returns {Promise<Record<string, unknown>>} the parsed result; rejects with the helper's own message.
 */
export function runPowerShellScript(options) {
  const { script, args = [], request, signal, timeoutMs = 30_000 } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    if (!existsSync(script)) {
      reject(new Error(`desktop helper is missing: ${script}`))
      return
    }

    const outJson = scratchPath('json')
    const requestPath = request === undefined ? undefined : scratchPath('request.json')
    if (requestPath) writeFileSync(requestPath, JSON.stringify(request), 'utf8')

    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
    if (requestPath) argv.push('-Request', requestPath)
    argv.push('-OutJson', outJson, ...args)

    let settled = false
    let stderr = ''
    const child = spawn(powershellPath(), argv, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      for (const path of [outJson, requestPath]) {
        if (path) {
          try { rmSync(path, { force: true }) } catch { /* best effort */ }
        }
      }
    }
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      cleanup()
      settle(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(reject, new Error(`desktop helper timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    const onAbort = () => {
      child.kill()
      finish(reject, signal?.reason ?? new Error('desktop helper aborted'))
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      finish(reject, new Error(`cannot start Windows PowerShell (${powershellPath()}): ${error.message}`))
    })
    child.on('close', (code) => {
      let payload
      try {
        payload = JSON.parse(readFileSync(outJson, 'utf8'))
      } catch { /* fall through to stderr */ }
      if (payload && payload.ok === true) {
        finish(resolve, payload)
        return
      }
      const detail = (payload && typeof payload.error === 'string' && payload.error)
        || stderr.trim().slice(-600)
        || `desktop helper exited with code ${code}`
      finish(reject, new Error(detail))
    })
  })
}
