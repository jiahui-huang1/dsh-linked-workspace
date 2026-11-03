/**
 * dsh-linked-workspace - linked local workspaces (host half helpers).
 *
 * A linked workspace pairs one local directory with one remote directory.
 * The local directory owns two plugin-managed children:
 *
 *   .local/                 plugin-owned state and session intermediate files
 *   .local/linked.json      manifest describing this particular local directory
 *   .remote/                optional archive/mirror of remote files (mirror only)
 *
 * This module is deliberately self-contained: no SSH, no network, no
 * credentials. Remote paths are POSIX strings and are never resolved here;
 * the caller owns all remote-side containment and transport.
 *
 * Conventions:
 *   - Local paths use the platform `node:path`, so the same code works on a
 *     Windows host (drive letters, UNC shares) and on POSIX hosts.
 *   - JSON files are written atomically: a temp file in the target directory
 *     is renamed over the destination. Files are created with mode 0600;
 *     chmod is best effort on Windows.
 *   - Missing or corrupt JSON never throws: the store degrades to an empty
 *     registry so one bad file cannot break the plugin.
 *   - Only the documented LinkRecord fields are persisted, never credentials.
 */
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

// -- constants --------------------------------------------------------------

/** Per-workspace directory owned by this plugin. */
export const LINKED_DIR = '.local'

/** Manifest file (relative to the linked local directory). */
export const LINKED_MANIFEST = '.local/linked.json'

/** Optional archive/mirror of remote files. */
export const MIRROR_DIR = '.remote'

/** Store schema version written to the registry file. */
const DATA_VERSION = 1

/** The host platform folds path case on Windows. */
const CASE_INSENSITIVE = process.platform === 'win32'

/** Fields an update patch is allowed to change (id and createdAt are fixed). */
const ALLOWED_UPDATE_FIELDS = Object.freeze([
  'syncChoice',
  'name',
  'localPath',
  'hostId',
  'hostSnapshot',
  'remotePath',
  'mirror',
])

// -- small helpers ----------------------------------------------------------

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function readJsonFile(file) {
  try {
    return JSON.parse(stripBom(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

/** mkdir -p that tolerates a concurrently created directory. */
function ensureDir(directory, mode = 0o700) {
  try {
    mkdirSync(directory, { recursive: true, mode })
  } catch (error) {
    if (!existsSync(directory)) throw error
  }
}

/**
 * Write `data` to `file` through a same-directory temp file and a rename.
 * Rename is atomic on both NTFS and POSIX filesystems, so a reader never sees
 * a half-written file after a crash.
 */
function writeAtomic(file, data, mode = 0o600) {
  const directory = dirname(file)
  ensureDir(directory)
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, data, { mode })
    try {
      chmodSync(temp, mode)
    } catch {
      /* best effort (Windows has no POSIX permission bits) */
    }
    renameSync(temp, file)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      /* the original error is more useful */
    }
    throw error
  }
}

function writeJsonAtomic(file, value, mode = 0o600) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  writeAtomic(file, text, mode)
}

function pluginDataDir() {
  const override = process.env.DSH_LINKED_WORKSPACE_HOME || process.env.DSH_REMOTE_WORKSPACE_HOME
  if (override && override !== '') return override
  const home =
    process.env.DSH_HOME && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
  return join(home, 'linked-workspace')
}

function defaultStoreFile() {
  return join(pluginDataDir(), 'linked.json')
}

// -- path rules -------------------------------------------------------------

/**
 * Normalize a local path to an absolute, `resolve`d path.
 *
 * Throws TypeError('local path must be absolute') for missing, relative or
 * empty input. Windows drive letters are preserved as written; a relative
 * spelling such as `foo/bar` is never silently anchored to the cwd.
 */
export function normalizeLocalPath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new TypeError('local path must be absolute')
  }
  if (input.includes('\0')) throw new TypeError('local path must not contain NUL')
  if (!isAbsolute(input)) throw new TypeError('local path must be absolute')
  return resolve(input)
}

/**
 * Comparison key for local path identity: normalized, and lower-cased on
 * win32 (NTFS is case-insensitive by default). POSIX keeps the case.
 */
export function localPathKey(input) {
  const normalized = normalizeLocalPath(input)
  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized
}

/**
 * Normalize a POSIX relative path used below `.remote/`.
 *
 * - `''`, `'.'` and `'./'` map to the root (`''`).
 * - Empty and `.` segments collapse; repeated slashes collapse.
 * - Absolute paths, `..` segments, backslashes and NUL are rejected,
 *   because they could escape the mirror directory.
 * - Unicode file names pass through unchanged.
 */
export function sanitizeRelative(relativePath) {
  if (typeof relativePath !== 'string') {
    throw new TypeError('relative path must be a string')
  }
  if (relativePath.includes('\0')) {
    throw new TypeError('relative path must not contain NUL')
  }
  if (relativePath.startsWith('/')) {
    throw new TypeError('relative path must be relative')
  }
  const segments = []
  for (const segment of relativePath.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new TypeError('relative path must not escape its root')
    }
    if (segment.includes('\\')) {
      throw new TypeError('relative path must use forward slashes')
    }
    segments.push(segment)
  }
  return segments.join('/')
}

// -- link records -----------------------------------------------------------

function toPort(value) {
  const number =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number === 'number' && Number.isInteger(number)) {
    if (number > 0 && number < 65536) return number
  }
  return undefined
}

function normalizePort(value, fallback) {
  const candidate = toPort(value)
  if (candidate !== undefined) return candidate
  const previous = toPort(fallback)
  return previous === undefined ? 22 : previous
}

function toTimestamp(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    return Math.trunc(fallback)
  }
  return Date.now()
}

/**
 * Whitelist a host record down to the four display fields we may persist.
 * Anything else - notably passwords and private keys - is dropped here, so a
 * caller cannot accidentally persist credentials through this module.
 */
function sanitizeHostSnapshot(input, previous) {
  const source = isObject(input) ? input : {}
  const base = isObject(previous) ? previous : {}
  return {
    name: asString(source.name, asString(base.name, '')),
    host: asString(source.host, asString(base.host, '')),
    port: normalizePort(source.port, base.port),
    username: asString(source.username, asString(base.username, '')),
  }
}

/**
 * Build a persisted LinkRecord from untrusted JSON or caller input.
 * `previous` supplies defaults for a merge-style update.
 */
function sanitizeRecord(input, previous) {
  if (!isObject(input)) throw new TypeError('link record must be an object')
  const base = isObject(previous) ? previous : {}
  const localPath = normalizeLocalPath(input.localPath ?? base.localPath)
  const id = nonEmptyString(input.id) ?? nonEmptyString(base.id) ?? randomUUID()
  const name =
    asString(input.name, asString(base.name, '')) || basename(localPath)
  const hostId = asString(input.hostId, asString(base.hostId, ''))
  const remotePath = asString(input.remotePath, asString(base.remotePath, ''))
  const mirror =
    typeof input.mirror === 'boolean' ? input.mirror : base.mirror === true
  const syncChoice =
    typeof input.syncChoice === 'boolean' ? input.syncChoice : base.syncChoice === true
  const createdAt = toTimestamp(input.createdAt, base.createdAt)
  return {
    id,
    name,
    localPath,
    hostId,
    hostSnapshot: sanitizeHostSnapshot(input.hostSnapshot, base.hostSnapshot),
    remotePath,
    mirror,
    syncChoice,
    createdAt,
  }
}

// -- registry store ---------------------------------------------------------

/**
 * Persisted registry of linked workspaces.
 *
 * File layout: `{ "version": 1, "links": [LinkRecord, ...] }`.
 * The store is synchronous and defensive; every mutation persists immediately,
 * so a crash never leaves an in-memory-only record behind.
 */
export class LinkedStore {
  /**
   * @param {string} [file] absolute registry file; defaults to
   *   `$DSH_LINKED_WORKSPACE_HOME/linked.json` (or
   *   `$DSH_HOME/linked-workspace/linked.json`).
   */
  constructor(file) {
    this.file =
      typeof file === 'string' && file.trim() !== ''
        ? resolve(file)
        : defaultStoreFile()
    this.links = []
    this.load()
  }

  /** Reload records from disk, dropping anything malformed. */
  load() {
    const raw = readJsonFile(this.file)
    const source = Array.isArray(raw)
      ? raw
      : isObject(raw) && Array.isArray(raw.links)
        ? raw.links
        : []
    const seen = new Set()
    const links = []
    for (const item of source) {
      if (!isObject(item)) continue
      if (typeof item.id !== 'string' || item.id === '') continue
      if (typeof item.localPath !== 'string' || !isAbsolute(item.localPath)) continue
      try {
        const record = sanitizeRecord(item)
        if (seen.has(record.id)) continue
        seen.add(record.id)
        links.push(record)
      } catch {
        /* skip malformed entries instead of failing the whole registry */
      }
    }
    this.links = links
  }

  /** Records, in insertion order. Treat the objects as read-only. */
  list() {
    return this.links.slice()
  }

  /** @returns {object|undefined} */
  get(id) {
    if (typeof id !== 'string') return undefined
    return this.links.find((link) => link.id === id)
  }

  /** Look a record up by local path (normalized; case-insensitive on win32). */
  findByLocalPath(localPath) {
    let key
    try {
      key = localPathKey(localPath)
    } catch {
      return undefined
    }
    return this.links.find((link) => localPathKey(link.localPath) === key)
  }

  /** Validate, persist and return a record. An existing id is replaced. */
  add(record) {
    const next = sanitizeRecord(record)
    const previous = this.links
    const index = previous.findIndex((link) => link.id === next.id)
    this.links =
      index === -1
        ? [...previous, next]
        : previous.map((link, position) => (position === index ? next : link))
    try {
      this.save()
    } catch (error) {
      this.links = previous
      throw error
    }
    return next
  }

  /**
   * Merge allowed fields into an existing record, persist and return it.
   * `id` and `createdAt` cannot be changed. Unknown fields are ignored.
   * @returns {object|undefined} undefined when the id is unknown
   */
  update(id, patch) {
    if (typeof id !== 'string') return undefined
    if (!isObject(patch)) throw new TypeError('link patch must be an object')
    const index = this.links.findIndex((link) => link.id === id)
    if (index === -1) return undefined
    const current = this.links[index]
    const merged = { ...current }
    for (const field of ALLOWED_UPDATE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        merged[field] = patch[field]
      }
    }
    const next = sanitizeRecord(merged, current)
    const previous = this.links
    this.links = previous.map((link, position) =>
      position === index ? next : link,
    )
    try {
      this.save()
    } catch (error) {
      this.links = previous
      throw error
    }
    return next
  }

  /** @returns {boolean} true when a record was removed and persisted */
  remove(id) {
    if (typeof id !== 'string') return false
    const index = this.links.findIndex((link) => link.id === id)
    if (index === -1) return false
    const previous = this.links
    this.links = previous.filter((link) => link.id !== id)
    try {
      this.save()
    } catch (error) {
      this.links = previous
      throw error
    }
    return true
  }

  /** Persist the current registry atomically. */
  save() {
    writeJsonAtomic(this.file, { version: DATA_VERSION, links: this.links })
  }
}

// -- per-workspace layout ---------------------------------------------------

/** Read `.local/linked.json`; undefined when missing, unreadable or corrupt. */
export async function readLinkedManifest(localPath) {
  const root = normalizeLocalPath(localPath)
  const file = join(root, LINKED_MANIFEST)
  try {
    return JSON.parse(stripBom(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

/**
 * Create the linked-workspace layout:
 * `localPath/`, `localPath/.local/`, the manifest (atomically, 0600) and
 * `localPath/.remote/` when mirror mode is on.
 *
 * @returns {{ manifestPath: string, localPath: string, mirror: boolean }}
 */
export async function ensureLinkedLayout({ localPath, manifest, mirror } = {}) {
  const root = normalizeLocalPath(localPath)
  const wantsMirror = mirror === true
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(join(root, LINKED_DIR), { recursive: true, mode: 0o700 })
  const manifestPath = join(root, LINKED_MANIFEST)
  const value = manifest === undefined ? { version: DATA_VERSION } : manifest
  writeJsonAtomic(manifestPath, value, 0o600)
  if (wantsMirror) {
    mkdirSync(join(root, MIRROR_DIR), { recursive: true, mode: 0o700 })
  }
  return { manifestPath, localPath: root, mirror: wantsMirror }
}

/** Coerce mirror-file payloads to a Buffer. */
function toBuffer(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (Buffer.isBuffer(data)) return data
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  throw new TypeError('mirror file data must be a string, Buffer or Uint8Array')
}

function mirrorTarget(root, relativePath) {
  const relativeValue = sanitizeRelative(relativePath)
  if (relativeValue === '') throw new TypeError('relative path must name a file')
  return join(root, MIRROR_DIR, ...relativeValue.split('/'))
}

/**
 * Atomically write a remote file into `localPath/.remote/<relativePath>`.
 * Parent directories are created; the returned path is absolute.
 */
export async function writeMirrorFile(localPath, relativePath, data) {
  const root = normalizeLocalPath(localPath)
  const target = mirrorTarget(root, relativePath)
  writeAtomic(target, toBuffer(data), 0o600)
  return target
}

/** Read a mirrored file; undefined when it does not exist. */
export async function readMirrorFile(localPath, relativePath) {
  const root = normalizeLocalPath(localPath)
  const target = mirrorTarget(root, relativePath)
  try {
    return readFileSync(target)
  } catch (error) {
    const code = error && error.code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      return undefined
    }
    throw error
  }
}

/** True when `realTarget` is strictly below `realRoot` (both resolved). */
function isContained(realRoot, realTarget) {
  const offset = relative(realRoot, realTarget)
  return offset !== '' && !offset.startsWith('..') && !isAbsolute(offset)
}

/**
 * Remove empty parent directories of `target`, stopping at `stopAt` (exclusive).
 * Best effort: the first non-empty or unreadable directory ends the walk.
 */
function pruneEmptyParents(target, stopAt) {
  let directory = dirname(target)
  while (directory !== stopAt) {
    const offset = relative(stopAt, directory)
    if (offset === '' || offset.startsWith('..') || isAbsolute(offset)) break
    try {
      rmdirSync(directory)
    } catch {
      break
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
}

/**
 * Delete one path from the local mirror only: `<localPath>/.remote/<relativePath>`.
 * Works for files and directories. Missing paths are a strict no-op.
 *
 * The mirror root itself is rejected, and a path that resolves outside the
 * mirror (for example through a symlinked subdirectory, or through a symlinked
 * `.remote` root) is refused. After a successful delete, empty parent
 * directories below `.remote` are pruned so a deleted remote file does not
 * leave empty scaffolding behind.
 *
 * @returns {boolean} true when something was deleted, false for a no-op
 */
export async function removeMirrorPath(localPath, relativePath) {
  const root = normalizeLocalPath(localPath)
  const relativeValue = sanitizeRelative(relativePath)
  if (relativeValue === '') {
    throw new TypeError('relative path must not be the mirror root')
  }
  const mirrorRoot = join(root, MIRROR_DIR)
  const target = join(mirrorRoot, ...relativeValue.split('/'))

  // A symlinked `.remote` would redirect every operation outside the
  // workspace; refuse instead of deleting through it.
  let mirrorStats
  try {
    mirrorStats = lstatSync(mirrorRoot)
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
  if (mirrorStats.isSymbolicLink()) {
    const error = new Error(
      `refusing to remove ${target}: ${mirrorRoot} is a symbolic link`,
    )
    error.code = 'ELINKED_UNSAFE'
    throw error
  }

  let stats
  try {
    stats = lstatSync(target)
  } catch (error) {
    const code = error && error.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }

  if (stats.isSymbolicLink()) {
    // Delete the link itself, never what it points at.
    removeSymlink(target)
  } else {
    const realMirror = realpathSync(mirrorRoot)
    const realTarget = realpathSync(target)
    if (!isContained(realMirror, realTarget)) {
      const error = new Error(
        `refusing to remove ${target}: it resolves outside ${mirrorRoot}`,
      )
      error.code = 'ELINKED_UNSAFE'
      throw error
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 3 })
  }
  pruneEmptyParents(target, mirrorRoot)
  return true
}

/** Remove a symlink itself (never its target). */
function removeSymlink(target) {
  try {
    unlinkSync(target)
  } catch (error) {
    const code = error && error.code
    if (
      process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EACCES' || code === 'EISDIR')
    ) {
      // Windows directory symlinks/junctions: rmdir removes only the link.
      rmdirSync(target)
      return
    }
    throw error
  }
}

/**
 * Remove exactly one plugin-owned child directory.
 * A symlinked child is unlinked, never followed, so data outside `root`
 * cannot be deleted through it.
 */
function removeOwnedDir(target, root) {
  let stats
  try {
    stats = lstatSync(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
  if (stats.isSymbolicLink()) {
    removeSymlink(target)
    return true
  }
  const realRoot = realpathSync(root)
  const realTarget = realpathSync(target)
  if (!isContained(realRoot, realTarget)) {
    const error = new Error(
      `refusing to remove ${target}: it resolves outside ${root}`,
    )
    error.code = 'ELINKED_UNSAFE'
    throw error
  }
  rmSync(target, { recursive: true, force: true, maxRetries: 3 })
  return true
}

/**
 * Remove only `.local/` (always) and `.remote/` (when `mirror` is true).
 * Missing directories are ignored; every other file is left untouched.
 */
export async function removeLinkedLayout(localPath, { mirror = true } = {}) {
  const root = normalizeLocalPath(localPath)
  removeOwnedDir(join(root, LINKED_DIR), root)
  if (mirror === true) removeOwnedDir(join(root, MIRROR_DIR), root)
}

// -- local directory browsing ----------------------------------------------

/** Directory names sort case-insensitively, with a stable case tie-break. */
function compareNames(a, b) {
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function stripTrailingSeparators(value) {
  if (value.length <= 1) return value
  return value.replace(/[\\/]+$/, '')
}

function samePath(left, right) {
  const a = stripTrailingSeparators(left)
  const b = stripTrailingSeparators(right)
  return CASE_INSENSITIVE ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Parent directory for the browser, or null at the volume root. */
function parentOf(target) {
  const root = parse(target).root
  if (samePath(target, root)) return null
  const parent = dirname(target)
  if (samePath(parent, target)) return null
  return parent
}

/**
 * List immediate subdirectories of a local directory (hidden included).
 *
 * Files are skipped. Symlinked directories are listed as entries; symlinks are
 * never followed during the listing itself, so a directory symlink cycle
 * cannot loop. Errors keep their Node `code` (ENOENT, EACCES, ENOTDIR, ...)
 * so callers can map them to API error codes.
 *
 * @returns {{ path: string, parent: string|null, home: string,
 *            entries: Array<{ name: string, path: string }> }}
 */
export async function listLocalDirectories({ path, home } = {}) {
  const homePath =
    home === undefined || home === null
      ? normalizeLocalPath(homedir())
      : normalizeLocalPath(home)
  const target =
    path === undefined || path === null ? homePath : normalizeLocalPath(path)

  let dirents
  try {
    dirents = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    const wrapped = new Error(`cannot list ${target}: ${message}`, { cause: error })
    if (error && error.code) wrapped.code = error.code
    throw wrapped
  }

  const entries = []
  for (const dirent of dirents) {
    let isDirectory = dirent.isDirectory()
    if (!isDirectory && dirent.isSymbolicLink()) {
      try {
        isDirectory = statSync(join(target, dirent.name)).isDirectory()
      } catch {
        isDirectory = false
      }
    }
    if (!isDirectory) continue
    entries.push({ name: dirent.name, path: join(target, dirent.name) })
  }
  entries.sort(compareNames)

  return { path: target, parent: parentOf(target), home: homePath, entries }
}

function validateDirectoryName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('directory name must not be empty')
  }
  if (name === '.' || name === '..') {
    throw new TypeError('directory name must not be . or ..')
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new TypeError('directory name must not contain path separators')
  }
  if (name.includes('\0')) {
    throw new TypeError('directory name must not contain NUL')
  }
  return name
}

/**
 * Create one directory under `path` (same single-segment rule the directory
 * picker uses). Creating an existing directory is a no-op.
 *
 * @returns {{ path: string }}
 */
export async function createLocalDirectory({ path, name } = {}) {
  const parent = normalizeLocalPath(path)
  const directoryName = validateDirectoryName(name)
  const target = join(parent, directoryName)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  return { path: target }
}
