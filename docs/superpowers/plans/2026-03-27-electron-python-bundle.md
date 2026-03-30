# Electron/Python Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle the Python backend as a standalone executable (via PyInstaller) and integrate it with the Electron frontend, managing the backend lifecycle (spawn/kill) from the main process.

**Architecture:**
- **Backend:** `wayper/web/api.py` compiled to `wayper-backend` (executable).
- **Frontend:** Electron app spawns `wayper-backend` as a child process.
- **Communication:** HTTP over `localhost` (port dynamically found or fixed with retry).
- **Build:** `electron-builder` includes `wayper-backend` in `extraResources`.

**Tech Stack:** Electron, Python (FastAPI), PyInstaller, Node.js (electron-builder).

---

### Task 1: Create PyInstaller Spec

Create the PyInstaller specification file to bundle the backend.

**Files:**
- Create: `wayper.spec`

- [ ] **Step 1: Create `wayper.spec`**

```python
# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

# Collect hidden imports for uvicorn/fastapi
hidden_imports = collect_submodules('uvicorn') + collect_submodules('fastapi')

a = Analysis(
    ['wayper/web/api.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='wayper-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
```

- [ ] **Step 2: Install PyInstaller**

```bash
uv pip install pyinstaller
```

### Task 2: Modify API Entry Point

The API needs to run `uvicorn` when executed directly as a script (which PyInstaller does).

**Files:**
- Modify: `wayper/web/api.py`

- [ ] **Step 1: Add `if __name__ == "__main__":` block to `wayper/web/api.py`**

Add this to the end of the file:

```python
if __name__ == "__main__":
    # When running as a PyInstaller bundle, we need to run uvicorn programmatically
    # because the 'uvicorn' command line tool isn't available.
    import uvicorn
    import socket

    # Simple port finding or just stick to 8080 for now
    # Ideally pass port 0 to let OS pick, print it, and Electron reads it.
    # For now, stick to 8080 to match frontend hardcoding.
    # Using 127.0.0.1 explicitly.
    uvicorn.run(app, host="127.0.0.1", port=8080, log_level="info")
```

### Task 3: Test Backend Build

Verify that we can build the backend executable.

**Files:**
- None (Build artifact verification)

- [ ] **Step 1: Run PyInstaller build**

```bash
pyinstaller --clean wayper.spec
```

- [ ] **Step 2: Verify executable exists**

```bash
ls -l dist/wayper-backend
```

- [ ] **Step 3: Test run the executable (manual check)**

```bash
./dist/wayper-backend &
PID=$!
sleep 5
curl http://127.0.0.1:8080/api/status
kill $PID
```
Expected output: JSON status response.

### Task 4: Update Electron Main Process

Modify Electron to spawn the backend process.

**Files:**
- Modify: `wayper/gui/electron/main.js`

- [ ] **Step 1: Update `main.js` with process management**

```javascript
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
```

### Task 5: Configure Electron Builder

Update `package.json` to include the binary in the build.

**Files:**
- Modify: `wayper/gui/electron/package.json`

- [ ] **Step 1: Update `build` configuration**

Add `extraResources` and `beforeBuild` script logic.

```json
{
  "scripts": {
    "start": "electron .",
    "build:backend": "pyinstaller --clean ../../../wayper.spec",
    "prebuild": "npm run build:backend && mkdir -p resources && cp ../../../dist/wayper-backend resources/",
    "dist": "npm run prebuild && electron-builder"
  },
  "build": {
    "extraResources": [
      {
        "from": "resources/wayper-backend",
        "to": "wayper-backend"
      }
    ],
    "files": [
      "**/*",
      "!resources/wayper-backend"
    ]
  }
}
```

*Note: We need to copy the built binary into the electron project folder structure so electron-builder can find it easily, or reference it directly from `dist/`.*

Refined Step 1 JSON update:

```json
  "scripts": {
    "start": "electron .",
    "build:backend": "cd ../../.. && pyinstaller --clean wayper.spec",
    "dist": "npm run build:backend && electron-builder"
  },
  "build": {
    "extraResources": [
      {
        "from": "../../../dist/wayper-backend",
        "to": "."
      }
    ]
  }
```

### Task 6: Verify Full Build

Run the full build process and check the artifact.

- [ ] **Step 1: Run `npm run dist`**

```bash
cd wayper/gui/electron
npm run dist
```

- [ ] **Step 2: Launch the built app**

(On Linux, run the .AppImage or the unpacked executable in `dist/linux-unpacked/wayper-electron`)

```bash
./dist/linux-unpacked/wayper-electron
```

