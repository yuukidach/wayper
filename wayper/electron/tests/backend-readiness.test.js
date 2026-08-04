const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const { readPortFile, waitForApi } = require('../backend-readiness')

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayper-api-ready-'))
  const portFile = path.join(tempDir, 'api.port')
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/status')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{}')
  })

  try {
    assert.equal(readPortFile(portFile), 0)
    fs.writeFileSync(portFile, 'not-a-port')
    assert.equal(readPortFile(portFile), 0)

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    fs.writeFileSync(portFile, String(address.port))

    assert.equal(await waitForApi(portFile, { timeout: 1000 }), address.port)

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
