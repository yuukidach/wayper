const { app, BrowserWindow, Menu, shell, ipcMain, dialog, screen } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')
const { waitForApi } = require('./backend-readiness')

let backendProcess = null
let mainWindow = null
let backendPathResolved = false
let backendPath = null
let captureInProgress = false

const CAPTURE_SWITCH = '--wayper-capture'
const APP_ID = 'com.wayper.app'

if (process.platform === 'win32') {
  // Keep development launches grouped under Wayper instead of electron.exe.
  app.setAppUserModelId(APP_ID)
}

// Platform specific binary name
const BACKEND_BINARY = process.platform === 'win32' ? 'wayper-backend.exe' : 'wayper-backend'

function getBackendPath() {
  if (backendPathResolved) return backendPath
  backendPathResolved = true
  console.log('isPackaged:', app.isPackaged)
  console.log('defaultApp:', process.defaultApp)
  console.log('resourcesPath:', process.resourcesPath)

  if (process.env.WAYPER_DEV) {
    return backendPath
  }

  // If defaultApp is true, we are running via electron executable (dev mode)
  // If isPackaged is true AND defaultApp is undefined/false, we are packaged
  const isDev = process.defaultApp || /node_modules[\\/]electron[\\/]/.test(process.execPath)

  if (!isDev && app.isPackaged) {
    // In production, binary is in resources/wayper-backend/wayper-backend
    backendPath = path.join(process.resourcesPath, 'wayper-backend', BACKEND_BINARY)
  } else {
    // In dev, try to find locally built binary in onedir dist
    const localBuild = path.join(__dirname, '../../dist/wayper-backend', BACKEND_BINARY)
    console.log('Checking local build:', localBuild)
    if (fs.existsSync(localBuild)) {
      backendPath = localBuild
    }
  }
  return backendPath
}

function getPortFilePath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
    return path.join(appData, 'wayper', 'api.port')
  }
  return path.join(process.env.HOME, '.config', 'wayper', 'api.port')
}

function getAppIconPath() {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon-256.png'
  const candidates = [
    // electron-builder copies runtime icons beside the packaged app resources.
    path.join(process.resourcesPath, iconName),
    // Source/development launch from wayper/electron.
    path.join(__dirname, '../../assets', iconName),
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) || null
}

function startBackend() {
  const binaryPath = getBackendPath()
  if (!binaryPath) {
    console.log('Development mode: Assuming backend is running externally.')
    return false
  }

  console.log(`Starting backend from: ${binaryPath}`)
  backendProcess = spawn(binaryPath, [], {
    stdio: ['ignore', 'inherit', 'inherit'], // Pipe logs to main process stdout
    env: { ...process.env, WAYPER_GUI: 'electron' },
    windowsHide: true
  })

  backendProcess.on('error', (err) => {
    console.error('Failed to start backend:', err)
  })

  backendProcess.on('exit', (code, signal) => {
    console.log(`Backend exited with code ${code} signal ${signal}`)
  })
  return true
}

async function waitForBackend(timeout = 10000) {
  const port = await waitForApi(getPortFilePath(), { timeout })
  if (port > 0) {
    console.log(`API ready on port: ${port}`)
    process.env.WAYPER_API_PORT = String(port)
  } else {
    console.warn('API did not become ready within timeout')
  }
  return port
}

function killBackend() {
  if (backendProcess) {
    console.log('Killing backend process...')
    if (!backendProcess.killed) backendProcess.kill()
    backendProcess = null
  }
}

function capturePathFromCommandLine(commandLine = []) {
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = String(commandLine[index] || '')
    if (argument.startsWith(`${CAPTURE_SWITCH}=`)) {
      const value = argument.slice(CAPTURE_SWITCH.length + 1).trim()
      return value ? path.resolve(value) : null
    }
    if (argument === CAPTURE_SWITCH) {
      const value = String(commandLine[index + 1] || '').trim()
      return value ? path.resolve(value) : null
    }
  }
  return null
}

async function settleRendererForCapture(webContents) {
  await webContents.executeJavaScript(`
    (async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const visibleImages = [...document.images].filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.right > 0
          && rect.top < window.innerHeight && rect.left < window.innerWidth;
      });
      await Promise.all(visibleImages.map(image => Promise.race([
        image.decode ? image.decode().catch(() => undefined) : Promise.resolve(),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ])));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return true;
    })()
  `, true)
}

async function captureCurrentWindow(outputPath) {
  if (captureInProgress || !mainWindow || mainWindow.isDestroyed()) return
  if (path.extname(outputPath).toLowerCase() !== '.png') {
    console.error(`Capture path must end in .png: ${outputPath}`)
    return
  }
  const parent = path.dirname(outputPath)
  try {
    if (!fs.statSync(parent).isDirectory()) throw new Error('parent is not a directory')
  } catch (error) {
    console.error(`Capture directory is unavailable: ${parent} (${error.message})`)
    return
  }

  captureInProgress = true
  const webContents = mainWindow.webContents
  let insertedCss = null
  try {
    await settleRendererForCapture(webContents)
    insertedCss = await webContents.insertCSS(`
      *, *::before, *::after {
        animation-play-state: paused !important;
        transition: none !important;
        caret-color: transparent !important;
      }
    `)
    await settleRendererForCapture(webContents)
    const image = await webContents.capturePage()
    if (image.isEmpty()) throw new Error('Electron returned an empty image')
    await fs.promises.writeFile(outputPath, image.toPNG(), { flag: 'wx' })
    console.log(`Captured renderer to ${outputPath}`)
  } catch (error) {
    console.error(`Could not capture renderer: ${error.message}`)
  } finally {
    if (insertedCss) {
      await webContents.removeInsertedCSS(insertedCss).catch(() => {})
    }
    captureInProgress = false
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

// IPC handler: renderer asks for the API port (cached by the launcher/readiness check)
ipcMain.handle('get-api-port', () => {
  return parseInt(process.env.WAYPER_API_PORT || '0', 10)
})

ipcMain.handle('select-download-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Wallpaper Download Folder',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths.length) {
    return null
  }
  return result.filePaths[0]
})

function createWindow () {
  const isMac = process.platform === 'darwin'
  const iconPath = getAppIconPath()
  const availableHeight = screen.getPrimaryDisplay().workAreaSize.height
  const windowOptions = {
    width: 1200,
    height: Math.min(900, availableHeight),
    backgroundColor: '#11111b',
    autoHideMenuBar: !isMac,
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    }
  }
  if (iconPath) windowOptions.icon = iconPath
  mainWindow = new BrowserWindow(windowOptions)

  mainWindow.loadFile('index.html')

  // Forward renderer console to main process stdout
  mainWindow.webContents.on('console-message', (_e, _level, msg) => {
    console.log('[renderer]', msg)
  })

  // Open external URLs in system browser instead of new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Prevent Electron from navigating on mouse back/forward buttons
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
}

const initialCapturePath = capturePathFromCommandLine(process.argv)
// Pass the capture destination through Electron's single-instance payload as
// well as the command line.  Some Linux launchers normalize/strip arguments
// before delivering the `second-instance` event, which otherwise leaves the
// capture helper waiting even though the request reached the running app.
const gotTheLock = app.requestSingleInstanceLock({
  capturePath: initialCapturePath,
})

if (!gotTheLock) {
  app.quit()
} else if (initialCapturePath) {
  console.error('Internal capture requires an existing wayper-gui instance')
  app.quit()
} else {
  app.on('second-instance', (event, commandLine, workingDirectory, additionalData) => {
    const capturePath = additionalData?.capturePath || capturePathFromCommandLine(commandLine)
    if (capturePath) {
      void captureCurrentWindow(capturePath)
      return
    }
    // Someone tried to run a second interactive instance, so focus the window.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    const iconPath = getAppIconPath()
    if (process.platform === 'darwin' && app.dock && iconPath) {
      app.dock.setIcon(iconPath)
    }
    buildMenu()
    const backendStarted = startBackend()
    // In packaged mode, wait until the API is actually accepting requests.
    if (backendStarted) {
      await waitForBackend()
    }
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
