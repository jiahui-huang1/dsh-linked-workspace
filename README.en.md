# dsh-linked-workspace

English · [简体中文](README.md)

Turn existing SSH connections into **remote directories** or **linked workspaces** in DeepSeek Harness:

- **Remote directory**: Settings → Connections → Add remote directory. Pick a host and a remote folder, then browse and read its files from the right sidebar. Remote-directory views are **read-only**.
- **Linked workspace**: Add a workspace (or Settings → Connections → Create linked workspace) to pair a **local folder** with a **remote folder**. The local folder becomes a real DSH workspace; sessions in it read and edit remote files through the `linked_workspace` tool. The remote host only needs SSH, not a DSH plugin. The right sidebar shows both trees: remote on top, local below.

> Built for DSH 0.2.1-rc.4. Sidebar pages require `dsh-better-sidebar` (v0.24+). Without it the plugin still loads (Settings works), but sidebar entries are unavailable.

## Features

### Connections and settings (Settings → Connections)

- SSH hosts come from the `dsh-ssh-tunnel` SSH Manager (`~/.dsh/ssh-tunnel/hosts.json`) and from `~/.ssh/config`. Passwords and private keys stay inside the Host process and are never returned to the page or the model.
- Remote-directory list: add (host + remote folder browser), test, open, remove.
- Linked-workspace list: local ⇄ remote paths, mirror switch (**off by default**), background sync (archive into `.remote`, show file count/size progress, cancellable), remove (optionally remove the DSH workspace and delete `.local`/`.remote`). With mirroring enabled, the first check runs immediately, then **every 5 minutes**: download new/changed files, remove mirror files that no longer exist remotely, skip unchanged files (`.local/mirror-manifest.json`), and exclude `.git`/`node_modules`/cache folders. With mirroring off, both sides may differ freely.
- **Editor themes**: appearance modes **System / Light / Dark** (default System, following DSH); nine theme families (GitHub, Solarized, One, Dracula, Monokai, Nord, VS Code, Xcode, Catppuccin), each with light and dark variants on one card. The preview follows the selected mode.
- Remote-directory and linked-workspace creation share one form.
- File-open behavior (editor / system default app / copy path) is selected from the sidebar toolbar and persisted.
- The Settings → Connections page has **Create linked workspace** and **Add remote directory** actions; the old “Open sidebar” button is gone.

### Add workspace

The plugin takes over the directory-selection hole used by the DSH sidebar and empty-session hero. The dialog has two tabs:

1. **Local workspace**: enter or browse for a local directory (C:/D:/E: drive chips on Windows), set a workspace name, then create a normal DSH workspace.
2. **Linked workspace**: SSH host + remote folder + local folder + optional mirror. Creating it also registers the local folder as a DSH workspace. The local directory is **not** pre-populated with `.local`/`.remote`; those are created lazily when mirroring or transfers need them.

### Document editing

The content panel now edits **Markdown / PDF / DOCX / XLSX / PPTX** files on both local and remote sides:

- **Markdown**: raw editing, rendered preview, export to PDF.
- **DOCX**: edit paragraph and table text; paragraph styles are kept, complex inline formatting may be simplified.
- **XLSX**: switch sheets and edit a cell grid; untouched formulas and styles are preserved.
- **PPTX**: navigate slides and edit text frames.
- **PDF**: page navigation, rotate/delete pages, and title/author metadata; pages are rendered by PyMuPDF.
- Create blank documents from the directory context menu by using one of these extensions.
- Office/PDF operations need Python 3 with `python-docx`, `openpyxl`, `python-pptx` and `PyMuPDF`; Markdown does not. Set `DSH_OFFICE_PYTHON` to choose an interpreter.

### Right-sidebar entries

- **Linked workspace directory**: appears only in sessions of a linked workspace, and opens the linked workspace bound to that session. Remote and local files are editable.
- **Remote directories**: available in any workspace session once at least one remote directory is configured. Browsing and files are **read-only**; editing, transfers, rename/delete and other mutations are disabled.
- Both entries are opened from the right-sidebar start page. Non-linked sessions do not show the linked-workspace entry.

### Right-sidebar linked-workspace directory

- The directory is a fixed panel at the far right of the sidebar: **remote tree on top, local tree below**, both rooted at “All files”. Plugin internals (`.local`/`.remote`) are hidden by default but can be shown with the hidden-files toggle.
- **Single click opens, double click pins**: clicking a folder expands/collapses it immediately; clicking a file opens it in the content panel, and clicking another file replaces the current unpinned preview tab. Double-click a file to pin its tab so later single clicks do not replace it; double-clicking a folder only keeps it expanded.
- **Layout**: conversation → content panel (internal file tabs) → directory panel. The content panel shows “Open a file / Select a file from the workspace directory tree” when nothing is open. A toolbar button shows/hides the directory panel.
- Toolbar:
  - **Tree switch**: all files / changed files / all changes (git status from remote and local sides).
  - **Search in files**: at least two characters; remote uses `find`, local walks the tree. Results are grouped by remote/local.
  - **Open options menu**: editor / system default app / copy path.
  - **Open terminal**: the remote button in the remote tree toolbar opens the system terminal and SSHes into the current remote directory; linked workspaces also show a local button that opens a terminal in the local directory. The remote terminal uses the system `ssh` client, so it may ask for a password or host-key confirmation.
  - **Transfer**: bidirectional. Select a remote file/folder to copy it into the local `.remote/` folder; select a local file/folder to copy it to the corresponding relative remote path. Jobs run one at a time through a queue.
  - **Show/hide hidden files**: applies to both trees.
  - **Refresh**: reload roots, git status and search.
- File-type icons for JS/TS/Python/JSON/Markdown/Shell/YAML/images/archives/config files, etc.
- Editor: line numbers, syntax highlighting (layered rendering), theme colors, `Ctrl/Cmd+S` save, conflict prompt (reload/force save), read-only protection for binary and >2 MB files, UTF-8/LF/CRLF/line-count status bar. The embedded content panel hides the path/save header; unsaved changes show a gray dot in the file tab. Read-only tabs render the file content but cannot be edited or saved.
- **Image, CSV and HTML preview**: PNG/JPG/GIF/WebP/BMP/ICO/AVIF/SVG render directly in the content panel (up to 24 MB) with toolbar zoom, `Ctrl/Cmd + wheel` zoom, fit-to-window and 1:1 actual-size controls. CSV/TSV opens as a table by default with a Table/Source toggle; the source view remains editable and saveable. Tables are capped at 1000 rows and 80 columns. HTML/HTM files render in a sandboxed iframe with scripts disabled.
- **Shortcuts**: `Ctrl/Cmd+S` saves the current file; `Ctrl/Cmd+W` closes the current tab (with a save/discard/cancel prompt when dirty); `Ctrl+Tab` / `Shift+Ctrl+Tab` cycles tabs; `Ctrl/Cmd+B` toggles the directory panel; `Ctrl/Cmd+Shift+F` opens file search.
- **Auto save**: enable it under Settings → Connections → Editor behavior. It saves about one second after you stop typing. When off, use `Ctrl+S`. Closing a dirty file always asks first instead of discarding silently.
- Multiple files can be open at once (up to 12 slots). A single click opens a preview tab and replaces the current unpinned preview; double-click pins the tab; clicking the same file focuses its existing tab. Local files use the same internal editor and can be edited and saved.

### Running indicator and local skills

- When a linked workspace has a running session, its link icon turns **blue** in the left workspace list (polled about every 5 seconds).
- Linked sessions run in the **local directory**, so local skills (`~/.dsh/skills`, `~/.agents/skills`, `<local>/.dsh/skills`, `<local>/.agents/skills`) are available without installing them on the remote host. The model can use `linked_skills` to `list`/`read` them, and the system prompt explains this.

### Context menu (files, folders, roots)

Transfer (download to `.remote` / upload to remote), download to the default folder, queue, open, edit with Notepad, copy, paste, copy path, **Move to…** (only within the same local or remote tree), rename, delete, change permissions, new folder/file, properties. Remote operations use SFTP; local operations use the local filesystem. The transfer queue runs one job at a time.

### Linked-workspace layout

```
<local>/
  .local/                  # created lazily (mirror manifest when needed)
    mirror-manifest.json
  .remote/                  # optional: remote mirror archive
```

The remote side is not modified by mirroring. The `linked_workspace` tool supports `list`, `info`, `list_dir`, `read`, `write`, `replace`, `stat`, `mkdir`, `rename`, `delete`, and `sync` (start a background mirror job). `path` is relative to the remote root (or an absolute path inside it). Writes are atomic and support `if_modified_since` optimistic concurrency. The workspace is resolved from the session cwd; use the `workspace` parameter to target another linked workspace.

## Screenshots

[![Settings → Connections](https://github.com/jiahui-huang1/dsh-linked-workspace/raw/main/docs/screenshots/settings-connections.png)](https://github.com/jiahui-huang1/dsh-linked-workspace/blob/main/docs/screenshots/settings-connections.png)

[![Linked workspace directory: remote on top, local below](https://github.com/jiahui-huang1/dsh-linked-workspace/raw/main/docs/screenshots/linked-directories.png)](https://github.com/jiahui-huang1/dsh-linked-workspace/blob/main/docs/screenshots/linked-directories.png)

[![Open a file in the content panel](https://github.com/jiahui-huang1/dsh-linked-workspace/raw/main/docs/screenshots/file-editor.png)](https://github.com/jiahui-huang1/dsh-linked-workspace/blob/main/docs/screenshots/file-editor.png)

## Installation

```bash
dsh plugin --profile web add dsh-linked-workspace
```

Install from source (development):

```bash
dsh plugin --profile "$DSH_PROFILE" add "file:$PWD/dsh-linked-workspace"
```

Or use `plugin_manager` → `install_bundle` with the absolute path of this directory. Restart the DSH desktop app after installing (new Host plugins load at process start; session history is preserved). Then:

1. Account menu → Settings → **Connections**;
2. Or use the workspace “Add workspace” button and choose the linked-workspace tab.

## Upgrading from 0.2.x

Since 0.3.0 the plugin is named `dsh-linked-workspace`. On first start after installing the new package, the old `$DSH_HOME/remote-workspace` data directory is migrated to `$DSH_HOME/linked-workspace` (remote directories, linked workspaces, theme settings and known host fingerprints are preserved). The old `dsh-remote-workspace` package can then be uninstalled.

Old “Remote directories” tabs are restored after refresh through hidden legacy tab-type aliases; their titles are updated to “Linked workspace directory”, while new tabs use the new type.

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

### 0.8.3

Follow-up fixes to the 0.8.2 paging and preview work (second review round):

- Document previews now also drop inline `style` attributes, so a `position:fixed` overlay can no longer cover the whole app and impersonate a login page (click-jacking/phishing surface).
- Tree refreshes (the local tree every 4 s) re-request only the entries already loaded, so “Load more” results are no longer reset to the first page.
- With hidden files toggled, “Load more” uses the true server offset: entries are neither duplicated nor skipped, and the “N left” label is computed from that offset.
- `fs.list` gained a 5-second listing cache: paging reads the directory once, and any write, mkdir, rename, move, delete, copy or transfer invalidates it.
- A directory copy that fails midway removes the partial copy and reports `FS_INCOMPLETE`; `FS_TOO_LARGE` is now reserved for real size limits.
- Concurrent first connects are keyed by host *and* address, so an address change cannot hand the old connection to the new request, and replaced connections are released.
- The right-sidebar tree source de-duplicates in-flight loads instead of issuing the same request twice.
- Directory pickers render at most 500 entries and suggest typing the path; PDF export stops after 999 name suffixes with an explicit error instead of looping forever.
- Tests: two self-inconsistent assertions in `test/host-api.mjs` were fixed (a leftover folder made a later create return 409, and an existing name was expected to return 400); all 28 steps now pass.

### 0.8.2

Security, data-integrity and large-directory fixes from the three-day review round:

- The document-preview sanitizer normalizes control characters, whitespace and zero-width characters before checking a URL scheme, so `jav\tascript:`, `vbscript:`, `file:` and `data:text/html` links no longer run in the GUI; only `http(s)`, `mailto`, `tel`, relative URLs and bitmap `data:image` sources are kept.
- Windows junctions can no longer escape the `.remote` containment check (`realpathSync.native`); linked `.local`/`.remote` entries are removed as links, never followed.
- Copying a remote file over 64 MB, or reading one incompletely, now fails loudly instead of writing a truncated copy; the read tool no longer mirrors truncated payloads.
- `local.read` reads only the requested head instead of loading the whole file into memory.
- The `linked_workspace` `delete` action removes non-empty directories recursively.
- Directory listings are paged (500 by default, 5000 max, with `total`/`hasMore`) and both trees render a “Load more” row, so a 20,000-entry folder no longer freezes the UI.
- Mirror sync marks a job truncated at the depth limit instead of reporting success with files missing.
- Accessibility: `:focus-visible` rings, `treeitem`/`aria-level`/`aria-expanded` semantics, `←`/`→` collapse and expand, and an add-workspace dialog that focuses its first field, traps Tab and closes on Escape.
- Excel previews report `totalRow`/`totalCol`/`truncated` and note when the grid shows only the first 200 rows × 40 columns or the first 20 worksheets.
- The client build fails when a `src/parts/*` file is missing; the dead `linked.update` branch is gone; `HostPool` reuses one in-flight connection per host.

### 0.7.0

Single-click tree navigation with preview tabs and double-click pinning, remote/local terminal buttons with `cd`, VSCode-like shortcuts, unsaved-close prompts, and an auto-save switch under Settings → Connections.

### 0.6.2

Fix Windows GBK JSON transport errors for Markdown characters such as the superscript minus; PDF pages now load lazily and the source PDF is cached, avoiding long loading hangs on large files.

### 0.6.1

Fix the linked-workspace directory tab and start-page entry disappearing in a new blank linked-workspace session by consulting the client session store for cwd and workspaceId first.

### 0.5.13

The directory panel divider is draggable (double-click resets to 300 px; width persists). The local tree refreshes silently every 4 seconds and on window focus, so new local subdirectories appear without a manual refresh.

## Releases and marketplace updates

- The npm package is `dsh-linked-workspace`. To release, bump `package.json` and push a `v*` tag; `.github/workflows/release.yml` runs `npm publish --access public` (set an `NPM_TOKEN` repository secret).
- awesome-dsh-plugin (the DSH community market) reads the npm latest version and repository metadata, so published upgrades appear automatically without resubmitting the entry. A ready-to-submit entry is kept at `market/awesome-dsh-plugin-entry.yml`.
- dsh-plugin.org (DSH Plugin Hub) periodically scans public repositories with the `dsh-plugin` topic and their npm packages; new versions refresh automatically after publication.
- Before releasing, check the package with `npm run build && npm pack --dry-run`.

## Security

- Credentials live only in the Host process; the API returns only host names, addresses and workspace paths.
- Host-key TOFU: the SHA256 fingerprint is recorded on first connection and connections are refused if it changes.
- Direct remote directories are read-only and confined to their configured root; linked-workspace tool operations are confined to the remote root.
- Single-file saves are capped at 8 MB. Mirroring runs in the background with defaults of at most 500 files / 50 MB per pass; oversized files are skipped. `.git`, `node_modules` and caches are excluded; single-file reads time out after 30 s. A manual transfer/download handles at most 150 files / 15 MB per run and reports when the limit is hit.
- The HTTP API only accepts loopback, same-origin requests. For remote deployments it falls back to DSH `connection` host/origin authentication.

## Architecture and development

```
Client (browser)                         Host (DSH process)
Settings / right-sidebar workbench  →    POST /dsh-linked-workspace/api
themes + highlighting + file icons       workspace registry + linked registry + SSH pool
```

- `lib/index.js` — Host API, connection pool, linked workspaces, `linked_workspace` tool, prompt section.
- `lib/ssh.js` — SSH/SFTP, remote exec, host discovery, TOFU fingerprints.
- `lib/git.js` — remote/local git status (porcelain) and filename search.
- `lib/linked.js` — linked persistence, `.local`/`.remote` layout, mirror I/O.
- `src/client.js` + `src/parts/*` → `scripts/build-client.mjs` → `lib/client.js` (single browser bundle).
- `docs/API.md` — API contract; `docs/VERIFY.md` — manual test checklist.

```
node scripts/build-client.mjs       # rebuild lib/client.js
node --check lib/index.js lib/ssh.js lib/linked.js
node test/linked.test.mjs           # linked filesystem unit tests (node --test)
node test/parts.test.mjs            # theme/highlight/icon unit tests
node test/client-smoke.mjs          # client bundle registration smoke test
node test/git.test.mjs              # git status/search (includes a real SSH read-only check)
node test/ssh-smoke.mjs             # real SSH transfer smoke test
node test/host-api.mjs              # full Host API over real SSH (24 steps)
```

## License

MIT © 2026 Huangjh
