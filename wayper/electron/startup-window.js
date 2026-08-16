function createStartupWindowController({ initiallyHidden = false, createWindow, showWindow }) {
  if (typeof createWindow !== 'function' || typeof showWindow !== 'function') {
    throw new TypeError('createWindow and showWindow must be functions')
  }

  let startupFinished = false
  let showRequested = !initiallyHidden

  return {
    requestShow() {
      if (!startupFinished) {
        showRequested = true
        return false
      }
      showWindow()
      return true
    },

    finishStartup() {
      if (startupFinished) return false
      startupFinished = true
      createWindow({ show: showRequested })
      return true
    },
  }
}

module.exports = { createStartupWindowController }
