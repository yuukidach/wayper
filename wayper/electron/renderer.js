/*
 * The renderer is intentionally split into the following ordered scripts:
 *
 *   i18n.js            system locale detection and UI translations
 *   renderer-state.js   bootstrap, state, keyboard and navigation
 *   renderer-data.js    settings, actions, search and API coordination
 *   renderer-views.js   gallery, blocklist and review rendering
 *   renderer-lightbox.js image viewer and zoom controls
 *
 * index.html loads them in this order.  This file remains as a discoverable
 * entry point for older packaging scripts; it contains no duplicate runtime.
 */
