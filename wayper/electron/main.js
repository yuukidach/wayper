const { app, BrowserWindow, Menu, shell } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')
const fs = require('fs')

let backendProcess = null
let mainWindow = null

// Platform specific binary name
const BACKEND_BINARY = process.platform === 'win32' ? 'wayper-backend.exe' : 'wayper-backend'

function getBackendPath() {
  console.log('isPackaged:', app.isPackaged)
  console.log('defaultApp:', process.defaultApp)
  console.log('resourcesPath:', process.resourcesPath)

  if (process.env.WAYPER_DEV) {
    return null
  }

  // If defaultApp is true, we are running via electron executable (dev mode)
  // If isPackaged is true AND defaultApp is undefined/false, we are packaged
  const isDev = process.defaultApp || /node_modules[\\/]electron[\\/]/.test(process.execPath)

  if (!isDev && app.isPackaged) {
    // In production, binary is in resources/wayper-backend/wayper-backend
    return path.join(process.resourcesPath, 'wayper-backend', BACKEND_BINARY)
  } else {
    // In dev, try to find locally built binary in onedir dist
    const localBuild = path.join(__dirname, '../../dist/wayper-backend', BACKEND_BINARY)
    console.log('Checking local build:', localBuild)
    if (fs.existsSync(localBuild)) {
      return localBuild
    }
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

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Wayper Website',
          click: () => shell.openExternal('https://yuukidach.github.io/wayper/')
        },
        {
          label: 'Report Issue',
          click: () => shell.openExternal('https://github.com/yuukidach/wayper/issues')
        },
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow () {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: !isMac,
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    }
  })

  mainWindow.loadFile('index.html')

  // Open external URLs in system browser instead of new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    buildMenu()
    startBackend()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })
}

app.on('will-quit', () => {
  killBackend()
})

app.on('window-all-closed', () => {
  app.quit()
})
