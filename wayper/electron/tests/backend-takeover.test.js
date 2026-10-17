const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const { takeoverInProgress, waitForApi } = require('../backend-readiness')

function startTime(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8')
  return Number.parseInt(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19], 10)
}

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayper-takeover-'))
  const portFile = path.join(tempDir, 'api.port')
  const marker = path.join(tempDir, 'api.takeover')
  const now = Math.floor(Date.now() / 1000)
  try {
    assert.equal(takeoverInProgress(marker), false)

    // Extended wait: the base timeout passes, but an active takeover keeps waiting.
    let calls = 0
    const begun = Date.now()
    const port = await waitForApi(portFile, {
      timeout: 30,
      maxTimeout: 2000,
      pollInterval: 5,
      preferredPort: 4242,
      takeoverActive: () => true,
      probe: async () => (++calls, Date.now() - begun > 150),
    })
    assert.equal(port, 4242)

    if (process.platform === 'linux') {
      fs.writeFileSync(marker, `pid=${process.pid} start=${startTime(process.pid)} ts=${now}`)
      assert.equal(takeoverInProgress(marker), true)
      // Wrong start time (PID reuse) or an old marker is ignored.
      fs.writeFileSync(marker, `pid=${process.pid} start=1 ts=${now}`)
      assert.equal(takeoverInProgress(marker), false)
      fs.writeFileSync(marker, `pid=${process.pid} start=${startTime(process.pid)} ts=${now - 120}`)
      assert.equal(takeoverInProgress(marker), false)

      // A stale marker from a dead pid must not extend the wait.
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
      fs.writeFileSync(marker, `pid=${dead.stdout} start=12345 ts=${now}`)
      assert.equal(takeoverInProgress(marker), false)
      const t0 = Date.now()
      assert.equal(await waitForApi(portFile, {
        timeout: 50,
        maxTimeout: 5000,
        pollInterval: 5,
        takeoverFile: marker,
        probe: async () => false,
      }), 0)
      assert.ok(Date.now() - t0 < 1000, 'dead-pid marker must not extend the wait')
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  console.log('backend takeover tests passed')
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
