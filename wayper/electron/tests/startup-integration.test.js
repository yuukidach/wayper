const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Module = require('node:module')
const path = require('node:path')

const mainPath = path.join(__dirname, '..', 'main.js')
const ipcHandlers = new Map()
const windows = []
const spawnedProcesses = []
let resolveReadiness
const readiness = new Promise(resolve => {
  resolveReadiness = resolve
})

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler() {}
}

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.webContents = new FakeWebContents()
    this.showCount = 0
    windows.push(this)
  }

  loadFile() {
    setImmediate(() => this.emit('ready-to-show'))
  }

  isDestroyed() { return false }
  isMinimized() { return false }
  hide() {}
  focus() {}
  restore() {}
  show() { this.showCount += 1 }
}

class FakeTray extends EventEmitter {
  isDestroyed() { return false }
  setContextMenu() {}
  setToolTip() {}
  destroy() {}
}

const app = new EventEmitter()
Object.assign(app, {
  isPackaged: true,
  getLocale: () => 'en-US',
  quit: () => {},
  requestSingleInstanceLock: () => true,
  setAppUserModelId: () => {},
  whenReady: () => Promise.resolve(),
})

const electron = {
  app,
  BrowserWindow: FakeBrowserWindow,
  Menu: {
    buildFromTemplate: template => template,
    setApplicationMenu: () => {},
  },
  Tray: FakeTray,
  shell: { openExternal: () => {} },
  ipcMain: {
    handle: (name, handler) => ipcHandlers.set(name, handler),
    on: () => {},
  },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { height: 900 } }) },
}

function spawn() {
  const child = new EventEmitter()
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  spawnedProcesses.push(child)
  return child
}

function flushEvents() {
  return new Promise(resolve => setImmediate(resolve))
}

async function run() {
  const originalLoad = Module._load
  const originalArgv = process.argv
  const originalApiPort = process.env.WAYPER_API_PORT
  const originalResourcesPath = process.resourcesPath
  const originalFetch = global.fetch

  try {
    process.argv = originalArgv.filter(argument => argument !== '--hidden')
    process.argv.push('--hidden')
    // A launcher-provided port still needs to pass the readiness probe before
    // the renderer may use it.
    process.env.WAYPER_API_PORT = '45123'
    process.resourcesPath = path.join(__dirname, 'missing-resources')
    global.fetch = async url => ({
      ok: true,
      status: 200,
      json: async () => String(url).endsWith('/api/config')
        ? { language: 'en' }
        : { auto_rotation: false, rotation_paused: false },
    })

    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return electron
      if (request === 'child_process') return { spawn }
      if (request === './backend-readiness' && parent?.filename === mainPath) {
        return {
          waitForApi: (_portFile, options) => {
            assert.equal(options.timeout, 60000)
            assert.equal(options.preferredPort, 45123)
            return readiness
          },
        }
      }
      return originalLoad.call(this, request, parent, isMain)
    }

    delete require.cache[mainPath]
    require(mainPath)

    // A normal second launch during a hidden cold start should be remembered,
    // not create a premature second window with port 8080.
    app.emit('second-instance', {}, ['Wayper'], '', {})
    await flushEvents()
    assert.equal(windows.length, 1)
    await flushEvents()
    assert.equal(windows[0].showCount, 1)

    const getApiPort = ipcHandlers.get('get-api-port')
    assert.equal(typeof getApiPort, 'function')
    let portRequestSettled = false
    const portRequest = getApiPort().then(port => {
      portRequestSettled = true
      return port
    })
    await flushEvents()
    assert.equal(portRequestSettled, false)

    resolveReadiness(45123)
    assert.equal(await portRequest, 45123)
    assert.equal(process.env.WAYPER_API_PORT, '45123')

    app.emit('second-instance', {}, ['Wayper'], '', {})
    assert.equal(windows.length, 1)
    assert.equal(windows[0].showCount, 2)
  } finally {
    app.emit('before-quit')
    app.emit('will-quit')
    Module._load = originalLoad
    process.argv = originalArgv
    process.resourcesPath = originalResourcesPath
    global.fetch = originalFetch
    if (originalApiPort === undefined) delete process.env.WAYPER_API_PORT
    else process.env.WAYPER_API_PORT = originalApiPort
    delete require.cache[mainPath]
  }

  assert.equal(spawnedProcesses.length, 1)
  assert.equal(spawnedProcesses[0].killed, true)
  console.log('startup integration tests passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
