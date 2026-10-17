const fs = require('fs')
const http = require('http')

function readPortFile(portFile) {
  try {
    const port = Number.parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
  } catch (_) {
    return 0
  }
}

function probeApi(port, timeout = 1000, route = '/api/status') {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ready) => {
      if (settled) return
      settled = true
      resolve(ready)
    }
    const request = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        timeout,
      },
      (response) => {
        response.resume()
        finish(response.statusCode >= 200 && response.statusCode < 300)
      }
    )
    request.on('timeout', () => {
      request.destroy()
      finish(false)
    })
    request.on('error', () => finish(false))
  })
}

const TAKEOVER_MAX_AGE_MS = 60000

function readFields(file) {
  const fields = {}
  try {
    for (const part of fs.readFileSync(file, 'utf-8').split(/\s+/)) {
      const [key, value] = part.split('=')
      const number = Number.parseInt(value, 10)
      if (key && Number.isInteger(number)) fields[key] = number
    }
  } catch (_) {
    return {}
  }
  return fields
}

function procStat(pid) {
  // Returns { state, start } from /proc/<pid>/stat, or null.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    return { state: rest[0], start: Number.parseInt(rest[19], 10) }
  } catch (_) {
    return null
  }
}

// True if api.takeover is fresh and names a live (non-zombie) process whose
// start time matches the one recorded, i.e. a backend is replacing a hung one.
function takeoverInProgress(takeoverFile, now = Date.now()) {
  if (!takeoverFile) return false
  const { pid, start, ts } = readFields(takeoverFile)
  if (!pid || start === undefined || ts === undefined) return false
  if (now - ts * 1000 > TAKEOVER_MAX_AGE_MS) return false
  const stat = procStat(pid)
  if (!stat || stat.state === 'Z' || stat.state === 'X') return false
  return stat.start === start
}

function pidAlive(pid) {
  if (!(pid > 0)) return false
  if (process.platform === 'linux') {
    const stat = procStat(pid)
    return Boolean(stat) && stat.state !== 'Z' && stat.state !== 'X'
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// Locate the backend that replaced ``currentPort``: prefer the port recorded
// in api.lock when its pid is alive, then api.port. Returns 0 if none answers.
async function findReplacementPort(options = {}) {
  const probe = options.probe ?? probeApi
  const lock = readFields(options.lockFile)
  const candidates = []
  if (lock.port && pidAlive(lock.pid)) candidates.push(lock.port)
  candidates.push(readPortFile(options.portFile))
  for (const port of candidates) {
    if (port > 0 && port <= 65535 && port !== options.currentPort
        && await probe(port, options.requestTimeout ?? 1500, '/api/config')) {
      return port
    }
  }
  return 0
}

// Tell a backend which Electron main process is using it, so a backend that
// took over from a hung one can shut down when this app exits.
function registerClient(port, options = {}) {
  const pid = options.pid ?? process.pid
  const stat = procStat(pid)
  const body = JSON.stringify({ pid, start: stat ? stat.start : null })
  return new Promise((resolve) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/client',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: options.timeout ?? 2000,
      },
      (response) => {
        response.resume()
        resolve(response.statusCode >= 200 && response.statusCode < 300)
      }
    )
    request.on('timeout', () => {
      request.destroy()
      resolve(false)
    })
    request.on('error', () => resolve(false))
    request.end(body)
  })
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForApi(portFile, options = {}) {
  const timeout = options.timeout ?? 10000
  const pollInterval = options.pollInterval ?? 200
  const requestTimeout = options.requestTimeout ?? 1000
  const probe = options.probe ?? probeApi
  const preferredPort = Number.parseInt(options.preferredPort || '0', 10)
  // While a takeover marker is valid, extend the wait to maxTimeout in total.
  const maxTimeout = Math.max(timeout, options.maxTimeout ?? 30000)
  const takeoverActive = options.takeoverActive
    ?? (() => takeoverInProgress(options.takeoverFile))
  const started = Date.now()
  let deadline = started + timeout
  let extended = false
  const expired = () => {
    if (Date.now() <= deadline) return false
    if (!extended && takeoverActive()) {
      extended = true
      deadline = started + maxTimeout
    }
    return Date.now() > deadline
  }

  while (!expired()) {
    const filePort = readPortFile(portFile)
    const candidates = [preferredPort, filePort].filter((port, index, ports) => (
      Number.isInteger(port)
      && port > 0
      && port <= 65535
      && ports.indexOf(port) === index
    ))
    for (const port of candidates) {
      if (await probe(port, requestTimeout)) return port
    }

    const remaining = deadline - Date.now()
    await delay(Math.max(0, Math.min(pollInterval, remaining)))
  }

  return 0
}

module.exports = {
  findReplacementPort,
  pidAlive,
  probeApi,
  readPortFile,
  registerClient,
  takeoverInProgress,
  waitForApi,
}
