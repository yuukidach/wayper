"""Catppuccin Mocha CSS theme for the GTK4 GUI."""

from __future__ import annotations

CSS = b"""
window {
    background-color: #1e1e2e;
    color: #cdd6f4;
}
headerbar {
    background-color: #181825;
    color: #cdd6f4;
    border-bottom: 1px solid #313244;
}
.category-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 8px;
    padding: 4px 14px;
    min-height: 28px;
    border: none;
    box-shadow: none;
}
.category-btn:hover {
    background: #45475a;
}
.category-btn:checked {
    background: #89b4fa;
    color: #1e1e2e;
}
.view-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 8px;
    padding: 4px 14px;
    min-height: 28px;
    border: none;
    box-shadow: none;
}
.view-btn:hover {
    background: #45475a;
}
.view-btn:checked {
    background: #a6e3a1;
    color: #1e1e2e;
}
.mode-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 8px;
    padding: 4px 12px;
    min-height: 28px;
    border: none;
}
.mode-btn:checked {
    background: #f38ba8;
    color: #1e1e2e;
}
.preview-area {
    background-color: #181825;
    border-radius: 12px;
}
.action-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 8px;
    padding: 6px 16px;
    border: none;
    min-height: 32px;
}
.action-btn:hover {
    background: #45475a;
}
.action-btn.destructive {
    background: #45475a;
    color: #f38ba8;
}
.action-btn.destructive:hover {
    background: #f38ba8;
    color: #1e1e2e;
}
.status-label {
    color: #6c7086;
    font-size: 12px;
}
.blocklist-placeholder {
    background: #313244;
    border-radius: 10px;
    color: #6c7086;
    font-size: 11px;
}
flowboxchild {
    background: transparent;
    border-radius: 10px;
    padding: 0;
    border: 2px solid transparent;
}
flowboxchild:selected {
    background: #313244;
    border-color: #89b4fa;
}
.daemon-bar {
    background-color: #181825;
    border-radius: 8px;
    padding: 4px 12px;
}
.status-dot-running {
    color: #a6e3a1;
}
.status-dot-stopped {
    color: #f38ba8;
}
.info-label {
    color: #89b4fa;
    font-weight: bold;
}
.fav-badge {
    color: #a6e3a1;
}
.stats-label {
    color: #a6adc8;
    font-family: monospace;
    font-size: 11px;
}
.nav-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 8px;
    padding: 6px 18px;
    border: none;
    min-height: 32px;
}
.nav-btn:hover {
    background: #45475a;
}
.rate-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 8px;
    padding: 6px 14px;
    border: none;
    min-height: 32px;
}
.rate-btn:hover {
    background: #45475a;
}
notebook > header {
    background-color: #181825;
}
notebook > header > tabs > tab {
    background: #313244;
    color: #cdd6f4;
    padding: 4px 16px;
    border-radius: 6px;
    margin: 2px;
}
notebook > header > tabs > tab:checked {
    background: #89b4fa;
    color: #1e1e2e;
}
.settings-row label {
    color: #a6adc8;
}
.settings-entry {
    background: #313244;
    color: #cdd6f4;
    border-radius: 6px;
    border: 1px solid #45475a;
    padding: 4px 8px;
}
"""
