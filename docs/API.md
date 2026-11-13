# dsh-linked-workspace — internal API contract

The Host half exposes one JSON endpoint on the DSH web server:

```
POST /dsh-linked-workspace/api
Content-Type: application/json

{ "method": "<name>", "params": { ... } }
```

Success: HTTP 200 `{ "ok": true, "data": ... }`.
Failure: meaningful HTTP status + `{ "ok": false, "error": { "code": "...", "message": "..." } }`.

Codes: `BAD_REQUEST`, `NOT_FOUND`, `SSH_CONNECT`, `AUTH_FAILED`,
`HOST_KEY_MISMATCH`, `TIMEOUT`, `FS_NOT_FOUND`, `FS_PERMISSION`, `FS_IS_DIR`,
`FS_NOT_DIR`, `FS_TOO_LARGE`, `CONFLICT`, `INTERNAL`.

## Document APIs

| Method | Params | Result |
| --- | --- | --- |
| `docs.read` | `{ path, linkedId?, workspaceId? }` | kind-specific document model |
| `docs.write` | `{ path, data, expectedMtime?, linkedId?, workspaceId? }` | `{ kind, path, size, mtime }` |
| `docs.create` | `{ path, kind?, linkedId?, workspaceId? }` | `{ kind, path, size, mtime }` |
| `docs.mdPreview` | `{ path, text?, linkedId?, workspaceId? }` | `{ kind, html }` |
| `docs.mdPdf` | `{ path, text?, linkedId?, workspaceId? }` | `{ kind: "pdf", path, size, mtime }` |

## Records

```ts
HostInfo = { id, name, host, port, username, authType, source, hasCredential }
WorkspaceInfo = { id, name, hostId, hostName, host, port, username,
                  remotePath, createdAt, status: { state, message?, latencyMs? } }
LinkInfo = { id, name, localPath, hostId, hostName, host, port, username,
             remotePath, mirror, createdAt, workspaceId: string|null,
             workspaceTitle: string|null, status: {...} }
RemoteEntry = { name, path, type: 'file'|'dir'|'symlink'|'other', size, mtime,
                relative }
FileRead = { path, relative, content, size, mtime, truncated, binary,
             tooLarge, editable, encoding: 'utf-8' }
```

## Remote scope

Every `fs.*` method takes a scope: either `{ linkedId }` (a linked workspace's
remote root) or `{ remoteId }` (a remote workspace). Paths are relative to the
scope root, or absolute inside it.

## Methods

| method | params | data |
| --- | --- | --- |
| `hosts.list` | `{ refresh? }` | `{ hosts: HostInfo[] }` |
| `hosts.browse` | `{ hostId, path? }` | `{ path, parent, home, entries }` (dirs + files) |
| `remote_workspaces.list` | `{}` | `{ workspaces: RemoteWorkspaceInfo[] }` |
| `remote_workspaces.create` | `{ hostId, remotePath, name? }` | `{ workspace }` |
| `remote_workspaces.get` | `{ id }` | `{ workspace }` |
| `remote_workspaces.update` | `{ id, name? }` | `{ workspace }` |
| `remote_workspaces.remove` | `{ id }` | `{ removedWorkspace, removedPlaceholder }` |
| `remote_workspaces.test` | `{ id }` | `{ ok, latencyMs?, exists?, type?, error? }` |
| `fs.list` | `{ linkedId?/remoteId?, path, limit?, offset? }` | `{ path, entries: RemoteEntry[], total, offset, limit, hasMore }` (default 500, max 5000). Listings are cached for 5 s for `offset > 0`; writes, mkdir, rename, move, delete, copy and transfers invalidate the cache. |
| `fs.read` | `{ linkedId?/remoteId?, path, maxBytes? }` | `FileRead` |
| `media.read` | `{ linkedId?/remoteId?, path }` | `{ path, size, mtime, mime, base64 }` (PNG/JPG/GIF/WebP/BMP/ICO/AVIF/SVG, max 24 MB) |
| `fs.write` | `{ linkedId?/remoteId?, path, content, expectedMtime?, createOnly? }` | `{ path, size, mtime }` (`createOnly: true`: existing target → 409) |
| `fs.stat` | `{ linkedId?/remoteId?, path }` | `{ path, relative, type, size, mtime, mode }` |
| `fs.mkdir` | `{ linkedId?/remoteId?, path, createOnly? }` | `{}` (`createOnly: true`: existing target → 409) |
| `fs.rename` | `{ linkedId?/remoteId?, from, to }` | `{}` |
| `fs.move` | `{ linkedId?/remoteId?, path, targetDir? }` | `{ path }` (same remote tree; collision → 409) |
| `fs.delete` | `{ linkedId?/remoteId?, path }` | `{}` |
| `fs.home` | `{ linkedId?/remoteId? }` | `{ home }` |
| `settings.get` | `{}` | `{ editorTheme, editorThemeFamily, editorThemeMode, fileOpenMode, autoSave }` |
| `settings.update` | `{ editorTheme?, editorThemeFamily?, editorThemeMode?, fileOpenMode?, autoSave? }` | `{ editorTheme, editorThemeFamily, editorThemeMode, fileOpenMode, autoSave }` |
| `local.browse` | `{ path? }` | `{ path, parent, home, entries: [{ name, path }] }` |
| `local.mkdir` | `{ path, name }` | `{ path }` (existing target → 409) |
| `linked.list` | `{}` | `{ links: LinkInfo[] }` (each link carries `running`) |
| `linked.create` | `{ hostId, remotePath, localPath, name?, mirror? }` | `{ link, workspaceId: string|null }` |
| `linked.update` | `{ id, name?, mirror?, ensureWorkspace? }` | `{ link }` (`ensureWorkspace: true` registers the local directory as a DSH workspace when it is not registered yet) |
| `linked.remove` | `{ id, removeWorkspace?, deleteLocalState? }` | `{ removedWorkspace, deletedLocalState }` |
| `linked.sync` | `{ id, maxFiles?, maxBytes? }` | `{ job: SyncJob }` (starts a background job) |
| `linked.syncStatus` | `{ id }` | `{ job: SyncJob | null }` |
| `linked.syncCancel` | `{ id }` | `{ cancelled: boolean }` |
| `local.list` | `{ path, limit?, offset? }` | `{ path, entries: [{ name, path, type, size, mtime }], total, offset, limit, hasMore }` |
| `local.openExternal` | `{ path }` | `{ opened, path }` |
| `terminal.open` | `{ linkedId?/remoteId?, side: 'remote'\|'local', path? }` | `{ opened, side, path, host? }` (`path` must stay inside the workspace; remote workspaces only support `side: 'remote'`) |
| `fs.openExternal` | `{ linkedId?/remoteId?, path }` | `{ opened, localPath, size }` |
| `localWorkspace.create` | `{ path, name? }` | `{ workspaceId, title, path }` |
| `session.info` | `{ sessionId }` | `{ sessionId, cwd, running }` |
| `skills.list` | `{ linkedId }` | `{ localPath, skills: [{ name, description, whenToUse, path, source }] }` |
| `skills.read` | `{ linkedId, name }` | `{ name, description, content, path }` |
| `git.status` | `{ linkedId?/remoteId?, side: 'remote'|'local' }` | `{ ok, repo, root, branch, changes, error? }` (remote workspaces only support `side: 'remote'`) |
| `fs.search` | `{ linkedId?/remoteId?, side, query, maxResults? }` | `{ ok, query, entries, truncated }` (matches **file names**, not contents; use `fs.grep` for contents) |
| `fs.grep` | `{ linkedId?/remoteId?, side, query, maxResults? }` | `{ ok, query, entries, truncated }` (searches file **contents**; local scans stop at 1 MB per file, 2000 files, 8 MB and 5 s; remote uses `grep -rIl`; max 1000 rows) |
| `fs.compare` | `{ linkedId?, path? }` | `{ path, relative, localPath, localMissing, counts: { onlyLocal, onlyRemote, changed, same }, onlyLocal, onlyRemote, changed, truncated, remoteTruncated, localTruncated, skippedLinks }` (linked workspaces only; excludes `.git`, `node_modules`, `.local`, `.remote`; 4000 files and depth 12 **per side**, 200 rows per group; `skippedLinks` counts symlinks and non-regular files) |
| `fs.pullToLocal` | `{ linkedId?, path, targetDir?, conflict? }` | `{ path, relative, size, mtime }` (linked workspaces only; single file, ≤64 MB; `targetDir` must stay inside the local root; `conflict` is `error` (default), `overwrite` or `unique`) |
| `fs.upload` | `{ linkedId?/remoteId?, path, paths, conflict? }` | `{ side: 'remote', target, files, bytes, skipped }` (≤50 local files, 64 MB each; `conflict` is `error` (default), `overwrite` or `unique`; a missing target directory is created) |
| `fs.transfer` | `{ linkedId?/remoteId?, path }` | `{ files, bytes, skipped, truncated, dest }` |
| `fs.download` | `{ linkedId?/remoteId?, path }` | `{ path, files, bytes, skipped, truncated }` |
| `fs.edit` | `{ linkedId?/remoteId?, path, app? }` | `{ localPath, size }` (opens Notepad/default app) |
| `fs.copy` | `{ linkedId?/remoteId?, path, targetDir? }` | `{ path, files }` |
| `fs.chmod` | `{ linkedId?/remoteId?, path, mode }` | stat |
| `local.read` | `{ path }` | `{ path, content, size, mtime, truncated, binary, tooLarge, editable }` |
| `local.media` | `{ path }` | `{ path, size, mtime, mime, base64 }` (max 24 MB) |
| `local.write` | `{ path, content, expectedMtime? }` | `{ path, size, mtime }` |
| `local.stat` | `{ path }` | `{ path, type, size, mtime, mode }` |
| `local.import` | `{ dir, paths }` | `{ dir, copied, skipped }` (copies OS files into `dir`, ≤50 files, 64 MB each) |
| `local.rename` | `{ from, to }` | `{ path }` |
| `local.move` | `{ path, targetDir?, root? }` | `{ path, type }` (same local tree; collision → 409) |
| `local.delete` | `{ path, root? }` | `{}` (recursive) |
| `local.copy` | `{ path, targetDir? }` | `{ path, type }` |
| `local.newFile` | `{ path }` | `{ path }` (existing target → 409) |
| `local.chmod` | `{ path, mode }` | `{ path, mode }` |
| `local.edit` | `{ path, app? }` | `{ path }` (opens Notepad) |

`fs.write` returns `CONFLICT` when `expectedMtime` differs (seconds precision).
`linked.create` creates the local directory, `.local/` (+ `session/`, README),
optional `.remote/`, writes `.local/linked.json`, and registers a DSH workspace
whose title is `⇄ <name>`.

## Persistence

Under `$DSH_HOME/linked-workspace/`:

- `linked.json` — linked workspaces (no credentials).
- `remote-workspaces.json` — remote workspaces (no credentials).
- `settings.json` — `{ editorTheme, editorThemeFamily, editorThemeMode, fileOpenMode, autoSave }`.
- `known_hosts.json` — trust-on-first-use host key fingerprints.
- `remote-placeholders/<uuid>/` — placeholder directories for remote workspaces.
- Local linked directories also hold `.local/linked.json` (same binding without
  secrets) and the optional `.remote/` mirror.

## Agent tools

`linked_workspace` (Host tool, JSON-Schema parameters) actions: `list`, `info`,
`list_dir`, `read`, `write`, `replace`, `stat`, `mkdir`, `rename`, `delete`,
`sync`. It resolves the workspace from the session working directory (a linked
local directory or a remote workspace placeholder) or from an explicit
`workspace` reference (id, local/placeholder path, or name), confines paths to
the remote root, and mirrors reads/writes into `.remote/` when a linked
workspace mirrors. `list` shows both kinds, labelled `(linked)` and `(remote)`;
`info` returns `kind: "linked" | "remote"` and `sync` is rejected for remote
workspaces.

`linked_skills` (Host tool) actions: `list`, `read` — local skills
(`~/.dsh/skills`, `~/.agents/skills`, `<local>/.dsh/skills`,
`<local>/.agents/skills`). For a remote workspace `<local>` is its placeholder
directory, so skills installed on the machine hosting the session still work.

## Client transport

```js
const url = new URL('dsh-linked-workspace/api', document.baseURI)
fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method, params }) })
```
