/**
 * Tests for lib/linked.js (linked local workspaces, host half).
 *
 *   node --test test/linked.test.mjs
 *
 * Every test works inside its own mkdtemp directory under the OS temp dir and
 * cleans it up afterwards. The real home directory is never modified.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, resolve, sep } from 'node:path'

import {
  LINKED_DIR,
  LINKED_MANIFEST,
  MIRROR_DIR,
  LinkedStore,
  createLocalDirectory,
  ensureLinkedLayout,
  listLocalDirectories,
  localPathKey,
  normalizeLocalPath,
  readLinkedManifest,
  readMirrorFile,
  removeLinkedLayout,
  removeMirrorPath,
  sanitizeRelative,
  writeMirrorFile,
} from '../lib/linked.js'

const isWindows = process.platform === 'win32'

/** Fresh temp directory, removed after the test. */
function makeTemp(t, prefix = 'dsh-linked-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort cleanup */
    }
  })
  return dir
}

/**
 * Create a directory symlink (junction on Windows, which needs no privileges).
 * Returns the symlink path, or undefined when the platform refuses.
 */
function tryDirectoryLink(target, linkPath) {
  const types = isWindows ? ['junction', 'dir'] : ['dir']
  for (const type of types) {
    try {
      symlinkSync(target, linkPath, type)
      return linkPath
    } catch {
      /* try the next link type */
    }
  }
  return undefined
}

// ===========================================================================
// LinkedStore
// ===========================================================================

test('LinkedStore tolerates a missing registry file', (t) => {
  const dir = makeTemp(t)
  const file = join(dir, 'nested', 'state', 'linked.json')
  const store = new LinkedStore(file)

  assert.equal(store.file, resolve(file))
  assert.deepEqual(store.list(), [])
  assert.equal(store.get('missing'), undefined)
  assert.equal(store.findByLocalPath(join(dir, 'unknown')), undefined)
  assert.equal(existsSync(file), false)
})

test('LinkedStore ignores corrupt or malformed registry files', (t) => {
  const dir = makeTemp(t)
  const file = join(dir, 'linked.json')
  const corrupt = [
    'not json at all',
    '{"version":1,"links":"nope"}',
    '{"version":1,"links":[null, 42]}',
    // entries without an id or without an absolute localPath are dropped
    '{"version":1,"links":[{"id":"x"},{"id":"y","localPath":"relative/dir"}]}',
  ]
  for (const content of corrupt) {
    writeFileSync(file, content)
    const store = new LinkedStore(file)
    assert.deepEqual(store.list(), [], `corrupt content should load as empty: ${content}`)
  }

  // a UTF-8 BOM must not break a valid file
  const valid = {
    version: 1,
    links: [
      {
        id: 'bom-1',
        name: 'bom',
        localPath: join(dir, 'project'),
        hostId: 'h',
        hostSnapshot: { name: 'n', host: '1.2.3.4', port: 22, username: 'u' },
        remotePath: '/srv/project',
        mirror: false,
        createdAt: 1,
      },
    ],
  }
  writeFileSync(file, `\uFEFF${JSON.stringify(valid)}`)
  assert.equal(new LinkedStore(file).get('bom-1').name, 'bom')
})

test('LinkedStore add/update/remove persist across instances', (t) => {
  const dir = makeTemp(t)
  const file = join(dir, 'state', 'linked.json')
  const project = join(dir, 'project')
  mkdirSync(project, { recursive: true })

  const store = new LinkedStore(file)
  const record = {
    id: 'link-1',
    name: 'Project',
    localPath: project,
    hostId: 'host-1',
    hostSnapshot: { name: 'node1', host: '10.0.0.1', port: 2222, username: 'huangjh' },
    remotePath: '/shared_data_ssd1/huangjh/project',
    mirror: false,
    createdAt: 1700000000000,
  }
  const added = store.add(record)

  assert.equal(added.id, 'link-1')
  assert.equal(added.localPath, normalizeLocalPath(project))
  assert.equal(added.createdAt, 1700000000000)
  assert.deepEqual(added.hostSnapshot, record.hostSnapshot)
  assert.equal(existsSync(file), true)
  assert.equal(store.get('link-1'), added)
  if (!isWindows) assert.equal(statSync(file).mode & 0o777, 0o600)
  // atomic write leaves no temp file behind
  assert.deepEqual(readdirSync(join(dir, 'state')), ['linked.json'])

  const reloaded = new LinkedStore(file)
  assert.deepEqual(reloaded.list(), [added])
  assert.deepEqual(reloaded.get('link-1'), added)

  const updated = reloaded.update('link-1', { name: 'Renamed', mirror: true })
  assert.equal(updated.name, 'Renamed')
  assert.equal(updated.mirror, true)
  assert.equal(updated.id, 'link-1')
  assert.equal(updated.createdAt, 1_700_000_000_000)

  // id and createdAt are immutable even if a patch tries to change them
  const guarded = new LinkedStore(file).update('link-1', {
    id: 'evil',
    createdAt: 1,
    unknownField: 'dropped',
  })
  assert.equal(guarded.id, 'link-1')
  assert.equal(guarded.createdAt, 1_700_000_000_000)
  assert.equal('unknownField' in guarded, false)

  // hostSnapshot patches merge with the existing snapshot
  const snapshot = new LinkedStore(file).update('link-1', {
    hostSnapshot: { host: '10.0.0.2' },
  })
  assert.equal(snapshot.hostSnapshot.host, '10.0.0.2')
  assert.equal(snapshot.hostSnapshot.name, 'node1')
  assert.equal(snapshot.hostSnapshot.port, 2222)
  assert.equal(snapshot.hostSnapshot.username, 'huangjh')

  assert.equal(new LinkedStore(file).updatedMissing, undefined)
  assert.equal(new LinkedStore(file).update('missing-id', { name: 'x' }), undefined)

  assert.equal(new LinkedStore(file).remove('link-1'), true)
  assert.deepEqual(new LinkedStore(file).list(), [])
  assert.equal(new LinkedStore(file).remove('link-1'), false)
})

test('LinkedStore generates ids and never persists extra secret fields', (t) => {
  const dir = makeTemp(t)
  const file = join(dir, 'linked.json')
  const store = new LinkedStore(file)
  const project = join(dir, 'other')
  mkdirSync(project, { recursive: true })

  const added = store.add({
    localPath: project,
    password: 'hunter2',
    privateKey: 'PRIVATE-KEY',
    hostSnapshot: {
      name: 'node1',
      host: '10.0.0.1',
      port: 22,
      username: 'huangjh',
      password: 'hunter2',
      privateKey: 'PRIVATE-KEY',
    },
  })

  assert.equal(typeof added.id, 'string')
  assert.ok(added.id.length > 0)
  assert.equal(added.name, 'other')
  assert.equal(added.mirror, false)
  assert.equal(typeof added.createdAt, 'number')

  const raw = readFileSync(file, 'utf8')
  assert.equal(raw.includes('hunter2'), false)
  assert.equal(raw.includes('PRIVATE-KEY'), false)
  assert.deepEqual(Object.keys(added.hostSnapshot).sort(), ['host', 'name', 'port', 'username'])
})

test('LinkedStore.findByLocalPath normalizes and is case-insensitive on win32', (t) => {
  const dir = makeTemp(t)
  const store = new LinkedStore(join(dir, 'links.json'))
  const project = join(dir, 'workspace', 'project')
  mkdirSync(project, { recursive: true })
  store.add({ id: 'p1', localPath: project, name: 'project' })

  // '.', '..' and a trailing separator normalize to the same path
  assert.equal(store.findByLocalPath(join(dir, 'workspace', '.', 'project')).id, 'p1')
  assert.equal(store.findByLocalPath(`${project}${sep}`).id, 'p1')
  assert.equal(store.findByLocalPath(join(dir, 'workspace', 'x', '..', 'project')).id, 'p1')

  // a relative reference is not a local path: undefined, never a throw
  assert.equal(store.findByLocalPath('relative/path'), undefined)
  assert.equal(store.findByLocalPath(''), undefined)
  assert.equal(store.findByLocalPath(null), undefined)

  if (isWindows) {
    assert.equal(store.findByLocalPath(project.toUpperCase()).id, 'p1')
    assert.equal(localPathKey(project), localPathKey(project.toLowerCase()))
  } else {
    assert.equal(store.findByLocalPath(project.toUpperCase()), undefined)
    assert.notEqual(localPathKey(project), localPathKey(project.toUpperCase()))
  }
})

test('LinkedStore defaults to the plugin data directory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-linked-env-'))
  const previous = process.env.DSH_LINKED_WORKSPACE_HOME
  process.env.DSH_LINKED_WORKSPACE_HOME = dir
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_LINKED_WORKSPACE_HOME
    else process.env.DSH_LINKED_WORKSPACE_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  })

  const store = new LinkedStore()
  assert.equal(store.file, join(resolve(dir), 'linked.json'))
  assert.deepEqual(store.list(), [])
})

// ===========================================================================
// local path rules
// ===========================================================================

test('normalizeLocalPath requires an absolute path', () => {
  for (const bad of ['relative/path', '.', '..', '', '   ', null, undefined, 42]) {
    assert.throws(
      () => normalizeLocalPath(bad),
      { name: 'TypeError', message: 'local path must be absolute' },
      `expected ${String(bad)} to be rejected`,
    )
  }
})

test('normalizeLocalPath resolves dot segments and preserves the root', (t) => {
  const dir = makeTemp(t)
  assert.equal(normalizeLocalPath(dir), resolve(dir))
  assert.equal(
    normalizeLocalPath(join(dir, 'a', '..', 'b', 'c')),
    resolve(join(dir, 'b', 'c')),
  )
  const root = parse(dir).root
  assert.equal(normalizeLocalPath(root), resolve(root))
})

test('normalizeLocalPath preserves Windows drive and UNC spellings', (t) => {
  if (!isWindows) {
    assert.equal(normalizeLocalPath('/tmp/example'), '/tmp/example')
    return
  }
  assert.equal(normalizeLocalPath('C:\\Users\\example'), resolve('C:\\Users\\example'))
  assert.equal(normalizeLocalPath('\\\\server\\share\\dir'), '\\\\server\\share\\dir')
  assert.throws(() => normalizeLocalPath('C:'), TypeError)
  assert.equal(localPathKey('C:\\Temp\\X'), localPathKey('c:\\temp\\x'))
  assert.equal(localPathKey('C:\\Temp\\X'), localPathKey('C:\\Temp\\X\\'))
})

test('sanitizeRelative collapses safe paths and rejects escapes', () => {
  assert.equal(sanitizeRelative(''), '')
  assert.equal(sanitizeRelative('.'), '')
  assert.equal(sanitizeRelative('./'), '')
  assert.equal(sanitizeRelative('a/b/c.txt'), 'a/b/c.txt')
  assert.equal(sanitizeRelative('a//b/'), 'a/b')
  assert.equal(sanitizeRelative('./a/./b'), 'a/b')
  assert.equal(sanitizeRelative('unicode/folder/文件 2026.txt'), 'unicode/folder/文件 2026.txt')

  for (const bad of [
    '/absolute/path',
    '//server/share',
    '/',
    '..',
    '../escape.txt',
    'a/../../escape.txt',
    'a\\b.txt',
    'C:\\Windows\\system32',
    'nested\\windows.txt',
    'a/\0/b',
    null,
    undefined,
    42,
  ]) {
    assert.throws(() => sanitizeRelative(bad), TypeError, `expected ${String(bad)} to be rejected`)
  }
})

// ===========================================================================
// per-workspace layout
// ===========================================================================

test('ensureLinkedLayout writes the manifest atomically and creates .local', async (t) => {
  const dir = makeTemp(t)
  const workspace = join(dir, 'nested', 'workspace')
  const manifest = { version: 1, linkedId: 'link-1', name: 'demo', mirror: false }

  const layout = await ensureLinkedLayout({ localPath: workspace, manifest, mirror: false })

  assert.equal(layout.localPath, normalizeLocalPath(workspace))
  assert.equal(layout.manifestPath, join(workspace, LINKED_MANIFEST))
  assert.equal(layout.mirror, false)
  assert.equal(existsSync(join(workspace, LINKED_DIR)), true)
  assert.equal(existsSync(join(workspace, MIRROR_DIR)), false)
  assert.equal(layout.manifestPath, join(workspace, '.local', 'linked.json'))

  const text = readFileSync(layout.manifestPath, 'utf8')
  assert.deepEqual(JSON.parse(text), manifest)
  assert.deepEqual(readdirSync(join(workspace, LINKED_DIR)), ['linked.json'])
  if (!isWindows) assert.equal(statSync(layout.manifestPath).mode & 0o777, 0o600)

  // roundtrip through the reader
  assert.deepEqual(await readLinkedManifest(workspace), manifest)

  // mirror mode adds .remote
  const mirrored = join(dir, 'mirrored')
  const mirroredLayout = await ensureLinkedLayout({
    localPath: mirrored,
    manifest: { version: 1 },
    mirror: true,
  })
  assert.equal(mirroredLayout.mirror, true)
  assert.equal(statSync(join(mirrored, MIRROR_DIR)).isDirectory(), true)

  // omitted manifest gets a minimal valid document
  const plain = join(dir, 'plain')
  await ensureLinkedLayout({ localPath: plain })
  assert.deepEqual(JSON.parse(readFileSync(join(plain, LINKED_MANIFEST), 'utf8')), {
    version: 1,
  })

  await assert.rejects(ensureLinkedLayout({ localPath: 'relative/dir' }), TypeError)
})

test('readLinkedManifest returns undefined for missing or corrupt files', async (t) => {
  const dir = makeTemp(t)
  const workspace = join(dir, 'workspace')
  assert.equal(await readLinkedManifest(workspace), undefined)

  mkdirSync(join(workspace, LINKED_DIR), { recursive: true })
  writeFileSync(join(workspace, LINKED_MANIFEST), '{not json')
  assert.equal(await readLinkedManifest(workspace), undefined)

  // a corrupt manifest is still readable once replaced with valid JSON
  writeFileSync(join(workspace, LINKED_MANIFEST), JSON.stringify({ version: 1, name: 'x' }))
  assert.deepEqual(await readLinkedManifest(workspace), { version: 1, name: 'x' })
})

// ===========================================================================
// mirror
// ===========================================================================

test('writeMirrorFile / readMirrorFile roundtrip nested payloads', async (t) => {
  const dir = makeTemp(t)
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })

  const target = await writeMirrorFile(workspace, 'a/b/c.txt', 'hello mirror')
  assert.equal(target, join(normalizeLocalPath(workspace), MIRROR_DIR, 'a', 'b', 'c.txt'))
  assert.equal(readFileSync(target, 'utf8'), 'hello mirror')

  const buffer = await readMirrorFile(workspace, 'a/b/c.txt')
  assert.equal(Buffer.isBuffer(buffer), true)
  assert.equal(buffer.toString(), 'hello mirror')

  await writeMirrorFile(workspace, 'bin.dat', Buffer.from([0, 1, 2, 255]))
  assert.deepEqual([...(await readMirrorFile(workspace, 'bin.dat'))], [0, 1, 2, 255])

  await writeMirrorFile(workspace, 'unicode/文件.txt', 'unicode payload')
  assert.equal((await readMirrorFile(workspace, 'unicode/文件.txt')).toString(), 'unicode payload')

  // overwriting is atomic and replaces content
  await writeMirrorFile(workspace, 'a/b/c.txt', 'second revision')
  assert.equal(readFileSync(target, 'utf8'), 'second revision')

  assert.equal(await readMirrorFile(workspace, 'a/b/missing.txt'), undefined)

  // traversal and absolute paths never write outside .remote
  for (const bad of ['../escape.txt', 'a/../../escape.txt', '/absolute.txt', 'a\\b.txt', '']) {
    await assert.rejects(writeMirrorFile(workspace, bad, 'x'), TypeError)
  }
  await writeMirrorFile(workspace, 'a/b/ok.txt', 'x')
  await assert.rejects(readMirrorFile(workspace, '../escape.txt'), TypeError)
  await assert.rejects(readMirrorFile(workspace, ''), TypeError)

  assert.equal(existsSync(join(workspace, 'escape.txt')), false)
  assert.equal(existsSync(join(dir, 'escape.txt')), false)
  assert.equal(existsSync(join(workspace, MIRROR_DIR, 'escaped')), false)
})

// ===========================================================================
// removeLinkedLayout
// ===========================================================================

test('removeLinkedLayout removes only .local and .remote', async (t) => {
  const dir = makeTemp(t)
  const workspace = join(dir, 'workspace')
  mkdirSync(join(workspace, LINKED_DIR, 'session'), { recursive: true })
  writeFileSync(join(workspace, LINKED_MANIFEST), '{}')
  mkdirSync(join(workspace, MIRROR_DIR, 'nested'), { recursive: true })
  writeFileSync(join(workspace, MIRROR_DIR, 'nested', 'file.txt'), 'x')
  writeFileSync(join(workspace, 'keep.txt'), 'keep me')
  const sibling = join(dir, 'sibling.txt')
  writeFileSync(sibling, 'sibling')

  await removeLinkedLayout(workspace)

  assert.equal(existsSync(join(workspace, LINKED_DIR)), false)
  assert.equal(existsSync(join(workspace, MIRROR_DIR)), false)
  assert.equal(readFileSync(join(workspace, 'keep.txt'), 'utf8'), 'keep me')
  assert.equal(readFileSync(sibling, 'utf8'), 'sibling')
  assert.equal(existsSync(workspace), true)

  // removing again is a silent no-op
  await removeLinkedLayout(workspace)

  // mirror: false leaves .remote alone
  const other = join(dir, 'other')
  mkdirSync(join(other, LINKED_DIR), { recursive: true })
  mkdirSync(join(other, MIRROR_DIR), { recursive: true })
  await removeLinkedLayout(other, { mirror: false })
  assert.equal(existsSync(join(other, LINKED_DIR)), false)
  assert.equal(existsSync(join(other, MIRROR_DIR)), true)

  await assert.rejects(removeLinkedLayout('relative/workspace'), TypeError)
})

test('removeLinkedLayout never deletes through a symlinked .local', async (t) => {
  const dir = makeTemp(t)
  const workspace = join(dir, 'workspace')
  const outside = join(dir, 'outside')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(outside, 'precious'), { recursive: true })
  writeFileSync(join(outside, 'precious', 'important.txt'), 'do not delete')

  const link = tryDirectoryLink(outside, join(workspace, LINKED_DIR))
  if (!link) {
    t.skip('this platform cannot create a directory symlink without extra privileges')
    return
  }
  assert.equal(lstatSync(join(workspace, LINKED_DIR)).isSymbolicLink(), true)

  await removeLinkedLayout(workspace)

  assert.equal(
    readFileSync(join(outside, 'precious', 'important.txt'), 'utf8'),
    'do not delete',
  )
  assert.equal(existsSync(join(outside, 'precious')), true)
  assert.equal(existsSync(join(workspace, LINKED_DIR)), false)
})

// ===========================================================================
// removeMirrorPath
// ===========================================================================

test('removeMirrorPath deletes mirrored files and prunes empty parents', async (t) => {
  const dir = makeTemp(t)
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })

  await writeMirrorFile(workspace, 'deep/nested/file.txt', 'content')
  assert.equal(await removeMirrorPath(workspace, 'deep/nested/file.txt'), true)
  assert.equal(existsSync(join(workspace, MIRROR_DIR, 'deep')), false)
  // the mirror root itself is never pruned
  assert.equal(statSync(join(workspace, MIRROR_DIR)).isDirectory(), true)

  // a surviving sibling keeps its parent directories
  await writeMirrorFile(workspace, 'keep/one.txt', 'one')
  await writeMirrorFile(workspace, 'keep/two.txt', 'two')
  assert.equal(await removeMirrorPath(workspace, 'keep/one.txt'), true)
  assert.equal(existsSync(join(workspace, MIRROR_DIR, 'keep', 'two.txt')), true)
  assert.equal(await removeMirrorPath(workspace, 'keep/two.txt'), true)
  assert.equal(existsSync(join(workspace, MIRROR_DIR, 'keep')), false)

  // directories are removed recursively, without touching siblings
  await writeMirrorFile(workspace, 'tree/a/x.txt', 'x')
  await writeMirrorFile(workspace, 'tree/b/y.txt', 'y')
  assert.equal(await removeMirrorPath(workspace, 'tree/a'), true)
  assert.equal(existsSync(join(workspace, MIRROR_DIR, 'tree', 'a')), false)
  assert.equal(existsSync(join(workspace, MIRROR_DIR, 'tree', 'b', 'y.txt')), true)

  // missing paths are a strict no-op, even before .remote exists
  assert.equal(await removeMirrorPath(workspace, 'nope/missing.txt'), false)
  assert.equal(await removeMirrorPath(join(dir, 'never-mirrored'), 'a/b.txt'), false)

  // the mirror root cannot be deleted through this helper
  for (const bad of ['', '.', './']) {
    await assert.rejects(removeMirrorPath(workspace, bad), TypeError)
  }
  assert.equal(statSync(join(workspace, MIRROR_DIR)).isDirectory(), true)

  // traversal and absolute paths are rejected
  for (const bad of ['../outside.txt', 'a/../../outside.txt', '/absolute.txt', 'a\\b.txt', null]) {
    await assert.rejects(removeMirrorPath(workspace, bad), TypeError)
  }
  assert.equal(existsSync(join(workspace, 'outside.txt')), false)
  assert.equal(existsSync(join(dir, 'outside.txt')), false)
})

test('removeMirrorPath never follows a symlink out of the mirror', async (t) => {
  const dir = makeTemp(t)
  const workspace = join(dir, 'workspace')
  const outside = join(dir, 'outside')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(outside, 'precious'), { recursive: true })
  writeFileSync(join(outside, 'precious', 'important.txt'), 'do not delete')
  mkdirSync(join(workspace, MIRROR_DIR), { recursive: true })

  const link = tryDirectoryLink(outside, join(workspace, MIRROR_DIR, 'linked'))
  if (!link) {
    t.skip('this platform cannot create a directory symlink without extra privileges')
    return
  }

  assert.equal(await removeMirrorPath(workspace, 'linked'), true)
  assert.equal(
    readFileSync(join(outside, 'precious', 'important.txt'), 'utf8'),
    'do not delete',
  )
  assert.equal(existsSync(join(workspace, MIRROR_DIR, 'linked')), false)

  // a symlinked .remote root is refused outright; its target is untouched
  const workspace2 = join(dir, 'workspace2')
  const outside2 = join(dir, 'outside2')
  mkdirSync(workspace2, { recursive: true })
  mkdirSync(outside2, { recursive: true })
  writeFileSync(join(outside2, 'important.txt'), 'keep')
  const rootLink = tryDirectoryLink(outside2, join(workspace2, MIRROR_DIR))
  if (rootLink) {
    await assert.rejects(removeMirrorPath(workspace2, 'important.txt'), (error) => {
      assert.equal(error.code, 'ELINKED_UNSAFE')
      return true
    })
    assert.equal(readFileSync(join(outside2, 'important.txt'), 'utf8'), 'keep')
  }
})

// ===========================================================================
// local directory browsing
// ===========================================================================

test('listLocalDirectories lists directories only, sorted case-insensitively', async (t) => {
  const dir = makeTemp(t)
  const home = join(dir, 'home')
  mkdirSync(join(home, 'alpha'), { recursive: true })
  mkdirSync(join(home, 'Beta'), { recursive: true })
  mkdirSync(join(home, '.hidden'), { recursive: true })
  mkdirSync(join(home, 'Gamma'), { recursive: true })
  writeFileSync(join(home, 'file.txt'), 'x')
  writeFileSync(join(home, '.hidden-file'), 'x')

  const target = join(dir, 'target')
  mkdirSync(target, { recursive: true })
  const linked = tryDirectoryLink(target, join(home, 'linked-dir'))

  const listing = await listLocalDirectories({ home })
  assert.equal(listing.path, normalizeLocalPath(home))
  assert.equal(listing.home, normalizeLocalPath(home))
  assert.equal(listing.parent, normalizeLocalPath(dir))

  const names = listing.entries.map((entry) => entry.name)
  const expected = ['.hidden', 'alpha', 'Beta', 'Gamma']
  if (linked) expected.push('linked-dir')
  assert.deepEqual(names, expected)
  assert.equal(names.includes('file.txt'), false)
  assert.equal(names.includes('.hidden-file'), false)
  for (const entry of listing.entries) {
    assert.equal(entry.path, join(listing.path, entry.name))
  }
  if (linked) {
    const linkedEntry = listing.entries.find((entry) => entry.name === 'linked-dir')
    assert.equal(linkedEntry.path, join(normalizeLocalPath(home), 'linked-dir'))
  }

  // explicit path + explicit home
  const sub = await listLocalDirectories({ path: join(home, 'alpha'), home })
  assert.equal(sub.path, normalizeLocalPath(join(home, 'alpha')))
  assert.equal(sub.parent, normalizeLocalPath(home))
  assert.equal(sub.home, normalizeLocalPath(home))
  assert.deepEqual(sub.entries, [])

  // parent is null at the volume root
  try {
    const rootListing = await listLocalDirectories({ path: parse(home).root, home })
    assert.equal(rootListing.parent, null)
  } catch (error) {
    if (error.code !== 'EACCES') throw error
  }
})

test('listLocalDirectories preserves fs error codes', async (t) => {
  const dir = makeTemp(t)
  const missing = join(dir, 'does-not-exist')
  await assert.rejects(listLocalDirectories({ path: missing, home: dir }), (error) => {
    assert.equal(error.code, 'ENOENT')
    assert.ok(error.message.includes(missing), `message should name the path: ${error.message}`)
    return true
  })
})

test('createLocalDirectory creates one segment and validates names', async (t) => {
  const dir = makeTemp(t)

  const created = await createLocalDirectory({ path: dir, name: 'new-folder' })
  assert.equal(created.path, join(normalizeLocalPath(dir), 'new-folder'))
  assert.equal(statSync(created.path).isDirectory(), true)

  // creating an existing directory is a no-op success
  const again = await createLocalDirectory({ path: dir, name: 'new-folder' })
  assert.equal(again.path, created.path)

  const unicode = await createLocalDirectory({ path: dir, name: '目录 名称' })
  assert.equal(statSync(unicode.path).isDirectory(), true)

  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '   ', null, undefined, 42]) {
    await assert.rejects(createLocalDirectory({ path: dir, name: bad }), TypeError)
  }
  await assert.rejects(createLocalDirectory({ path: 'relative', name: 'x' }), TypeError)

  assert.equal(existsSync(join(dir, 'a')), false)
  assert.equal(existsSync(join(dir, 'b')), false)
})
