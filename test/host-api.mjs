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

  // 1b. Build info: the client compares apiRevision with its own to warn about
  // a DSH process that is still running an older copy of this plugin.
  started = Date.now()
  const meta = await ok('meta.info', {})
  assert.ok(Number(meta.apiRevision) >= 2, 'apiRevision is at least 2')
  assert.equal(typeof meta.startedAt, 'string', 'startedAt is reported')
  assert.ok(!Number.isNaN(Date.parse(meta.startedAt)), 'startedAt is an ISO timestamp')
  step('meta.info', started, `apiRevision ${meta.apiRevision}, started ${meta.startedAt}`)

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
  // Later steps create the same folder again, so the duplicate check above must
  // not leave it behind (it used to make step 13b fail with a 409).
  await ok('local.delete', { path: localNewFolder.path, root: localRoot })
  step('local.browse/mkdir/new', started)

  // 5. Add a direct remote workspace
  started = Date.now()
  const added = await ok('remote_workspaces.create', { hostId: host.id, remotePath: ROOT, name: 'Smoke Test' })
  const remoteId = added.workspace.id
  assert.equal(added.workspace.remotePath, ROOT)
  assert.equal(added.workspace.name, 'Smoke Test')
  const fetched = await ok('remote_workspaces.get', { id: remoteId })
  assert.equal(fetched.workspace.id, remoteId)
  assert.ok(fetched.workspace.placeholderPath, 'a placeholder directory backs the workspace')
  assert.ok(existsSync(fetched.workspace.placeholderPath), 'the placeholder directory exists on disk')
  assert.ok(fetched.workspace.workspaceId, 'a DSH workspace was registered')
  step('remote_workspaces.create + get', started, remoteId)

  try {
    // A previous aborted run can leave the scratch tree behind: clear it up
    // front so a re-run starts from a known state (D5).
    await ok('fs.delete', { remoteId, path: REMOTE_LINK_DIR }).catch(() => null)
    // 6. List the workspace root
    started = Date.now()
    const listing = await ok('fs.list', { remoteId, path: '' })
    assert.equal(listing.path, ROOT)
    assert.ok(listing.entries.length > 0, 'workspace root is not empty')
    step('fs.list', started, `${listing.entries.length} entries`)

    // 7. Write a file, read it back
    started = Date.now()
    const content = `hello from dsh-linked-workspace\n第二个行\n${Date.now()}\n`
    const written = await ok('fs.write', { remoteId, path: TEST_FILE, content })
    assert.equal(written.size, Buffer.byteLength(content))
    const read = await ok('fs.read', { remoteId, path: TEST_FILE })
    assert.equal(read.content, content)
    assert.equal(read.editable, true)
    step('fs.write + fs.read', started, `${written.size} bytes`)

    // 8. Conflict detection
    started = Date.now()
    const conflict = await fail('fs.write', {
      remoteId,
      path: TEST_FILE,
      content: 'should not be written\n',
      expectedMtime: read.mtime - 60_000,
    }, 409)
    assert.equal(conflict.code, 'CONFLICT')
    const kept = await ok('fs.read', { remoteId, path: TEST_FILE })
    assert.equal(kept.content, content, 'the conflicting write did not touch the file')
    step('fs.write conflict guard', started)

    // 9. Forced save (no expectedMtime)
    started = Date.now()
    await ok('fs.write', { remoteId, path: TEST_FILE, content: 'force saved\n' })
    const forced = await ok('fs.read', { remoteId, path: TEST_FILE })
    assert.equal(forced.content, 'force saved\n')
    step('fs.write force', started)

    // 9b. Preview reads use the 8 MB cap instead of the editor's 2 MB one
    started = Date.now()
    const previewed = await ok('fs.read', { remoteId, path: TEST_FILE, preview: true })
    assert.equal(previewed.content, 'force saved\n')
    assert.equal(previewed.truncated, false)
    assert.equal(previewed.tooLarge, false)
    assert.equal(previewed.editable, true)
    step('fs.read preview cap', started)

    // 10. Path containment
    started = Date.now()
    await fail('fs.list', { remoteId, path: '../../etc' }, 400)
    await fail('fs.read', { remoteId, path: '/etc/passwd' }, 400)
    step('path containment', started)

    // 10b. Documents in a remote workspace
    started = Date.now()
    const remoteDocDir = `${ROOT}/.dshrw-doc-${SUFFIX}`
    await ok('fs.mkdir', { remoteId, path: remoteDocDir })
    const remoteDocPath = `${remoteDocDir}/note.md`
    await ok('docs.create', { remoteId, path: remoteDocPath, kind: 'markdown' })
    const remoteDocText = '# remote doc\n\nwritten through docs.write\n'
    await ok('docs.write', { remoteId, path: remoteDocPath, data: { text: remoteDocText } })
    const remoteDocRead = await ok('docs.read', { remoteId, path: remoteDocPath })
    assert.equal(remoteDocRead.kind, 'markdown')
    assert.equal(remoteDocRead.text, remoteDocText, 'docs.read returned the remote document')
    const remoteDocRaw = await ok('fs.read', { remoteId, path: remoteDocPath })
    assert.equal(remoteDocRaw.content, remoteDocText, 'the document landed on the remote host')
    await fail('docs.read', { remoteId, path: '/etc/passwd' }, 400)
    await ok('fs.delete', { remoteId, path: remoteDocPath })
    await ok('fs.delete', { remoteId, path: remoteDocDir })
    step('docs.* remote scope', started)

    // 11. stat / mkdir / rename / delete
    started = Date.now()
    const stat = await ok('fs.stat', { remoteId, path: TEST_FILE })
    assert.equal(stat.type, 'file')
    const dir = `${ROOT}/.dshrw-dir-${SUFFIX}`
    await ok('fs.mkdir', { remoteId, path: dir })

    // 10a. A 3 MB page fails the editor's 2 MB ceiling but previews whole
    started = Date.now()
    const bigBody = `${'x'.repeat(3 * 1024 * 1024)}\n`
    await ok('fs.write', { remoteId, path: `${dir}/big.html`, content: bigBody })
    const bigEditor = await ok('fs.read', { remoteId, path: `${dir}/big.html` })
    assert.equal(bigEditor.tooLarge, true)
    assert.equal(bigEditor.editable, false)
    const bigPreview = await ok('fs.read', { remoteId, path: `${dir}/big.html`, preview: true })
    assert.equal(bigPreview.tooLarge, false)
    assert.equal(bigPreview.truncated, false)
    assert.equal(bigPreview.content.length, bigBody.length)
    await ok('fs.delete', { remoteId, path: `${dir}/big.html` })
    step('fs.read preview lifts the 2 MB cap', started)
    await ok('fs.rename', { remoteId, from: TEST_FILE, to: `${dir}/renamed.txt` })
    const moved = await ok('fs.read', { remoteId, path: `${dir}/renamed.txt` })
    assert.equal(moved.content, 'force saved\n')
    await ok('fs.mkdir', { remoteId, path: `${dir}/sub` })
    const remoteMoved = await ok('fs.move', { remoteId, path: `${dir}/renamed.txt`, targetDir: `${dir}/sub` })
    assert.equal(remoteMoved.path, `${dir}/sub/renamed.txt`)
    assert.equal((await ok('fs.read', { remoteId, path: remoteMoved.path })).content, 'force saved\n')
    await ok('fs.write', { remoteId, path: `${dir}/renamed.txt`, content: 'collision\n' })
    await fail('fs.move', { remoteId, path: `${dir}/renamed.txt`, targetDir: `${dir}/sub` }, 409)
    await ok('fs.delete', { remoteId, path: `${dir}/renamed.txt` })
    await ok('fs.delete', { remoteId, path: remoteMoved.path })
    await ok('fs.delete', { remoteId, path: `${dir}/sub` })
    await ok('fs.delete', { remoteId, path: dir })
    step('stat / mkdir / rename / delete', started)

    // 12. Connection test + rename + listing
    started = Date.now()
    const tested = await ok('remote_workspaces.test', { id: remoteId })
    assert.equal(tested.ok, true, `remote_workspaces.test failed: ${JSON.stringify(tested)}`)
    const renamed = await ok('remote_workspaces.update', { id: remoteId, name: 'Renamed Workspace' })
    assert.equal(renamed.workspace.name, 'Renamed Workspace')
    const all = await ok('remote_workspaces.list', {})
    assert.equal(all.workspaces.length, 1)
    assert.equal(all.workspaces[0].hostName, host.name)
    step('remote_workspaces.test + update + list', started, `${tested.latencyMs} ms`)

    // 13. Prepare a small remote tree for the linked workspace
    started = Date.now()
    await ok('fs.mkdir', { remoteId, path: REMOTE_LINK_DIR })
    await ok('fs.write', { remoteId, path: `${REMOTE_LINK_DIR}/a.txt`, content: 'alpha\n' })
    await ok('fs.write', { remoteId, path: `${REMOTE_LINK_DIR}/b.txt`, content: 'beta\n' })
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
    // The remote workspace created above registered its placeholder first.
    assert.equal(fakeWorkspaces.length, 2)
    const linkedWorkspace = fakeWorkspaces.find((workspace) => workspace.path === localRoot)
    assert.ok(linkedWorkspace, 'the linked workspace registered its local directory')
    assert.equal(linkedWorkspace.title, 'Smoke Linked')
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
      await ok('fs.delete', { remoteId, path: REMOTE_LINK_DIR })
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
    // 400 is for a malformed name, not for an existing one (same name would 409).
    await fail('local.mkdir', { path: localRoot, name: 'bad/name' }, 400)
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
    // A 644 on the workspace root would hide the whole tree, so the Host refuses.
    const rootChmod = await fail('fs.chmod', { linkedId: link.id, path: link.remotePath, mode: '644' }, 400)
    assert.match(String(rootChmod.message || ''), /根目录/)
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

    // 13a2. Content search reports line numbers and honours the new options
    started = Date.now()
    const grepPlain = await ok('fs.grep', { linkedId: link.id, side: 'remote', query: 'alpha' })
    assert.ok(grepPlain.entries.length >= 1, 'content search returns matches')
    assert.ok(grepPlain.entries[0].line >= 1, 'a match carries its line number')
    assert.ok(typeof grepPlain.entries[0].preview === 'string' && grepPlain.entries[0].preview.length > 0, 'a match carries a preview')
    const grepCaseSensitive = await ok('fs.grep', { linkedId: link.id, side: 'remote', query: 'ALPHA', ignoreCase: false })
    assert.equal(grepCaseSensitive.entries.length, 0, 'case sensitive search skips the lower-case match')
    const grepInsensitive = await ok('fs.grep', { linkedId: link.id, side: 'remote', query: 'ALPHA', ignoreCase: true })
    assert.ok(grepInsensitive.entries.length >= 1, 'case insensitive search finds it again')
    const grepRegex = await ok('fs.grep', { linkedId: link.id, side: 'remote', query: '^beta$', regex: true })
    assert.ok(grepRegex.entries.length >= 1, 'a regular expression matches a whole line')
    await fail('fs.grep', { linkedId: link.id, side: 'remote', query: '(', regex: true }, 400)
    const grepScoped = await ok('fs.grep', { linkedId: link.id, side: 'remote', query: 'alpha', path: REMOTE_LINK_DIR })
    assert.ok(grepScoped.entries.every((entry) => entry.relative.startsWith('.') === false), 'scoped search stays inside the folder')
    step('fs.grep content options', started, `${grepPlain.entries.length} matches`)

    // 13a2b. Content search: counters, files-only mode, cancellation jobs
    started = Date.now()
    assert.ok(typeof grepPlain.scannedFiles === 'number' && grepPlain.scannedFiles >= 1, 'content search reports how many files it scanned')
    assert.ok(typeof grepPlain.scannedBytes === 'number', 'content search reports the bytes it read')
    assert.equal(typeof grepPlain.skippedFiles, 'number', 'content search reports skipped files')
    const grepFilesOnly = await ok('fs.grep', { linkedId: link.id, side: 'remote', query: 'alpha', resultMode: 'files' })
    assert.ok(grepFilesOnly.entries.length >= 1, 'files-only mode still returns hits')
    assert.ok(grepFilesOnly.entries.every((entry) => entry.line === 0 && entry.preview === ''), 'files-only entries carry no line or preview')
    const grepIgnored = await ok('fs.grep', { linkedId: link.id, side: 'remote', query: 'alpha', includeIgnored: true })
    assert.ok(grepIgnored.scannedFiles >= grepPlain.scannedFiles, 'searching ignored folders never scans fewer files')
    const grepJob = await ok('fs.grep', { linkedId: link.id, side: 'remote', query: 'alpha', jobId: 'grep-smoke-1', timeoutMs: 9000 })
    assert.ok(Array.isArray(grepJob.entries), 'a job-scoped search still answers')
    const grepCancel = await ok('fs.grepCancel', { jobId: 'grep-smoke-1' })
    assert.equal(grepCancel.cancelled, true, 'a finished job is still marked cancelled for the caller')
    step('fs.grep counters, files-only and cancel', started, `${grepPlain.scannedFiles} files scanned`)

    // 13a2c. Reference candidates for @ mentions
    started = Date.now()
    const references = await ok('fs.references', { linkedId: link.id, query: 'a.txt' })
    assert.ok(references.candidates.length >= 1, 'references find a path by name')
    assert.ok(references.candidates.every((entry) => entry.kind === 'file' || entry.kind === 'directory'), 'candidates carry a kind')
    assert.ok(references.candidates[0].relative.indexOf('a.txt') !== -1, 'the best candidate matches the query')
    assert.ok(typeof references.scannedEntries === 'number' && references.scannedEntries >= 1, 'references report how many entries they walked')
    const referencesDir = await ok('fs.references', { linkedId: link.id, query: '新建文件夹' })
    assert.ok(referencesDir.candidates.some((entry) => entry.kind === 'directory'), 'directories are offered as candidates')
    const referencesLocal = await ok('fs.references', { linkedId: link.id, side: 'local', query: '新建' })
    assert.ok(referencesLocal.candidates.length >= 1, 'the local tree can be searched for references too')
    const referencesLimited = await ok('fs.references', { linkedId: link.id, query: 'e', limit: 3 })
    assert.ok(referencesLimited.candidates.length <= 3, 'limit caps the candidate list')
    const referencesEmpty = await ok('fs.references', { linkedId: link.id, query: '' })
    assert.equal(referencesEmpty.candidates.length, 0, 'an empty query yields no candidates')
    step('fs.references candidates', started, `${references.candidates.length} candidates`)

    // 13a3. Transfers expose progress and can be cancelled
    started = Date.now()
    const transferJobId = 'job-smoke-1'
    const tracked = await ok('fs.transfer', { linkedId: link.id, side: 'local', path: join(localRoot, 'upload.txt'), jobId: transferJobId })
    assert.equal(tracked.files, 1)
    const progress = await ok('fs.transferProgress', { jobId: transferJobId })
    assert.ok(progress.job, 'the transfer job is tracked')
    assert.equal(progress.job.state, 'done')
    assert.equal(progress.job.files, 1)
    const cancelDone = await ok('fs.transferCancel', { jobId: transferJobId })
    assert.equal(typeof cancelDone.cancelled, 'boolean')
    await ok('fs.delete', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/upload.txt` })
    step('fs.transfer progress + cancel', started)

    // 13a4. Remote folder creation from the picker
    started = Date.now()
    const madeFolder = await ok('hosts.mkdir', { hostId: host.id, path: REMOTE_LINK_DIR, name: 'from-picker' })
    assert.equal(madeFolder.path, `${REMOTE_LINK_DIR}/from-picker`)
    await fail('hosts.mkdir', { hostId: host.id, path: REMOTE_LINK_DIR, name: 'from-picker' }, 409)
    await fail('hosts.mkdir', { hostId: host.id, path: REMOTE_LINK_DIR, name: '../escape' }, 400)
    await ok('fs.delete', { linkedId: link.id, path: `${REMOTE_LINK_DIR}/from-picker` })
    step('hosts.mkdir', started)

    // 13a4b. Push plan + push (0.19.0): classify, dry-run, then write back
    started = Date.now()
    // These files live only in the push test: `a.txt`/`b.txt` stay untouched
    // because later steps read and rewrite them.
    writeFileSync(join(localRoot, 'pnew.txt'), 'brand new' + String.fromCharCode(10))
    writeFileSync(join(localRoot, 'pchanged.txt'), 'local edit one' + String.fromCharCode(10))
    await ok('fs.write', { remoteId, path: `${REMOTE_LINK_DIR}/pchanged.txt`, content: 'remote original' + String.fromCharCode(10) })
    await ok('fs.write', { remoteId, path: `${REMOTE_LINK_DIR}/psame.txt`, content: 'same' + String.fromCharCode(10) })
    writeFileSync(join(localRoot, 'psame.txt'), 'same' + String.fromCharCode(10))
    const plan = await ok('linked.plan', { id: link.id })
    const planAdded = plan.added.map((item) => item.relative)
    const planChanged = plan.changed.map((item) => item.relative)
    assert.ok(planAdded.indexOf('pnew.txt') >= 0, 'a local-only file shows up as added')
    assert.ok(planChanged.indexOf('pchanged.txt') >= 0, 'a file edited locally shows up as changed')
    assert.ok(planAdded.indexOf('psame.txt') < 0 && planChanged.indexOf('psame.txt') < 0, 'an identical file stays out of the plan')

    const dry = await ok('linked.push', { id: link.id, dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.ok(dry.pushed >= 2, 'the dry run counts what it would push')
    await fail('fs.read', { remoteId, path: `${REMOTE_LINK_DIR}/pnew.txt` }, 404)

    const pushed = await ok('linked.push', { id: link.id, conflict: 'skip' })
    assert.ok(pushed.pushed >= 2, 'the real push writes the planned files')
    const afterPush = await ok('fs.read', { remoteId, path: `${REMOTE_LINK_DIR}/pnew.txt` })
    assert.match(afterPush.content, /brand new/, 'the new file landed on the remote side')
    const changedThere = await ok('fs.read', { remoteId, path: `${REMOTE_LINK_DIR}/pchanged.txt` })
    assert.match(changedThere.content, /local edit one/, 'the changed file landed on the remote side')

    // Now the remote side moves too: the same file becomes a conflict and is
    // left alone unless the caller asks for an overwrite.
    await ok('fs.write', { remoteId, path: `${REMOTE_LINK_DIR}/pchanged.txt`, content: 'remote edit' + String.fromCharCode(10), force: true })
    writeFileSync(join(localRoot, 'pchanged.txt'), 'local edit two' + String.fromCharCode(10))
    const plan2 = await ok('linked.plan', { id: link.id })
    assert.ok(plan2.conflict.map((item) => item.relative).indexOf('pchanged.txt') >= 0, 'a file that moved on both sides is a conflict')
    const skipConflict = await ok('linked.push', { id: link.id, conflict: 'skip' })
    assert.ok(skipConflict.conflictsLeft >= 1, 'skip leaves the conflict untouched')
    const stillRemote = await ok('fs.read', { remoteId, path: `${REMOTE_LINK_DIR}/pchanged.txt` })
    assert.match(stillRemote.content, /remote edit/, 'the remote version survived a skipping push')
    const overwriteConflict = await ok('linked.push', { id: link.id, conflict: 'overwrite' })
    assert.ok(overwriteConflict.pushed >= 1, 'overwrite takes the local side')
    const overwritten = await ok('fs.read', { remoteId, path: `${REMOTE_LINK_DIR}/pchanged.txt` })
    assert.match(overwritten.content, /local edit two/, 'the local version replaced the remote one')

    // 13a4b. A folder in `paths` matches everything below it (0.21.0).
    mkdirSync(join(localRoot, 'pushdir'), { recursive: true })
    writeFileSync(join(localRoot, 'pushdir', 'inside.txt'), 'nested' + String.fromCharCode(10))
    const dirPlan = await ok('linked.plan', { id: link.id, maxFiles: 500 })
    assert.ok(dirPlan.added.map((item) => item.relative).indexOf('pushdir/inside.txt') >= 0,
      'a nested file shows up in the plan')
    assert.ok(typeof dirPlan.added.find((item) => item.relative === 'pushdir/inside.txt').localMtime === 'number',
      'the plan carries the local mtime for the dialog')
    const dirPush = await ok('linked.push', { id: link.id, conflict: 'skip', paths: ['pushdir'] })
    assert.strictEqual(dirPush.pushed, 1, 'a folder path pushes the files under it')
    const nestedThere = await ok('fs.read', { remoteId, path: `${REMOTE_LINK_DIR}/pushdir/inside.txt` })
    assert.match(nestedThere.content, /nested/, 'the nested file landed on the remote')
    step('linked.plan / linked.push (dry run, skip, overwrite)', started)

    // 13a4c. Batch transfer + the history file (0.19.0)
    started = Date.now()
    writeFileSync(join(localRoot, 'batch-1.txt'), 'one' + String.fromCharCode(10))
    writeFileSync(join(localRoot, 'batch-2.txt'), 'two' + String.fromCharCode(10))
    const batchJobId = `batch-${SUFFIX}`
    const batch = await ok('fs.transfer', {
      linkedId: link.id,
      side: 'local',
      paths: [join(localRoot, 'batch-1.txt'), join(localRoot, 'batch-2.txt')],
      jobId: batchJobId,
    })
    assert.equal(batch.files, 2, 'one request carries both files')
    const bothThere = await ok('fs.list', { remoteId, path: REMOTE_LINK_DIR })
    const remoteNames = bothThere.entries.map((entry) => entry.name)
    assert.ok(remoteNames.indexOf('batch-1.txt') >= 0 && remoteNames.indexOf('batch-2.txt') >= 0, 'both files landed')
    const history = await ok('transfer.history', {})
    assert.ok(history.entries.length >= 1, 'the history records the batch')
    assert.ok(history.entries.some((entry) => entry.kind === 'push'), 'pushes are recorded too')
    step('fs.transfer batch + transfer.history', started, `${history.entries.length} history entries`)

    // 13a5. Free space on the remote volume (shown in the tree header)
    started = Date.now()
    const diskInfo = await ok('hosts.df', { hostId: host.id, path: REMOTE_LINK_DIR })
    assert.ok(diskInfo.disk, 'df reports the volume behind the path')
    assert.ok(diskInfo.disk.size > 0, 'the volume has a size')
    assert.ok(diskInfo.disk.avail >= 0, 'free space is reported')
    assert.ok(diskInfo.disk.percent >= 0 && diskInfo.disk.percent <= 100, 'usage percentage is sane')
    step('hosts.df', started, `${Math.round(diskInfo.disk.avail / 1048576)} MB free, ${diskInfo.disk.percent}% used`)

    // 13a5b. Explicit reconnect (0.22.0): dials instead of reading the cached state
    started = Date.now()
    const reconnected = await ok('hosts.reconnect', { hostId: host.id })
    assert.equal(reconnected.hostId, host.id, 'the answer names the host it dialled')
    assert.equal(reconnected.state, 'connected', 'a reachable host comes back connected')
    assert.ok(typeof reconnected.checkedAt === 'number', 'the status carries a timestamp')
    await fail('hosts.reconnect', { hostId: 'sshconfig:no-such-host' }, 404)
    step('hosts.reconnect', started, `${reconnected.state} in ${reconnected.latencyMs} ms`)

    // 13a6. Remote command execution (0.17.0): three gates and an audit trail
    started = Date.now()
    await ok('settings.update', { execEnabled: false, execHostIds: [], execWorkspaceIds: [] })
    await fail('hosts.exec', { linkedId: link.id, command: 'echo gated' }, 403)
    await ok('settings.update', { execEnabled: true, execHostIds: [] })
    await fail('hosts.exec', { linkedId: link.id, command: 'echo gated' }, 403)
    await ok('settings.update', { execEnabled: true, execHostIds: [host.id] })
    const echoed = await ok('hosts.exec', { linkedId: link.id, command: 'echo exec-ok' })
    assert.equal(echoed.exitCode, 0, 'the command exits cleanly')
    assert.match(echoed.stdout, /exec-ok/, 'stdout comes back')
    assert.ok(echoed.auditId, 'the call carries an audit id')
    const badExit = await ok('hosts.exec', { linkedId: link.id, command: 'exit 7', timeoutMs: 5000 })
    assert.equal(badExit.exitCode, 7, 'the remote exit code is preserved')
    await fail('hosts.exec', { linkedId: link.id, command: 'echo x', cwd: '../..' }, 400)
    await fail('hosts.exec', { linkedId: link.id, command: '' }, 400)
    // The workspace allow-list is the second layer: empty means "no restriction".
    await ok('settings.update', { execWorkspaceIds: ['not-this-workspace'] })
    await fail('hosts.exec', { linkedId: link.id, command: 'echo nope' }, 403)
    await ok('settings.update', { execWorkspaceIds: [link.id] })
    const pwdResult = await ok('hosts.exec', { linkedId: link.id, command: 'pwd' })
    assert.equal(pwdResult.exitCode, 0)
    assert.equal(pwdResult.cwd, link.remotePath, 'the workspace root is the default cwd')
    // Every attempt above — refusals included — must be on disk.
    const auditLines = readFileSync(join(isolatedHome, 'exec-audit.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line))
    assert.ok(auditLines.length >= 6, 'each attempt is audited')
    assert.ok(auditLines.some((entry) => entry.refusal === 'EXEC_DISABLED'), 'refusals are audited too')
    assert.ok(auditLines.some((entry) => entry.command === 'echo exec-ok' && entry.exitCode === 0), 'successes are audited')
    assert.ok(auditLines.every((entry) => typeof entry.auditId === 'string' && entry.auditId !== ''), 'every row has an id')
    await ok('settings.update', { execEnabled: false, execHostIds: [], execWorkspaceIds: [] })
    step('hosts.exec', started, `${auditLines.length} audited attempts`)

    // 13a7. Host key trust and output encoding (0.20.0)
    started = Date.now()
    const knownKeys = await ok('hosts.hostKeys', {})
    assert.ok(Array.isArray(knownKeys.entries), 'host keys come back as a list')
    const ourKey = knownKeys.entries.find((entry) => entry.hostId === host.id)
      || knownKeys.entries.find((entry) => entry.authority.endsWith(`:${host.port}`))
    assert.ok(ourKey, 'the host we just connected to has a fingerprint on disk')
    assert.match(ourKey.fingerprint, /^SHA256:/, 'the fingerprint keeps its prefix')

    // GBK output: printf emits the two bytes for 中文 in GBK, not UTF-8.
    await ok('settings.update', { execEnabled: true, execHostIds: [host.id], outputEncoding: 'gbk' })
    const gbk = await ok('hosts.exec', { linkedId: link.id, command: "printf '\\326\\320\\316\\304'" })
    assert.equal(gbk.stdout.trim(), '中文', 'gbk bytes decode to the same two characters')
    await ok('settings.update', { outputEncoding: 'utf8' })
    const utf8 = await ok('hosts.exec', { linkedId: link.id, command: "printf '\\326\\320\\316\\304'" })
    assert.notEqual(utf8.stdout.trim(), '中文', 'utf8 decoding of the same bytes differs')

    // Forget the key, then prove strict refuses the unknown host and tofu re-trusts it.
    const forgotten = await ok('hosts.forgetHostKey', { hostId: host.id })
    assert.equal(forgotten.removed, true, 'the stored key is removed')
    assert.equal((await ok('hosts.hostKeys', {})).entries.some((entry) => entry.authority === forgotten.authority), false, 'the list no longer has it')
    await ok('settings.update', { hostKeyPolicy: 'strict' })
    const strictRefusal = await call('fs.list', { remoteId, path: REMOTE_LINK_DIR })
    assert.equal(strictRefusal.payload.ok, false, 'strict refuses the unknown host')
    assert.equal(
      strictRefusal.status,
      409,
      `strict refusal should be 409: ${strictRefusal.status} ${JSON.stringify(strictRefusal.payload)}`,
    )
    await ok('settings.update', { hostKeyPolicy: 'tofu' })
    const retrusted = await ok('fs.list', { remoteId, path: REMOTE_LINK_DIR })
    assert.ok(Array.isArray(retrusted.entries), 'tofu trusts the host again')
    assert.equal((await ok('hosts.hostKeys', {})).entries.some((entry) => entry.authority === forgotten.authority), true, 'the key is remembered again')
    await ok('settings.update', { execEnabled: false, execHostIds: [] })
    step('hosts.hostKeys / forgetHostKey / outputEncoding', started, 'strict refused, tofu re-trusted')

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
    assert.equal(linkedList.links[0].workspaceId, link.workspaceId)
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
  } finally {
    // Cleanup: remove the workspace record and any remote leftovers. The
    // scratch tree is removed here rather than at the end of the happy path so
    // a failed assertion cannot leave it on the server (D5).
    try {
      await ok('fs.delete', { remoteId, path: REMOTE_LINK_DIR })
    } catch (error) {
      console.error('cleanup: could not remove the remote scratch tree', error && error.message ? error.message : error)
    }
    try {
      await ok('remote_workspaces.remove', { id: remoteId })
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
