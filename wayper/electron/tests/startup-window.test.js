const assert = require('node:assert/strict')

const { createStartupWindowController } = require('../startup-window')

function controllerHarness(initiallyHidden = false) {
  const created = []
  let showCount = 0
  const controller = createStartupWindowController({
    initiallyHidden,
    createWindow: options => created.push(options),
    showWindow: () => {
      showCount += 1
    },
  })
  return { controller, created, showCount: () => showCount }
}

{
  const { controller, created, showCount } = controllerHarness()

  assert.equal(controller.requestShow(), false)
  assert.equal(controller.requestShow(), false)
  assert.deepEqual(created, [])

  assert.equal(controller.finishStartup(), true)
  assert.deepEqual(created, [{ show: true }])
  assert.equal(controller.finishStartup(), false)
  assert.equal(created.length, 1)

  assert.equal(controller.requestShow(), true)
  assert.equal(showCount(), 1)
}

{
  const { controller, created } = controllerHarness(true)
  controller.finishStartup()
  assert.deepEqual(created, [{ show: false }])
}

{
  const { controller, created } = controllerHarness(true)
  controller.requestShow()
  controller.finishStartup()
  assert.deepEqual(created, [{ show: true }])
}

console.log('startup window tests passed')
