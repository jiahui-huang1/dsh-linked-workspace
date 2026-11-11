/**
 * Host API smoke test — exercises lib/index.js end to end against a real
 * SSH target, using a fake Cordis context and fake HTTP request/response.
 *
 *   node test/host-api.mjs
 *
 * It covers: host discovery, direct remote workspaces (list/read/write/
 * conflict/rename/delete), settings, local directory browsing, and linked
 * workspaces (create → workspace registration → browse/edit through linkedId →
 * mirror + sync → remove). Only temporary paths are created on either side.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../lib/index.js'
import { newEntryRequest } from '../src/parts/file-creation.js'

const HOST_NAME = process.env.RW_TEST_HOST || 'RTX-PRO-6000-1'
const ROOT = process.env.RW_TEST_ROOT || '/shared_data_ssd1/huangjh'
const SUFFIX = `${process.pid}-${Date.now()}`
const TEST_FILE = `${ROOT}/.dshrw-api-test-${SUFFIX}.txt`
const REMOTE_LINK_DIR = `${ROOT}/.dshrw-link-${SUFFIX}`

const isolatedHome = mkdtempSync(join(tmpdir(), 'dsh-rw-test-'))
const localRoot = mkdtempSync(join(tmpdir(), 'dsh-rw-local-'))
process.env.DSH_LINKED_WORKSPACE_HOME = isolatedHome

const fakeWorkspaces = []
const fakeSessionController = {
  cwd: '',
  async list() {
    return { items: fakeSessionController.cwd === '' ? [] : [{ sessionId: 'sess-test', running: true, cwd: fakeSessionController.cwd }] }
  },
}

function makeCtx() {
  const routes = []
  const disposers = []
  const tools = []
  const prompts = []
  const registry = {
    list: () => fakeWorkspaces.slice(),
    create: async (path, title) => {
      const existing = fakeWorkspaces.find((workspace) => workspace.path === path)
      if (existing) return existing
      const workspace = { id: `ws-${fakeWorkspaces.length + 1}`, path, title, createdAt: Date.now() }
      fakeWorkspaces.push(workspace)
      return workspace
    },
    delete: async (id) => {
      const index = fakeWorkspaces.findIndex((workspace) => workspace.id === id)
      if (index < 0) return false
      fakeWorkspaces.splice(index, 1)
      return true
    },
  }
  const services = {
    workspaceRegistry: registry,
    workspaceController: { rename: async () => {} },
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    systemPrompt: { section: (section) => { prompts.push(section); return () => {} } },
    workingDirectory: { ensure: async () => process.cwd() },
    sessionController: fakeSessionController,
  }
  const ctx = {
    ...services,
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    get(serviceName) {
      // No `connection` service in this harness: the loopback fence applies.
      return services[serviceName]
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes, disposers, tools, prompts }
}

function makeRequest(body, headers) {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    url: '/dsh-linked-workspace/api',
    headers: headers || { host: '127.0.0.1:7113' },
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  }
}

function makeResponse() {
  const state = { status: 0, headers: {}, chunks: [] }
  return {
    get status() {
      return state.status
    },
    get body() {
      return Buffer.concat(state.chunks).toString('utf8')
    },
    get headersSent() {
      return state.status !== 0
    },
    writeHead(status, headers) {
      state.status = status
      state.headers = headers || {}
      return this
    },
    end(chunk) {
      if (chunk !== undefined) state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    },
    destroy() {},
  }
}

const timings = []
function step(label, started, extra) {
  const ms = Date.now() - started
  timings.push({ label, ms })
  console.log(`  ok  ${label} (${ms} ms)${extra ? ` — ${extra}` : ''}`)
}

async function main() {
  const { ctx, routes, disposers, tools, prompts } = makeCtx()
  apply(ctx)
  const route = routes.find((entry) => entry.path === '/dsh-linked-workspace/api')
  assert.ok(route, 'the plugin registered its API route')

  async function call(method, params) {
    const response = makeResponse()
    await route.handler(makeRequest({ method, params }), response)
    return { status: response.status, payload: JSON.parse(response.body) }
  }

  async function ok(method, params) {
    const result = await call(method, params)
    assert.equal(result.status, 200, `${method} status ${result.status}: ${JSON.stringify(result.payload)}`)
    assert.equal(result.payload.ok, true, `${method} failed: ${JSON.stringify(result.payload)}`)
    return result.payload.data
  }

  async function fail(method, params, expectedStatus) {
    const result = await call(method, params)
    assert.equal(result.payload.ok, false, `${method} unexpectedly succeeded`)
    assert.equal(result.status, expectedStatus, `${method} expected ${expectedStatus}, got ${result.status}`)
    return result.payload.error
  }

  console.log(`plugin: ${name}`)
  console.log('')

  // 1. Host discovery
  let started = Date.now()
  const hostList = await ok('hosts.list', {})
  assert.ok(Array.isArray(hostList.hosts) && hostList.hosts.length > 0, 'at least one SSH host')
  const host = hostList.hosts.find((entry) => entry.name === HOST_NAME) || hostList.hosts[0]
  assert.equal(host.hasCredential, true, 'the host has credentials available')
  assert.equal(host.privateKeyPath, undefined, 'credentials never cross the API')
  step('hosts.list', started, `${hostList.hosts.length} hosts, using "${host.name}"`)

  // 2. Directory browsing during setup
  started = Date.now()
  const home = await ok('hosts.browse', { hostId: host.id })
  assert.ok(home.path.startsWith('/'), 'browse returns an absolute path')
  assert.ok(Array.isArray(home.entries), 'browse returns entries')
  step('hosts.browse (home)', started, `${home.path} (${home.entries.length} entries)`)

  // 3. Settings
  started = Date.now()
  const defaults = await ok('settings.get', {})
  assert.equal(defaults.editorTheme, 'github-light')
  const changed = await ok('settings.update', { editorTheme: 'dracula' })
  assert.equal(changed.editorTheme, 'dracula')
  await fail('settings.update', { editorTheme: '../nope' }, 400)
  assert.equal((await ok('settings.get', {})).editorTheme, 'dracula')
  assert.equal(defaults.fileOpenMode, 'editor')
  assert.equal(defaults.autoSave, false)
  const autoSave = await ok('settings.update', { autoSave: true })
  assert.equal(autoSave.autoSave, true)
  assert.equal((await ok('settings.get', {})).autoSave, true)
  await fail('settings.update', { autoSave: 'yes' }, 400)
  assert.equal(defaults.editorThemeMode, 'system')
  assert.equal(defaults.editorThemeFamily, 'github')
  await ok('settings.update', { editorThemeFamily: 'catppuccin' })
  assert.equal((await ok('settings.get', {})).editorThemeFamily, 'catppuccin')
  await fail('settings.update', { editorThemeFamily: 'nope' }, 400)
  await ok('settings.update', { editorThemeMode: 'dark' })
  assert.equal((await ok('settings.get', {})).editorThemeMode, 'dark')
  await fail('settings.update', { editorThemeMode: 'sepia' }, 400)
  const openMode = await ok('settings.update', { fileOpenMode: 'system' })
  assert.equal(openMode.fileOpenMode, 'system')
  assert.equal((await ok('settings.get', {})).fileOpenMode, 'system')
  await fail('settings.update', { fileOpenMode: 'nope' }, 400)
  step('settings.get/update', started)

  // 4. Local directory browsing (used by the workspace pickers)
  started = Date.now()
  const localHome = await ok('local.browse', {})
  assert.equal(typeof localHome.home, 'string')
  assert.ok(Array.isArray(localHome.entries))
  assert.equal(localHome.parent === null || typeof localHome.parent === 'string', true)
  assert.ok(Array.isArray(localHome.drives), 'local.browse returns drive roots')
  const createdLocal = await ok('local.mkdir', { path: localRoot, name: 'nested' })
  assert.equal(createdLocal.path, join(localRoot, 'nested'))
  assert.equal(existsSync(createdLocal.path), true)
  const nested = await ok('local.browse', { path: localRoot })
  assert.ok(nested.entries.some((entry) => entry.name === 'nested'))
  await fail('local.mkdir', { path: localRoot, name: '../escape' }, 400)
  const localNewFilePath = join(localRoot, '新建 file.csv')
  await ok('local.newFile', { path: localNewFilePath })
  assert.equal(readFileSync(localNewFilePath, 'utf8'), '')
  await fail('local.newFile', { path: localNewFilePath }, 409)
  const localNewFolder = await ok('local.mkdir', { path: localRoot, name: '新建文件夹' })
  assert.equal(existsSync(localNewFolder.path), true)
  await fail('local.mkdir', { path: localRoot, name: '新建文件夹' }, 409)
  step('local.browse/mkdir/new', started)

  // 5. Add a direct remote workspace
  started = Date.now()
  const added = await ok('workspaces.add', { hostId: host.id, remotePath: ROOT, name: 'Smoke Test' })
  const workspaceId = added.workspace.id
  assert.equal(added.workspace.remotePath, ROOT)
  assert.equal(added.workspace.name, 'Smoke Test')
  step('workspaces.add', started, workspaceId)

  try {
    // 6. List the workspace root
    started = Date.now()
    const listing = await ok('fs.list', { workspaceId, path: '' })
    assert.equal(listing.path, ROOT)
    assert.ok(listing.entries.length > 0, 'workspace root is not empty')
    step('fs.list', started, `${listing.entries.length} entries`)

    // 7. Write a file, read it back
    started = Date.now()
    const content = `hello from dsh-linked-workspace\n第二个行\n${Date.now()}\n`
    const written = await ok('fs.write', { workspaceId, path: TEST_FILE, content })
    assert.equal(written.size, Buffer.byteLength(content))
    const read = await ok('fs.read', { workspaceId, path: TEST_FILE })
    assert.equal(read.content, content)
    assert.equal(read.editable, true)
    step('fs.write + fs.read', started, `${written.size} bytes`)

    // 8. Conflict detection
    started = Date.now()
    const conflict = await fail('fs.write', {
      workspaceId,
      path: TEST_FILE,
      content: 'should not be written\n',
      expectedMtime: read.mtime - 60_000,
    }, 409)
    assert.equal(conflict.code, 'CONFLICT')
    const kept = await ok('fs.read', { workspaceId, path: TEST_FILE })
    assert.equal(kept.content, content, 'the conflicting write did not touch the file')
    step('fs.write conflict guard', started)

    // 9. Forced save (no expectedMtime)
    started = Date.now()
    await ok('fs.write', { workspaceId, path: TEST_FILE, content: 'force saved\n' })
    const forced = await ok('fs.read', { workspaceId, path: TEST_FILE })
    assert.equal(forced.content, 'force saved\n')
    step('fs.write force', started)

    // 10. Path containment
    started = Date.now()
    await fail('fs.list', { workspaceId, path: '../../etc' }, 400)
    await fail('fs.read', { workspaceId, path: '/etc/passwd' }, 400)
    step('path containment', started)

    // 11. stat / mkdir / rename / delete
    started = Date.now()
    const stat = await ok('fs.stat', { workspaceId, path: TEST_FILE })
    assert.equal(stat.type, 'file')
    const dir = `${ROOT}/.dshrw-dir-${SUFFIX}`
    await ok('fs.mkdir', { workspaceId, path: dir })
    await ok('fs.rename', { workspaceId, from: TEST_FILE, to: `${dir}/renamed.txt` })
    const moved = await ok('fs.read', { workspaceId, path: `${dir}/renamed.txt` })
    assert.equal(moved.content, 'force saved\n')
    await ok('fs.mkdir', { workspaceId, path: `${dir}/sub` })
    const remoteMoved = await ok('fs.move', { workspaceId, path: `${dir}/renamed.txt`, targetDir: `${dir}/sub` })
    assert.equal(remoteMoved.path, `${dir}/sub/renamed.txt`)
    assert.equal((await ok('fs.read', { workspaceId, path: remoteMoved.path })).content, 'force saved\n')
    await ok('fs.write', { workspaceId, path: `${dir}/renamed.txt`, content: 'collision\n' })
    await fail('fs.move', { workspaceId, path: `${dir}/renamed.txt`, targetDir: `${dir}/sub` }, 409)
    await ok('fs.delete', { workspaceId, path: `${dir}/renamed.txt` })
    await ok('fs.delete', { workspaceId, path: remoteMoved.path })
    await ok('fs.delete', { workspaceId, path: `${dir}/sub` })
    await ok('fs.delete', { workspaceId, path: dir })
    step('stat / mkdir / rename / delete', started)

    // 12. Connection test + rename + listing
    started = Date.now()
    const tested = await ok('workspaces.test', { id: workspaceId })
    assert.equal(tested.ok, true, `workspaces.test failed: ${JSON.stringify(tested)}`)
    const renamed = await ok('workspaces.rename', { id: workspaceId, name: 'Renamed Workspace' })
    assert.equal(renamed.workspace.name, 'Renamed Workspace')
    const all = await ok('workspaces.list', {})
    assert.equal(all.workspaces.length, 1)
    assert.equal(all.workspaces[0].hostName, host.name)
    step('workspaces.test + rename + list', started, `${tested.latencyMs} ms`)

    // 13. Prepare a small remote tree for the linked workspace
    started = Date.now()
    await ok('fs.mkdir', { workspaceId, path: REMOTE_LINK_DIR })
    await ok('fs.write', { workspaceId, path: `${REMOTE_LINK_DIR}/a.txt`, content: 'alpha\n' })
    await ok('fs.write', { workspaceId, path: `${REMOTE_LINK_DIR}/b.txt`, content: 'beta\n' })
    step('prepare remote linked tree', started)

    // 14. Linked workspace creation
    started = Date.now()
    const linked = await ok('linked.create', {
      hostId: host.id,
      remotePath: REMOTE_LINK_DIR,
      localPath: localRoot,
      name: 'Smoke Linked',
      mirror: true,
    })
    const link = linked.link
    assert.equal(link.name, 'Smoke Linked')
    assert.equal(link.localPath, localRoot)
    assert.equal(link.remotePath, REMOTE_LINK_DIR)
    assert.equal(link.mirror, true)
    assert.ok(linked.workspaceId, 'a DSH workspace was registered')
    assert.equal(fakeWorkspaces.length, 1)
    assert.equal(fakeWorkspaces[0].path, localRoot)
    assert.equal(fakeWorkspaces[0].title, 'Smoke Linked')
    assert.equal(existsSync(join(localRoot, '.local')), false, 'linked.create does not force a .local directory')
    assert.equal(existsSync(join(localRoot, '.remote')), false, 'linked.create does not force a .remote directory')
    writeFileSync(join(localRoot, 'local-copy.txt'), 'local copy' + String.fromCharCode(10))
    step('linked.create', started, linked.workspaceId)

    // 14a-new. Exercise the exact requests generated by the directory context menu.
    started = Date.now()
    const remoteNewFolder = newEntryRequest('remote', REMOTE_LINK_DIR, '新建文件夹', true, { linkedId: link.id })
    await ok(remoteNewFolder.method, remoteNewFolder.params)
    await fail(remoteNewFolder.method, remoteNewFolder.params, 409)
    const remoteNewFile = newEntryRequest('remote', `${REMOTE_LINK_DIR}/新建文件夹`, '新建 file.csv', false, { linkedId: link.id })
    await ok(remoteNewFile.method, remoteNewFile.params)
    assert.equal((await ok('fs.read', { linkedId: link.id, path: remoteNewFile.path })).content, '')
    const remoteTemplate = newEntryRequest('remote', REMOTE_LINK_DIR, '新建文档.md', false, { linkedId: link.id })
    await ok(remoteTemplate.method, remoteTemplate.params)
    await ok('fs.write', { linkedId: link.id, path: remoteNewFile.path, content: 'preserve this' })
    await fail('fs.write', { linkedId: link.id, path: remoteNewFile.path, content: '', createOnly: true }, 409)
    assert.equal((await ok('fs.read', { linkedId: link.id, path: remoteNewFile.path })).content, 'preserve this')
    step('linked new-entry requests', started)

    if (process.env.RW_TEST_ONLY_CREATION === '1') {
      await ok('linked.remove', { id: link.id, removeWorkspace: true, deleteLocalState: true })
      await ok('fs.delete', { workspaceId, path: REMOTE_LINK_DIR })
      console.log('PASS — creation-only integration checks')
      return
    }

    // 14a. Terminal launcher resolves both sides without opening a console
    started = Date.now()
    process.env.DSH_LINKED_WORKSPACE_NO_TERMINAL = '1'
    try {
      const localTerminal = await ok('terminal.open', { linkedId: link.id, side: 'local' })
      assert.equal(localTerminal.opened, true)
      assert.equal(localTerminal.side, 'local')
      assert.equal(localTerminal.path, localRoot)
      const remoteTerminal = await ok('terminal.open', { linkedId: link.id, side: 'remote' })
      assert.equal(remoteTerminal.opened, true)
      assert.equal(remoteTerminal.side, 'remote')
      assert.equal(remoteTerminal.path, REMOTE_LINK_DIR)
      assert.equal(remoteTerminal.host, host.host)
    } finally {
      delete process.env.DSH_LINKED_WORKSPACE_NO_TERMINAL
    }
    step('terminal.open local/remote', started)

    // 13a2. Plain local DSH workspace creation (Ctrl+O local workspace tab)
    started = Date.now()
    const plainDir = join(localRoot, 'plain-workspace')
    mkdirSync(plainDir, { recursive: true })
    const plainWorkspace = await ok('localWorkspace.create', { path: plainDir, name: 'Plain Smoke' })
    assert.equal(plainWorkspace.title, 'Plain Smoke')
    assert.equal(plainWorkspace.path, plainDir)
    assert.ok(plainWorkspace.workspaceId)
    step('localWorkspace.create', started)

    // 13b. Context-menu operations: transfer/download/copy/chmod/recursive delete
    started = Date.now()
    const transferred = await ok('fs.transfer', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/a.txt` })
    assert.equal(transferred.files, 1)
    assert.equal(existsSync(join(localRoot, '.remote', 'a.txt')), true)
    const downloaded = await ok('fs.download', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/b.txt` })
    assert.equal(existsSync(downloaded.path), true)
    rmSync(downloaded.path, { force: true })
    const localStat = await ok('local.stat', { path: localRoot })
    assert.equal(localStat.type, 'dir')
    const localCopied = await ok('local.copy', { path: join(localRoot, 'local-copy.txt'), targetDir: localRoot })
    assert.equal(existsSync(localCopied.path), true)
    const localRenamed = await ok('local.rename', { from: localCopied.path, to: `${localCopied.path}.renamed` })
    assert.equal(existsSync(localRenamed.path), true)
    await ok('local.chmod', { path: localRenamed.path, mode: '600' })
    const localNewFilePath = join(localRoot, 'new file.csv')
    await ok('local.newFile', { path: localNewFilePath })
    assert.equal(readFileSync(localNewFilePath, 'utf8'), '')
    await fail('local.newFile', { path: localNewFilePath }, 409)
    const localNewFolder = await ok('local.mkdir', { path: localRoot, name: '新建文件夹' })
    assert.equal(existsSync(localNewFolder.path), true)
    await fail('local.mkdir', { path: localRoot, name: '新建文件夹' }, 409)
    await fail('local.mkdir', { path: localRoot, name: '新建文件夹' }, 400)
    await ok('local.delete', { path: localNewFolder.path, root: localRoot })
    await ok('local.delete', { path: localRenamed.path, root: localRoot })
    assert.equal(existsSync(localRenamed.path), false)

    // 13b2. Local media preview + move within the linked local root
    const pngPath = join(localRoot, 'pixel.png')
    writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lcZ9WQAAAABJRU5ErkJggg==', 'base64'))
    const localMedia = await ok('local.media', { path: pngPath })
    assert.equal(localMedia.mime, 'image/png')
    assert.ok(localMedia.base64.length > 20)
    await fail('local.media', { path: join(localRoot, 'local-copy.txt') }, 400)
    await ok('fs.transfer', { linkedId: link.id, side: 'local', path: pngPath })
    const remoteMedia = await ok('media.read', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/pixel.png` })
    assert.equal(remoteMedia.mime, 'image/png')
    assert.ok(remoteMedia.base64.length > 20)
    await ok('fs.delete', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/pixel.png` })

    const movePath = join(localRoot, 'move-a.txt')
    writeFileSync(movePath, 'move me\n')
    const movedLocal = await ok('local.move', { path: movePath, targetDir: join(localRoot, 'nested'), root: localRoot })
    assert.equal(movedLocal.path, join(localRoot, 'nested', 'move-a.txt'))
    assert.equal(existsSync(movedLocal.path), true)
    assert.equal(existsSync(movePath), false)
    writeFileSync(movePath, 'collision\n')
    await fail('local.move', { path: movePath, targetDir: join(localRoot, 'nested'), root: localRoot }, 409)
    await ok('local.delete', { path: movePath, root: localRoot })
    await fail('local.move', { path: join(localRoot, 'nested'), targetDir: join(localRoot, 'nested'), root: localRoot }, 400)
    const movedBack = await ok('local.move', { path: movedLocal.path, targetDir: localRoot, root: localRoot })
    assert.equal(movedBack.path, movePath)
    await ok('local.delete', { path: movedBack.path, root: localRoot })
    await ok('local.delete', { path: pngPath, root: localRoot })
    step('local.media + local.move', started)

    const remoteCopy = await ok('fs.copy', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/a.txt`, targetDir: REMOTE_LINK_DIR })
    assert.notEqual(remoteCopy.path, `${REMOTE_LINK_DIR}/a.txt`)
    assert.equal(remoteCopy.files, 1)
    await ok('fs.chmod', { linkedId: link.id, path: remoteCopy.path, mode: '600' })
    await ok('fs.delete', { linkedId: link.id, path: remoteCopy.path })
    const ctxDir = `${REMOTE_LINK_DIR}/ctxdir`
    await ok('fs.mkdir', { linkedId: link.id, path: ctxDir })
    await ok('fs.write', { linkedId: link.id, path: `${ctxDir}/nested.txt`, content: 'nested' })
    const remoteNewFilePath = `${ctxDir}/新建 file.csv`
    await ok('fs.write', { linkedId: link.id, path: remoteNewFilePath, content: '', createOnly: true })
    assert.equal((await ok('fs.read', { linkedId: link.id, path: remoteNewFilePath })).content, '')
    await ok('fs.write', { linkedId: link.id, path: remoteNewFilePath, content: 'preserve this' })
    await fail('fs.write', { linkedId: link.id, path: remoteNewFilePath, content: '', createOnly: true }, 409)
    assert.equal((await ok('fs.read', { linkedId: link.id, path: remoteNewFilePath })).content, 'preserve this')
    const remoteNewFolderPath = `${ctxDir}/新建文件夹`
    await ok('fs.mkdir', { linkedId: link.id, path: remoteNewFolderPath })
    assert.equal((await ok('fs.stat', { linkedId: link.id, path: remoteNewFolderPath })).type, 'dir')
    await ok('fs.delete', { linkedId: link.id, path: ctxDir })
    assert.equal(existsSync(join(localRoot, '.remote', 'ctxdir')), false)
    writeFileSync(join(localRoot, 'upload.txt'), 'uploaded' + String.fromCharCode(10))
    const upload = await ok('fs.transfer', { linkedId: link.id, side: 'local', path: join(localRoot, 'upload.txt') })
    assert.equal(upload.side, 'local')
    assert.equal(upload.files, 1)
    const uploaded = await ok('fs.read', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/upload.txt` })
    assert.equal(uploaded.content, 'uploaded' + String.fromCharCode(10))
    await ok('fs.delete', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/upload.txt` })
    step('context ops: transfer/download/copy/chmod/delete', started)

    // 13b2. Local read/write (the workbench content pane edits local files too)
    started = Date.now()
    const localEditPath = join(localRoot, 'local-edit.txt')
    const localWritten = await ok('local.write', { path: localEditPath, content: 'local edit' + String.fromCharCode(10) })
    assert.equal(existsSync(localEditPath), true)
    const localRead = await ok('local.read', { path: localEditPath })
    assert.equal(localRead.content, 'local edit' + String.fromCharCode(10))
    assert.equal(localRead.editable, true)
    assert.ok(typeof localWritten.mtime === 'number')
    await fail('local.write', { path: localEditPath, content: 'stale', expectedMtime: localRead.mtime - 5000 }, 409)
    step('local.read/local.write', started)

    // 13b3. Document bridge: Markdown/PDF/DOCX/XLSX/PPTX create/read/write
    started = Date.now()
    const docDir = join(localRoot, 'doc-tests')
    rmSync(docDir, { recursive: true, force: true })
    mkdirSync(docDir, { recursive: true })
    const mdPath = join(docDir, 'note.md')
    await ok('docs.create', { path: mdPath, kind: 'markdown' })
    await ok('docs.write', { path: mdPath, data: { text: '# Hello ' + String.fromCharCode(8315) + ' 中文' + String.fromCharCode(10) } })
    const mdRead = await ok('docs.read', { path: mdPath })
    assert.equal(mdRead.kind, 'markdown')
    assert.ok(mdRead.text.includes('# Hello'))
    const mdPreview = await ok('docs.mdPreview', { path: mdPath })
    assert.ok(mdPreview.html.includes('中文'))
    const mdPdf = await ok('docs.mdPdf', { path: mdPath })
    assert.equal(existsSync(mdPdf.path), true)
    assert.equal(mdPdf.kind, 'pdf')

    const docxPath = join(docDir, 'note.docx')
    await ok('docs.create', { path: docxPath, kind: 'docx' })
    const docxRead = await ok('docs.read', { path: docxPath })
    assert.equal(docxRead.kind, 'docx')
    await ok('docs.write', { path: docxPath, data: { paragraphs: [{ text: 'Edited DOCX' }], tables: [] } })
    assert.ok((await ok('docs.read', { path: docxPath })).paragraphs[0].text.includes('Edited DOCX'))

    const xlsxPath = join(docDir, 'note.xlsx')
    await ok('docs.create', { path: xlsxPath, kind: 'xlsx' })
    const xlsxRead = await ok('docs.read', { path: xlsxPath })
    assert.equal(xlsxRead.kind, 'xlsx')
    await ok('docs.write', { path: xlsxPath, data: { updates: [{ sheet: 'Sheet1', cell: 'A1', value: 'Cell A1' }] } })
    assert.equal((await ok('docs.read', { path: xlsxPath })).sheets[0].rows[0][0], 'Cell A1')

    const pptxPath = join(docDir, 'note.pptx')
    await ok('docs.create', { path: pptxPath, kind: 'pptx' })
    const pptxRead = await ok('docs.read', { path: pptxPath })
    assert.equal(pptxRead.kind, 'pptx')
    assert.ok(pptxRead.slides.length >= 1)

    const pdfPath = join(docDir, 'manual.pdf')
    await ok('docs.create', { path: pdfPath, kind: 'pdf' })
    const pdfRead = await ok('docs.read', { path: pdfPath })
    assert.equal(pdfRead.kind, 'pdf')
    assert.equal(pdfRead.pageCount, 1)
    assert.ok(pdfRead.pages[0].png.startsWith('data:image/png;base64,'))
    const pdfPage = await ok('docs.pdfPage', { path: pdfPath, page: 0 })
    assert.equal(pdfPage.pages[0].index, 0)
    step('docs create/read/write (md/pdf/docx/xlsx/pptx)', started)

    // 13c. Local skills bridge (scan fallback) + running-session flag
    started = Date.now()
    mkdirSync(join(localRoot, '.dsh', 'skills', 'demo-skill'), { recursive: true })
    writeFileSync(
      join(localRoot, '.dsh', 'skills', 'demo-skill', 'SKILL.md'),
      ['---', 'name: demo-skill', 'description: Demo local skill', '---', '', '# Demo', 'Do the thing.'].join('\n'),
    )
    const localSkills = await ok('skills.list', { linkedId: link.id })
    assert.ok(localSkills.skills.some((skill) => skill.name === 'demo-skill'), 'local project skill discovered')
    const readSkill = await ok('skills.read', { linkedId: link.id, name: 'demo-skill' })
    assert.ok(readSkill.content.includes('Do the thing'), 'skill body readable from the local directory')
    fakeSessionController.cwd = localRoot
    await new Promise((resolve) => setTimeout(resolve, 2600))
    const sessionInfo = await ok('session.info', { sessionId: 'sess-test' })
    assert.equal(sessionInfo.cwd, localRoot, 'session.info resolves the active session cwd')
    const runningList = await ok('linked.list', {})
    assert.equal(runningList.links[0].running, true, 'a running local session marks the linked workspace running')
    fakeSessionController.cwd = ''
    await new Promise((resolve) => setTimeout(resolve, 2600))
    const idleList = await ok('linked.list', {})
    assert.equal(idleList.links[0].running, false)
    step('local skills + running-session flag', started)

    // 14c. Local tree listing + local/remote search + git status shape
    started = Date.now()
    const localListing = await ok('local.list', { path: localRoot })
    assert.ok(localListing.entries.some((entry) => entry.name === 'local-copy.txt'))
    assert.ok(localListing.entries.some((entry) => entry.name === 'nested'))
    writeFileSync(join(localRoot, 'local-note.txt'), 'local note\n')
    const localSearchResult = await ok('fs.search', { linkedId: link.id, side: 'local', query: 'local-note' })
    assert.ok(localSearchResult.entries.some((entry) => entry.relative.includes('local-note.txt')))
    const remoteSearchResult = await ok('fs.search', { linkedId: link.id, side: 'remote', query: 'txt' })
    assert.ok(remoteSearchResult.entries.some((entry) => entry.relative === 'a.txt'))
    const remoteGit = await ok('git.status', { linkedId: link.id, side: 'remote' })
    assert.equal(remoteGit.ok, true)
    assert.equal(remoteGit.repo, false, 'the temporary linked root is not a git repository')
    const localGit = await ok('git.status', { linkedId: link.id, side: 'local' })
    assert.equal(localGit.ok, true)
    assert.equal(localGit.repo, false, 'the temp local root is not a git repository')
    step('local.list + search + git.status', started)

    // 14b. The linked_workspace agent tool sees the link and edits remote files.
    started = Date.now()
    const linkedTool = tools.find((tool) => tool.name === 'linked_workspace')
    assert.ok(linkedTool, 'the linked_workspace tool registered')
    assert.ok(prompts.some((section) => section.name === 'tool:linked-workspace'), 'the prompt section registered')
    const toolList = await linkedTool.execute({ action: 'list' }, { agent: {}, signal: undefined })
    assert.equal(toolList.isError, false)
    assert.match(toolList.text, /Smoke Linked/)
    const toolRead = await linkedTool.execute({ action: 'read', workspace: link.localPath, path: 'a.txt' }, { agent: {}, signal: undefined })
    assert.equal(toolRead.isError, false)
    assert.match(toolRead.text, /alpha/)
    const toolWrite = await linkedTool.execute({ action: 'write', workspace: link.localPath, path: 'b.txt', content: 'beta tool' + String.fromCharCode(10) }, { agent: {}, signal: undefined })
    assert.equal(toolWrite.isError, false)
    const toolReplace = await linkedTool.execute({ action: 'replace', workspace: link.localPath, path: 'b.txt', old_string: 'tool', new_string: 'via tool' }, { agent: {}, signal: undefined })
    assert.equal(toolReplace.isError, false)
    assert.match((await ok('fs.read', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/b.txt` })).content, /beta via tool/)
    const toolOutside = await linkedTool.execute({ action: 'read', workspace: link.localPath, path: '/etc/passwd' }, { agent: {}, signal: undefined })
    assert.equal(toolOutside.isError, true)
    step('linked_workspace tool', started)

    // 15. List + browse/edit through the linked id
    started = Date.now()
    const linkedList = await ok('linked.list', {})
    assert.equal(linkedList.links.length, 1)
    assert.equal(linkedList.links[0].workspaceId, 'ws-1')
    const linkedListing = await ok('fs.list', { linkedId: link.id, path: '' })
    assert.equal(linkedListing.path, REMOTE_LINK_DIR)
    assert.ok(linkedListing.entries.some((entry) => entry.name === 'a.txt'))
    const linkedRead = await ok('fs.read', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/a.txt` })
    assert.equal(linkedRead.content, 'alpha\n')
    await ok('fs.write', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/a.txt`, content: 'alpha edited\n' })
    const edited = await ok('fs.read', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/a.txt` })
    assert.equal(edited.content, 'alpha edited\n')
    assert.equal(existsSync(join(localRoot, '.remote', 'a.txt')), true, 'a read mirrored the file into .remote')
    step('linked browse/edit', started)

    // 16. Mirror toggle + sync
    started = Date.now()
    await ok('linked.update', { id: link.id, mirror: false })
    const syncOff = await fail('linked.sync', { id: link.id }, 400)
    assert.equal(syncOff.code, 'BAD_REQUEST')
    step('linked.update mirror off', started)
    await ok('linked.update', { id: link.id, mirror: true })
    started = Date.now()
    const startedSync = await ok('linked.sync', { id: link.id, maxFiles: 10, maxBytes: 2 * 1024 * 1024 })
    assert.ok(startedSync.job && ['running', 'done'].includes(startedSync.job.state), 'linked.sync starts a background job')
    let syncJob = startedSync.job
    const deadline = Date.now() + 30_000
    while (syncJob && syncJob.state === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      syncJob = (await ok('linked.syncStatus', { id: link.id })).job
    }
    assert.equal(syncJob.state, 'done', 'the sync job finishes without a request timeout')
    assert.ok(syncJob.files >= 2, `sync pulled ${syncJob.files} files`)
    assert.equal(existsSync(join(localRoot, '.remote', 'b.txt')), true)
    step('linked.sync (background job)', started, `${syncJob.files} files, ${syncJob.bytes} bytes`)

    // 17. Remove the link (workspace + local state too)
    started = Date.now()
    const removed = await ok('linked.remove', { id: link.id, removeWorkspace: true, deleteLocalState: true })
    assert.equal(removed.removedWorkspace, true)
    assert.equal(removed.deletedLocalState, true)
    assert.equal(fakeWorkspaces.some((workspace) => workspace.path === localRoot), false)
    assert.equal(existsSync(join(localRoot, '.local')), false)
    assert.equal(existsSync(join(localRoot, '.remote')), false)
    assert.equal((await ok('linked.list', {})).links.length, 0)
    step('linked.remove', started)

    // Cleanup the remote linked tree.
    await ok('fs.delete', { workspaceId, path: `${REMOTE_LINK_DIR}/a.txt` })
    await ok('fs.delete', { workspaceId, path: `${REMOTE_LINK_DIR}/b.txt` })
    await ok('fs.delete', { workspaceId, path: REMOTE_LINK_DIR })
  } finally {
    // Cleanup: remove the workspace record and any remote leftovers.
    try {
      await ok('workspaces.remove', { id: workspaceId })
    } catch (error) {
      console.error('cleanup: could not remove workspace', error && error.message ? error.message : error)
    }
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        /* ignore */
      }
    }
    rmSync(isolatedHome, { recursive: true, force: true })
    rmSync(localRoot, { recursive: true, force: true })
  }

  console.log('')
  const total = timings.reduce((sum, entry) => sum + entry.ms, 0)
  console.log(`PASS — ${timings.length} steps in ${total} ms`)
}

main().catch((error) => {
  console.error('')
  console.error('FAIL —', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
