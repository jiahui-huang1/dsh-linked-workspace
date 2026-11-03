/**
 * dsh-linked-workspace — git status and file-name search helpers.
 *
 * Both halves of the sidebar (local and remote) need the same small views:
 *
 *   - the working-tree change list of a project, and
 *   - a "find a file by name" search that ignores dependency and cache dirs.
 *
 * This module implements them without npm dependencies. The remote variants
 * run `git` / `find` through `RemoteHost.exec`; the local variants use
 * node:child_process (never a shell) and a bounded directory walk.
 *
 * Path conventions:
 *   - a change record's `path` is repo-relative and POSIX ("src/a b.ts");
 *   - a change record's `absolutePath` is native (path.join/resolve) for a
 *     local repo and POSIX absolute for a remote repo;
 *   - a search hit's `path` is absolute and `relative` is POSIX.
 *
 * Expected negative outcomes (no git repo, no `git` binary, a query without
 * hits, an unreadable directory) are reported as `{ ok: false, error }` or as
 * an empty result — they never reject. Only a bug in the caller's arguments is
 * rejected, and only by returning `ok: false` as well.
 */

import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

// ── constants ───────────────────────────────────────────────────────────────

const DEFAULT_GIT_TIMEOUT_MS = 15_000
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000
const DEFAULT_MAX_CHANGES = 5_000
const DEFAULT_MAX_RESULTS = 200
const LOCAL_GIT_MAX_BUFFER = 16 * 1024 * 1024
const LOCAL_SEARCH_MAX_DEPTH = 8
const REMOTE_SEARCH_MAX_DEPTH = 8
const LOCAL_SEARCH_MAX_VISITED = 50_000

/**
 * Directory names never descended into by either search, matching what the
 * remote `find` command prunes. Order is kept stable for snapshot-ish callers.
 */
export const DEFAULT_EXCLUDES = Object.freeze([
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

/** Human labels for the normalized change states. */
const STATUS_LABELS = Object.freeze({
  modified: { zh: '已修改', en: 'Modified' },
  added: { zh: '新增', en: 'Added' },
  deleted: { zh: '已删除', en: 'Deleted' },
  renamed: { zh: '重命名', en: 'Renamed' },
  copied: { zh: '已复制', en: 'Copied' },
  untracked: { zh: '未跟踪', en: 'Untracked' },
  conflicted: { zh: '冲突', en: 'Conflicted' },
  typechange: { zh: '类型变更', en: 'Type changed' },
})

/**
 * Raw porcelain XY code -> normalized state. Only two-letter codes that git
 * actually emits are listed; anything else falls back to `deriveStatus`.
 */
const CHANGE_STATUS_RAW = {
  ' M': 'modified',
  'M ': 'modified',
  MM: 'modified',
  ' A': 'added',
  'A ': 'added',
  AM: 'added',
  ' D': 'deleted',
  'D ': 'deleted',
  'R ': 'renamed',
  RM: 'renamed',
  RD: 'renamed',
  ' R': 'renamed',
  'C ': 'copied',
  CM: 'copied',
  ' C': 'copied',
  '??': 'untracked',
  DD: 'conflicted',
  AU: 'conflicted',
  UD: 'conflicted',
  UA: 'conflicted',
  DU: 'conflicted',
  AA: 'conflicted',
  UU: 'conflicted',
  ' T': 'typechange',
  'T ': 'typechange',
  TM: 'typechange',
  MT: 'typechange',
}

/**
 * Map of raw `git status --porcelain=v1` XY code to
 * `{ code, label: { zh, en } }`, for the common states a change list shows.
 */
export const CHANGE_STATUS = Object.freeze(
  Object.fromEntries(
    Object.entries(CHANGE_STATUS_RAW).map(([xy, code]) => [
      xy,
      Object.freeze({ code, label: Object.freeze({ ...STATUS_LABELS[code] }) }),
    ]),
  ),
)

/** Unmerged (conflicted) porcelain code pairs. */
const CONFLICT_PAIRS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

// ── small helpers ───────────────────────────────────────────────────────────

function asOptions(value) {
  return value && typeof value === 'object' ? value : {}
}

function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function nonNegativeInt(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error === undefined || error === null ? 'unknown error' : error)
}

/** POSIX single-quote escaping (' → '\'') for a remote shell command. */
function shellSingleQuote(value) {
  const text = String(value === undefined || value === null ? '' : value)
  return `'${text.split("'").join("'\\''")}'`
}

/** Escape `find -iname` glob metacharacters so the query stays a literal. */
function escapeFindGlob(text) {
  return String(text).replace(/[\\*?[\]]/g, (character) => `\\${character}`)
}

function compareByPath(a, b) {
  if (a.path < b.path) return -1
  if (a.path > b.path) return 1
  return 0
}

function compareByRelative(a, b) {
  if (a.relative < b.relative) return -1
  if (a.relative > b.relative) return 1
  return 0
}

/** Normalize a caller-provided local path; `null` when unusable. */
function resolveLocalInput(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  return path.resolve(trimmed)
}

/** Normalize a caller-provided remote path (POSIX); `null` when unusable. */
function resolveRemoteInput(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  const normalized = path.posix.normalize(trimmed)
  return normalized === '' ? '.' : normalized
}

// ── porcelain parsing ───────────────────────────────────────────────────────

/** Derive a normalized state for XY pairs missing from CHANGE_STATUS. */
function deriveStatus(indexCode, worktreeCode) {
  const pair = `${indexCode}${worktreeCode}`
  if (pair === '??') return 'untracked'
  if (CONFLICT_PAIRS.has(pair)) return 'conflicted'
  if (indexCode === 'R' || worktreeCode === 'R') return 'renamed'
  if (indexCode === 'C' || worktreeCode === 'C') return 'copied'
  if (indexCode === 'T' || worktreeCode === 'T') return 'typechange'
  if (indexCode === 'D' || worktreeCode === 'D') return 'deleted'
  if (indexCode === 'A' || worktreeCode === 'A') return 'added'
  return 'modified'
}

/**
 * Parse `git status --porcelain=v1 -z --untracked-files=all` output.
 *
 * Entries are NUL separated and look like `XY <path>`; rename/copy entries are
 * followed by one extra NUL-terminated token holding the original path
 * (`R  new-name\0old-name\0`, as git emits it). Ignored (`!!`) entries — which
 * `--ignored=no` normally hides — are skipped.
 *
 * The returned records have no `absolutePath` (the parser does not know the
 * repo root); callers add it. Records are sorted by `path`.
 *
 * @param {string|Buffer} raw
 * @returns {Array<{ path: string, index: string, worktree: string,
 *   status: string, staged: boolean, untracked: boolean, origPath?: string }>}
 */
export function parsePorcelainStatus(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : ''
  if (!text) return []

  const records = []
  const tokens = text.split('\0')

  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index]
    if (!entry || entry.length < 4 || entry[2] !== ' ') continue

    const indexCode = entry[0]
    const worktreeCode = entry[1]
    if (indexCode === '!' && worktreeCode === '!') continue

    const entryPath = entry.slice(3)
    if (!entryPath) continue

    let origPath
    if (indexCode === 'R' || indexCode === 'C' || worktreeCode === 'R' || worktreeCode === 'C') {
      const next = tokens[index + 1]
      if (typeof next === 'string' && next !== '') {
        origPath = next
        index += 1
      }
    }

    const status = CHANGE_STATUS[`${indexCode}${worktreeCode}`]?.code ?? deriveStatus(indexCode, worktreeCode)
    const record = {
      path: entryPath,
      index: indexCode,
      worktree: worktreeCode,
      status,
      // '?' (untracked) is about the worktree, not a staged index change.
      staged: indexCode !== ' ' && indexCode !== '?',
      untracked: indexCode === '?' && worktreeCode === '?',
    }
    if (origPath !== undefined) record.origPath = origPath
    records.push(record)
  }

  records.sort(compareByPath)
  return records
}

// ── local git execution ─────────────────────────────────────────────────────

/**
 * Run git without a shell. Never rejects: always resolves with
 * `{ code, error, stdout, stderr }`, where `code` is the exit status, or null
 * when git could not run at all (spawn failure, timeout, abort, maxBuffer).
 */
function runLocalGit(args, options = {}) {
  const execOptions = {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: LOCAL_GIT_MAX_BUFFER,
    windowsHide: true,
    encoding: 'utf8',
  }
  if (options.signal) execOptions.signal = options.signal

  return new Promise((resolve) => {
    try {
      execFile('git', args, execOptions, (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          error: error || null,
          stdout: typeof stdout === 'string' ? stdout : String(stdout === undefined || stdout === null ? '' : stdout),
          stderr: typeof stderr === 'string' ? stderr : String(stderr === undefined || stderr === null ? '' : stderr),
        })
      })
    } catch (error) {
      resolve({ code: null, error, stdout: '', stderr: '' })
    }
  })
}

function describeGitFailure(result, label, timeoutMs) {
  const error = result.error
  if (!error) return `${label} failed`
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') return `${label} was aborted`
  if (error.killed || error.signal) return `${label} timed out after ${timeoutMs} ms`
  if (error.code === 'ENOENT') return 'the "git" executable was not found'
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `${label} produced too much output`
  const stderr = String(result.stderr || '').trim()
  if (stderr) return `${label} failed: ${stderr.split('\n')[0]}`
  return `${label} failed: ${errorMessage(error)}`
}

/**
 * Working-tree status of a local git repository.
 *
 * A directory that is not a repository is a normal answer:
 * `{ ok: true, repo: false, root, branch: null, changes: [] }`.
 *
 * @param {string} localPath directory to inspect (may be a subdirectory)
 * @param {{ timeoutMs?: number, signal?: AbortSignal, maxChanges?: number }} [options]
 * @returns {Promise<{ ok: boolean, repo: boolean, root: string,
 *   branch: string|null, changes: Array<object>, truncated?: boolean, error?: string }>}
 */
export async function localGitStatus(localPath, options = {}) {
  const opts = asOptions(options)
  const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_GIT_TIMEOUT_MS)
  const signal = opts.signal
  const requestedRoot = resolveLocalInput(localPath)
  if (!requestedRoot) {
    return {
      ok: false,
      repo: false,
      root: '',
      branch: null,
      changes: [],
      error: 'localPath must be a non-empty path string',
    }
  }

  const revParse = await runLocalGit(['-C', requestedRoot, 'rev-parse', '--show-toplevel'], { timeoutMs, signal })
  if (revParse.code === null) {
    return {
      ok: false,
      repo: false,
      root: requestedRoot,
      branch: null,
      changes: [],
      error: describeGitFailure(revParse, 'git rev-parse', timeoutMs),
    }
  }
  if (revParse.code !== 0) {
    return { ok: true, repo: false, root: requestedRoot, branch: null, changes: [] }
  }
  const topLevel = revParse.stdout.trim()
  if (!topLevel) {
    return { ok: true, repo: false, root: requestedRoot, branch: null, changes: [] }
  }
  const root = path.resolve(topLevel)

  const branchResult = await runLocalGit(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs, signal })
  const branch = branchResult.code === 0 && branchResult.stdout.trim() ? branchResult.stdout.trim() : null

  const statusResult = await runLocalGit(
    ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no'],
    { timeoutMs, signal },
  )
  if (statusResult.code === null || statusResult.code !== 0) {
    return { ok: false, repo: true, root, branch, changes: [], error: describeGitFailure(statusResult, 'git status', timeoutMs) }
  }

  const allChanges = parsePorcelainStatus(statusResult.stdout)
  const maxChanges = nonNegativeInt(opts.maxChanges, DEFAULT_MAX_CHANGES)
  const truncated = allChanges.length > maxChanges
  const changes = (truncated ? allChanges.slice(0, maxChanges) : allChanges).map((record) => ({
    ...record,
    absolutePath: path.resolve(root, record.path),
  }))
  return { ok: true, repo: true, root, branch, changes, truncated }
}

// ── remote exec wrapper ─────────────────────────────────────────────────────

/**
 * Run one remote command. Never rejects; resolves with
 * `{ ok: true, result: { stdout, stderr, code } }` or `{ ok: false, error }`.
 */
async function runRemote(remote, command, options = {}) {
  if (!remote || typeof remote.exec !== 'function') {
    return { ok: false, error: 'the remote host object does not provide exec()' }
  }
  const execOptions = { timeoutMs: options.timeoutMs }
  if (options.signal) execOptions.signal = options.signal
  try {
    const result = await remote.exec(command, execOptions)
    return { ok: true, result: result || { stdout: '', stderr: '', code: 0 } }
  } catch (error) {
    return { ok: false, error }
  }
}

function remoteCommandOutput(result) {
  return {
    stdout: String(result && result.stdout !== undefined && result.stdout !== null ? result.stdout : ''),
    stderr: String(result && result.stderr !== undefined && result.stderr !== null ? result.stderr : ''),
    code: result && typeof result.code === 'number' ? result.code : 0,
  }
}

/**
 * Working-tree status of a remote git repository, using `RemoteHost.exec`.
 * Same shape and semantics as `localGitStatus`.
 *
 * @param {{ exec: Function }} remote a connected RemoteHost
 * @param {string} remoteRoot remote directory to inspect
 * @param {{ timeoutMs?: number, signal?: AbortSignal, maxChanges?: number }} [options]
 */
export async function remoteGitStatus(remote, remoteRoot, options = {}) {
  const opts = asOptions(options)
  const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_GIT_TIMEOUT_MS)
  const signal = opts.signal
  const requestedRoot = resolveRemoteInput(remoteRoot)
  if (!requestedRoot) {
    return {
      ok: false,
      repo: false,
      root: '',
      branch: null,
      changes: [],
      error: 'remoteRoot must be a non-empty path string',
    }
  }
  if (!remote || typeof remote.exec !== 'function') {
    return {
      ok: false,
      repo: false,
      root: requestedRoot,
      branch: null,
      changes: [],
      error: 'the remote host object does not provide exec()',
    }
  }

  const revParse = await runRemote(remote, `git -C ${shellSingleQuote(requestedRoot)} rev-parse --show-toplevel`, {
    timeoutMs,
    signal,
  })
  if (!revParse.ok) {
    return {
      ok: false,
      repo: false,
      root: requestedRoot,
      branch: null,
      changes: [],
      error: errorMessage(revParse.error),
    }
  }
  const revParseOutput = remoteCommandOutput(revParse.result)
  const topLevel = revParseOutput.stdout.trim()
  // A non-zero exit means "not a repository" (or no git on the host) - normal.
  if (revParseOutput.code !== 0 || !topLevel) {
    return { ok: true, repo: false, root: requestedRoot, branch: null, changes: [] }
  }
  const root = path.posix.normalize(topLevel)

  const branchResult = await runRemote(remote, `git -C ${shellSingleQuote(root)} rev-parse --abbrev-ref HEAD`, {
    timeoutMs,
    signal,
  })
  let branch = null
  if (branchResult.ok) {
    const branchOutput = remoteCommandOutput(branchResult.result)
    if (branchOutput.code === 0) branch = branchOutput.stdout.trim() || null
  }

  const statusResult = await runRemote(
    remote,
    `git -C ${shellSingleQuote(root)} status --porcelain=v1 -z --untracked-files=all --ignored=no`,
    { timeoutMs, signal },
  )
  if (!statusResult.ok) {
    return { ok: false, repo: true, root, branch, changes: [], error: errorMessage(statusResult.error) }
  }
  const statusOutput = remoteCommandOutput(statusResult.result)
  if (statusOutput.code !== 0) {
    const firstLine = statusOutput.stderr.trim().split('\n')[0]
    return {
      ok: false,
      repo: true,
      root,
      branch,
      changes: [],
      error: firstLine || `git status exited with code ${statusOutput.code}`,
    }
  }

  const allChanges = parsePorcelainStatus(statusOutput.stdout)
  const maxChanges = nonNegativeInt(opts.maxChanges, DEFAULT_MAX_CHANGES)
  const truncated = allChanges.length > maxChanges
  const changes = (truncated ? allChanges.slice(0, maxChanges) : allChanges).map((record) => ({
    ...record,
    absolutePath: path.posix.join(root, record.path),
  }))
  return { ok: true, repo: true, root, branch, changes, truncated }
}

// ── file search ─────────────────────────────────────────────────────────────

function emptySearchResult(query) {
  return { ok: true, query, entries: [], truncated: false }
}

/**
 * Case-insensitive substring search over file names below `localPath`.
 *
 * Its rules mirror the remote `find` command: depth <= 8, `DEFAULT_EXCLUDES`
 * directories skipped, symlinks never followed, regular files only. The walk
 * is capped at 50,000 visited entries and `maxResults` hits.
 *
 * @param {string} localPath
 * @param {string} query
 * @param {{ maxResults?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: boolean, query: string,
 *   entries: Array<{ path: string, relative: string, size: number|null }>,
 *   truncated: boolean, error?: string }>}
 */
export async function localSearch(localPath, query, options = {}) {
  const opts = asOptions(options)
  const rawQuery = typeof query === 'string' ? query : ''
  const needle = rawQuery.trim()
  if (!needle) return emptySearchResult(rawQuery)
  if (needle.includes('\0')) {
    return { ok: false, query: rawQuery, entries: [], truncated: false, error: 'query must not contain NUL' }
  }

  const root = resolveLocalInput(localPath)
  if (!root) {
    return {
      ok: false,
      query: rawQuery,
      entries: [],
      truncated: false,
      error: 'localPath must be a non-empty path string',
    }
  }

  try {
    const info = await stat(root)
    if (!info.isDirectory()) {
      return { ok: false, query: rawQuery, entries: [], truncated: false, error: `Not a directory: ${root}` }
    }
  } catch (error) {
    return {
      ok: false,
      query: rawQuery,
      entries: [],
      truncated: false,
      error: `Cannot read ${root}: ${errorMessage(error)}`,
    }
  }

  const maxResults = nonNegativeInt(opts.maxResults, DEFAULT_MAX_RESULTS)
  const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS)
  const signal = opts.signal
  const lowerNeedle = needle.toLowerCase()
  const deadline = Date.now() + timeoutMs

  const entries = []
  let visited = 0
  let truncated = false
  let timedOut = false
  let aborted = false

  const walk = async (directory, segments, depth) => {
    if (truncated || timedOut || aborted) return
    let dirents
    try {
      dirents = await readdir(directory, { withFileTypes: true })
    } catch {
      return // unreadable directory: skip, never fail the whole search
    }
    // Stable, platform-independent order for deterministic results.
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const dirent of dirents) {
      if (truncated || timedOut || aborted) return
      if (signal && signal.aborted) {
        aborted = true
        return
      }
      if (Date.now() > deadline) {
        timedOut = true
        return
      }
      if (visited >= LOCAL_SEARCH_MAX_VISITED) {
        truncated = true
        return
      }
      visited += 1

      const name = dirent.name
      if (DEFAULT_EXCLUDES.includes(name)) continue
      if (dirent.isSymbolicLink()) continue

      const absolutePath = path.join(directory, name)
      const childSegments = segments.concat(name)

      if (dirent.isDirectory()) {
        // Files at depth 8 are still reported; deeper directories are not read.
        if (depth + 1 < LOCAL_SEARCH_MAX_DEPTH) await walk(absolutePath, childSegments, depth + 1)
        continue
      }
      if (!dirent.isFile()) continue
      if (!name.toLowerCase().includes(lowerNeedle)) continue

      let size = null
      try {
        const info = await stat(absolutePath)
        size = info.size
      } catch {
        /* unreadable file: still report the name match */
      }
      entries.push({ path: absolutePath, relative: childSegments.join('/'), size })
      if (entries.length > maxResults) {
        truncated = true
        return
      }
    }
  }

  try {
    await walk(root, [], 0)
  } catch (error) {
    return { ok: false, query: rawQuery, entries: [], truncated: false, error: errorMessage(error) }
  }

  if (aborted) {
    return { ok: false, query: rawQuery, entries: [], truncated: false, error: 'search was aborted' }
  }
  if (timedOut) {
    return { ok: false, query: rawQuery, entries: [], truncated: false, error: `search timed out after ${timeoutMs} ms` }
  }
  if (entries.length > maxResults) {
    truncated = true
    entries.length = maxResults
  }
  entries.sort(compareByRelative)
  return { ok: true, query: rawQuery, entries, truncated }
}

/**
 * Case-insensitive file-name search on a remote host, using `exec` + `find`.
 *
 * Prefers GNU `find -printf '%p\t%s\n'` for sizes; when the remote `find`
 * rejects `-printf` (BSD/macOS, BusyBox) it falls back to plain `find` output
 * with `size: null`. Output is bounded with `head -n maxResults + 1` so a
 * broad query cannot flood the channel.
 *
 * @param {{ exec: Function }} remote a connected RemoteHost
 * @param {string} remoteRoot
 * @param {string} query
 * @param {{ maxResults?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function remoteSearch(remote, remoteRoot, query, options = {}) {
  const opts = asOptions(options)
  const rawQuery = typeof query === 'string' ? query : ''
  const needle = rawQuery.trim()
  if (!needle) return emptySearchResult(rawQuery)
  if (needle.includes('\0')) {
    return { ok: false, query: rawQuery, entries: [], truncated: false, error: 'query must not contain NUL' }
  }

  const root = resolveRemoteInput(remoteRoot)
  if (!root) {
    return {
      ok: false,
      query: rawQuery,
      entries: [],
      truncated: false,
      error: 'remoteRoot must be a non-empty path string',
    }
  }
  if (!remote || typeof remote.exec !== 'function') {
    return {
      ok: false,
      query: rawQuery,
      entries: [],
      truncated: false,
      error: 'the remote host object does not provide exec()',
    }
  }

  const maxResults = nonNegativeInt(opts.maxResults, DEFAULT_MAX_RESULTS)
  const timeoutMs = positiveInt(opts.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS)
  const signal = opts.signal
  const limit = maxResults + 1

  const pattern = `*${escapeFindGlob(needle)}*`
  const prune = DEFAULT_EXCLUDES.map((name) => `-name ${shellSingleQuote(name)}`).join(' -o ')
  const baseFind = [
    'find',
    shellSingleQuote(root),
    '-maxdepth',
    String(REMOTE_SEARCH_MAX_DEPTH),
    `\\( ${prune} \\)`,
    '-prune',
    '-o',
    '-type',
    'f',
    '-iname',
    shellSingleQuote(pattern),
  ].join(' ')

  const first = await runRemote(remote, `${baseFind} -printf '%p\\t%s\\n' | head -n ${limit}`, { timeoutMs, signal })
  if (!first.ok) {
    return { ok: false, query: rawQuery, entries: [], truncated: false, error: errorMessage(first.error) }
  }

  let output = remoteCommandOutput(first.result)
  let sized = true
  let stderr = output.stderr

  // BSD/BusyBox find does not know -printf; retry without sizes.
  if (output.code !== 0 || /-printf|unknown primary|unrecognized|illegal|usage/i.test(output.stderr)) {
    const fallback = await runRemote(remote, `${baseFind} | head -n ${limit}`, { timeoutMs, signal })
    if (!fallback.ok) {
      return { ok: false, query: rawQuery, entries: [], truncated: false, error: errorMessage(fallback.error) }
    }
    output = remoteCommandOutput(fallback.result)
    sized = false
    stderr = output.stderr
    if (output.code !== 0) {
      const firstLine = output.stderr.trim().split('\n')[0]
      return {
        ok: false,
        query: rawQuery,
        entries: [],
        truncated: false,
        error: firstLine || `find exited with code ${output.code}`,
      }
    }
  }

  const lines = output.stdout.split('\n')
  const lowerNeedle = needle.toLowerCase()
  const entries = []
  let truncated = false

  for (const line of lines) {
    if (!line) continue
    let entryPath = line
    let size = null
    if (sized) {
      const tabIndex = line.lastIndexOf('\t')
      if (tabIndex > 0) {
        entryPath = line.slice(0, tabIndex)
        const parsedSize = Number(line.slice(tabIndex + 1))
        size = Number.isFinite(parsedSize) ? parsedSize : null
      }
    }
    if (!entryPath || entryPath.includes('\0')) continue

    const absolutePath = path.posix.normalize(entryPath)
    const relative = path.posix.relative(root, absolutePath)
    if (!relative || relative === '' || relative.startsWith('..') || path.posix.isAbsolute(relative)) continue
    if (!path.posix.basename(absolutePath).toLowerCase().includes(lowerNeedle)) continue

    entries.push({ path: absolutePath, relative, size })
    if (entries.length > maxResults) {
      truncated = true
      break
    }
  }

  if (entries.length === 0 && /no such file or directory|permission denied/i.test(stderr)) {
    const firstLine = stderr.trim().split('\n')[0]
    return { ok: false, query: rawQuery, entries: [], truncated: false, error: firstLine }
  }
  if (entries.length > maxResults) {
    truncated = true
    entries.length = maxResults
  }
  return { ok: true, query: rawQuery, entries, truncated }
}
