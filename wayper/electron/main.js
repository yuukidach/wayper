const { app, BrowserWindow, Menu, Tray, shell, ipcMain, dialog, screen } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')
const { waitForApi } = require('./backend-readiness')
const { createStartupWindowController } = require('./startup-window')

let backendProcess = null
let mainWindow = null
let tray = null
let trayRefreshTimer = null
let backendPathResolved = false
let backendPath = null
let captureInProgress = false
let isQuitting = false
let backendReadyPromise = null
let trayRotationState = { auto_rotation: false, rotation_paused: false }
let trayLanguage = 'auto'

const CAPTURE_SWITCH = '--wayper-capture'
const HIDDEN_SWITCH = '--hidden'
const APP_ID = 'com.wayper.app'
const BACKEND_START_TIMEOUT = 60000

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
    process.env.WAYPER_ICON_PATH,
    // electron-builder copies runtime icons beside the packaged app resources.
    path.join(process.resourcesPath, iconName),
    // Source/development launch from wayper/electron.
    path.join(__dirname, '../../assets', iconName),
  ]
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || null
}

function startBackend() {
  const binaryPath = getBackendPath()
  if (!binaryPath) {
    console.log('Development mode: Assuming backend is running externally.')
    return false
  }

  console.log(`Starting backend from: ${binaryPath}`)
  const launchedProcess = spawn(binaryPath, [], {
    stdio: ['ignore', 'inherit', 'inherit'], // Pipe logs to main process stdout
    env: { ...process.env, WAYPER_GUI: 'electron' },
    windowsHide: true
  })
  backendProcess = launchedProcess

  launchedProcess.on('error', (err) => {
    console.error('Failed to start backend:', err)
    if (backendProcess === launchedProcess) backendProcess = null
  })

  launchedProcess.on('exit', (code, signal) => {
    console.log(`Backend exited with code ${code} signal ${signal}`)
    if (backendProcess === launchedProcess) backendProcess = null
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

function configuredApiPort() {
  const port = Number.parseInt(process.env.WAYPER_API_PORT || '0', 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
}

function apiUrl(route) {
  const port = configuredApiPort()
  return port > 0 ? `http://127.0.0.1:${port}${route}` : null
}

function backendStartupLabels() {
  const isChinese = app.getLocale().toLowerCase().startsWith('zh')
  const detail = process.platform === 'win32'
    ? 'The first launch can be delayed by Windows security scanning. You can retry; diagnostic details are in wayper.log inside the Wayper config directory.'
    : 'The background service took longer than expected to start. You can retry; diagnostic details are in wayper.log inside the Wayper config directory.'
  const chineseDetail = process.platform === 'win32'
    ? '首次启动可能会被 Windows 安全扫描拖慢。你可以重试；诊断日志位于 Wayper 配置目录中的 wayper.log。'
    : '后台服务启动时间超过预期。你可以重试；诊断日志位于 Wayper 配置目录中的 wayper.log。'
  return isChinese ? {
    title: 'Wayper 后台服务未启动',
    message: 'Wayper 暂时无法连接后台服务。',
    detail: chineseDetail,
    retry: '重试',
    quit: '退出',
  } : {
    title: 'Wayper backend did not start',
    message: 'Wayper could not connect to its background service.',
    detail,
    retry: 'Retry',
    quit: 'Quit',
  }
}

async function waitForBackendUntilReady() {
  const configuredPort = configuredApiPort()
  if (configuredPort > 0) return configuredPort

  while (!isQuitting) {
    const port = await waitForBackend(BACKEND_START_TIMEOUT)
    if (port > 0) return port
    if (isQuitting) break

    const labels = backendStartupLabels()
    const result = await dialog.showMessageBox({
      type: 'error',
      title: labels.title,
      message: labels.message,
      detail: labels.detail,
      buttons: [labels.retry, labels.quit],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (result.response !== 0) {
      isQuitting = true
      app.quit()
      break
    }

    // A failed child can be restarted. If it is merely slow, keep waiting for
    // the existing process instead of interrupting a security scan.
    if (!backendProcess) startBackend()
  }
  return 0
}

async function callApi(route, options = {}) {
  const url = apiUrl(route)
  if (!url) throw new Error('Wayper backend port is unavailable')
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(`Wayper backend returned HTTP ${response.status}`)
  return response.json()
}

function trayLabels() {
  const isChinese = trayLanguage === 'zh'
    || (trayLanguage === 'auto' && app.getLocale().toLowerCase().startsWith('zh'))
  return isChinese ? {
    show: '打开 Wayper',
    next: '下一张壁纸',
    pause: '暂停自动换壁纸',
    resume: '继续自动换壁纸',
    disabled: '自动换壁纸已关闭',
    quit: '退出 Wayper',
  } : {
    show: 'Open Wayper',
    next: 'Next Wallpaper',
    pause: 'Pause Auto Rotation',
    resume: 'Resume Auto Rotation',
    disabled: 'Auto Rotation Off',
    quit: 'Quit Wayper',
  }
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ show: true })
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function showMainWindow() {
  startupWindowController.requestShow()
}

async function setRotationPaused(paused) {
  const action = paused ? 'pause' : 'resume'
  try {
    trayRotationState = await callApi(`/api/rotation/${action}`, { method: 'POST' })
  } catch (error) {
    console.error(`Could not ${action} automatic rotation:`, error)
  }
  await refreshTrayMenu()
}

async function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  if (configuredApiPort() > 0) {
    try {
      const [status, config] = await Promise.all([
        callApi('/api/status?include_recoverable=false'),
        callApi('/api/config'),
      ])
      trayRotationState = status
      trayLanguage = config.language || 'auto'
    } catch (error) {
      console.warn('Could not refresh tray status:', error.message)
    }
  }

  const labels = trayLabels()
  const active = !!trayRotationState.auto_rotation
  const paused = !!trayRotationState.rotation_paused
  const rotationLabel = active ? labels.pause : paused ? labels.resume : labels.disabled
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: labels.show, click: showMainWindow },
    {
      label: labels.next,
      click: () => {
        void callApi('/api/control/next', { method: 'POST' }).catch(error => {
          console.error('Could not change wallpaper from tray:', error)
        })
      },
    },
    { type: 'separator' },
    {
      label: rotationLabel,
      enabled: active || paused,
      click: () => void setRotationPaused(active),
    },
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]))
}

function createTray() {
  if (tray && !tray.isDestroyed()) return
  const iconPath = getAppIconPath()
  if (!iconPath) {
    console.error('Could not create system tray: Wayper icon is missing')
    return
  }
  try {
    tray = new Tray(iconPath)
    tray.setToolTip('Wayper')
    tray.on('click', showMainWindow)
    void refreshTrayMenu()
    trayRefreshTimer = setInterval(() => void refreshTrayMenu(), 30000)
  } catch (error) {
    tray = null
    console.error('Could not create system tray:', error)
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
      const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
      if (document.fonts && document.fonts.ready) {
        await Promise.race([document.fonts.ready, delay(1000)]);
      }
      const visibleImages = [...document.images].filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.right > 0
          && rect.top < window.innerHeight && rect.left < window.innerWidth;
      });
      await Promise.all(visibleImages.map(image => Promise.race([
        image.decode ? image.decode().catch(() => undefined) : Promise.resolve(),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ])));
      await Promise.race([
        new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        delay(250),
      ]);
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

// Keep the renderer on its loading screen until the auto-selected API port is
// actually accepting requests. Every window shares the same readiness promise.
ipcMain.handle('get-api-port', async () => {
  const port = configuredApiPort()
  if (port > 0) return port
  return backendReadyPromise ? await backendReadyPromise : 0
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

ipcMain.on('refresh-tray-menu', () => {
  void refreshTrayMenu()
})

function createWindow ({ show = true } = {}) {
  const isMac = process.platform === 'darwin'
  const iconPath = getAppIconPath()
  const availableHeight = screen.getPrimaryDisplay().workAreaSize.height
  const windowOptions = {
    width: 1200,
    height: Math.min(900, availableHeight),
    backgroundColor: '#11111b',
    autoHideMenuBar: !isMac,
    titleBarStyle: 'default',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    }
  }
  if (iconPath) windowOptions.icon = iconPath
  mainWindow = new BrowserWindow(windowOptions)

  mainWindow.once('ready-to-show', () => {
    if (show && mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

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
const initiallyHidden = process.argv.includes(HIDDEN_SWITCH)
const startupWindowController = createStartupWindowController({
  initiallyHidden,
  createWindow,
  showWindow: revealMainWindow,
})
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
    // A normal second launch reopens the resident app. Hidden launches stay hidden.
    if (!commandLine.includes(HIDDEN_SWITCH)) showMainWindow()
  })

  app.whenReady().then(() => {
    const iconPath = getAppIconPath()
    if (process.platform === 'darwin' && app.dock && iconPath) {
      app.dock.setIcon(iconPath)
    }
    buildMenu()
    startBackend()
    backendReadyPromise = waitForBackendUntilReady()
    createTray()
    startupWindowController.finishStartup()

    void backendReadyPromise.then(port => {
      if (port > 0) void refreshTrayMenu()
    })

    app.on('activate', () => {
      showMainWindow()
    })
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  if (trayRefreshTimer) clearInterval(trayRefreshTimer)
  if (tray && !tray.isDestroyed()) tray.destroy()
  killBackend()
})

app.on('window-all-closed', () => {
  // Wayper remains available from the system tray until the user chooses Quit.
})
