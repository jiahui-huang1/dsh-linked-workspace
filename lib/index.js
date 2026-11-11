/**
 * dsh-linked-workspace — Host half.
 *
 * Turns connections the user already established in the SSH Manager (the
 * `dsh-ssh-tunnel` host store) or in `~/.ssh/config` into remote workspaces:
 * a persisted directory on another machine that the sidebar can browse, read
 * and edit through SFTP.
 *
 * The Host owns:
 *  - the persisted workspace registry ($DSH_HOME/linked-workspace/workspaces.json),
 *  - the SSH connection pool (one keepalive connection per host),
 *  - the JSON API the Client half calls over the DSH web server,
 *  - path containment, size limits and write-conflict detection.
 *
 * Credentials never leave this process: the client only sees host names,
 * addresses and workspace paths.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, readdir, stat as fsStat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listHosts, RemoteHost, SshError } from './ssh.js'
import * as linkedFs from './linked.js'
import * as git from './git.js'

/** Plugin identity for cordis.yml rows and the client-module table. */
export const name = 'dsh-linked-workspace'

/** The web server carries the JSON API; the rest are the linked-workspace tool faces. */
export const inject = ['webServer', 'tools', 'systemPrompt', 'workingDirectory']

const DATA_VERSION = 1
const SETTINGS_VERSION = 1
const SETTINGS_DEFAULTS = Object.freeze({ editorTheme: 'github-light', editorThemeFamily: 'github', editorThemeMode: 'system', fileOpenMode: 'editor', autoSave: false })
const EDITOR_THEME_FAMILIES = new Set(['github', 'solarized', 'one', 'dracula', 'monokai', 'nord', 'vscode', 'xcode', 'catppuccin'])
const THEME_FAMILY_OF = (id) => {
  const value = String(id || '')
  if (value.startsWith('solarized')) return 'solarized'
  if (value.startsWith('one')) return 'one'
  if (value.startsWith('dracula')) return 'dracula'
  if (value.startsWith('monokai')) return 'monokai'
  if (value.startsWith('nord')) return 'nord'
  if (value.startsWith('vs-')) return 'vscode'
  if (value.startsWith('xcode')) return 'xcode'
  if (value.startsWith('catppuccin')) return 'catppuccin'
  return 'github'
}
const EDITOR_THEME_MODES = new Set(['system', 'light', 'dark'])
const LIGHT_EDITOR_THEMES = new Set(['github-light', 'solarized-light', 'xcode-light'])
const LEGACY_THEME_MIGRATION = 'github-dark'
const FILE_OPEN_MODES = new Set(['editor', 'system', 'copy'])
const WORKSPACE_TITLE_PREFIX = '⇄ '
const LINKED_TOOL_NAME = 'linked_workspace'
const LINKED_PROMPT_SECTION = 'tool:linked-workspace'
const LINKED_READ_CAP = 512 * 1024
const LINKED_SYNC_FILES = 500
const LINKED_SYNC_BYTES = 50 * 1024 * 1024
const LINKED_SYNC_FILE = 20 * 1024 * 1024
const LINKED_SYNC_EXCLUDES = new Set(['.git', 'node_modules', '__pycache__', '.conda', '.venv', '.mypy_cache', '.pytest_cache', '.ipynb_checkpoints', '.ruff_cache'])
const LINKED_SYNC_TIMEOUT_MS = 30_000
const LINKED_SYNC_MAX_DEPTH = 24
const LINKED_OPEN_FILE_CAP = 64 * 1024 * 1024
const MAX_BODY_BYTES = 16 * 1024 * 1024
const EDITABLE_LIMIT = 2 * 1024 * 1024
const PEEK_LIMIT = 512 * 1024
const READ_CAP = 8 * 1024 * 1024
const MAX_WRITE_BYTES = 8 * 1024 * 1024
const MAX_MEDIA_BYTES = 24 * 1024 * 1024
const IMAGE_MIME = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
})
const MAX_NAME_LENGTH = 120
const CONNECT_TIMEOUT_MS = 20_000
const OP_TIMEOUT_MS = 60_000
// Directory listings are paged so a folder with tens of thousands of entries
// cannot stall the Host or flood the renderer.
const LIST_PAGE_SIZE = 500
const LIST_PAGE_MAX = 5000
// SFTP readdir has no paging, so a directory is always read in one call. A
// freshly read listing is kept briefly so "load more" does not repeat the same
// expensive scan; a first page (offset 0) is always re-read.
const LISTING_CACHE_TTL_MS = 5000
const LISTING_CACHE_LIMIT = 128
const listingCache = new Map()
const listingCacheKey = (scope, target) => `${scope.kind === 'linked' ? 'L' : 'W'}:${scope.id}:${target}`
const rememberListing = (key, listing) => {
  listingCache.delete(key)
  listingCache.set(key, { at: Date.now(), listing })
  while (listingCache.size > LISTING_CACHE_LIMIT) {
    listingCache.delete(listingCache.keys().next().value)
  }
}
const forgetListings = () => listingCache.clear()

/** Clamp a requested page window to the listing limits. */
const pageWindow = (params = {}, total = 0) => {
  const limit = Math.min(Math.max(Number(params.limit) || LIST_PAGE_SIZE, 1), LIST_PAGE_MAX)
  const offset = Math.min(Math.max(Number(params.offset) || 0, 0), Math.max(total, 0))
  return { limit, offset }
}

const LOG_PREFIX = '[dsh-linked-workspace]'

// ── errors ──────────────────────────────────────────────────────────────────

const ERROR_STATUS = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  SSH_CONNECT: 502,
  AUTH_FAILED: 401,
  HOST_KEY_MISMATCH: 409,
  TIMEOUT: 408,
  FS_NOT_FOUND: 404,
  FS_PERMISSION: 403,
  FS_IS_DIR: 400,
  FS_NOT_DIR: 400,
  FS_TOO_LARGE: 413,
  FS_INCOMPLETE: 500,
  FS_EXISTS: 409,
  CONFLICT: 409,
  INTERNAL: 500,
}

class ApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status ?? ERROR_STATUS[code] ?? 500
  }
}

function asApiError(error) {
  if (error instanceof ApiError) return error
  if (error instanceof SshError) {
    return new ApiError(error.code || 'INTERNAL', error.message || String(error), error.status)
  }
  const message = error && error.message ? error.message : String(error)
  return new ApiError('INTERNAL', message)
}

// ── small utilities ─────────────────────────────────────────────────────────

function log(level, message) {
  const line = `${LOG_PREFIX} ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

function dshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME !== '') return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

function dataDir() {
  // Testing/advanced knob; production uses the profile's DSH home. The legacy
  // variable name keeps older test scripts working.
  const override = process.env.DSH_LINKED_WORKSPACE_HOME || process.env.DSH_REMOTE_WORKSPACE_HOME
  if (override && override !== '') return override
  return join(dshHome(), 'linked-workspace')
}

/**
 * Rename the 0.1/0.2 data directory on first run after the plugin rename.
 * The registry, known hosts and settings are plain JSON, so a rename (falling
 * back to a recursive copy) preserves every configured workspace.
 */
function migrateLegacyDataDir(dir) {
  if (process.env.DSH_LINKED_WORKSPACE_HOME || process.env.DSH_REMOTE_WORKSPACE_HOME) return
  const legacy = join(dshHome(), 'remote-workspace')
  if (!existsSync(legacy) || existsSync(dir)) return
  try {
    mkdirSync(dirname(dir), { recursive: true })
    renameSync(legacy, dir)
    log('info', 'migrated data directory remote-workspace -> linked-workspace')
  } catch (error) {
    try {
      cpSync(legacy, dir, { recursive: true })
      log('info', `copied legacy data directory (rename failed: ${error && error.message ? error.message : error})`)
    } catch (copyError) {
      log('warn', `legacy data migration failed: ${copyError && copyError.message ? copyError.message : copyError}`)
    }
  }
}

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    if (!existsSync(dir)) throw error
  }
}

/** Open one absolute local path with the OS default application (best effort). */
function openWithSystem(targetPath) {
  let child
  try {
    if (process.platform === 'win32') {
      // explorer.exe resolves the file's default application and, unlike
      // "cmd /c start", it never re-parses &, spaces or quotes in the path.
      child = spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore', windowsHide: true })
    } else if (process.platform === 'darwin') {
      child = spawn('open', [targetPath], { detached: true, stdio: 'ignore' })
    } else {
      child = spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' })
    }
    if (typeof child.unref === 'function') child.unref()
    return true
  } catch (error) {
    log('warn', `cannot open ${targetPath}: ${error && error.message ? error.message : error}`)
    return false
  }
}

/** Spawn a detached console process and report whether the executable started. */
function launchDetached(command, args, extra = {}) {
  return new Promise((resolveLaunch) => {
    let child
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', ...extra })
    } catch {
      resolveLaunch(false)
      return
    }
    let settled = false
    child.once('error', () => {
      if (settled) return
      settled = true
      resolveLaunch(false)
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      try { child.unref() } catch { /* already detached */ }
      resolveLaunch(true)
    })
  })
}

function quotePosix(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

function quotePowerShell(text) {
  return `'${String(text).replace(/'/g, "''")}'`
}

function quoteAppleScript(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function remoteTerminalCommand(remotePath) {
  return `cd ${quotePosix(remotePath)} && exec bash -l`
}

function sshTarget(host, username) {
  return `${username || ''}@${host}`
}

/** Open a local terminal whose working directory is `dir`. */
async function openLocalTerminal(dir) {
  if (process.platform === 'win32') {
    if (await launchDetached('wt.exe', ['-d', dir], { windowsHide: false })) return true
    const script = `Set-Location -LiteralPath ${quotePowerShell(dir)}`
    return launchDetached('powershell.exe', ['-NoLogo', '-NoExit', '-Command', script], { windowsHide: false })
  }
  if (process.platform === 'darwin') {
    return launchDetached('open', ['-a', 'Terminal', dir])
  }
  if (await launchDetached('x-terminal-emulator', [`--working-directory=${dir}`])) return true
  return launchDetached('gnome-terminal', [`--working-directory=${dir}`])
}

/** Open a terminal that SSHes into `host` and cd's to `remotePath`. */
async function openRemoteTerminal(host, port, username, remotePath) {
  const target = sshTarget(host, username)
  const command = remoteTerminalCommand(remotePath)
  if (!username) return false
  if (process.platform === 'win32') {
    const sshArgs = ['-p', String(port || 22), '-t', `${username}@${host}`, command]
    if (await launchDetached('wt.exe', ['new-tab', '--', 'ssh.exe', ...sshArgs], { windowsHide: false })) return true
    const script = `& ssh.exe -p ${Number(port) || 22} -t ${quotePowerShell(`${username}@${host}`)} ${quotePowerShell(command)}`
    return launchDetached('powershell.exe', ['-NoLogo', '-NoExit', '-Command', script], { windowsHide: false })
  }
  if (process.platform === 'darwin') {
    const line = `ssh -p ${Number(port) || 22} -t ${target} ${command}`
    return launchDetached('osascript', ['-e', `tell application "Terminal" to do script ${quoteAppleScript(line)}`])
  }
  const sshArgs = ['-p', String(port || 22), '-t', target, command]
  if (await launchDetached('x-terminal-emulator', ['-e', 'ssh', ...sshArgs])) return true
  return launchDetached('gnome-terminal', ['--', 'ssh', ...sshArgs])
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file, value, mode) {
  ensureDir(dirname(file))
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: mode ?? 0o600 })
  try {
    chmodSync(temp, mode ?? 0o600)
  } catch {
    /* best effort (Windows) */
  }
  renameSync(temp, file)
}

/** Strip a trailing slash, keep '/' itself. */
function trimSlash(path) {
  if (path === '/') return path
  return path.replace(/\/+$/, '') || '/'
}

function isInside(root, target) {
  const base = trimSlash(root)
  const next = trimSlash(target)
  if (base === '/') return next.startsWith('/')
  return next === base || next.startsWith(`${base}/`)
}

function isInsideLocal(root, target) {
  const base = resolve(root)
  const next = resolve(target)
  return next === base || next.startsWith(`${base}${sep}`)
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ApiError('TIMEOUT', `${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new ApiError('BAD_REQUEST', 'request body too large', 413)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object')
    }
    return value
  } catch {
    throw new ApiError('BAD_REQUEST', 'invalid JSON body')
  }
}

// ── workspace registry ──────────────────────────────────────────────────────

class WorkspaceStore {
  constructor(file) {
    this.file = file
    this.workspaces = []
    this.load()
  }

  load() {
    const raw = readJsonFile(this.file, { version: DATA_VERSION, workspaces: [] })
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.workspaces) ? raw.workspaces : []
    this.workspaces = list.filter((item) => {
      return item && typeof item === 'object' && typeof item.id === 'string' && typeof item.remotePath === 'string'
    })
  }

  save() {
    writeJsonAtomic(this.file, { version: DATA_VERSION, workspaces: this.workspaces })
  }

  list() {
    return this.workspaces
  }

  get(id) {
    return this.workspaces.find((item) => item.id === id)
  }

  find(hostId, remotePath) {
    return this.workspaces.find((item) => item.hostId === hostId && item.remotePath === remotePath)
  }

  add(entry) {
    this.workspaces.push(entry)
    this.save()
    return entry
  }

  remove(id) {
    const next = this.workspaces.filter((item) => item.id !== id)
    if (next.length === this.workspaces.length) return false
    this.workspaces = next
    this.save()
    return true
  }

  rename(id, name) {
    const entry = this.get(id)
    if (!entry) return undefined
    entry.name = name
    this.save()
    return entry
  }

  updateSnapshot(hostId, snapshot) {
    let changed = false
    for (const entry of this.workspaces) {
      if (entry.hostId !== hostId) continue
      const next = { ...entry.hostSnapshot, ...snapshot }
      if (JSON.stringify(next) !== JSON.stringify(entry.hostSnapshot)) {
        entry.hostSnapshot = next
        changed = true
      }
    }
    if (changed) this.save()
  }
}

// ── settings ────────────────────────────────────────────────────────────────

function isThemeId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value)
}

class SettingsStore {
  constructor(file) {
    this.file = file
    this.value = { ...SETTINGS_DEFAULTS }
    const raw = readJsonFile(file, { version: SETTINGS_VERSION, settings: {} })
    const settings = raw && typeof raw === 'object' && raw.settings && typeof raw.settings === 'object'
      ? raw.settings
      : raw
    if (settings && typeof settings === 'object' && isThemeId(settings.editorTheme)) {
      this.value.editorTheme = settings.editorTheme
    }
    if (settings && typeof settings === 'object' && FILE_OPEN_MODES.has(settings.fileOpenMode)) {
      this.value.fileOpenMode = settings.fileOpenMode
    }
    if (settings && typeof settings === 'object' && typeof settings.autoSave === 'boolean') {
      this.value.autoSave = settings.autoSave
    }
    if (settings && typeof settings === 'object' && settings.themeExplicit === true) {
      this.themeExplicit = true
    }
    if (settings && typeof settings === 'object' && EDITOR_THEME_FAMILIES.has(settings.editorThemeFamily)) {
      this.value.editorThemeFamily = settings.editorThemeFamily
    } else if (raw && settings && typeof settings === 'object') {
      this.value.editorThemeFamily = THEME_FAMILY_OF(settings.editorTheme)
    }
    if (settings && typeof settings === 'object' && EDITOR_THEME_MODES.has(settings.editorThemeMode)) {
      this.value.editorThemeMode = settings.editorThemeMode
    } else if (raw && settings && typeof settings === 'object') {
      // 0.5.1: theme selection is a mode (system/light/dark) now. An old
      // explicit theme keeps its light/dark nature; the old implicit default
      // becomes "system".
      this.value.editorThemeMode = settings.themeExplicit === true
        ? (LIGHT_EDITOR_THEMES.has(settings.editorTheme) ? 'light' : 'dark')
        : 'system'
    }
    // 0.5.0: the default editor theme became GitHub Light. Existing settings
    // that still carry the old implicit dark default are migrated once; a
    // theme the user picked explicitly is preserved.
    if (raw && settings && settings.editorTheme === LEGACY_THEME_MIGRATION && settings.themeExplicit !== true) {
      this.value.editorTheme = SETTINGS_DEFAULTS.editorTheme
      writeJsonAtomic(this.file, { version: SETTINGS_VERSION, settings: { ...this.value, themeExplicit: false } })
    }
  }

  get() {
    return { ...this.value }
  }

  update(patch = {}) {
    if (patch && typeof patch === 'object' && patch.editorTheme !== undefined) {
      if (!isThemeId(patch.editorTheme)) throw new ApiError('BAD_REQUEST', '编辑器主题无效')
      this.value.editorTheme = patch.editorTheme
      this.themeExplicit = true
      if (patch.editorThemeMode === undefined) {
        this.value.editorThemeMode = LIGHT_EDITOR_THEMES.has(patch.editorTheme) ? 'light' : 'dark'
      }
    }
    if (patch && typeof patch === 'object' && patch.editorThemeFamily !== undefined) {
      if (!EDITOR_THEME_FAMILIES.has(patch.editorThemeFamily)) throw new ApiError('BAD_REQUEST', '编辑器主题无效')
      this.value.editorThemeFamily = patch.editorThemeFamily
    }
    if (patch && typeof patch === 'object' && patch.editorThemeMode !== undefined) {
      if (!EDITOR_THEME_MODES.has(patch.editorThemeMode)) throw new ApiError('BAD_REQUEST', '编辑器主题模式无效')
      this.value.editorThemeMode = patch.editorThemeMode
    }
    if (patch && typeof patch === 'object' && patch.fileOpenMode !== undefined) {
      if (!FILE_OPEN_MODES.has(patch.fileOpenMode)) throw new ApiError('BAD_REQUEST', '文件打开方式无效')
      this.value.fileOpenMode = patch.fileOpenMode
    }
    if (patch && typeof patch === 'object' && patch.autoSave !== undefined) {
      if (typeof patch.autoSave !== 'boolean') throw new ApiError('BAD_REQUEST', '自动保存设置无效')
      this.value.autoSave = patch.autoSave
    }
    writeJsonAtomic(this.file, { version: SETTINGS_VERSION, settings: { ...this.value, themeExplicit: this.themeExplicit === true } })
    return this.get()
  }
}

// ── local filesystem helpers ────────────────────────────────────────────────

function mapLocalFsError(error, fallback = 'INTERNAL') {
  const code = error && error.code
  if (code === 'ENOENT') return new ApiError('FS_NOT_FOUND', '本地路径不存在')
  if (code === 'EACCES' || code === 'EPERM') return new ApiError('FS_PERMISSION', '没有权限访问本地路径')
  if (code === 'ENOTDIR') return new ApiError('FS_NOT_DIR', '本地路径不是目录')
  if (code === 'EEXIST') return new ApiError('FS_EXISTS', '同名文件或文件夹已存在')
  return new ApiError(fallback, error && error.message ? error.message : String(error))
}

/**
 * Read at most `maxBytes` from the start of a local file.
 * Unlike readFileSync this never maps the whole file, so a peek at a huge
 * (or larger-than-2-GiB) file stays cheap.
 */
function readHeadSync(absolute, maxBytes) {
  const fd = openSync(absolute, 'r')
  try {
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(maxBytes, 16 * 1024 * 1024)))
    let filled = 0
    while (filled < buffer.length) {
      const read = readSync(fd, buffer, filled, buffer.length - filled, filled)
      if (read <= 0) break
      filled += read
    }
    return buffer.subarray(0, filled)
  } finally {
    closeSync(fd)
  }
}

function localDrives() {
  if (process.platform !== 'win32') return []
  const drives = []
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    const root = letter + ':\\'
    try {
      if (existsSync(root)) drives.push({ name: `${letter}:`, path: root })
    } catch {
      /* inaccessible drive */
    }
  }
  return drives
}

async function localBrowse(rawPath) {
  const home = homedir()
  const requested = typeof rawPath === 'string' ? rawPath.trim() : ''
  const target = requested === '' ? home : resolve(requested)
  if (!isAbsolute(target)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
  let info
  try {
    info = await fsStat(target)
  } catch (error) {
    throw mapLocalFsError(error)
  }
  if (!info.isDirectory()) throw new ApiError('FS_NOT_DIR', '本地路径不是目录')
  let rawEntries
  try {
    rawEntries = await readdir(target, { withFileTypes: true })
  } catch (error) {
    throw mapLocalFsError(error)
  }
  const entries = []
  for (const entry of rawEntries) {
    let isDirectory = entry.isDirectory()
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = (await fsStat(join(target, entry.name))).isDirectory()
      } catch {
        isDirectory = false
      }
    }
    if (!isDirectory) continue
    const name = entry.name
    if (name === '.git' || name === 'node_modules' || name === '__pycache__') continue
    entries.push({ name, path: join(target, name) })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  const parent = dirname(target) === target ? null : dirname(target)
  return { path: target, parent, home, entries, drives: localDrives() }
}

async function localMkdir(rawPath, rawName) {
  const parent = typeof rawPath === 'string' && rawPath.trim() !== '' ? resolve(rawPath.trim()) : ''
  if (parent === '' || !isAbsolute(parent)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (name === '' || name === '.' || name === '..' || /[/\\\u0000]/.test(name)) {
    throw new ApiError('BAD_REQUEST', '文件夹名称无效')
  }
  const target = join(parent, name)
  try {
    await mkdir(target)
  } catch (error) {
    throw mapLocalFsError(error)
  }
  return { path: target }
}

// ── DSH workspace registration helpers ──────────────────────────────────────

function workspacePathKey(path) {
  const normalized = resolve(String(path))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function linkedWorkspaceTitle(name) {
  return String(name || '').trim()
}

function findWorkspaceByPath(registry, localPath) {
  if (!registry || typeof registry.list !== 'function') return undefined
  try {
    const key = workspacePathKey(localPath)
    return registry.list().find((workspace) => workspacePathKey(workspace.path) === key)
  } catch {
    return undefined
  }
}

async function ensureDshWorkspace(registry, localPath, title) {
  if (!registry || typeof registry.create !== 'function') return undefined
  try {
    const workspace = await registry.create(localPath, title)
    return { id: String(workspace.id), title: workspace.title, path: workspace.path }
  } catch (error) {
    log('warn', `DSH workspace registration failed: ${error && error.message ? error.message : error}`)
    return undefined
  }
}

async function renameDshWorkspace(ctx, workspaceId, title) {
  if (!workspaceId) return
  try {
    const controller = ctx.get('workspaceController', true)
    if (controller && typeof controller.rename === 'function') {
      await controller.rename({ workspaceId, title })
    }
  } catch (error) {
    log('warn', `DSH workspace rename failed: ${error && error.message ? error.message : error}`)
  }
}

/** Create `.local/session/` (session intermediate files) and a short README. */
async function ensureLinkedStateDirs(localPath) {
  const localDir = join(localPath, linkedFs.LINKED_DIR)
  await mkdir(join(localDir, 'session'), { recursive: true })
  const readme = join(localDir, 'README.md')
  if (existsSync(readme)) return
  const text = [
    '# dsh-linked-workspace linked workspace',
    '',
    'This directory is owned by the dsh-linked-workspace plugin.',
    '',
    '- `linked.json` — the local ⇄ remote binding manifest (host, remote root, mirror flag).',
    '- `session/` — intermediate files that sessions may need. Safe to delete while no session is running.',
    '',
    'The local workspace itself is the DSH workspace; the project files live on the SSH host.',
    'Use the `linked_workspace` tool inside a session to read, search and edit them.',
    '',
  ].join('\n')
  try {
    writeFileSync(readme, text, { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    log('warn', `cannot write .local/README.md: ${error && error.message ? error.message : error}`)
  }
}

function linkedManifestFor(record) {
  return {
    version: 1,
    linkedId: record.id,
    name: record.name,
    hostId: record.hostId,
    hostName: record.hostSnapshot && record.hostSnapshot.name,
    host: record.hostSnapshot && record.hostSnapshot.host,
    port: record.hostSnapshot && record.hostSnapshot.port,
    username: record.hostSnapshot && record.hostSnapshot.username,
    remotePath: record.remotePath,
    mirror: Boolean(record.mirror),
    createdAt: record.createdAt,
  }
}

// ── connection pool ─────────────────────────────────────────────────────────

class HostPool {
  constructor({ knownHostsFile }) {
    this.knownHostsFile = knownHostsFile
    this.records = new Map() // hostId -> HostRecord
    this.connections = new Map() // hostId -> { authority, remote: RemoteHost }
    this.connecting = new Map() // hostId -> { authority, promise }
    this.statuses = new Map() // hostId -> { state, message?, latencyMs?, checkedAt }
  }

  setHosts(hosts) {
    this.records = new Map(hosts.map((host) => [host.id, host]))
    // Drop connections for hosts whose address changed.
    for (const [hostId, entry] of this.connections) {
      const host = this.records.get(hostId)
      const authority = host ? `${host.host}:${host.port}` : ''
      if (!host || entry.authority !== authority) {
        entry.remote.dispose().catch(() => {})
        this.connections.delete(hostId)
      }
    }
    // In-flight connects for removed or re-addressed hosts must not be reused:
    // the attempt itself notices the lost map entry and disposes its socket.
    for (const [hostId, pending] of [...this.connecting]) {
      const host = this.records.get(hostId)
      if (!host || `${host.host}:${host.port}` !== pending.authority) this.connecting.delete(hostId)
    }
  }

  host(hostId) {
    return this.records.get(hostId)
  }

  connection(hostId) {
    return this.connections.get(hostId)?.remote
  }

  status(hostId) {
    return this.statuses.get(hostId)
  }

  setStatus(hostId, status) {
    this.statuses.set(hostId, { ...status, checkedAt: Date.now() })
  }

  async remote(hostRecord) {
    const authority = `${hostRecord.host}:${hostRecord.port}`
    const existing = this.connections.get(hostRecord.id)
    if (existing && existing.authority === authority) {
      try {
        await existing.remote.ensureConnected()
        return existing.remote
      } catch (error) {
        existing.remote.dispose().catch(() => {})
        this.connections.delete(hostRecord.id)
        throw error
      }
    }
    // Two concurrent first requests for one host must share one connection;
    // otherwise the second RemoteHost overwrites the map entry and the first
    // SSH socket leaks. The pending attempt is bound to the address it dials,
    // so a host edit during connect never hands the old socket to the new
    // address.
    const pending = this.connecting.get(hostRecord.id)
    if (pending && pending.authority === authority) return pending.promise
    const remote = new RemoteHost({
      host: hostRecord,
      knownHostsFile: this.knownHostsFile,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      logger: log,
    })
    const entry = { authority, remote }
    this.connections.set(hostRecord.id, entry)
    const attempt = (async () => {
      try {
        await remote.connect()
        // The host may have been removed while the socket was connecting: keep
        // the map state authoritative so the unused connection is closed.
        if (this.connections.get(hostRecord.id) !== entry) {
          remote.dispose().catch(() => {})
        }
        return remote
      } catch (error) {
        if (this.connections.get(hostRecord.id) === entry) this.connections.delete(hostRecord.id)
        remote.dispose().catch(() => {})
        throw error
      } finally {
        const current = this.connecting.get(hostRecord.id)
        if (current && current.promise === attempt) this.connecting.delete(hostRecord.id)
      }
    })()
    this.connecting.set(hostRecord.id, { authority, promise: attempt })
    return attempt
  }

  async disposeAll() {
    const all = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(all.map((entry) => entry.remote.dispose().catch(() => {})))
  }
}

// ── Host plugin ─────────────────────────────────────────────────────────────

export function apply(ctx) {
  const dir = dataDir()
  migrateLegacyDataDir(dir)
  ensureDir(dir)
  const store = new WorkspaceStore(join(dir, 'workspaces.json'))
  const settingsStore = new SettingsStore(join(dir, 'settings.json'))
  const linkedStore = new linkedFs.LinkedStore(join(dir, 'linked.json'))
  // 0.5.0: mirror sync is opt-in. Records created under the old default
  // (mirror on, never explicitly chosen) are switched off once.
  for (const existing of linkedStore.list()) {
    if (existing.mirror === true && existing.syncChoice !== true) {
      try {
        linkedStore.update(existing.id, { mirror: false })
      } catch (error) {
        log('warn', `could not apply the opt-in sync default to ${existing.id}: ${error && error.message ? error.message : error}`)
      }
    }
  }
  const pool = new HostPool({ knownHostsFile: join(dir, 'known_hosts.json') })

  let hostsCache = null
  let hostsRefreshedAt = 0

  const refreshHosts = async (force) => {
    if (!force && hostsCache !== null && Date.now() - hostsRefreshedAt < 15_000) return hostsCache
    try {
      const hosts = await listHosts()
      hostsCache = hosts
      hostsRefreshedAt = Date.now()
      pool.setHosts(hosts)
      for (const host of hosts) {
        // Keep the denormalized snapshot fresh for every workspace on this host.
        store.updateSnapshot(host.id, {
          name: host.name,
          host: host.host,
          port: host.port,
          username: host.username,
        })
      }
      return hosts
    } catch (error) {
      log('warn', `cannot read SSH hosts: ${error && error.message ? error.message : error}`)
      if (hostsCache === null) {
        hostsCache = []
        pool.setHosts([])
      }
      return hostsCache
    }
  }

  const findHost = async (hostId) => {
    await refreshHosts()
    const host = pool.host(hostId)
    if (!host) throw new ApiError('NOT_FOUND', `SSH 主机不存在或已被移除: ${hostId}`)
    return host
  }

  const connectHost = async (host) => {
    const started = Date.now()
    try {
      const remote = await pool.remote(host)
      pool.setStatus(host.id, { state: 'connected', latencyMs: Date.now() - started })
      return remote
    } catch (error) {
      const apiError = asApiError(error)
      pool.setStatus(host.id, { state: 'error', message: apiError.message })
      throw apiError
    }
  }

  const requireWorkspace = (workspaceId) => {
    if (typeof workspaceId !== 'string' || workspaceId === '') {
      throw new ApiError('BAD_REQUEST', 'workspaceId is required')
    }
    const workspace = store.get(workspaceId)
    if (!workspace) throw new ApiError('NOT_FOUND', `远程工作区不存在: ${workspaceId}`)
    return workspace
  }

  const workspaceRemote = async (workspace) => {
    let host = pool.host(workspace.hostId)
    if (!host) {
      await refreshHosts(true)
      host = pool.host(workspace.hostId)
    }
    if (!host) {
      // Fall back to the snapshot so a temporarily unreadable SSH store still
      // produces a useful error instead of a generic 404.
      const snapshot = workspace.hostSnapshot || {}
      throw new ApiError(
        'NOT_FOUND',
        `SSH 连接不可用：主机「${snapshot.name || workspace.hostId}」已不在 SSH 管理器中`,
      )
    }
    return connectHost(host)
  }

  const normalizeRemotePath = async (remote, rawPath) => {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      throw new ApiError('BAD_REQUEST', 'path is required')
    }
    let target = rawPath.trim()
    if (target === '~' || target.startsWith('~/')) {
      const home = await remote.homeDir()
      target = target === '~' ? home : posix.join(home, target.slice(2))
    }
    if (!target.startsWith('/')) throw new ApiError('BAD_REQUEST', '远程路径必须是绝对路径（以 / 开头）')
    return posix.resolve(target)
  }

  const resolveInside = (workspace, rawPath) => {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new ApiError('BAD_REQUEST', 'path is required')
    const root = posix.resolve(workspace.remotePath)
    const target = posix.resolve(root, rawPath.trim())
    if (!isInside(root, target)) throw new ApiError('BAD_REQUEST', '路径超出该远程工作区的范围')
    return target
  }

  const relativeInside = (workspace, absolutePath) => {
    const root = posix.resolve(workspace.remotePath)
    if (absolutePath === root) return ''
    return absolutePath.slice(root.length + 1)
  }

  const describeWorkspace = (workspace) => {
    const host = pool.host(workspace.hostId)
    const snapshot = workspace.hostSnapshot || {}
    const status = pool.status(workspace.hostId)
    return {
      id: workspace.id,
      name: workspace.name,
      hostId: workspace.hostId,
      hostName: host ? host.name : snapshot.name || workspace.hostId,
      host: host ? host.host : snapshot.host || '',
      port: host ? host.port : snapshot.port || 22,
      username: host ? host.username : snapshot.username || '',
      remotePath: workspace.remotePath,
      createdAt: workspace.createdAt,
      status: {
        state: status ? status.state : 'idle',
        ...(status && status.message ? { message: status.message } : {}),
        ...(status && typeof status.latencyMs === 'number' ? { latencyMs: status.latencyMs } : {}),
      },
    }
  }

  // ── linked workspaces ───────────────────────────────────────────────────

  const linkedRegistry = () => {
    try {
      return ctx.get('workspaceRegistry', true)
    } catch {
      return undefined
    }
  }

  let runningCache = { at: 0, keys: new Set() }

  /** Local directories of linked workspaces that currently own a running Session. */
  const runningLocalKeys = async () => {
    const now = Date.now()
    if (now - runningCache.at < 2500) return runningCache.keys
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.list !== 'function') return runningCache.keys
    try {
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(4000) : undefined
      const result = await controller.list({}, signal)
      const items = result && Array.isArray(result.items) ? result.items : []
      const keys = new Set()
      for (const item of items) {
        if (item && item.running === true && typeof item.cwd === 'string' && item.cwd !== '') {
          keys.add(linkedFs.localPathKey(item.cwd))
        }
      }
      runningCache = { at: Date.now(), keys }
    } catch (error) {
      runningCache = { at: Date.now(), keys: new Set() }
    }
    return runningCache.keys
  }

  const describeLink = (record, runningKeys) => {
    const host = pool.host(record.hostId)
    const snapshot = record.hostSnapshot || {}
    const workspace = findWorkspaceByPath(linkedRegistry(), record.localPath)
    const status = pool.status(record.hostId)
    return {
      id: record.id,
      name: record.name,
      localPath: record.localPath,
      hostId: record.hostId,
      hostName: host ? host.name : snapshot.name || record.hostId,
      host: host ? host.host : snapshot.host || '',
      port: host ? host.port : snapshot.port || 22,
      username: host ? host.username : snapshot.username || '',
      remotePath: record.remotePath,
      mirror: Boolean(record.mirror),
      running: Boolean(runningKeys && runningKeys.has(linkedFs.localPathKey(record.localPath))),
      createdAt: record.createdAt,
      workspaceId: workspace ? String(workspace.id) : null,
      workspaceTitle: workspace ? workspace.title : null,
      status: {
        state: status ? status.state : 'idle',
        ...(status && status.message ? { message: status.message } : {}),
        ...(status && typeof status.latencyMs === 'number' ? { latencyMs: status.latencyMs } : {}),
      },
    }
  }

  /** Strip the old "⇄ " title prefix once; the sidebar icon is replaced by CSS. */
  const migrateLinkedWorkspaceTitles = async () => {
    const registry = linkedRegistry()
    if (!registry) return
    for (const record of linkedStore.list()) {
      const workspace = findWorkspaceByPath(registry, record.localPath)
      if (!workspace) continue
      const title = typeof workspace.title === 'string' ? workspace.title : ''
      if (!title.startsWith(WORKSPACE_TITLE_PREFIX)) continue
      const stripped = title.slice(WORKSPACE_TITLE_PREFIX.length).trim() || record.name
      await renameDshWorkspace(ctx, String(workspace.id), stripped)
      log('info', `stripped legacy title prefix from linked workspace "${stripped}"`)
    }
  }

  const requireLinked = (id) => {
    const record = linkedStore.get(id)
    if (!record) throw new ApiError('NOT_FOUND', `联动工作区不存在: ${id}`)
    return record
  }

  const hostForLink = async (record) => {
    let host = pool.host(record.hostId)
    if (!host) {
      await refreshHosts(true)
      host = pool.host(record.hostId)
    }
    if (!host) {
      const snapshot = record.hostSnapshot || {}
      throw new ApiError('NOT_FOUND', `SSH 连接不可用：主机「${snapshot.name || record.hostId}」已不在 SSH 管理器中`)
    }
    return connectHost(host)
  }

  const linkedRootOf = (record) => posix.resolve(record.remotePath)

  /** Resolve a tool/API path against the remote root; absolute paths must stay inside it. */
  const linkedTarget = (record, rawPath) => {
    const root = linkedRootOf(record)
    const text = typeof rawPath === 'string' ? rawPath.trim() : ''
    if (text === '') return root
    const target = text.startsWith('/') ? posix.resolve(text) : posix.resolve(root, text)
    if (!isInside(root, target)) throw new ApiError('BAD_REQUEST', '路径超出该联动工作区的远程根目录')
    return target
  }

  const linkedRelative = (record, target) => {
    const root = linkedRootOf(record)
    if (target === root) return ''
    return target.slice(root.length + 1)
  }

  const mirrorWrite = async (record, target, data) => {
    if (!record.mirror) return
    const relative = linkedRelative(record, target)
    if (relative === '') return
    try {
      await linkedFs.writeMirrorFile(record.localPath, relative, data)
    } catch (error) {
      log('warn', `mirror write failed for ${relative}: ${error && error.message ? error.message : error}`)
    }
  }

  // ── mirror sync jobs ───────────────────────────────────────────────────

  const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000
  const AUTO_SYNC_TICK_MS = 60 * 1000
  const autoSyncLast = new Map()

  /** Check every mirror-enabled linked workspace at most once per 5 minutes. */
  const autoSyncTick = () => {
    const now = Date.now()
    for (const record of linkedStore.list()) {
      if (record.mirror !== true) continue
      const last = autoSyncLast.get(record.id) || 0
      if (now - last < AUTO_SYNC_INTERVAL_MS) continue
      const running = syncJobs.get(record.id)
      if (running && running.state === 'running') continue
      autoSyncLast.set(record.id, now)
      try {
        startSyncJob(record, { reason: 'auto' })
        log('info', `auto sync started for "${record.name}"`)
      } catch (error) {
        log('warn', `auto sync for "${record.name}" failed to start: ${error && error.message ? error.message : error}`)
      }
    }
  }

  const syncJobs = new Map()

  const jobView = (job) => ({
    id: job.id,
    linkId: job.linkId,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    files: job.files,
    bytes: job.bytes,
    skipped: job.skipped,
    removed: job.removed,
    checked: job.checked,
    reason: job.reason,
    truncated: job.truncated,
    error: job.error,
    maxFiles: job.maxFiles,
    maxBytes: job.maxBytes,
    excludes: [...LINKED_SYNC_EXCLUDES],
  })

  const mirrorManifestPath = (record) => join(record.localPath, linkedFs.LINKED_DIR, 'mirror-manifest.json')

  const loadMirrorManifest = (record) => {
    const raw = readJsonFile(mirrorManifestPath(record), { version: 1, files: {} })
    if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object') return raw
    return { version: 1, files: {} }
  }

  const saveMirrorManifest = (record, manifest) => {
    try {
      writeJsonAtomic(mirrorManifestPath(record), { version: 1, files: manifest.files })
    } catch (error) {
      log('warn', `cannot save mirror manifest: ${error && error.message ? error.message : error}`)
    }
  }

  /**
   * Start (or return the running) background sync. Large projects blow past any
   * single HTTP request, so the job runs detached and the UI polls its status.
   * Unchanged files (size + mtime match the recorded manifest) are skipped, so
   * repeated syncs are cheap.
   */
  const startSyncJob = (record, options = {}) => {
    if (!record.mirror) throw new ApiError('BAD_REQUEST', '该联动工作区未启用 .remote 存档；请先在设置中打开镜像')
    const running = syncJobs.get(record.id)
    if (running && running.state === 'running') return running
    const job = {
      id: randomUUID(),
      linkId: record.id,
      state: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      files: 0,
      bytes: 0,
      skipped: 0,
      removed: 0,
      checked: 0,
      walkErrors: 0,
      reason: options.reason || 'manual',
      truncated: false,
      error: null,
      cancel: false,
      maxFiles: Math.min(Math.max(Number(options.maxFiles) || LINKED_SYNC_FILES, 1), 5000),
      maxBytes: Math.min(Math.max(Number(options.maxBytes) || LINKED_SYNC_BYTES, 1024 * 1024), 500 * 1024 * 1024),
    }
    syncJobs.set(record.id, job)
    job.promise = (async () => {
      try {
        const remote = await hostForLink(record)
        const root = linkedRootOf(record)
        const manifest = loadMirrorManifest(record)
        const seen = new Set()
        const shouldStop = () => job.cancel || job.files >= job.maxFiles || job.bytes >= job.maxBytes
        const visit = async (directory, depth) => {
          // Hitting the depth limit makes the scan incomplete, exactly like the
          // file/byte caps: flag it so the removal pass is skipped and the UI
          // can say the archive is partial.
          if (depth > LINKED_SYNC_MAX_DEPTH || shouldStop()) {
            if (!job.cancel) job.truncated = true
            return
          }
          let listing
          try {
            listing = await remote.listDir(directory)
          } catch (error) {
            job.walkErrors += 1
            job.skipped += 1
            return
          }
          for (const entry of listing.entries) {
            if (shouldStop()) {
              if (!job.cancel) job.truncated = true
              return
            }
            if (entry.type === 'dir') {
              if (LINKED_SYNC_EXCLUDES.has(entry.name)) {
                job.skipped += 1
                continue
              }
              await visit(entry.path, depth + 1)
              continue
            }
            if (entry.type !== 'file' || entry.size > LINKED_SYNC_FILE) {
              job.skipped += 1
              continue
            }
            const relative = posix.relative(root, entry.path)
            if (relative === '' || relative.startsWith('..')) {
              job.skipped += 1
              continue
            }
            seen.add(relative)
            const known = manifest.files[relative]
            if (known && known.size === entry.size && known.mtime === entry.mtime) {
              job.skipped += 1
              continue
            }
            try {
              const read = await withTimeout(
                remote.readFile(entry.path, { maxBytes: Math.min(entry.size, LINKED_SYNC_FILE) }),
                LINKED_SYNC_TIMEOUT_MS,
                `sync ${relative}`,
              )
              await linkedFs.writeMirrorFile(record.localPath, relative, read.data)
              manifest.files[relative] = { size: entry.size, mtime: entry.mtime, savedAt: Date.now() }
              job.files += 1
              job.bytes += read.data.length
              if (job.files % 25 === 0) saveMirrorManifest(record, manifest)
            } catch (error) {
              job.skipped += 1
            }
          }
        }
        await visit(root, 0)
        job.checked = seen.size
        // A full, error-free scan also removes mirror files whose remote
        // counterpart disappeared, so .remote matches the remote tree.
        if (!job.cancel && !job.truncated && job.walkErrors === 0) {
          for (const relative of Object.keys(manifest.files)) {
            if (seen.has(relative)) continue
            const top = relative.split('/')[0]
            if (LINKED_SYNC_EXCLUDES.has(top)) continue
            try {
              await linkedFs.removeMirrorPath(record.localPath, relative)
              delete manifest.files[relative]
              job.removed += 1
            } catch {
              /* best effort */
            }
          }
        }
        saveMirrorManifest(record, manifest)
        job.state = job.cancel ? 'cancelled' : 'done'
      } catch (error) {
        job.state = 'error'
        job.error = error && error.message ? error.message : String(error)
        log('warn', `sync job failed: ${job.error}`)
      } finally {
        job.finishedAt = Date.now()
      }
      return jobView(job)
    })()
    job.promise.catch(() => {})
    return job
  }

  /** Find the linked workspace a session belongs to (exact cwd or a directory inside it). */
  const resolveLinkedSelection = async (args, exec) => {
    const reference = args && typeof args.workspace === 'string' ? args.workspace.trim() : ''
    if (reference !== '') {
      const direct = linkedStore.get(reference)
      if (direct) return direct
      const byPath = linkedStore.findByLocalPath(reference)
      if (byPath) return byPath
      const byName = linkedStore.list().find((record) => record.name === reference)
      if (byName) return byName
      throw new ApiError('NOT_FOUND', `联动工作区不存在: ${reference}`)
    }
    if (!exec || !exec.agent) throw new ApiError('BAD_REQUEST', '需要 agent 会话或显式 workspace 参数')
    const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    const cwdKey = linkedFs.localPathKey(cwd)
    let best
    for (const record of linkedStore.list()) {
      const localKey = linkedFs.localPathKey(record.localPath)
      const matches = cwdKey === localKey || cwdKey.startsWith(`${localKey}${sep}`) || cwdKey.startsWith(`${localKey}/`)
      if (!matches) continue
      if (!best || localKey.length > best.key.length) best = { record, key: localKey }
    }
    if (!best) {
      throw new ApiError('NOT_FOUND', '当前会话工作目录不是联动工作区；先调用 action="list" 查看可用工作区，或用 workspace 参数指定')
    }
    return best.record
  }

  const linkedPrompt = [
    'Linked remote workspaces (dsh-linked-workspace)',
    'A workspace may pair a local directory with a remote directory on an SSH host (the local directory shows "⇄" in the sidebar).',
    'For these workspaces the session working directory is the LOCAL directory, while the real project files live under the REMOTE root.',
    `Use the \`${LINKED_TOOL_NAME}\` tool for remote files:`,
    '- action "list" returns every linked workspace with its local path, SSH host, remote root and mirror state.',
    '- action "list_dir" | "read" | "write" | "replace" | "stat" | "mkdir" | "rename" | "delete" takes `path` relative to the remote root (or an absolute path inside it).',
    '- Writes are atomic. Pass `if_modified_since` (epoch milliseconds from a previous read/stat) to refuse a stale overwrite.',
    '- action "sync" archives the remote tree into `.remote/` (only when the workspace mirrors).',
    'Local files — including `.local/` (manifest and session intermediates) and `.remote/` (archived copies) — still use the normal read/write/edit/bash tools.',
    'This session runs in the LOCAL directory: locally installed skills (~/.dsh/skills, ~/.agents/skills, <local>/.dsh/skills) remain available. Use `linked_skills` to list or read them; do NOT install skills into the remote project just to use them.',
    'Do not hand-edit `.remote/`; it is a mirror of the remote tree. Prefer linked_workspace over bash/read/write for anything under the remote root, and list first when unsure which workspace you are in.',
  ].join('\n')


  /** Unified remote scope: a direct remote directory or a linked workspace. */
  const requireScope = async (params = {}) => {
    if (typeof params.linkedId === 'string' && params.linkedId.trim() !== '') {
      const record = requireLinked(params.linkedId.trim())
      const remote = await hostForLink(record)
      return { kind: 'linked', record, remote, root: linkedRootOf(record) }
    }
    if (typeof params.workspaceId === 'string' && params.workspaceId.trim() !== '') {
      const workspace = requireWorkspace(params.workspaceId)
      const remote = await workspaceRemote(workspace)
      return { kind: 'workspace', workspace, remote, root: posix.resolve(workspace.remotePath) }
    }
    throw new ApiError('BAD_REQUEST', 'workspaceId or linkedId is required')
  }

  const scopeTarget = (scope, rawPath) => {
    const text = typeof rawPath === 'string' ? rawPath.trim() : ''
    if (text === '') return scope.root
    const target = text.startsWith('/') ? posix.resolve(text) : posix.resolve(scope.root, text)
    if (!isInside(scope.root, target)) throw new ApiError('BAD_REQUEST', '路径超出该工作区的范围')
    return target
  }

  const scopeRelative = (scope, target) => {
    if (target === scope.root) return ''
    return target.slice(scope.root.length + 1)
  }

  const scopeMirror = async (scope, target, data) => {
    if (scope.kind !== 'linked') return
    await mirrorWrite(scope.record, target, data)
  }

  const scopeMirrorRemove = async (scope, target) => {
    if (scope.kind !== 'linked') return
    try {
      await linkedFs.removeMirrorPath(scope.record.localPath, scopeRelative(scope, target))
    } catch {
      /* mirror cleanup is best effort */
    }
  }

  // ── context-menu / transfer helpers ─────────────────────────────────────

  const CONTEXT_TREE_LIMITS = { maxFiles: 150, maxBytes: 15 * 1024 * 1024, maxDepth: 12 }

  const downloadsFolder = () => join(homedir(), 'Downloads')

  const shellQuoteArg = (value) => `'${String(value).replace(/'/g, "'\\''")}'`

  const uniqueLocalPath = (baseDir, name) => {
    const safe = String(name || 'file').replace(/[\\/:*?"<>|]/g, '_')
    let candidate = join(baseDir, safe)
    if (!existsSync(candidate)) return candidate
    const dot = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const ext = dot > 0 ? safe.slice(dot) : ''
    for (let index = 2; index < 500; index += 1) {
      candidate = join(baseDir, `${stem} (${index})${ext}`)
      if (!existsSync(candidate)) return candidate
    }
    return join(baseDir, `${Date.now()}-${safe}`)
  }

  const remoteDeleteRecursive = async (remote, target) => {
    const stat = await remote.stat(target)
    if (stat.type !== 'dir') {
      await remote.unlink(target)
      return 1
    }
    let count = 1
    const listing = await remote.listDir(target)
    for (const entry of listing.entries) {
      if (entry.type === 'dir') count += await remoteDeleteRecursive(remote, entry.path)
      else {
        await remote.unlink(entry.path)
        count += 1
      }
    }
    await remote.rmdir(target)
    return count
  }

  const remoteCopyRecursive = async (remote, source, target) => {
    const stat = await remote.stat(source)
    if (stat.type !== 'dir') {
      // readFile truncates silently, so an oversized source has to be refused
      // here: copying only its first 64 MiB would corrupt the destination.
      if (stat.size > LINKED_OPEN_FILE_CAP) {
        throw new ApiError('FS_TOO_LARGE', `${posix.basename(source)} 超过 64 MB，无法复制`)
      }
      const read = await remote.readFile(source, { maxBytes: LINKED_OPEN_FILE_CAP })
      if (read.truncated || read.data.length !== stat.size) {
        throw new ApiError('FS_INCOMPLETE', `${posix.basename(source)} 读取不完整，已取消复制`)
      }
      await remote.writeFileAtomic(target, read.data)
      return 1
    }
    await remote.mkdirp(target)
    let count = 0
    const listing = await remote.listDir(source)
    for (const entry of listing.entries) {
      count += await remoteCopyRecursive(remote, entry.path, posix.join(target, entry.name))
    }
    return count
  }

  const remoteUniqueTarget = async (remote, dir, name) => {
    const safe = String(name || 'file')
    let candidate = posix.join(dir, safe)
    const dot = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const ext = dot > 0 ? safe.slice(dot) : ''
    let index = 2
    for (;;) {
      try {
        await remote.stat(candidate)
      } catch {
        return candidate
      }
      candidate = posix.join(dir, `${stem} copy${index > 2 ? ` ${index}` : ''}${ext}`)
      index += 1
      if (index > 500) return posix.join(dir, `${Date.now()}-${safe}`)
    }
  }

  /** Copy one local file/folder of a linked workspace to the same relative remote path. */
  const transferLocalToRemote = async (record, remote, rawPath) => {
    const localRoot = resolve(record.localPath)
    const source = resolve(String(rawPath || ''))
    if (source !== localRoot && !source.startsWith(localRoot + sep) && !source.startsWith(localRoot + '/')) {
      throw new ApiError('BAD_REQUEST', '本地路径不在联动工作区根目录内')
    }
    if (source === localRoot) throw new ApiError('BAD_REQUEST', '不能传输联动工作区的本地根目录')
    const relative = source.slice(localRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    if (relative === '') throw new ApiError('BAD_REQUEST', '无法计算相对路径')
    const target = posix.join(record.remotePath, relative)
    const limits = { files: 0, bytes: 0, skipped: 0, truncated: false }
    const visit = async (localPath, remotePath, depth) => {
      if (depth > CONTEXT_TREE_LIMITS.maxDepth || limits.files >= CONTEXT_TREE_LIMITS.maxFiles || limits.bytes >= CONTEXT_TREE_LIMITS.maxBytes) {
        limits.truncated = true
        return
      }
      let info
      try {
        info = await fsStat(localPath)
      } catch {
        limits.skipped += 1
        return
      }
      if (info.isDirectory()) {
        await remote.mkdirp(remotePath)
        const entries = await readdir(localPath, { withFileTypes: true })
        for (const entry of entries) {
          if (limits.files >= CONTEXT_TREE_LIMITS.maxFiles || limits.bytes >= CONTEXT_TREE_LIMITS.maxBytes) {
            limits.truncated = true
            return
          }
          await visit(join(localPath, entry.name), posix.join(remotePath, entry.name), depth + 1)
        }
        return
      }
      if (!info.isFile()) {
        limits.skipped += 1
        return
      }
      if (info.size > LINKED_SYNC_FILE) {
        limits.skipped += 1
        return
      }
      const data = readFileSync(localPath)
      await withTimeout(remote.writeFileAtomic(remotePath, data), LINKED_SYNC_TIMEOUT_MS, `transfer ${relative}`)
      limits.files += 1
      limits.bytes += data.length
    }
    await visit(source, target, 0)
    return { side: 'local', files: limits.files, bytes: limits.bytes, skipped: limits.skipped, truncated: limits.truncated, target }
  }

  /** Explicit SFTP transfer of one remote file/folder into <local>/.remote. */
  const transferToMirror = async (record, remote, target) => {
    const relative = linkedRelative(record, target)
    if (relative === '') throw new ApiError('BAD_REQUEST', '不能传输联动工作区根目录')
    const limits = { files: 0, bytes: 0, skipped: 0, truncated: false }
    const visit = async (remotePath, rel, depth) => {
      if (depth > CONTEXT_TREE_LIMITS.maxDepth || limits.files >= CONTEXT_TREE_LIMITS.maxFiles || limits.bytes >= CONTEXT_TREE_LIMITS.maxBytes) {
        limits.truncated = true
        return
      }
      const stat = await remote.stat(remotePath)
      if (stat.type === 'dir') {
        const listing = await remote.listDir(remotePath)
        for (const entry of listing.entries) {
          if (limits.files >= CONTEXT_TREE_LIMITS.maxFiles || limits.bytes >= CONTEXT_TREE_LIMITS.maxBytes) {
            limits.truncated = true
            return
          }
          await visit(entry.path, posix.join(rel, entry.name), depth + 1)
        }
        return
      }
      if (stat.type !== 'file') return
      if (stat.size > LINKED_SYNC_FILE) {
        limits.skipped += 1
        return
      }
      const read = await withTimeout(remote.readFile(remotePath, { maxBytes: LINKED_SYNC_FILE }), LINKED_SYNC_TIMEOUT_MS, `transfer ${rel}`)
      await linkedFs.writeMirrorFile(record.localPath, rel, read.data)
      limits.files += 1
      limits.bytes += read.data.length
    }
    const stat = await remote.stat(target)
    if (stat.type !== 'dir') {
      if (stat.size > LINKED_SYNC_FILE) throw new ApiError('FS_TOO_LARGE', '文件超过 20 MB，请使用同步任务')
      const read = await withTimeout(remote.readFile(target, { maxBytes: LINKED_SYNC_FILE }), LINKED_SYNC_TIMEOUT_MS, 'transfer file')
      await linkedFs.writeMirrorFile(record.localPath, relative, read.data)
      return { files: 1, bytes: read.data.length, skipped: 0, truncated: false, dest: join(record.localPath, linkedFs.MIRROR_DIR, relative) }
    }
    await visit(target, relative, 0)
    return { ...limits, dest: join(record.localPath, linkedFs.MIRROR_DIR, relative) }
  }

  /** Download one remote file/folder into the OS Downloads folder. */
  const downloadRemotePath = async (remote, target, destDir) => {
    await mkdir(destDir, { recursive: true })
    const stat = await remote.stat(target)
    const baseName = posix.basename(target) || 'remote'
    const destination = uniqueLocalPath(destDir, baseName)
    if (stat.type !== 'file') {
      const limits = { files: 0, bytes: 0, skipped: 0, truncated: false }
      const visit = async (remotePath, localPath, depth) => {
        if (depth > CONTEXT_TREE_LIMITS.maxDepth || limits.files >= CONTEXT_TREE_LIMITS.maxFiles || limits.bytes >= CONTEXT_TREE_LIMITS.maxBytes) {
          limits.truncated = true
          return
        }
        const entryStat = await remote.stat(remotePath)
        if (entryStat.type === 'dir') {
          await mkdir(localPath, { recursive: true })
          const listing = await remote.listDir(remotePath)
          for (const entry of listing.entries) {
            if (limits.files >= CONTEXT_TREE_LIMITS.maxFiles || limits.bytes >= CONTEXT_TREE_LIMITS.maxBytes) {
              limits.truncated = true
              return
            }
            await visit(entry.path, join(localPath, entry.name), depth + 1)
          }
          return
        }
        if (entryStat.type !== 'file' || entryStat.size > LINKED_SYNC_FILE) {
          limits.skipped += 1
          return
        }
        const read = await withTimeout(remote.readFile(remotePath, { maxBytes: LINKED_SYNC_FILE }), LINKED_SYNC_TIMEOUT_MS, `download ${entryStat.name || remotePath}`)
        writeFileSync(localPath, read.data, { mode: 0o600 })
        limits.files += 1
        limits.bytes += read.data.length
      }
      await visit(target, destination, 0)
      return { path: destination, ...limits }
    }
    if (stat.size > LINKED_OPEN_FILE_CAP) throw new ApiError('FS_TOO_LARGE', '文件超过 64 MB，无法直接下载')
    const read = await remote.readFile(target, { maxBytes: LINKED_OPEN_FILE_CAP })
    writeFileSync(destination, read.data, { mode: 0o600 })
    return { path: destination, files: 1, bytes: read.data.length, skipped: 0, truncated: false }
  }

  const openTempCopy = async (remote, target, app) => {
    const stat = await remote.stat(target)
    if (stat.type !== 'file') throw new ApiError('FS_IS_DIR', '只能编辑文件')
    const read = await remote.readFile(target, { maxBytes: LINKED_OPEN_FILE_CAP })
    const dir = join(tmpdir(), 'dsh-linked-workspace-open')
    await mkdir(dir, { recursive: true })
    const localPath = join(dir, `${Date.now()}-${posix.basename(target).replace(/[\\/:*?"<>|]/g, '_')}`)
    writeFileSync(localPath, read.data, { mode: 0o600 })
    spawnNotepad(localPath, app)
    return { localPath, size: read.data.length }
  }

  const spawnNotepad = (localPath, app) => {
    try {
      if (process.platform === 'win32') {
        const child = spawn(app === 'default' ? 'explorer.exe' : 'notepad.exe', [localPath], { detached: true, stdio: 'ignore', windowsHide: true })
        if (child.unref) child.unref()
      } else if (process.platform === 'darwin') {
        const args = app === 'notepad' ? ['-e', localPath] : [localPath]
        const child = spawn('open', args, { detached: true, stdio: 'ignore' })
        if (child.unref) child.unref()
      } else {
        const child = spawn('xdg-open', [localPath], { detached: true, stdio: 'ignore' })
        if (child.unref) child.unref()
      }
      return true
    } catch (error) {
      log('warn', `cannot open ${localPath}: ${error && error.message ? error.message : error}`)
      return false
    }
  }

  // ── document bridge (Markdown/PDF/DOCX/XLSX/PPTX) ──────────────────────

  const DOC_MAX_BYTES = 80 * 1024 * 1024
  const DOC_PDF_SUFFIX_MAX = 999
  const DOC_TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'doc_tool.py')
  const DOC_KIND_BY_EXT = new Map([
    ['.md', 'markdown'], ['.markdown', 'markdown'],
    ['.pdf', 'pdf'], ['.docx', 'docx'], ['.xlsx', 'xlsx'], ['.pptx', 'pptx'],
  ])

  function docKind(path) {
    return DOC_KIND_BY_EXT.get(extname(String(path || '')).toLowerCase()) || ''
  }

  function docPython() {
    return process.env.DSH_OFFICE_PYTHON || process.env.DSH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  }

  function runDocTool(args, timeoutMs = 120000) {
    return new Promise((resolvePromise, rejectPromise) => {
      let child
      try {
        child = spawn(docPython(), [DOC_TOOL, ...args], { windowsHide: true })
      } catch (error) {
        rejectPromise(new ApiError('DOC_RUNTIME', '需要 Python 3 与文档库：' + (error && error.message ? error.message : error)))
        return
      }
      const out = []
      const err = []
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* already gone */ }
        rejectPromise(new ApiError('DOC_TIMEOUT', '文档处理超时'))
      }, timeoutMs)
      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))
      child.on('error', (error) => {
        clearTimeout(timer)
        if (error && error.code === 'ENOENT') {
          rejectPromise(new ApiError('DOC_RUNTIME', '未找到 Python。请安装 Python 3 以及 python-docx / openpyxl / python-pptx / PyMuPDF，或设置 DSH_OFFICE_PYTHON。'))
        } else {
          rejectPromise(new ApiError('DOC_RUNTIME', error && error.message ? error.message : String(error)))
        }
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const stdout = Buffer.concat(out).toString('utf8')
        const stderr = Buffer.concat(err).toString('utf8')
        let parsed
        try {
          parsed = JSON.parse(stdout.trim().split(String.fromCharCode(10)).filter(Boolean).pop() || '{}')
        } catch {
          parsed = null
        }
        if (code !== 0 || !parsed || parsed.ok !== true) {
          const message = (parsed && parsed.error) || stderr.trim() || ('文档处理失败（退出码 ' + code + '）')
          rejectPromise(new ApiError('DOC_FAILED', String(message).slice(0, 800)))
          return
        }
        resolvePromise(parsed.data)
      })
    })
  }

  async function docTarget(params) {
    if (params.linkedId || params.workspaceId) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      return { remote: true, scope, path: target }
    }
    const raw = typeof params.path === 'string' ? params.path.trim() : ''
    if (raw === '' || !isAbsolute(raw)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
    return { remote: false, path: resolve(raw) }
  }

  async function readDocBytes(target, current) {
    if (!current.remote) {
      const info = await fsStat(current.path)
      if (!info.isFile()) throw new ApiError('FS_NOT_DIR', '只能打开文件')
      if (info.size > DOC_MAX_BYTES) throw new ApiError('DOC_TOO_LARGE', '文档超过 80 MB')
      return { data: readFileSync(current.path), mtime: info.mtimeMs, size: info.size }
    }
    const stat = await current.scope.remote.stat(current.path)
    const isFile = target.remote ? stat.type === 'file' : stat.isFile()
    if (!isFile) throw new ApiError('FS_NOT_DIR', '只能打开文件')
    if (stat.size > DOC_MAX_BYTES) throw new ApiError('DOC_TOO_LARGE', '文档超过 80 MB')
    const read = await current.scope.remote.readFile(current.path, { maxBytes: DOC_MAX_BYTES })
    return { data: read.data, mtime: stat.mtime, size: stat.size }
  }

  async function writeDocBytes(target, data) {
    if (!target.remote) {
      await mkdir(dirname(target.path), { recursive: true })
      const temp = target.path + '.' + randomUUID() + '.tmp'
      writeFileSync(temp, data)
      try { renameSync(temp, target.path) } catch (error) { rmSync(temp, { force: true }); throw error }
      const info = await fsStat(target.path)
      return { path: target.path, size: info.size, mtime: info.mtimeMs }
    }
    const result = await target.scope.remote.writeFileAtomic(target.path, data)
    return { path: target.path, size: result.size, mtime: result.mtime }
  }

  const docFileCache = new Map()

  async function ensureDocCache(target) {
    let stat
    try {
      stat = target.remote ? await target.scope.remote.stat(target.path) : await fsStat(target.path)
    } catch (error) {
      if (target.remote) throw error
      throw mapLocalFsError(error)
    }
    const isFile = target.remote ? stat.type === 'file' : stat.isFile()
    if (!isFile) throw new ApiError('FS_NOT_DIR', '只能打开文件')
    if (stat.size > DOC_MAX_BYTES) throw new ApiError('DOC_TOO_LARGE', '文档超过 80 MB')
    const mtime = target.remote ? stat.mtime : stat.mtimeMs
    const key = (target.remote ? String(target.scope.id) : 'local') + '|' + target.path + '|' + String(mtime)
    const existing = docFileCache.get(key)
    if (existing && existsSync(existing)) return { file: existing, size: stat.size, mtime }
    let data
    if (target.remote) {
      const read = await target.scope.remote.readFile(target.path, { maxBytes: DOC_MAX_BYTES })
      data = read.data
    } else {
      data = readFileSync(target.path)
    }
    const directory = join(tmpdir(), 'dsh-linked-workspace-docs')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, randomUUID() + (extname(target.path) || '.bin'))
    writeFileSync(file, data)
    docFileCache.set(key, file)
    if (docFileCache.size > 20) {
      const oldestKey = docFileCache.keys().next().value
      const oldestFile = docFileCache.get(oldestKey)
      docFileCache.delete(oldestKey)
      try { rmSync(oldestFile, { force: true }) } catch { /* best effort */ }
    }
    return { file, size: stat.size, mtime }
  }

  async function makeDocTemp() {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-doc-'))
    return {
      dir: directory,
      file(name) { return join(directory, name) },
      cleanup() { try { rmSync(directory, { recursive: true, force: true }) } catch { /* best effort */ } },
    }
  }

  function assertDocKind(path, expected) {
    const kind = docKind(path)
    if (kind === '') throw new ApiError('DOC_UNSUPPORTED', '仅支持 Markdown、PDF、DOCX、XLSX、PPTX')
    if (expected && expected !== kind) throw new ApiError('DOC_UNSUPPORTED', '文件类型与请求不一致')
    return kind
  }

  async function docStat(target) {
    if (!target.remote) {
      try { const info = await fsStat(target.path); return info } catch { return null }
    }
    try { return await target.scope.remote.stat(target.path) } catch { return null }
  }

  // ── method table ─────────────────────────────────────────────────────────

  const methods = {
    async 'hosts.list'(params) {
      const hosts = await refreshHosts(Boolean(params && params.refresh))
      return {
        hosts: hosts.map((host) => ({
          id: host.id,
          name: host.name,
          host: host.host,
          port: host.port,
          username: host.username,
          authType: host.authType,
          source: host.source,
          hasCredential: host.hasCredential,
        })),
      }
    },

    async 'hosts.browse'(params = {}) {
      const host = await findHost(params.hostId)
      const remote = await connectHost(host)
      const home = await remote.homeDir()
      const requested = typeof params.path === 'string' && params.path.trim() !== '' ? params.path.trim() : home
      const target = await normalizeRemotePath(remote, requested)
      const listing = await remote.listDir(target)
      const entries = listing.entries
        .filter((entry) => entry.type === 'dir' || entry.type === 'file')
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          size: entry.size,
          mtime: entry.mtime,
        }))
      return {
        path: target,
        parent: target === '/' ? null : posix.dirname(target),
        home,
        entries,
      }
    },

    async 'workspaces.list'() {
      await refreshHosts()
      return { workspaces: store.list().map(describeWorkspace) }
    },

    async 'workspaces.add'(params = {}) {
      const host = await findHost(params.hostId)
      const remote = await connectHost(host)
      const requested = typeof params.name === 'string' ? params.name.trim() : ''
      if (requested.length > MAX_NAME_LENGTH) throw new ApiError('BAD_REQUEST', '工作区名称过长')
      const rawPath = await normalizeRemotePath(remote, params.remotePath)
      const resolved = await remote.realpath(rawPath).catch(() => rawPath)
      const stat = await remote.stat(resolved)
      if (stat.type !== 'dir') throw new ApiError('FS_NOT_DIR', '远程路径不是目录')
      const existing = store.find(host.id, resolved)
      if (existing) throw new ApiError('BAD_REQUEST', '该目录已经是远程工作区')
      const entry = {
        id: randomUUID(),
        name: requested !== '' ? requested : posix.basename(resolved) || host.name,
        hostId: host.id,
        hostSnapshot: {
          name: host.name,
          host: host.host,
          port: host.port,
          username: host.username,
        },
        remotePath: resolved,
        createdAt: Date.now(),
      }
      store.add(entry)
      pool.setStatus(host.id, { state: 'connected', latencyMs: 0 })
      return { workspace: describeWorkspace(entry) }
    },

    async 'workspaces.remove'(params = {}) {
      const workspace = requireWorkspace(params.id)
      store.remove(workspace.id)
      return {}
    },

    async 'workspaces.rename'(params = {}) {
      const workspace = requireWorkspace(params.id)
      const next = typeof params.name === 'string' ? params.name.trim() : ''
      if (next === '') throw new ApiError('BAD_REQUEST', '名称不能为空')
      if (next.length > MAX_NAME_LENGTH) throw new ApiError('BAD_REQUEST', '名称过长')
      store.rename(workspace.id, next)
      return { workspace: describeWorkspace(workspace) }
    },

    async 'workspaces.test'(params = {}) {
      const workspace = requireWorkspace(params.id)
      const started = Date.now()
      try {
        const remote = await workspaceRemote(workspace)
        const stat = await remote.stat(workspace.remotePath)
        if (stat.type !== 'dir') throw new ApiError('FS_NOT_DIR', '远程目录已不存在')
        const label = `${workspace.hostSnapshot.username}@${workspace.hostSnapshot.host}`
        log('info', `test ok ${label}:${workspace.remotePath} in ${Date.now() - started}ms`)
        return { ok: true, latencyMs: Date.now() - started, resolvedPath: workspace.remotePath }
      } catch (error) {
        const apiError = asApiError(error)
        return { ok: false, latencyMs: Date.now() - started, error: apiError.message }
      }
    },

    async 'fs.list'(params = {}) {
      const scope = await requireScope(params)
      const target = params.path === undefined || params.path === ''
        ? scope.root
        : scopeTarget(scope, params.path)
      const limit = Math.min(Math.max(Number(params.limit) || LIST_PAGE_SIZE, 1), LIST_PAGE_MAX)
      const requestedOffset = Math.max(Number(params.offset) || 0, 0)
      const key = listingCacheKey(scope, target)
      let listing
      if (requestedOffset > 0) {
        const hit = listingCache.get(key)
        if (hit && Date.now() - hit.at < LISTING_CACHE_TTL_MS) listing = hit.listing
      }
      if (!listing) {
        listing = await scope.remote.listDir(target)
        rememberListing(key, listing)
      }
      const all = listing.entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        type: entry.type,
        size: entry.size,
        mtime: entry.mtime,
        relative: scopeRelative(scope, entry.path),
      }))
      const page = pageWindow({ limit, offset: requestedOffset }, all.length)
      return {
        path: target,
        entries: all.slice(page.offset, page.offset + page.limit),
        total: all.length,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.offset + page.limit < all.length,
      }
    },

    async 'fs.read'(params = {}) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      const stat = await scope.remote.stat(target)
      if (stat.type === 'dir') throw new ApiError('FS_IS_DIR', '目标是目录，无法作为文件读取')
      const limit = Math.min(Math.max(Number(params.maxBytes) || EDITABLE_LIMIT, 1024), READ_CAP)
      const tooLarge = stat.size > EDITABLE_LIMIT
      const read = await scope.remote.readFile(target, { maxBytes: tooLarge ? Math.min(PEEK_LIMIT, limit) : limit })
      const truncated = read.truncated || read.data.length < stat.size
      const binary = looksBinary(read.data)
      const content = binary ? '' : decodeUtf8(read.data)
      if (!binary) await scopeMirror(scope, target, read.data)
      return {
        path: target,
        relative: scopeRelative(scope, target),
        content,
        size: stat.size,
        mtime: stat.mtime,
        truncated,
        binary,
        tooLarge,
        editable: !binary && !tooLarge && !truncated,
        encoding: 'utf-8',
      }
    },

    async 'media.read'(params = {}) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      const mime = imageMimeOf(target)
      if (!mime) throw new ApiError('BAD_REQUEST', '该文件不是支持的图片格式')
      const stat = await scope.remote.stat(target)
      if (stat.type === 'dir') throw new ApiError('FS_IS_DIR', '目标是目录，无法预览')
      if (stat.size > MAX_MEDIA_BYTES) throw new ApiError('FS_TOO_LARGE', '图片超过 24 MB，无法预览')
      const read = await scope.remote.readFile(target, { maxBytes: MAX_MEDIA_BYTES })
      return {
        path: target,
        size: stat.size,
        mtime: stat.mtime,
        mime,
        base64: read.data.toString('base64'),
      }
    },

    async 'fs.write'(params = {}) {
      const scope = await requireScope(params)
      if (typeof params.content !== 'string') throw new ApiError('BAD_REQUEST', 'content is required')
      const bytes = Buffer.byteLength(params.content, 'utf8')
      if (bytes > MAX_WRITE_BYTES) throw new ApiError('FS_TOO_LARGE', '文件超过 8 MB，无法在工作区编辑器中保存')
      const target = scopeTarget(scope, params.path)
      let current
      try {
        current = await scope.remote.stat(target)
      } catch (error) {
        const apiError = asApiError(error)
        if (apiError.code !== 'FS_NOT_FOUND') throw apiError
        current = undefined
      }
      if (params.createOnly === true && current) throw new ApiError('FS_EXISTS', '目标已存在，请使用其他名称')
      if (current && current.type === 'dir') throw new ApiError('FS_IS_DIR', '目标是目录，无法写入')
      if (current && typeof params.expectedMtime === 'number' && params.expectedMtime > 0) {
        const currentSeconds = Math.floor(current.mtime / 1000)
        const expectedSeconds = Math.floor(params.expectedMtime / 1000)
        if (currentSeconds !== expectedSeconds) {
          throw new ApiError('CONFLICT', '远端文件已被其他人修改，请重新加载后再保存')
        }
      }
      const data = Buffer.from(params.content, 'utf8')
      const info = await scope.remote.writeFileAtomic(target, data, {
        mode: current ? current.mode : undefined,
      })
      await scopeMirror(scope, target, data)
      forgetListings()
      return { path: target, size: info.size, mtime: info.mtime }
    },

    async 'docs.read'(params = {}) {
      const target = await docTarget(params)
      const kind = assertDocKind(target.path)
      if (kind === 'pdf') {
        const cached = await ensureDocCache(target)
        const data = await runDocTool(['read', '--kind', 'pdf', '--file', cached.file])
        return { ...data, path: target.path, size: cached.size, mtime: cached.mtime, cached: true }
      }
      const current = await readDocBytes(target, target)
      if (kind === 'markdown') {
        if (looksBinary(current.data)) throw new ApiError('DOC_BINARY', 'Markdown 文件包含二进制内容')
        return { kind, path: target.path, text: decodeUtf8(current.data), size: current.size, mtime: current.mtime }
      }
      const temp = await makeDocTemp()
      try {
        const input = temp.file('input.' + (kind === 'markdown' ? 'md' : kind))
        writeFileSync(input, current.data)
        const data = await runDocTool(['read', '--kind', kind, '--file', input])
        return { ...data, path: target.path, size: current.size, mtime: current.mtime }
      } finally {
        temp.cleanup()
      }
    },

    async 'docs.pdfPage'(params = {}) {
      const target = await docTarget(params)
      assertDocKind(target.path, 'pdf')
      const page = Number(params.page)
      if (!Number.isInteger(page) || page < 0) throw new ApiError('BAD_REQUEST', '页码无效')
      const cached = await ensureDocCache(target)
      return await runDocTool(['read', '--kind', 'pdf', '--file', cached.file, '--page', String(page)])
    },

    async 'docs.write'(params = {}) {
      const target = await docTarget(params)
      const kind = assertDocKind(target.path)
      const data = params.data
      if (!data || typeof data !== 'object') throw new ApiError('BAD_REQUEST', '缺少文档数据')
      if (typeof params.expectedMtime === 'number' && params.expectedMtime > 0) {
        const current = await docStat(target)
        if (current && Math.floor(current.mtime / 1000) !== Math.floor(params.expectedMtime / 1000)) {
          throw new ApiError('CONFLICT', '文件已被修改，请重新加载后再保存')
        }
      }
      if (kind === 'markdown') {
        if (typeof data.text !== 'string') throw new ApiError('BAD_REQUEST', 'Markdown 内容无效')
        const written = await writeDocBytes(target, Buffer.from(data.text, 'utf8'))
        return { kind, ...written }
      }
      let sourceFile
      if (kind === 'pdf') {
        sourceFile = (await ensureDocCache(target)).file
      } else {
        sourceFile = (await readDocBytes(target, target)).data
      }
      const temp = await makeDocTemp()
      try {
        const source = temp.file('source.' + kind)
        const spec = temp.file('data.json')
        const output = temp.file('output.' + kind)
        writeFileSync(source, Buffer.isBuffer(sourceFile) ? sourceFile : readFileSync(sourceFile))
        writeFileSync(spec, JSON.stringify(data))
        await runDocTool(['write', '--kind', kind, '--file', source, '--data', spec, '--out', output])
        const written = await writeDocBytes(target, readFileSync(output))
        return { kind, ...written }
      } finally {
        temp.cleanup()
      }
    },

    async 'docs.create'(params = {}) {
      const target = await docTarget(params)
      const kind = assertDocKind(target.path, params.kind)
      const existing = await docStat(target)
      if (existing) throw new ApiError('FS_EXISTS', '目标文件已存在')
      const temp = await makeDocTemp()
      try {
        const cliKind = kind === 'markdown' ? 'md' : kind
        const output = temp.file('new.' + cliKind)
        await runDocTool(['create', '--kind', cliKind, '--out', output])
        const written = await writeDocBytes(target, readFileSync(output))
        return { kind, ...written }
      } finally {
        temp.cleanup()
      }
    },

    async 'docs.mdPreview'(params = {}) {
      const target = await docTarget(params)
      assertDocKind(target.path, 'markdown')
      let text = typeof params.text === 'string' ? params.text : null
      if (text === null) {
        const current = await readDocBytes(target, target)
        text = decodeUtf8(current.data)
      }
      const temp = await makeDocTemp()
      try {
        const input = temp.file('preview.md')
        writeFileSync(input, text, 'utf8')
        const data = await runDocTool(['md-preview', '--file', input])
        return data
      } finally {
        temp.cleanup()
      }
    },

    async 'docs.mdPdf'(params = {}) {
      const target = await docTarget(params)
      assertDocKind(target.path, 'markdown')
      let text = typeof params.text === 'string' ? params.text : null
      if (text === null) {
        const current = await readDocBytes(target, target)
        text = decodeUtf8(current.data)
      }
      const extension = extname(target.path)
      const base = target.path.slice(0, -extension.length)
      let outputPath = base + '.pdf'
      if (target.remote) {
        const directory = posix.dirname(outputPath)
        let candidate = outputPath
        let index = 1
        while (index <= DOC_PDF_SUFFIX_MAX && await target.scope.remote.stat(candidate).catch(() => null)) {
          candidate = posix.join(directory, posix.basename(base) + '-' + index + '.pdf')
          index += 1
        }
        if (index > DOC_PDF_SUFFIX_MAX) throw new ApiError('FS_EXISTS', '同名 PDF 过多，请先清理目录中的旧导出')
        outputPath = candidate
      } else {
        const directory = dirname(outputPath)
        let candidate = outputPath
        let index = 1
        while (index <= DOC_PDF_SUFFIX_MAX && existsSync(candidate)) {
          candidate = join(directory, basename(base) + '-' + index + '.pdf')
          index += 1
        }
        if (index > DOC_PDF_SUFFIX_MAX) throw new ApiError('FS_EXISTS', '同名 PDF 过多，请先清理目录中的旧导出')
        outputPath = candidate
      }
      const temp = await makeDocTemp()
      try {
        const input = temp.file('export.md')
        const output = temp.file('export.pdf')
        writeFileSync(input, text, 'utf8')
        await runDocTool(['md-pdf', '--file', input, '--out', output], 180000)
        const written = await writeDocBytes({ ...target, path: outputPath }, readFileSync(output))
        return { kind: 'pdf', ...written }
      } finally {
        temp.cleanup()
      }
    },

    async 'fs.stat'(params = {}) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      const stat = await scope.remote.stat(target)
      return {
        path: target,
        relative: scopeRelative(scope, target),
        type: stat.type,
        size: stat.size,
        mtime: stat.mtime,
        mode: stat.mode,
      }
    },

    async 'fs.mkdir'(params = {}) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      if (target === scope.root) throw new ApiError('BAD_REQUEST', '不能创建工作区根目录')
      if (params.createOnly === true) {
        let current
        try {
          current = await scope.remote.stat(target)
        } catch (error) {
          const apiError = asApiError(error)
          if (apiError.code !== 'FS_NOT_FOUND') throw apiError
          current = undefined
        }
        if (current) throw new ApiError('FS_EXISTS', '目标已存在，请使用其他名称')
      }
      await scope.remote.mkdirp(target)
      forgetListings()
      return {}
    },

    async 'fs.rename'(params = {}) {
      const scope = await requireScope(params)
      const from = scopeTarget(scope, params.from)
      const to = scopeTarget(scope, params.to)
      if (from === scope.root) throw new ApiError('BAD_REQUEST', '不能移动工作区根目录')
      await scope.remote.rename(from, to)
      await scopeMirrorRemove(scope, from)
      forgetListings()
      return {}
    },

    async 'fs.move'(params = {}) {
      const scope = await requireScope(params)
      const source = scopeTarget(scope, params.path)
      if (source === scope.root) throw new ApiError('BAD_REQUEST', '不能移动工作区根目录')
      const sourceStat = await scope.remote.stat(source)
      const targetDir = params.targetDir === undefined || params.targetDir === ''
        ? posix.dirname(source)
        : scopeTarget(scope, params.targetDir)
      const dirStat = await scope.remote.stat(targetDir)
      if (dirStat.type !== 'dir') throw new ApiError('FS_NOT_DIR', '目标不是目录')
      if (sourceStat.type === 'dir' && (targetDir === source || targetDir.startsWith(`${source}/`))) {
        throw new ApiError('BAD_REQUEST', '不能把目录移动到自身内部')
      }
      const target = posix.join(targetDir, posix.basename(source))
      if (target === source) return { path: target }
      if (await scope.remote.stat(target).catch(() => null)) throw new ApiError('FS_EXISTS', '目标目录中已存在同名文件或文件夹')
      await scope.remote.rename(source, target)
      await scopeMirrorRemove(scope, source)
      forgetListings()
      return { path: target }
    },

    async 'fs.delete'(params = {}) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      if (target === scope.root) throw new ApiError('BAD_REQUEST', '不能删除工作区根目录')
      await remoteDeleteRecursive(scope.remote, target)
      await scopeMirrorRemove(scope, target)
      forgetListings()
      return {}
    },

    async 'fs.transfer'(params = {}) {
      const scope = await requireScope(params)
      if (scope.kind !== 'linked') throw new ApiError('BAD_REQUEST', '只有联动工作区支持文件传输')
      if (params.side === 'local') {
        const result = await transferLocalToRemote(scope.record, scope.remote, params.path)
        forgetListings()
        return result
      }
      const target = scopeTarget(scope, params.path)
      return await transferToMirror(scope.record, scope.remote, target)
    },

    async 'fs.download'(params = {}) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      return await downloadRemotePath(scope.remote, target, downloadsFolder())
    },

    async 'fs.edit'(params = {}) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      return await openTempCopy(scope.remote, target, params.app === 'notepad' ? 'notepad' : 'default')
    },

    async 'fs.copy'(params = {}) {
      const scope = await requireScope(params)
      const source = scopeTarget(scope, params.path)
      const stat = await scope.remote.stat(source)
      const parent = params.targetDir === undefined
        ? posix.dirname(source)
        : scopeTarget(scope, params.targetDir)
      const parentStat = await scope.remote.stat(parent)
      if (parentStat.type !== 'dir') throw new ApiError('FS_NOT_DIR', '目标不是目录')
      if (stat.type === 'dir' && (parent === source || parent.startsWith(`${source}/`))) {
        throw new ApiError('BAD_REQUEST', '不能把目录复制到自身内部')
      }
      const target = await remoteUniqueTarget(scope.remote, parent, posix.basename(source))
      let files
      try {
        files = await remoteCopyRecursive(scope.remote, source, target)
      } catch (error) {
        // A half-copied tree is worse than a clean failure: remove what this
        // call created (the target name was unique, so nothing else lives there).
        await remoteDeleteRecursive(scope.remote, target).catch(() => {})
        throw error
      }
      forgetListings()
      return { path: target, files }
    },

    async 'fs.chmod'(params = {}) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      const mode = String(params.mode || '').trim()
      if (!/^[0-7]{3,4}$/.test(mode)) throw new ApiError('BAD_REQUEST', '权限必须是 3-4 位八进制，例如 644 或 0755')
      await scope.remote.exec(`chmod ${mode} ${shellQuoteArg(target)}`, { timeoutMs: 15000 })
      return await scope.remote.stat(target)
    },

    async 'fs.home'(params = {}) {
      const scope = await requireScope(params)
      return { home: await scope.remote.homeDir() }
    },

    // ── settings ───────────────────────────────────────────────────────────

    async 'settings.get'() {
      return settingsStore.get()
    },

    async 'settings.update'(params = {}) {
      return settingsStore.update(params)
    },

    // ── local directories (workspace pickers) ──────────────────────────────

    async 'local.browse'(params = {}) {
      return localBrowse(params.path)
    },

    async 'local.mkdir'(params = {}) {
      return localMkdir(params.path, params.name)
    },

    async 'local.list'(params = {}) {
      const rawPath = typeof params.path === 'string' && params.path.trim() !== '' ? params.path.trim() : homedir()
      if (!isAbsolute(rawPath)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      const target = resolve(rawPath)
      let info
      try {
        info = await fsStat(target)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      if (!info.isDirectory()) throw new ApiError('FS_NOT_DIR', '本地路径不是目录')
      const rawEntries = await readdir(target, { withFileTypes: true }).catch((error) => {
        throw mapLocalFsError(error)
      })
      const entries = []
      // Stat in small parallel batches: one await per entry is slow for big
      // folders, but an unbounded Promise.all can exhaust file descriptors.
      for (let start = 0; start < rawEntries.length; start += 128) {
        const batch = rawEntries.slice(start, start + 128)
        const stated = await Promise.all(batch.map(async (entry) => {
          const full = join(target, entry.name)
          let stat
          try {
            stat = await fsStat(full)
          } catch {
            return null
          }
          let type = 'file'
          if (stat.isDirectory()) type = 'dir'
          else if (stat.isSymbolicLink()) type = 'symlink'
          return { name: entry.name, path: full, type, size: stat.size, mtime: stat.mtimeMs }
        }))
        for (const item of stated) if (item) entries.push(item)
      }
      entries.sort((left, right) => {
        if (left.type === 'dir' && right.type !== 'dir') return -1
        if (right.type === 'dir' && left.type !== 'dir') return 1
        return left.name.localeCompare(right.name)
      })
      const page = pageWindow(params, entries.length)
      return {
        path: target,
        entries: entries.slice(page.offset, page.offset + page.limit),
        total: entries.length,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.offset + page.limit < entries.length,
      }
    },

    async 'local.stat'(params = {}) {
      const target = typeof params.path === 'string' ? params.path.trim() : ''
      if (target === '' || !isAbsolute(target)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      let info
      try {
        info = await fsStat(resolve(target))
      } catch (error) {
        throw mapLocalFsError(error)
      }
      return {
        path: resolve(target),
        type: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other',
        size: info.size,
        mtime: info.mtimeMs,
        mode: info.mode & 0o777,
      }
    },

    async 'local.read'(params = {}) {
      const target = typeof params.path === 'string' ? params.path.trim() : ''
      if (target === '' || !isAbsolute(target)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      const absolute = resolve(target)
      let info
      try {
        info = await fsStat(absolute)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      if (info.isDirectory()) throw new ApiError('FS_IS_DIR', '目标是目录，无法作为文件读取')
      const tooLarge = info.size > EDITABLE_LIMIT
      const cap = tooLarge ? PEEK_LIMIT : READ_CAP
      // Read at most `cap` bytes. Reading the whole file first would pull
      // multi-gigabyte files into Host memory (and on Windows readFileSync
      // throws ERR_FS_FILE_TOO_LARGE above 2 GiB even for a peek).
      let data
      try {
        data = readHeadSync(absolute, cap)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      const binary = looksBinary(data)
      return {
        path: absolute,
        content: binary ? '' : decodeUtf8(data),
        size: info.size,
        mtime: info.mtimeMs,
        truncated: data.length < info.size,
        binary,
        tooLarge,
        editable: !binary && !tooLarge && data.length === info.size,
        encoding: 'utf-8',
      }
    },

    async 'local.media'(params = {}) {
      const target = typeof params.path === 'string' ? params.path.trim() : ''
      if (target === '' || !isAbsolute(target)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      const absolute = resolve(target)
      const mime = imageMimeOf(absolute)
      if (!mime) throw new ApiError('BAD_REQUEST', '该文件不是支持的图片格式')
      let info
      try {
        info = await fsStat(absolute)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      if (info.isDirectory()) throw new ApiError('FS_IS_DIR', '目标是目录，无法预览')
      if (info.size > MAX_MEDIA_BYTES) throw new ApiError('FS_TOO_LARGE', '图片超过 24 MB，无法预览')
      let data
      try {
        data = readFileSync(absolute)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      return { path: absolute, size: info.size, mtime: info.mtimeMs, mime, base64: data.toString('base64') }
    },

    async 'local.write'(params = {}) {
      const target = typeof params.path === 'string' ? params.path.trim() : ''
      if (target === '' || !isAbsolute(target)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      if (typeof params.content !== 'string') throw new ApiError('BAD_REQUEST', 'content is required')
      const bytes = Buffer.byteLength(params.content, 'utf8')
      if (bytes > MAX_WRITE_BYTES) throw new ApiError('FS_TOO_LARGE', '文件超过 8 MB，无法在工作区编辑器中保存')
      const absolute = resolve(target)
      let info
      try {
        info = await fsStat(absolute)
      } catch (error) {
        if (error && error.code !== 'ENOENT') throw mapLocalFsError(error)
        info = undefined
      }
      if (info && info.isDirectory()) throw new ApiError('FS_IS_DIR', '目标是目录，无法写入')
      if (info && typeof params.expectedMtime === 'number' && params.expectedMtime > 0) {
        if (Math.floor(info.mtimeMs / 1000) !== Math.floor(params.expectedMtime / 1000)) {
          throw new ApiError('CONFLICT', '本地文件已被修改，请重新加载后再保存')
        }
      }
      const temp = join(dirname(absolute), `.~${basename(absolute)}.${process.pid}.${Date.now()}.tmp`)
      try {
        writeFileSync(temp, params.content, 'utf8')
        renameSync(temp, absolute)
      } catch (error) {
        try { rmSync(temp, { force: true }) } catch {}
        throw mapLocalFsError(error)
      }
      const next = await fsStat(absolute)
      return { path: absolute, size: next.size, mtime: next.mtimeMs }
    },

    async 'local.rename'(params = {}) {
      const from = typeof params.from === 'string' ? params.from.trim() : ''
      const to = typeof params.to === 'string' ? params.to.trim() : ''
      if (from === '' || to === '' || !isAbsolute(from) || !isAbsolute(to)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      try {
        if (existsSync(resolve(to))) throw new ApiError('BAD_REQUEST', '目标已存在')
        renameSync(resolve(from), resolve(to))
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw mapLocalFsError(error)
      }
      return { path: resolve(to) }
    },

    async 'local.move'(params = {}) {
      const source = typeof params.path === 'string' ? params.path.trim() : ''
      const targetDir = typeof params.targetDir === 'string' ? params.targetDir.trim() : ''
      if (source === '' || targetDir === '' || !isAbsolute(source) || !isAbsolute(targetDir)) {
        throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      }
      const root = typeof params.root === 'string' && params.root.trim() !== '' ? resolve(params.root.trim()) : ''
      const sourcePath = resolve(source)
      const dirPath = resolve(targetDir)
      if (root && sourcePath === root) throw new ApiError('BAD_REQUEST', '不能移动工作区根目录')
      if (root && (!isInsideLocal(root, sourcePath) || !isInsideLocal(root, dirPath))) {
        throw new ApiError('BAD_REQUEST', '移动范围超出本地目录')
      }
      let sourceInfo
      try {
        sourceInfo = await fsStat(sourcePath)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      let dirInfo
      try {
        dirInfo = await fsStat(dirPath)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      if (!dirInfo.isDirectory()) throw new ApiError('FS_NOT_DIR', '目标不是目录')
      if (sourceInfo.isDirectory() && (dirPath === sourcePath || dirPath.startsWith(sourcePath + sep))) {
        throw new ApiError('BAD_REQUEST', '不能把目录移动到自身内部')
      }
      const target = join(dirPath, basename(sourcePath))
      if (target === sourcePath) return { path: target }
      if (existsSync(target)) throw new ApiError('FS_EXISTS', '目标目录中已存在同名文件或文件夹')
      try {
        renameSync(sourcePath, target)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      return { path: target, type: sourceInfo.isDirectory() ? 'dir' : 'file' }
    },

    async 'local.delete'(params = {}) {
      const target = typeof params.path === 'string' ? params.path.trim() : ''
      if (target === '' || !isAbsolute(target)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      if (typeof params.root === 'string' && params.root !== '' && resolve(params.root) === resolve(target)) {
        throw new ApiError('BAD_REQUEST', '不能删除联动工作区根目录')
      }
      try {
        rmSync(resolve(target), { recursive: true, force: false })
      } catch (error) {
        throw mapLocalFsError(error)
      }
      return {}
    },

    async 'local.copy'(params = {}) {
      const source = typeof params.path === 'string' ? params.path.trim() : ''
      if (source === '' || !isAbsolute(source)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      const targetDir = typeof params.targetDir === 'string' && params.targetDir.trim() !== '' ? resolve(params.targetDir.trim()) : resolve(source, '..')
      let info
      try {
        info = await fsStat(resolve(source))
      } catch (error) {
        throw mapLocalFsError(error)
      }
      let dirInfo
      try {
        dirInfo = await fsStat(targetDir)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      if (!dirInfo.isDirectory()) throw new ApiError('FS_NOT_DIR', '目标不是目录')
      const name = resolve(source).split(/[\\/]/).pop()
      const target = uniqueLocalPath(targetDir, name)
      try {
        cpSync(resolve(source), target, { recursive: true, force: false, errorOnExist: true })
      } catch (error) {
        throw mapLocalFsError(error)
      }
      return { path: target, type: info.isDirectory() ? 'dir' : 'file' }
    },

    async 'local.newFile'(params = {}) {
      const target = typeof params.path === 'string' ? params.path.trim() : ''
      if (target === '' || !isAbsolute(target)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      try {
        writeFileSync(resolve(target), '', { flag: 'wx', mode: 0o644 })
      } catch (error) {
        throw mapLocalFsError(error, 'BAD_REQUEST')
      }
      return { path: resolve(target) }
    },

    async 'local.chmod'(params = {}) {
      const target = typeof params.path === 'string' ? params.path.trim() : ''
      const mode = String(params.mode || '').trim()
      if (target === '' || !isAbsolute(target)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      if (!/^[0-7]{3,4}$/.test(mode)) throw new ApiError('BAD_REQUEST', '权限必须是 3-4 位八进制，例如 644 或 0755')
      try {
        chmodSync(resolve(target), parseInt(mode, 8))
      } catch (error) {
        throw mapLocalFsError(error)
      }
      return { path: resolve(target), mode: parseInt(mode, 8) }
    },

    async 'local.edit'(params = {}) {
      const target = typeof params.path === 'string' ? params.path.trim() : ''
      if (target === '' || !isAbsolute(target)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      try {
        const info = await fsStat(resolve(target))
        if (!info.isFile()) throw new ApiError('FS_NOT_DIR', '只能编辑文件')
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw mapLocalFsError(error)
      }
      spawnNotepad(resolve(target), params.app === 'default' ? 'default' : 'notepad')
      return { path: resolve(target) }
    },

    async 'local.openExternal'(params = {}) {
      const rawPath = typeof params.path === 'string' ? params.path.trim() : ''
      if (rawPath === '' || !isAbsolute(rawPath)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      const target = resolve(rawPath)
      let info
      try {
        info = await fsStat(target)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      if (!info.isFile()) throw new ApiError('FS_NOT_DIR', '目标不是文件')
      if (!openWithSystem(target)) throw new ApiError('INTERNAL', '无法启动系统应用')
      return { opened: true, path: target }
    },

    async 'fs.openExternal'(params = {}) {
      const scope = await requireScope(params)
      const target = scopeTarget(scope, params.path)
      const stat = await scope.remote.stat(target)
      if (stat.type === 'dir') throw new ApiError('FS_IS_DIR', '目标是目录，无法用应用打开')
      if (stat.size > LINKED_OPEN_FILE_CAP) throw new ApiError('FS_TOO_LARGE', '文件超过 64 MB，暂不支持用本机应用打开')
      const read = await scope.remote.readFile(target, { maxBytes: LINKED_OPEN_FILE_CAP })
      const dir = join(tmpdir(), 'dsh-linked-workspace-open')
      await mkdir(dir, { recursive: true })
      const safeName = String(basename(target) || 'file').replace(/[\\/:*?"<>|]/g, '_')
      const localPath = join(dir, `${Date.now()}-${safeName}`)
      writeFileSync(localPath, read.data, { mode: 0o600 })
      if (!openWithSystem(localPath)) throw new ApiError('INTERNAL', '无法启动系统应用')
      return { opened: true, localPath, size: read.data.length }
    },

    async 'terminal.open'(params = {}) {
      const side = params.side === 'local' ? 'local' : 'remote'
      const testMode = process.env.DSH_LINKED_WORKSPACE_NO_TERMINAL === '1'
      const scope = await requireScope(params)
      const snapshot = scope.kind === 'linked' ? (scope.record.hostSnapshot || {}) : (scope.workspace.hostSnapshot || {})
      if (side === 'local') {
        if (scope.kind !== 'linked') throw new ApiError('BAD_REQUEST', '该工作区没有本地目录')
        const target = scope.record.localPath
        let info
        try {
          info = await fsStat(target)
        } catch (error) {
          throw mapLocalFsError(error)
        }
        if (!info.isDirectory()) throw new ApiError('FS_NOT_DIR', '本地目录不存在')
        if (testMode) return { opened: true, side, path: target, test: true }
        if (!(await openLocalTerminal(target))) throw new ApiError('INTERNAL', '无法启动本地终端')
        return { opened: true, side, path: target }
      }
      const stat = await scope.remote.stat(scope.root)
      if (stat.type !== 'dir') throw new ApiError('FS_NOT_DIR', '远程目录不存在')
      if (!snapshot.host || !snapshot.username) throw new ApiError('AUTH_FAILED', '缺少 SSH 主机或用户名，无法打开终端')
      if (testMode) return { opened: true, side, path: scope.root, host: snapshot.host, test: true }
      if (!(await openRemoteTerminal(snapshot.host, snapshot.port, snapshot.username, scope.root))) {
        throw new ApiError('INTERNAL', '无法启动远程终端（找不到可用的终端程序）')
      }
      return { opened: true, side, path: scope.root, host: snapshot.host }
    },

    async 'session.info'(params = {}) {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
      if (sessionId === '') throw new ApiError('BAD_REQUEST', 'sessionId is required')
      const controller = ctx.get('sessionController')
      if (!controller || typeof controller.list !== 'function') return { sessionId, cwd: null, running: false }
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(4000) : undefined
      const result = await controller.list({}, signal)
      const items = result && Array.isArray(result.items) ? result.items : []
      const item = items.find((entry) => String(entry.sessionId) === sessionId)
      return { sessionId, cwd: item && typeof item.cwd === 'string' ? item.cwd : null, running: Boolean(item && item.running) }
    },

    async 'skills.list'(params = {}) {
      const record = requireLinked(params.linkedId)
      return { localPath: record.localPath, skills: await localSkillsFor(record) }
    },

    async 'skills.read'(params = {}) {
      const record = requireLinked(params.linkedId)
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      if (name === '') throw new ApiError('BAD_REQUEST', 'name is required')
      return await readLocalSkill(record, name)
    },

    async 'git.status'(params = {}) {
      const scope = await requireScope(params)
      const side = params.side === 'local' ? 'local' : 'remote'
      if (side === 'remote') return await git.remoteGitStatus(scope.remote, scope.root)
      if (scope.kind !== 'linked') throw new ApiError('BAD_REQUEST', '只有联动工作区有本地目录')
      return await git.localGitStatus(scope.record.localPath)
    },

    async 'fs.search'(params = {}) {
      const scope = await requireScope(params)
      const query = typeof params.query === 'string' ? params.query.trim() : ''
      const maxResults = Math.min(Math.max(Number(params.maxResults) || 200, 1), 1000)
      if (query === '') return { ok: true, query: '', entries: [], truncated: false }
      const side = params.side === 'local' ? 'local' : 'remote'
      if (side === 'remote') {
        return await git.remoteSearch(scope.remote, scope.root, query, { maxResults })
      }
      if (scope.kind !== 'linked') throw new ApiError('BAD_REQUEST', '只有联动工作区有本地目录')
      return await git.localSearch(scope.record.localPath, query, { maxResults })
    },

    // ── linked workspaces ──────────────────────────────────────────────────

    async 'linked.list'() {
      await refreshHosts()
      const running = await runningLocalKeys()
      return { links: linkedStore.list().map((record) => describeLink(record, running)) }
    },

    async 'localWorkspace.create'(params = {}) {
      const rawPath = typeof params.path === 'string' ? params.path.trim() : ''
      if (rawPath === '' || !isAbsolute(rawPath)) throw new ApiError('BAD_REQUEST', '本地路径必须是绝对路径')
      const localPath = resolve(rawPath)
      const name = typeof params.name === 'string' ? params.name.trim() : ''
      if (name.length > MAX_NAME_LENGTH) throw new ApiError('BAD_REQUEST', '工作区名称过长')
      let info
      try {
        info = await fsStat(localPath)
      } catch (error) {
        throw mapLocalFsError(error)
      }
      if (!info.isDirectory()) throw new ApiError('BAD_REQUEST', '本地路径不是目录')
      const registry = ctx.get('workspaceRegistry', true)
      const title = name !== '' ? name : basename(localPath)
      const workspace = await ensureDshWorkspace(registry, localPath, title)
      if (!workspace) throw new ApiError('INTERNAL', '无法注册本地工作区')
      return { workspaceId: workspace.id, title: workspace.title || title, path: workspace.path || localPath }
    },

    async 'linked.create'(params = {}) {
      const host = await findHost(params.hostId)
      const remote = await connectHost(host)
      const rawRemote = await normalizeRemotePath(remote, params.remotePath)
      const remoteRoot = await remote.realpath(rawRemote).catch(() => rawRemote)
      const remoteStat = await remote.stat(remoteRoot)
      if (remoteStat.type !== 'dir') throw new ApiError('FS_NOT_DIR', '远程路径不是目录')

      if (typeof params.localPath !== 'string' || params.localPath.trim() === '' || !isAbsolute(params.localPath.trim())) {
        throw new ApiError('BAD_REQUEST', '本地目录必须是绝对路径')
      }
      const localPath = linkedFs.normalizeLocalPath(params.localPath)
      const localKey = linkedFs.localPathKey(localPath)
      const localClash = linkedStore.list().find((record) => linkedFs.localPathKey(record.localPath) === localKey)
      if (localClash) throw new ApiError('BAD_REQUEST', `该本地目录已绑定联动工作区「${localClash.name}」`)
      const remoteClash = linkedStore.list().find((record) => record.hostId === host.id && record.remotePath === remoteRoot)
      if (remoteClash) throw new ApiError('BAD_REQUEST', `该远程目录已绑定联动工作区「${remoteClash.name}」`)

      const requestedName = typeof params.name === 'string' ? params.name.trim() : ''
      if (requestedName.length > MAX_NAME_LENGTH) throw new ApiError('BAD_REQUEST', '工作区名称过长')
      const name = requestedName !== '' ? requestedName : basename(localPath) || host.name

      await mkdir(localPath, { recursive: true })
      const record = {
        id: randomUUID(),
        name,
        localPath,
        hostId: host.id,
        hostSnapshot: {
          name: host.name,
          host: host.host,
          port: host.port,
          username: host.username,
        },
        remotePath: remoteRoot,
        mirror: Boolean(params.mirror),
        syncChoice: params.mirror === true,
        createdAt: Date.now(),
      }
      linkedStore.add(record)
      const workspace = await ensureDshWorkspace(linkedRegistry(), localPath, linkedWorkspaceTitle(name))
      pool.setStatus(host.id, { state: 'connected', latencyMs: 0 })
      log('info', `linked workspace "${name}" (${localPath} ⇄ ${record.hostSnapshot.username}@${record.hostSnapshot.host}:${remoteRoot})`)
      return { link: describeLink(record), workspaceId: workspace ? workspace.id : null }
    },

    async 'linked.update'(params = {}) {
      const record = requireLinked(params.id)
      const nextName = typeof params.name === 'string' ? params.name.trim() : ''
      if (nextName.length > MAX_NAME_LENGTH) throw new ApiError('BAD_REQUEST', '工作区名称过长')
      const nextMirror = typeof params.mirror === 'boolean' ? params.mirror : record.mirror
      const renamed = nextName !== '' && nextName !== record.name
      record.name = nextName !== '' ? nextName : record.name
      record.mirror = nextMirror
      if (nextMirror === false) {
        const running = syncJobs.get(record.id)
        if (running && running.state === 'running') running.cancel = true
      }
      linkedStore.update(record.id, { name: record.name, mirror: record.mirror, syncChoice: true })
      if (renamed) {
        const workspace = findWorkspaceByPath(linkedRegistry(), record.localPath)
        if (workspace) await renameDshWorkspace(ctx, String(workspace.id), linkedWorkspaceTitle(record.name))
      }
      if (nextMirror === true && params.mirror === true) {
        try {
          startSyncJob(record, { reason: 'enable' })
        } catch (error) {
          log('warn', `could not start the first mirror check: ${error && error.message ? error.message : error}`)
        }
      }
      return { link: describeLink(record) }
    },

    async 'linked.remove'(params = {}) {
      const record = requireLinked(params.id)
      linkedStore.remove(record.id)
      let removedWorkspace = false
      if (params.removeWorkspace === true) {
        const registry = linkedRegistry()
        const workspace = findWorkspaceByPath(registry, record.localPath)
        if (workspace && registry && typeof registry.delete === 'function') {
          try {
            removedWorkspace = await registry.delete(workspace.id)
          } catch (error) {
            log('warn', `DSH workspace removal failed: ${error && error.message ? error.message : error}`)
          }
        }
      }
      let deletedLocalState = false
      if (params.deleteLocalState === true) {
        try {
          await linkedFs.removeLinkedLayout(record.localPath, { mirror: true })
          deletedLocalState = true
        } catch (error) {
          log('warn', `linked local state removal failed: ${error && error.message ? error.message : error}`)
        }
      }
      return { removedWorkspace, deletedLocalState }
    },

    async 'linked.sync'(params = {}) {
      const record = requireLinked(params.id)
      const job = startSyncJob(record, params)
      return { job: jobView(job) }
    },

    async 'linked.syncStatus'(params = {}) {
      const record = requireLinked(params.id)
      const job = syncJobs.get(record.id)
      return { job: job ? jobView(job) : null }
    },

    async 'linked.syncCancel'(params = {}) {
      const record = requireLinked(params.id)
      const job = syncJobs.get(record.id)
      if (!job || job.state !== 'running') return { cancelled: false }
      job.cancel = true
      return { cancelled: true }
    },
  }

  // ── linked_workspace agent tool + prompt section ──────────────────────────

  const toolText = (text) => ({ text, isError: false })

  const LOCAL_SKILL_DIRS = (localPath) => [
    join(localPath, '.dsh', 'skills'),
    join(localPath, '.agents', 'skills'),
    join(homedir(), '.dsh', 'skills'),
    join(homedir(), '.agents', 'skills'),
  ]

  const parseSkillFrontmatter = (text, fallbackName) => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const meta = { name: fallbackName, description: '', whenToUse: '' }
    if (match) {
      for (const line of match[1].split(/\r?\n/)) {
        const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
        if (!pair) continue
        const key = pair[1]
        const value = pair[2].trim().replace(/^["']|["']$/g, '')
        if (key === 'name' && value) meta.name = value
        else if (key === 'description') meta.description = value
        else if (key === 'whenToUse' || key === 'when_to_use') meta.whenToUse = value
      }
    }
    return meta
  }

  const scanLocalSkills = (localPath) => {
    const found = []
    const seen = new Set()
    for (const root of LOCAL_SKILL_DIRS(localPath)) {
      let entries
      try {
        entries = readdirSync(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillFile = join(root, entry.name, 'SKILL.md')
        if (!existsSync(skillFile)) continue
        let text
        try {
          text = readFileSync(skillFile, 'utf8')
        } catch {
          continue
        }
        const meta = parseSkillFrontmatter(text, entry.name)
        if (seen.has(meta.name)) continue
        seen.add(meta.name)
        found.push({
          name: meta.name,
          description: meta.description,
          whenToUse: meta.whenToUse,
          path: skillFile,
          source: root.startsWith(localPath) ? 'project' : 'user',
        })
      }
    }
    found.sort((left, right) => left.name.localeCompare(right.name))
    return found
  }

  const localSkillsFor = async (link, signal) => {
    const service = ctx.get('skills')
    if (service && typeof service.list === 'function') {
      try {
        const list = await service.list({ cwd: link.localPath, signal })
        if (Array.isArray(list)) {
          return list.map((skill) => ({
            name: skill.name,
            description: skill.description || '',
            whenToUse: skill.whenToUse || '',
            path: skill.path || '',
            source: skill.source || 'local',
          }))
        }
      } catch {
        /* fall back to a direct scan */
      }
    }
    return scanLocalSkills(link.localPath)
  }

  const readLocalSkill = async (link, name, signal) => {
    const service = ctx.get('skills')
    if (service && typeof service.get === 'function') {
      try {
        const skill = await service.get(name, { cwd: link.localPath, signal })
        if (skill && typeof skill.content === 'string') {
          return { name: skill.name, description: skill.description || '', content: skill.content, path: skill.path || '' }
        }
      } catch {
        /* fall back */
      }
    }
    for (const skill of scanLocalSkills(link.localPath)) {
      if (skill.name !== name) continue
      const content = readFileSync(skill.path, 'utf8')
      return { name: skill.name, description: skill.description, content, path: skill.path }
    }
    throw new ApiError('NOT_FOUND', `本地技能不存在: ${name}`)
  }

  const linkedTool = {
    name: LINKED_TOOL_NAME,
    timeoutMs: 120_000,
    isConcurrencySafe: (args) => ['list', 'info', 'list_dir', 'read', 'stat'].includes(String((args && args.action) || '').trim()),
    description:
      'Read and edit files of a linked remote workspace (a local directory paired with a remote directory over SSH). '
      + 'Actions: list (all linked workspaces), info, list_dir, read, write, replace, stat, mkdir, rename, delete, sync. '
      + '`path` is relative to the remote root (or an absolute path inside it). Writes are atomic; pass `if_modified_since` from a previous read/stat to refuse a stale overwrite. '
      + 'The workspace is resolved from the session working directory; pass `workspace` (link id, local path or name) when working elsewhere. '
      + 'Local files (including .local/ and .remote/) still use the normal read/write/bash tools.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'info', 'list_dir', 'read', 'write', 'replace', 'stat', 'mkdir', 'rename', 'delete', 'sync'],
          description: 'Operation to perform.',
        },
        workspace: {
          type: 'string',
          description: 'Optional linked workspace reference: link id, absolute local path, or workspace name. Omit to use the session working directory.',
        },
        path: {
          type: 'string',
          description: 'Remote path relative to the linked workspace root, or an absolute path inside it. Empty means the root.',
        },
        destination: { type: 'string', description: 'Destination path for rename (relative or absolute inside the root).' },
        content: { type: 'string', description: 'Full file content for write.' },
        old_string: { type: 'string', description: 'Exact text to replace for replace.' },
        new_string: { type: 'string', description: 'Replacement text for replace.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default: exactly one occurrence).' },
        if_modified_since: { type: 'number', description: 'Epoch milliseconds from a previous read/stat; refuse the write when the remote mtime differs.' },
        max_bytes: { type: 'number', description: 'Read cap in bytes for read/list_dir metadata (default 262144, max 524288).' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          isError: { type: 'boolean' },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      try {
        if (!exec || !exec.agent) throw new ApiError('BAD_REQUEST', `${LINKED_TOOL_NAME} requires an agent session`)
        const action = String((args && args.action) || '').trim()
        if (action === 'list') {
          const lines = linkedStore.list().map((record) => {
            const described = describeLink(record)
            return [
              `- ${described.name}`,
              `  local: ${described.localPath}`,
              `  remote: ${described.username}@${described.host}:${described.remotePath}`,
              `  mirror: ${described.mirror ? 'on' : 'off'}`,
            ].join('\n')
          })
          return toolText(lines.length === 0 ? 'No linked workspaces yet.' : lines.join('\n'))
        }

        const link = await resolveLinkedSelection(args, exec)
        const remote = await hostForLink(link)
        const root = linkedRootOf(link)
        const target = linkedTarget(link, args.path)

        if (action === 'info') {
          const stat = await remote.stat(root)
          return toolText(JSON.stringify({
            id: link.id,
            name: link.name,
            localPath: link.localPath,
            remoteHost: `${link.hostSnapshot.username}@${link.hostSnapshot.host}:${link.hostSnapshot.port}`,
            remoteRoot: root,
            mirror: Boolean(link.mirror),
            mirrorDir: link.mirror ? join(link.localPath, linkedFs.MIRROR_DIR) : null,
            stateDir: join(link.localPath, linkedFs.LINKED_DIR),
            remoteRootType: stat.type,
          }, null, 2))
        }

        if (action === 'list_dir') {
          const listing = await remote.listDir(target)
          const rows = listing.entries.map((entry) => {
            if (entry.type === 'dir') return `d ${entry.name}/`
            if (entry.type === 'file') return `f ${entry.name} (${entry.size} B)`
            return `${entry.type} ${entry.name}`
          })
          return toolText(`${target}\n${rows.length === 0 ? '(empty)' : rows.join('\n')}`)
        }

        if (action === 'read') {
          const stat = await remote.stat(target)
          if (stat.type === 'dir') throw new ApiError('FS_IS_DIR', '目标是目录，请用 list_dir')
          const cap = Math.min(Math.max(Number(args.max_bytes) || 262144, 1024), LINKED_READ_CAP)
          const read = await remote.readFile(target, { maxBytes: Math.min(stat.size, cap) })
          if (looksBinary(read.data)) {
            return toolText(`${target} (${stat.size} B, mtime ${stat.mtime}) is a binary file; use list_dir/stat or download it locally.`)
          }
          const content = decodeUtf8(read.data)
          const truncated = read.data.length < stat.size
          const suffix = truncated ? `\n...(truncated at ${read.data.length} of ${stat.size} bytes)` : ''
          // Only a complete read may be archived: mirroring a truncated prefix
          // would leave a silently corrupt copy under .remote.
          if (!truncated) await mirrorWrite(link, target, read.data)
          return toolText(`${target} (${stat.size} B, mtime ${stat.mtime})${suffix}\n\n${content}`)
        }

        if (action === 'stat') {
          const stat = await remote.stat(target)
          return toolText(JSON.stringify({ path: target, type: stat.type, size: stat.size, mtime: stat.mtime }, null, 2))
        }

        if (action === 'write') {
          if (typeof args.content !== 'string') throw new ApiError('BAD_REQUEST', 'content is required')
          const bytes = Buffer.byteLength(args.content, 'utf8')
          if (bytes > MAX_WRITE_BYTES) throw new ApiError('FS_TOO_LARGE', '文件超过 8 MB，无法写入')
          let current
          try {
            current = await remote.stat(target)
          } catch (error) {
            const apiError = asApiError(error)
            if (apiError.code !== 'FS_NOT_FOUND') throw apiError
            current = undefined
          }
          if (current && current.type === 'dir') throw new ApiError('FS_IS_DIR', '目标是目录')
          if (current && typeof args.if_modified_since === 'number' && args.if_modified_since > 0) {
            if (Math.floor(current.mtime / 1000) !== Math.floor(args.if_modified_since / 1000)) {
              throw new ApiError('CONFLICT', `远端文件已变化（mtime ${current.mtime}），请重新读取后再写入`)
            }
          }
          await remote.mkdirp(posix.dirname(target))
          const data = Buffer.from(args.content, 'utf8')
          const info = await remote.writeFileAtomic(target, data, { mode: current ? current.mode : undefined })
          await mirrorWrite(link, target, data)
          return toolText(`Wrote ${target} (${bytes} B, mtime ${info.mtime})`)
        }

        if (action === 'replace') {
          if (typeof args.old_string !== 'string' || args.old_string === '') throw new ApiError('BAD_REQUEST', 'old_string is required')
          if (typeof args.new_string !== 'string') throw new ApiError('BAD_REQUEST', 'new_string is required')
          const stat = await remote.stat(target)
          if (stat.type === 'dir') throw new ApiError('FS_IS_DIR', '目标是目录')
          if (stat.size > MAX_WRITE_BYTES) throw new ApiError('FS_TOO_LARGE', '文件超过 8 MB，无法在工具中替换')
          const read = await remote.readFile(target, { maxBytes: MAX_WRITE_BYTES })
          const before = decodeUtf8(read.data)
          const occurrences = before.split(args.old_string).length - 1
          if (occurrences === 0) throw new ApiError('BAD_REQUEST', 'old_string was not found in the remote file')
          if (!args.replace_all && occurrences > 1) {
            throw new ApiError('BAD_REQUEST', `old_string appears ${occurrences} times; set replace_all or narrow it`)
          }
          const after = before.split(args.old_string).join(args.new_string)
          const info = await remote.writeFileAtomic(target, Buffer.from(after, 'utf8'), { mode: stat.mode })
          await mirrorWrite(link, target, Buffer.from(after, 'utf8'))
          return toolText(`Replaced ${args.replace_all ? occurrences : 1} occurrence(s) in ${target} (mtime ${info.mtime})`)
        }

        if (action === 'mkdir') {
          if (target === root) throw new ApiError('BAD_REQUEST', '根目录已存在')
          await remote.mkdirp(target)
          return toolText(`Created directory ${target}`)
        }

        if (action === 'rename') {
          if (typeof args.destination !== 'string' || args.destination.trim() === '') {
            throw new ApiError('BAD_REQUEST', 'destination is required')
          }
          const destination = linkedTarget(link, args.destination)
          if (target === root) throw new ApiError('BAD_REQUEST', '不能移动联动工作区根目录')
          await remote.rename(target, destination)
          await linkedFs.removeMirrorPath(link.localPath, linkedRelative(link, target)).catch(() => {})
          return toolText(`Renamed ${target} -> ${destination}`)
        }

        if (action === 'delete') {
          if (target === root) throw new ApiError('BAD_REQUEST', '不能删除联动工作区根目录')
          const stat = await remote.stat(target)
          // rmdir only removes empty directories (same as the UI's fs.delete,
          // which uses this recursive helper).
          if (stat.type === 'dir') await remoteDeleteRecursive(remote, target)
          else await remote.unlink(target)
          await linkedFs.removeMirrorPath(link.localPath, linkedRelative(link, target)).catch(() => {})
          return toolText(`Deleted ${target}`)
        }

        if (action === 'sync') {
          const job = startSyncJob(link, args)
          return toolText(
            `Sync job running in the background: ${job.files} file(s) / ${job.bytes} bytes archived so far (${job.skipped} skipped). `
            + 'The Connections settings card shows progress; poll linked.syncStatus there or wait for completion.',
          )
        }

        throw new ApiError('BAD_REQUEST', `unknown action: ${action}`)
      } catch (error) {
        const apiError = asApiError(error)
        return { text: `${LINKED_TOOL_NAME} failed: ${apiError.message}`, isError: true }
      }
    },
  }

  const localSkillsTool = {
    name: 'linked_skills',
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    description:
      'List or read skills installed on the LOCAL machine for a linked workspace (the session runs in the local directory; the remote project must not need a copy). '
      + 'Actions: list (all local user/project skills for the linked workspace), read (requires name). '
      + 'The workspace is resolved from the session working directory; pass workspace (link id, local path or name) when needed.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read'], description: 'Operation to perform.' },
        name: { type: 'string', description: 'Skill name for read.' },
        workspace: { type: 'string', description: 'Optional linked workspace reference.' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, isError: { type: 'boolean' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      try {
        if (!exec || !exec.agent) throw new ApiError('BAD_REQUEST', 'linked_skills requires an agent session')
        const action = String((args && args.action) || 'list').trim()
        const link = await resolveLinkedSelection(args, exec)
        if (action === 'list') {
          const skills = await localSkillsFor(link)
          if (skills.length === 0) return toolText(`No local skills found for "${link.name}". Install them under ~/.dsh/skills, ~/.agents/skills or <local>/.dsh/skills.`)
          return toolText(skills.map((skill) => `- ${skill.name}: ${skill.description || skill.whenToUse || '(no description)'} [${skill.source}]`).join('\n'))
        }
        if (action === 'read') {
          const name = typeof args.name === 'string' ? args.name.trim() : ''
          if (name === '') throw new ApiError('BAD_REQUEST', 'name is required for read')
          const skill = await readLocalSkill(link, name)
          return toolText(`# ${skill.name}\n${skill.description}\n\n${skill.content}`)
        }
        throw new ApiError('BAD_REQUEST', `unknown action: ${action}`)
      } catch (error) {
        const apiError = asApiError(error)
        return { text: `linked_skills failed: ${apiError.message}`, isError: true }
      }
    },
  }

  ctx.effect(() => ctx.tools.register(linkedTool), 'dsh-linked-workspace: linked tool')
  ctx.effect(() => ctx.tools.register(localSkillsTool), 'dsh-linked-workspace: local skills tool')
  ctx.effect(
    () => ctx.systemPrompt.section({ name: LINKED_PROMPT_SECTION, order: 1250, text: linkedPrompt }),
    'dsh-linked-workspace: linked prompt section',
  )

  // ── HTTP route ───────────────────────────────────────────────────────────

  const trustRejection = (req) => {
    // Desktop shells serve the GUI from loopback, so the loopback + same-origin
    // fence is the fast path and the one that always works there. Deployments
    // that mount the GUI on a real hostname go through the Host's own
    // `connection` verdict instead (Host/Origin checks + browser credential).
    const local = loopbackRejection(req)
    if (local === 0) return 0
    try {
      const connection = ctx.get('connection', true)
      if (connection && typeof connection.requestRejection === 'function') {
        return connection.requestRejection({ headers: req.headers }) || 0
      }
    } catch {
      /* fall through to the loopback verdict */
    }
    return local
  }

  const handler = async (req, res) => {
    const started = Date.now()
    const rejection = trustRejection(req)
    if (rejection) {
      sendJson(res, rejection, { ok: false, error: { code: 'FORBIDDEN', message: 'request rejected' } })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { code: 'BAD_REQUEST', message: 'method not allowed' } })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const apiError = asApiError(error)
      sendJson(res, apiError.status, errorEnvelope(apiError))
      return
    }
    const method = typeof body.method === 'string' ? body.method : ''
    const fn = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : undefined
    if (!fn) {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: `unknown method: ${method}` } })
      return
    }
    try {
      const data = await withTimeout(Promise.resolve(fn(body.params || {})), OP_TIMEOUT_MS, method)
      sendJson(res, 200, { ok: true, data })
      if (Date.now() - started > 3000) log('info', `${method} took ${Date.now() - started}ms`)
    } catch (error) {
      const apiError = asApiError(error)
      if (apiError.status >= 500) log('error', `${method} failed: ${apiError.message}`)
      sendJson(res, apiError.status, errorEnvelope(apiError))
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/dsh-linked-workspace/api',
        handler,
      }),
    'dsh-linked-workspace: api',
  )

  ctx.effect(
    () => () => {
      pool.disposeAll().catch(() => {})
    },
    'dsh-linked-workspace: close ssh sessions',
  )

  log('info', `loaded (${store.list().length} remote workspace${store.list().length === 1 ? '' : 's'})`)
  const autoSyncTimer = setInterval(autoSyncTick, AUTO_SYNC_TICK_MS)
  if (autoSyncTimer && typeof autoSyncTimer.unref === 'function') autoSyncTimer.unref()
  ctx.effect(() => () => clearInterval(autoSyncTimer), 'dsh-linked-workspace: auto sync timer')
  const titleMigrationTimer = setTimeout(() => {
    migrateLinkedWorkspaceTitles().catch((error) => {
      log('warn', `linked workspace title migration failed: ${error && error.message ? error.message : error}`)
    })
  }, 900)
  if (titleMigrationTimer && typeof titleMigrationTimer.unref === 'function') titleMigrationTimer.unref()
}

// ── response helpers ────────────────────────────────────────────────────────

function errorEnvelope(error) {
  return { ok: false, error: { code: error.code || 'INTERNAL', message: error.message || String(error) } }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch {
      /* ignore */
    }
  }
}

function headerValue(headers, name) {
  const value = headers ? headers[name] : undefined
  if (Array.isArray(value)) return value[0]
  return typeof value === 'string' ? value : undefined
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** Fallback fence used only when the Host has no `connection` service. */
function loopbackRejection(req) {
  const host = headerValue(req.headers, 'host')
  if (!host) return 403
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return 403
  }
  if (!isLoopbackHostname(hostname)) return 403
  if (headerValue(req.headers, 'sec-fetch-site') === 'cross-site') return 403
  const origin = headerValue(req.headers, 'origin')
  if (origin === undefined) return 0
  try {
    return new URL(origin).host === host ? 0 : 403
  } catch {
    return 403
  }
}

// ── file helpers ────────────────────────────────────────────────────────────

function imageMimeOf(filePath) {
  return IMAGE_MIME[extname(String(filePath || '')).toLowerCase()] || ''
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) return true
  }
  return false
}

function decodeUtf8(buffer) {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return decoder.decode(buffer)
}

