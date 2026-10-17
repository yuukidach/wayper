const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { findReplacementPort, pidAlive } = require('../backend-readiness')

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayper-reconnect-'))
  const portFile = path.join(tempDir, 'api.port')
  const lockFile = path.join(tempDir, 'api.lock')
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/config')
    response.writeHead(200)
    response.end('{}')
  })
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const newPort = server.address().port
    const oldPort = newPort === 65535 ? 65534 : newPort + 1

    // New backend recorded in api.lock with a live pid: reconnect to it.
    fs.writeFileSync(lockFile, `pid=${process.pid} port=${newPort} start=1`)
    assert.equal(await findReplacementPort({ portFile, lockFile, currentPort: oldPort }), newPort)

    // The current port is never reported as a "replacement".
    assert.equal(await findReplacementPort({ portFile, lockFile, currentPort: newPort }), 0)

    // Dead lock owner: fall back to api.port.
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout)
    assert.equal(pidAlive(dead), false)
    assert.equal(pidAlive(process.pid), true)
    fs.writeFileSync(lockFile, `pid=${dead} port=${oldPort}`)
    fs.writeFileSync(portFile, String(newPort))
    const seen = []
    const port = await findReplacementPort({
      portFile,
      lockFile,
      currentPort: 1,
      probe: async (p) => (seen.push(p), p === newPort),
    })
    assert.equal(port, newPort)
    assert.deepEqual(seen, [newPort], 'dead owner port must not be probed')

    // Nothing answering: stay put.
    fs.unlinkSync(portFile)
    assert.equal(await findReplacementPort({ portFile, lockFile, currentPort: 1, probe: async () => false }), 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  console.log('backend reconnect tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

async function registerTests() {
  const { registerClient } = require('../backend-readiness')
  const received = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      received.push({ url: request.url, method: request.method, body: JSON.parse(body) })
      response.writeHead(200)
      response.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    assert.equal(await registerClient(server.address().port), true)
    assert.equal(received[0].url, '/api/client')
    assert.equal(received[0].method, 'POST')
    assert.equal(received[0].body.pid, process.pid)
    if (process.platform === 'linux') assert.ok(Number.isInteger(received[0].body.start))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.equal(await registerClient(1, { timeout: 300 }), false)
  console.log('register client tests passed')
}

registerTests().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
