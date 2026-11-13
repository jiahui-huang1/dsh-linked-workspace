/**
 * Client bundle smoke test — loads lib/client.js in Node with a minimal fake
 * browser/module-loader environment and runs `apply()` against a fake Cordis
 * client context. It proves the bundle parses, its factory executes, the
 * settings section, the two directory-flow occupants and the two sidebar tabs
 * register with the expected ids.
 *
 *   node test/client-smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const registered = { settings: [], flows: [], tabs: [] }
let captured = null
let effectCount = 0

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

function ReactStub() {}
ReactStub.createElement = function createElement(type, props) {
  return { type, props }
}
ReactStub.Fragment = 'Fragment'
ReactStub.useState = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}]
ReactStub.useEffect = () => {}
ReactStub.useRef = () => ({ current: null })
ReactStub.useCallback = (callback) => callback
ReactStub.useMemo = (factory) => factory()

const moduleTable = { react: ReactStub }

const localeService = {
  getSnapshot: () => ({ active: 'zh-CN' }),
  subscribe: () => () => {},
}

const sidebarService = {
  registerTab(descriptor) {
    registered.tabs.push(descriptor)
    return () => {}
  },
}

const ctx = {
  effect(callback) {
    effectCount += 1
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get(name) {
    if (name === 'locale') return localeService
    if (name === 'betterSidebar') return sidebarService
    return undefined
  },
  slots: {
    inject(owner, callback) {
      assert.ok(typeof owner === 'string' && owner.length > 0)
      callback()
    },
    register(options, component) {
      const entry = { options, component }
      if (options.name === 'settings.section') registered.settings.push(entry)
      else registered.flows.push(entry)
      return () => {}
    },
  },
}

await import('../lib/client.js')

const bundleSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.match(bundleSource, /terminal\.open/, 'terminal API call is part of the client bundle')
assert.match(bundleSource, /requestCloseInternalFile/, 'dirty-close prompt is part of the client bundle')
assert.match(bundleSource, /autoSave/, 'auto-save setting is part of the client bundle')
assert.match(bundleSource, /media\.read/, 'image preview API is part of the client bundle')
assert.match(bundleSource, /fs\.move/, 'remote move API is part of the client bundle')
assert.match(bundleSource, /local\.move/, 'local move API is part of the client bundle')
assert.match(bundleSource, /rw-csv-table/, 'CSV table preview is part of the client bundle')
assert.match(bundleSource, /ImagePreview/, 'image preview component is part of the client bundle')
assert.match(bundleSource, /HtmlPreview/, 'HTML preview component is part of the client bundle')
assert.match(bundleSource, /rw-image-canvas/, 'image zoom canvas is part of the client bundle')
assert.match(bundleSource, /htmlScriptsDisabled/, 'HTML preview safety note is part of the client bundle')
assert.match(bundleSource, /newEntryMenuItems/, 'direct new-entry menu actions are part of the client bundle')
assert.match(bundleSource, /createOnly: true/, 'remote new files are created without overwriting existing targets')

assert.ok(captured, 'the bundle registered itself with the module loader')
assert.equal(captured.id, 'dsh-linked-workspace')
assert.equal(typeof captured.factory, 'function')

const mod = captured.factory((name) => {
  assert.ok(moduleTable[name], `unexpected require(${name})`)
  return moduleTable[name]
})

assert.deepEqual(mod.inject, ['slots', 'locale'])
mod.apply(ctx)

assert.equal(registered.settings.length, 1, 'exactly one settings section registered')
const section = registered.settings[0]
assert.equal(section.options.name, 'settings.section')
assert.equal(section.options.id, 'linked-workspaces')
assert.equal(section.options.order, 52)
assert.equal(typeof section.options.label, 'function')
assert.equal(section.options.label(), '联动工作区', 'the nav label follows the zh locale')
assert.equal(typeof section.component, 'function')

assert.equal(registered.flows.length, 2, 'the sidebar and hero directory flows registered')
const flowNames = registered.flows.map((entry) => entry.options.name).sort()
assert.deepEqual(flowNames, ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow'])
for (const flow of registered.flows) {
  assert.equal(flow.options.priority, -2, 'the flow must shadow the shipped browser')
  assert.equal(typeof flow.component, 'function')
}

assert.equal(registered.tabs.length, 16, 'both tree tabs, the file tab, 12 file slots and the legacy file alias register eagerly')
const tree = registered.tabs.find((tab) => tab.id === 'dsh-linked-workspace')
assert.ok(tree, 'linked tree tab descriptor exists')
assert.equal(typeof tree.available, 'function')
const remoteTree = registered.tabs.find((tab) => tab.id === 'dsh-remote-workspace')
assert.ok(remoteTree, 'remote tree tab descriptor exists')
assert.equal(typeof remoteTree.available, 'function')
const file = registered.tabs.find((tab) => tab.id === 'dsh-linked-workspace:file')
assert.ok(file, 'file tab descriptor exists')
assert.equal(file.hidden, true)
assert.equal(typeof file.dedupeKey, 'function')
assert.equal(file.dedupeKey({ id: 'rw-file:x' }), 'rw-file:x')
assert.ok(effectCount >= 2, 'resources were registered through ctx.effect')

console.log('PASS — client bundle factory + registrations')
console.log('  settings section:', section.options.id, '/', section.options.label())
console.log('  directory flows:', flowNames.join(', '))
console.log('  sidebar tabs:', registered.tabs.map((tab) => tab.id).join(', '))
