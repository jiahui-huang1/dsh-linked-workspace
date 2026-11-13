# Changelog

English · [简体中文](CHANGELOG.zh.md)

## 0.11.0 — 2026-11-13

**Breaking change**: Remote workspaces replace remote directories.

- **Remote workspaces (feature)**: sessions run directly in a remote directory without requiring a local copy. The Host creates a placeholder directory for DSH workspace registration, sessions use the `linked_workspace` tool (or `fs.*` APIs with `remoteId`), and local Skills stay accessible. The old read-only "remote directory" mode is removed.
- **Settings UI (feature)**: the settings “Connections” page is now “Linked & remote workspaces” (“Linked workspaces” in the settings nav) with a **Remote workspaces** group — create (host + remote directory + name), open workspace, open directory tree, test connection, rename inline, and remove behind a two-step confirmation.
- **Sidebar (feature)**: a dedicated **Remote workspace directory** tab shows the remote tree without the local pane; files open read-only in the editor. Both tree tabs (linked and remote) register eagerly, so a remote tree opens from settings even while the current session belongs to a linked workspace.
- **Add workspace flow (feature)**: the sidebar “Add workspace” dialog gains a third tab, “Remote workspace”, with steps *SSH connection → remote directory → workspace name*.
- **API changes**: `workspaces.*` methods removed, replaced by `remote_workspaces.*` (list/create/get/update/remove/test). `requireScope` now accepts `linkedId` or `remoteId` (not `workspaceId`). All existing `fs.*` methods work with both linked and remote workspaces. `linked_workspace` resolves remote workspaces by id, placeholder path or name, and reports `kind: "remote"` from `info`.
- **Data persistence**: `remote-workspaces.json` registry (including the SSH host snapshot for display), placeholder directories under `remote-placeholders/<uuid>/`.
- **Fixes**: removing a remote workspace now really deletes its placeholder directory (the code called an unimported `rm`), the host-snapshot refresh no longer calls a non-existent `LinkedStore.updateSnapshot`, and `terminal.open` no longer reads the removed remote-directory scope.
- **Smaller fixes**: a directory-tree tab opened from the start page lists every linked/remote workspace when the current session belongs to none of them (it used to show an empty pane), the tree empty state names workspaces instead of “remote directories”, and “Open directory tree” now closes the settings dialog the way “Open workspace” does. In the add-workspace dialog the local “Create” button no longer starts out disabled (it looked greyed out next to the linked/remote ones); clicking it without a folder now explains what is missing instead of doing nothing.
- **Workspace icons (feature)**: linked workspaces now use a two-link glyph and remote workspaces a display-with-arrow glyph everywhere the plugin renders them — the sidebar workspace row, the sidebar “+” menu, the directory-tree chips and headers, the settings cards and create buttons, and the “Add workspace” dialog tabs.
- **Connection state (feature)**: the sidebar row icon belongs to the plugin, so a dropped SSH connection paints it red (`.data-lw-disconnected` + a `#f85149` mask). Hovering the sidebar row reports the state in the host's own hover preview (see below); the settings card, the tree chip and the tree header keep it in their tooltip. The Host now reports a lost connection itself: `RemoteHost` gained an `onLost` hook, `HostPool.noteConnectionLost` stores `{ state: "error", reason: "lost" }`, and the next successful connect clears it.
- **Naming**: the settings nav entry is “Linked workspaces” (was “Connections”) and the page title is “Linked & remote workspaces”; the “Add workspace” tab is plain “Remote workspace”.
- **Hover preview**: the workspace hover card is rendered by the host, so the plugin decorates it after it appears — the connection state becomes one line (“已连接” / “连接已断开” / “未连接”), a remote workspace shows its remote directory instead of the local placeholder, and a linked workspace lists both the remote and the local directory. The row `title` tooltip is gone so the two no longer overlap, and the card's “copy path” label always matches the path it shows.
- **Dark theme**: primary buttons take their label colour from `--dsw-alias-bg-base` (pure black `#000` in the dark theme) instead of a hard-coded `#fff`, so they are no longer white-on-white; the checked switch thumb follows the theme too.
- Tests: 63 unit tests pass; `test/host-api.mjs` covers `remote_workspaces.*` end to end.

## 0.10.0 — 2026-11-12

Fourth review round: transfer safety, content search, document find and comparison actions.

- **No silent overwrite (fix)**: dropping a file onto a folder that already has that name now asks first — cancel, keep both, or overwrite. `fs.pullToLocal` and `fs.upload` accept `conflict=error|overwrite|unique`; `unique` goes through `uniqueLocalPath` / `remoteUniqueTarget`. Verified by overwriting `REMOTE-OVER` with `LOCAL-OVER` and by creating `same copy.txt` and `overwrite (2).txt`.
- **Transfer and drag fixes**: single-file transfers create missing parent directories (previously `writeFileAtomic … No such file`); same-tree drops point at “Move to…”; dropping a folder shows a direction-specific notice; hovering a folder for 700 ms while dragging expands it.
- **Content search (feature)**: `fs.grep` searches file contents — the local scan is bounded to 1 MB per file, 2000 files, 8 MB and 5 s; the remote side runs `grep -rIl … | head`. The search bar switches between “File name” and “Content” modes; `fs.search` stays a filename search (now documented, and the placeholder was corrected).
- **Document find (feature)**: the Markdown document pane supports Ctrl/Cmd+F with a counter, next/previous and Escape; it is read-only (replace remains in the text editor).
- **Compare actions (feature)**: comparison rows can be pushed to the remote side or pulled to the local side; the dialog notes a missing local folder and per-side truncation, closes when a row is opened, and derives the local path separator instead of hardcoding `\`.
- **Queue retry (feature)**: failed transfer-queue items gain “Retry”.
- **Workspace registration (feature)**: when a link has no `workspaceId`, settings offers “Register workspace” (`linked.update` with `ensureWorkspace: true`).
- **Smaller fixes**: the find counter is announced (`aria-live`), Escape closes the find bar from the replace field, and the editor status bar no longer shows a pointless `Ctrl+S` keycap.
- Tests: 63 unit tests pass; `test/host-api.mjs` passes 28 steps.
## 0.9.0 — 2026-11-12

Third review round: in-editor editing, local/remote comparison and drag-and-drop, plus refresh behaviour.

- **Find and replace (feature)**: `Ctrl/Cmd + F` opens an in-editor bar with a case-sensitive toggle, previous/next, a match counter, replace and replace all. Matching stops at 5000 hits and the counter shows `5000+` when more exist; replace-all still edits the whole document (6000 replacements verified).
- **Terminal in a directory (feature)**: the tree context menu gains “Open terminal here” for folders. `terminal.open` accepts an optional `path`, validated to stay inside the linked workspace, and starts the shell in that directory (verified with a real `ssh -t … "cd <dir> && exec bash -l"` process).
- **Filter in the path pickers (feature)**: the local and remote directory pickers filter already-loaded entries while typing, with an empty-state hint.
- **Local/remote comparison (feature)**: `fs.compare` compares a remote directory with its local counterpart and returns only-local / only-remote / changed entries (size differs, or mtime differs by more than 2 s), capped at 4000 files, depth 12 and 200 rows per group with a `truncated` flag. The dialog lists the three groups; clicking a row opens it.
- **Multi-select and batch actions (feature)**: Ctrl/Cmd-click toggles a row, Shift-click extends the selection; the context menu offers “Transfer selected (N)” and “Delete selected (N)” with a confirmation dialog, and per-item errors are aggregated (a file deleted outside the app reports “path does not exist” while the others are removed).
- **Drag and drop (feature)**: drag rows between the local and remote trees (a remote file is copied through `fs.pullToLocal`, a local file through `fs.upload`), and drop OS files onto either tree (`fs.upload` / `local.import`; up to 50 files, 64 MB each). If the browser hides file paths, or a remote folder is dropped onto the local tree, a notice explains the limitation instead of failing silently.
- **Refresh throttling**: the 4-second tick now refreshes each directory at most every 15 seconds and pauses while the page is hidden (measured intervals 18–19 s), so a large tree no longer re-lists on every tick.
- **Unsaved-changes guard**: a dirty editor registers `beforeunload`, so reloading or closing the window asks for confirmation.
- **Refresh keeps loaded rows**: a silent refresh merges the first page with already-loaded rows instead of truncating back to 500 (or 5000); a 5500-entry directory stayed at 5522 rendered rows across refresh cycles.
- **Search truncation**: results over the 200-row cap now show “showing the first 200 matches” instead of dropping the flag.
- **Load-more and counter fixes**: “Load more (0 left)” disappears once everything is loaded; the find counter reports `5000+` instead of pretending the document has exactly 5000 matches.
- Review note: two previously reported issues (no context menu in the right-sidebar tree, hidden-file toggle not refreshing expanded folders) were re-tested and could not be reproduced; neither was changed.

## 0.8.3 — 2026-11-11

Second review round: follow-ups to the 0.8.2 paging and preview work.

- **Preview overlay (medium)**: the sanitizer now strips inline `style` attributes as well. A document containing `<div style="position:fixed;inset:0;z-index:99999;background:#fff">` used to cover the whole DSH window and could impersonate a login page (click-jacking / phishing without any script).
- **Paging survives refresh (medium)**: the local tree refreshes every 4 seconds; it now re-requests only the number of entries already loaded instead of resetting to the first page, so “Load more” results no longer disappear after up to 4 s.
- **Paging offset with hidden files (medium)**: “Load more” uses the raw server offset, so with hidden files toggled off entries are neither duplicated (200 duplicates before) nor skipped; the remaining count follows the same offset.
- **Directory listing cache (medium)**: `fs.list` caches a listing for 5 seconds, so paging a huge directory reads it once instead of re-running a full `listDir` (20,000 entries: ~10.4 s per call). Writes, mkdir, rename, move, delete, copy and transfers invalidate the cache, and `limit` is clamped server-side to 1..5000.
- **Partial copy cleanup (low)**: if a directory copy fails midway (for example on a >64 MB file), the partial target is removed and the error is `FS_INCOMPLETE`; `FS_TOO_LARGE` now only means an actual size cap.
- **Connection reuse (low)**: `HostPool` keys in-flight connects by host *and* authority, so an address change cannot attach an old connection to a new request; a connection replaced while connecting is disposed instead of leaked, and `setHosts` clears stale pending entries.
- **Right-sidebar requests (low)**: the linked-workspace tree source de-duplicates in-flight loads instead of sending the same request twice.
- **Large pickers and PDF export (low)**: the local/remote directory pickers render at most 500 entries plus a “type the path directly” note; markdown-to-PDF export stops after 999 name suffixes with an explicit error instead of looping forever.
- **Tests**: fixed two self-inconsistent assertions in `test/host-api.mjs` (a folder left behind made a later create return 409, and an already-existing folder was expected to answer 400); the suite now passes all 28 steps.

## 0.8.2 — 2026-11-11

Three-day review round: security, data-integrity and large-directory fixes.

- **Document preview XSS (high)**: the preview sanitizer now normalizes control characters, whitespace and zero-width characters before checking a URL scheme, so `jav\tascript:` links (and `vbscript:`, `file:`, `blob:`, `data:text/html`) can no longer run in the GUI. Only `http(s)`, `mailto`, `tel`, relative URLs and bitmap `data:image/*` sources are kept; SVG data URLs stay blocked.
- **Mirror containment on Windows**: `realpathSync.native` is used for the containment check, so a directory junction can no longer make `.remote` (or a mirrored file) point outside the workspace. Linked `.local`/`.remote` entries that are themselves links are removed as links, never followed.
- **No silent truncation when copying**: copying a remote file larger than 64 MB, or reading one incompletely, now fails with an explicit error instead of writing a truncated copy. The `linked_workspace` read tool no longer mirrors a truncated payload into `.remote`.
- **Large local files**: `local.read` reads only the requested head of the file instead of loading the whole thing into memory, so peeking at multi-gigabyte files no longer allocates them (or fails with `ERR_FS_FILE_TOO_LARGE`).
- **Non-empty directory delete from the tool**: `linked_workspace` `delete` now removes directories recursively, matching the UI, instead of failing on SFTP `rmdir`.
- **Paged directory listings**: `fs.list` and `local.list` return `limit`/`offset` with `total` and `hasMore` (default 500, max 5000); both trees render a “Load more (N left)” row. A 20,000-entry folder no longer freezes the UI (it used to render all 20,012 rows).
- **Deep sync trees**: the mirror sync marks a job truncated when it stops at the depth limit, instead of reporting success with missing files.
- **Accessibility**: visible `:focus-visible` rings for tree rows, inputs, buttons and tabs; `role="treeitem"`/`aria-level`/`aria-selected`/`aria-expanded` on tree rows with ←/→ collapse/expand; the add-workspace dialog focuses its first field, traps Tab, and closes on Escape.
- **Excel preview honesty**: `read_xlsx` reports `totalRow`/`totalCol`/`truncated`, and the grid notes when it shows only the first 200 rows × 40 columns or the first 20 worksheets.
- **Build and host fixes**: the client build fails loudly when a `src/parts/*` file is missing; the dead branch in `linked.update` is gone; `HostPool` reuses one in-flight connection per host instead of leaking a duplicate on concurrent first connects.

Earlier unreleased work included in this version:

- Fixed linked-directory context-menu creation on both the remote and local trees: New folder and New file are direct menu actions, so the scrollable menu no longer clips the creation submenu.
- CSV, HTML, SVG and other preview formats now create ordinary empty files; only Markdown, PDF, DOCX, XLSX and PPTX use document templates.
- Creation keeps the name dialog open on failure, displays the error and prevents repeated submissions while pending. New files and folders reject existing names with HTTP 409 instead of replacing or silently reusing them, on both remote and local trees.

## 0.8.1 — 2026-11-09

- **Image zoom**: the image preview gains zoom-out/zoom-in buttons, a percentage readout, “Fit to window” and “1:1” controls, plus `Ctrl/Cmd + wheel` zoom.
- **HTML preview**: `.html` and `.htm` files now render in a sandboxed iframe in the content panel. Scripts are disabled; the status bar notes this.

## 0.8.0 — 2026-11-09

- **Image previews**: PNG/JPG/GIF/WebP/BMP/ICO/AVIF/SVG now render in the content panel for both remote and local files (`media.read` / `local.media`, 24 MB cap).
- **CSV/TSV table view**: CSV and TSV files open in a table by default with a Table/Source toggle. The source view keeps editing, syntax highlighting, and save; tables are capped at 1000 rows and 80 columns.
- **Move files and folders**: the directory context menu gains "Move to…" for remote and local entries. A directory picker chooses the destination inside the same tree; the plugin rejects collisions, moving a folder into itself, moving the workspace root, and moving a file with unsaved edits.
- New host APIs `media.read`, `fs.move`, `local.media`, `local.move`; `FS_EXISTS` now maps to HTTP 409.

## 0.7.0 — 2026-11-09

- **VSCode-like tree interaction**: single-click a folder to expand/collapse and single-click a file to open it. A single-click preview tab is replaced by the next file; double-click pins the tab so later single clicks do not overwrite it. Double-clicking a folder keeps it expanded.
- **Terminal shortcuts in the directory toolbar**: one button opens a system terminal at the current remote directory (via `ssh`), and linked workspaces get a second button for the local directory.
- **Keyboard shortcuts**: `Ctrl/Cmd+S` save, `Ctrl/Cmd+W` close tab, `Ctrl+Tab` / `Shift+Ctrl+Tab` cycle tabs, `Ctrl/Cmd+B` toggle the directory panel, `Ctrl/Cmd+Shift+F` file search.
- **Unsaved-close prompt**: closing a dirty tab now offers Save / Discard / Cancel instead of silently losing edits.
- **Auto save setting**: Settings → Connections → Editor behavior adds an auto-save switch; when enabled, edits are saved about one second after typing stops. Default remains off.

## 0.6.2 — 2026-11-05

- Fixed Markdown/document JSON transport failing with a Windows GBK codec error for characters such as the superscript minus (U+207B); the Python bridge now emits UTF-8/ASCII-safe JSON and configures UTF-8 stdout.
- PDF files now load lazily: only the current page is rendered; other pages are fetched on demand (`docs.pdfPage`), and a large PDF is downloaded/opened once and cached. This removes the long “加载中” hang on large (30 MB+) PDFs.
- PDF page navigation, rotation, deletion and metadata remain available.

## 0.6.1 — 2026-11-05

- Fixed the linked-workspace directory tab disappearing for a new or blank linked-workspace session: the client session store is now consulted for cwd/workspaceId before falling back to session.info, so the tab and the start-page option are registered immediately when the workspace session opens.
- Availability also matches the linked record workspaceId, not only the local path.

## 0.6.0 — 2026-11-05

- **Document editing in the content panel** for Markdown, PDF, DOCX, XLSX and PPTX, on both local and remote files.
  - Markdown: raw editing, rendered preview, export to PDF.
  - DOCX: paragraph and table text editing (styles are preserved at paragraph level; rich inline formatting may be simplified).
  - XLSX: sheet tabs and editable cell grid; formulas and untouched styles are preserved.
  - PPTX: slide navigation and text-frame editing.
  - PDF: page navigation, rotate/delete page, title/author metadata; page images are rendered by PyMuPDF.
- New document files can be created from the directory context menu (`.md`, `.pdf`, `.docx`, `.xlsx`, `.pptx`).
- A small Python bridge (`scripts/doc_tool.py`) implements the format-specific read/write/create operations. Python 3 with `python-docx`, `openpyxl`, `python-pptx` and `PyMuPDF` is required for Office/PDF operations; Markdown works without them.
- Runs on both local folders and remote linked/directories (remote files are downloaded, processed and uploaded atomically).

## 0.5.13 — 2026-11-05

- The linked-workspace directory panel can now be resized by dragging the divider; double-click the divider to reset to 300 px. The width is persisted.
- The local directory tree now refreshes silently every 4 seconds (and on window focus), so newly created local subdirectories appear without a manual refresh; expanded folders are reloaded in place.

## 0.5.12 — 2026-11-04

- Published as **dsh-linked-workspace** on npm (public).
- Added the `v*` tag release workflow: it verifies the tag against `package.json`, skips an already-published version, and otherwise publishes to npm with provenance.
- Added repository metadata, `dsh-plugin` topic, and marketplace submission files.

## 0.5.11 — 2026-11-04

- Documentation: added an **English README** (`README.en.md`) with language links; refreshed stale Chinese README details (read-only remote directories, bidirectional transfer, local-workspace form, lazy `.local`).

- **Fixed remote directory file viewing**: read-only tabs now render the file content (gutter, syntax colors, status bar with 只读 chip) instead of only showing a “只读” message. Binary/oversized files still show the read-only notice.
- **Fixed Settings → 连接 open actions**: “打开工作区” now navigates to the linked workspace and closes settings; remote directory “打开” now opens the remote-directory tab (was opening the linked tab type) and closes settings. Tab metadata pins the requested linked workspace / remote directory.
- Save keys remain disabled in read-only views.

## 0.5.10 — 2026-11-04

- The add-workspace **本地工作区** tab now behaves like the linked tab: the local directory is an input plus a **浏览…** button, and the directory picker opens only after clicking browse (picking a folder collapses it again).
- Removed the **打开右侧栏** button from Settings → 连接.

## 0.5.9 — 2026-11-04

- Ctrl+O / add-workspace linked flow: the inner card no longer renders its own 取消/添加联动工作区 buttons; the modal footer now shows **取消 + 创建**.
- Settings: the linked action is now **创建联动工作区**; its form title is **创建联动工作区** and the submit button is **创建**.
- Settings: adding a remote directory now submits with the **添加** button.

## 0.5.8 — 2026-11-04

- Add-form titles now match the action: **添加联动工作区** / **添加远程目录** instead of the generic 添加工作区.
- The Ctrl+O / add-workspace flow's first tab is renamed **本地工作区**; it now has a real form with **1. 本地目录** and **2. 工作区名称** (directory picker no longer closes the flow on pick; the footer creates the workspace).
- New host API `localWorkspace.create` registers a plain local DSH workspace by path + optional name.
- Tests: host API suite now 24 steps (localWorkspace.create).

## 0.5.7 — 2026-11-04

- Adding a **linked workspace** now locks the form to linked mode: no “远程目录 / 联动工作区” switch inside the add card (both settings and the Ctrl+O directory flow).
- Adding a **remote directory** locks the form to remote mode: no linked switch and **no workspace-name field**; the workspace name is derived from the path.
- Existing name field remains for linked workspaces, where it titles the DSH workspace.

## 0.5.6 — 2026-11-04

- Wording: the direct-remote section now reads **直接浏览远端目录（只读）**.
- **Bidirectional transfer**: the linked-workspace transfer button/context menu works for both sides. Remote → local copies only into the local `.remote` directory; local → remote preserves the path relative to the linked local root. The queue records the direction.
- **No eager `.local`**: creating or updating a linked workspace no longer creates `.local` (or `.remote`); plugin metadata is created lazily only when mirror sync needs it.
- **Local path picker supports all drives**: `local.browse` returns Windows drive roots and the browser shows C:/D:/E: chips; this also fixes adding normal local workspaces and linked local folders on non-C drives.
- **Remote breadcrumb**: no more doubled leading slash (//home → /home).
- Tests: host API suite still 23 steps (drive roots, local→remote transfer, no eager `.local`).

## 0.5.5 — 2026-11-04

- The right-sidebar start page now offers **联动工作区目录 only for sessions of a linked workspace**, and the opened panel is bound to that session's own linked workspace (never another one). Non-linked sessions no longer register the linked tab at all (dynamic registration via `session.info`).
- **远程目录** is a separate tab type, offered in every session as soon as at least one remote directory is configured; it is **read-only** — tree browsing, file viewing, download/copy path/properties, no editing, no transfer/rename/delete/new actions. Only linked-workspace tabs are editable.
- The empty remote-directory wording is now **还没有远程目录**.
- Host API `session.info` (sessionId → cwd/running) added for the dynamic tab availability.
- Tests: host API suite still 23 steps (now also checks `session.info`).

## 0.5.4 — 2026-11-04

- Hidden files are **shown by default** when the linked-workspace directory opens (including `.local`/`.remote`), and the directory panel is open by default; the eye button still hides them.
- Internal file tabs no longer show a file-type icon for either remote or local files (only the file name).
- The internal editor header (path, reload/save buttons) is removed; saving stays on Ctrl/Cmd+S. Unsaved changes now show as a small gray dot in front of the file name in the tab strip.

## 0.5.3 — 2026-11-04

- **Theme families (9 cards)**: GitHub, Solarized, One, Dracula, Monokai, Nord, VS Code, Xcode and Catppuccin each keep both a light and a dark variant on one card; the preview follows the selected mode (System follows the DSH light/dark scheme). The three mode cards no longer carry preview strips.
- **Workspace layout**: the linked-workspace directory is now a fixed **right-side panel** (never its own tab) with a toolbar button to show/hide it. Between the conversation and that panel sits the **file content panel** with its own internal tabs; with nothing open it shows the “打开文件 / 从工作区目录树中选择文件” placeholder.
- **Local files are editable in the content panel** via new `local.read`/`local.write` host APIs; local file tabs show no icon and no longer depend on the native editor.
- Clicking a tree row still only selects; double-click expands a folder or opens a file in the internal content panel while the directory panel stays visible.
- Tests: host API suite now 23 steps (local read/write + theme-family settings).

## 0.5.2 — 2026-11-04

- **Local tree hidden toggle**: `.local`/`.remote` are no longer filtered unconditionally; the show/hide-hidden-files button now governs both the remote and the local tree (showing the linkage directories when enabled).
- **Single click selects, double click opens**: tree rows select on one click; double-click expands folders or opens files. Files open as a background tab (via `reveal: false` + re-activating the directory tab), so the panel keeps showing the linked-workspace directories until the new tab is clicked.
- **Theme distinction**: the three mode cards now carry light/dark preview strips (system is split), and every specific theme shows a 浅色/深色 badge; light themes render with their true light palette (verified GitHub Light / Xcode Light).
- **Settings buttons swapped**: 添加联动工作区 now precedes 添加远程目录.
- Toolbar transfer-file and show-hidden-files buttons remain as in 0.5.1.

## 0.5.1 — 2026-11-04

- **Editor theme modes**: 系统 / 浅色 / 深色, default **系统**. System follows the current DSH light/dark theme; Light/Dark force the matching palette; the specific-theme grid is still available and picking one switches to its mode.
- **Running workspace icon**: linked-workspace rows whose local directory currently owns a running Session turn **blue** (host reads running Session cwds via the session controller; the client refreshes the icon styles every 5 s).
- **Local skills bridge**: linked sessions run in the local directory, so locally installed skills (user + project) stay available. New tool `linked_skills` (list/read) and host APIs `skills.list` / `skills.read` expose them; the prompt section explicitly says not to install skills into the remote project. The earlier transfer-file/hidden-file toolbar buttons remain.
- Host API `linked.list` now returns `running` per link; `settings` carries `editorThemeMode`.
- Tests: host API suite 22 steps (local skill discovery/read + running flag included).

## 0.5.0 — 2026-11-04

- **GitHub Light is the default editor theme.** Settings written by older versions that still carry the old implicit dark default are migrated once; an explicitly chosen theme is kept.
- **Mirror sync is opt-in and defaults off.** Existing records created under the old default are switched off once; when enabled, the first check starts immediately and a background consistency check then runs every five minutes (downloads changed/missing files, removes mirror files whose remote counterpart disappeared, skips unchanged files via the manifest, per-file timeout, cancel on demand).
- **Context menu in the directory panel** (right-click a file, folder or root row): transfer the selection to `.remote`, download to the OS Downloads folder, transfer queue, open, edit in Notepad, copy/paste, copy path, rename, delete, change permissions, new folder/file, properties. The transfer queue runs one SFTP transfer at a time with live state.
- **Toolbar additions**: a transfer button for the selected remote file/folder, a show/hide-hidden-files toggle, plus the existing tree modes, search, open-with menu and refresh.
- **Several remote files can be open in separate tabs at once** (12 hidden page kinds act as file slots; reopening the same file focuses its tab, closing it frees the slot).
- The settings page title is now **连接与联动工作区** / Connections & Linked Workspaces.
- New host APIs: `fs.transfer`, `fs.download`, `fs.edit`, `fs.copy`, `fs.chmod`, recursive `fs.delete`, `local.stat/rename/delete/copy/newFile/chmod/edit`.
- Tests: host API suite now 21 steps (transfer/download/copy/chmod/recursive delete included).

## 0.4.0 — 2026-11-03

- Sidebar tab renamed **联动工作区目录**: for a linked workspace the panel shows the remote tree on top and the local tree below (root row "所有文件"); clicking a file opens a new tab, the directory panel stays in place.
- Toolbar: **切换文件树** (所有文件 / 已更改的文件 / 所有更改 via git status on both sides), **在文件中搜索** (remote `find` + local walk, debounced), **打开选项菜单** (editor / system default app / copy path) and refresh. The chosen open mode is persisted in settings.
- Linked workspace rows now show a real link icon instead of the "⇄" title prefix: the host strips the old prefix from existing workspaces and the client replaces the folder glyph via a scoped stylesheet (documented safe degradation).
- **Sync no longer times out**: `linked.sync` now starts a background job with progress polling (`linked.syncStatus` / `linked.syncCancel`), skips unchanged files via a mirror manifest, excludes VCS/dependency directories, stops at the caps and uses a per-file timeout. The settings card shows live progress and a cancel action.
- Host additions: `RemoteHost.exec`, `git.status`, `fs.search`, `local.list`, `fs.openExternal`, `local.openExternal`, plus `fileOpenMode` in settings.
- Tests: 10 new git/search tests (local temp repos + read-only remote checks); host API suite now 20 steps.

## 0.3.0 — 2026-11-03

- Renamed the plugin from `dsh-remote-workspace` to **`dsh-linked-workspace`** (bundle row id `linked-workspace-ui`, HTTP route `/dsh-linked-workspace/api`, client module id `dsh-linked-workspace`).
- Data directory renamed from `$DSH_HOME/remote-workspace` to `$DSH_HOME/linked-workspace`; the first start after the upgrade migrates the old directory (rename, copy fallback) so existing remote directories, linked workspaces, settings and trusted host keys survive.
- Environment knob renamed to `DSH_LINKED_WORKSPACE_HOME` (the old `DSH_REMOTE_WORKSPACE_HOME` still works).
- Settings section id is now `linked-workspaces` (nav label unchanged: 连接 / Connections).
- Tabs persisted before the rename keep the old type ids; hidden legacy aliases (`dsh-remote-workspace`, `dsh-remote-workspace:file`) restore them after a page reload instead of showing an empty view.

## 0.2.0 — 2026-11-03

- **Linked workspaces** (local ⇄ remote): the sidebar/hero "add workspace" hole now offers a local folder or a linked workspace. Creating one writes `.local/linked.json` + `.local/session/`, optionally `.remote/`, registers a real DSH workspace titled `⇄ <name>`, and exposes the `linked_workspace` agent tool (list/info/list_dir/read/write/replace/stat/mkdir/rename/delete/sync) plus a system-prompt section so sessions edit remote files directly.
- **Editor themes**: 10 built-in themes (GitHub Dark/Light, One Dark, Dracula, Monokai, Nord, Solarized Dark/Light, VS Code Dark+, Xcode Light) selectable in Settings → Connections; the remote editor background/text/gutter/selection/token colors follow the choice.
- **Syntax highlighting**: a dependency-free tokenizer powers an overlay highlighter in the remote editor (strings, comments, keywords, numbers, functions…), with a plain-text fallback for very large files.
- **Split workbench**: the sidebar tab is now a split view — remote directory tree on the left, editor on the right; files open in place, with "open in tab" as an escape hatch. Tab renamed to 远程目录 / Remote Directory.
- **File-type icons**: colored glyph icons per extension and well-known file names, plus a distinct link icon for linked workspaces (sidebar group, cards, tree).
- **Settings → Connections** reorganized into editor theme / linked workspaces / remote directories, with mirror toggle + sync, safe removal options, and local directory browsing (system picker included).
- Host: `settings.get/update`, `local.browse/mkdir`, `linked.create/list/update/remove/sync`; every `fs.*` method now accepts `linkedId` as well as `workspaceId`; reads/writes of linked workspaces mirror into `.remote` and every write is atomic.
- Build: `src/client.js` + `src/parts/{themes,highlight,file-icons}.js` are inlined by `scripts/build-client.mjs` into `lib/client.js`.

## 0.1.0 — 2026-11-03

First release.

- Settings → **连接** page: list, test, open and remove remote workspaces; an
  `添加工作区` flow that picks an existing SSH connection and a remote
  directory (with a remote directory browser).
- Sidebar (dsh-better-sidebar) pages: a lazy remote file tree per workspace and
  an editor tab with line numbers, dirty marker, `Ctrl/Cmd+S`, conflict
  detection, binary/large-file read-only protection and a UTF-8/LF/CRLF status
  bar.
- Host: JSON API on the DSH web server, persisted workspace registry, one SSH
  connection per host, SFTP reads/writes with atomic replace, path containment,
  8 MB save cap, trust-on-first-use host-key pinning.
- Host discovery reuses the `dsh-ssh-tunnel` SSH Manager store and
  `~/.ssh/config`; credentials never cross the client boundary.
- zh/en UI following the DSH locale; DSH theme tokens only.
