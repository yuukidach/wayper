const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const mainPath = path.join(__dirname, '..', 'main.js')
const mainRequire = createRequire(mainPath)
const flush = () => new Promise(resolve => setImmediate(resolve))

function launch({ source = false, ownsLock = true, results = [41001], retry = 1 } = {}) {
  const state = { children: [], windows: [], commands: [], probes: [], events: [], dialogs: 0 }
  const app = new EventEmitter()
  Object.assign(app, {
    isPackaged: !source,
    getLocale: () => 'en-US',
    requestSingleInstanceLock: () => ownsLock,
    whenReady: async () => {},
    setAppUserModelId() {},
    focus() {},
    quit() {
      let prevented = false
      app.emit('before-quit', { preventDefault() { prevented = true } })
      if (!prevented) {
        state.quit = true
        app.emit('will-quit')
      }
    },
    exit(code) { state.exitCode = code },
  })
  class Window extends EventEmitter {
    constructor() {
      super()
      this.webContents = new EventEmitter()
      this.webContents.setWindowOpenHandler = () => {}
      this.webContents.reload = () => { this.reloads = (this.reloads || 0) + 1 }
      state.windows.push(this)
    }
    static getAllWindows() { return state.windows }
    isDestroyed() { return false }
    isMinimized() { return false }
    show() {}
    focus() {}
    hide() {}
    loadFile() { setImmediate(() => this.emit('ready-to-show')) }
  }
  class Tray extends EventEmitter {
    isDestroyed() { return false }
    setContextMenu() {}
    setToolTip() {}
    destroy() {}
  }
  const handlers = new Map()
  const electron = {
    app, BrowserWindow: Window, Tray,
    Menu: { buildFromTemplate: value => value, setApplicationMenu() {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    shell: {},
    dialog: { showMessageBox: async () => { state.dialogs++; return { response: retry } } },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { height: 900 } }) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage() {} }) },
  }
  const env = { ...process.env }
  delete env.WAYPER_API_PORT
  delete env.WAYPER_DEV
  delete env.WAYPER_PYTHON
  if (source) Object.assign(env, { WAYPER_DEV: '1', WAYPER_PYTHON: '/selected/python' })
  const context = {
    __dirname: path.dirname(mainPath),
    console: { log() {}, warn() {}, error() {} },
    process: { env, platform: process.platform, execPath: '/test/electron', argv: ['Wayper'], resourcesPath: '/test/resources' },
    setTimeout, clearTimeout,
    setInterval: () => ({ unref() {} }), clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    require(name) {
      if (name === 'electron') return electron
      if (name === 'child_process') return { spawn(command, args, options) {
        state.commands.push({ command, args, options })
        state.events.push('spawn')
        const child = new EventEmitter()
        child.pid = state.children.length + 100
        child.exitCode = null
        child.signalCode = null
        child.autoExit = true
        child.signals = []
        child.exit = () => {
          child.exitCode = 0
          state.events.push('exit')
          child.emit('exit', 0)
        }
        child.kill = signal => {
          child.signals.push(signal)
          if (child.autoExit) setImmediate(child.exit)
          return true
        }
        state.children.push(child)
        return child
      } }
      if (name === './backend-readiness') return { waitForApi: async (_file, options) => {
        state.probes.push(options.timeout)
        const result = results.shift()
        assert.notEqual(result, undefined, 'unexpected readiness probe')
        return result
      } }
      return mainRequire(name)
    },
  }
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath })
  return Object.assign(state, {
    app,
    reopen() { app.emit('second-instance', {}, ['Wayper'], '', { showWindow: true }) },
    port() { return handlers.get('get-api-port')() },
    async close() { app.quit(); await flush(); await flush() },
  })
}

for (const source of [false, true]) {
  test(`${source ? 'source' : 'packaged'} launch restarts its hung child once`, async () => {
    const state = launch({ source, results: [41001, 0, 41002] })
    try {
      await flush()
      assert.equal(await state.port(), 41001)
      if (source) {
        assert.equal(state.commands[0].command, '/selected/python')
        assert.deepEqual(Array.from(state.commands[0].args), ['-m', 'wayper.server.api'])
      } else {
        assert.match(state.commands[0].command, /wayper-backend/)
      }
      state.reopen()
      state.reopen() // Concurrent launches share one recovery operation.
      assert.equal(await state.port(), 41002)
      assert.deepEqual(state.events, ['spawn', 'exit', 'spawn'])
      assert.deepEqual(state.children[0].signals, ['SIGTERM'])
      assert.equal(state.windows[0].reloads, 1)
      assert.deepEqual(state.probes, [60000, 10000, 60000])
    } finally {
      await state.close()
    }
    assert.equal(state.quit, true)
    assert.deepEqual(state.events, ['spawn', 'exit', 'spawn', 'exit'])
  })
}

test('a healthy backend survives reopening without reloading the window', async () => {
  const state = launch({ results: [41001, 41001] })
  try {
    await flush()
    state.reopen()
    assert.equal(await state.port(), 41001)
    assert.equal(state.children.length, 1)
    assert.deepEqual(state.children[0].signals, [])
    assert.equal(state.windows[0].reloads, undefined)
  } finally { await state.close() }
})

test('a losing Electron instance never starts a backend', async () => {
  const state = launch({ source: true, ownsLock: false, results: [] })
  await flush()
  assert.equal(state.quit, true)
  assert.equal(state.children.length, 0)
  assert.deepEqual(state.probes, [])
})

test('explicit startup retry replaces the unresponsive child', async () => {
  const state = launch({ results: [0, 41002], retry: 0 })
  try {
    await flush()
    assert.equal(await state.port(), 41002)
    assert.deepEqual(state.events, ['spawn', 'exit', 'spawn'])
    assert.equal(state.dialogs, 1)
  } finally { await state.close() }
})

test('quitting during recovery does not start another backend', async () => {
  const state = launch({ results: [41001, 0] })
  await flush()
  const child = state.children[0]
  child.autoExit = false
  state.reopen()
  await flush()
  state.app.quit()
  child.exit()
  assert.equal(await state.port(), 0)
  await flush()
  assert.equal(state.children.length, 1)
  assert.equal(state.quit, true)
})

test('a healthy external backend is reused without taking ownership', async () => {
  const state = launch({ results: [41001, 41001] })
  await flush()
  state.children[0].exit() // Child lost the API lock to an existing server.
  state.reopen()
  assert.equal(await state.port(), 41001)
  await state.close()
  assert.deepEqual(state.children[0].signals, [])
  assert.equal(state.children.length, 1)
})

test('a second launch waits for cold startup without interrupting the child', async () => {
  let ready
  const initial = new Promise(resolve => { ready = resolve })
  const state = launch({ results: [initial, 41001] })
  try {
    await flush()
    state.reopen()
    await flush()
    assert.deepEqual(state.probes, [60000])
    assert.deepEqual(state.children[0].signals, [])
    ready(41001)
    assert.equal(await state.port(), 41001)
    assert.equal(state.children.length, 1)
  } finally { await state.close() }
})

test('failure to stop a running child does not discard ownership or spawn a rival', async () => {
  const state = launch({ results: [41001, 0, 41001] })
  await flush()
  const child = state.children[0]
  const kill = child.kill
  child.kill = () => {
    setImmediate(() => child.emit('error', new Error('permission denied')))
    return false
  }
  try {
    state.reopen()
    assert.equal(await state.port(), 41001)
    assert.equal(state.children.length, 1)
  } finally {
    child.kill = kill
    await state.close()
  }
  assert.equal(child.exitCode, 0)
})
