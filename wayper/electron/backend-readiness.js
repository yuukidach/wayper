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

function probeApi(port, timeout = 1000) {
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
        path: '/api/status',
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForApi(portFile, options = {}) {
  const timeout = options.timeout ?? 10000
  const pollInterval = options.pollInterval ?? 200
  const requestTimeout = options.requestTimeout ?? 1000
  const probe = options.probe ?? probeApi
  const deadline = Date.now() + timeout

  while (Date.now() <= deadline) {
    const port = readPortFile(portFile)
    if (port > 0 && await probe(port, requestTimeout)) return port

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(pollInterval, remaining))
  }

  return 0
}

module.exports = { probeApi, readPortFile, waitForApi }
