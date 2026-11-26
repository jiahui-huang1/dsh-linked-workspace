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
| `docs.read` | `{ path, linkedId?, remoteId? }` | kind-specific document model |
| `docs.text` | `{ path, linkedId?, remoteId?, maxChars? }` | `{ kind, path, size, mtime, pageCount?, text, truncated }` (plain text out of PDF / Word / Excel / PowerPoint; `maxChars` is clamped to 1000–200000, default 40000) |
| `docs.write` | `{ path, data, expectedMtime?, linkedId?, remoteId? }` | `{ kind, path, size, mtime }` |
| `docs.create` | `{ path, kind?, linkedId?, remoteId? }` | `{ kind, path, size, mtime }` |
| `docs.mdPreview` | `{ path, text?, linkedId?, remoteId? }` | `{ kind: 'markdown-preview', html }` (rendered in-process; the fragment carries the KaTeX stylesheet and expects the plugin's `/dsh-linked-workspace/assets/katex/` fonts; the last 3 renders are cached by content hash) or `{ kind: 'markdown-preview-too-large', chars \| bytes, limit }` for a document above 512 Ki characters — the viewer must show the editor instead |
| `docs.mdPdf` | `{ path, text?, linkedId?, remoteId? }` | `{ kind: "pdf", path, size, mtime }` |

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
| `hosts.list` | `{ refresh? }` | `{ hosts: HostInfo[] }` (`HostInfo` carries `authType`, `hasCredential`, `hasStoredPassword`) |
| `hosts.credentials` | `{ hostId, password?, passphrase?, privateKey?, clear? }` | `{ hostId, authType, hasCredential, hasStoredPassword }` (stores the secret in the plugin's own `ssh-credentials.json`; `clear: true` deletes it) |
| `hosts.browse` | `{ hostId, path? }` | `{ path, parent, home, entries }` (dirs + files) |
| `hosts.df` | `{ hostId, path? }` | `{ disk: { path, size, used, avail, percent } \| null }` (free space of the volume holding `path`; defaults to the login home) |
| `hosts.hostKeys` | `{}` | `{ entries: [{ authority, fingerprint, firstSeen, hostId?, hostName? }] }` — the keys remembered in `known_hosts.json`; `hostId` is filled in when the authority still matches a configured host |
| `hosts.forgetHostKey` | `{ hostId?/authority? }` | `{ authority, removed }` — drops the stored key (and the live connection) so the next connect trusts the host again; `settings.hostKeyPolicy` decides whether an unknown key is accepted (`tofu`, default) or refused (`strict`) |
| `hosts.status` | `{ hostIds? }` | `{ statuses: { [hostId]: { state, reason?, message?, latencyMs?, checkedAt? } } }` (in-memory snapshot of the pool, never dials; an `error` older than 60 s is reported as `idle`; defaults to every known host of the host list plus every workspace's host id) |
| `fs.readOutside` | `{ linkedId?, remoteId?, path, maxBytes? }` | `{ path, size, mtime, binary, truncated, content }` (only under an `extraRoots` prefix; audited) |
| `fs.writeOutside` | `{ linkedId?, remoteId?, path, content, ifModifiedSince? }` | `{ path, size, mtime, created }` (8 MB limit; only under an `extraRoots` prefix; audited) |
| `fs.listOutside` | `{ linkedId?, remoteId?, path }` | `{ path, entries }` (only under an `extraRoots` prefix; audited) |
| `hosts.forward` | `{ hostId, remotePort, remoteHost?, localPort? }` | `{ forward: { id, hostId, hostName, remoteHost, remotePort, localPort, startedAt, url } }` (localhost TCP tunnel; reuses an identical one; the definition is written to `forwards.json`, so a restarted Host re-binds the same port) |
| `hosts.forwards` | `{}` | `{ forwards: [...] }` — a tunnel that could not get its port back after a restart is listed with `localPort: 0`, `url: ""` and an `error`; Stop removes it |
| `hosts.unforward` | `{ id }` | `{ removed }` |
| `hosts.reconnect` | `{ hostId }` | `{ hostId, state, reason?, message?, latencyMs?, checkedAt? }` (drops the pooled socket and dials again; returns the resulting status instead of throwing, so the UI can show the reason) |
| `hosts.mkdir` | `{ hostId, path?, name }` | `{ path }` (creates `name` inside `path`; defaults to the login home; `409`/`FS_EXISTS` when it already exists) |
| `hosts.exec` | `{ hostId?/linkedId?/remoteId?, command, cwd?, timeoutMs? }` | `{ hostId, hostName, workspaceId, kind, command, cwd, exitCode, stdout, stderr, stdoutBytes, stderrBytes, truncated, durationMs, startedAt, auditId }` — runs **one** non-interactive command on the remote host. Three gates: `settings.execEnabled` must be `true`, the host must be in `settings.execHostIds`, and — when `settings.execWorkspaceIds` is non-empty — the workspace must be in it. Refusals are audited too and answer `403` (`EXEC_DISABLED` / `EXEC_HOST_NOT_ALLOWED` / `EXEC_WORKSPACE_NOT_ALLOWED`); a timeout answers `504` `EXEC_TIMEOUT`, other failures `502` `EXEC_FAILED`. Output is clipped to `settings.execMaxOutputChars` per stream (default 200000, head+tail). `cwd` is resolved inside the workspace root and may not escape it. Output is decoded with `settings.outputEncoding` (`utf8` by default, `gbk` for Chinese Windows remotes). |
| `remote_workspaces.list` | `{}` | `{ workspaces: RemoteWorkspaceInfo[] }` |
| `remote_workspaces.create` | `{ hostId, remotePath, name? }` | `{ workspace }` |
| `remote_workspaces.get` | `{ id }` | `{ workspace }` |
| `remote_workspaces.update` | `{ id, name? }` | `{ workspace }` |
| `remote_workspaces.remove` | `{ id }` | `{ removedWorkspace, removedPlaceholder }` |
| `remote_workspaces.test` | `{ id }` | `{ ok, latencyMs?, exists?, type?, error? }` (a missing directory comes back as `exists: false` and leaves the host's connection state untouched) |
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
| `meta.info` | `{}` | `{ version, apiRevision, startedAt, listings }` (the client warns when `apiRevision` is older than its own, i.e. DSH still runs an older copy of this plugin; `listings` is a counter that every mutation bumps, so the panel can notice changes made elsewhere) |
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
| `local.openUrl` | `{ url }` | `{ opened, url }` (only `http:`, `https:`, `mailto:` and `tel:`; the preview hands external links here instead of navigating — anything else is `BAD_REQUEST`) |
| `terminal.open` | `{ linkedId?/remoteId?, side: 'remote'\|'local', path? }` | `{ opened, side, path, host? }` (`path` must stay inside the workspace; remote workspaces only support `side: 'remote'`) |
| `fs.openExternal` | `{ linkedId?/remoteId?, path }` | `{ opened, localPath, size }` |
| `localWorkspace.create` | `{ path, name? }` | `{ workspaceId, title, path }` |
| `session.info` | `{ sessionId }` | `{ sessionId, cwd, running }` |
| `skills.list` | `{ linkedId }` | `{ localPath, skills: [{ name, description, whenToUse, path, source }] }` |
| `skills.read` | `{ linkedId, name }` | `{ name, description, content, path }` |
| `git.status` | `{ linkedId?/remoteId?, side: 'remote'|'local' }` | `{ ok, repo, root, branch, changes, error? }` (remote workspaces only support `side: 'remote'`) |
| `fs.search` | `{ linkedId?/remoteId?, side, query, maxResults? }` | `{ ok, query, entries, truncated }` (matches **file names**, not contents; use `fs.grep` for contents) |
| `fs.grep` | `{ linkedId?/remoteId?, side, query, maxResults?, path?, ignoreCase?, regex?, includeIgnored?, resultMode?, maxFiles?, maxFileBytes?, timeoutMs?, jobId? }` | `{ ok, query, entries: [{ path, relative, size, line, preview, matches }], truncated, truncatedReason, scannedFiles, scannedBytes, skippedFiles }` (searches file **contents**; `path` narrows the scan to a sub-folder; `ignoreCase` defaults to `true`; `regex` treats `query` as a regular expression; `includeIgnored: true` also walks usually ignored folders such as `node_modules`/`.venv`/`dist` (`.git`/`.hg`/`.svn` always stay out); `resultMode: 'files'` lists file names only (`line: 0`, empty `preview`, `matches` = hit count); `maxFiles` (default 2000), `maxFileBytes` (default 1 MB) and `timeoutMs` (default 5 s, max 10 s) raise or lower the sweep; limits are 1 MB per file, 2000 files, 8 MB and 5 s for both sides, and `truncatedReason` is one of `files`, `bytes`, `deadline`, `results`, `cancelled`; max 1000 rows) |
| `fs.grepCancel` | `{ jobId }` | `{ cancelled }` (marks the job started by `fs.grep`'s `jobId`; the Host checks it between files and answers `truncatedReason: 'cancelled'`) |
| `linked.plan` | `{ id, maxFiles? }` | `{ linkedId, localPath, remotePath, added, changed, conflict, removed, unchanged, pending, truncated, skipped, maxFiles }` (each entry carries `relative`, `size`, `localHash`, `remoteHash`; a file that moved on both sides since the last push lands in `conflict`) |
| `linked.push` | `{ id, paths?, dryRun?, conflict?, jobId? }` | `{ linkedId, dryRun, conflict, files, pushed, skipped, conflictsLeft, bytes, cancelled }` (`conflict` is `skip` by default; every file is written as a temporary file and renamed into place; `paths` entries may be files or folders — a folder matches everything under it — and every planned entry carries `localMtime` / `remoteMtime`) |
| `linked.pushCancel` | `{ jobId }` | `{ cancelled }` (stops after the file being written) |
| `transfer.history` | `{}` | `{ entries: [{ kind: "transfer" \| "push", direction?, linkedId?, files, bytes, skipped, truncated?, at }] }` (newest first, at most 50) |
| `linked.lastArtifact` | `{ sessionId }` | `{ artifact: { path, at } \| null }` (the file the chat presented most recently in that session; in memory, cleared on restart) |
| `linked.sessionScope` | `{ sessionId }` | `{ scope: { linkedId?, remoteId?, root, cwd } \| null }` (resolves which linked/remote workspace a session belongs to by matching the registry path against every record; session ids are compared with or without the `session-` prefix. The `@` picker calls this instead of guessing from the agent context, which only carries `sessionId`) |
| `fs.references` | `{ linkedId?/remoteId?, query, limit?, includeIgnored?, side? }` | `{ ok, query, candidates: [{ path, relative, name, kind }], total, truncated, scannedEntries }` (path completion for `@`-style references: matches the **path**, case-insensitive, best match first — exact name, then prefix, then substring; `limit` defaults to 50 and caps at 200; walking stops after 20000 entries or 3 s; `side: 'local'` searches the local tree of a linked workspace. **An empty `query` returns no candidates**, and a full tree walk takes 5–20 s on a real remote, so the `@` picker no longer uses this method — it lists one directory at a time by calling `fs.list` with the parent path) |
| `fs.compare` | `{ linkedId?, path? }` | `{ path, relative, localPath, localMissing, counts: { onlyLocal, onlyRemote, changed, same }, onlyLocal, onlyRemote, changed, truncated, remoteTruncated, localTruncated, skippedLinks }` (linked workspaces only; excludes `.git`, `node_modules`, `.local`, `.remote`; 4000 files and depth 12 **per side**, 200 rows per group; `skippedLinks` counts symlinks and non-regular files) |
| `fs.pullToLocal` | `{ linkedId?, path, targetDir?, conflict? }` | `{ path, relative, size, mtime }` (linked workspaces only; single file, ≤64 MB; `targetDir` must stay inside the local root; `conflict` is `error` (default), `overwrite` or `unique`) |
| `fs.upload` | `{ linkedId?/remoteId?, path, paths, conflict? }` | `{ side: 'remote', target, files, bytes, skipped }` (≤50 local files, 64 MB each; `conflict` is `error` (default), `overwrite` or `unique`; a missing target directory is created) |
| `fs.transfer` | `{ linkedId?/remoteId?, path, paths?, jobId? }` | `{ files, bytes, skipped, truncated, dest }` (with `jobId` the run is tracked and can be polled/cancelled) |
| `fs.transferProgress` | `{ jobId }` | `{ job: { id, files, bytes, skipped, state, cancelled, reason } \| null }` (`state` is `running`, `done`, `cancelled` or `failed`; jobs are dropped after 5 minutes) |
| `fs.transferCancel` | `{ jobId }` | `{ cancelled }` (asks the running transfer to stop; it finishes the file in flight, then reports `CANCELLED`) |
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
- `forwards.json` — `{ version, forwards: [{ id, hostId, hostName, remoteHost, remotePort, localPort, startedAt }] }`. Since 0.25.0 the tunnels opened from 设置 → 端口转发 are standing arrangements: the listener is re-bound on start (with a new local port if the old one is taken, and the record updated), and only `hosts.unforward` removes an entry.
- `settings.json` — `{ editorTheme, editorThemeFamily, editorThemeMode, fileOpenMode, autoSave, execEnabled, execHostIds, execWorkspaceIds, execTimeoutMs, execMaxOutputChars, execShell, hostKeyPolicy, outputEncoding, extraRoots, revealSide }`. `revealSide` is `"remote"` (default) or `"local"`: which tree the **Locate last artifact** button opens a chat artifact in for a linked workspace. Remote workspaces always use the remote tree. The four `autoPush*` keys are still accepted so an old file loads unchanged, but since 0.24.0 auto push is configured per workspace (`linked.json` → each record's `autoPush`), and those keys no longer drive any watcher.
- `linked.json` — every record carries `autoPush: { enabled, debounceMs, include[], exclude[] }` (`debounceMs` clamped to 300–60000, default 1500). `linked.list` returns it, `linked.update { id, autoPush }` writes it, and the Host starts/stops one `fs.watch` per enabled workspace.
  The exec keys are off unless you turn them on: `execEnabled` defaults to
  `false`, `execHostIds` (host allow-list) starts empty, and
  `execWorkspaceIds` is an optional second layer where an empty list means
  "every workspace on an allowed host".
- `exec-audit.jsonl` — one JSON line per `hosts.exec` attempt (accepted or  refused): `{ ts, auditId, hostId, hostName, workspaceId, kind, command, cwd?,
  exitCode?, durationMs?, stdoutBytes?, stderrBytes?, truncated?, stdoutHead?,
  stderrHead?, refusal?, message? }`. Rotated to `exec-audit.jsonl.1` past 5 MB.
  `meta.info` returns its absolute path as `execAuditFile` so the settings page
  can open it.
- `known_hosts.json` — trust-on-first-use host key fingerprints, readable through
  `hosts.hostKeys` and prunable one authority at a time with `hosts.forgetHostKey`.
  With `settings.hostKeyPolicy: "strict"` an unknown key is refused instead of
  trusted (`409` `HOST_KEY_UNKNOWN`) — see the SSH trust section in the settings page.
- `ssh-credentials.json` — `{ version, byHostId: { <hostId>: { password?, privateKey?, passphrase? } } }`,
  written by `hosts.credentials` with mode `0600`. Hosts listed in `~/.ssh/config`
  without an `IdentityFile` can be paired with a password here, so the plugin does
  not need `dsh-ssh-tunnel` for password logins.
- `remote-placeholders/<uuid>/` — placeholder directories for remote workspaces.
- Local linked directories also hold `.local/linked.json` (same binding without
  secrets) and the optional `.remote/` mirror.

## Agent tools

`linked_workspace` (Host tool, JSON-Schema parameters) actions: `list`, `info`,
`list_dir`, `read`, `write`, `replace`, `stat`, `mkdir`, `rename`, `delete`,
`sync`, `exec`, `references`. It resolves the workspace from the session working directory (a linked
local directory or a remote workspace placeholder) or from an explicit
`workspace` reference (id, local/placeholder path, or name), confines paths to
the remote root, and mirrors reads/writes into `.remote/` when a linked
workspace mirrors. `list` shows both kinds, labelled `(linked)` and `(remote)`;
`info` returns `kind: "linked" | "remote"` and `sync` is rejected for remote
workspaces. `exec` takes `command` (≤ 8000 characters), an optional `cwd`
(inside the workspace root) and `timeout_ms`, and refuses unless the switches
described under `hosts.exec` are on. `references` takes `query` (≤ 200
characters) and an optional `limit`, and lists matching paths best-match first
(directories marked `dir`) — that is how the model resolves a remote path a user
mentioned by name. The `@` completion popup itself is **not** extensible: the
Host `fileReferences` service only exposes `list(agent, query, signal)` and has
no provider registration, so remote candidates cannot be injected into it; use
the action or the sidebar's “Copy as @ reference”.

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
