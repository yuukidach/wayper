// Stop only a child we launched, and wait for its exit before starting another.
// A PID read from disk is never sufficient authority to terminate a process.
function stopBackendProcess(child, timeout = 3000) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve()

  return new Promise((resolve, reject) => {
    let timer
    const finish = error => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('error', finish)
      if (error) reject(error)
      else resolve()
    }
    const onExit = () => finish()
    child.once('exit', onExit)
    child.once('error', finish)
    timer = setTimeout(() => {
      timer = setTimeout(() => finish(new Error('Wayper backend did not exit')), timeout)
      try {
        child.kill('SIGKILL')
      } catch (error) {
        finish(error)
      }
    }, timeout)
    try {
      child.kill('SIGTERM')
    } catch (error) {
      finish(error)
    }
  })
}

module.exports = { stopBackendProcess }
