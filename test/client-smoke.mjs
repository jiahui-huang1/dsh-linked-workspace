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

const registered = { settings: [], icons: [], overlays: [], flows: [], tabs: [] }
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
      else if (options.name === 'settings.section.icon') registered.icons.push(entry)
      else if (options.name === 'shell.overlay') registered.overlays.push(entry)
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

assert.deepEqual(mod.inject, ['slots', 'locale', 'sessions'])
mod.apply(ctx)

assert.equal(registered.settings.length, 1, 'exactly one settings section registered')
const section = registered.settings[0]
assert.equal(section.options.name, 'settings.section')
assert.equal(section.options.id, 'linked-workspaces')
assert.equal(section.options.order, 52)
assert.equal(typeof section.options.label, 'function')
assert.equal(section.options.label(), '联动工作区', 'the nav label follows the zh locale')
assert.equal(typeof section.component, 'function')

assert.equal(registered.icons.length, 1, 'exactly one settings nav icon registered')
const navIcon = registered.icons[0]
assert.equal(navIcon.options.name, 'settings.section.icon')
assert.equal(navIcon.options.id, 'linked-workspaces', 'the icon claims the same id as the section')
assert.equal(navIcon.options.order, 52)
assert.equal(typeof navIcon.component, 'function')
const navIconNode = navIcon.component({ size: 16 })
assert.equal(navIconNode.type, 'svg')
assert.equal(navIconNode.props.viewBox, '0 0 1024 1024', 'the settings glyph keeps the 1024 grid')
assert.equal(navIconNode.props.width, 16, 'the host size is honoured')
assert.equal(navIconNode.props.height, 16)

assert.equal(registered.overlays.length, 1, 'exactly one frame-wide overlay registered')
const welcome = registered.overlays[0]
assert.equal(welcome.options.name, 'shell.overlay')
assert.equal(welcome.options.id, 'linked-workspace-welcome')
assert.equal(typeof welcome.options.label, 'function')
assert.equal(welcome.options.label(), '欢迎使用联动工作区插件', 'the overlay label follows the zh locale')
assert.equal(typeof welcome.component, 'function')

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
assert.equal(tree.available({}, { cwd: 'C:/somewhere/else', workspaceId: 'ws-unrelated' }), true, 'the linked page is enabled whenever the "+" menu lists it')
const linkedHidden = Object.getOwnPropertyDescriptor(tree, 'hidden')
assert.equal(typeof linkedHidden.get, 'function', 'the linked page hides itself per session instead of being unregistered')
assert.equal(tree.hidden, true, 'the linked page is hidden outside linked workspaces')
const remoteTree = registered.tabs.find((tab) => tab.id === 'dsh-remote-workspace')
assert.ok(remoteTree, 'remote tree tab descriptor exists')
assert.equal(typeof remoteTree.available, 'function')
assert.equal(remoteTree.available({}, { cwd: 'C:/somewhere/else', workspaceId: 'ws-unrelated' }), true, 'the remote page is enabled whenever the "+" menu lists it')
const remoteHidden = Object.getOwnPropertyDescriptor(remoteTree, 'hidden')
assert.equal(typeof remoteHidden.get, 'function', 'the remote page hides itself per session instead of being unregistered')
assert.equal(remoteTree.hidden, true, 'the remote page is hidden outside remote workspaces')
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

// ── optional companion ─────────────────────────────────────────────────────
// `dsh-better-sidebar` is optional: a deployment without it must still load the
// bundle, register the settings page and the directory flows, and simply skip
// the sidebar pages. `ctx.get` throws for an unknown service, which is exactly
// what the plugin sees when the companion is not installed.
const orphan = { settings: [], icons: [], overlays: [], flows: [], tabs: [] }
const orphanCtx = {
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get(name) {
    if (name === 'locale') return localeService
    if (name === 'betterSidebar') throw new Error('service "betterSidebar" not found')
    return undefined
  },
  slots: {
    inject(_owner, callback) {
      callback()
    },
    register(options, component) {
      const entry = { options, component }
      if (options.name === 'settings.section') orphan.settings.push(entry)
      else if (options.name === 'settings.section.icon') orphan.icons.push(entry)
      else if (options.name === 'shell.overlay') orphan.overlays.push(entry)
      else orphan.flows.push(entry)
      return () => {}
    },
  },
}

const orphanModule = captured.factory((name) => moduleTable[name])
assert.doesNotThrow(() => orphanModule.apply(orphanCtx), 'apply() survives a missing dsh-better-sidebar')
assert.equal(orphan.settings.length, 1, 'the settings section still registers without the sidebar')
assert.equal(orphan.settings[0].options.id, 'linked-workspaces')
assert.equal(orphan.icons.length, 1, 'the settings nav icon still registers without the sidebar')
assert.equal(orphan.icons[0].options.id, 'linked-workspaces')
assert.equal(orphan.overlays.length, 1, 'the welcome overlay still registers without the sidebar')
assert.equal(orphan.flows.length, 2, 'both directory flows still register without the sidebar')
assert.equal(orphan.tabs.length, 0, 'no sidebar page is registered when the companion is absent')

console.log('PASS — the plugin runs without dsh-better-sidebar')
