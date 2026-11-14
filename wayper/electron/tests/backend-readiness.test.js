const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const { probeApi, readPortFile, waitForApi } = require('../backend-readiness')

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayper-api-ready-'))
  const portFile = path.join(tempDir, 'api.port')
  let responseBody = '{"service":"wayper"}'
  let hang = false
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/health')
    if (hang) return
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(responseBody)
  })

  try {
    assert.equal(readPortFile(portFile), 0)
    fs.writeFileSync(portFile, 'not-a-port')
    assert.equal(readPortFile(portFile), 0)
    fs.writeFileSync(portFile, '12345garbage')
    assert.equal(readPortFile(portFile), 0)

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    fs.writeFileSync(portFile, String(address.port))

    assert.equal(await waitForApi(portFile, { timeout: 1000 }), address.port)

    responseBody = '{"service":"something-else"}'
    assert.equal(await probeApi(address.port), false)
    responseBody = 'invalid json'
    assert.equal(await probeApi(address.port), false)
    responseBody = '{"service":"wayper"}'
    hang = true
    assert.equal(await probeApi(address.port, 20), false)
    hang = false

    fs.unlinkSync(portFile)
    assert.equal(await waitForApi(portFile, {
      timeout: 1000,
      preferredPort: address.port,
    }), address.port)

    fs.writeFileSync(portFile, String(address.port))
    assert.equal(await waitForApi(portFile, {
      timeout: 1000,
      preferredPort: address.port === 65535 ? 65534 : address.port + 1,
      probe: async port => port === address.port,
    }), address.port)

    let probes = 0
    const unavailable = await waitForApi(portFile, {
      timeout: 20,
      pollInterval: 1,
      probe: async () => {
        probes += 1
        return false
      },
    })
    assert.equal(unavailable, 0)
    assert.ok(probes > 0)

    // A killed backend can leave an old port; a successor replaces it while
    // readiness is polling. The next attempt must follow the new file.
    fs.writeFileSync(portFile, '12345')
    const seen = []
    assert.equal(await waitForApi(portFile, {
      timeout: 1000,
      pollInterval: 1,
      probe: async port => {
        seen.push(port)
        fs.writeFileSync(portFile, '23456')
        return port === 23456
      },
    }), 23456)
    assert.deepEqual(seen, [12345, 23456])
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  console.log('backend readiness tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
