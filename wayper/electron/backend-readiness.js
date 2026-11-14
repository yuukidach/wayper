const fs = require('fs')
const http = require('http')

function readPortFile(portFile) {
  try {
    const port = Number(fs.readFileSync(portFile, 'utf-8').trim())
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
      clearTimeout(timer)
      resolve(ready)
    }
    const request = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/health',
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          body += chunk
          if (body.length > 1024) request.destroy()
        })
        response.on('end', () => {
          try {
            finish(response.statusCode === 200 && JSON.parse(body).service === 'wayper')
          } catch (_) {
            finish(false)
          }
        })
        response.on('error', () => finish(false))
      }
    )
    const timer = setTimeout(() => {
      request.destroy()
      finish(false)
    }, timeout)
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
  const preferredPort = Number.parseInt(options.preferredPort || '0', 10)
  const deadline = Date.now() + timeout

  while (Date.now() <= deadline) {
    const filePort = readPortFile(portFile)
    const candidates = [preferredPort, filePort].filter((port, index, ports) => (
      Number.isInteger(port)
      && port > 0
      && port <= 65535
      && ports.indexOf(port) === index
    ))
    for (const port of candidates) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return 0
      if (await probe(port, Math.min(requestTimeout, remaining))) return port
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await delay(Math.min(pollInterval, remaining))
  }

  return 0
}

module.exports = { probeApi, readPortFile, waitForApi }
