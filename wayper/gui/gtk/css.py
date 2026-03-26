"""Catppuccin Mocha CSS theme for the GTK4 GUI."""

from __future__ import annotations

CSS = """
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
    transition: background 150ms ease, border-color 150ms ease;
}
flowboxchild:hover {
    background: rgba(69, 71, 90, 0.5);
    border-color: #585b70;
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
@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
.status-dot-running {
    color: #a6e3a1;
    animation: pulse 2s ease-in-out infinite;
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

/* ── Thumbnail overlay ── */
.thumb-overlay {
    background: rgba(0, 0, 0, 0.65);
    color: #cdd6f4;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 0 0 8px 8px;
}

/* ── Skeleton placeholder + fade-in ── */
@keyframes skeleton-pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
}
.thumb-skeleton {
    background: #313244;
    border-radius: 8px;
    animation: skeleton-pulse 1.5s ease-in-out infinite;
}
.thumb-loaded {
    transition: opacity 300ms ease-in;
}

/* ── Preview info overlay ── */
.preview-overlay {
    background: linear-gradient(to bottom, transparent, rgba(0, 0, 0, 0.7));
    padding: 8px 12px;
    border-radius: 0 0 12px 12px;
}
.preview-overlay label {
    color: #cdd6f4;
    font-size: 12px;
}

/* ── Quota progress bar ── */
.quota-bar trough {
    background: #313244;
    border-radius: 4px;
    min-height: 6px;
}
.quota-bar progress {
    background: #89b4fa;
    border-radius: 4px;
    min-height: 6px;
}
.quota-bar.warning progress {
    background: #fab387;
}
.quota-bar.critical progress {
    background: #f38ba8;
}
.quota-bar-inline trough {
    background: #313244;
    border-radius: 3px;
    min-height: 4px;
}
.quota-bar-inline progress {
    background: #89b4fa;
    border-radius: 3px;
    min-height: 4px;
}

/* ── Detail panel ── */
.detail-panel {
    background: #181825;
    border-radius: 8px;
    padding: 8px 12px;
}
.detail-panel label {
    color: #a6adc8;
    font-family: monospace;
    font-size: 11px;
}
.detail-label-key {
    color: #89b4fa;
    font-weight: bold;
}

/* ── Context menu (popover) ── */
popover.background contents {
    background: #313244;
    border-radius: 8px;
    border: 1px solid #45475a;
    padding: 4px;
}
popover modelbutton {
    padding: 6px 12px;
    border-radius: 4px;
    color: #cdd6f4;
}
popover modelbutton:hover {
    background: #45475a;
}
popover separator {
    background: #45475a;
    margin: 4px 8px;
    min-height: 1px;
}

/* ── Search / filter bar ── */
.search-bar {
    background: #181825;
    border-radius: 8px;
    padding: 4px 8px;
}
.filter-btn {
    background: #313244;
    color: #cdd6f4;
    border-radius: 6px;
    padding: 4px 10px;
    border: none;
    min-height: 24px;
}
.filter-btn:hover {
    background: #45475a;
}
.filter-btn:checked {
    background: #89b4fa;
    color: #1e1e2e;
}

/* ── Wallhaven online browse ── */
.wallhaven-card {
    background: #313244;
    border-radius: 10px;
    border: 2px solid transparent;
    transition: background 150ms ease, border-color 150ms ease;
}
.wallhaven-card:hover {
    background: #45475a;
    border-color: #585b70;
}
.wallhaven-card:selected {
    background: #313244;
    border-color: #89b4fa;
}
.download-btn {
    background: #a6e3a1;
    color: #1e1e2e;
    border-radius: 8px;
    padding: 4px 12px;
    border: none;
    min-height: 28px;
    font-weight: bold;
}
.download-btn:hover {
    background: #94e2d5;
}
.download-btn:disabled {
    background: #45475a;
    color: #6c7086;
}
.wallhaven-meta label {
    color: #a6adc8;
    font-size: 12px;
}
.wallhaven-tag {
    background: #45475a;
    color: #cdd6f4;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 11px;
}

/* ── Multi-select bar ── */
.multi-select-bar {
    background: #313244;
    border-radius: 8px;
    padding: 4px 8px;
}
"""
