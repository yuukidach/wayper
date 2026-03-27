const { app, BrowserWindow } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')

let backendProcess = null
let mainWindow = null

// Platform specific binary name
const BACKEND_BINARY = process.platform === 'win32' ? 'wayper-backend.exe' : 'wayper-backend'

function getBackendPath() {
  if (app.isPackaged) {
    // In production, binary is in resources/extraResources
    // electron-builder puts extraResources in resources/ (macOS) or root (Linux) sometimes?
    // Standard path: process.resourcesPath
    return path.join(process.resourcesPath, BACKEND_BINARY)
  } else {
    // In dev, we assume separate launch or manual launch.
    // Return null to indicate "don't spawn"
    return null
  }
}

function startBackend() {
  const binaryPath = getBackendPath()
  if (!binaryPath) {
    console.log('Development mode: Assuming backend is running externally.')
    return
  }

  console.log(`Starting backend from: ${binaryPath}`)
  backendProcess = spawn(binaryPath, [], {
    stdio: ['ignore', 'inherit', 'inherit'], // Pipe logs to main process stdout
    env: { ...process.env, WAYPER_GUI: 'electron' }
  })

  backendProcess.on('error', (err) => {
    console.error('Failed to start backend:', err)
  })

  backendProcess.on('exit', (code, signal) => {
    console.log(`Backend exited with code ${code} signal ${signal}`)
  })
}

function killBackend() {
  if (backendProcess) {
    console.log('Killing backend process...')
    backendProcess.kill()
    backendProcess = null
  }
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    }
  })

  mainWindow.loadFile('index.html')
}

app.whenReady().then(() => {
  startBackend()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('will-quit', () => {
  killBackend()
})

app.on('window-all-closed', () => {
  app.quit()
})
