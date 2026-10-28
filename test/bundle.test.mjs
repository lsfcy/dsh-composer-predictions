// Loads the built client.js exactly the way the DSH shell does — a
// `window.__ModuleLoader__.load({ id, factory })` call with a `require` backed
// by the platform module table — then applies the plugin against a fake ctx and
// renders the dock component once. This catches the failures that a browser
// would otherwise be needed for: a broken bundle envelope, the wrong module id,
// a slot registration the slot core would reject, and a component that throws
// on the standard kit props.
import test from 'node:test'
import assert from 'node:assert/strict'

// --- minimal browser surface ------------------------------------------------
const element = () => ({
  style: {},
  dataset: {},
  childElementCount: 0,
  isConnected: true,
  setAttribute() {},
  remove() {},
  appendChild() {},
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }),
  querySelector: () => null,
  querySelectorAll: () => [],
  closest: () => null,
  focus() {},
})

globalThis.window = globalThis.window || {}
globalThis.document = {
  createElement: element,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}
globalThis.requestAnimationFrame = () => 0
globalThis.fetch = () => Promise.reject(new Error('network disabled in test'))

// --- mock module loader -----------------------------------------------------
const loaded = []
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
}
globalThis.window.__ModuleLoader__ = {
  load({ id, factory }) {
    const req = (specifier) => {
      if (specifier === 'react') return react
      throw new Error('unexpected require: ' + specifier)
    }
    loaded.push({ id, exports: factory(req) })
  },
}

await import('../client.js')

test('bundle registers one factory under the package id', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, '@lsfcy/dsh-composer-predictions')
})

function applyPlugin() {
  const registrations = new Map()
  loaded[0].exports.apply({
    effect: (fn) => fn(),
    slots: {
      inject(name, callback) {
        assert.ok(name === 'conversation.input.dock' || name === 'settings.section')
        callback()
      },
      register(options, Component) {
        registrations.set(options.name, { options, Component })
        return () => {}
      },
    },
  })
  return registrations
}

const dockOf = (registrations) => registrations.get('conversation.input.dock')

test('plugin exports a cordis plugin and registers into the input dock', () => {
  const plugin = loaded[0].exports
  assert.equal(plugin.name, 'composer-predictions')
  assert.deepEqual(plugin.inject, ['slots'])

  const registration = dockOf(applyPlugin())
  assert.equal(registration.options.name, 'conversation.input.dock')
  assert.equal(registration.options.id, 'composer-predictions')
  assert.equal(typeof registration.options.order, 'number')
  assert.equal(typeof registration.Component, 'function')
})

test('dock renders only a hidden anchor, never a visible hint row', () => {
  const { Component } = dockOf(applyPlugin())
  const tree = Component({
    sessionId: 'session-1',
    session: { sessionId: 'session-1', running: false, pendingSubmissions: [] },
    input: { draft: '' },
    inputActions: { setDraft: () => {} },
    useSession: () => false,
  })
  assert.equal(tree.type, 'div')
  assert.equal(tree.props['data-composer-predictions'], 'anchor')
  assert.equal(tree.props['aria-hidden'], 'true')
  assert.equal(tree.props.style.display, 'none')
  assert.equal(tree.children.length, 0)
})

test('dock still renders without the optional session kit props', () => {
  const { Component } = dockOf(applyPlugin())
  const tree = Component({ session: {}, input: {} })
  assert.equal(tree.type, 'div')
  assert.equal(tree.props['data-composer-predictions'], 'anchor')
})


test('plugin contributes a settings section next to Plugins', () => {
  const registration = applyPlugin().get('settings.section')
  assert.ok(registration, 'settings.section registered')
  assert.equal(registration.options.id, 'composer-predictions')
  assert.ok(registration.options.order > 15 && registration.options.order < 20)
  assert.equal(typeof registration.options.label, 'function')
  // configStore has not loaded (effects are inert in this mock): the page
  // must render its loading state without throwing.
  const tree = registration.Component({ close: () => {} })
  assert.equal(tree.type, 'section')
})
