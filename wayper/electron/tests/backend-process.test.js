const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { EventEmitter, once } = require('node:events')
const test = require('node:test')
const { stopBackendProcess } = require('../backend-process')

test('stops an actual owned child on the current platform', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await once(child.stdout, 'data')
    await stopBackendProcess(child, 100)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
    await stopBackendProcess(child) // Already exited: no signals or waits.
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('escalates an unresponsive child and waits for exit, not just kill()', async () => {
  const child = new EventEmitter()
  const signals = []
  child.kill = signal => {
    signals.push(signal)
    if (signal === 'SIGKILL') setImmediate(() => child.emit('exit', null, signal))
    return true
  }
  let stopped = false
  const stopping = stopBackendProcess(child, 10).then(() => { stopped = true })
  assert.equal(stopped, false)
  assert.deepEqual(signals, ['SIGTERM'])
  await stopping
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(child.listenerCount('exit'), 0)
})

test('reports a failed stop instead of allowing a competing child', async () => {
  const child = new EventEmitter()
  child.kill = () => false
  await assert.rejects(stopBackendProcess(child, 5), /did not exit/)
  assert.equal(child.listenerCount('exit'), 0)
})
