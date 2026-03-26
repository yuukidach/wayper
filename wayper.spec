# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Wayper.app — standalone macOS GUI bundle."""

block_cipher = None

# ── GUI entry point ──
gui_a = Analysis(
    ['entry_gui.py'],
    pathex=[],
    binaries=[],
    datas=[('assets/icon.icns', 'assets')],
    hiddenimports=[
        'wayper', 'wayper.gui', 'wayper.gui.macos', 'wayper.gui.macos.app',
        'wayper.gui.macos.main_window', 'wayper.gui.macos.browse_view',
        'wayper.gui.macos.actions_view', 'wayper.gui.macos.daemon_control',
        'wayper.gui.macos.settings_window', 'wayper.gui.macos.colors',
        'wayper.backend', 'wayper.backend.macos',
        'wayper.browse', 'wayper.browse._common',
        'wayper.config', 'wayper.daemon', 'wayper.history',
        'wayper.pool', 'wayper.state', 'wayper.image',
        'objc', 'AppKit', 'Foundation', 'Quartz',
        'PIL', 'PIL.Image',
        'click', 'httpx', 'mcp',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['gtk', 'gi', 'wayper.backend.linux'],
    noarchive=False,
    cipher=block_cipher,
)
gui_pyz = PYZ(gui_a.pure, cipher=block_cipher)

gui_exe = EXE(
    gui_pyz,
    gui_a.scripts,
    [],
    exclude_binaries=True,
    name='Wayper',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    target_arch=None,
)

# ── CLI entry point (bundled inside .app for daemon control) ──
cli_a = Analysis(
    ['entry_cli.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'wayper', 'wayper.backend', 'wayper.backend.macos',
        'wayper.browse', 'wayper.browse._common',
        'wayper.config', 'wayper.daemon', 'wayper.history',
        'wayper.pool', 'wayper.state', 'wayper.image',
        'objc', 'AppKit', 'Foundation', 'Quartz',
        'PIL', 'PIL.Image',
        'click', 'httpx',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['gtk', 'gi', 'wayper.backend.linux'],
    noarchive=False,
    cipher=block_cipher,
)
cli_pyz = PYZ(cli_a.pure, cipher=block_cipher)

cli_exe = EXE(
    cli_pyz,
    cli_a.scripts,
    [],
    exclude_binaries=True,
    name='wayper-cli',
    debug=False,
    strip=False,
    upx=False,
    console=True,
    target_arch=None,
)

# ── Merge into single COLLECT ──
coll = COLLECT(
    gui_exe, gui_a.binaries, gui_a.datas,
    cli_exe, cli_a.binaries, cli_a.datas,
    strip=False,
    upx=False,
    name='Wayper',
)

app = BUNDLE(
    coll,
    name='Wayper.app',
    icon='assets/icon.icns',
    bundle_identifier='io.github.yuukidach.wayper',
    info_plist={
        'CFBundleName': 'Wayper',
        'CFBundleDisplayName': 'Wayper',
        'CFBundleVersion': '0.7.0',
        'CFBundleShortVersionString': '0.7.0',
        'CFBundleExecutable': 'Wayper',
        'CFBundleIconFile': 'icon.icns',
        'CFBundlePackageType': 'APPL',
        'NSHighResolutionCapable': True,
        'LSMinimumSystemVersion': '12.0',
        'LSBackgroundOnly': False,
    },
)
