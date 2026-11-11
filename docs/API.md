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

Every `fs.*` method takes a scope: either `{ workspaceId }` (a direct remote
directory) or `{ linkedId }` (a linked workspace's remote root). Paths are
relative to the scope root, or absolute inside it.

## Methods

| method | params | data |
| --- | --- | --- |
| `hosts.list` | `{ refresh? }` | `{ hosts: HostInfo[] }` |
| `hosts.browse` | `{ hostId, path? }` | `{ path, parent, home, entries }` (dirs + files) |
| `workspaces.list` | `{}` | `{ workspaces: WorkspaceInfo[] }` |
| `workspaces.add` | `{ hostId, remotePath, name? }` | `{ workspace }` |
| `workspaces.remove` | `{ id }` | `{}` |
| `workspaces.rename` | `{ id, name }` | `{ workspace }` |
| `workspaces.test` | `{ id }` | `{ ok, latencyMs?, resolvedPath?, error? }` |
| `fs.list` | `{ workspaceId?/linkedId?, path, limit?, offset? }` | `{ path, entries: RemoteEntry[], total, offset, limit, hasMore }` (default 500, max 5000) |
| `fs.read` | `{ workspaceId?/linkedId?, path, maxBytes? }` | `FileRead` |
| `media.read` | `{ workspaceId?/linkedId?, path }` | `{ path, size, mtime, mime, base64 }` (PNG/JPG/GIF/WebP/BMP/ICO/AVIF/SVG, max 24 MB) |
| `fs.write` | `{ workspaceId?/linkedId?, path, content, expectedMtime?, createOnly? }` | `{ path, size, mtime }` (`createOnly: true`: existing target → 409) |
| `fs.stat` | `{ workspaceId?/linkedId?, path }` | `{ path, relative, type, size, mtime, mode }` |
| `fs.mkdir` | `{ workspaceId?/linkedId?, path, createOnly? }` | `{}` (`createOnly: true`: existing target → 409) |
| `fs.rename` | `{ workspaceId?/linkedId?, from, to }` | `{}` |
| `fs.move` | `{ workspaceId?/linkedId?, path, targetDir? }` | `{ path }` (same remote tree; collision → 409) |
| `fs.delete` | `{ workspaceId?/linkedId?, path }` | `{}` |
| `fs.home` | `{ workspaceId?/linkedId? }` | `{ home }` |
| `settings.get` | `{}` | `{ editorTheme, editorThemeFamily, editorThemeMode, fileOpenMode, autoSave }` |
| `settings.update` | `{ editorTheme?, editorThemeFamily?, editorThemeMode?, fileOpenMode?, autoSave? }` | `{ editorTheme, editorThemeFamily, editorThemeMode, fileOpenMode, autoSave }` |
| `local.browse` | `{ path? }` | `{ path, parent, home, entries: [{ name, path }] }` |
| `local.mkdir` | `{ path, name }` | `{ path }` (existing target → 409) |
| `linked.list` | `{}` | `{ links: LinkInfo[] }` (each link carries `running`) |
| `linked.create` | `{ hostId, remotePath, localPath, name?, mirror? }` | `{ link, workspaceId: string|null }` |
| `linked.update` | `{ id, name?, mirror? }` | `{ link }` |
| `linked.remove` | `{ id, removeWorkspace?, deleteLocalState? }` | `{ removedWorkspace, deletedLocalState }` |
| `linked.sync` | `{ id, maxFiles?, maxBytes? }` | `{ job: SyncJob }` (starts a background job) |
| `linked.syncStatus` | `{ id }` | `{ job: SyncJob | null }` |
| `linked.syncCancel` | `{ id }` | `{ cancelled: boolean }` |
| `local.list` | `{ path, limit?, offset? }` | `{ path, entries: [{ name, path, type, size, mtime }], total, offset, limit, hasMore }` |
| `local.openExternal` | `{ path }` | `{ opened, path }` |
| `terminal.open` | `{ workspaceId?/linkedId?, side: 'remote'\|'local' }` | `{ opened, side, path, host? }` |
| `fs.openExternal` | `{ workspaceId?/linkedId?, path }` | `{ opened, localPath, size }` |
| `localWorkspace.create` | `{ path, name? }` | `{ workspaceId, title, path }` |
| `session.info` | `{ sessionId }` | `{ sessionId, cwd, running }` |
| `skills.list` | `{ linkedId }` | `{ localPath, skills: [{ name, description, whenToUse, path, source }] }` |
| `skills.read` | `{ linkedId, name }` | `{ name, description, content, path }` |
| `git.status` | `{ workspaceId?/linkedId?, side: 'remote'|'local' }` | `{ ok, repo, root, branch, changes, error? }` |
| `fs.search` | `{ workspaceId?/linkedId?, side, query, maxResults? }` | `{ ok, query, entries, truncated }` |
| `fs.transfer` | `{ workspaceId?/linkedId?, path }` | `{ files, bytes, skipped, truncated, dest }` |
| `fs.download` | `{ workspaceId?/linkedId?, path }` | `{ path, files, bytes, skipped, truncated }` |
| `fs.edit` | `{ workspaceId?/linkedId?, path, app? }` | `{ localPath, size }` (opens Notepad/default app) |
| `fs.copy` | `{ workspaceId?/linkedId?, path, targetDir? }` | `{ path, files }` |
| `fs.chmod` | `{ workspaceId?/linkedId?, path, mode }` | stat |
| `local.read` | `{ path }` | `{ path, content, size, mtime, truncated, binary, tooLarge, editable }` |
| `local.media` | `{ path }` | `{ path, size, mtime, mime, base64 }` (max 24 MB) |
| `local.write` | `{ path, content, expectedMtime? }` | `{ path, size, mtime }` |
| `local.stat` | `{ path }` | `{ path, type, size, mtime, mode }` |
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

- `workspaces.json` — direct remote directories (no credentials).
- `linked.json` — linked workspaces (no credentials).
- `settings.json` — `{ editorTheme, editorThemeFamily, editorThemeMode, fileOpenMode, autoSave }`.
- `known_hosts.json` — trust-on-first-use host key fingerprints.
- Local linked directories also hold `.local/linked.json` (same binding without
  secrets) and the optional `.remote/` mirror.

## Agent tool

`linked_workspace` (Host tool, JSON-Schema parameters) actions: `list`, `info`,
`list_dir`, `read`, `write`, `replace`, `stat`, `mkdir`, `rename`, `delete`,
`sync`. It resolves the linked workspace from the session working directory (or
an explicit `workspace` reference), confines paths to the remote root, and
mirrors reads/writes into `.remote/` when the workspace mirrors.

## Client transport

```js
const url = new URL('dsh-linked-workspace/api', document.baseURI)
fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ method, params }) })
```
