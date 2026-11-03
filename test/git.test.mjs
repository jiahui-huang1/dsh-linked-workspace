/**
 * Tests for lib/git.js (git status + file-name search, local and remote).
 *
 *   node --test test/git.test.mjs
 *
 * The local half works inside mkdtemp directories that are removed afterwards.
 * The remote half is read-only: it connects to RTX-PRO-6000-1 through the same
 * host discovery and RemoteHost setup as test/ssh-smoke.mjs, and never writes
 * to the server.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { listHosts, RemoteHost, SshError } from '../lib/ssh.js'
import {
  CHANGE_STATUS,
  DEFAULT_EXCLUDES,
  localGitStatus,
  localSearch,
  parsePorcelainStatus,
  remoteGitStatus,
  remoteSearch,
} from '../lib/git.js'

const REMOTE_HOST_NAME = 'RTX-PRO-6000-1'
const REMOTE_REPO = '/shared_data_ssd1/huangjh/code/projects_weather_prediction/nsl-wp'
const REMOTE_META_DIR = '/shared_data_ssd1/huangjh'
const KNOWN_HOSTS_FILE = path.join(tmpdir(), `dshrw-git-test-known-hosts-${process.pid}.json`)

const CHANGE_STATES = [
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'conflicted',
  'typechange',
]

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Fresh temp directory, removed after the test. */
function makeTemp(t, prefix = 'dsh-linked-git-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort cleanup */
    }
  })
  return dir
}

/** Run a git sub-command in `cwd` synchronously. */
function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Create a repository with a stable local identity (never touches the user's git config). */
function initRepo(dir) {
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'dsh-linked-workspace@example.invalid')
  git(dir, 'config', 'user.name', 'DSH Linked Workspace Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function byPath(records, target) {
  return records.find((record) => record.path === target)
}

/**
 * Connect to the lab host for one test, disposing the connection afterwards.
 * Returns `{ skipped }` when the host is not configured on this machine.
 */
async function withRemote(callback) {
  const hosts = await listHosts()
  const target = hosts.find((entry) => entry.name === REMOTE_HOST_NAME)
  if (!target) return { skipped: `host "${REMOTE_HOST_NAME}" is not configured on this machine` }

  const remote = new RemoteHost({ host: target, knownHostsFile: KNOWN_HOSTS_FILE, connectTimeoutMs: 20000 })
  try {
    await remote.connect()
    return { value: await callback(remote) }
  } finally {
    await remote.dispose().catch(() => {})
  }
}

after(async () => {
  try {
    unlinkSync(KNOWN_HOSTS_FILE)
  } catch {
    /* never created */
  }
})

// ===========================================================================
// local git status
// ===========================================================================

test('localGitStatus reports modified, untracked and deleted files', async (t) => {
  const dir = makeTemp(t)
  initRepo(dir)
  writeFileSync(path.join(dir, 'committed.txt'), 'v1\n')
  writeFileSync(path.join(dir, 'deleted.txt'), 'bye\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'initial')

  writeFileSync(path.join(dir, 'committed.txt'), 'v2\n')
  writeFileSync(path.join(dir, 'untracked.txt'), 'new\n')
  unlinkSync(path.join(dir, 'deleted.txt'))

  const result = await localGitStatus(dir)

  assert.equal(result.ok, true)
  assert.equal(result.repo, true)
  assert.equal(path.resolve(result.root), path.resolve(realpathSync(dir)))
  assert.equal(typeof result.branch, 'string')
  assert.ok(result.branch.length > 0, 'a repository with a commit has a branch name')
  assert.equal(result.truncated, false)
  assert.equal(result.changes.length, 3)

  const modified = byPath(result.changes, 'committed.txt')
  assert.equal(modified.status, 'modified')
  assert.equal(modified.index, ' ')
  assert.equal(modified.worktree, 'M')
  assert.equal(modified.staged, false)
  assert.equal(modified.untracked, false)
  assert.equal(modified.absolutePath, path.resolve(result.root, 'committed.txt'))

  const untracked = byPath(result.changes, 'untracked.txt')
  assert.equal(untracked.status, 'untracked')
  assert.equal(untracked.index, '?')
  assert.equal(untracked.worktree, '?')
  assert.equal(untracked.staged, false)
  assert.equal(untracked.untracked, true)
  assert.equal(untracked.absolutePath, path.resolve(result.root, 'untracked.txt'))

  const deleted = byPath(result.changes, 'deleted.txt')
  assert.equal(deleted.status, 'deleted')
  assert.equal(deleted.index, ' ')
  assert.equal(deleted.worktree, 'D')
  assert.equal(deleted.staged, false)
  assert.equal(deleted.untracked, false)
  assert.equal(deleted.absolutePath, path.resolve(result.root, 'deleted.txt'))

  const paths = result.changes.map((change) => change.path)
  assert.deepEqual(paths, [...paths].sort(), 'changes are sorted by path')
})

test('localGitStatus marks staged additions and modifications', async (t) => {
  const dir = makeTemp(t)
  initRepo(dir)
  writeFileSync(path.join(dir, 'committed.txt'), 'v1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'initial')

  writeFileSync(path.join(dir, 'committed.txt'), 'v2\n')
  writeFileSync(path.join(dir, 'added.txt'), 'a\n')
  git(dir, 'add', 'committed.txt', 'added.txt')

  const result = await localGitStatus(dir)
  assert.equal(result.ok, true)
  assert.equal(result.repo, true)

  const modified = byPath(result.changes, 'committed.txt')
  assert.equal(modified.index, 'M')
  assert.equal(modified.worktree, ' ')
  assert.equal(modified.status, 'modified')
  assert.equal(modified.staged, true)

  const added = byPath(result.changes, 'added.txt')
  assert.equal(added.index, 'A')
  assert.equal(added.worktree, ' ')
  assert.equal(added.status, 'added')
  assert.equal(added.staged, true)
  assert.equal(added.untracked, false)
})

test('localGitStatus returns repo: false instead of throwing outside a repo', async (t) => {
  const dir = makeTemp(t, 'dsh-linked-nonrepo-')
  writeFileSync(path.join(dir, 'plain.txt'), 'not a repo\n')

  const result = await localGitStatus(dir)
  assert.equal(result.ok, true)
  assert.equal(result.repo, false)
  assert.equal(path.resolve(result.root), path.resolve(dir))
  assert.equal(result.branch, null)
  assert.deepEqual(result.changes, [])
})

// ===========================================================================
// local file search
// ===========================================================================

test('localSearch matches case-insensitively, skips excluded dirs and truncates', async (t) => {
  const dir = makeTemp(t)
  mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true })
  mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  mkdirSync(path.join(dir, '.venv'), { recursive: true })
  writeFileSync(path.join(dir, 'src', 'Alpha-MATCH.TXT'), 'content a\n')
  writeFileSync(path.join(dir, 'src', 'nested', 'beta-match.md'), 'content b\n')
  writeFileSync(path.join(dir, 'node_modules', 'x-match.txt'), 'must not match\n')
  writeFileSync(path.join(dir, '.venv', 'y-match.txt'), 'must not match\n')
  writeFileSync(path.join(dir, 'unrelated.txt'), 'nope\n')

  const result = await localSearch(dir, 'MaTcH')
  assert.equal(result.ok, true)
  assert.equal(result.query, 'MaTcH')
  assert.equal(result.truncated, false)
  assert.deepEqual(
    result.entries.map((entry) => entry.relative).sort(),
    ['src/Alpha-MATCH.TXT', 'src/nested/beta-match.md'],
  )
  for (const entry of result.entries) {
    assert.equal(path.isAbsolute(entry.path), true)
    assert.equal(entry.path, path.resolve(dir, ...entry.relative.split('/')))
    assert.equal(typeof entry.size, 'number')
    assert.ok(entry.size > 0)
    assert.equal(entry.relative.includes('\\'), false, 'relative paths are POSIX')
  }

  // Directories are never search hits.
  const dirOnly = await localSearch(dir, 'src')
  assert.equal(dirOnly.ok, true)
  assert.deepEqual(dirOnly.entries, [])

  // Blank or whitespace-only queries short-circuit.
  for (const blank of ['', '   ']) {
    const empty = await localSearch(dir, blank)
    assert.equal(empty.ok, true)
    assert.deepEqual(empty.entries, [])
    assert.equal(empty.truncated, false)
  }

  // maxResults caps the entries and reports truncation.
  const capped = await localSearch(dir, 'match', { maxResults: 1 })
  assert.equal(capped.ok, true)
  assert.equal(capped.entries.length, 1)
  assert.equal(capped.truncated, true)
  assert.ok(['src/Alpha-MATCH.TXT', 'src/nested/beta-match.md'].includes(capped.entries[0].relative))

  // A path that is not a directory is a clean error, not a throw.
  const missing = await localSearch(path.join(dir, 'missing-dir'), 'x')
  assert.equal(missing.ok, false)
  assert.equal(typeof missing.error, 'string')
  assert.deepEqual(missing.entries, [])
})

// ===========================================================================
// porcelain parsing
// ===========================================================================

test('parsePorcelainStatus parses -z entries, renames and conflicts', () => {
  assert.deepEqual(DEFAULT_EXCLUDES, [
    '.git',
    'node_modules',
    '__pycache__',
    '.conda',
    '.venv',
    '.mypy_cache',
    '.pytest_cache',
    '.ipynb_checkpoints',
    '.ruff_cache',
  ])
  assert.equal(CHANGE_STATUS['M '].code, 'modified')
  assert.equal(CHANGE_STATUS['M '].label.en, 'Modified')
  assert.equal(typeof CHANGE_STATUS['M '].label.zh, 'string')
  assert.equal(CHANGE_STATUS['??'].code, 'untracked')
  assert.equal(CHANGE_STATUS['UU'].code, 'conflicted')

  const raw =
    ' M src/a.ts\0' +
    'M  staged.ts\0' +
    'A  added.ts\0' +
    ' D gone.ts\0' +
    '?? new b.txt\0' +
    'R  new-name.ts\0old-name.ts\0' +
    'UU conflict.ts\0' +
    '!! ignored.log\0' +
    'T  type.bin\0'

  const parsed = parsePorcelainStatus(raw)
  assert.equal(parsed.length, 8, 'ignored entries are skipped')
  const paths = parsed.map((record) => record.path)
  assert.deepEqual(paths, [...paths].sort(), 'records are sorted by path')

  const modified = byPath(parsed, 'src/a.ts')
  assert.equal(modified.index, ' ')
  assert.equal(modified.worktree, 'M')
  assert.equal(modified.status, 'modified')
  assert.equal(modified.staged, false)
  assert.equal(modified.untracked, false)

  const staged = byPath(parsed, 'staged.ts')
  assert.equal(staged.status, 'modified')
  assert.equal(staged.staged, true)

  assert.equal(byPath(parsed, 'added.ts').status, 'added')
  assert.equal(byPath(parsed, 'added.ts').staged, true)
  assert.equal(byPath(parsed, 'gone.ts').status, 'deleted')
  assert.equal(byPath(parsed, 'type.bin').status, 'typechange')
  assert.equal(byPath(parsed, 'ignored.log'), undefined)

  const untracked = byPath(parsed, 'new b.txt')
  assert.equal(untracked.status, 'untracked')
  assert.equal(untracked.staged, false)
  assert.equal(untracked.untracked, true)

  const renamed = byPath(parsed, 'new-name.ts')
  assert.equal(renamed.status, 'renamed')
  assert.equal(renamed.index, 'R')
  assert.equal(renamed.worktree, ' ')
  assert.equal(renamed.staged, true)
  assert.equal(renamed.origPath, 'old-name.ts')

  const conflicted = byPath(parsed, 'conflict.ts')
  assert.equal(conflicted.status, 'conflicted')
  assert.equal(conflicted.index, 'U')
  assert.equal(conflicted.worktree, 'U')
  assert.equal(conflicted.staged, true)
  assert.equal(conflicted.untracked, false)

  for (const record of parsed) {
    assert.ok(CHANGE_STATES.includes(record.status), `unexpected status: ${record.status}`)
  }

  assert.deepEqual(parsePorcelainStatus(''), [])
  assert.deepEqual(parsePorcelainStatus(undefined), [])
  assert.equal(parsePorcelainStatus(Buffer.from(' M buffer.txt\0'))[0].path, 'buffer.txt')
})

// ===========================================================================
// remote command construction (no network)
// ===========================================================================

test('remoteSearch shell-quotes the query and falls back when find lacks -printf', async () => {
  const calls = []
  const files = ["/srv/proj/it's file.txt"]
  const fakeRemote = {
    exec: async (command) => {
      calls.push(command)
      if (command.includes('-printf')) {
        // BSD / BusyBox find: no -printf
        return { code: 2, stdout: '', stderr: 'find: -printf: unknown primary or operator' }
      }
      return { code: 0, stdout: `${files.join('\n')}\n`, stderr: '' }
    },
  }

  const result = await remoteSearch(fakeRemote, '/srv/proj', "it's")
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2, 'one -printf attempt and one fallback')
  assert.ok(calls[0].includes('-printf'))
  assert.ok(calls[0].includes(`-iname '*it'\\''s*'`), `query must be shell/glob quoted: ${calls[0]}`)
  assert.ok(calls[0].startsWith("find '/srv/proj'"))
  assert.equal(calls[1].includes('-printf'), false)
  // Fallback entries carry no size.
  assert.deepEqual(result.entries, [{ path: "/srv/proj/it's file.txt", relative: "it's file.txt", size: null }])
  assert.equal(result.truncated, false)
})

// ===========================================================================
// remote (read-only) checks against the lab server
// ===========================================================================

test('remoteGitStatus reports the nsl-wp repository shape', async (t) => {
  const outcome = await withRemote((remote) => remoteGitStatus(remote, REMOTE_REPO))
  if (outcome.skipped) return t.skip(outcome.skipped)

  const result = outcome.value
  assert.equal(result.ok, true)
  assert.equal(result.repo, true)
  assert.equal(result.root, REMOTE_REPO)
  assert.equal(typeof result.branch, 'string')
  assert.ok(result.branch.length > 0, 'the repository is on a branch')
  assert.ok(Array.isArray(result.changes))

  for (const change of result.changes) {
    assert.equal(typeof change.path, 'string')
    assert.ok(change.path.length > 0)
    assert.equal(change.path.startsWith('/'), false, 'change paths are repo-relative')
    assert.equal(change.absolutePath, path.posix.join(result.root, change.path))
    assert.equal(typeof change.index, 'string')
    assert.equal(typeof change.worktree, 'string')
    assert.equal(typeof change.staged, 'boolean')
    assert.equal(typeof change.untracked, 'boolean')
    assert.ok(CHANGE_STATES.includes(change.status), `unexpected status: ${change.status}`)
  }
  const paths = result.changes.map((change) => change.path)
  assert.deepEqual(paths, [...paths].sort(), 'changes are sorted by path')
})

test('remoteSearch returns at most maxResults existing paradis files', async (t) => {
  const outcome = await withRemote(async (remote) => {
    const result = await remoteSearch(remote, REMOTE_REPO, 'paradis', { maxResults: 10 })
    const stats = []
    for (const entry of result.entries) stats.push(await remote.stat(entry.path))
    return { result, stats }
  })
  if (outcome.skipped) return t.skip(outcome.skipped)

  const { result, stats } = outcome.value
  assert.equal(result.ok, true)
  assert.ok(result.entries.length > 0, 'the nsl-wp repository contains paradis files')
  assert.ok(result.entries.length <= 10, 'maxResults is respected')
  assert.equal(result.entries.length, stats.length)

  for (let index = 0; index < result.entries.length; index += 1) {
    const entry = result.entries[index]
    const info = stats[index]
    assert.equal(entry.path.startsWith('/'), true)
    assert.equal(entry.path.includes('\\'), false)
    assert.equal(path.posix.isAbsolute(entry.relative), false)
    assert.ok(path.posix.basename(entry.path).toLowerCase().includes('paradis'))
    assert.equal(info.type, 'file')
    assert.equal(info.path, entry.path)
    if (entry.size !== null) {
      assert.equal(typeof entry.size, 'number')
      assert.ok(entry.size >= 0)
    }
  }
})

test('remoteGitStatus on a non-repo directory does not throw', async (t) => {
  const outcome = await withRemote((remote) => remoteGitStatus(remote, REMOTE_META_DIR))
  if (outcome.skipped) return t.skip(outcome.skipped)

  const result = outcome.value
  assert.equal(typeof result.repo, 'boolean')
  assert.equal(result.ok, true)
  if (!result.repo) {
    assert.equal(result.branch, null)
    assert.deepEqual(result.changes, [])
    assert.equal(result.root, REMOTE_META_DIR)
  } else {
    assert.equal(typeof result.root, 'string')
    assert.ok(Array.isArray(result.changes))
  }
})

test('RemoteHost.exec returns stdout, stderr and exit code; timeout and abort reject', async (t) => {
  const outcome = await withRemote(async (remote) => {
    const ok = await remote.exec('echo hello && printf err >&2 && exit 3')
    const zero = await remote.exec('true')
    const timeoutError = await remote.exec('sleep 5', { timeoutMs: 200 }).then(
      () => null,
      (error) => error,
    )
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 200)
    const abortError = await remote.exec('sleep 5', { signal: controller.signal }).then(
      () => null,
      (error) => error,
    )
    clearTimeout(timer)
    return { ok, zero, timeoutError, abortError }
  })
  if (outcome.skipped) return t.skip(outcome.skipped)

  const { ok, zero, timeoutError, abortError } = outcome.value

  assert.equal(ok.stdout, 'hello\n')
  assert.equal(ok.stderr, 'err')
  assert.equal(ok.code, 3)
  assert.deepEqual(Object.keys(ok).sort(), ['code', 'stderr', 'stdout'])

  assert.equal(zero.code, 0)
  assert.equal(zero.stdout, '')
  assert.equal(zero.stderr, '')

  assert.ok(timeoutError, 'sleeping past timeoutMs must reject')
  assert.equal(timeoutError instanceof SshError, true)
  assert.equal(timeoutError.code, 'TIMEOUT')

  assert.ok(abortError, 'aborting the signal must reject')
  assert.equal(abortError.name, 'AbortError')
  assert.equal(abortError.code, 'ABORT_ERR')
})
