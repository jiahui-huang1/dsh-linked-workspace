/*
 * dsh-linked-workspace - SSH / SFTP transport
 *
 * This module owns everything that talks to a remote machine:
 *
 *   - loading the `ssh2` module in a plugin that is installed as a symlink
 *   - discovering hosts from the DSH SSH Manager store and from ~/.ssh/config
 *   - a small, defensive RemoteHost wrapper (connect, SFTP file operations,
 *     trust-on-first-use host key pinning, automatic reconnect on transient
 *     connection failures)
 *
 * Conventions used by the public API:
 *
 *   - Remote paths always use POSIX semantics (node:path.posix), even when the
 *     DSH process runs on Windows.
 *   - All timestamps (`mtime`) are epoch milliseconds (SFTP reports seconds).
 *   - `mode` is the raw SFTP/UNIX mode including the file type bits; use
 *     `mode & 0o7777` for the permission bits.
 *   - `stat()` uses lstat semantics, so a symlink reports type "symlink".
 *     Use `realpath()` when the resolved target matters.
 *   - `dispose()` releases the connection but does not poison the instance:
 *     a later call reconnects on demand.
 *   - Secrets (passwords, private keys, passphrases) are never returned in a
 *     host record and never written to the log.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SSH_PORT = 22;
const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const DEFAULT_READ_MAX_BYTES = 2 * 1024 * 1024;
const KEEPALIVE_INTERVAL_MS = 15000;
const KEEPALIVE_COUNT_MAX = 4;
const KNOWN_HOSTS_VERSION = 1;
const SFTP_READ_CHUNK = 64 * 1024;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const AUTH_TYPES = new Set(['privateKey', 'password', 'agent']);

/** Map of SshError code to the numeric status exposed for HTTP-ish consumers. */
const STATUS_BY_CODE = Object.freeze({
  SSH_CONNECT: 400,
  AUTH_FAILED: 401,
  FS_PERMISSION: 403,
  FS_NOT_FOUND: 404,
  TIMEOUT: 408,
  HOST_KEY_MISMATCH: 409,
  FS_IS_DIR: 409,
  FS_NOT_DIR: 409,
  INTERNAL: 500,
});

/** Raw error codes that mean "the connection is gone", not "the operation failed". */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_SOCKET_CLOSED',
]);

const CONNECTION_MESSAGE_RE =
  /not connected|no response from server|connection lost|connection reset|socket hang up|channel.*(?:closed|destroyed)|stream.*(?:closed|destroyed)|client is closed/i;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown by every public helper of this module.
 *
 * `code` is one of the strings listed in STATUS_BY_CODE; `status` is the
 * matching numeric status. `connectionLevel` marks failures that are safe to
 * retry once after reconnecting.
 */
export class SshError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, cause?: unknown, connectionLevel?: boolean, details?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    const errorCode = typeof code === 'string' && Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, code) ? code : 'INTERNAL';
    const superOptions = options && options.cause !== undefined ? { cause: options.cause } : undefined;
    super(String(message === undefined || message === null ? 'SSH error' : message), superOptions);
    this.name = 'SshError';
    this.code = errorCode;
    this.status = typeof options.status === 'number' && Number.isFinite(options.status) ? options.status : STATUS_BY_CODE[errorCode];
    this.connectionLevel = options.connectionLevel === true;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** True when the failure came from the transport (connection dropped), not the request. */
function isConnectionLevelError(err) {
  if (!err) return false;
  if (err instanceof SshError) return err.connectionLevel === true;
  const code = err.code;
  if (typeof code === 'number') return code === 6 || code === 7; // NO_CONNECTION, CONNECTION_LOST
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) return true;
  return CONNECTION_MESSAGE_RE.test(String(err.message || ''));
}

/** Best-effort semantic classification of a server message. */
function classifyMessage(message) {
  const text = String(message || '');
  if (/no such file/i.test(text)) return 'FS_NOT_FOUND';
  if (/permission denied|operation not permitted/i.test(text)) return 'FS_PERMISSION';
  if (/is a directory/i.test(text)) return 'FS_IS_DIR';
  if (/not a directory/i.test(text)) return 'FS_NOT_DIR';
  if (/no connection|connection lost/i.test(text)) return 'SSH_CONNECT';
  return null;
}

/**
 * Convert any error raised by ssh2 / the SFTP layer / node:fs into an SshError.
 * An SshError gets a short operation label prefixed once.
 */
function toSshError(err, label) {
  if (err instanceof SshError) {
    if (label && !err.message.startsWith(`${label}:`)) err.message = `${label}: ${err.message}`;
    return err;
  }
  const cause = err;
  const message = String((err && err.message) || err || 'SSH operation failed');
  const code = err && err.code;
  const connectionLevel = isConnectionLevelError(err);
  const prefix = label ? `${label}: ` : '';
  let sshCode = null;

  if (typeof code === 'number') {
    // SFTP status codes: 0 OK, 1 EOF, 2 NO_SUCH_FILE, 3 PERMISSION_DENIED,
    // 4 FAILURE, 5 BAD_MESSAGE, 6 NO_CONNECTION, 7 CONNECTION_LOST, 8 OP_UNSUPPORTED
    if (code === 2) sshCode = 'FS_NOT_FOUND';
    else if (code === 3) sshCode = 'FS_PERMISSION';
    else if (code === 6 || code === 7) sshCode = 'SSH_CONNECT';
    else sshCode = classifyMessage(message) || 'INTERNAL';
  } else if (typeof code === 'string') {
    if (code === 'ENOENT') sshCode = 'FS_NOT_FOUND';
    else if (code === 'EACCES' || code === 'EPERM') sshCode = 'FS_PERMISSION';
    else if (code === 'EISDIR') sshCode = 'FS_IS_DIR';
    else if (code === 'ENOTDIR') sshCode = 'FS_NOT_DIR';
    else if (code === 'ETIMEDOUT') sshCode = 'TIMEOUT';
    else if (
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      code === 'ENETDOWN' ||
      code === 'EPIPE' ||
      CONNECTION_ERROR_CODES.has(code)
    ) {
      sshCode = 'SSH_CONNECT';
    }
  }

  if (!sshCode) sshCode = classifyMessage(message) || (connectionLevel ? 'SSH_CONNECT' : 'INTERNAL');
  return new SshError(sshCode, `${prefix}${message}`, { cause, connectionLevel });
}

// ---------------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asPort(value) {
  const port = Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_SSH_PORT;
}

function toMode(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value) & 0o7777;
  if (typeof value === 'string' && /^[0-7]{3,4}$/.test(value)) return Number.parseInt(value, 8) & 0o7777;
  return fallback;
}

function randomToken(bytes) {
  return randomBytes(bytes).toString('hex');
}

async function readJsonFile(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function getDshHome() {
  const explicit = asString(process.env.DSH_HOME).trim();
  return explicit || path.join(os.homedir(), '.dsh');
}

function defaultSshDataDir() {
  return path.join(getDshHome(), 'ssh-tunnel');
}

function getProfileDir() {
  const explicit = asString(process.env.DSH_PROFILE_DIR).trim();
  if (explicit) return explicit;
  const profile = asString(process.env.DSH_PROFILE).trim() || 'desktop';
  return path.join(getDshHome(), 'profiles', profile);
}

function localUserName() {
  return asString(process.env.USER) || asString(process.env.LOGNAME) || asString(process.env.USERNAME) || '';
}

function typeFromMode(mode) {
  const value = Number(mode);
  if (!Number.isFinite(value) || value <= 0) return 'other';
  switch (value & S_IFMT) {
    case S_IFDIR:
      return 'dir';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'other';
  }
}

function mtimeMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function attrsToStat(target, attrs) {
  const record = isPlainObject(attrs) ? attrs : {};
  const size = Number(record.size);
  const mode = Number(record.mode);
  return {
    path: target,
    type: typeFromMode(mode),
    size: Number.isFinite(size) ? size : 0,
    mtime: mtimeMs(record.mtime),
    mode: Number.isFinite(mode) ? mode : 0,
  };
}

function normalizeRemotePath(input) {
  if (input === undefined || input === null) return '.';
  if (typeof input !== 'string') throw new SshError('INTERNAL', 'Remote path must be a string');
  const trimmed = input.trim();
  if (!trimmed) return '.';
  const normalized = path.posix.normalize(trimmed);
  return normalized === '' ? '.' : normalized;
}

function joinRemote(dir, name) {
  if (dir === '.' || dir === '') return name;
  return path.posix.join(dir, name);
}

function compareEntries(a, b) {
  const rankA = a.type === 'dir' ? 0 : 1;
  const rankB = b.type === 'dir' ? 0 : 1;
  if (rankA !== rankB) return rankA - rankB;
  const loweredA = a.name.toLowerCase();
  const loweredB = b.name.toLowerCase();
  if (loweredA < loweredB) return -1;
  if (loweredA > loweredB) return 1;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

/** Wrap a callback-style ssh2 method as a promise. */
function callSftp(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    try {
      sftp[method](...args, done);
    } catch (err) {
      done(err);
    }
  });
}

function isExtensionUnsupportedError(err) {
  if (!err) return false;
  if (typeof err.code === 'number' && err.code === 8) return true; // OP_UNSUPPORTED
  return /does not support this extended request/i.test(String(err.message || ''));
}

// ---------------------------------------------------------------------------
// Minimal per-file mutex, so concurrent first-use of one known_hosts file does
// not drop entries when several hosts connect at the same time.
// ---------------------------------------------------------------------------

const fileLocks = new Map();

async function withFileLock(file, task) {
  const previous = fileLocks.get(file) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  fileLocks.set(file, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (fileLocks.get(file) === tail) fileLocks.delete(file);
  }
}

// ---------------------------------------------------------------------------
// ssh2 loader
// ---------------------------------------------------------------------------

let ssh2Module = null;
let ssh2Loading = null;

function describeLoadError(err) {
  const message = String((err && err.message) || err || 'unknown error').split('\n')[0];
  const code = err && err.code ? `${err.code}: ` : '';
  return `${code}${message}`.slice(0, 200);
}

function normalizeSsh2Module(loaded) {
  const candidates = [loaded, loaded && loaded.default];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.Client === 'function') {
      return { Client: candidate.Client, utils: candidate.utils, module: candidate };
    }
  }
  return null;
}

function requireSsh2From(baseFile) {
  const requireFrom = createRequire(baseFile);
  return requireFrom('ssh2');
}

function requireSsh2Directory(dir) {
  const requireFrom = createRequire(path.join(dir, 'package.json'));
  return requireFrom(dir);
}

async function findPnpmSsh2Directories(profileDir) {
  const pnpmDir = path.join(profileDir, 'node_modules', '.pnpm');
  let entries;
  try {
    entries = await fs.readdir(pnpmDir);
  } catch {
    return [];
  }
  const directories = [];
  for (const entry of entries) {
    if (!/^ssh2@/.test(entry)) continue;
    const dir = path.join(pnpmDir, entry, 'node_modules', 'ssh2');
    if (await fileExists(path.join(dir, 'package.json'))) directories.push(dir);
  }
  return directories;
}

/**
 * Load the `ssh2` module.
 *
 * The plugin is normally installed as a symlink, so a bare `import('ssh2')`
 * does not resolve against the DSH profile. Try, in order:
 *   1. plain `import('ssh2')` (correct for a normal install / other machines)
 *   2. a require anchored at the DSH profile directory
 *   3. a require anchored at the profile's dsh-ssh-tunnel plugin
 *   4. the profile's pnpm store (.pnpm/ssh2@*\/node_modules/ssh2)
 *
 * The resolved module is cached for the lifetime of the process.
 *
 * @returns {Promise<{ Client: any, utils?: any }>}
 */
export async function loadSsh2() {
  if (ssh2Module) return ssh2Module;
  if (ssh2Loading) return ssh2Loading;
  const loading = resolveSsh2();
  ssh2Loading = loading;
  try {
    return await loading;
  } finally {
    if (ssh2Loading === loading) ssh2Loading = null;
  }
}

async function resolveSsh2() {
  const profileDir = getProfileDir();
  const attempts = [];

  const candidates = [
    { label: "import('ssh2')", load: () => import('ssh2') },
    { label: `require('ssh2') from ${profileDir}`, load: () => requireSsh2From(path.join(profileDir, 'package.json')) },
    {
      label: `require('ssh2') from ${path.join(profileDir, 'node_modules', 'dsh-ssh-tunnel')}`,
      load: () => requireSsh2From(path.join(profileDir, 'node_modules', 'dsh-ssh-tunnel', 'package.json')),
    },
  ];

  for (const directory of await findPnpmSsh2Directories(profileDir)) {
    candidates.push({ label: `require('ssh2') from ${directory}`, load: () => requireSsh2Directory(directory) });
  }

  for (const candidate of candidates) {
    try {
      const normalized = normalizeSsh2Module(await candidate.load());
      if (!normalized) throw new Error('module does not export a Client constructor');
      ssh2Module = normalized;
      return normalized;
    } catch (err) {
      attempts.push({ label: candidate.label, error: describeLoadError(err) });
    }
  }

  const details = attempts.map((attempt) => `  - ${attempt.label}: ${attempt.error}`).join('\n');
  throw new SshError(
    'INTERNAL',
    [
      'Failed to load the "ssh2" module.',
      'Tried:',
      details,
      '',
      'Install ssh2 in the plugin (npm install ssh2) or make it resolvable from the DSH',
      `profile (DSH_PROFILE_DIR=${profileDir}).`,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Host discovery - DSH SSH Manager store
// ---------------------------------------------------------------------------

function mergeSecrets(base, override) {
  if (!base && !override) return null;
  const merged = { ...(base || {}) };
  for (const key of Object.keys(override || {})) {
    const value = override[key];
    if (typeof value === 'string' && value) merged[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * Read and normalize an SSH Manager secrets file.
 * The result never leaves this module: it is only used to authenticate and to
 * decide whether a host has usable credentials.
 */
async function readSshManagerSecrets(dataDir) {
  const raw = await readJsonFile(path.join(dataDir, 'secrets.json'));
  const byHostId = isPlainObject(raw) && isPlainObject(raw.byHostId) ? raw.byHostId : {};
  const secrets = {};
  for (const id of Object.keys(byHostId)) {
    const entry = normalizeSecretEntry(byHostId[id]);
    if (entry) secrets[id] = entry;
  }
  return secrets;
}

// ---------------------------------------------------------------------------
// Host discovery - plugin-local credential store
// ---------------------------------------------------------------------------
//
// `dsh-ssh-tunnel` (the SSH Manager) is optional. Without it there is no place
// to keep a password, so hosts parsed from `~/.ssh/config` that have no
// `IdentityFile` used to be unusable. The plugin therefore keeps its own store
// at `<dataDir>/ssh-credentials.json`:
//
//   { "version": 1, "byHostId": { "<hostId>": { "password"|"privateKey"|"passphrase": "..." } } }
//
// It is written with 0600 permissions and never leaves the Host process: the
// API only ever reports `authType` / `hasCredential` / `hasStoredPassword`.

const CREDENTIALS_VERSION = 1;

function normalizeSecretEntry(value) {
  if (!isPlainObject(value)) return null;
  const entry = {};
  if (typeof value.password === 'string' && value.password) entry.password = value.password;
  if (typeof value.privateKey === 'string' && value.privateKey) entry.privateKey = value.privateKey;
  if (typeof value.passphrase === 'string' && value.passphrase) entry.passphrase = value.passphrase;
  return Object.keys(entry).length > 0 ? entry : null;
}

/**
 * Read the plugin's own credential store.
 * @param {string} file
 * @returns {Promise<Record<string, { password?: string, privateKey?: string, passphrase?: string }>>}
 */
export async function readLocalCredentials(file) {
  if (typeof file !== 'string' || !file.trim()) return {};
  const raw = await readJsonFile(file);
  const byHostId = isPlainObject(raw) && isPlainObject(raw.byHostId) ? raw.byHostId : {};
  const secrets = {};
  for (const id of Object.keys(byHostId)) {
    const entry = normalizeSecretEntry(byHostId[id]);
    if (entry) secrets[id] = entry;
  }
  return secrets;
}

/**
 * Store (or delete) the plugin-local credential of one host.
 * Passing `null` removes the entry. The secret is never returned.
 *
 * @param {string} file
 * @param {string} hostId
 * @param {{ password?: string, privateKey?: string, passphrase?: string } | null} patch
 * @returns {Promise<boolean>} true when the host now has a stored credential
 */
export async function writeLocalCredential(file, hostId, patch) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new SshError('INTERNAL', 'A credentials file path is required');
  }
  const id = asString(hostId).trim();
  if (!id) throw new SshError('BAD_REQUEST', 'A host id is required');
  return withFileLock(file, async () => {
    const current = await readJsonFile(file);
    const byHostId = isPlainObject(current) && isPlainObject(current.byHostId) ? { ...current.byHostId } : {};
    const entry = patch === null ? null : normalizeSecretEntry(patch);
    if (entry) byHostId[id] = entry;
    else delete byHostId[id];
    const payload = `${JSON.stringify({ version: CREDENTIALS_VERSION, byHostId }, null, 2)}\n`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomToken(6)}.tmp`;
    await fs.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, file);
    try {
      await fs.chmod(file, 0o600);
    } catch {
      /* best effort on filesystems without POSIX modes */
    }
    return Boolean(entry);
  });
}

function normalizeAuthType(value, context = {}) {
  if (typeof value === 'string' && AUTH_TYPES.has(value)) return value;
  const secret = context.secret && typeof context.secret === 'object' ? context.secret : null;
  if (context.privateKeyPath) return 'privateKey';
  if (secret && (typeof secret.privateKey === 'string' || Buffer.isBuffer(secret.privateKey)) && secret.privateKey) return 'privateKey';
  if (secret && typeof secret.password === 'string' && secret.password) return 'password';
  return 'agent';
}

async function computeHasCredential(authType, privateKeyPath, secret) {
  if (authType === 'password') return Boolean(secret && secret.password);
  if (authType === 'privateKey') {
    if (secret && secret.privateKey) return true;
    if (typeof privateKeyPath === 'string' && privateKeyPath) return fileExists(privateKeyPath);
    return false;
  }
  return Boolean(asString(process.env.SSH_AUTH_SOCK) || asString(process.env.SSH_AGENT_SOCK));
}

function pickHostKeyAlgorithms(record) {
  if (!Array.isArray(record.hostKeyAlgorithms)) return undefined;
  const algorithms = record.hostKeyAlgorithms.filter((item) => typeof item === 'string' && item);
  return algorithms.length > 0 ? algorithms : undefined;
}

/**
 * Read hosts from the DSH SSH Manager store (hosts.json + secrets.json).
 *
 * `hosts.json` may be a bare array or `{ hosts: [...] }`. A missing or corrupt
 * file yields an empty list. Secrets are only inspected to set
 * `hasCredential`; no secret value is ever placed on a returned record.
 *
 * @param {{ homeDir?: string, dataDir?: string, credentials?: Record<string, object> }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function readSshManagerHosts(opts = {}) {
  const dataDir = typeof opts.dataDir === 'string' && opts.dataDir ? opts.dataDir : defaultSshDataDir();
  const raw = await readJsonFile(path.join(dataDir, 'hosts.json'));
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) && Array.isArray(raw.hosts) ? raw.hosts : [];
  const secrets = await readSshManagerSecrets(dataDir);
  const local = isPlainObject(opts.credentials) ? opts.credentials : {};
  const records = [];

  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    const host = asString(entry.host) || asString(entry.hostname);
    if (!host) continue;
    const port = asPort(entry.port);
    const username = asString(entry.username) || asString(entry.user);
    const id = asString(entry.id) || `ssh-manager:${username}@${host}:${port}`;
    const name = asString(entry.name) || host;
    const privateKeyPath = asString(entry.privateKeyPath) || asString(entry.identityFile) || undefined;
    // A credential stored by this plugin wins over the SSH Manager one, so a
    // stale password can be fixed without the companion plugin.
    const secret = mergeSecrets(secrets[id] || null, local[id] || null);
    const authType = normalizeAuthType(entry.authType, { privateKeyPath, secret });
    const record = {
      id,
      name,
      host,
      port,
      username,
      authType,
      source: 'ssh-manager',
      hasCredential: await computeHasCredential(authType, privateKeyPath, secret),
    };
    if (privateKeyPath) record.privateKeyPath = privateKeyPath;
    if (secret && secret.password) record.hasStoredPassword = true;
    const hostKeyAlgorithms = pickHostKeyAlgorithms(entry);
    if (hostKeyAlgorithms) record.hostKeyAlgorithms = hostKeyAlgorithms;
    records.push(record);
  }

  return records;
}

// ---------------------------------------------------------------------------
// Host discovery - ~/.ssh/config
// ---------------------------------------------------------------------------

function stripInlineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return line.slice(0, i);
  }
  return line;
}

function unquote(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitDirective(line) {
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*)?(.*)$/.exec(line);
  if (!match) return null;
  return { keyword: match[1].toLowerCase(), value: match[2].trim() };
}

function splitAliases(value) {
  return String(value || '')
    .split(/\s+/)
    .map((alias) => unquote(alias))
    .filter((alias) => alias.length > 0);
}

function expandIdentityTokens(value, context) {
  return String(value || '').replace(/%[du%]/g, (token) => {
    if (token === '%d') return context.homeDir;
    if (token === '%u') return context.user;
    return '%';
  });
}

function resolveLocalConfigPath(value, homeDir) {
  let expanded = unquote(value);
  if (!expanded) return undefined;
  expanded = expandIdentityTokens(expanded, { homeDir, user: localUserName() });
  if (expanded === '~') expanded = homeDir;
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = path.join(homeDir, expanded.slice(2));
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  // Relative IdentityFile paths are relative to ~/.ssh in practice.
  return path.resolve(path.join(homeDir, '.ssh'), expanded);
}

/**
 * Auth type for a `~/.ssh/config` host.
 * A stored password only wins when there is no usable key file, so a host with
 * a working `IdentityFile` keeps using the key.
 */
async function resolveConfigAuthType(privateKeyPath, secret) {
  if (secret && secret.password) {
    if (!privateKeyPath) return 'password';
    return (await fileExists(privateKeyPath)) ? 'privateKey' : 'password';
  }
  if (privateKeyPath) return 'privateKey';
  if (secret && secret.privateKey) return 'privateKey';
  return 'agent';
}

/**
 * Parse ~/.ssh/config into host records.
 *
 * Case-insensitive keywords, Host/HostName/Port/User/IdentityFile are honoured;
 * wildcard, negated and `Match` blocks are skipped. `Include` is not followed.
 * The first definition of an alias wins, like OpenSSH.
 *
 * @param {{ homeDir?: string, credentials?: Record<string, object> }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function readSshConfigHosts(opts = {}) {
  const homeDir = typeof opts.homeDir === 'string' && opts.homeDir ? opts.homeDir : os.homedir();
  const local = isPlainObject(opts.credentials) ? opts.credentials : {};
  const configFile = path.join(homeDir, '.ssh', 'config');
  let text;
  try {
    text = await fs.readFile(configFile, 'utf8');
  } catch {
    return [];
  }

  const defaultUser = localUserName();
  const records = [];
  const seenAliases = new Set();
  let current = null;

  const flush = async () => {
    if (!current) return;
    const { aliases, options } = current;
    current = null;
    for (const alias of aliases) {
      if (/[*?!]/.test(alias)) continue; // wildcard / negated pattern
      if (seenAliases.has(alias)) continue;
      const hostNameRaw = unquote(options.hostname || '') || alias;
      const host = hostNameRaw.replace(/%h/g, alias);
      const port = asPort(options.port);
      const username = unquote(options.user || '') || defaultUser;
      const privateKeyPath = options.identityfile ? resolveLocalConfigPath(options.identityfile, homeDir) : undefined;
      const id = `sshconfig:${alias}`;
      const secret = mergeSecrets(null, local[id] || null);
      const authType = await resolveConfigAuthType(privateKeyPath, secret);
      const record = {
        id,
        name: alias,
        host,
        port,
        username,
        authType,
        source: 'ssh-config',
        hasCredential: await computeHasCredential(authType, privateKeyPath, secret),
      };
      if (privateKeyPath) record.privateKeyPath = privateKeyPath;
      if (secret && secret.password) record.hasStoredPassword = true;
      seenAliases.add(alias);
      records.push(record);
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;
    const directive = splitDirective(line);
    if (!directive) continue;
    const { keyword, value } = directive;

    if (keyword === 'host') {
      await flush();
      current = { aliases: splitAliases(value), options: {} };
      continue;
    }
    if (keyword === 'match') {
      await flush();
      current = null;
      continue;
    }
    if (keyword === 'include') continue;
    if (!current) continue;
    if (keyword === 'identityfile') {
      if (!current.options.identityfile) current.options.identityfile = value;
      continue;
    }
    if (current.options[keyword] === undefined) current.options[keyword] = value;
  }
  await flush();

  return records;
}

/**
 * Merge SSH Manager hosts and ~/.ssh/config hosts, de-duplicated by
 * username@host:port. Manager hosts win and appear first.
 *
 * `credentialFile` points at this plugin's own credential store, which makes a
 * `~/.ssh/config` host without `IdentityFile` usable even when the SSH Manager
 * (`dsh-ssh-tunnel`) is not installed.
 *
 * @param {{ homeDir?: string, dataDir?: string, credentialFile?: string }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function listHosts(opts = {}) {
  const credentials = await readLocalCredentials(opts.credentialFile);
  const [managerHosts, configHosts] = await Promise.all([
    readSshManagerHosts({ ...opts, credentials }),
    readSshConfigHosts({ ...opts, credentials }),
  ]);
  const merged = [];
  const seen = new Set();
  for (const record of [...managerHosts, ...configHosts]) {
    const key = `${record.username}@${String(record.host).toLowerCase()}:${record.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(record);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Known hosts (trust on first use)
// ---------------------------------------------------------------------------

async function readKnownHostsStore(file) {
  const empty = { version: KNOWN_HOSTS_VERSION, byAuthority: {} };
  const raw = await readJsonFile(file);
  if (!isPlainObject(raw)) return empty;
  const source = isPlainObject(raw.byAuthority) ? raw.byAuthority : isPlainObject(raw.keys) ? raw.keys : null;
  if (!source) return empty;

  const byAuthority = {};
  for (const authority of Object.keys(source)) {
    const value = source[authority];
    const stored = typeof value === 'string' ? value : isPlainObject(value) ? value.fingerprint : '';
    if (typeof stored !== 'string' || !stored) continue;
    let fingerprint = stored;
    if (/^sha256:/i.test(stored)) fingerprint = `SHA256:${stored.slice(7)}`;
    else if (/^[0-9a-f]{64}$/i.test(stored)) fingerprint = `SHA256:${stored}`;
    const firstSeenRaw = isPlainObject(value) ? (value.firstSeen === undefined ? value.trustedAt : value.firstSeen) : 0;
    const firstSeen = Number.isFinite(Number(firstSeenRaw)) ? Number(firstSeenRaw) : 0;
    byAuthority[authority] = { fingerprint, firstSeen };
  }
  return { version: KNOWN_HOSTS_VERSION, byAuthority };
}

async function writeKnownHostsStore(file, store) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomToken(4)}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.chmod(temp, 0o600);
    } catch {
      /* best effort (Windows ignores POSIX modes) */
    }
    await fs.rename(temp, file);
  } catch (err) {
    try {
      await fs.unlink(temp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// RemoteHost
// ---------------------------------------------------------------------------

/**
 * A single SSH connection to one host, with lazily created SFTP channel,
 * TOFU host key verification and one-shot reconnect on transport failures.
 *
 * Extra (optional) host record fields used for manual hosts:
 *   - password / privateKey / passphrase: inline credentials
 *   - dataDir: where to look for the SSH Manager secrets.json
 */
export class RemoteHost {
  #client = null;
  #ready = false;
  #connecting = null;
  #sftp = null;
  #sftpCreating = null;
  #homeDir = null;
  #hostKeyMismatch = null;
  #generation = 0;
  #logger;
  #dataDir;
  #credentialFile = null;
  #onLost = null;

  /**
   * @param {{
   *   host: object,
   *   knownHostsFile: string,
   *   connectTimeoutMs?: number,
   *   logger?: (level: 'info'|'warn'|'error', message: string) => void,
   *   dataDir?: string,
   *   credentialFile?: string,
   *   onLost?: (info: { reason: string, authority: string }) => void,
   * }} options
   */
  constructor(options = {}) {
    const { host, knownHostsFile, connectTimeoutMs, logger, dataDir, credentialFile, onLost } = options || {};
    if (!isPlainObject(host) || !asString(host.host).trim()) {
      throw new SshError('INTERNAL', 'RemoteHost requires a host record with a non-empty "host" field');
    }
    if (typeof knownHostsFile !== 'string' || !knownHostsFile.trim()) {
      throw new SshError('INTERNAL', 'RemoteHost requires a knownHostsFile path');
    }

    const hostRecord = { ...host, host: asString(host.host).trim() };
    hostRecord.port = asPort(host.port);
    hostRecord.username = asString(host.username).trim();
    hostRecord.authType = normalizeAuthType(host.authType, { privateKeyPath: host.privateKeyPath, secret: host });
    if (typeof host.privateKeyPath === 'string' && host.privateKeyPath) hostRecord.privateKeyPath = host.privateKeyPath;

    this.host = hostRecord;
    this.knownHostsFile = knownHostsFile;
    const timeout = Number(connectTimeoutMs);
    this.connectTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CONNECT_TIMEOUT_MS;
    this.#logger = typeof logger === 'function' ? logger : null;
    this.#dataDir = typeof dataDir === 'string' && dataDir ? dataDir : null;
    this.#credentialFile = typeof credentialFile === 'string' && credentialFile ? credentialFile : null;
    this.#onLost = typeof onLost === 'function' ? onLost : null;
  }

  /** "host:port" */
  get authority() {
    return `${this.host.host}:${this.host.port}`;
  }

  /** True while a client is connected and past authentication. */
  get connected() {
    return Boolean(this.#client) && this.#ready;
  }

  // -- logging --------------------------------------------------------------

  #log(level, message) {
    if (!this.#logger) return;
    try {
      this.#logger(level, message);
    } catch {
      /* a broken logger must never break the transport */
    }
  }

  // -- connection lifecycle -------------------------------------------------

  /** Connect (or reuse an existing connection). */
  async connect() {
    if (this.#client && this.#ready) return this;
    if (this.#connecting) return this.#connecting;

    const connecting = this.#openClient();
    this.#connecting = connecting;
    try {
      return await connecting;
    } finally {
      if (this.#connecting === connecting) this.#connecting = null;
    }
  }

  /** Connect if not already connected. */
  async ensureConnected() {
    return this.connect();
  }

  /** Close the connection. The instance stays usable and reconnects on demand. */
  async dispose() {
    await this.#teardownConnection();
    this.#log('info', `Released SSH connection to ${this.authority}`);
  }

  async #openClient() {
    const ssh2 = await loadSsh2();
    const auth = await this.#resolveAuth();
    const knownHosts = await readKnownHostsStore(this.knownHostsFile);
    this.#hostKeyMismatch = null;

    const client = new ssh2.Client();
    this.#generation += 1;
    this.#client = client;
    this.#ready = false;

    const config = {
      host: this.host.host,
      port: this.host.port,
      username: auth.username,
      readyTimeout: this.connectTimeoutMs,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      tryKeyboard: false,
      hostHash: 'sha256',
      hostVerifier: (hashedKey, callback) => this.#verifyHostKey(knownHosts, hashedKey, callback),
    };
    if (auth.password) config.password = auth.password;
    if (auth.privateKey) config.privateKey = auth.privateKey;
    if (auth.passphrase) config.passphrase = auth.passphrase;
    if (auth.agent) config.agent = auth.agent;
    if (Array.isArray(this.host.hostKeyAlgorithms) && this.host.hostKeyAlgorithms.length > 0) {
      config.algorithms = { serverHostKey: this.host.hostKeyAlgorithms };
    }

    const connectError = await new Promise((resolve) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        resolve(err || null);
      };

      client.on('ready', () => {
        this.#ready = true;
        finish(null);
      });
      client.on('error', (err) => {
        if (!settled) {
          finish(err);
          return;
        }
        this.#log('warn', `Connection error on ${this.authority}: ${err.message}`);
        this.#onClientLost(client, err.message);
      });
      client.on('close', () => {
        if (!settled) {
          finish(new SshError('SSH_CONNECT', `Connection to ${this.authority} closed before it became ready`));
          return;
        }
        this.#log('info', `Connection to ${this.authority} closed`);
        this.#onClientLost(client, 'connection closed');
      });

      try {
        client.connect(config);
      } catch (err) {
        finish(err);
      }
    });

    if (connectError) {
      const mapped = this.#classifyConnectError(connectError);
      this.#onClientLost(client);
      this.#log('error', `Connect failed for ${this.authority}: ${mapped.message}`);
      throw mapped;
    }

    this.#log('info', `Connected to ${this.authority} as ${auth.username}`);
    return this;
  }

  #onClientLost(client, reason) {
    if (this.#client !== client) return;
    // Only a connection that had already reached "ready" counts as lost; a
    // failure during the initial connect is reported by connect() itself.
    const wasReady = this.#ready;
    this.#client = null;
    this.#ready = false;
    this.#sftp = null;
    this.#sftpCreating = null;
    this.#generation += 1;
    try {
      client.end();
    } catch {
      /* ignore */
    }
    if (wasReady) this.#notifyLost(reason);
  }

  #notifyLost(reason) {
    if (!this.#onLost) return;
    try {
      this.#onLost({ reason: asString(reason) || 'connection lost', authority: this.authority });
    } catch {
      /* a broken listener must never break the transport */
    }
  }

  async #teardownConnection() {
    const client = this.#client;
    this.#client = null;
    this.#ready = false;
    this.#sftp = null;
    this.#sftpCreating = null;
    this.#generation += 1;
    if (!client) return;
    try {
      client.end();
    } catch {
      /* ignore */
    }
  }

  #classifyConnectError(raw) {
    if (raw instanceof SshError) return raw;
    const message = String((raw && raw.message) || raw || 'connection failed');
    const level = raw && raw.level;
    const code = raw && raw.code;
    const mismatch = this.#hostKeyMismatch;

    if (mismatch && (/host denied/i.test(message) || /verification failed/i.test(message) || level === 'handshake')) {
      return new SshError(
        'HOST_KEY_MISMATCH',
        [
          `Host key mismatch for ${this.authority}:`,
          `expected ${mismatch.expected} but the server presented ${mismatch.actual}.`,
          `If this change is expected, remove the entry for ${this.authority} from ${this.knownHostsFile} and reconnect.`,
        ].join(' '),
        { cause: raw },
      );
    }
    if (
      /all configured authentication methods failed/i.test(message) ||
      /cannot parse privatekey/i.test(message) ||
      /invalid username/i.test(message) ||
      level === 'client-authentication'
    ) {
      const hint = /cannot parse privatekey/i.test(message)
        ? ' The private key could not be parsed; if it is passphrase protected, store the passphrase in the SSH Manager secrets.'
        : '';
      return new SshError(
        'AUTH_FAILED',
        `Authentication failed for ${this.authority} (user "${this.host.username}"): ${message}.${hint}`,
        { cause: raw },
      );
    }
    if (level === 'client-timeout' || /timed out while waiting for handshake/i.test(message)) {
      return new SshError('TIMEOUT', `Timed out connecting to ${this.authority} after ${this.connectTimeoutMs} ms`, { cause: raw });
    }
    if (level === 'client-dns' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new SshError('SSH_CONNECT', `Cannot resolve host "${this.host.host}": ${message}`, { cause: raw });
    }
    if (/connection lost before handshake|no response from server/i.test(message)) {
      return new SshError(
        'SSH_CONNECT',
        `Cannot reach ${this.authority}: ${message} (host unreachable, connection refused, or not an SSH server)`,
        { cause: raw },
      );
    }
    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'EPIPE' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH' ||
      code === 'ENETDOWN' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNABORTED'
    ) {
      return new SshError('SSH_CONNECT', `Cannot connect to ${this.authority}: ${code} ${message}`, { cause: raw });
    }
    return new SshError('SSH_CONNECT', `SSH connection to ${this.authority} failed: ${message}`, { cause: raw });
  }

  // -- authentication -------------------------------------------------------

  async #secretForHost() {
    const local = this.#credentialFile
      ? (await readLocalCredentials(this.#credentialFile))[this.host.id] || null
      : null;
    const dataDir = this.#dataDir || defaultSshDataDir();
    const manager = (await readSshManagerSecrets(dataDir))[this.host.id] || null;
    // The plugin-local store wins, so a password set in the add-workspace dialog
    // takes effect even when the SSH Manager holds a stale one.
    return mergeSecrets(manager, local);
  }

  async #resolveAuth() {
    const authority = this.authority;
    const username = asString(this.host.username).trim();
    if (!username) throw new SshError('AUTH_FAILED', `No username configured for ${authority}`);

    const authType = AUTH_TYPES.has(this.host.authType) ? this.host.authType : 'agent';

    if (authType === 'agent') {
      const socket = asString(process.env.SSH_AUTH_SOCK) || asString(process.env.SSH_AGENT_SOCK);
      if (!socket) {
        throw new SshError(
          'AUTH_FAILED',
          `Host ${authority} is configured for SSH agent authentication but no agent socket is available (SSH_AUTH_SOCK is not set).`,
        );
      }
      return { username, agent: socket };
    }

    const secret = await this.#secretForHost();
    const passphrase = asString(this.host.passphrase) || (secret && secret.passphrase) || undefined;

    if (authType === 'password') {
      const password = asString(this.host.password) || (secret && secret.password) || '';
      if (!password) {
        throw new SshError(
          'AUTH_FAILED',
          `No password is stored for ${authority}. Enter it in the add-workspace dialog (it stays on this machine) or in the SSH Tunnel tab.`,
        );
      }
      return { username, password };
    }

    // privateKey
    if (this.host.privateKey) return { username, privateKey: this.host.privateKey, ...(passphrase ? { passphrase } : {}) };

    const keyPath = asString(this.host.privateKeyPath);
    if (keyPath) {
      try {
        const privateKey = await fs.readFile(keyPath);
        return { username, privateKey, ...(passphrase ? { passphrase } : {}) };
      } catch (err) {
        if (secret && secret.privateKey) {
          this.#log('info', `Private key file "${keyPath}" is not readable for ${authority}; using the key stored in the SSH Manager secrets`);
          return { username, privateKey: secret.privateKey, ...(passphrase ? { passphrase } : {}) };
        }
        throw new SshError(
          'AUTH_FAILED',
          `Cannot read the private key file "${keyPath}" for ${authority}: ${(err && err.code) || (err && err.message) || 'unknown error'}`,
          { cause: err },
        );
      }
    }

    if (secret && secret.privateKey) return { username, privateKey: secret.privateKey, ...(passphrase ? { passphrase } : {}) };

    throw new SshError(
      'AUTH_FAILED',
      `No private key is configured for ${authority} (privateKeyPath is empty and the SSH Manager stores no key for host "${this.host.id}").`,
    );
  }

  // -- host key trust -------------------------------------------------------

  #verifyHostKey(store, hashedKey, callback) {
    let answered = false;
    const answer = (permitted) => {
      if (answered) return;
      answered = true;
      callback(permitted);
    };

    const fingerprint = `SHA256:${String(hashedKey || '').toLowerCase()}`;
    const entry = store.byAuthority[this.authority];

    if (!entry) {
      this.#log('info', `Trusting new host key for ${this.authority}: ${fingerprint}`);
      this.#rememberHostKey(fingerprint).then(
        () => answer(true),
        (err) => {
          // Accept for this session, but keep the connection usable: the store
          // could not be written (read-only profile, permissions, ...).
          this.#log('error', `Could not persist the host key for ${this.authority}: ${(err && err.message) || err}`);
          answer(true);
        },
      );
      return;
    }

    if (String(entry.fingerprint).toLowerCase() === fingerprint.toLowerCase()) {
      answer(true);
      return;
    }

    this.#hostKeyMismatch = { expected: entry.fingerprint, actual: fingerprint };
    this.#log('error', `Host key mismatch for ${this.authority}: expected ${entry.fingerprint}, got ${fingerprint}`);
    answer(false);
  }

  async #rememberHostKey(fingerprint) {
    const file = this.knownHostsFile;
    const authority = this.authority;
    await withFileLock(file, async () => {
      const store = await readKnownHostsStore(file);
      const existing = store.byAuthority[authority];
      if (existing && String(existing.fingerprint).toLowerCase() === fingerprint.toLowerCase()) return;
      if (existing && existing.fingerprint) {
        throw new SshError(
          'HOST_KEY_MISMATCH',
          `Host key for ${authority} changed from ${existing.fingerprint} to ${fingerprint}; refusing to overwrite ${file}`,
        );
      }
      store.byAuthority[authority] = { fingerprint, firstSeen: Date.now() };
      await writeKnownHostsStore(file, store);
    });
  }

  // -- channel management ---------------------------------------------------

  async #readyClient() {
    await this.connect();
    const client = this.#client;
    if (!client) {
      throw new SshError('SSH_CONNECT', `Not connected to ${this.authority}`, { connectionLevel: true });
    }
    return client;
  }

  async #getSftp() {
    if (this.#sftp) return this.#sftp;

    if (!this.#sftpCreating) {
      const creating = (async () => {
        const client = await this.#readyClient();
        const sftp = await callSftp(client, 'sftp');
        if (!sftp) throw new SshError('INTERNAL', `SSH server ${this.authority} did not provide an SFTP channel`);
        if (this.#client !== client) {
          throw new SshError('SSH_CONNECT', `Connection to ${this.authority} was lost while opening the SFTP channel`, {
            connectionLevel: true,
          });
        }
        const clear = () => {
          if (this.#sftp === sftp) this.#sftp = null;
        };
        sftp.on('error', (err) => {
          this.#log('warn', `SFTP channel error on ${this.authority}: ${(err && err.message) || err}`);
          clear();
        });
        sftp.once('close', clear);
        sftp.once('end', clear);
        this.#sftp = sftp;
        return sftp;
      })();
      this.#sftpCreating = creating;
      try {
        return await creating;
      } finally {
        if (this.#sftpCreating === creating) this.#sftpCreating = null;
      }
    }

    return this.#sftpCreating;
  }

  /** Run one operation, retrying once after a reconnect on transport failures. */
  async #retry(label, run, retry = true) {
    const generation = this.#generation;
    try {
      return await run();
    } catch (raw) {
      const err = toSshError(raw, label);
      if (!retry || !err.connectionLevel) throw err;
      this.#log('warn', `${label} failed (${err.code}: ${err.message}); reconnecting and retrying once`);
      if (this.#generation === generation) await this.#teardownConnection();
      try {
        return await run();
      } catch (rawAgain) {
        throw toSshError(rawAgain, label);
      }
    }
  }

  async #sftpOp(label, run, retry = true) {
    return this.#retry(
      label,
      async () => {
        const sftp = await this.#getSftp();
        return run(sftp);
      },
      retry,
    );
  }

  // -- remote exec ----------------------------------------------------------

  /**
   * Run a shell command on the remote host over one SSH exec channel.
   *
   * Resolves when the channel closes, with the command's exit status:
   *   { stdout, stderr, code }   // code is 0 when the server reports none
   *
   * Transport-level failures are retried once after a reconnect, mirroring the
   * SFTP file operations, but only while no output has arrived: a command that
   * already produced output may have had side effects and is not replayed.
   * A `timeoutMs` expiry rejects with SshError("TIMEOUT"); an aborted `signal`
   * closes the channel and rejects with an AbortError. Neither is retried.
   *
   * @param {string} command shell command line, run by the remote login shell
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
   */
  async exec(command, options = {}) {
    const defaultTimeoutMs = 20000;
    const commandText = typeof command === 'string' ? command : '';
    if (!commandText.trim()) throw new SshError('INTERNAL', 'exec requires a non-empty command');
    const opts = isPlainObject(options) ? options : {};
    const requestedTimeout = Number(opts.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.floor(requestedTimeout) : defaultTimeoutMs;
    const signal = opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null;
    const shortCommand = commandText.length > 120 ? `${commandText.slice(0, 117)}...` : commandText;
    const label = `exec ${JSON.stringify(shortCommand)}`;

    // Output already produced by an attempt makes replaying it unsafe.
    let outputStarted = false;
    let aborted = false;

    const makeAbortError = () => {
      const message = `${label}: aborted`;
      const reason = signal ? signal.reason : undefined;
      const error = reason === undefined ? new Error(message) : new Error(message, { cause: reason });
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      return error;
    };

    const runOnce = async () => {
      outputStarted = false;
      const client = await this.#readyClient();
      return new Promise((resolve, reject) => {
        const stdout = [];
        const stderr = [];
        let stream = null;
        let timer = null;
        let abortListener = null;
        let settled = false;

        const detach = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (signal && abortListener) {
            signal.removeEventListener('abort', abortListener);
            abortListener = null;
          }
        };
        const settle = (err, value) => {
          if (settled) return;
          settled = true;
          detach();
          if (err) reject(err);
          else resolve(value);
        };
        const closeChannel = () => {
          const active = stream;
          if (!active) return;
          try {
            active.close();
          } catch {
            /* the channel may already be gone */
          }
          try {
            active.destroy();
          } catch {
            /* the channel may already be gone */
          }
        };

        if (signal) {
          if (signal.aborted) {
            aborted = true;
            settle(makeAbortError());
            return;
          }
          abortListener = () => {
            aborted = true;
            closeChannel();
            settle(makeAbortError());
          };
          signal.addEventListener('abort', abortListener, { once: true });
        }

        timer = setTimeout(() => {
          closeChannel();
          settle(new SshError('TIMEOUT', `${label}: timed out after ${timeoutMs} ms`));
        }, timeoutMs);

        try {
          client.exec(commandText, (err, channel) => {
            if (settled) {
              try {
                if (channel) channel.close();
              } catch {
                /* already gone */
              }
              return;
            }
            if (err) {
              settle(err);
              return;
            }
            stream = channel;
            channel.on('data', (chunk) => {
              outputStarted = true;
              stdout.push(chunk);
            });
            channel.stderr.on('data', (chunk) => {
              outputStarted = true;
              stderr.push(chunk);
            });
            channel.on('error', (streamErr) => settle(streamErr));
            channel.on('close', (code) => {
              settle(null, {
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
                code: typeof code === 'number' ? code : 0,
              });
            });
          });
        } catch (err) {
          settle(err);
        }
      });
    };

    const generation = this.#generation;
    try {
      return await runOnce();
    } catch (raw) {
      if (aborted) throw raw;
      const mapped = toSshError(raw, label);
      if (!mapped.connectionLevel || outputStarted) throw mapped;
      this.#log('warn', `${label} failed (${mapped.code}: ${mapped.message}); reconnecting and retrying once`);
      if (this.#generation === generation) await this.#teardownConnection();
      try {
        return await runOnce();
      } catch (rawAgain) {
        if (aborted) throw rawAgain;
        throw toSshError(rawAgain, label);
      }
    }
  }

  async #exec(command) {
    return this.#retry(`exec ${JSON.stringify(command)}`, async () => {
      const client = await this.#readyClient();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err, value) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve(value);
        };
        try {
          client.exec(command, (err, stream) => {
            if (err) {
              finish(err);
              return;
            }
            const stdout = [];
            const stderr = [];
            stream.on('data', (chunk) => stdout.push(chunk));
            stream.stderr.on('data', (chunk) => stderr.push(chunk));
            stream.on('error', (streamErr) => finish(streamErr));
            stream.on('close', (code, signal) => {
              finish(null, {
                code: typeof code === 'number' ? code : 0,
                signal: signal || null,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
              });
            });
          });
        } catch (err) {
          finish(err);
        }
      });
    });
  }

  // -- directory / file operations -----------------------------------------

  async #lstatRaw(target) {
    const attrs = await this.#sftpOp(`lstat ${target}`, (sftp) => callSftp(sftp, 'lstat', target));
    return attrsToStat(target, attrs);
  }

  async #tryLstat(target) {
    try {
      return await this.#lstatRaw(target);
    } catch {
      return null;
    }
  }

  /** List a directory (hidden entries included, directories sorted first). */
  async listDir(dirPath) {
    const target = normalizeRemotePath(dirPath);
    const label = `listDir ${target}`;
    let rawEntries;
    try {
      rawEntries = await this.#sftpOp(label, (sftp) => callSftp(sftp, 'readdir', target));
    } catch (err) {
      const mapped = err instanceof SshError ? err : toSshError(err, label);
      if (mapped.code === 'FS_NOT_FOUND') {
        const probe = await this.#tryLstat(target);
        if (probe && probe.type !== 'dir') {
          throw new SshError('FS_NOT_DIR', `Not a directory: ${target}`, { cause: mapped });
        }
      }
      throw mapped;
    }

    const entries = [];
    for (const item of Array.isArray(rawEntries) ? rawEntries : []) {
      if (!isPlainObject(item)) continue;
      const name = asString(item.filename);
      if (!name || name === '.' || name === '..') continue;
      const stat = attrsToStat(joinRemote(target, name), item.attrs);
      entries.push({ name, path: stat.path, type: stat.type, size: stat.size, mtime: stat.mtime, mode: stat.mode });
    }
    entries.sort(compareEntries);
    return { path: target, entries };
  }

  /** Stat a path (lstat semantics: symlinks report type "symlink"). */
  async stat(target) {
    const normalized = normalizeRemotePath(target);
    return this.#lstatRaw(normalized);
  }

  /** Resolve a remote path to its canonical absolute form. */
  async realpath(target) {
    const normalized = normalizeRemotePath(target);
    const resolved = await this.#sftpOp(`realpath ${normalized}`, (sftp) => callSftp(sftp, 'realpath', normalized));
    return String(resolved);
  }

  /** Remote home directory, cached per instance. */
  async homeDir() {
    if (this.#homeDir) return this.#homeDir;
    let resolved = null;
    try {
      resolved = await this.#sftpOp('homeDir', (sftp) => callSftp(sftp, 'realpath', '.'));
    } catch (err) {
      this.#log('warn', `realpath(".") failed on ${this.authority}: ${(err && err.message) || err}; trying $HOME`);
    }
    if (resolved === null || resolved === undefined || resolved === '') {
      const result = await this.#exec('printf %s "$HOME"');
      resolved = String((result && result.stdout) || '').trim();
    }
    if (!resolved) throw new SshError('INTERNAL', `Could not determine the home directory of ${this.authority}`);
    this.#homeDir = path.posix.normalize(String(resolved));
    return this.#homeDir;
  }

  /** Read a file, at most `maxBytes` (default 2 MiB). */
  async readFile(filePath, options = {}) {
    const target = normalizeRemotePath(filePath);
    const label = `readFile ${target}`;
    const requestedMax = Number(options && options.maxBytes);
    const maxBytes = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : DEFAULT_READ_MAX_BYTES;

    const initial = await this.#lstatRaw(target);
    if (initial.type === 'dir') throw new SshError('FS_IS_DIR', `Cannot read "${target}": it is a directory`);
    const stat = initial.type === 'symlink' ? await this.#lstatFollow(target) : initial;
    if (stat.type === 'dir') throw new SshError('FS_IS_DIR', `Cannot read "${target}": it is a directory`);

    const size = stat.size;
    const truncated = size > maxBytes;
    const limit = truncated ? maxBytes : size;

    const data = await this.#sftpOp(label, async (sftp) => {
      const handle = await callSftp(sftp, 'open', target, 'r');
      try {
        const chunks = [];
        let position = 0;
        while (position < limit) {
          const want = Math.min(SFTP_READ_CHUNK, limit - position);
          const buffer = Buffer.allocUnsafe(want);
          const bytesRead = await callSftp(sftp, 'read', handle, buffer, 0, want, position);
          if (!bytesRead) break;
          chunks.push(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        return Buffer.concat(chunks, position);
      } finally {
        try {
          await callSftp(sftp, 'close', handle);
        } catch {
          /* the channel may already be gone; the read result is what matters */
        }
      }
    });

    return { data, truncated, size, mtime: stat.mtime, mode: stat.mode };
  }

  async #lstatFollow(target) {
    const attrs = await this.#sftpOp(`stat ${target}`, (sftp) => callSftp(sftp, 'stat', target));
    return attrsToStat(target, attrs);
  }

  /**
   * Write a file atomically: temp file in the same directory, then rename.
   * Retrying is safe because the temp name is unique per attempt.
   */
  async writeFileAtomic(filePath, data, options = {}) {
    const target = normalizeRemotePath(filePath);
    const label = `writeFileAtomic ${target}`;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data === undefined || data === null ? '' : String(data), 'utf8');
    const dir = path.posix.dirname(target);
    const base = path.posix.basename(target);
    if (!base || base === '.' || base === '/' || target === '/') {
      throw new SshError('FS_IS_DIR', `Cannot write file "${target}": not a file path`);
    }

    let fileMode = toMode(options && options.mode, null);
    if (fileMode === null) {
      fileMode = 0o644;
      const existing = await this.#tryLstat(target);
      if (existing && existing.type === 'dir') {
        throw new SshError('FS_IS_DIR', `Cannot write file "${target}": it is a directory`);
      }
      if (existing && (existing.mode & 0o7777) > 0) fileMode = existing.mode & 0o7777;
    }

    const temp = path.posix.join(dir, `.${base}.dshrw-${process.pid}-${randomToken(6)}.tmp`);

    const run = async () => {
      const sftp = await this.#getSftp();
      await callSftp(sftp, 'writeFile', temp, buffer, { mode: fileMode });
      await this.#renameOverwrite(sftp, temp, target);
    };

    try {
      await this.#retry(label, run, true);
    } catch (raw) {
      await this.#safeUnlink(temp);
      const mapped = toSshError(raw, label);
      const probe = await this.#tryLstat(target);
      if (probe && probe.type === 'dir') {
        throw new SshError('FS_IS_DIR', `Cannot write file "${target}": it is a directory`, { cause: mapped });
      }
      throw mapped;
    }

    try {
      const stat = await this.#lstatRaw(target);
      return { size: stat.size, mtime: stat.mtime };
    } catch (err) {
      this.#log('warn', `Wrote "${target}" but could not stat it afterwards: ${(err && err.message) || err}`);
      return { size: buffer.length, mtime: Date.now() };
    }
  }

  /**
   * Replace `to` with `from`.
   * Prefers the OpenSSH posix-rename extension (atomic, overwrites the target).
   * Plain SFTP v3 rename does NOT overwrite on OpenSSH, so the fallback removes
   * the target first (documented non-atomic path).
   */
  async #renameOverwrite(sftp, from, to) {
    try {
      await callSftp(sftp, 'ext_openssh_rename', from, to);
      return;
    } catch (err) {
      if (!isExtensionUnsupportedError(err)) throw err;
    }

    try {
      await callSftp(sftp, 'rename', from, to);
      return;
    } catch (err) {
      const mapped = toSshError(err);
      if (mapped.code !== 'INTERNAL' && mapped.code !== 'FS_IS_DIR') throw err;
      // The target may already exist (SFTP v3 rename refuses to replace it).
      try {
        await callSftp(sftp, 'unlink', to);
      } catch (unlinkErr) {
        if (toSshError(unlinkErr).code !== 'FS_NOT_FOUND') throw err;
      }
      await callSftp(sftp, 'rename', from, to);
    }
  }

  async #safeUnlink(target) {
    const sftp = this.#sftp;
    if (!sftp) return;
    try {
      await callSftp(sftp, 'unlink', target);
    } catch {
      /* best effort cleanup */
    }
  }

  /** Create a directory and all missing parents. */
  async mkdirp(dirPath) {
    const target = normalizeRemotePath(dirPath);
    if (target === '/' || target === '.') return;

    const absolute = target.startsWith('/');
    const segments = target.split('/').filter((segment) => segment && segment !== '.');
    const label = `mkdirp ${target}`;

    await this.#retry(label, async () => {
      const sftp = await this.#getSftp();
      let current = '';
      for (const segment of segments) {
        current = absolute ? `${current}/${segment}` : current ? `${current}/${segment}` : segment;
        try {
          await callSftp(sftp, 'mkdir', current);
        } catch (err) {
          const mapped = toSshError(err);
          const probe = await callSftp(sftp, 'lstat', current).catch(() => null);
          if (probe && typeFromMode(probe.mode) === 'dir') continue;
          if (probe && typeFromMode(probe.mode) !== 'dir') {
            throw new SshError('FS_NOT_DIR', `Cannot create directory "${current}": a non-directory entry already exists`, {
              cause: mapped,
            });
          }
          throw mapped;
        }
      }
    });
  }

  /** Rename / move a remote path. */
  async rename(from, to) {
    const source = normalizeRemotePath(from);
    const destination = normalizeRemotePath(to);
    const label = `rename ${source} -> ${destination}`;
    let attempts = 0;
    await this.#retry(
      label,
      async () => {
        attempts += 1;
        const sftp = await this.#getSftp();
        try {
          await callSftp(sftp, 'rename', source, destination);
        } catch (err) {
          if (attempts > 1) {
            // The previous attempt may have completed before the connection broke.
            const probe = await callSftp(sftp, 'lstat', destination).catch(() => null);
            if (probe) return;
          }
          throw err;
        }
      },
      true,
    );
  }

  /** Delete a file. */
  async unlink(target) {
    const normalized = normalizeRemotePath(target);
    const label = `unlink ${normalized}`;
    let attempts = 0;
    await this.#retry(
      label,
      async () => {
        attempts += 1;
        const sftp = await this.#getSftp();
        try {
          await callSftp(sftp, 'unlink', normalized);
        } catch (err) {
          if (attempts > 1 && toSshError(err).code === 'FS_NOT_FOUND') return;
          throw err;
        }
      },
      true,
    );
  }

  /** Delete an empty directory. */
  async rmdir(target) {
    const normalized = normalizeRemotePath(target);
    const label = `rmdir ${normalized}`;
    let attempts = 0;
    await this.#retry(
      label,
      async () => {
        attempts += 1;
        const sftp = await this.#getSftp();
        try {
          await callSftp(sftp, 'rmdir', normalized);
        } catch (err) {
          if (attempts > 1 && toSshError(err).code === 'FS_NOT_FOUND') return;
          throw err;
        }
      },
      true,
    );
  }
}
