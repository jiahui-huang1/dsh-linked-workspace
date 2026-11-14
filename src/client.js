/*!
 * dsh-linked-workspace — Client half (browser bundle source).
 *
 * This file is the build source: `scripts/build-client.mjs` inlines
 * `src/parts/*.js` (themes, tokenizer, file icons) at the __INLINE_PARTS__
 * marker and writes `lib/client.js`. The emitted bundle keeps the official DSH
 * client-bundle shape — a lazy-CJS closure registered with
 * window.__ModuleLoader__.load({ id, factory }). `react` is an external
 * resolved from the shell's module table at runtime.
 *
 * The module contributes:
 *  - a DSH Settings section ("连接") with editor theme picker, remote
 *    directories and linked (local ⇄ remote) workspaces;
 *  - two dsh-better-sidebar tab types: the remote directory workbench
 *    (tree + inline editor split) and a standalone remote file editor tab;
 *  - occupants of the sidebar/hero directory-flow holes, so the sidebar's
 *    "添加工作区" button offers both a local folder and a linked workspace.
 * Everything talks to this plugin's own Host route
 * POST /dsh-linked-workspace/api.
 */
window.__ModuleLoader__.load({
  id: 'dsh-linked-workspace',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    'use strict';

    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;
    var useMemo = React.useMemo;

    // __INLINE_PARTS__

    var TREE_TAB_TYPE = 'dsh-linked-workspace';
    // Remote workspaces get their own page kind: the two modes show different
    // trees (local ⇄ remote pair vs. a plain remote root), so a session must be
    // able to hold both, and each one filters its own workspace list.
    var REMOTE_TREE_TAB_TYPE = 'dsh-remote-workspace';
    // One tree page; a folder with 20k entries must not render 20k rows.
    var TREE_PAGE_SIZE = 500;
    var TREE_PAGE_MAX = 5000;
    // Background tree refresh interval per directory. The app ticks every 4 s,
    // but a full remote listing on a huge folder is expensive; 15 s keeps the
    // tree fresh without hammering the SSH channel.
    var REFRESH_MIN_INTERVAL_MS = 15000;
    var linkedLocalKeys = new Set();
    var linkedWorkspaceKeys = new Set();
    // Remote workspaces run inside a placeholder directory, so they are matched
    // by that path (and by their DSH workspace id) instead of a local directory.
    var remotePlaceholderKeys = new Set();
    var remoteWorkspaceKeys = new Set();
    var linkedTabDisposer = null;
    var remoteTabDisposer = null;
    var syncDirectoryTabsRef = null;
    // Set by the sidebar registration block so the availability refresh can ask
    // the sidebar to rebuild its "+" entries after the workspace lists change.
    var refreshTabVisibilityRef = null;

    function linkedScopeKey(cwd) {
      return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    function pathInsideOf(root, target) {
      var base = linkedScopeKey(root);
      var value = linkedScopeKey(target);
      if (!base) return true;
      return value === base || value.indexOf(base + '/') === 0;
    }

    function isLinkedWorkspaceId(workspaceId) {
      return Boolean(workspaceId) && linkedWorkspaceKeys.has(String(workspaceId));
    }

    function isLinkedScope(scope) {
      var key = linkedScopeKey(scope && scope.cwd);
      if (!key) return false;
      var found = false;
      linkedLocalKeys.forEach(function (localKey) {
        if (found) return;
        if (key === localKey || key.indexOf(localKey + '/') === 0) found = true;
      });
      return found;
    }

    function isRemoteWorkspaceId(workspaceId) {
      return Boolean(workspaceId) && remoteWorkspaceKeys.has(String(workspaceId));
    }

    function isRemoteScope(scope) {
      var key = linkedScopeKey(scope && scope.cwd);
      if (!key) return false;
      var found = false;
      remotePlaceholderKeys.forEach(function (placeholderKey) {
        if (found) return;
        if (key === placeholderKey || key.indexOf(placeholderKey + '/') === 0) found = true;
      });
      return found;
    }

    function dismissSettingsOverlay() {
      // 设置面板以 Escape 关闭；事件必须落在当前焦点元素上，直接派发到 window 不会触发它。
      function fire(target) {
        if (!target || typeof target.dispatchEvent !== 'function') return;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      }
      try {
        fire((typeof document !== 'undefined' && (document.activeElement || document.body)) || null);
        fire(typeof window !== 'undefined' ? window : null);
      } catch (error) { /* keyboard unavailable */ }
    }

    // `dsh-better-sidebar` is an optional companion: everything that touches
    // its service goes through here, so a deployment without it keeps the
    // settings page, the directory flows and the agent tools working instead of
    // failing on a missing service lookup.
    function sidebarService(ctx) {
      if (!ctx || typeof ctx.get !== 'function') return undefined;
      try {
        return ctx.get('betterSidebar') || undefined;
      } catch (error) {
        return undefined;
      }
    }

    function rememberDirectoryAvailability(links, remotes) {
      var next = new Set();
      var workspaceKeys = new Set();
      (links || []).forEach(function (link) {
        var key = linkedScopeKey(link.localPath);
        if (key) next.add(key);
        if (link.workspaceId) workspaceKeys.add(String(link.workspaceId));
      });
      linkedLocalKeys = next;
      linkedWorkspaceKeys = workspaceKeys;

      var placeholderKeys = new Set();
      var remoteKeys = new Set();
      (remotes || []).forEach(function (workspace) {
        var key = linkedScopeKey(workspace.placeholderPath);
        if (key) placeholderKeys.add(key);
        if (workspace.workspaceId) remoteKeys.add(String(workspace.workspaceId));
      });
      remotePlaceholderKeys = placeholderKeys;
      remoteWorkspaceKeys = remoteKeys;
    }

    function refreshDirectoryAvailability() {
      return Promise.all([
        apiCall('linked.list').catch(function () { return { links: [] }; }),
        apiCall('remote_workspaces.list').catch(function () { return { workspaces: [] }; }),
      ]).then(function (results) {
        var links = (results[0] && results[0].links) || [];
        var remotes = (results[1] && results[1].workspaces) || [];
        rememberDirectoryAvailability(links, remotes);
        publishWorkspaceIcons(links, remotes);
        // The "+" menu decides visibility from this availability data, and the
        // sidebar only rebuilds its entries when something notifies it.
        if (refreshTabVisibilityRef !== null) {
          try { refreshTabVisibilityRef(); } catch (error) { /* ignore */ }
        }
      });
    }
    function releaseRemoteFileSlot(kind) {
      var key = fileSlotByKind.get(kind);
      if (key !== undefined) fileSlotByKey.delete(key);
      fileSlotByKind.delete(kind);
    }

    function remoteFileSlotFor(key) {
      if (fileSlotByKey.has(key)) return fileSlotByKey.get(key);
      for (var index = 1; index <= FILE_SLOT_COUNT; index += 1) {
        var kind = FILE_SLOT_PREFIX + index;
        if (!fileSlotByKind.has(kind)) {
          fileSlotByKey.set(key, kind);
          fileSlotByKind.set(kind, key);
          return kind;
        }
      }
      return undefined;
    }

    function openRemoteFileTab(sidebar, scope, source, filePath) {
      if (!sidebar || typeof sidebar.openTab !== 'function') return false;
      var key = scopeKeyOf(sourceScopeOf(source)) + ':' + filePath;
      var kind = remoteFileSlotFor(key);
      if (kind === undefined) return false;
      sidebar.openTab({
        type: kind,
        id: kind,
        title: basename(filePath),
        path: filePath,
        meta: sourceMetaOf(source),
      }, scope);
      return true;
    }

    var FILE_TAB_TYPE = 'dsh-linked-workspace:file';
    var FILE_SLOT_PREFIX = 'dsh-linked-workspace:file:';
    var FILE_SLOT_COUNT = 12;
    // DSH's native right sidebar deduplicates ordinary page tabs by kind, so a
    // second file opened under one kind would focus the first tab. Each file
    // slot is its own hidden page kind; this map hands a free slot to a file and
    // releases it again when its tab closes.
    var fileSlotByKey = new Map();
    var fileSlotByKind = new Map();
    var FLOW_SLOTS = ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow'];
    var API_PATH = 'dsh-linked-workspace/api';

    // ── i18n ────────────────────────────────────────────────────────────────

    var ZH = {
      settingsNav: '联动工作区',
      title: '联动&远程工作区',
      welcomeEyebrow: 'DSH-LINKED-WORKSPACE',
      welcomeTitle: '欢迎使用联动工作区插件',
      welcomeLead: '把 SSH 主机上的远端目录接进 DSH：既能和本地目录配对成联动工作区，也能让会话直接运行在远端目录。会话里的模型可以读写远端代码。',
      welcomeCreate: '创建联动或远程工作区',
      welcomeCreateWhere: '设置 →「联动工作区」，或左侧工作区栏的「添加工作区」',
      welcomeBrowse: '在右侧栏浏览远端文件',
      welcomeBrowseWhere: '标签栏「+」→「联动工作区目录」或「远程工作区目录」',
      welcomeTools: '让模型读写远端代码',
      welcomeToolsWhere: '直接在会话里提需求，模型会用 linked_workspace 工具',
      welcomePassword: '不用装 SSH Manager 也能连',
      welcomePasswordWhere: '添加工作区时直接填 SSH 密码，只保存在本机',
      welcomeStar: '★ 点个 Star',
      welcomeDone: '知道了',
      intro: '把 SSH 连接变成工作区：联动工作区把本地目录与远端目录配对，远程工作区让会话直接运行在远端目录。会话都能读取、搜索和编辑远端文件。',
      addWorkspace: '添加工作区',
      addLinked: '添加联动工作区',
      createLinked: '创建联动工作区',
      addShort: '添加',
      refresh: '刷新',
      open: '打开',
      openSidebar: '打开右侧栏',
      test: '测试',
      remove: '移除',
      confirmRemove: '确认移除',
      removeHint: '只移除记录，不会删除远端文件。',
      emptyTitle: '还没有可浏览的工作区',
      emptyBody: '先在「设置 → 连接」里创建联动工作区或远程工作区，左侧「添加工作区」里也能创建。',
      emptyHint: '没有找到可用的 SSH 连接。请先在右侧栏的 SSH Tunnel 面板里添加主机。',
      stepHost: '1. 选择 SSH 连接',
      stepPath: '2. 远程目录',
      stepLocalPath: '3. 本地目录',
      stepName: '4. 工作区名称',
      remoteStepName: '3. 工作区名称',
      pathPlaceholder: '/shared_data_ssd1/huangjh/project',
      localPathPlaceholder: 'C:\\Users\\you\\projects\\demo',
      localPathRequired: '先选择或填写一个本地目录',
      namePlaceholder: '留空则使用目录名',
      browse: '浏览…',
      browsing: '正在浏览…',
      useThisDir: '使用此目录',
      parentDir: '上一级',
      home: '主目录',
      cancel: '取消',
      back: '返回',
      create: '创建',
      creating: '正在连接并验证…',
      loading: '加载中…',
      retry: '重试',
      connected: '已连接',
      idle: '未连接',
      errorState: '连接异常',
      disconnected: '连接已断开',
      testOk: '连接正常',
      testFail: '连接失败',
      testRunning: '正在测试…',
      saved: '已保存',
      saving: '保存中…',
      save: '保存',
      reload: '重新加载',
      conflictTitle: '远端文件已被修改',
      conflictBody: '保存前请重新加载，或强制覆盖远端文件。',
      forceSave: '强制保存',
      dirty: '有未保存的修改',
      readOnly: '只读',
      binaryFile: '这是二进制文件，暂不支持在侧边栏内编辑。',
      tooLarge: '文件过大（{{size}}），暂不支持在侧边栏内编辑。',
      truncated: '内容已截断',
      fileLoadError: '无法打开文件',
      imageLoadError: '无法预览图片',
      imageZoomIn: '放大',
      imageZoomOut: '缩小',
      imageFit: '适应窗口',
      imageActualSize: '原始大小',
      htmlLoadError: '无法预览网页',
      htmlScriptsDisabled: '网页脚本已禁用',
      previewOnly: '图片预览',
      csvTable: '表格',
      csvSource: '源码',
      csvEmpty: '没有可显示的数据',
      csvTruncated: '仅显示前 1000 行',
      moveTitle: '移动到…',
      moveMessage: '选择「{{name}}」要移动到的目录',
      moveDone: '已移动',
      moveDirty: '该文件有未保存修改，请先保存或关闭后再移动',
      moveFailed: '移动失败',
      moveHint: '进入目标文件夹后点击「使用此目录」',
      ctxMove: '移动到…',
      noWorkspace: '远程工作区不存在，请重新添加。',
      noTarget: '没有可浏览的工作区。先在设置 → 连接中创建，或点击左侧「添加工作区」。',
      treeEmpty: '空目录',
      sourceManager: 'SSH 管理器',
      sourceConfig: '~/.ssh/config',
      tabTitle: '联动工作区目录',
      tabDesc: '联动工作区的远程与本地目录；点击文件在新标签页打开。',
      fileTabTitle: '远程文件',
      connecting: '正在连接远端…',
      needsSidebar: '未检测到 dsh-better-sidebar，无法注册侧边栏页面。安装并启用它之后即可在侧边栏浏览远程文件。',
      hostsFailed: '读取 SSH 连接失败',
      workspacesFailed: '读取远程目录失败',
      linksFailed: '读取联动工作区失败',
      settingsFailed: '读取设置失败',
      addFailed: '添加失败',
      addLinkedFailed: '创建联动工作区失败',
      openFailed: '打开失败',
      diskHint: '路径以 / 开头',
      lineCount: '行',
      nameLabel: '名称',
      hostLabel: '主机',
      pathLabel: '路径',
      statusLabel: '状态',
      latency: '延迟',
      countSuffix: ' 个',
      noEntries: '空目录',
      loadMore: '加载更多（剩余 {{count}} 项）',
      loadMoreShort: '加载更多',
      pickerTruncated: '目录项过多，仅显示前 {{count}} 项；可直接在输入框中输入路径',
      filterPlaceholder: '按名称过滤…',
      filterEmpty: '没有匹配当前过滤条件的条目',
      searchTruncated: '结果过多，仅显示前 200 条；请输入更精确的关键词',
      findPlaceholder: '查找…',
      replacePlaceholder: '替换为…',
      findCounter: '第 {{index}} / {{total}} 个',
      findNoMatch: '无匹配',
      findNext: '下一个',
      findPrev: '上一个',
      replaceOne: '替换',
      replaceAll: '全部替换',
      compareTitle: '本地与远端对比',
      compareOnlyLocal: '仅本地存在',
      compareOnlyRemote: '仅远端存在',
      compareChanged: '大小或时间不同',
      compareNone: '无',
      compareTruncated: '文件过多，对比结果已截断（最多 4000 个文件 / 12 层）',
      compareFailed: '对比失败',
      ctxCompare: '与本地对比…',
      ctxTerminalHere: '在此打开终端',
      ctxTransferSelected: '传输所选的 {{count}} 项',
      ctxDeleteSelected: '删除所选的 {{count}} 项',
      deleteManyTitle: '批量删除',
      deleteManyMessage: '确定删除所选的 {{count}} 个项目吗？此操作不可撤销。',
      dropNeedsDesktop: '当前浏览器无法读取被拖入文件的路径，请在 DSH 桌面窗口中拖拽',
      dropImported: '已导入 {{count}} 个文件',
      dropSkipped: '{{count}} 个文件被跳过（过大或不是普通文件）',
      dropDirUnsupported: '暂不支持把远程目录拖拽到本地，请使用右键「传输」',
      dropLocalDirUnsupported: '暂不支持把本地目录拖拽到远端，请使用右键「传输」',
      sheetTruncated: '仅显示前 {{rows}} 行 × {{cols}} 列',
      sheetMore: '工作表较多，仅显示前 20 个',
      noCredential: '缺少凭据',
      needPassword: '需要密码',
      sshPassword: 'SSH 密码',
      sshPasswordPlaceholder: '输入这台主机的密码',
      sshPasswordHint: '密码只保存在本机（DSH 数据目录的 ssh-credentials.json），只有本插件读取；不需要安装 SSH Manager 插件。',
      sshPasswordStored: '已保存密码，留空则保持不变',
      sshPasswordStoredHint: '已保存密码。想更换就重新输入，留空则继续使用原密码。',
      sshPasswordRequired: '请先在下面填写这台 SSH 主机的密码',
      sshVerify: '验证密码',
      sshVerifying: '验证中…',
      sshPasswordOk: '密码可用，可以继续创建。',
      sshPasswordFailed: '验证失败：',
      staleHost: 'DSH 的插件进程仍在运行旧版代码，请完全退出并重启 DSH 后再试',
      sourceManagerShort: 'SSH',
      linkedGroup: '联动工作区',
      linkedEmpty: '还没有联动工作区。联动工作区会把本地目录与远端目录配对，会话可直接编辑远端文件。',
      linkedName: '联动工作区',
      localPathLabel: '本地目录',
      remotePathLabel: '远端目录',
      mirrorLabel: '镜像存档（.remote）',
      mirrorHint: '把读取/保存过的远端文件归档到本地 .remote；开启后每 5 分钟自动检查一次远端与 .remote 的差异并修复。',
      mirrorOn: '镜像开启',
      mirrorOff: '镜像关闭',
      initialSyncHint: '创建后可用「同步」把远端文件归档到 .remote（最多 500 个文件 / 50 MB）。',
      sync: '同步',
      syncing: '同步中…',
      syncDone: '已同步 {{files}} 个文件（{{size}}）',
      syncSkipped: '{{n}} 项跳过',
      removeLinked: '移除联动',
      removeLinkedOnly: '仅移除联动',
      removeLinkedAndWorkspace: '同时移除工作区',
      removeLocalState: '删除 .local 与 .remote',
      removeWorkspaceHint: '「同时移除工作区」会把该本地目录从 DSH 工作区列表移除（会话保留，显示在未分组下）。',
      openWorkspace: '打开工作区',
      workspaceMissing: '工作区未注册',
      workspaceRegister: '注册为工作区',
      workspaceRegistered: '已注册为工作区',
      conflictDropTitle: '目标已存在',
      conflictOverwrite: '覆盖',
      conflictKeepBoth: '保留两者',
      conflictCancel: '取消',
      compareLocalMissing: '本地没有对应目录，远端独有的文件无法对比',
      compareTruncatedRemote: '远端条目过多，对比只覆盖前 4000 项',
      compareTruncatedLocal: '本地条目过多，对比只覆盖前 4000 项',
      comparePush: '推送到远端',
      comparePull: '拉取到本地',
      comparePushed: '已推送 {{name}}',
      comparePulled: '已拉取 {{name}}',
      dropSameSide: '同一工作区内请使用「移动到…」；拖拽只用于本地与远端之间',
      searchModeName: '文件名',
      searchModeContent: '内容',
      searchPlaceholderContent: '在文件内容中搜索…',
      queueRetry: '重试',
      shortcutWebNote: 'Web GUI 中 Ctrl+W、Ctrl+Tab 由浏览器占用，请在 DSH 桌面端使用这些快捷键。',
      themeTitle: '编辑器主题',
      themeHint: '远程文件编辑器的配色；主题只影响本插件的远程文件视图。',
      themeDark: '深色',
      themeLight: '浅色',
      themeSaved: '主题已保存',
      themeModeTitle: '显示模式',
      themeModeHint: '系统模式跟随 DSH 当前的浅色/深色主题；浅色/深色模式强制使用对应配色。',
      themeModeSystem: '系统',
      themeModeLight: '浅色',
      themeModeDark: '深色',
      themeModeSystemDesc: '跟随 DSH',
      themeModeLightDesc: '强制浅色',
      themeModeDarkDesc: '强制深色',
      themeSpecific: '指定主题',
      themeSpecificHint: '选择具体主题会切换到对应的浅色/深色模式。',
      themeModeSaved: '主题模式已保存',
      openFileTitle: '打开文件',
      openFileHint: '从工作区目录树中选择文件',
      toggleDirectory: '开启/关闭联动工作区目录面板',
      closeFile: '关闭文件标签',
      resizeDirectory: '拖动调整目录面板宽度；双击恢复默认宽度',
      docPreview: '预览',
      docEdit: '编辑',
      exportPdf: '导出 PDF',
      docPages: '页',
      docRotate: '旋转 90°',
      docDeletePage: '删除当前页',
      docParagraph: '段落',
      docTable: '表格',
      docSheet: '工作表',
      docSlide: '幻灯片',
      docPdfTitle: '标题',
      docPdfAuthor: '作者',
      docPageOf: '第 {page} / {total} 页',
      docExportDone: '已导出 PDF：{path}',
      docPreviewFailed: '预览失败',
      linkedTitle: '联动工作区',
      linkedHint: '本地目录与远端目录成对出现：DSH 会话在该本地目录中工作，并通过 linked_workspace 工具直接编辑远端文件。',
      localFlow: '本地目录',
      linkedFlow: '远程联动',
      localFlowHint: '选择一个已有的本地文件夹，或新建一个普通 DSH 工作区。',
      linkedFlowHint: '本地目录会成为 DSH 工作区；远端目录的文件可在该工作区的会话中直接编辑。',
      useLocalDir: '使用此目录',
      useLocalDirHint: '该目录将注册为 DSH 工作区。',
      newFolder: '新建文件夹',
      folderName: '文件夹名称',
      folderCreated: '文件夹已创建',
      nativePicker: '使用系统选择器',
      pickFolder: '选择文件夹',
      pathEdited: '路径',
      localBrowserHint: '只显示文件夹；.git、node_modules 等已隐藏。',
      emptyFolder: '没有子文件夹',
      cannotUseDir: '请选择目录',
      splitHint: '点击左侧文件在右侧分栏中打开',
      closeEditor: '关闭分栏',
      openInTab: '在标签中打开',
      linkedBadge: '本地 ⇄ 远端',
      linkedChip: '联动',
      remoteChip: '远程',
      remoteGroup: '远程工作区',
      remoteEmpty: '还没有远程工作区。远程工作区会让会话直接运行在 SSH 主机的目录里，本地不落任何项目文件。',
      remoteTitle: '远程工作区',
      remoteHint: '会话运行在远端目录：DSH 不在本地创建项目文件，模型通过 remote_workspace 与 linked_workspace 工具读写远端。',
      addRemote: '添加远程工作区',
      createRemote: '创建远程工作区',
      remoteTabTitle: '远程工作区目录',
      remoteTabDesc: '远程工作区的远端目录；点击文件在新标签页打开。',
      remotePlaceholderLabel: '本地占位目录',
      remotePlaceholderHint: '占位目录只用于把工作区注册进 DSH，不会同步任何远端文件；请不要在里面存放项目文件。',
      remoteCreateFailed: '创建远程工作区失败',
      remoteUpdateFailed: '重命名远程工作区失败',
      remoteRemoveFailed: '移除远程工作区失败',
      remoteRemoved: '已移除远程工作区',
      removeRemote: '移除远程工作区',
      remoteRemoveHint: '只移除记录与占位目录，不会删除远端文件。',
      remoteSessionHint: '在该工作区下新建会话即可直接使用远端目录。',
      flowRemote: '远程工作区',
      flowRemoteDesc: '会话运行在远端目录，本地只保留一个占位目录',
      localSideMissing: '该工作区没有本地目录',
      remoteWorkspacesFailed: '读取远程工作区失败',
      openTree: '打开目录树',
      testConnection: '测试连接',
      testFailed: '连接失败',
      rename: '重命名',
      pathLocalShort: '本地',
      pathRemoteShort: '远端',
      flowTitle: '添加工作区',
      flowLocal: '本地工作区',
      localDirStep: '1. 本地目录',
      nameStep: '2. 工作区名称',
      flowLinked: '联动工作区（本地 ⇄ 远端）',
      flowLocalDesc: '选一个本地目录并命名，作为普通 DSH 工作区',
      flowLinkedDesc: '配对本地目录与远端目录，会话可直接编辑远端文件',
      selectRemoteDir: '选择远端目录',
      selectLocalDir: '选择本地目录',
      mirrorCreate: '创建后镜像远端文件到 .remote（默认关闭）',
      workspaceNameOptional: '名称（可选）',
      creatingWorkspace: '正在创建…',
      createFailed: '创建失败',
      wsFlowBusy: '正在创建工作区…',
      nothingChosen: '请先选择路径',
      toggleShowHidden: '显示隐藏文件夹',
      showHidden: '显示隐藏',
      pickDifferent: '换一个',
      fileType: '文件类型',
      allFiles: '所有文件',
      localGroup: '本地目录',
      switchTree: '切换文件树',
      modeAllFiles: '所有文件',
      modeChanged: '已更改的文件',
      modeChanges: '所有更改',
      searchInFiles: '在文件中搜索',
      searchPlaceholder: '在文件中搜索…',
      searchHint: '输入至少 2 个字符',
      searchEmpty: '没有匹配的文件',
      searchResults: '搜索结果',
      openOptions: '打开选项菜单',
      openWithTitle: '打开方式',
      openWithEditor: '编辑器',
      openWithSystem: '系统默认应用',
      openWithCopy: '复制路径',
      openModeSaved: '打开方式已保存',
      autoSaveTitle: '自动保存',
      autoSaveHint: '编辑停顿约 1 秒后自动保存；关闭后请按 Ctrl+S 手动保存。',
      autoSaveLabel: '开启自动保存',
      autoSaveSaved: '自动保存设置已保存',
      shortcutTitle: '常用快捷键',
      shortcutHint: '与 VS Code 类似的默认快捷键；macOS 上把 Ctrl 换成 ⌘。',
      shortcutSave: '保存当前文件',
      shortcutClose: '关闭当前文件',
      shortcutSwitch: '切换文件标签',
      shortcutDirectory: '显示/隐藏目录面板',
      shortcutSearch: '在文件中搜索',
      terminalRemote: '打开远程终端',
      terminalLocal: '打开本地终端',
      terminalOpened: '已打开终端',
      terminalOpenFailed: '打开终端失败',
      dirtyCloseTitle: '文件尚未保存',
      dirtyCloseMessage: '「{{name}}」有未保存的修改。关闭前要保存吗？',
      dirtyCloseSave: '保存并关闭',
      dirtyCloseDiscard: '不保存关闭',
      saveFailed: '保存失败，文件未关闭',
      noChanges: '没有检测到更改',
      notGitRepo: '该目录不是 Git 仓库',
      changesRemote: '远端更改',
      changesLocal: '本地更改',
      changedFiles: '已更改的文件',
      noLocalDir: '该工作区没有本地目录',
      remoteTree: '远程目录',
      localTree: '本地目录',
      openFailed: '打开失败',
      copyPathDone: '已复制路径',
      mirrorAutoHint: '开启后每 5 分钟自动检查远端与 .remote 的差异并修复。',
      ctxTransfer: '传输（下载到 .remote）',
      ctxTransferLocal: '传输（到远程目录）',
      ctxDownload: '下载到默认文件夹',
      ctxQueue: '队列',
      ctxOpen: '打开',
      ctxNotepad: '用记事本编辑',
      ctxCopy: '复制',
      ctxPaste: '粘贴',
      ctxCopyPath: '复制路径',
      ctxRename: '重命名',
      ctxDelete: '删除',
      ctxChmod: '更改权限',
      ctxNew: '新建',
      ctxNewFolder: '新建文件夹',
      ctxNewFile: '新建文件',
      ctxProperties: '属性',
      queueTitle: '传输队列',
      queueEmpty: '队列为空；右击远端或本地文件选择「传输」即可加入。',
      queueQueued: '等待中',
      queueRunning: '传输中',
      queueDone: '完成',
      queueFailed: '失败',
      transferDone: '已传输 {{files}} 个文件（{{size}}）',
      transferTruncated: '（达到上限，未全部传输）',
      downloadDone: '已下载到 {{path}}',
      renameTitle: '重命名',
      renameLabel: '新名称',
      deleteTitle: '确认删除',
      deleteMessage: '删除「{{name}}」？此操作不可撤销。',
      deleteConfirm: '删除',
      newFolderTitle: '新建文件夹',
      newFileTitle: '新建文件',
      nameLabel: '名称',
      chmodTitle: '更改权限',
      chmodLabel: '八进制权限（如 644 / 0755）',
      propsTitle: '属性',
      propsName: '名称',
      propsPath: '路径',
      propsType: '类型',
      propsSize: '大小',
      propsMtime: '修改时间',
      propsMode: '权限',
      propsDir: '文件夹',
      propsFile: '文件',
      copiedEntry: '已复制，可在目标文件夹粘贴',
      pasteDone: '粘贴完成',
      newDone: '已创建',
      renameDone: '已重命名',
      deleteDone: '已删除',
      chmodDone: '权限已更新',
      actionFailed: '操作失败',
      close: '关闭',
      confirm: '确定',
      queueClear: '清空已完成',
      tooManyTabs: '同时打开的文件标签已达上限（12 个），请先关闭一些标签。',
      transferSelected: '传输所选文件/文件夹',
      selectFirst: '先在目录树中选择一个远端文件或文件夹。',
      showHidden: '显示隐藏的文件',
      hideHidden: '隐藏隐藏的文件',
      syncStarting: '正在启动同步…',
      syncRunning: '同步中：{{files}} 个文件 / {{size}}',
      syncDone2: '同步完成：{{files}} 个文件（{{size}}）',
      syncCancelled: '同步已取消',
      syncFailed: '同步失败',
      syncCancel: '取消同步',
      syncTruncated: '已达到上限，剩余文件未同步',
      sideRemote: '远端',
      sideLocal: '本地',
      changedCount: '{{n}} 个',
      refreshTree: '刷新目录',
    };

    var EN = {
      settingsNav: 'Linked workspaces',
      title: 'Linked & remote workspaces',
      welcomeEyebrow: 'DSH-LINKED-WORKSPACE',
      welcomeTitle: 'Welcome to the linked-workspaces plugin',
      welcomeLead: 'Bring a folder on an SSH host into DSH: pair it with a local folder as a linked workspace, or run sessions straight inside the remote folder. Sessions can read and edit the remote code.',
      welcomeCreate: 'Create a linked or remote workspace',
      welcomeCreateWhere: 'Settings → “Linked workspaces”, or “Add workspace” in the left column',
      welcomeBrowse: 'Browse remote files in the right sidebar',
      welcomeBrowseWhere: 'Tab bar “+” → “Linked workspace directory” or “Remote workspace directory”',
      welcomeTools: 'Let the model read and write remote code',
      welcomeToolsWhere: 'Just ask in a session; the model uses the linked_workspace tool',
      welcomePassword: 'No SSH Manager needed',
      welcomePasswordWhere: 'Type the SSH password when adding a workspace; it stays on this machine',
      welcomeStar: '★ Star the repo',
      welcomeDone: 'Got it',
      intro: 'Turn an SSH connection into a workspace: a linked workspace pairs a local folder with a remote folder, and a remote workspace runs sessions directly inside the remote folder. Either way sessions can read, search and edit remote files.',
      addWorkspace: 'Add workspace',
      addRemoteDir: 'Add remote directory',
      addLinked: 'Add linked workspace',
      createLinked: 'Create linked workspace',
      addShort: 'Add',
      refresh: 'Refresh',
      open: 'Open',
      openSidebar: 'Open sidebar',
      test: 'Test',
      remove: 'Remove',
      confirmRemove: 'Confirm remove',
      removeHint: 'Removes the record only; remote files stay untouched.',
      emptyTitle: 'No workspace to browse yet',
      emptyBody: 'Create a linked or remote workspace in Settings → Connections, or from “Add workspace” on the left.',
      emptyHint: 'No SSH connections found. Add a host in the Side card’s SSH Tunnel panel first.',
      stepHost: '1. Choose an SSH connection',
      stepPath: '2. Remote directory',
      stepLocalPath: '3. Local directory',
      stepName: '4. Workspace name',
      remoteStepName: '3. Workspace name',
      pathPlaceholder: '/home/you/project',
      localPathPlaceholder: 'C:\\Users\\you\\projects\\demo',
      localPathRequired: 'Choose or enter a local directory first',
      namePlaceholder: 'Defaults to the directory name',
      browse: 'Browse…',
      browsing: 'Browsing…',
      useThisDir: 'Use this directory',
      parentDir: 'Parent',
      home: 'Home',
      cancel: 'Cancel',
      back: 'Back',
      create: 'Create',
      creating: 'Connecting and validating…',
      loading: 'Loading…',
      retry: 'Retry',
      connected: 'Connected',
      idle: 'Not connected',
      errorState: 'Connection error',
      disconnected: 'Connection lost',
      testOk: 'Connection OK',
      testFail: 'Connection failed',
      testRunning: 'Testing…',
      saved: 'Saved',
      saving: 'Saving…',
      save: 'Save',
      reload: 'Reload',
      conflictTitle: 'The remote file changed',
      conflictBody: 'Reload before saving, or overwrite the remote file anyway.',
      forceSave: 'Force save',
      dirty: 'Unsaved changes',
      readOnly: 'Read-only',
      binaryFile: 'This is a binary file; editing it in the sidebar is not supported yet.',
      tooLarge: 'File too large ({{size}}); editing it in the sidebar is not supported yet.',
      truncated: 'Content truncated',
      fileLoadError: 'Cannot open the file',
      imageLoadError: 'Cannot preview this image',
      imageZoomIn: 'Zoom in',
      imageZoomOut: 'Zoom out',
      imageFit: 'Fit to window',
      imageActualSize: 'Actual size',
      htmlLoadError: 'Cannot preview this page',
      htmlScriptsDisabled: 'Page scripts are disabled',
      previewOnly: 'Image preview',
      csvTable: 'Table',
      csvSource: 'Source',
      csvEmpty: 'No rows to show',
      csvTruncated: 'Showing the first 1000 rows',
      moveTitle: 'Move to…',
      moveMessage: 'Choose the destination folder for "{{name}}"',
      moveDone: 'Moved',
      moveDirty: 'This file has unsaved changes; save or close it before moving',
      moveFailed: 'Move failed',
      moveHint: 'Open the destination folder, then click “Use this directory”',
      ctxMove: 'Move to…',
      noWorkspace: 'This remote workspace no longer exists. Add it again.',
      noTarget: 'No workspace to browse. Create one in Settings → Connections, or click “Add workspace” on the left.',
      treeEmpty: 'Empty directory',
      sourceManager: 'SSH Manager',
      sourceConfig: '~/.ssh/config',
      tabTitle: 'Linked Workspaces',
      tabDesc: 'Remote and local trees of linked workspaces; files open in a new tab.',
      fileTabTitle: 'Remote file',
      connecting: 'Connecting to the remote host…',
      needsSidebar: 'dsh-better-sidebar was not detected, so the sidebar pages cannot register. Install and enable it to browse remote files.',
      hostsFailed: 'Could not read SSH connections',
      workspacesFailed: 'Could not read remote directories',
      linksFailed: 'Could not read linked workspaces',
      settingsFailed: 'Could not read settings',
      addFailed: 'Could not add the workspace',
      addLinkedFailed: 'Could not create the linked workspace',
      openFailed: 'Could not open',
      diskHint: 'Absolute path starting with /',
      lineCount: 'lines',
      nameLabel: 'Name',
      hostLabel: 'Host',
      pathLabel: 'Path',
      statusLabel: 'Status',
      latency: 'Latency',
      countSuffix: '',
      noEntries: 'Empty directory',
      loadMore: 'Load more ({{count}} left)',
      loadMoreShort: 'Load more',
      pickerTruncated: 'Too many entries; only the first {{count}} are shown. Type a path directly.',
      filterPlaceholder: 'Filter by name…',
      filterEmpty: 'No entries match the current filter',
      searchTruncated: 'Too many results; showing the first 200. Narrow the query.',
      findPlaceholder: 'Find…',
      replacePlaceholder: 'Replace with…',
      findCounter: '{{index}} / {{total}}',
      findNoMatch: 'No match',
      findNext: 'Next match',
      findPrev: 'Previous match',
      replaceOne: 'Replace',
      replaceAll: 'Replace all',
      compareTitle: 'Local vs remote comparison',
      compareOnlyLocal: 'Local only',
      compareOnlyRemote: 'Remote only',
      compareChanged: 'Different size or time',
      compareNone: 'None',
      compareTruncated: 'Too many files; the comparison was truncated (4000 files / 12 levels).',
      compareFailed: 'Comparison failed',
      ctxCompare: 'Compare with local…',
      ctxTerminalHere: 'Open terminal here',
      ctxTransferSelected: 'Transfer selected ({{count}})',
      ctxDeleteSelected: 'Delete selected ({{count}})',
      deleteManyTitle: 'Delete multiple',
      deleteManyMessage: 'Delete the {{count}} selected items? This cannot be undone.',
      dropNeedsDesktop: 'This browser cannot read dropped file paths; drag files in the DSH desktop window',
      dropImported: 'Imported {{count}} file(s)',
      dropSkipped: '{{count}} file(s) skipped (too large or not a regular file)',
      dropDirUnsupported: 'Dropping a remote folder onto local is not supported yet; use Transfer instead',
      dropLocalDirUnsupported: 'Dropping a local folder onto remote is not supported yet; use Transfer instead',
      sheetTruncated: 'Showing the first {{rows}} rows × {{cols}} columns',
      sheetMore: 'Showing the first 20 worksheets only',
      noCredential: 'No credentials',
      needPassword: 'Password needed',
      sshPassword: 'SSH password',
      sshPasswordPlaceholder: 'Enter the password for this host',
      sshPasswordHint: 'Stored on this machine only (ssh-credentials.json in the DSH data directory) and read by this plugin. The SSH Manager plugin is not required.',
      sshPasswordStored: 'Password stored — leave empty to keep it',
      sshPasswordStoredHint: 'A password is already stored. Type a new one to replace it, or leave empty to keep it.',
      sshPasswordRequired: 'Enter the password for this SSH host below first',
      sshVerify: 'Check password',
      sshVerifying: 'Checking…',
      sshPasswordOk: 'The password works — you can create the workspace now.',
      sshPasswordFailed: 'Check failed:',
      staleHost: 'The plugin host is still running older code; quit and restart DSH, then retry',
      sourceManagerShort: 'SSH',
      linkedGroup: 'Linked workspaces',
      linkedEmpty: 'No linked workspaces yet. A linked workspace pairs a local folder with a remote folder so sessions can edit remote files directly.',
      linkedName: 'Linked workspace',
      localPathLabel: 'Local directory',
      remotePathLabel: 'Remote directory',
      mirrorLabel: 'Mirror archive (.remote)',
      mirrorHint: 'Archives remote files into the local .remote folder; when enabled, differences are checked and repaired every 5 minutes.',
      mirrorOn: 'Mirror on',
      mirrorOff: 'Mirror off',
      initialSyncHint: 'After creation, “Sync” archives the remote tree into .remote (up to 500 files / 50 MB).',
      sync: 'Sync',
      syncing: 'Syncing…',
      syncDone: 'Synced {{files}} files ({{size}})',
      syncSkipped: '{{n}} skipped',
      removeLinked: 'Remove link',
      removeLinkedOnly: 'Remove link only',
      removeLinkedAndWorkspace: 'Remove workspace too',
      removeLocalState: 'Delete .local and .remote',
      removeWorkspaceHint: '“Remove workspace too” also removes the local folder from the DSH workspace list (sessions stay, shown under ungrouped).',
      openWorkspace: 'Open workspace',
      workspaceMissing: 'Workspace not registered',
      workspaceRegister: 'Register as workspace',
      workspaceRegistered: 'Registered as workspace',
      conflictDropTitle: 'Target already exists',
      conflictOverwrite: 'Overwrite',
      conflictKeepBoth: 'Keep both',
      conflictCancel: 'Cancel',
      compareLocalMissing: 'The local folder has no counterpart here; remote-only entries cannot be compared',
      compareTruncatedRemote: 'Too many remote entries; the comparison covers the first 4000',
      compareTruncatedLocal: 'Too many local entries; the comparison covers the first 4000',
      comparePush: 'Push to remote',
      comparePull: 'Pull to local',
      comparePushed: 'Pushed {{name}}',
      comparePulled: 'Pulled {{name}}',
      dropSameSide: 'Within one side, use “Move to…”; dragging is for local ↔ remote only',
      searchModeName: 'Name',
      searchModeContent: 'Content',
      searchPlaceholderContent: 'Search file contents…',
      queueRetry: 'Retry',
      shortcutWebNote: 'In the Web GUI, Ctrl+W and Ctrl+Tab are reserved by the browser; use these shortcuts in the DSH desktop app.',
      themeTitle: 'Editor theme',
      themeHint: 'Colors of the remote file editor. Themes affect this plugin’s remote file views only.',
      themeDark: 'Dark',
      themeLight: 'Light',
      themeSaved: 'Theme saved',
      themeModeTitle: 'Appearance',
      themeModeHint: 'System follows the current DSH light/dark theme; Light and Dark force the matching palette.',
      themeModeSystem: 'System',
      themeModeLight: 'Light',
      themeModeDark: 'Dark',
      themeModeSystemDesc: 'Follow DSH',
      themeModeLightDesc: 'Force light',
      themeModeDarkDesc: 'Force dark',
      themeSpecific: 'Specific theme',
      themeSpecificHint: 'Picking a specific theme switches to its light/dark mode.',
      themeModeSaved: 'Appearance saved',
      openFileTitle: 'Open a file',
      openFileHint: 'Select a file from the workspace directory tree',
      toggleDirectory: 'Show or hide the linked workspace directory panel',
      closeFile: 'Close file tab',
      resizeDirectory: 'Drag to resize the directory panel; double-click to reset',
      docPreview: 'Preview',
      docEdit: 'Edit',
      exportPdf: 'Export PDF',
      docPages: 'pages',
      docRotate: 'Rotate 90°',
      docDeletePage: 'Delete current page',
      docParagraph: 'Paragraph',
      docTable: 'Table',
      docSheet: 'Sheet',
      docSlide: 'Slide',
      docPdfTitle: 'Title',
      docPdfAuthor: 'Author',
      docPageOf: 'Page {page} / {total}',
      docExportDone: 'Exported PDF: {path}',
      docPreviewFailed: 'Preview failed',
      linkedTitle: 'Linked workspaces',
      linkedHint: 'A local folder paired with a remote folder: DSH sessions work in the local folder and edit remote files through the linked_workspace tool.',
      localFlow: 'Local folder',
      linkedFlow: 'Remote link',
      localFlowHint: 'Pick an existing local folder, or create a normal DSH workspace.',
      linkedFlowHint: 'The local folder becomes a DSH workspace; its sessions can edit the remote files directly.',
      useLocalDir: 'Use this directory',
      useLocalDirHint: 'This directory will be registered as a DSH workspace.',
      newFolder: 'New folder',
      folderName: 'Folder name',
      folderCreated: 'Folder created',
      nativePicker: 'Use system picker',
      pickFolder: 'Choose folder',
      pathEdited: 'Path',
      localBrowserHint: 'Folders only; .git, node_modules and similar are hidden.',
      emptyFolder: 'No subfolders',
      cannotUseDir: 'Choose a directory first',
      splitHint: 'Click a file on the left to open it in the right pane',
      closeEditor: 'Close split',
      openInTab: 'Open in tab',
      linkedBadge: 'Local ⇄ remote',
      linkedChip: 'Linked',
      remoteChip: 'Remote',
      remoteGroup: 'Remote workspaces',
      remoteEmpty: 'No remote workspace yet. A remote workspace runs sessions directly inside an SSH host folder, so nothing is written to your machine.',
      remoteTitle: 'Remote workspaces',
      remoteHint: 'Sessions run in the remote folder: DSH creates no local project files, and the model reads and writes the remote side through the remote_workspace and linked_workspace tools.',
      addRemote: 'Add remote workspace',
      createRemote: 'Create remote workspace',
      remoteTabTitle: 'Remote workspace tree',
      remoteTabDesc: 'The remote folder of this remote workspace; click a file to open it in a new tab.',
      remotePlaceholderLabel: 'Local placeholder',
      remotePlaceholderHint: 'The placeholder only registers the workspace in DSH and never mirrors remote files; do not keep project files in it.',
      remoteCreateFailed: 'Could not create the remote workspace',
      remoteUpdateFailed: 'Could not rename the remote workspace',
      remoteRemoveFailed: 'Could not remove the remote workspace',
      remoteRemoved: 'Remote workspace removed',
      removeRemote: 'Remove remote workspace',
      remoteRemoveHint: 'Only the record and the placeholder are removed; remote files are untouched.',
      remoteSessionHint: 'Start a session in this workspace to work directly in the remote folder.',
      flowRemote: 'Remote workspace',
      flowRemoteDesc: 'Sessions run in the remote folder; only a placeholder stays local',
      localSideMissing: 'This workspace has no local folder',
      remoteWorkspacesFailed: 'Could not read remote workspaces',
      openTree: 'Open tree',
      testConnection: 'Test connection',
      testFailed: 'Connection failed',
      rename: 'Rename',
      pathLocalShort: 'Local',
      pathRemoteShort: 'Remote',
      flowTitle: 'Add workspace',
      flowLocal: 'Local workspace',
      localDirStep: '1. Local directory',
      nameStep: '2. Workspace name',
      flowLinked: 'Linked workspace (local ⇄ remote)',
      flowLocalDesc: 'Pick a local directory and name it as a normal DSH workspace',
      flowLinkedDesc: 'Pair a local folder with a remote folder; sessions edit remote files directly',
      selectRemoteDir: 'Select remote directory',
      selectLocalDir: 'Select local directory',
      mirrorCreate: 'Mirror remote files into .remote after creation (off by default)',
      workspaceNameOptional: 'Name (optional)',
      creatingWorkspace: 'Creating…',
      createFailed: 'Creation failed',
      wsFlowBusy: 'Creating workspace…',
      nothingChosen: 'Choose a path first',
      toggleShowHidden: 'Show hidden folders',
      showHidden: 'Show hidden',
      pickDifferent: 'Change',
      fileType: 'File type',
      allFiles: 'All files',
      localGroup: 'Local directory',
      switchTree: 'Switch file tree',
      modeAllFiles: 'All files',
      modeChanged: 'Changed files',
      modeChanges: 'All changes',
      searchInFiles: 'Search in files',
      searchPlaceholder: 'Search files…',
      searchHint: 'Type at least 2 characters',
      searchEmpty: 'No matching files',
      searchResults: 'Search results',
      openOptions: 'Open options',
      openWithTitle: 'Open with',
      openWithEditor: 'Editor',
      openWithSystem: 'System default app',
      openWithCopy: 'Copy path',
      openModeSaved: 'Open mode saved',
      autoSaveTitle: 'Auto save',
      autoSaveHint: 'Saves about one second after you stop typing. When off, press Ctrl+S to save.',
      autoSaveLabel: 'Enable auto save',
      autoSaveSaved: 'Auto-save setting saved',
      shortcutTitle: 'Keyboard shortcuts',
      shortcutHint: 'VS Code-like defaults; use ⌘ instead of Ctrl on macOS.',
      shortcutSave: 'Save the current file',
      shortcutClose: 'Close the current file',
      shortcutSwitch: 'Switch file tabs',
      shortcutDirectory: 'Show/hide the directory pane',
      shortcutSearch: 'Search in files',
      terminalRemote: 'Open remote terminal',
      terminalLocal: 'Open local terminal',
      terminalOpened: 'Terminal opened',
      terminalOpenFailed: 'Could not open terminal',
      dirtyCloseTitle: 'Unsaved changes',
      dirtyCloseMessage: '“{{name}}” has unsaved changes. Save before closing?',
      dirtyCloseSave: 'Save and close',
      dirtyCloseDiscard: 'Close without saving',
      saveFailed: 'Save failed; the file was left open',
      noChanges: 'No changes detected',
      notGitRepo: 'Not a Git repository',
      changesRemote: 'Remote changes',
      changesLocal: 'Local changes',
      changedFiles: 'Changed files',
      noLocalDir: 'This workspace has no local directory',
      remoteTree: 'Remote directory',
      localTree: 'Local directory',
      openFailed: 'Could not open',
      copyPathDone: 'Path copied',
      mirrorAutoHint: 'When enabled, differences between the remote tree and .remote are checked and repaired every 5 minutes.',
      ctxTransfer: 'Transfer (download to .remote)',
      ctxTransferLocal: 'Transfer (to remote directory)',
      ctxDownload: 'Download to default folder',
      ctxQueue: 'Queue',
      ctxOpen: 'Open',
      ctxNotepad: 'Edit in Notepad',
      ctxCopy: 'Copy',
      ctxPaste: 'Paste',
      ctxCopyPath: 'Copy path',
      ctxRename: 'Rename',
      ctxDelete: 'Delete',
      ctxChmod: 'Change permissions',
      ctxNew: 'New',
      ctxNewFolder: 'New folder',
      ctxNewFile: 'New file',
      ctxProperties: 'Properties',
      queueTitle: 'Transfer queue',
      queueEmpty: 'The queue is empty. Right-click a remote or local file and choose Transfer.',
      queueQueued: 'Queued',
      queueRunning: 'Transferring',
      queueDone: 'Done',
      queueFailed: 'Failed',
      transferDone: 'Transferred {{files}} files ({{size}})',
      transferTruncated: ' (limit reached; not everything was transferred)',
      downloadDone: 'Downloaded to {{path}}',
      renameTitle: 'Rename',
      renameLabel: 'New name',
      deleteTitle: 'Confirm delete',
      deleteMessage: 'Delete "{{name}}"? This cannot be undone.',
      deleteConfirm: 'Delete',
      newFolderTitle: 'New folder',
      newFileTitle: 'New file',
      nameLabel: 'Name',
      chmodTitle: 'Change permissions',
      chmodLabel: 'Octal permissions (e.g. 644 / 0755)',
      propsTitle: 'Properties',
      propsName: 'Name',
      propsPath: 'Path',
      propsType: 'Type',
      propsSize: 'Size',
      propsMtime: 'Modified',
      propsMode: 'Permissions',
      propsDir: 'Folder',
      propsFile: 'File',
      copiedEntry: 'Copied; paste it in the target folder',
      pasteDone: 'Pasted',
      newDone: 'Created',
      renameDone: 'Renamed',
      deleteDone: 'Deleted',
      chmodDone: 'Permissions updated',
      actionFailed: 'Action failed',
      close: 'Close',
      confirm: 'OK',
      queueClear: 'Clear finished',
      tooManyTabs: 'At most 12 file tabs can be open at once; close one first.',
      transferSelected: 'Transfer the selected file/folder',
      selectFirst: 'Select a remote file or folder in the tree first.',
      showHidden: 'Show hidden files',
      hideHidden: 'Hide hidden files',
      syncStarting: 'Starting sync…',
      syncRunning: 'Syncing: {{files}} files / {{size}}',
      syncDone2: 'Sync finished: {{files}} files ({{size}})',
      syncCancelled: 'Sync cancelled',
      syncFailed: 'Sync failed',
      syncCancel: 'Cancel sync',
      syncTruncated: 'Limit reached; remaining files were not synced',
      sideRemote: 'Remote',
      sideLocal: 'Local',
      changedCount: '{{n}}',
      refreshTree: 'Refresh tree',
    };

    function normalizeLocale(value) {
      return typeof value === 'string' && value.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
    }

    function readLocale(ctx) {
      try {
        var svc = ctx && ctx.get ? ctx.get('locale') : undefined;
        var snapshot = svc && typeof svc.getSnapshot === 'function' ? svc.getSnapshot() : undefined;
        if (snapshot && typeof snapshot.active === 'string') return normalizeLocale(snapshot.active);
      } catch (error) {
        /* fall through */
      }
      var lang = typeof document !== 'undefined' ? document.documentElement.getAttribute('lang') : '';
      return normalizeLocale(lang || 'zh');
    }

    function useLocale(ctx) {
      var state = useState(function () { return readLocale(ctx); });
      var locale = state[0];
      var setLocale = state[1];
      useEffect(function () {
        var svc = ctx && ctx.get ? ctx.get('locale') : undefined;
        if (!svc || typeof svc.subscribe !== 'function') return undefined;
        setLocale(readLocale(ctx));
        return svc.subscribe(function () { setLocale(readLocale(ctx)); });
      }, []);
      return locale;
    }

    function makeT(locale) {
      var dict = locale === 'zh' ? ZH : EN;
      return function t(key, vars) {
        var value = dict[key];
        if (value === undefined) value = EN[key];
        if (value === undefined) value = key;
        if (vars) {
          Object.keys(vars).forEach(function (name) {
            value = value.split('{{' + name + '}}').join(String(vars[name]));
          });
        }
        return value;
      };
    }

    // ── api ─────────────────────────────────────────────────────────────────

    function apiUrl() {
      try {
        return new URL(API_PATH, document.baseURI).toString();
      } catch (error) {
        return '/' + API_PATH;
      }
    }

    function apiCall(method, params) {
      return fetch(apiUrl(), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, params: params || {} }),
      }).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (payload) {
          if (payload && payload.ok === true) return payload.data;
          var message = payload && payload.error && payload.error.message ? payload.error.message : 'HTTP ' + response.status;
          var error = new Error(message);
          if (payload && payload.error && payload.error.code) error.code = payload.error.code;
          throw error;
        });
      });
    }

    var CODE_TEXT = {
      zh: {
        NOT_FOUND: '远端对象不存在',
        SSH_CONNECT: '无法连接到 SSH 主机',
        AUTH_FAILED: 'SSH 认证失败，请检查主机凭据',
        HOST_KEY_MISMATCH: '远端主机指纹已变化，连接被拒绝',
        TIMEOUT: '操作超时',
        FS_NOT_FOUND: '路径不存在',
        FS_PERMISSION: '没有权限访问该路径',
        FS_IS_DIR: '目标是目录',
        FS_NOT_DIR: '目标不是目录',
        FS_TOO_LARGE: '文件过大',
        FS_EXISTS: '目标已存在，请使用其他名称',
        CONFLICT: '远端文件已被修改',
        BAD_REQUEST: '请求参数无效',
      },
      en: {
        NOT_FOUND: 'The remote target does not exist',
        SSH_CONNECT: 'Cannot reach the SSH host',
        AUTH_FAILED: 'SSH authentication failed; check the host credentials',
        HOST_KEY_MISMATCH: 'The remote host key changed; the connection was rejected',
        TIMEOUT: 'The operation timed out',
        FS_NOT_FOUND: 'The path does not exist',
        FS_PERMISSION: 'Permission denied for this path',
        FS_IS_DIR: 'That path is a directory',
        FS_NOT_DIR: 'That path is not a directory',
        FS_TOO_LARGE: 'The file is too large',
        FS_EXISTS: 'The target already exists; choose another name',
        CONFLICT: 'The remote file changed',
        BAD_REQUEST: 'Invalid request',
      },
    };

    function messageOf(error, t, locale) {
      if (!error) return '';
      // `unknown method` means the page is newer than the Host process: the
      // plugin's server half only changes on restart.
      if (typeof error.message === 'string' && error.message.indexOf('unknown method:') === 0) {
        return t('staleHost') + ' (' + error.message + ')';
      }
      var known = error.code ? (locale === 'zh' ? CODE_TEXT.zh : CODE_TEXT.en)[error.code] : '';
      if (!known) return error.message || String(error);
      if (error.code === 'BAD_REQUEST' && error.message) return error.message;
      // Keep the server's own wording: "All configured authentication methods
      // failed" tells the user far more than the generic code text alone.
      var detail = typeof error.message === 'string' ? error.message.trim() : '';
      if (!detail || detail === known) return known;
      return known + (locale === 'zh' ? '：' : ': ') + detail;
    }

    function documentKindOf(path) {
      var ext = String(path || '').toLowerCase().match(/\.[^./\\]+$/);
      if (!ext) return '';
      var value = ext[0];
      if (value === '.md' || value === '.markdown') return 'markdown';
      if (value === '.pdf') return 'pdf';
      if (value === '.docx') return 'docx';
      if (value === '.xlsx') return 'xlsx';
      if (value === '.pptx') return 'pptx';
      if (value === '.csv' || value === '.tsv') return 'csv';
      if (value === '.html' || value === '.htm') return 'html';
      if (value === '.png' || value === '.jpg' || value === '.jpeg' || value === '.gif'
        || value === '.webp' || value === '.bmp' || value === '.ico' || value === '.avif'
        || value === '.svg') return 'image';
      return '';
    }

    function isCsvPath(path) {
      var ext = String(path || '').toLowerCase().match(/\.[^./\\]+$/);
      return Boolean(ext && (ext[0] === '.csv' || ext[0] === '.tsv'));
    }

    function parseDelimited(text, delimiter) {
      var rows = [];
      var row = [];
      var field = '';
      var quoted = false;
      var index = 0;
      var source = String(text || '');
      function pushField() { row.push(field); field = ''; }
      function pushRow() {
        pushField();
        rows.push(row);
        row = [];
      }
      while (index < source.length) {
        var ch = source[index];
        if (quoted) {
          if (ch === '"') {
            if (source[index + 1] === '"') { field += '"'; index += 2; continue; }
            quoted = false; index += 1; continue;
          }
          field += ch; index += 1; continue;
        }
        if (ch === '"') { quoted = true; index += 1; continue; }
        if (ch === delimiter) { pushField(); index += 1; continue; }
        if (ch === '\r') { index += 1; continue; }
        if (ch === '\n') { pushRow(); index += 1; continue; }
        field += ch; index += 1;
      }
      if (field !== '' || row.length > 0) pushRow();
      return rows;
    }

    function csvDelimiterOf(path, text) {
      if (/\.tsv$/i.test(String(path || ''))) return '\t';
      var firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
      var commas = (firstLine.match(/,/g) || []).length;
      var semicolons = (firstLine.match(/;/g) || []).length;
      return semicolons > commas ? ';' : ',';
    }

    function sanitizeDocumentHtml(html) {
      try {
        var parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
        parsed.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form').forEach(function (node) { node.remove(); });
        parsed.querySelectorAll('*').forEach(function (element) {
          Array.from(element.attributes).forEach(function (attribute) {
            if (attributeViolation(attribute.name, attribute.value, element.tagName)) {
              element.removeAttribute(attribute.name);
            }
          });
        });
        return parsed.body.innerHTML;
      } catch (error) {
        return '';
      }
    }

    function basename(path) {
      if (!path) return '';
      var clean = path.replace(/[\\/]+$/, '');
      var index = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
      return index < 0 ? clean : clean.slice(index + 1) || '/';
    }

    function dirname(path) {
      if (!path || path === '/') return '/';
      var clean = path.replace(/\/+$/, '');
      var index = clean.lastIndexOf('/');
      return index <= 0 ? '/' : clean.slice(0, index);
    }

    function formatBytes(size) {
      var value = Number(size) || 0;
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB';
      if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
      return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }

    function hexToRgba(hex, alpha) {
      try {
        var value = String(hex || '').replace('#', '');
        if (value.length === 3) value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
        var number = parseInt(value, 16);
        return 'rgba(' + ((number >> 16) & 255) + ',' + ((number >> 8) & 255) + ',' + (number & 255) + ',' + alpha + ')';
      } catch (error) {
        return 'rgba(127,127,127,' + alpha + ')';
      }
    }

    function scopeParams(scope) {
      if (!scope) return {};
      if (scope.kind === 'linked') return { linkedId: scope.id };
      if (scope.kind === 'remote') return { remoteId: scope.id };
      return { workspaceId: scope.id };
    }

    function scopeKeyOf(scope) {
      return (scope && scope.kind ? scope.kind : 'workspace') + ':' + (scope && scope.id ? scope.id : '');
    }

    // ── shared refresh bus + runtime settings ──────────────────────────────

    var bus = {
      listeners: new Set(),
      subscribe: function (listener) {
        bus.listeners.add(listener);
        return function () { bus.listeners.delete(listener); };
      },
      emit: function () {
        bus.listeners.forEach(function (listener) {
          try { listener(); } catch (error) { /* isolated */ }
        });
      },
    };

    var runtimeSettings = {
      value: { editorTheme: DEFAULT_THEME_ID, editorThemeFamily: DEFAULT_THEME_FAMILY, editorThemeMode: 'system', appThemeDark: false, fileOpenMode: 'editor', autoSave: false },
      loaded: false,
      loading: null,
      listeners: new Set(),
      get: function () { return runtimeSettings.value; },
      subscribe: function (listener) {
        runtimeSettings.listeners.add(listener);
        return function () { runtimeSettings.listeners.delete(listener); };
      },
      apply: function (next) {
        runtimeSettings.value = Object.assign({}, runtimeSettings.value, next);
        runtimeSettings.listeners.forEach(function (listener) {
          try { listener(); } catch (error) { /* isolated */ }
        });
      },
      load: function () {
        if (runtimeSettings.loaded) return Promise.resolve(runtimeSettings.value);
        if (runtimeSettings.loading) return runtimeSettings.loading;
        runtimeSettings.loading = apiCall('settings.get').then(function (settings) {
          runtimeSettings.loaded = true;
          runtimeSettings.loading = null;
          var openMode = settings && (settings.fileOpenMode === 'system' || settings.fileOpenMode === 'copy') ? settings.fileOpenMode : 'editor';
          var mode = settings && (settings.editorThemeMode === 'light' || settings.editorThemeMode === 'dark') ? settings.editorThemeMode : 'system';
          runtimeSettings.apply({ editorTheme: settings && settings.editorTheme ? settings.editorTheme : DEFAULT_THEME_ID, editorThemeFamily: themeFamilyFor(settings), editorThemeMode: mode, fileOpenMode: openMode, autoSave: Boolean(settings && settings.autoSave) });
          return runtimeSettings.value;
        }).catch(function () {
          runtimeSettings.loaded = true;
          runtimeSettings.loading = null;
          return runtimeSettings.value;
        });
        return runtimeSettings.loading;
      },
      saveThemeFamily: function (familyId) {
        return apiCall('settings.update', { editorThemeFamily: familyId }).then(function (settings) {
          runtimeSettings.loaded = true;
          runtimeSettings.apply({ editorThemeFamily: settings && settings.editorThemeFamily ? settings.editorThemeFamily : familyId });
          return runtimeSettings.value;
        });
      },
      saveThemeMode: function (mode) {
        return apiCall('settings.update', { editorThemeMode: mode }).then(function (settings) {
          runtimeSettings.loaded = true;
          runtimeSettings.apply({ editorThemeMode: settings && settings.editorThemeMode ? settings.editorThemeMode : mode });
          return runtimeSettings.value;
        });
      },
      saveAutoSave: function (enabled) {
        return apiCall('settings.update', { autoSave: Boolean(enabled) }).then(function (settings) {
          runtimeSettings.loaded = true;
          runtimeSettings.apply({ autoSave: Boolean(settings && settings.autoSave) });
          return runtimeSettings.value;
        });
      },
    };

    function themeFamilyFor(settings) {
      var explicit = settings && settings.editorThemeFamily;
      var families = typeof EDITOR_THEME_FAMILIES !== 'undefined' ? EDITOR_THEME_FAMILIES : [];
      if (explicit && families.some(function (family) { return family.id === explicit; })) return explicit;
      var legacy = String(settings && settings.editorTheme || '');
      var derived = legacy.startsWith('solarized') ? 'solarized'
        : legacy.startsWith('one') ? 'one'
          : legacy.startsWith('dracula') ? 'dracula'
            : legacy.startsWith('monokai') ? 'monokai'
              : legacy.startsWith('nord') ? 'nord'
                : legacy.startsWith('vs-') ? 'vscode'
                  : legacy.startsWith('xcode') ? 'xcode'
                    : legacy.startsWith('catppuccin') ? 'catppuccin'
                      : 'github';
      return derived;
    }

    function resolveEditorTheme(settings) {
      var families = typeof EDITOR_THEME_FAMILIES !== 'undefined' ? EDITOR_THEME_FAMILIES : [];
      var familyId = themeFamilyFor(settings);
      var family = families.filter(function (entry) { return entry.id === familyId; })[0] || families[0];
      if (!family) return DEFAULT_THEME_ID;
      var mode = settings && settings.editorThemeMode ? settings.editorThemeMode : 'system';
      var dark = mode === 'dark' ? true : mode === 'light' ? false : Boolean(settings && settings.appThemeDark);
      return getTheme(dark ? family.dark : family.light).id;
    }

    function useRuntimeSettings() {
      var state = useState(function () { return runtimeSettings.get(); });
      var value = state[0];
      var setValue = state[1];
      useEffect(function () {
        runtimeSettings.load();
        return runtimeSettings.subscribe(function () { setValue(runtimeSettings.get()); });
      }, []);
      return value;
    }

    // ── styles ──────────────────────────────────────────────────────────────

    var CSS = [
      '.rw-root{display:flex;flex-direction:column;gap:16px;width:100%;max-width:820px;box-sizing:border-box;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.rw-intro{margin:0;padding:0 2px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}',
      '.rw-title{margin:0;font-size:20px;line-height:28px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rw-sub{margin:2px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.rw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .12s ease,border-color .12s ease,opacity .12s ease}',
      '.rw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.rw-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}',
      '.rw-btn-primary:hover{filter:brightness(1.06)}',
      'body[data-ds-dark-theme] .rw-btn-primary{color:#000}',
      '.rw-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}',
      '.rw-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}',
      '.rw-btn-sm{height:26px;padding:0 9px;font-size:12px;border-radius:7px}',
      '.rw-group{display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2)}',
      '.rw-group-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.rw-group-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rw-group-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-list{display:flex;flex-direction:column;gap:10px}',
      '.rw-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-sizing:border-box}',
      '.rw-card-head{display:flex;align-items:flex-start;gap:10px;min-width:0}',
      '.rw-icon-chip{display:flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.rw-icon-chip-link{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.rw-card-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.rw-name{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}',
      '.rw-chip-link{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}',
      '.rw-path{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      // Injected into the host's workspace hover preview, which always paints on
      // a fixed dark card, so these colours cannot follow the theme tokens.
      '.rw-hover-status{margin:1px 0 0;font-size:12px;line-height:18px;color:rgb(207,211,214)}',
      '.rw-hover-status.is-on{color:#3fb950}',
      '.rw-hover-status.is-off{color:#f85149}',
      '.rw-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.rw-meta-text{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}',
      '.rw-pair-item{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.rw-pair-label{font-size:10.5px;line-height:15px;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.rw-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.rw-dot-ok{background:var(--dsw-alias-state-success-primary)}',
      '.rw-dot-error{background:var(--dsw-alias-state-error-primary)}',
      '.rw-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:34px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;text-align:center}',
      '.rw-empty-title{font-size:14px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rw-empty-body{max-width:440px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-banner{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:9px;font-size:12.5px;line-height:19px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}',
      '.rw-banner-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}',
      '.rw-banner-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dsw-alias-bg-layer-1))}',
      '.rw-banner-success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,var(--dsw-alias-bg-layer-1))}',
      '.rw-add{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-2);box-sizing:border-box}',
      '.rw-add-title{font-size:14px;line-height:22px;font-weight:600}',
      '.rw-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.rw-label{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.rw-hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-input{height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;min-width:0;box-sizing:border-box}',
      '.rw-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.rw-input-mono{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:12.5px}',
      '.rw-input-row{display:flex;align-items:center;gap:8px;min-width:0}',
      '.rw-input-row .rw-input{flex:1 1 auto}',
      '.rw-host-list{display:flex;flex-direction:column;gap:2px;max-height:216px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.rw-host{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:7px;border:1px solid transparent;cursor:pointer;background:transparent;font:inherit;color:inherit;text-align:left;width:100%;box-sizing:border-box}',
      '.rw-host:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-host.is-on{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}',
      '.rw-host-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}',
      '.rw-host-name{font-size:13px;line-height:19px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-host-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-browser{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.rw-drives{display:flex;flex-wrap:wrap;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rw-drive{padding:2px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}',
      '.rw-drive.is-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.rw-browser-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);min-width:0}',
      '.rw-breadcrumb{display:flex;align-items:center;gap:2px;flex:1 1 auto;min-width:0;overflow:hidden;font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.rw-crumb{background:transparent;border:0;padding:2px 4px;border-radius:5px;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px}',
      '.rw-crumb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
      '.rw-crumb-sep{color:var(--dsw-alias-label-tertiary);flex:none}',
      '.rw-browser-list{max-height:200px;overflow:auto;padding:4px}',
      '.rw-browser-row{display:flex;align-items:center;gap:7px;width:100%;padding:5px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;text-align:left;box-sizing:border-box}',
      '.rw-browser-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-browser-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-browser-actions{display:flex;justify-content:space-between;align-items:center;gap:8px}',
      '.rw-spin{animation:rw-spin .9s linear infinite;transform-origin:center}',
      '@keyframes rw-spin{to{transform:rotate(360deg)}}',
      '.rw-spinner{display:inline-flex;flex:none}',
      '.rw-workbench{display:flex;flex-direction:column;height:100%;max-height:calc(100vh - 150px);min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.rw-workbench-body{display:flex;flex:1 1 auto;min-height:0;position:relative}',
      '.rw-tree-pane{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1 1 auto}',
      '.rw-tree-pane.is-split{flex:0 0 38%;min-width:150px;max-width:52%;border-right:1px solid var(--dsw-alias-border-l1)}',
      '.rw-editor-pane{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;border-left:1px solid var(--dsw-alias-border-l1)}',
      '.rw-tree-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:8px}',
      '.rw-tree-toolbar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}',
      '.rw-tree-toolbar-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary);flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.rw-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary)}',
      '.rw-tree-group{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}',
      '.rw-tree-group-label{display:flex;align-items:center;gap:6px;padding:2px 6px;font-size:10.5px;line-height:16px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.rw-tree-ws{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.rw-tree-ws + .rw-tree-ws{margin-top:6px}',
      '.rw-tree-ws-head{display:flex;align-items:center;gap:7px;padding:7px 8px;cursor:pointer;background:transparent;border:0;width:100%;font:inherit;color:inherit;text-align:left}',
      '.rw-tree-ws-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-tree-ws-title{display:flex;flex-direction:column;gap:0;min-width:0;flex:1 1 auto}',
      '.rw-tree-ws-name{font-size:12.5px;line-height:18px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-tree-ws-sub{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-tree-body{padding:2px 4px 6px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.rw-row{display:flex;align-items:center;gap:5px;width:100%;min-width:0;height:23px;padding:0 6px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;text-align:left;box-sizing:border-box}',
      '.rw-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4176e6));outline-offset:-1px}',
      '.rw-input:focus-visible,.rw-textarea:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4176e6));outline-offset:-1px}',
      '.rw-btn:focus-visible,.rw-doc-tab:focus-visible,.rw-icon-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4176e6));outline-offset:1px}',
      '.rw-row.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}',
      '.rw-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}',
      '.rw-row-size{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.rw-chevron{display:flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}',
      '.rw-chevron.is-open{transform:rotate(90deg)}',
      '.rw-file-icon{display:flex;flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.rw-dir-icon{display:flex;flex:none;color:#dcb67a}',
      '.rw-row-msg{display:flex;align-items:center;gap:6px;padding:3px 8px 3px 24px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-weight:700;letter-spacing:-.02em;line-height:1;box-sizing:border-box}',
      '.rw-editor{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--rw-bg,var(--dsw-alias-bg-base));color:var(--rw-fg,var(--dsw-alias-label-primary))}',
      '.rw-editor-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--rw-border,var(--dsw-alias-border-l1));min-width:0;background:var(--rw-head-bg,var(--dsw-alias-bg-layer-1))}',
      '.rw-editor-title{display:flex;flex-direction:column;gap:0;min-width:0;flex:1 1 auto}',
      '.rw-editor-name{font-size:12.5px;line-height:18px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-editor-path{font-size:10.5px;line-height:15px;opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,"Cascadia Code",Consolas,monospace}',
      '.rw-editor-body{display:flex;flex:1 1 auto;min-height:0;position:relative}',
      '.rw-code{display:flex;flex:1 1 auto;min-height:0;position:relative}',
      '.rw-gutter{flex:none;overflow:hidden;padding:8px 6px 8px 8px;text-align:right;color:var(--rw-gutter-fg,var(--dsw-alias-label-tertiary));background:var(--rw-gutter-bg,var(--dsw-alias-bg-layer-1));border-right:1px solid var(--rw-border,var(--dsw-alias-border-l1));user-select:none;z-index:2}',
      '.rw-gutter-inner{font:12px/18px ui-monospace,"Cascadia Code",Consolas,monospace;white-space:pre}',
      '.rw-code-area{position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden}',
      '.rw-highlight{position:absolute;inset:0;margin:0;overflow:hidden;pointer-events:none;padding:8px 10px 8px 6px;font:12.5px/18px ui-monospace,"Cascadia Code",Consolas,monospace;white-space:pre;tab-size:4;color:var(--rw-fg,var(--dsw-alias-label-primary));z-index:0}',
      '.rw-textarea{position:absolute;inset:0;width:100%;height:100%;resize:none;border:0;outline:none;background:transparent;color:transparent;caret-color:var(--rw-caret,var(--dsw-alias-label-primary));padding:8px 10px 8px 6px;font:12.5px/18px ui-monospace,"Cascadia Code",Consolas,monospace;white-space:pre;overflow:auto;tab-size:4;z-index:1}',
      '.rw-textarea::selection{background:var(--rw-selection,rgba(90,140,220,.35))}',
      '.rw-textarea::-webkit-scrollbar{width:10px;height:10px}',
      '.rw-editor-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:4px 10px;border-top:1px solid var(--rw-border,var(--dsw-alias-border-l1));font-size:10.5px;line-height:16px;color:var(--rw-status-fg,var(--dsw-alias-label-tertiary));background:var(--rw-head-bg,var(--dsw-alias-bg-layer-1))}',
      '.rw-status-chip{display:inline-flex;align-items:center;gap:4px}',
      '.rw-status-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.rw-status-error{color:var(--dsw-alias-state-error-primary)}',
      '.rw-status-ok{color:var(--dsw-alias-state-success-primary)}',
      '.rw-editor-message{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:18px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}',
      '.rw-editor-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.rw-fill{flex:1 1 auto;min-height:0}',
      '.rw-muted{color:var(--dsw-alias-label-tertiary)}',
      '.rw-block{display:block}',
      '.rw-inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.rw-kbd{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:10px;padding:1px 4px;border-radius:4px;border:1px solid var(--rw-border,var(--dsw-alias-border-l2));background:var(--rw-gutter-bg,var(--dsw-alias-bg-layer-1))}',
      '.rw-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.rw-switch input{position:absolute;opacity:0;width:0;height:0}',
      '.rw-switch-track{position:relative;flex:none;width:30px;height:18px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);transition:background .12s ease,border-color .12s ease}',
      '.rw-switch-thumb{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .12s ease,background .12s ease}',
      '.rw-switch input:checked + .rw-switch-track{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);border-color:transparent}',
      '.rw-switch input:checked + .rw-switch-track .rw-switch-thumb{transform:translateX(12px);background:var(--dsw-alias-bg-base)}',
      '.rw-theme-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px}',
      '.rw-theme-card{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;font:inherit;color:inherit;text-align:left}',
      '.rw-theme-card.is-on{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
      '.rw-theme-preview{display:flex;align-items:center;justify-content:space-between;gap:6px;height:44px;padding:0 10px;border-radius:7px;font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:11px;overflow:hidden}',
      '.rw-theme-label{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:12px;line-height:18px}',
      '.rw-theme-kind{font-size:10px;line-height:14px;padding:0 4px;border-radius:3px;border:1px solid currentColor;color:var(--dsw-alias-label-tertiary)}',
      '.rw-tabs{display:flex;gap:4px;padding:3px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
      '.rw-tab{flex:1 1 auto;height:28px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:7px;background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.rw-tab.is-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 0 0 1px var(--dsw-alias-border-l1)}',
      '.rw-modal-backdrop{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.34)}',
      '.rw-modal{display:flex;flex-direction:column;width:min(620px,100%);max-height:min(760px,88vh);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden}',
      '.rw-modal-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rw-modal-title{font-size:15px;line-height:22px;font-weight:600;flex:1 1 auto}',
      '.rw-modal-body{display:flex;flex-direction:column;gap:12px;padding:14px 16px;overflow:auto}',
      '.rw-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.rw-option-card{display:flex;flex-direction:column;gap:4px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;font:inherit;color:inherit;text-align:left}',
      '.rw-option-card.is-on{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}',
      '.rw-option-title{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;font-weight:600}',
      '.rw-option-desc{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-warn-box{padding:8px 10px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,var(--dsw-alias-bg-layer-1));font-size:12px;line-height:18px}',
      '.rw-setting-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}',
      '.rw-shortcut-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px 16px}',
      '.rw-shortcut-row{display:flex;align-items:center;gap:10px;min-height:28px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.rw-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:64px;padding:2px 7px;border:1px solid var(--dsw-alias-border-l2);border-bottom-width:2px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:11px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}',
      '@media (max-width:720px){.rw-theme-grid{grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}.rw-pair{grid-template-columns:minmax(0,1fr)}}',
      '.rw-linked-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0;position:relative;z-index:5}',
      '.rw-menu-wrap{position:relative}',
      '.rw-icon-btn.is-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.rw-popover{position:absolute;top:calc(100% + 4px);right:0;z-index:45;min-width:168px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 32px rgba(0,0,0,.28)}',
      '.rw-popover-label{padding:4px 8px 2px;font-size:10.5px;line-height:16px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.rw-popover-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;text-align:left}',
      '.rw-popover-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-popover-item.is-on{color:var(--dsw-alias-brand-primary)}',
      '.rw-menu-backdrop{position:fixed;inset:0;z-index:40}',
      '.rw-searchbar{display:flex;align-items:center;gap:6px;margin:6px 8px 0;padding:0 8px;height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);flex:none}',
      '.rw-searchbar input{flex:1 1 auto;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;min-width:0}',
      '.rw-chips{display:flex;gap:4px;padding:6px 8px 0;overflow:auto;flex:none}',
      '.rw-chip-btn{display:inline-flex;align-items:center;gap:4px;max-width:190px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none}',
      '.rw-chip-btn.is-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}',
      '.rw-linked-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
      '.rw-tree-section{display:flex;flex-direction:column;min-height:0;flex:1 1 50%}',
      '.rw-tree-section.is-bottom{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.rw-tree-section-head{display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:10.5px;line-height:16px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.rw-tree-section-body{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 6px}',
      '.rw-change-list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px}',
      '.rw-change-group{margin-bottom:10px}',
      '.rw-change-group-title{display:flex;align-items:center;gap:6px;padding:2px 4px 4px;font-size:10.5px;line-height:16px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.rw-change-row{display:flex;align-items:center;gap:6px;width:100%;padding:3px 4px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;text-align:left;box-sizing:border-box}',
      '.rw-change-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-change-row.is-disabled{opacity:.45;cursor:default}',
      '.rw-st-badge{display:inline-flex;align-items:center;justify-content:center;flex:none;width:16px;height:16px;border-radius:3px;font-family:ui-monospace,Consolas,monospace;font-size:9px;font-weight:700;color:#fff}',
      '.rw-st-modified{background:#e2a03f}.rw-st-added{background:#3fb950}.rw-st-deleted{background:#f85149}.rw-st-renamed{background:#58a6ff}.rw-st-untracked{background:#8b949e}.rw-st-conflicted{background:#d29922}.rw-st-copied{background:#58a6ff}',
      '.rw-change-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}',
      '.rw-change-meta{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-search-results{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px}',
      '.rw-result-row{display:flex;align-items:center;gap:6px;width:100%;padding:4px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;text-align:left}',
      '.rw-result-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-hint-row{padding:9px 6px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-linked-notice{margin:6px 8px 0}',
      '.rw-ctx-backdrop{position:fixed;inset:0;z-index:70}',
      '.rw-workspace-body{display:flex;flex:1 1 auto;min-height:0;min-width:0}',
      '.rw-content-pane{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0}',
      '.rw-directory-pane{display:flex;flex-direction:column;flex:0 0 auto;max-width:60%;min-width:240px;min-height:0;border-left:1px solid var(--dsw-alias-border-l1)}',
      '.rw-pane-resizer{flex:0 0 6px;align-self:stretch;cursor:col-resize;background:transparent;position:relative;z-index:2;touch-action:none}',
      '.rw-doc{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;min-width:0;background:var(--dsw-alias-bg-base)}',
      '.rw-doc-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none;flex-wrap:wrap}',
      '.rw-doc-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:auto;padding:10px}',
      '.rw-doc-textarea{width:100%;min-height:260px;flex:1 1 auto;resize:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:12.5px/18px ui-monospace,"Cascadia Code",Consolas,monospace;outline:none;box-sizing:border-box}',
      '.rw-doc-preview{max-width:920px;margin:0 auto;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.65;overflow-wrap:anywhere}',
      '.rw-doc-preview h1,.rw-doc-preview h2,.rw-doc-preview h3{line-height:1.3;margin:1em 0 .5em}',
      '.rw-doc-preview pre{background:var(--dsw-alias-bg-layer-2);padding:10px;border-radius:8px;overflow:auto}',
      '.rw-doc-preview table{border-collapse:collapse;margin:.8em 0}',
      '.rw-doc-preview th,.rw-doc-preview td{border:1px solid var(--dsw-alias-border-l2);padding:5px 8px}',
      '.rw-doc-preview img{max-width:100%}',
      '.rw-doc-preview blockquote{border-left:3px solid var(--dsw-alias-border-l2);margin:0;padding-left:10px;color:var(--dsw-alias-label-secondary)}',
      '.rw-doc-pdf-page{display:block;max-width:100%;margin:0 auto 10px;border:1px solid var(--dsw-alias-border-l2);box-shadow:0 2px 10px rgba(0,0,0,.08);background:#fff}',
      '.rw-doc-field{display:flex;align-items:center;gap:8px;margin:6px 0}',
      '.rw-doc-field label{font-size:11.5px;color:var(--dsw-alias-label-tertiary);min-width:38px}',
      '.rw-doc-input{height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;box-sizing:border-box}',
      '.rw-doc-block{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px;margin:0 0 8px;background:var(--dsw-alias-bg-layer-1)}',
      '.rw-doc-block-label{font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}',
      '.rw-doc-block textarea{width:100%;min-height:52px;resize:vertical;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none;box-sizing:border-box}',
      '.rw-doc-table{border-collapse:collapse;width:100%;margin:0 0 10px;font-size:12px}',
      '.rw-doc-table td{border:1px solid var(--dsw-alias-border-l2);padding:0}',
      '.rw-doc-table input{width:100%;border:0;background:transparent;padding:4px 5px;font:inherit;color:var(--dsw-alias-label-primary);outline:none;box-sizing:border-box}',
      '.rw-doc-tabs{display:flex;gap:3px;padding:5px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow:auto;flex:none}',
      '.rw-doc-note{padding:3px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rw-load-more{width:100%;border:0;background:transparent;cursor:pointer;text-align:left;font:inherit;font-size:11.5px;color:var(--dsw-alias-brand-primary)}',
      '.rw-load-more:hover{text-decoration:underline}',
      '.rw-load-more:disabled{opacity:.6;cursor:default}',
      '.rw-filter-row{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rw-filter-row .rw-input{width:100%}',
      '.rw-find-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-l1)}',
      '.rw-find-bar .rw-input{height:26px;font-size:11.5px;min-width:120px;flex:0 1 160px}',
      '.rw-find-counter{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.rw-compare-root{font-family:ui-monospace,Consolas,monospace;font-size:11px}',
      '.rw-compare-section{margin:0 0 8px}',
      '.rw-compare-title{font-size:11.5px;font-weight:600;padding:2px 0}',
      '.rw-compare-empty{font-size:11px;color:var(--dsw-alias-label-tertiary);padding-left:8px}',
      '.rw-compare-row{display:flex;width:100%;gap:8px;align-items:center;border:0;background:transparent;cursor:pointer;text-align:left;font:inherit;font-size:11px;padding:3px 6px;border-radius:4px}',
      '.rw-compare-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rw-compare-path{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-compare-size{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}',
      '.rw-compare-item{display:flex;align-items:center;gap:4px}',
      '.rw-compare-item .rw-compare-row{flex:1 1 auto;min-width:0}',
      '.rw-compare-actions{display:flex;gap:4px;flex:0 0 auto;padding-right:4px}',
      '.rw-compare-act{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;padding:1px 6px;border-radius:4px;cursor:pointer;white-space:nowrap}',
      '.rw-compare-act:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.rw-search-mode{display:flex;gap:2px;flex:0 0 auto}',
      '.rw-doc-find{flex:0 0 auto}',
      '.rw-dialog-note{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 0}',
      '.rw-dialog-error{color:var(--dsw-alias-state-error-primary)}',
      '.rw-row.is-drop-target{outline:1px dashed var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.rw-doc-tab{padding:2px 8px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}',
      '.rw-doc-tab.is-on{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.rw-doc-grid{width:100%;border-collapse:collapse;font-size:11.5px}',
      '.rw-doc-grid th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);font-weight:500;color:var(--dsw-alias-label-tertiary);padding:3px 4px;border:1px solid var(--dsw-alias-border-l1);z-index:1}',
      '.rw-doc-grid td{border:1px solid var(--dsw-alias-border-l1);padding:0;min-width:60px}',
      '.rw-doc-grid input{width:100%;border:0;background:transparent;padding:3px 4px;font:inherit;color:var(--dsw-alias-label-primary);outline:none;box-sizing:border-box}',
      '.rw-doc-status{display:flex;align-items:center;gap:8px;padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);flex:none}',
      '.rw-pane-resizer:hover,.rw-pane-resizer:active{background:var(--dsw-alias-brand-primary)}',
      '.rw-directory-head{display:flex;align-items:center;gap:6px;padding:5px 8px;font-size:10.5px;line-height:16px;letter-spacing:.03em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.rw-directory-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
      '.rw-file-tabs{display:flex;align-items:stretch;gap:2px;min-height:30px;padding:3px 5px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}',
      '.rw-file-tab{display:inline-flex;align-items:center;gap:5px;max-width:180px;padding:2px 5px 2px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:18px;cursor:pointer;flex:none}',
      '.rw-file-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.rw-file-tab.is-on{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}',
      '.rw-file-tab-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-file-tab-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}',
      '.rw-file-tab-close{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.rw-file-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary)}',
      '.rw-content-body{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden}',
      '.rw-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;flex:1 1 auto;padding:24px;color:var(--dsw-alias-label-tertiary);text-align:center}',
      '.rw-placeholder-title{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.rw-placeholder-hint{font-size:11.5px;line-height:17px}',
      '.rw-tree-toolbar-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rw-mode-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}',
      '.rw-mode-card{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}',
      '.rw-mode-card:hover{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.4))}',
      '.rw-mode-card.is-on{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}',
      '.rw-mode-name{font-size:12px;font-weight:600;line-height:17px}',
      '.rw-mode-desc{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-ctx-menu{position:fixed;min-width:214px;max-height:min(70vh,520px);overflow:auto;padding:4px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 36px rgba(0,0,0,.3);z-index:71;font-size:12px;user-select:none}',
      '.rw-ctx-item{display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;padding:5px 14px;border:0;border-radius:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;cursor:pointer;text-align:left;position:relative}',
      '.rw-ctx-item:hover:not(.is-disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.rw-ctx-item.is-disabled{opacity:.42;cursor:default}',
      '.rw-ctx-sep{height:1px;margin:4px 0;background:var(--dsw-alias-border-l1)}',
      '.rw-ctx-arrow{display:inline-flex;color:var(--dsw-alias-label-tertiary)}',
      '.rw-ctx-sub{display:none;position:absolute;left:100%;top:-5px;min-width:150px;padding:4px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-overlay);box-shadow:0 12px 36px rgba(0,0,0,.3)}',
      '.rw-ctx-item.has-sub:hover .rw-ctx-sub{display:block}',
      '.rw-dialog-backdrop{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center}',
      '.rw-dialog{width:min(430px,calc(100vw - 48px));max-height:min(72vh,560px);overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 50px rgba(0,0,0,.34);padding:14px}',
      '.rw-dialog-title{font-size:13px;font-weight:600;line-height:20px;margin-bottom:9px}',
      '.rw-dialog-label{display:block;margin:7px 0 4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-dialog-input{width:100%;box-sizing:border-box;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}',
      '.rw-dialog-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:12px}',
      '.rw-dialog-message{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      // First-run welcome card: sits in shell.overlay, so the backdrop is its own.
      '.rw-welcome-backdrop{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}',
      '.rw-welcome{position:relative;width:min(470px,100%);max-height:min(86vh,700px);overflow:auto;box-sizing:border-box;padding:22px 22px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 26px 70px rgba(0,0,0,.42);color:var(--dsw-alias-label-primary)}',
      '.rw-welcome-x{position:absolute;top:12px;right:12px;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.rw-welcome-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.rw-welcome-eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.rw-welcome-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary)}',
      '.rw-welcome-title{margin:8px 0 0;font-size:19px;line-height:26px;font-weight:650}',
      '.rw-welcome-lead{margin:8px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.rw-welcome-rows{display:flex;flex-direction:column;gap:8px;margin:16px 0 0}',
      '.rw-welcome-row{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-base)}',
      '.rw-welcome-row-main{font-size:13px;line-height:19px;font-weight:600}',
      '.rw-welcome-row-where{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.rw-welcome-foot{display:flex;align-items:center;gap:10px;margin-top:18px}',
      '.rw-welcome-foot .rw-btn{height:32px;padding:0 16px;text-decoration:none}',
      '.rw-props{display:grid;grid-template-columns:70px minmax(0,1fr);gap:5px 9px;font-size:12px;line-height:18px}',
      '.rw-props-key{color:var(--dsw-alias-label-tertiary)}',
      '.rw-props-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-image-preview{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.rw-image-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-width:0;flex:none}',
      '.rw-image-head .rw-actions{display:flex;align-items:center;gap:6px;flex:none}',
      '.rw-image-stage{display:block;flex:1 1 auto;min-height:0;overflow:auto;padding:18px;text-align:center;background:repeating-conic-gradient(var(--dsw-alias-bg-layer-1) 0% 25%,var(--dsw-alias-bg-base) 0% 50%) 50%/18px 18px}',
      '.rw-image-canvas{display:inline-block;min-width:100%;min-height:100%;box-sizing:border-box}',
      '.rw-image{display:inline-block;max-width:none;max-height:none;vertical-align:top;border-radius:4px;box-shadow:0 2px 16px rgba(0,0,0,.18)}',
      '.rw-image-tools{display:flex;align-items:center;gap:4px;flex:none}',
      '.rw-image-zoom{min-width:52px;text-align:center;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.rw-html-preview{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
      '.rw-html-stage{flex:1 1 auto;min-height:0;background:#fff;position:relative}',
      '.rw-html-frame{display:block;width:100%;height:100%;border:0;background:#fff}',
      '.rw-csv-wrap{flex:1 1 auto;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base)}',
      '.rw-csv-table{border-collapse:collapse;font:12px/18px ui-monospace,"Cascadia Code",Consolas,monospace;min-width:100%}',
      '.rw-csv-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-weight:600;text-align:left;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.rw-csv-table td{padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);vertical-align:top;max-width:360px;overflow-wrap:anywhere}',
      '.rw-csv-table tr:nth-child(even) td{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 52%,transparent)}',
      '.rw-csv-note{padding:5px 9px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.rw-queue-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}',
      '.rw-queue-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-queue-state{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}',
    ].join('\n');

    function installStyles() {
      var id = 'dsh-linked-workspace/styles';
      if (typeof document === 'undefined' || !document.head) return function () {};
      var existing = document.querySelector('style[data-plugin-css="' + id + '"]');
      if (existing) return function () {};
      var tag = document.createElement('style');
      tag.setAttribute('data-plugin', 'dsh-linked-workspace');
      tag.setAttribute('data-plugin-css', id);
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () {
        try { tag.remove(); } catch (error) { /* ignore */ }
      };
    }

    // ── workspace row icons ────────────────────────────────────────────────
    // DSH renders a fixed folder glyph for every workspace row; the sidebar
    // gives plugins no per-row icon slot. This stylesheet swaps that glyph for
    // the icon of the workspace kind (identified by the documented
    // data-row-key attribute). If the host markup ever changes the selector
    // simply stops matching and the folder glyph stays — a safe degradation.

    // Filled 1024-unit shapes, shared by the row masks and the JSX icons so a
    // workspace looks the same in the sidebar, the settings cards, the dialogs
    // and the sidebar "+" menu.
    // Linked workspace: two interlocking chain links (local ⇄ remote).
    var LINKED_ICON_PATHS = [
      'M861.866667 164.266667c-87.466667-87.466667-230.4-89.6-320-2.133334l-68.266667 68.266667c-12.8 12.8-12.8 32 0 44.8s32 12.8 44.8 0l68.266667-68.266667c64-61.866667 166.4-61.866667 230.4 2.133334 64 64 64 168.533333 2.133333 232.533333l-117.333333 119.466667c-34.133333 34.133333-81.066667 51.2-128 49.066666-46.933333-4.266667-91.733333-27.733333-119.466667-66.133333-10.666667-14.933333-29.866667-17.066667-44.8-6.4-14.933333 10.666667-17.066667 29.866667-6.4 44.8 40.533333 53.333333 100.266667 87.466667 166.4 91.733333h17.066667c59.733333 0 119.466667-23.466667 162.133333-68.266666l117.333333-119.466667c83.2-89.6 83.2-234.666667-4.266666-322.133333z',
      'M505.6 750.933333l-66.133333 68.266667c-64 61.866667-166.4 61.866667-230.4-2.133333-64-64-64-168.533333-2.133334-232.533334l117.333334-119.466666c34.133333-34.133333 81.066667-51.2 128-49.066667 46.933333 4.266667 91.733333 27.733333 119.466666 66.133333 10.666667 14.933333 29.866667 17.066667 44.8 6.4 14.933333-10.666667 17.066667-29.866667 6.4-44.8-40.533333-53.333333-100.266667-87.466667-166.4-91.733333-66.133333-4.266667-130.133333 19.2-177.066666 66.133333l-117.333334 119.466667c-85.333333 89.6-85.333333 234.666667 2.133334 322.133333 44.8 44.8 102.4 66.133333 162.133333 66.133334 57.6 0 115.2-21.333333 160-64l66.133333-68.266667c12.8-12.8 12.8-32 0-44.8-14.933333-10.666667-34.133333-10.666667-46.933333 2.133333z',
    ];
    // Remote workspace: a display with an outbound arrow — the session itself
    // runs on the far side of the connection.
    var REMOTE_ICON_PATHS = [
      'M896 64a64 64 0 0 1 64 64v608a64 64 0 0 1-64 64H128a64 64 0 0 1-64-64V128a64 64 0 0 1 64-64h768z m-12.8 76.8H140.8v582.4h742.4V140.8z',
      'M320 883.2m38.4 0l307.2 0q38.4 0 38.4 38.4l0 0q0 38.4-38.4 38.4l-307.2 0q-38.4 0-38.4-38.4l0 0q0-38.4 38.4-38.4Z',
      'M262.4 224h243.2a38.4 38.4 0 1 1 0 76.8H351.808L586.24 535.168a38.4 38.4 0 0 1 4.032 49.536l-4.032 4.736-4.736 4.032a38.4 38.4 0 0 1-49.6-4.032L300.8 358.272 300.8 505.6a38.4 38.4 0 0 1-76.8 0V262.4a38.4 38.4 0 0 1 38.4-38.4z',
    ];

    // Settings-nav glyph: a stack of sheets (the linked / remote pairing sits on
    // top of the plain local workspace). Registered through the host's
    // `settings.section.icon` seat so the settings list shows it instead of the
    // default gear.
    var SETTINGS_ICON_PATHS = [
      'M20.66204445 509.34044445l475.70488888 256.27306667A35.10044445 35.10044445 0 0 0 542.72 753.6896a31.07271111 31.07271111 0 0 0-10.71786667-42.60977778c-0.63715555-0.38684445-1.29706667-0.73955555-1.96835555-1.08088888L54.35164445 453.72586667a35.11182222 35.11182222 0 0 0-46.31893334 11.91253333 31.08408889 31.08408889 0 0 0 10.68373334 42.63253334c0.62577778 0.37546667 1.28568889 0.73955555 1.9456 1.06951111z',
      'M972.07182222 453.72586667l-475.70488889 256.27306667a31.07271111 31.07271111 0 0 0-13.65333333 41.75644444c0.34133333 0.65991111 0.69404445 1.30844445 1.06951111 1.93422222 9.29564445 15.38275555 30.04871111 20.69617778 46.31893334 11.92391112L1005.79555555 509.34044445a31.07271111 31.07271111 0 0 0 13.76711112-41.73368889c-0.32995555-0.67128889-0.69404445-1.31982222-1.13777778-1.96835556a35.10044445 35.10044445 0 0 0-46.35306667-11.91253333z',
      'M20.66204445 701.54524445l475.70488888 256.27306667A35.10044445 35.10044445 0 0 0 542.72 945.84888889a31.07271111 31.07271111 0 0 0-10.71786667-42.60977777c-0.63715555-0.38684445-1.29706667-0.75093333-1.96835555-1.13777778L54.35164445 645.93066667a35.11182222 35.11182222 0 0 0-46.31893334 11.91253333 31.08408889 31.08408889 0 0 0 10.68373334 42.63253334c0.62577778 0.37546667 1.28568889 0.75093333 1.9456 1.06951111z',
      'M972.07182222 645.93066667l-475.70488889 256.27306667a31.07271111 31.07271111 0 0 0-13.65333333 41.75644444c0.34133333 0.65991111 0.69404445 1.30844445 1.06951111 1.93422222 9.29564445 15.38275555 30.04871111 20.69617778 46.31893334 11.92391112L1005.79555555 701.54524445a31.07271111 31.07271111 0 0 0 13.76711112-41.73368889c-0.32995555-0.67128889-0.69404445-1.31982222-1.13777778-1.96835556a35.10044445 35.10044445 0 0 0-46.35306667-11.91253333z',
      'M500.62222222 122.496L142.32462222 291.62666667 512 509.34044445l357.48977778-196.36906667z m3.77742223-70.54222222l483.04355555 249.42364444a13.75573333 13.75573333 0 0 1 6.53084445 17.80622223 12.12871111 12.12871111 0 0 1-5.12 5.50684444L520.64711111 581.76a13.23235555 13.23235555 0 0 1-13.07306666-0.38684444L23.54062222 296.24604445a13.65333333 13.65333333 0 0 1-5.44995555-18.20444445 12.25386667 12.25386667 0 0 1 5.44995555-5.13137778l469.17404445-221.27502222a13.18684445 13.18684445 0 0 1 11.71911111 0.31857778z',
    ];

    var ICON_DISCONNECTED_COLOR = '#f85149';
    var ICON_BUSY_COLOR = '#2f81f7';

    function iconMaskUrl(paths) {
      var markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="black">'
        + paths.map(function (path) { return '<path d="' + path + '"/>'; }).join('')
        + '</svg>';
      return 'url("data:image/svg+xml,' + encodeURIComponent(markup) + '")';
    }

    var LINKED_ICON_MASK = iconMaskUrl(LINKED_ICON_PATHS);
    var REMOTE_ICON_MASK = iconMaskUrl(REMOTE_ICON_PATHS);

    function workspaceIconStyleTag() {
      if (typeof document === 'undefined' || !document.head) return null;
      var selector = 'style[data-plugin-css="dsh-linked-workspace/workspace-icons"]';
      var tag = document.querySelector(selector);
      if (tag) return tag;
      tag = document.createElement('style');
      tag.setAttribute('data-plugin', 'dsh-linked-workspace');
      tag.setAttribute('data-plugin-css', 'dsh-linked-workspace/workspace-icons');
      document.head.appendChild(tag);
      return tag;
    }

    function stateOf(item) {
      var status = item && item.status;
      var state = status && status.state;
      return typeof state === 'string' && state !== '' ? state : 'idle';
    }

    function isDisconnected(item) {
      return stateOf(item) === 'error';
    }

    // Rows are React-rendered and get recreated on every sidebar update, so the
    // decorations have to be re-applied. A debounced observer handles that.
    var workspaceRowTips = [];
    var workspaceRowObserver = null;
    var workspaceRowTimer = null;
    var workspaceHoverRecords = {};

    function applyWorkspaceRowTips() {
      if (typeof document === 'undefined') return;
      for (var index = 0; index < workspaceRowTips.length; index += 1) {
        var tip = workspaceRowTips[index];
        var rows = document.querySelectorAll('[data-row-key="workspace:' + tip.id + '"]');
        for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          var row = rows[rowIndex];
          if (tip.disconnected) row.setAttribute('data-lw-disconnected', 'true');
          else row.removeAttribute('data-lw-disconnected');
          // The native tooltip would pop up next to the hover preview card, so
          // the connection state is written into that card instead.
          if (row.hasAttribute('title')) row.removeAttribute('title');
        }
      }
    }

    function queueWorkspaceRowTips() {
      if (typeof window === 'undefined' || workspaceRowTimer !== null) return;
      workspaceRowTimer = window.setTimeout(function () {
        workspaceRowTimer = null;
        applyWorkspaceRowTips();
        applyHoverCards();
      }, 200);
      if (workspaceRowTimer && typeof workspaceRowTimer.unref === 'function') workspaceRowTimer.unref();
    }

    function watchWorkspaceRows() {
      if (workspaceRowObserver !== null) return;
      if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return;
      try {
        workspaceRowObserver = new MutationObserver(function () { queueWorkspaceRowTips(); });
        // Only structural changes: our own attribute writes must not retrigger it.
        workspaceRowObserver.observe(document.body, { childList: true, subtree: true });
      } catch (error) {
        workspaceRowObserver = null;
      }
    }

    function statusLabel(t, item) {
      var state = stateOf(item);
      if (state === 'error') return item && item.status && item.status.reason === 'lost' ? t('disconnected') : t('errorState');
      return state === 'connected' ? t('connected') : t('idle');
    }

    // ── workspace hover preview ────────────────────────────────────────────
    // The host renders the hover card itself (name / directory / created at)
    // inside a portal that lives outside our row, so it can only be enriched by
    // decorating it after it appears. Class names are hashed, hence the
    // substring selectors.
    var HOVER_CARD_QUERY = '[class*="hoverContent"]';
    var HOVER_LINE_ATTR = 'data-lw-hover-line';
    var hoverCardObserver = null;
    var hoverCardState = typeof WeakMap === 'function' ? new WeakMap() : null;

    function clearHoverLines(card) {
      var injected = card.querySelectorAll('[' + HOVER_LINE_ATTR + ']');
      for (var index = 0; index < injected.length; index += 1) {
        var node = injected[index];
        if (node.parentNode) node.parentNode.removeChild(node);
      }
    }

    function decorateHoverCard(card) {
      if (!card || !hoverCardState || !card.querySelector) return;
      var pathEl = card.querySelector('[class*="hoverPath"]');
      if (!pathEl) return;
      var known = hoverCardState.get(card);
      var current = (pathEl.textContent || '').trim();
      // Already decorated for this very content: nothing to do.
      if (known && known.rendered === current) return;
      // The host re-rendered the card for another workspace: drop our lines.
      if (known) clearHoverLines(card);
      var record = workspaceHoverRecords[linkedScopeKey(current)];
      if (!record || !record.remotePath) return;
      var t = makeT(readLocale());
      var remote = record.remotePath;
      var local = record.localPath || '';

      var status = document.createElement('div');
      status.className = 'rw-hover-status' + (record.disconnected ? ' is-off' : record.connected ? ' is-on' : '');
      status.setAttribute(HOVER_LINE_ATTR, '1');
      status.textContent = record.status;
      var titleEl = card.querySelector('[class*="hoverTitle"]');
      var anchor = titleEl || pathEl;
      anchor.parentNode.insertBefore(status, anchor.nextSibling);

      if (record.kind === 'linked' && local !== '') {
        pathEl.textContent = t('pathRemoteShort') + ' ' + remote;
        var localEl = pathEl.cloneNode(false);
        localEl.setAttribute(HOVER_LINE_ATTR, '1');
        localEl.textContent = t('pathLocalShort') + ' ' + local;
        pathEl.parentNode.insertBefore(localEl, pathEl.nextSibling);
      } else {
        pathEl.textContent = remote;
      }

      // The card doubles as a "copy this path" button; keep its label in sync so
      // a remote workspace copies the remote directory, not the placeholder.
      var host = card.parentElement;
      var label = host && host.getAttribute ? host.getAttribute('aria-label') : null;
      if (label && current !== '' && label.indexOf(current) !== -1) {
        host.setAttribute('aria-label', label.split(current).join(remote));
      }

      hoverCardState.set(card, { rendered: (pathEl.textContent || '').trim() });
    }

    function applyHoverCards() {
      if (typeof document === 'undefined') return;
      var cards = document.querySelectorAll(HOVER_CARD_QUERY);
      for (var index = 0; index < cards.length; index += 1) decorateHoverCard(cards[index]);
    }

    function watchHoverCards() {
      if (hoverCardObserver !== null) return;
      if (typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) return;
      try {
        hoverCardObserver = new MutationObserver(function (records) {
          for (var index = 0; index < records.length; index += 1) {
            var added = records[index].addedNodes;
            for (var nodeIndex = 0; nodeIndex < added.length; nodeIndex += 1) {
              var node = added[nodeIndex];
              if (!node || node.nodeType !== 1) continue;
              if (node.closest) {
                var outer = node.closest(HOVER_CARD_QUERY);
                if (outer) decorateHoverCard(outer);
              }
              if (node.querySelectorAll) {
                var inner = node.querySelectorAll(HOVER_CARD_QUERY);
                for (var innerIndex = 0; innerIndex < inner.length; innerIndex += 1) decorateHoverCard(inner[innerIndex]);
              }
            }
          }
        });
        hoverCardObserver.observe(document.body, { childList: true, subtree: true });
      } catch (error) {
        hoverCardObserver = null;
      }
    }

    function publishRowTips(entries) {
      var t = makeT(readLocale());
      var records = {};
      workspaceRowTips = entries.map(function (entry) {
        var item = entry.item || {};
        var linked = entry.kind === 'linked';
        var key = linkedScopeKey(linked ? item.localPath : item.placeholderPath);
        if (key !== '') {
          records[key] = {
            kind: entry.kind,
            name: item.name,
            remotePath: item.remotePath || '',
            localPath: linked ? (item.localPath || '') : '',
            status: statusLabel(t, item),
            connected: stateOf(item) === 'connected',
            disconnected: isDisconnected(item),
          };
        }
        return { id: entry.id, disconnected: isDisconnected(item) };
      });
      workspaceHoverRecords = records;
      applyWorkspaceRowTips();
      watchWorkspaceRows();
      watchHoverCards();
      applyHoverCards();
    }

    function publishWorkspaceIcons(links, remotes) {
      var tag = workspaceIconStyleTag();
      if (!tag) return;
      var entries = [];
      (links || []).forEach(function (link) {
        entries.push({ item: link, id: link && link.workspaceId, mask: LINKED_ICON_MASK, running: Boolean(link.running), kind: 'linked' });
      });
      (remotes || []).forEach(function (workspace) {
        entries.push({ item: workspace, id: workspace && workspace.workspaceId, mask: REMOTE_ICON_MASK, running: false, kind: 'remote' });
      });
      var rules = entries.map(function (entry) {
        var id = entry.id ? String(entry.id).replace(/[^0-9a-zA-Z-]/g, '') : '';
        if (id === '') return '';
        var row = '[data-row-key="workspace:' + id + '"] > span:first-child';
        var rule = row + '{display:inline-flex;align-items:center;justify-content:center;flex:none;}'
          + row + ' svg{display:none!important;}'
          + row + '::before{content:"";display:block;width:14px;height:14px;background:currentColor;'
          + '-webkit-mask:' + entry.mask + ' center/contain no-repeat;mask:' + entry.mask + ' center/contain no-repeat;}';
        // A dropped SSH connection turns the row icon red; a running mirror
        // sync keeps the existing accent highlight.
        if (isDisconnected(entry.item)) rule += row + '::before{background:' + ICON_DISCONNECTED_COLOR + '!important}';
        else if (entry.running) rule += row + '::before{background:' + ICON_BUSY_COLOR + '!important}';
        return rule;
      }).filter(function (rule) { return rule !== ''; });
      tag.textContent = rules.join('\n');
      publishRowTips(entries);
    }

    // ── icons (16px outline set, currentColor) ─────────────────────────────

    function svg(size, children, extra) {
      var props = {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
      };
      if (extra) Object.keys(extra).forEach(function (key) { props[key] = extra[key]; });
      return h('svg', props, children);
    }

    // Filled workspace-kind icons. The supplied shapes are drawn on a 1024 grid
    // and carry no stroke, so they are rendered apart from the outline set.
    function solidIcon(size, paths) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 1024 1024',
        fill: 'currentColor',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        focusable: 'false',
      }, paths.map(function (path, index) { return h('path', { key: index, d: path }); }));
    }

    function IconLinkedWorkspace(size) {
      return solidIcon(size || 14, LINKED_ICON_PATHS);
    }

    function IconRemoteWorkspace(size) {
      return solidIcon(size || 14, REMOTE_ICON_PATHS);
    }

    function IconSettingsNav(size) {
      return solidIcon(size || 16, SETTINGS_ICON_PATHS);
    }

    function IconChevron(size) {
      return svg(size || 14, h('path', {
        d: 'm6 3 5 5-5 5', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }
    function IconFolder(size, open) {
      return svg(size || 14, [
        open
          ? h('path', { key: 'p', d: 'M1.5 5.5 3 4h4l1.4 1.5H13a1.5 1.5 0 0 1 1.5 1.6l-.7 4.3a1.5 1.5 0 0 1-1.5 1.26H2.4a1.5 1.5 0 0 1-1.5-1.3l-.8-4.5A1.5 1.5 0 0 1 1.5 5.5Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' })
          : h('path', { key: 'p', d: 'M1.8 4.5A1.5 1.5 0 0 1 3.3 3h2.5l1.4 1.5h5.5A1.5 1.5 0 0 1 14.2 6v5.6a1.5 1.5 0 0 1-1.5 1.5H3.3a1.5 1.5 0 0 1-1.5-1.5V4.5Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
      ]);
    }
    function IconFile(size) {
      return svg(size || 14, [
        h('path', { key: 'p', d: 'M3.5 2.2A1.2 1.2 0 0 1 4.7 1h4.6l3.2 3.2v9.6a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V2.2Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        h('path', { key: 'f', d: 'M9 1.2v3.4h3.4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
      ]);
    }
    function IconServer(size) {
      return svg(size || 16, [
        h('rect', { key: 'a', x: 2, y: 2.2, width: 12, height: 5, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('rect', { key: 'b', x: 2, y: 8.8, width: 12, height: 5, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { key: 'c', cx: 4.6, cy: 4.7, r: 0.8, fill: 'currentColor' }),
        h('circle', { key: 'd', cx: 4.6, cy: 11.3, r: 0.8, fill: 'currentColor' }),
      ]);
    }
    function IconTerminal(size) {
      return svg(size || 14, [
        h('rect', { key: 'a', x: 1.8, y: 2.4, width: 12.4, height: 11.2, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.25 }),
        h('path', { key: 'b', d: 'm4.4 6 2.1 2-2.1 2M8.2 10h3.3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function IconEye(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M1.6 8s2.4-4.1 6.4-4.1S14.4 8 14.4 8 12 12.1 8 12.1 1.6 8 1.6 8Z', stroke: 'currentColor', strokeWidth: 1.25, strokeLinejoin: 'round' }),
        h('circle', { key: 'b', cx: 8, cy: 8, r: 1.9, stroke: 'currentColor', strokeWidth: 1.25 }),
      ]);
    }
    function IconEyeOff(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M1.6 8s2.4-4.1 6.4-4.1c1.1 0 2.1.3 3 .7M14.4 8s-2.4 4.1-6.4 4.1c-1.1 0-2.1-.3-3-.7', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'm2.4 2.4 11.2 11.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      ]);
    }
    function IconDownload(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M8 2.4v7.4M4.9 6.6 8 9.7l3.1-3.1', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'b', d: 'M2.8 11.4v1.2a1.1 1.1 0 0 0 1.1 1.1h8.2a1.1 1.1 0 0 0 1.1-1.1v-1.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      ]);
    }
    function IconRefresh(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M13.3 8a5.3 5.3 0 1 1-1.6-3.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M13.6 2.4v3.2h-3.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function IconPlus(size) {
      return svg(size || 14, h('path', {
        d: 'M8 3.2v9.6M3.2 8h9.6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }));
    }
    function IconTrash(size) {
      return svg(size || 14, h('path', {
        d: 'M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.2 4.2l.6 9h6.4l.6-9',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }
    function IconSave(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M3 2.5h7.2L13 5.3v8.2a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 .4-.9Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        h('path', { key: 'b', d: 'M5 2.5v3.2h4.6V2.8M5.2 14.4v-3.6h5.6v3.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
      ]);
    }
    function IconClose(size) {
      return svg(size || 14, h('path', {
        d: 'm4 4 8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
      }));
    }
    function IconAlert(size) {
      return svg(size || 14, [
        h('circle', { key: 'a', cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { key: 'b', d: 'M8 4.8v3.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('circle', { key: 'c', cx: 8, cy: 11, r: 0.85, fill: 'currentColor' }),
      ]);
    }
    function IconCheck(size) {
      return svg(size || 14, h('path', {
        d: 'm3.2 8.4 3.1 3.1 6.5-6.8', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }
    function IconLink(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M6.4 9.6a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-1 1', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'b', d: 'M9.6 6.4a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l1-1', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function IconPanelRight(size) {
      return svg(size || 14, [
        h('rect', { key: 'a', x: 1.8, y: 2.2, width: 12.4, height: 11.6, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.25 }),
        h('path', { key: 'b', d: 'M9.4 2.2v11.6', stroke: 'currentColor', strokeWidth: 1.25 }),
      ]);
    }
    function IconSearch(size) {
      return svg(size || 14, [
        h('circle', { key: 'a', cx: 7, cy: 7, r: 4.2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { key: 'b', d: 'm10.2 10.2 3.3 3.3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      ]);
    }
    function IconOpenApp(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M6.5 3.2H3.4a1.2 1.2 0 0 0-1.2 1.2v8.2a1.2 1.2 0 0 0 1.2 1.2h8.2a1.2 1.2 0 0 0 1.2-1.2V9.5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'b', d: 'M9.4 2.5h4.1v4.1M13.2 2.8 7.8 8.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function IconTree(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M2.4 3.8h3.1M2.4 8h3.1M2.4 12.2h3.1M5.5 3.8h2.1v8.4h2.1', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function IconFolderTree(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M1.8 4.2a1.2 1.2 0 0 1 1.2-1.2h2.2l1.2 1.3h5.6a1.2 1.2 0 0 1 1.2 1.2v5.6a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2V4.2Z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
      ]);
    }
    function IconColumns(size) {
      return svg(size || 14, [
        h('rect', { key: 'a', x: 1.8, y: 2.5, width: 12.4, height: 11, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.2 }),
        h('path', { key: 'b', d: 'M8 2.8v10.4', stroke: 'currentColor', strokeWidth: 1.2 }),
      ]);
    }
    function IconExternal(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M9 2.5h4.5V7M13.2 2.8 7.6 8.4', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'b', d: 'M12.4 9.4v3.2a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.8a1.2 1.2 0 0 1 1.2-1.2h3.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function IconSync(size) {
      return svg(size || 14, [
        h('path', { key: 'a', d: 'M2.4 6.2A5.8 5.8 0 0 1 13 4.4M13.6 9.8A5.8 5.8 0 0 1 3 11.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { key: 'b', d: 'M11.2 2.2v3h-3M4.8 13.8v-3h3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ]);
    }
    function Spinner(size) {
      var s = size || 14;
      return h('span', { className: 'rw-spinner', 'aria-hidden': 'true' }, svg(s, h('circle', {
        cx: 8, cy: 8, r: 5.6, stroke: 'currentColor', strokeWidth: 1.8, 'stroke-dasharray': '24 12',
        className: 'rw-spin',
      })));
    }

    function FileGlyph(props) {
      var spec = props.spec || fileIconSpec(props.name || '', Boolean(props.dir));
      var size = props.size || 14;
      if (props.dir) {
        return h('span', { className: 'rw-dir-icon' }, IconFolder(size, Boolean(props.open)));
      }
      if (!spec || !spec.glyph) {
        return h('span', { className: 'rw-file-icon' }, IconFile(size));
      }
      return h('span', {
        className: 'rw-glyph',
        style: {
          width: size,
          height: size,
          borderRadius: spec.shape === 'circle' ? '50%' : '3px',
          background: hexToRgba(spec.color, 0.16),
          color: spec.color,
          fontSize: spec.glyph.length <= 2 ? Math.max(7, size - 5) : Math.max(6, size - 7),
        },
        'aria-hidden': 'true',
        title: spec.label ? spec.label.zh : undefined,
      }, spec.glyph);
    }

    // ── data hooks ─────────────────────────────────────────────────────────

    function useRemoteData(ctx) {
      var dataState = useState({ loading: true, hosts: [], remotes: [], links: [], error: null, hostError: null, linkError: null });
      var data = dataState[0];
      var setData = dataState[1];
      var alive = useRef(true);

      var load = useCallback(function () {
        var jobs = [
          apiCall('remote_workspaces.list').then(function (result) { return { remotes: result.workspaces || [] }; }),
          apiCall('hosts.list').then(function (result) { return { hosts: result.hosts || [] }; }),
          apiCall('linked.list').then(function (result) { return { links: result.links || [] }; }),
        ];
        return Promise.all(jobs.map(function (promise) {
          return promise.then(function (value) { return { ok: true, value: value }; }, function (error) { return { ok: false, error: error }; });
        })).then(function (results) {
          if (!alive.current) return;
          var remotesResult = results[0];
          var hostsResult = results[1];
          var linksResult = results[2];
          setData(function (previous) {
            return {
              loading: false,
              remotes: remotesResult.ok ? remotesResult.value.remotes : previous.remotes,
              hosts: hostsResult.ok ? hostsResult.value.hosts : previous.hosts,
              links: linksResult.ok ? linksResult.value.links : previous.links,
              error: remotesResult.ok ? null : remotesResult.error,
              hostError: hostsResult.ok ? null : hostsResult.error,
              linkError: linksResult.ok ? null : linksResult.error,
            };
          });
          rememberDirectoryAvailability(linksResult.ok ? linksResult.value.links : [], remotesResult.ok ? remotesResult.value.remotes : []);
          publishWorkspaceIcons(linksResult.ok ? linksResult.value.links : [], remotesResult.ok ? remotesResult.value.remotes : []);
        });
      }, []);

      useEffect(function () {
        alive.current = true;
        load();
        var unsubscribe = bus.subscribe(load);
        return function () {
          alive.current = false;
          unsubscribe();
        };
      }, [load]);

      return { data: data, reload: load };
    }

    // ── small building blocks ───────────────────────────────────────────────

    function statusTitle(t, item) {
      var status = (item && item.status) || {};
      if (status.state === 'connected') {
        return typeof status.latencyMs === 'number' ? t('connected') + ' · ' + status.latencyMs + ' ms' : t('connected');
      }
      if (status.state === 'error') {
        if (status.reason === 'lost') return t('disconnected');
        return status.message ? t('errorState') + ' · ' + status.message : t('errorState');
      }
      return t('idle');
    }

    function StatusPill(props) {
      var t = props.t;
      var status = props.status || { state: 'idle' };
      var cls = status.state === 'connected' ? 'rw-dot-ok' : status.state === 'error' ? 'rw-dot-error' : '';
      var label = status.state === 'connected'
        ? t('connected')
        : status.state === 'error'
          ? (status.reason === 'lost' ? t('disconnected') : t('errorState'))
          : t('idle');
      return h('span', { className: 'rw-chip', title: statusTitle(t, props) || label },
        h('span', { className: 'rw-dot ' + cls }),
        label);
    }

    function Banner(props) {
      var cls = 'rw-banner' + (props.kind ? ' rw-banner-' + props.kind : '');
      return h('div', { className: cls, role: props.role || 'status' },
        props.kind === 'error' ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, IconAlert(14)) : null,
        h('span', { className: 'rw-fill', style: { flex: '1 1 auto' } }, props.children),
        props.onClose ? h('button', { type: 'button', className: 'rw-btn rw-btn-ghost rw-btn-sm', onClick: props.onClose }, IconClose(12)) : null);
    }

    function Switch(props) {
      return h('label', { className: 'rw-switch', title: props.title || props.label },
        h('input', {
          type: 'checkbox',
          checked: Boolean(props.checked),
          onChange: function (event) { if (props.onChange) props.onChange(event.currentTarget.checked); },
          'aria-label': props.label || 'toggle',
        }),
        h('span', { className: 'rw-switch-track', 'aria-hidden': 'true' }, h('span', { className: 'rw-switch-thumb' })),
        props.text ? h('span', null, props.text) : null);
    }

    function ThemeSwatch(props) {
      var theme = props.theme;
      var c = theme.colors;
      return h('div', {
        className: 'rw-theme-preview',
        style: { background: c.bg, color: c.fg, border: '1px solid ' + c.border },
      },
        h('span', { style: { color: c.comment } }, '// remote'),
        h('span', { style: { color: c.keyword, fontWeight: 600 } }, '✓'));
    }

    // ── local / remote path pickers ────────────────────────────────────────

    function LocalPathPicker(props) {
      var t = props.t;
      var locale = props.locale;
      var initialPath = props.initialPath || '';
      var root = props.root || '';
      var state = useState({ loading: true, listing: null, error: '', input: initialPath, creating: false, folderName: '', filter: '' });
      var local = state[0];
      var setLocal = state[1];

      var load = useCallback(function (path) {
        setLocal(function (previous) { return Object.assign({}, previous, { loading: true, error: '', input: path || previous.input }); });
        apiCall('local.browse', path ? { path: path } : {}).then(function (result) {
          setLocal(function (previous) {
            return Object.assign({}, previous, { loading: false, listing: result, error: '', input: result.path, filter: '' });
          });
        }).catch(function (error) {
          setLocal(function (previous) {
            return Object.assign({}, previous, { loading: false, error: messageOf(error, t, locale) });
          });
        });
      }, []);

      useEffect(function () { load(initialPath); }, []);

      function navigate(path) {
        if (!path) return;
        if (root && !pathInsideOf(root, path)) return;
        load(path);
      }

      function createFolder() {
        var name = local.folderName.trim();
        if (name === '' || !local.listing) return;
        apiCall('local.mkdir', { path: local.listing.path, name: name }).then(function () {
          setLocal(function (previous) { return Object.assign({}, previous, { creating: false, folderName: '' }); });
          load(local.listing.path);
        }).catch(function (error) {
          setLocal(function (previous) { return Object.assign({}, previous, { error: messageOf(error, t, locale) }); });
        });
      }

      function nativePick() {
        var pick = typeof window !== 'undefined' ? window.__DSH_DESKTOP_PICK_DIRECTORY__ : undefined;
        if (typeof pick !== 'function') return;
        Promise.resolve().then(function () { return pick(); }).then(function (chosen) {
          if (typeof chosen === 'string' && chosen !== '') navigate(chosen);
        }).catch(function () { /* native picker cancelled */ });
      }

      var listing = local.listing;
      var entries = listing ? listing.entries : [];
      // A folder with thousands of sub-folders must not build thousands of DOM
      // rows; the input box below still accepts any path.
      var PICKER_LIMIT = 500;
      var filterText = String(local.filter || '').trim().toLowerCase();
      var matchedEntries = filterText === '' ? entries : entries.filter(function (entry) {
        return String(entry.name || '').toLowerCase().indexOf(filterText) !== -1;
      });
      var shownEntries = matchedEntries.slice(0, PICKER_LIMIT);
      var crumbs = useMemo(function () {
        if (!listing || !listing.path) return [];
        var path = listing.path;
        var pieces = path.split(/[\\/]+/).filter(function (piece) { return piece !== ''; });
        var list = [];
        var current = '';
        if (/^[A-Za-z]:/.test(path)) {
          current = pieces.length > 0 ? pieces[0] + '/' : '/';
          list.push({ label: pieces[0], path: pieces.length > 0 ? pieces[0] + '/' : '/' });
          pieces = pieces.slice(1);
        } else {
          list.push({ label: '/', path: '/' });
        }
        pieces.forEach(function (piece) {
          current = current.endsWith('/') ? current + piece : current + '/' + piece;
          list.push({ label: piece, path: current });
        });
        return list;
      }, [listing && listing.path]);

      return h('div', { className: 'rw-browser' },
        h('div', { className: 'rw-browser-head' },
          h('button', {
            type: 'button', className: 'rw-icon-btn', title: t('parentDir'),
            disabled: local.loading || !listing || !listing.parent,
            onClick: function () { if (listing && listing.parent) navigate(listing.parent); },
          }, h('span', { style: { transform: 'rotate(180deg)', display: 'inline-flex' } }, IconChevron(13))),
          h('div', { className: 'rw-breadcrumb' },
            crumbs.map(function (crumb, index) {
              return h('span', { key: crumb.path + ':' + index, className: 'rw-inline', style: { minWidth: 0 } },
                index > 0 ? h('span', { className: 'rw-crumb-sep' }, '/') : null,
                h('button', {
                  type: 'button', className: 'rw-crumb', title: crumb.path,
                  onClick: function () { navigate(crumb.path); },
                }, crumb.label));
            })),
          local.loading ? Spinner(13) : null),
        listing && listing.drives && listing.drives.length > 0
          ? h('div', { className: 'rw-drives' },
            listing.drives.map(function (drive) {
              return h('button', {
                key: drive.path, type: 'button',
                className: 'rw-drive' + (linkedScopeKey(listing.path) === linkedScopeKey(drive.path) ? ' is-on' : ''),
                onClick: function () { navigate(drive.path); },
              }, drive.name);
            }))
          : null,
        h('div', { className: 'rw-filter-row' },
          h('input', {
            className: 'rw-input', style: { height: 26, fontSize: 11.5 },
            value: local.filter,
            placeholder: t('filterPlaceholder'),
            'aria-label': t('filterPlaceholder'),
            spellCheck: false,
            onChange: function (event) { setLocal(function (previous) { return Object.assign({}, previous, { filter: event.currentTarget.value }); }); },
          })),
        h('div', { className: 'rw-browser-list', role: 'list' },
          local.error
            ? h('div', { className: 'rw-row-msg' }, IconAlert(12), local.error)
            : entries.length === 0
              ? h('div', { className: 'rw-row-msg' }, t('emptyFolder'))
              : matchedEntries.length === 0
                ? h('div', { className: 'rw-row-msg' }, t('filterEmpty'))
                : shownEntries.map(function (entry) {
                return h('button', {
                  key: entry.path, type: 'button', className: 'rw-browser-row', role: 'listitem',
                  onClick: function () { navigate(entry.path); },
                }, h('span', { className: 'rw-dir-icon' }, IconFolder(13, false)), h('span', null, entry.name));
              }),
          matchedEntries.length > PICKER_LIMIT
            ? h('div', { className: 'rw-row-msg' }, t('pickerTruncated', { count: PICKER_LIMIT }))
            : null),
        h('div', { className: 'rw-browser-actions', style: { padding: '8px', gap: 8 } },
          h('div', { className: 'rw-inline', style: { minWidth: 0, flex: '1 1 auto' } },
            h('input', {
              className: 'rw-input rw-input-mono', style: { height: 28, fontSize: 11.5 },
              value: local.input,
              spellCheck: false,
              onChange: function (event) { setLocal(function (previous) { return Object.assign({}, previous, { input: event.currentTarget.value }); }); },
              onKeyDown: function (event) { if (event.key === 'Enter') navigate(local.input); },
            }),
            h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: function () { navigate(local.input); } }, t('open')),
            typeof window !== 'undefined' && typeof window.__DSH_DESKTOP_PICK_DIRECTORY__ === 'function'
              ? h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: nativePick, title: t('nativePicker') }, t('nativePicker'))
              : null,
            h('button', {
              type: 'button', className: 'rw-btn rw-btn-sm',
              onClick: function () { setLocal(function (previous) { return Object.assign({}, previous, { creating: !previous.creating }); }); },
            }, IconPlus(12), t('newFolder'))),
          h('div', { className: 'rw-actions' },
            h('button', {
              type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary',
              disabled: !listing || local.loading || (root && !pathInsideOf(root, listing.path)),
              onClick: function () { if (listing && props.onPick) props.onPick(listing.path); },
            }, IconCheck(12), t('useThisDir')))),
        local.creating
          ? h('div', { className: 'rw-browser-actions', style: { padding: '0 8px 8px', gap: 8 } },
            h('input', {
              className: 'rw-input', style: { height: 28, fontSize: 12 }, placeholder: t('folderName'),
              value: local.folderName, autoFocus: true,
              onChange: function (event) { setLocal(function (previous) { return Object.assign({}, previous, { folderName: event.currentTarget.value }); }); },
              onKeyDown: function (event) { if (event.key === 'Enter') createFolder(); },
            }),
            h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary', disabled: local.folderName.trim() === '', onClick: createFolder }, t('create')),
            h('button', {
              type: 'button', className: 'rw-btn rw-btn-sm',
              onClick: function () { setLocal(function (previous) { return Object.assign({}, previous, { creating: false, folderName: '' }); }); },
            }, t('cancel')))
          : null);
    }

    function RemotePathPicker(props) {
      var t = props.t;
      var locale = props.locale;
      var hostId = props.hostId;
      var state = useState({ loading: true, listing: null, error: '', input: props.initialPath || '', filter: '' });
      var remote = state[0];
      var setRemote = state[1];

      var load = useCallback(function (path) {
        if (!hostId) {
          setRemote(function (previous) { return Object.assign({}, previous, { loading: false, error: '' }); });
          return;
        }
        setRemote(function (previous) { return Object.assign({}, previous, { loading: true, error: '' }); });
        apiCall('hosts.browse', { hostId: hostId, path: path || undefined }).then(function (result) {
          setRemote(function (previous) {
            return Object.assign({}, previous, { loading: false, listing: result, error: '', input: result.path, filter: '' });
          });
        }).catch(function (error) {
          setRemote(function (previous) { return Object.assign({}, previous, { loading: false, error: messageOf(error, t, locale) }); });
        });
      }, [hostId]);

      useEffect(function () { load(props.initialPath || ''); }, [hostId]);

      function navigate(path) {
        if (!path) return;
        load(path);
      }

      var listing = remote.listing;
      var dirs = listing ? (listing.entries || []).filter(function (entry) { return entry.type === 'dir'; }) : [];
      var PICKER_LIMIT = 500;
      var filterText = String(remote.filter || '').trim().toLowerCase();
      var matchedDirs = filterText === '' ? dirs : dirs.filter(function (entry) {
        return String(entry.name || '').toLowerCase().indexOf(filterText) !== -1;
      });
      var shownDirs = matchedDirs.slice(0, PICKER_LIMIT);
      var pickerTruncated = matchedDirs.length > PICKER_LIMIT || Boolean(listing && listing.hasMore);
      var crumbs = useMemo(function () {
        if (!listing || !listing.path) return [];
        var pieces = listing.path.split('/').filter(function (piece) { return piece !== ''; });
        var list = [{ label: '/', path: '/' }];
        var current = '';
        pieces.forEach(function (piece) {
          current += '/' + piece;
          list.push({ label: piece, path: current });
        });
        return list;
      }, [listing && listing.path]);

      return h('div', { className: 'rw-browser' },
        h('div', { className: 'rw-browser-head' },
          h('button', {
            type: 'button', className: 'rw-icon-btn', title: t('parentDir'),
            disabled: remote.loading || !listing || !listing.parent,
            onClick: function () { if (listing && listing.parent) navigate(listing.parent); },
          }, h('span', { style: { transform: 'rotate(180deg)', display: 'inline-flex' } }, IconChevron(13))),
          h('div', { className: 'rw-breadcrumb' },
            crumbs.map(function (crumb, index) {
              return h('span', { key: crumb.path + ':' + index, className: 'rw-inline', style: { minWidth: 0 } },
                index > 0 && crumbs[index - 1].label !== '/' ? h('span', { className: 'rw-crumb-sep' }, '/') : null,
                h('button', { type: 'button', className: 'rw-crumb', title: crumb.path, onClick: function () { navigate(crumb.path); } }, crumb.label));
            })),
          remote.loading ? Spinner(13) : null),
        h('div', { className: 'rw-filter-row' },
          h('input', {
            className: 'rw-input', style: { height: 26, fontSize: 11.5 },
            value: remote.filter,
            placeholder: t('filterPlaceholder'),
            'aria-label': t('filterPlaceholder'),
            spellCheck: false,
            onChange: function (event) { setRemote(function (previous) { return Object.assign({}, previous, { filter: event.currentTarget.value }); }); },
          })),
        h('div', { className: 'rw-browser-list', role: 'list' },
          remote.error
            ? h('div', { className: 'rw-row-msg' }, IconAlert(12), remote.error)
            : dirs.length === 0
              ? h('div', { className: 'rw-row-msg' }, t('noEntries'))
              : matchedDirs.length === 0
                ? h('div', { className: 'rw-row-msg' }, t('filterEmpty'))
                : shownDirs.map(function (entry) {
                return h('button', {
                  key: entry.path, type: 'button', className: 'rw-browser-row', role: 'listitem',
                  onClick: function () { navigate(entry.path); },
                }, h('span', { className: 'rw-dir-icon' }, IconFolder(13, false)), h('span', null, entry.name));
              }),
          pickerTruncated
            ? h('div', { className: 'rw-row-msg' }, t('pickerTruncated', { count: PICKER_LIMIT }))
            : null),
        h('div', { className: 'rw-browser-actions', style: { padding: '8px' } },
          h('span', { className: 'rw-hint rw-input-mono', title: remote.input || (listing && listing.path) || '' },
            (listing && listing.path) || (remote.input !== '' ? remote.input : t('home'))),
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary',
            disabled: !listing || remote.loading,
            onClick: function () { if (listing && props.onPick) props.onPick(listing.path); },
          }, IconCheck(12), t('useThisDir'))));
    }

    function ScopePathPicker(props) {
      var t = props.t;
      var locale = props.locale;
      var scope = props.scope;
      var root = props.root || '';
      var state = useState({ loading: true, listing: null, error: '' });
      var view = state[0];
      var setView = state[1];

      var load = useCallback(function (path) {
        setView(function (previous) { return Object.assign({}, previous, { loading: true, error: '' }); });
        var request = Object.assign({ path: path || root }, scopeParams(scope));
        apiCall('fs.list', request).then(function (result) {
          setView({ loading: false, listing: result, error: '' });
        }).catch(function (error) {
          setView({ loading: false, listing: null, error: messageOf(error, t, locale) });
        });
      }, [scopeKeyOf(scope), root]);

      useEffect(function () { load(props.initialPath || root); }, []);

      var listing = view.listing;
      var dirs = listing ? (listing.entries || []).filter(function (entry) { return entry.type === 'dir'; }) : [];
      var parent = listing && listing.path !== root
        ? listing.path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'
        : '';
      return h('div', { className: 'rw-browser rw-move-browser' },
        h('div', { className: 'rw-browser-head' },
          h('button', {
            type: 'button', className: 'rw-icon-btn', title: t('parentDir'),
            disabled: view.loading || !parent,
            onClick: function () { if (parent) load(parent); },
          }, h('span', { style: { transform: 'rotate(180deg)', display: 'inline-flex' } }, IconChevron(13))),
          h('div', { className: 'rw-breadcrumb rw-input-mono', title: listing ? listing.path : '' },
            listing ? listing.path : t('loading')),
          view.loading ? Spinner(13) : null),
        h('div', { className: 'rw-browser-list', role: 'list' },
          view.error
            ? h('div', { className: 'rw-row-msg' }, IconAlert(12), view.error)
            : dirs.length === 0
              ? h('div', { className: 'rw-row-msg' }, t('noEntries'))
              : dirs.map(function (entry) {
                return h('button', {
                  key: entry.path, type: 'button', className: 'rw-browser-row', role: 'listitem',
                  onClick: function () { load(entry.path); },
                }, h('span', { className: 'rw-dir-icon' }, IconFolder(13, false)), h('span', null, entry.name));
              })),
        h('div', { className: 'rw-browser-actions', style: { padding: '8px' } },
          h('span', { className: 'rw-hint' }, t('moveHint')),
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary',
            disabled: !listing || view.loading,
            onClick: function () { if (listing) props.onPick(listing.path); },
          }, IconCheck(12), t('useThisDir'))));
    }

    function ImagePreview(props) {
      var ctx = props.ctx;
      var t = props.t;
      var locale = props.locale;
      var scope = props.scope;
      var local = props.local === true;
      var filePath = props.path;
      var state = useState({ loading: true, error: null, data: null });
      var view = state[0];
      var setView = state[1];
      var naturalState = useState(null);
      var natural = naturalState[0];
      var setNatural = naturalState[1];
      var zoomState = useState(1);
      var zoom = zoomState[0];
      var setZoom = zoomState[1];
      var stageRef = useRef(null);
      var params = scopeParams(scope);
      var MIN_ZOOM = 0.05;
      var MAX_ZOOM = 8;

      function clampZoom(value) {
        return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
      }

      function zoomBy(factor) {
        setZoom(function (previous) { return clampZoom(previous * factor); });
      }

      function fitToStage() {
        if (!natural || !stageRef.current) return;
        var width = Math.max(40, stageRef.current.clientWidth - 36);
        var height = Math.max(40, stageRef.current.clientHeight - 36);
        setZoom(clampZoom(Math.min(1, width / natural.width, height / natural.height)));
      }

      var load = useCallback(function () {
        if (!filePath || (!local && !scope)) {
          setView({ loading: false, error: new Error(t('noWorkspace')), data: null });
          return;
        }
        setNatural(null);
        setView({ loading: true, error: null, data: null });
        var request = local ? { path: filePath } : Object.assign({ path: filePath }, params);
        apiCall(local ? 'local.media' : 'media.read', request).then(function (result) {
          setView({ loading: false, error: null, data: result });
        }).catch(function (error) {
          setView({ loading: false, error: error, data: null });
        });
      }, [scopeKeyOf(scope), filePath, local]);

      useEffect(function () { load(); }, [load]);

      useEffect(function () {
        setZoom(1);
        setNatural(null);
      }, [filePath]);

      useEffect(function () {
        if (!natural || !stageRef.current) return;
        var width = Math.max(40, stageRef.current.clientWidth - 36);
        var height = Math.max(40, stageRef.current.clientHeight - 36);
        setZoom(clampZoom(Math.min(1, width / natural.width, height / natural.height)));
      }, [natural]);

      useEffect(function () {
        var stage = stageRef.current;
        if (!stage) return;
        function onWheel(event) {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          setZoom(function (previous) {
            return clampZoom(previous * (event.deltaY < 0 ? 1.2 : 1 / 1.2));
          });
        }
        stage.addEventListener('wheel', onWheel, { passive: false });
        return function () { stage.removeEventListener('wheel', onWheel); };
      }, [view.data]);

      var name = basename(filePath) || t('fileTabTitle');
      var zoomTools = view.data ? h('div', { className: 'rw-image-tools' },
        h('button', {
          type: 'button', className: 'rw-btn rw-btn-sm', title: t('imageZoomOut'),
          onClick: function () { zoomBy(1 / 1.2); },
        }, '−'),
        h('span', { className: 'rw-image-zoom' }, Math.round(zoom * 100) + '%'),
        h('button', {
          type: 'button', className: 'rw-btn rw-btn-sm', title: t('imageZoomIn'),
          onClick: function () { zoomBy(1.2); },
        }, '+'),
        h('button', {
          type: 'button', className: 'rw-btn rw-btn-sm', title: t('imageFit'),
          onClick: fitToStage,
        }, t('imageFit')),
        h('button', {
          type: 'button', className: 'rw-btn rw-btn-sm', title: t('imageActualSize'),
          onClick: function () { setZoom(1); },
        }, '1:1')) : null;

      var header = h('div', { className: 'rw-image-head' },
        h(FileGlyph, { name: name, size: 15 }),
        h('div', { className: 'rw-editor-title' },
          h('span', { className: 'rw-editor-name', title: name }, name),
          h('span', { className: 'rw-editor-path', title: filePath }, filePath)),
        h('div', { className: 'rw-actions' },
          zoomTools,
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: load, disabled: view.loading }, IconRefresh(12), t('reload'))));

      if (view.loading) {
        return h('div', { className: 'rw-image-preview' }, header,
          h('div', { className: 'rw-editor-message' }, Spinner(14), t('loading')));
      }
      if (view.error) {
        return h('div', { className: 'rw-image-preview' }, header,
          h('div', { className: 'rw-editor-message' },
            h(Banner, { kind: 'error' }, t('imageLoadError') + '：' + messageOf(view.error, t, locale)),
            h('button', { type: 'button', className: 'rw-btn', onClick: load }, IconRefresh(13), t('retry'))));
      }
      var data = view.data;
      var imageStyle = natural
        ? { width: natural.width * zoom + 'px', height: natural.height * zoom + 'px' }
        : { maxWidth: '100%', maxHeight: '100%' };
      return h('div', { className: 'rw-image-preview' },
        header,
        h('div', { className: 'rw-image-stage', ref: stageRef },
          h('div', { className: 'rw-image-canvas' },
            h('img', {
              className: 'rw-image',
              src: 'data:' + data.mime + ';base64,' + data.base64,
              alt: name,
              style: imageStyle,
              onLoad: function (event) {
                var image = event.currentTarget;
                if (image.naturalWidth && image.naturalHeight) {
                  setNatural({ width: image.naturalWidth, height: image.naturalHeight });
                }
              },
              onError: function () {
                setView({ loading: false, error: new Error(t('imageLoadError')), data: null });
              },
            }))),
        h('div', { className: 'rw-editor-status' },
          h('span', { className: 'rw-status-chip' }, data.mime || 'image'),
          h('span', { className: 'rw-status-chip' }, formatBytes(data.size || 0)),
          h('span', { className: 'rw-status-chip' }, Math.round(zoom * 100) + '%'),
          h('span', { className: 'rw-fill', style: { flex: '1 1 auto' } }),
          h('span', { className: 'rw-status-chip' }, t('previewOnly'))));
    }

    function HtmlPreview(props) {
      var ctx = props.ctx;
      var t = props.t;
      var locale = props.locale;
      var scope = props.scope;
      var local = props.local === true;
      var filePath = props.path;
      var state = useState({ loading: true, error: null, data: null });
      var view = state[0];
      var setView = state[1];
      var params = scopeParams(scope);

      var load = useCallback(function () {
        if (!filePath || (!local && !scope)) {
          setView({ loading: false, error: new Error(t('noWorkspace')), data: null });
          return;
        }
        setView({ loading: true, error: null, data: null });
        var request = local ? { path: filePath } : Object.assign({ path: filePath }, params);
        apiCall(local ? 'local.read' : 'fs.read', request).then(function (result) {
          if (result.binary || result.tooLarge) {
            setView({ loading: false, error: new Error(t('htmlLoadError')), data: null });
            return;
          }
          setView({ loading: false, error: null, data: result });
        }).catch(function (error) {
          setView({ loading: false, error: error, data: null });
        });
      }, [scopeKeyOf(scope), filePath, local]);

      useEffect(function () { load(); }, [load]);

      var name = basename(filePath) || t('fileTabTitle');
      var header = h('div', { className: 'rw-image-head' },
        h(FileGlyph, { name: name, size: 15 }),
        h('div', { className: 'rw-editor-title' },
          h('span', { className: 'rw-editor-name', title: name }, name),
          h('span', { className: 'rw-editor-path', title: filePath }, filePath)),
        h('div', { className: 'rw-actions' },
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: load, disabled: view.loading }, IconRefresh(12), t('reload'))));

      if (view.loading) {
        return h('div', { className: 'rw-html-preview' }, header,
          h('div', { className: 'rw-editor-message' }, Spinner(14), t('loading')));
      }
      if (view.error) {
        return h('div', { className: 'rw-html-preview' }, header,
          h('div', { className: 'rw-editor-message' },
            h(Banner, { kind: 'error' }, t('htmlLoadError') + '：' + messageOf(view.error, t, locale)),
            h('button', { type: 'button', className: 'rw-btn', onClick: load }, IconRefresh(13), t('retry'))));
      }
      var data = view.data;
      return h('div', { className: 'rw-html-preview' },
        header,
        h('div', { className: 'rw-html-stage' },
          h('iframe', {
            className: 'rw-html-frame',
            title: name,
            sandbox: '',
            srcDoc: data.content || '',
          })),
        h('div', { className: 'rw-editor-status' },
          h('span', { className: 'rw-status-chip' }, 'HTML'),
          h('span', { className: 'rw-status-chip' }, formatBytes(data.size || 0)),
          h('span', { className: 'rw-fill', style: { flex: '1 1 auto' } }),
          h('span', { className: 'rw-status-chip' }, t('htmlScriptsDisabled'))));
    }

    // ── editor ─────────────────────────────────────────────────────────────

    function colorForToken(colors, type) {
      switch (type) {
        case 'comment': return colors.comment;
        case 'string': return colors.string;
        case 'number': return colors.number;
        case 'keyword': return colors.keyword;
        case 'literal': return colors.literal || colors.number;
        case 'functionName': return colors.functionName;
        case 'typeName': return colors.typeName;
        case 'operator': return colors.operator;
        case 'punctuation': return colors.punctuation;
        default: return null;
      }
    }

    function highlightNodes(text, language, theme, maxChars) {
      if (typeof tokenize !== 'function') return null;
      if (!text || text.length > maxChars) return null;
      var tokens = tokenize(text, language);
      if (!tokens || tokens.length === 0 || tokens.length > 4000) return null;
      var nodes = [];
      var cursor = 0;
      for (var index = 0; index < tokens.length; index += 1) {
        var token = tokens[index];
        if (token.start > cursor) nodes.push(text.slice(cursor, token.start));
        var color = colorForToken(theme.colors, token.type);
        if (color) {
          nodes.push(h('span', { key: 'tk' + index, style: { color: color } }, text.slice(token.start, token.end)));
        } else {
          nodes.push(text.slice(token.start, token.end));
        }
        cursor = token.end;
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    function RemoteFileEditor(props) {
      var ctx = props.ctx;
      var t = props.t;
      var locale = props.locale;
      var scope = props.scope;
      var local = props.local === true;
      var readOnly = props.readOnly === true;
      var filePath = props.path;
      var sidebar = sidebarService(ctx);
      var settings = useRuntimeSettings();
      var theme = getTheme(resolveEditorTheme(settings));
      var language = languageOf(filePath);
      var csvMode = isCsvPath(filePath);
      var csvTableState = useState(true);
      var showCsvTable = csvTableState[0];
      var setShowCsvTable = csvTableState[1];

      var loadState = useState({ loading: true, error: null, file: null });
      var load = loadState[0];
      var setLoad = loadState[1];
      var contentState = useState('');
      var content = contentState[0];
      var setContent = contentState[1];
      var dirtyState = useState(false);
      var dirty = dirtyState[0];
      var setDirty = dirtyState[1];
      var saveState = useState({ saving: false, conflict: false, error: '', ok: false });
      var save = saveState[0];
      var setSave = saveState[1];
      var textareaRef = useRef(null);
      var highlightRef = useRef(null);
      var gutterRef = useRef(null);
      var baseTitle = basename(filePath) || t('fileTabTitle');
      var params = scopeParams(scope);
      var editable = Boolean(load.file && load.file.editable) && !readOnly;

      var loadFile = useCallback(function () {
        if (!filePath || (!local && !scope)) {
          setLoad({ loading: false, error: new Error(t('noWorkspace')), file: null });
          return;
        }
        setLoad({ loading: true, error: null, file: null });
        var readParams = local ? { path: filePath } : Object.assign({ path: filePath }, params);
        apiCall(local ? 'local.read' : 'fs.read', readParams).then(function (result) {
          setLoad({ loading: false, error: null, file: result });
          setContent(result.content || '');
          setDirty(false);
          setSave({ saving: false, conflict: false, error: '', ok: false });
        }).catch(function (error) {
          setLoad({ loading: false, error: error, file: null });
        });
      }, [scopeKeyOf(scope), filePath, local]);

      useEffect(function () { loadFile(); }, [loadFile]);

      useEffect(function () {
        if (typeof props.onDirtyChange === 'function') props.onDirtyChange(dirty);
      }, [dirty]);

      useEffect(function () {
        if (!sidebar || typeof sidebar.updateTab !== 'function' || !props.tabId) return;
        try {
          sidebar.updateTab(props.tabId, { title: (dirty ? '● ' : '') + baseTitle }, props.sessionId);
        } catch (error) { /* ignore */ }
      }, [dirty, baseTitle]);

      function saveFile(force) {
        if (readOnly || !load.file || load.file.binary || load.file.tooLarge || save.saving) return Promise.resolve(false);
        setSave({ saving: true, conflict: false, error: '', ok: false });
        var payload = local ? { path: filePath, content: content } : Object.assign({ path: filePath, content: content }, params);
        if (!force && load.file && typeof load.file.mtime === 'number') payload.expectedMtime = load.file.mtime;
        return apiCall(local ? 'local.write' : 'fs.write', payload).then(function (result) {
          setLoad(function (previous) {
            if (!previous.file) return previous;
            return { loading: false, error: null, file: Object.assign({}, previous.file, { mtime: result.mtime, size: result.size }) };
          });
          setDirty(false);
          setSave({ saving: false, conflict: false, error: '', ok: true });
          setTimeout(function () {
            setSave(function (previous) { return previous.ok ? { saving: false, conflict: false, error: '', ok: false } : previous; });
          }, 2200);
          return true;
        }).catch(function (error) {
          if (error && error.code === 'CONFLICT') {
            setSave({ saving: false, conflict: true, error: '', ok: false });
          } else {
            setSave({ saving: false, conflict: false, error: messageOf(error, t, locale), ok: false });
          }
          return false;
        });
      }

      var saveRef = useRef(null);
      saveRef.current = saveFile;
      useEffect(function () {
        var notify = props.onSaveReady;
        if (typeof notify === 'function') notify(function () { return saveRef.current(false); });
        return function () {
          if (typeof notify === 'function') notify(null);
        };
      }, [filePath, local]);

      useEffect(function () {
        if (!settings.autoSave || !dirty || !editable || save.saving || save.conflict) return undefined;
        var timer = setTimeout(function () { saveRef.current(false); }, 900);
        return function () { clearTimeout(timer); };
      }, [content, dirty, settings.autoSave, editable, save.saving, save.conflict]);

      useEffect(function () {
        if (props.visible === false) return undefined;
        function onKey(event) {
          var mod = event.ctrlKey || event.metaKey;
          if (mod && (event.key === 's' || event.key === 'S')) {
            event.preventDefault();
            saveFile(false);
          }
          if (mod && (event.key === 'f' || event.key === 'F') && !event.shiftKey) {
            // Ctrl+F inside the editor opens the in-file find bar; the browser
            // find dialog cannot see textarea content anyway.
            event.preventDefault();
            openFind();
          }
        }
        window.addEventListener('keydown', onKey, true);
        return function () { window.removeEventListener('keydown', onKey, true); };
      }, [content, dirty, load.file, props.visible]);

      function syncScroll(event) {
        var target = event.currentTarget;
        if (highlightRef.current) {
          highlightRef.current.scrollTop = target.scrollTop;
          highlightRef.current.scrollLeft = target.scrollLeft;
        }
        if (gutterRef.current) gutterRef.current.scrollTop = target.scrollTop;
      }

      // ── in-file find / replace ──────────────────────────────────────────
      var findInputRef = useRef(null);
      var findState = useState({ open: false, query: '', replace: '', caseSensitive: false, index: 0 });
      var find = findState[0];
      var setFind = findState[1];
      var FIND_MATCH_LIMIT = 5000;
      var findResult = useMemo(function () {
        if (!find.open || find.query === '') return { list: [], truncated: false };
        var text = content;
        var needle = find.caseSensitive ? find.query : find.query.toLowerCase();
        var haystack = find.caseSensitive ? text : text.toLowerCase();
        var list = [];
        var from = 0;
        while (list.length < FIND_MATCH_LIMIT) {
          var at = haystack.indexOf(needle, from);
          if (at === -1) break;
          list.push(at);
          from = at + Math.max(needle.length, 1);
        }
        // The list is capped so a huge file cannot freeze the editor, but the
        // counter must not pretend the cap is the real number of matches.
        var truncated = list.length === FIND_MATCH_LIMIT && haystack.indexOf(needle, from) !== -1;
        return { list: list, truncated: truncated };
      }, [content, find.open, find.query, find.caseSensitive]);
      var findMatches = findResult.list;
      var findIndex = findMatches.length === 0 ? -1 : Math.min(Math.max(find.index, 0), findMatches.length - 1);

      function focusMatch(index) {
        var target = textareaRef.current;
        var at = findMatches.length === 0 ? -1 : findMatches[Math.min(Math.max(index, 0), findMatches.length - 1)];
        if (!target || at < 0) return;
        target.focus();
        target.selectionStart = at;
        target.selectionEnd = at + find.query.length;
        // Re-focusing makes the textarea scroll the selection into view.
        target.blur();
        target.focus();
      }

      function stepMatch(delta) {
        if (findMatches.length === 0) return;
        var next = (findIndex + delta + findMatches.length) % findMatches.length;
        setFind(function (previous) { return Object.assign({}, previous, { index: next }); });
        focusMatch(next);
      }

      function openFind() {
        setFind(function (previous) { return Object.assign({}, previous, { open: true }); });
        requestAnimationFrame(function () {
          if (findInputRef.current) {
            findInputRef.current.focus();
            findInputRef.current.select();
          }
        });
      }

      function closeFind() {
        setFind({ open: false, query: '', replace: '', caseSensitive: false, index: 0 });
      }

      function replaceCurrent() {
        if (findMatches.length === 0 || !editable) return;
        var at = findMatches[findIndex];
        var next = content.slice(0, at) + find.replace + content.slice(at + find.query.length);
        setContent(next);
        setDirty(true);
        setSave({ saving: false, conflict: false, error: '', ok: false });
        setFind(function (previous) { return Object.assign({}, previous, { index: Math.min(previous.index, Math.max(findMatches.length - 1, 0)) }); });
      }

      function replaceAll() {
        if (findMatches.length === 0 || !editable || find.query === '') return;
        var escaped = find.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var pattern = new RegExp(escaped, find.caseSensitive ? 'g' : 'gi');
        var next = content.replace(pattern, function () { return find.replace; });
        setContent(next);
        setDirty(true);
        setSave({ saving: false, conflict: false, error: '', ok: false });
        setFind(function (previous) { return Object.assign({}, previous, { index: 0 }); });
      }

      function renderFindBar() {
        if (!find.open) return null;
        var counterTotal = findResult.truncated ? String(findMatches.length) + '+' : findMatches.length;
        var counter = findMatches.length === 0 ? t('findNoMatch') : t('findCounter', { index: findIndex + 1, total: counterTotal });
        return h('div', { className: 'rw-find-bar', role: 'search' },
          h('input', {
            ref: findInputRef,
            className: 'rw-input',
            value: find.query,
            placeholder: t('findPlaceholder'),
            'aria-label': t('findPlaceholder'),
            spellCheck: false,
            onChange: function (event) {
              var value = event.currentTarget.value;
              setFind(function (previous) { return Object.assign({}, previous, { query: value, index: 0 }); });
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') { event.preventDefault(); stepMatch(event.shiftKey ? -1 : 1); }
              if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
            },
          }),
          h('span', { className: 'rw-find-counter', 'aria-live': 'polite' }, counter),
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', title: t('findNext'), disabled: findMatches.length === 0, onClick: function () { stepMatch(1); } }, IconChevron(12)),
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', title: t('findPrev'), disabled: findMatches.length === 0, onClick: function () { stepMatch(-1); } }, h('span', { style: { display: 'inline-flex', transform: 'rotate(180deg)' } }, IconChevron(12))),
          h('input', {
            className: 'rw-input',
            value: find.replace,
            placeholder: t('replacePlaceholder'),
            'aria-label': t('replacePlaceholder'),
            spellCheck: false,
            disabled: !editable,
            onChange: function (event) {
              var value = event.currentTarget.value;
              setFind(function (previous) { return Object.assign({}, previous, { replace: value }); });
            },
            onKeyDown: function (event) {
              if (event.key === 'Enter') { event.preventDefault(); replaceCurrent(); }
              if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
            },
          }),
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', disabled: !editable || findMatches.length === 0, onClick: replaceCurrent }, t('replaceOne')),
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', disabled: !editable || findMatches.length === 0, onClick: replaceAll }, t('replaceAll')),
          h('button', { type: 'button', className: 'rw-icon-btn', title: t('close'), onClick: closeFind }, IconClose(12)));
      }

      var file = load.file;
      var lineCount = useMemo(function () {
        if (content.length > 200000) return null;
        var count = 1;
        for (var index = 0; index < content.length; index += 1) {
          if (content.charCodeAt(index) === 10) count += 1;
        }
        return count;
      }, [content]);
      var gutterLines = typeof lineCount === 'number' && lineCount <= 20000;
      var csvRows = useMemo(function () {
        if (!csvMode) return [];
        var text = content.length > 1000000 ? content.slice(0, 1000000) : content;
        var delimiter = csvDelimiterOf(filePath, text);
        return parseDelimited(text, delimiter).slice(0, 1000).map(function (row) {
          return row.slice(0, 80);
        });
      }, [content, filePath, csvMode]);
      var highlighted = useMemo(function () {
        if (!editable) return null;
        return highlightNodes(content, language, theme, 180000);
      }, [content, language, settings.editorTheme, settings.editorThemeMode, settings.appThemeDark, editable]);

      var colors = theme.colors;
      var containerStyle = {
        '--rw-bg': colors.bg,
        '--rw-fg': colors.fg,
        '--rw-gutter-bg': colors.gutterBg,
        '--rw-gutter-fg': colors.gutterFg,
        '--rw-border': colors.border,
        '--rw-caret': colors.caret,
        '--rw-selection': hexToRgba(colors.selection, 0.35),
        '--rw-head-bg': colors.gutterBg,
        '--rw-status-fg': colors.comment,
      };

      var header = props.hideHeader ? null : h('div', { className: 'rw-editor-head' },
        h(FileGlyph, { name: baseTitle, size: 15 }),
        h('div', { className: 'rw-editor-title' },
          h('span', { className: 'rw-editor-name', title: baseTitle }, baseTitle + (dirty ? ' ●' : '')),
          h('span', { className: 'rw-editor-path', title: filePath }, filePath)),
        h('div', { className: 'rw-actions' },
          props.onOpenTab
            ? h('button', { type: 'button', className: 'rw-icon-btn', title: t('openInTab'), onClick: props.onOpenTab }, IconExternal(13))
            : null,
          props.onClose
            ? h('button', { type: 'button', className: 'rw-icon-btn', title: t('closeEditor'), onClick: props.onClose }, IconClose(13))
            : null,
          csvMode
            ? h('button', {
              type: 'button', className: 'rw-btn rw-btn-sm',
              onClick: function () { setShowCsvTable(function (previous) { return !previous; }); },
              title: showCsvTable ? t('csvSource') : t('csvTable'),
            }, showCsvTable ? t('csvSource') : t('csvTable'))
            : null,
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-sm', onClick: function () { loadFile(); },
            disabled: load.loading || save.saving,
          }, IconRefresh(12), t('reload')),
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary', onClick: function () { saveFile(false); },
            disabled: !editable || save.saving || (csvMode && showCsvTable),
          }, save.saving ? Spinner(12) : IconSave(12), save.saving ? t('saving') : t('save'))));

      if (load.loading) {
        return h('div', { className: 'rw-editor', style: containerStyle }, header,
          h('div', { className: 'rw-editor-message' }, Spinner(14), t('loading')));
      }

      if (load.error) {
        return h('div', { className: 'rw-editor', style: containerStyle }, header,
          h('div', { className: 'rw-editor-message' },
            h(Banner, { kind: 'error' }, t('fileLoadError') + '：' + messageOf(load.error, t, locale)),
            h('button', { type: 'button', className: 'rw-btn', onClick: function () { loadFile(); } }, IconRefresh(13), t('retry'))));
      }

      if (!file) return h('div', { className: 'rw-editor', style: containerStyle }, header);

      var notice = null;
      if (file.binary) notice = h(Banner, { kind: 'warn' }, t('binaryFile') + '（' + formatBytes(file.size) + '）');
      else if (file.tooLarge || file.truncated) notice = h(Banner, { kind: 'warn' }, t('tooLarge', { size: formatBytes(file.size) }));

      var banner = save.error
        ? h(Banner, { kind: 'error' }, save.error)
        : save.conflict
          ? h(Banner, { kind: 'warn' },
            h('div', { className: 'rw-block' },
              h('div', { style: { fontWeight: 600 } }, t('conflictTitle')),
              h('div', { className: 'rw-muted', style: { marginTop: 2 } }, t('conflictBody')),
              h('div', { className: 'rw-actions', style: { marginTop: 8 } },
                h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: function () { loadFile(); } }, IconRefresh(12), t('reload')),
                h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-danger', onClick: function () { saveFile(true); } }, IconSave(12), t('forceSave')))))
          : save.ok
            ? h(Banner, { kind: 'success' }, t('saved'))
            : null;

      var canView = Boolean(load.file && !load.file.binary && !load.file.tooLarge);
      var csvColumnCount = 0;
      csvRows.forEach(function (row) { if (row.length > csvColumnCount) csvColumnCount = row.length; });
      var csvTable = csvRows.length === 0
        ? h('div', { className: 'rw-editor-message' }, t('csvEmpty'))
        : h('div', { className: 'rw-csv-wrap' },
          h('table', { className: 'rw-csv-table' },
            h('thead', null, h('tr', null,
              Array.from({ length: csvColumnCount }, function (_, index) {
                return h('th', { key: 'h' + index, title: csvRows[0][index] || '' }, csvRows[0][index] || '');
              }))),
            h('tbody', null, csvRows.slice(1).map(function (row, rowIndex) {
              return h('tr', { key: 'r' + rowIndex },
                Array.from({ length: csvColumnCount }, function (_, columnIndex) {
                  var value = row[columnIndex] === undefined ? '' : row[columnIndex];
                  return h('td', { key: 'c' + columnIndex, title: value }, value);
                }));
            }))),
          csvRows.length >= 1000 ? h('div', { className: 'rw-csv-note' }, t('csvTruncated')) : null);
      var body = canView
        ? (csvMode && showCsvTable
          ? csvTable
          : h('div', { className: 'rw-editor-body' },
            h('div', { className: 'rw-code' },
              h('div', { className: 'rw-gutter', ref: gutterRef },
                gutterLines
                  ? h('div', { className: 'rw-gutter-inner' }, Array.from({ length: lineCount }, function (_, index) { return index + 1; }).join('\n'))
                  : null),
              h('div', { className: 'rw-code-area' },
                h('pre', { className: 'rw-highlight', ref: highlightRef, 'aria-hidden': 'true' },
                  highlighted || content),
                h('textarea', {
                  ref: textareaRef,
                  className: 'rw-textarea',
                  readOnly: readOnly || !editable,
                  value: content,
                  spellCheck: false,
                  wrap: 'off',
                  onChange: function (event) {
                    setContent(event.currentTarget.value);
                    setDirty(true);
                    setSave({ saving: false, conflict: false, error: '', ok: false });
                  },
                  onScroll: syncScroll,
                  onKeyDown: function (event) {
                    if (!editable) return;
                    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
                      event.preventDefault();
                      var target = event.currentTarget;
                      var start = target.selectionStart;
                      var end = target.selectionEnd;
                      var next = content.slice(0, start) + '    ' + content.slice(end);
                      setContent(next);
                      setDirty(true);
                      requestAnimationFrame(function () {
                        target.selectionStart = start + 4;
                        target.selectionEnd = start + 4;
                      });
                    }
                  },
                })))))
        : h('div', { className: 'rw-editor-message' }, notice, h('span', { className: 'rw-muted' }, t('readOnly')));

      return h('div', { className: 'rw-editor', style: containerStyle },
        header,
        banner ? h('div', { style: { padding: '8px 10px 0' } }, banner) : null,
        renderFindBar(),
        body,
        h('div', { className: 'rw-editor-status' },
          h('span', { className: 'rw-status-chip' }, 'UTF-8'),
          h('span', { className: 'rw-status-chip' }, content.indexOf('\r\n') >= 0 ? 'CRLF' : 'LF'),
          h('span', { className: 'rw-status-chip' }, lineCount === null ? '—' : lineCount + ' ' + t('lineCount')),
          h('span', { className: 'rw-status-chip' }, formatBytes(file.size)),
          dirty
            ? h('span', { className: 'rw-status-chip rw-status-warn' }, t('dirty'))
            : readOnly
              ? h('span', { className: 'rw-status-chip rw-status-error' }, t('readOnly'))
              : file.tooLarge || file.truncated || file.binary
              ? h('span', { className: 'rw-status-chip rw-status-error' }, t('readOnly'))
              : h('span', { className: 'rw-status-chip rw-status-ok' }, theme.label ? (locale === 'zh' ? theme.label.zh : theme.label.en) : theme.id),
          h('span', { className: 'rw-fill', style: { flex: '1 1 auto' } })));
    }

    // ── linked workspace directory workbench ──────────────────────────────

    var CHANGE_STATUS_META = {
      modified: { code: 'M', zh: '修改', en: 'Modified' },
      added: { code: 'A', zh: '新增', en: 'Added' },
      deleted: { code: 'D', zh: '删除', en: 'Deleted' },
      renamed: { code: 'R', zh: '重命名', en: 'Renamed' },
      copied: { code: 'C', zh: '复制', en: 'Copied' },
      untracked: { code: 'U', zh: '未跟踪', en: 'Untracked' },
      conflicted: { code: '!', zh: '冲突', en: 'Conflict' },
      typechange: { code: 'T', zh: '类型变化', en: 'Type changed' },
    };

    function changeMeta(change) {
      return CHANGE_STATUS_META[change && change.status] || CHANGE_STATUS_META.modified;
    }

    function sourceScopeOf(source) {
      if (source && source.kind === 'linked') return { kind: 'linked', id: source.id };
      if (source && source.kind === 'remote') return { kind: 'remote', id: source.id };
      return { kind: 'workspace', id: source ? source.id : '' };
    }

    function sourceMetaOf(source) {
      if (source && source.kind === 'linked') return { linkedId: source.id, linkedName: source.name };
      if (source && source.kind === 'remote') return { remoteId: source.id, remoteName: source.name };
      return { workspaceId: source ? source.id : undefined, workspaceName: source ? source.name : undefined };
    }

    function workspaceRelativePath(rootPath, filePath) {
      var root = String(rootPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
      var file = String(filePath || '').replace(/\\/g, '/');
      if (root === '') return filePath;
      if (file === root) return '';
      if (file.indexOf(root + '/') === 0) return file.slice(root.length + 1);
      return filePath;
    }

    function TreePanel(props) {
      var t = props.t;
      var locale = props.locale;
      var rootPath = props.rootPath;
      var expandedState = useState(function () {
        var set = new Set();
        set.add(rootPath);
        return set;
      });
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var cacheState = useState({ entries: new Map() });
      var cache = cacheState[0];
      var setCache = cacheState[1];
      var pending = useRef(new Set());
      var lastRefreshAt = useRef(new Map());

      useEffect(function () {
        if (!props.refreshTick) return;
        // A background refresh costs one full listing per expanded directory, so
        // it stays quiet while the tab is hidden and never runs more often than
        // REFRESH_MIN_INTERVAL_MS per directory.
        if (typeof document !== 'undefined' && document.hidden) return;
        var now = Date.now();
        Array.from(expanded).forEach(function (path) {
          var at = lastRefreshAt.current.get(path) || 0;
          if (now - at < REFRESH_MIN_INTERVAL_MS) return;
          load(path, true);
        });
      }, [props.refreshTick]);

      function toggle(path) {
        setExpanded(function (previous) {
          var next = new Set(previous);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      }

      function listRequest(path, offset, limit) {
        var params = { path: path, limit: limit || TREE_PAGE_SIZE, offset: offset };
        return props.kind === 'local'
          ? apiCall('local.list', params)
          : apiCall('fs.list', Object.assign(params, scopeParams(props.scope)));
      }

      function applyEntries(list) {
        return props.showHidden ? list : list.filter(function (entry) {
          return String(entry.name || '').charAt(0) !== '.';
        });
      }

      function load(path, silent) {
        if (pending.current.has(path)) return;
        pending.current.add(path);
        lastRefreshAt.current.set(path, Date.now());
        var previousRecord = cache.entries.get(path) || {};
        // A silent refresh keeps as many rows as the user already loaded:
        // re-reading only the first page would drop everything past it.
        var keep = silent ? Math.max(Number(previousRecord.raw) || 0, TREE_PAGE_SIZE) : TREE_PAGE_SIZE;
        keep = Math.min(keep, TREE_PAGE_MAX);
        setCache(function (previous) {
          var entries = new Map(previous.entries);
          var existing = entries.get(path) || {};
          entries.set(path, { loading: !silent, error: null, entries: existing.entries || [], loaded: existing.loaded, raw: existing.raw, total: existing.total, hasMore: existing.hasMore });
          return { entries: entries };
        });
        listRequest(path, 0, keep).then(function (result) {
          pending.current.delete(path);
          setCache(function (previous) {
            var next = new Map(previous.entries);
            var existing = next.get(path) || {};
            var fresh = applyEntries(result.entries || []);
            var freshPaths = new Set(fresh.map(function (entry) { return entry.path; }));
            // Keep rows beyond the refreshed page so a silent refresh cannot
            // shrink a list the user scrolled many pages into.
            var retained = silent
              ? (existing.entries || []).filter(function (entry) { return !freshPaths.has(entry.path); })
              : [];
            var pageRaw = (result.entries || []).length;
            var raw = silent ? Math.max(Number(existing.raw) || 0, pageRaw) : pageRaw;
            var total = Number(result.total) || pageRaw + retained.length;
            next.set(path, {
              loading: false,
              error: null,
              loaded: true,
              entries: fresh.concat(retained),
              raw: raw,
              total: total,
              // A silent refresh asks for `keep` rows; when everything is already
              // loaded the server still reports hasMore for the page it did not
              // return, so trust the row counts instead of the flag alone.
              hasMore: Boolean(result.hasMore) && raw < total,
            });
            return { entries: next };
          });
          setExpanded(function (previous) {
            var next = new Set(previous);
            next.add(path);
            return next;
          });
        }).catch(function (error) {
          pending.current.delete(path);
          setCache(function (previous) {
            var next = new Map(previous.entries);
            next.set(path, { loading: false, error: error, loaded: false, entries: [] });
            return { entries: next };
          });
        });
      }

      function loadMore(path) {
        var record = cache.entries.get(path);
        if (!record || record.loadingMore || !record.hasMore) return;
        // Offset is the number of RAW entries already fetched, not the number of
        // visible rows: hidden entries are filtered out of the list but still
        // occupy positions in the server-side listing.
        var offset = Number(record.raw);
        if (!Number.isFinite(offset)) offset = (record.entries || []).length;
        setCache(function (previous) {
          var next = new Map(previous.entries);
          var current = next.get(path);
          if (current) next.set(path, Object.assign({}, current, { loadingMore: true }));
          return { entries: next };
        });
        listRequest(path, offset).then(function (result) {
          setCache(function (previous) {
            var next = new Map(previous.entries);
            var current = next.get(path) || { entries: [] };
            next.set(path, Object.assign({}, current, {
              loadingMore: false,
              loaded: true,
              entries: current.entries.concat(applyEntries(result.entries || [])),
              raw: offset + (result.entries || []).length,
              total: Number(result.total) || current.total,
              hasMore: Boolean(result.hasMore),
            }));
            return { entries: next };
          });
        }).catch(function (error) {
          setCache(function (previous) {
            var next = new Map(previous.entries);
            var current = next.get(path);
            if (current) next.set(path, Object.assign({}, current, { loadingMore: false, moreError: error }));
            return { entries: next };
          });
        });
      }

      var rootRecord = cache.entries.get(rootPath);
      var rootSiblings = rootRecord && rootRecord.entries ? rootRecord.entries.map(function (item) {
        return { path: item.path, name: item.name, isDir: item.type === 'dir' };
      }) : [];
      return h('div', {
        className: 'rw-tree',
        role: 'tree',
        'aria-label': t('allFiles'),
        onDragOver: function (event) {
          if (!props.onDropOnPath) return;
          event.preventDefault();
          try { event.dataTransfer.dropEffect = 'copy'; } catch (error) { /* ignore */ }
        },
        onDrop: function (event) {
          if (props.onDropOnPath) props.onDropOnPath(rootPath, event);
        },
      }, h(TreeDirectory, {
        path: rootPath,
        name: props.rootName || t('allFiles'),
        depth: 0,
        source: props.source || { kind: props.kind },
        t: t,
        locale: locale,
        expanded: expanded,
        toggle: toggle,
        state: { entries: cache.entries },
        load: load,
        loadMore: loadMore,
        onSelect: props.onSelect,
        onPin: props.onPin,
        onSelectPath: props.onSelectPath,
        onContextMenu: props.onContextMenu,
        onDragStart: props.onDragStartRow
          ? function (event, info) { props.onDragStartRow(props.kind, event, info); }
          : null,
        onDropOnPath: props.onDropOnPath
          ? function (path, event) { props.onDropOnPath(props.kind, path, event); }
          : null,
        selectedPath: props.selectedPath || '',
        selectedSet: props.selectedPaths && props.selectedPaths.length > 0 ? new Set(props.selectedPaths) : null,
        siblings: rootSiblings,
      }));
    }

    function TreeSection(props) {
      return h('div', { className: 'rw-tree-section' + (props.bottom ? ' is-bottom' : '') },
        h('div', { className: 'rw-tree-section-head' },
          props.icon ? h('span', { style: { display: 'inline-flex' } }, props.icon) : null,
          h('span', null, props.title),
          props.extra ? h('span', { className: 'rw-change-meta', style: { marginLeft: 'auto' } }, props.extra) : null),
        h('div', { className: 'rw-tree-section-body' }, props.children));
    }

    function PopoverItem(props) {
      return h('button', {
        type: 'button',
        className: 'rw-popover-item' + (props.on ? ' is-on' : ''),
        onClick: function () { props.onClick(); },
      },
        h('span', null, props.label),
        props.on ? h('span', { style: { display: 'inline-flex' } }, IconCheck(12)) : null);
    }

    function LinkedDirectoryToolbar(props) {
      var t = props.t;
      var menuState = useState(null);
      var menu = menuState[0];
      var setMenu = menuState[1];
      var modeLabel = props.mode === 'changed' ? t('modeChanged') : props.mode === 'changes' ? t('modeChanges') : t('modeAllFiles');
      var openMode = props.openMode || 'editor';

      function close() { setMenu(null); }

      return h('div', { className: 'rw-linked-toolbar' },
        h('span', { className: 'rw-tree-toolbar-title' }, props.title || t('tabTitle')),
        h('div', { className: 'rw-actions', style: { marginLeft: 'auto', gap: 2 } },
          h('div', { className: 'rw-menu-wrap' },
            h('button', {
              type: 'button',
              className: 'rw-icon-btn' + (props.mode !== 'files' ? ' is-on' : ''),
              title: t('switchTree') + ' · ' + modeLabel,
              onClick: function () { setMenu(menu === 'tree' ? null : 'tree'); },
            }, IconTree(14)),
            menu === 'tree'
              ? h(React.Fragment, null,
                h('div', { className: 'rw-menu-backdrop', onClick: close }),
                h('div', { className: 'rw-popover' },
                  h('div', { className: 'rw-popover-label' }, t('switchTree')),
                  [['files', t('modeAllFiles')], ['changed', t('modeChanged')], ['changes', t('modeChanges')]].map(function (item) {
                    return h(PopoverItem, {
                      key: item[0],
                      label: item[1],
                      on: props.mode === item[0],
                      onClick: function () { close(); props.onMode(item[0]); },
                    });
                  })))
              : null),
          h('button', {
            type: 'button',
            className: 'rw-icon-btn' + (props.searchOpen ? ' is-on' : ''),
            title: t('searchInFiles'),
            onClick: props.onToggleSearch,
          }, IconSearch(14)),
          h('div', { className: 'rw-menu-wrap' },
            h('button', {
              type: 'button',
              className: 'rw-icon-btn',
              title: t('openOptions'),
              onClick: function () { setMenu(menu === 'open' ? null : 'open'); },
            }, IconOpenApp(14)),
            menu === 'open'
              ? h(React.Fragment, null,
                h('div', { className: 'rw-menu-backdrop', onClick: close }),
                h('div', { className: 'rw-popover' },
                  h('div', { className: 'rw-popover-label' }, t('openWithTitle')),
                  [['editor', t('openWithEditor')], ['system', t('openWithSystem')], ['copy', t('openWithCopy')]].map(function (item) {
                    return h(PopoverItem, {
                      key: item[0],
                      label: item[1],
                      on: openMode === item[0],
                      onClick: function () { close(); props.onOpenMode(item[0]); },
                    });
                  })))
              : null),
          h('button', {
            type: 'button',
            className: 'rw-icon-btn',
            title: t('terminalRemote'),
            onClick: function () { props.onOpenTerminal('remote'); },
          }, IconTerminal(14)),
          props.localEnabled
            ? h('button', {
              type: 'button',
              className: 'rw-icon-btn',
              title: t('terminalLocal'),
              onClick: function () { props.onOpenTerminal('local'); },
            }, IconTerminal(14))
            : null,
          h('button', {
            type: 'button',
            className: 'rw-icon-btn' + (props.directoryOpen ? ' is-on' : ''),
            title: t('toggleDirectory'),
            onClick: props.onToggleDirectory,
          }, IconPanelRight(14)),
          h('button', {
            type: 'button',
            className: 'rw-icon-btn' + (props.showHidden ? ' is-on' : ''),
            title: props.showHidden ? t('hideHidden') : t('showHidden'),
            onClick: props.onToggleHidden,
          }, props.showHidden ? IconEye(14) : IconEyeOff(14)),
          h('button', {
            type: 'button',
            className: 'rw-icon-btn',
            title: t('transferSelected'),
            disabled: !props.transferEnabled,
            style: props.transferEnabled ? undefined : { opacity: 0.42, cursor: 'default' },
            onClick: props.transferSelected,
          }, IconDownload(14)),
          h('button', {
            type: 'button',
            className: 'rw-icon-btn',
            title: t('refreshTree'),
            onClick: props.onRefresh,
          }, IconRefresh(13))));
    }

    function SearchResults(props) {
      var t = props.t;
      var locale = props.locale;
      var state = props.state;
      var groups = [
        { side: 'remote', label: t('remoteTree'), entries: state.remote || [] },
        { side: 'local', label: t('localTree'), entries: props.hasLocal ? state.local || [] : [] },
      ];
      if (!props.showHidden) {
        groups = groups.map(function (group) {
          return {
            side: group.side,
            label: group.label,
            entries: group.entries.filter(function (entry) {
              var relative = String(entry.relative || entry.path || '');
              return relative.split(/[\\/]/).every(function (segment) { return segment === '' || segment.charAt(0) !== '.'; });
            }),
          };
        });
      }
      var total = groups.reduce(function (sum, group) { return sum + group.entries.length; }, 0);
      return h('div', { className: 'rw-search-results' },
        state.error ? h(Banner, { kind: 'error' }, state.error) : null,
        state.loading ? h('div', { className: 'rw-hint-row' }, Spinner(12), t('loading')) : null,
        !state.loading && total === 0 ? h('div', { className: 'rw-hint-row' }, t('searchEmpty')) : null,
        !state.loading && state.truncated ? h('div', { className: 'rw-hint-row' }, t('searchTruncated')) : null,
        groups.map(function (group) {
          if (group.entries.length === 0) return null;
          return h('div', { key: group.side, className: 'rw-change-group' },
            h('div', { className: 'rw-change-group-title' }, group.label, h('span', { className: 'rw-change-meta' }, String(group.entries.length))),
            group.entries.map(function (entry) {
              return h('button', {
                key: group.side + ':' + entry.path,
                type: 'button',
                className: 'rw-result-row',
                title: entry.path,
                onClick: function () { props.onOpen(group.side, entry.path, entry); },
              },
                h(FileGlyph, { name: entry.relative || entry.path, size: 13 }),
                h('span', { className: 'rw-change-path' }, entry.relative || entry.path),
                h('span', { className: 'rw-change-meta' }, group.side === 'remote' ? t('sideRemote') : t('sideLocal')));
            }));
        }));
    }

    function GitChangesView(props) {
      var t = props.t;
      var locale = props.locale;
      var state = props.git || { loading: true, remote: null, local: null, error: null };
      var selected = props.selected;
      function sideData(side) {
        return side === 'remote' ? state.remote : state.local;
      }
      function renderRows(side) {
        var data = sideData(side);
        if (!data) return null;
        if (data.ok === false && data.error) return h('div', { className: 'rw-hint-row' }, data.error);
        if (data.repo === false) return h('div', { className: 'rw-hint-row' }, t('notGitRepo'));
        var changes = data.changes || [];
        if (changes.length === 0) return h('div', { className: 'rw-hint-row' }, t('noChanges'));
        return changes.map(function (change) {
          var meta = changeMeta(change);
          var label = locale === 'zh' ? meta.zh : meta.en;
          var disabled = change.status === 'deleted';
          return h('button', {
            key: side + ':' + (change.path || '') + ':' + (change.worktree || '') + ':' + (change.index || ''),
            type: 'button',
            className: 'rw-change-row' + (disabled ? ' is-disabled' : ''),
            title: change.path + ' · ' + label + (change.staged ? ' · staged' : ''),
            onClick: function () { if (!disabled) props.onOpen(side, change.absolutePath || change.path, change); },
          },
            h('span', { className: 'rw-st-badge rw-st-' + (change.status || 'modified') }, meta.code),
            h(FileGlyph, { name: change.path || '', size: 13 }),
            h('span', { className: 'rw-change-path' }, change.path || ''),
            h('span', { className: 'rw-change-meta' }, label));
        });
      }

      if (state.loading) return h('div', { className: 'rw-change-list' }, h('div', { className: 'rw-hint-row' }, Spinner(13), t('loading')));
      if (props.mode === 'changed') {
        return h('div', { className: 'rw-change-list' },
          h('div', { className: 'rw-change-group' },
            h('div', { className: 'rw-change-group-title' }, t('changesRemote'), h('span', { className: 'rw-change-meta' }, String((sideData('remote') && sideData('remote').changes ? sideData('remote').changes.length : 0)))),
            renderRows('remote')),
          selected && selected.kind === 'linked'
            ? h('div', { className: 'rw-change-group' },
              h('div', { className: 'rw-change-group-title' }, t('changesLocal'), h('span', { className: 'rw-change-meta' }, String((sideData('local') && sideData('local').changes ? sideData('local').changes.length : 0)))),
              renderRows('local'))
            : null);
      }

      var remoteChanges = (sideData('remote') && sideData('remote').changes) || [];
      var localChanges = (sideData('local') && sideData('local').changes) || [];
      var rows = [];
      remoteChanges.forEach(function (change) { rows.push({ side: 'remote', change: change }); });
      localChanges.forEach(function (change) { rows.push({ side: 'local', change: change }); });
      if (rows.length === 0) {
        return h('div', { className: 'rw-change-list' }, h('div', { className: 'rw-hint-row' }, t('noChanges')));
      }
      return h('div', { className: 'rw-change-list' },
        rows.map(function (row) {
          var meta = changeMeta(row.change);
          var label = locale === 'zh' ? meta.zh : meta.en;
          var disabled = row.change.status === 'deleted';
          return h('button', {
            key: row.side + ':' + row.change.path + ':' + (row.change.index || '') + ':' + (row.change.worktree || ''),
            type: 'button',
            className: 'rw-change-row' + (disabled ? ' is-disabled' : ''),
            title: row.change.path + ' · ' + label,
            onClick: function () { if (!disabled) props.onOpen(row.side, row.change.absolutePath || row.change.path, row.change); },
          },
            h('span', { className: 'rw-st-badge rw-st-' + (row.change.status || 'modified') }, meta.code),
            h(FileGlyph, { name: row.change.path || '', size: 13 }),
            h('span', { className: 'rw-change-path' }, row.change.path || ''),
            h('span', { className: 'rw-change-meta' }, (row.side === 'remote' ? t('sideRemote') : t('sideLocal')) + ' · ' + label));
        }));
    }

    // ── context menu / dialogs / transfer queue ───────────────────────────

    function parentPathOf(filePath, side) {
      var text = String(filePath || '');
      var slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
      if (slash < 0) return side === 'remote' ? '/' : text;
      if (slash === 0) return text.slice(0, 1);
      return text.slice(0, slash);
    }

    function joinChildPath(parent, name, side) {
      var text = String(parent || '');
      var sep = side === 'remote' ? '/' : (text.indexOf('\\') >= 0 ? '\\' : '/');
      if (text === '' || text === '/' || text.endsWith('/') || text.endsWith('\\')) return text + name;
      return text + sep + name;
    }

    function formatFileMode(mode) {
      if (typeof mode !== 'number') return '';
      return '0' + (mode & 0o777).toString(8).padStart(3, '0');
    }

    function ContextMenu(props) {
      var menu = props.menu;
      var items = props.items;
      var style = {
        left: Math.max(8, Math.min(menu.x, window.innerWidth - 260)),
        top: Math.max(8, Math.min(menu.y, window.innerHeight - Math.min(420, items.length * 28 + 40))),
      };
      useEffect(function () {
        function onKey(event) { if (event.key === 'Escape') props.onClose(); }
        window.addEventListener('keydown', onKey);
        return function () { window.removeEventListener('keydown', onKey); };
      }, []);
      function renderItem(item, key) {
        if (item.separator) return h('div', { key: key, className: 'rw-ctx-sep' });
        if (item.sub) {
          return h('div', { key: key, className: 'rw-ctx-item has-sub' },
            h('span', null, item.label),
            h('span', { className: 'rw-ctx-arrow' }, IconChevron(10)),
            h('div', { className: 'rw-ctx-sub' }, item.sub.map(function (child, index) {
              return h('button', {
                key: key + ':' + index,
                type: 'button',
                className: 'rw-ctx-item' + (child.disabled ? ' is-disabled' : ''),
                onClick: function () { if (child.disabled) return; props.onClose(); child.onSelect(); },
              }, child.label);
            })));
        }
        return h('button', {
          key: key,
          type: 'button',
          className: 'rw-ctx-item' + (item.disabled ? ' is-disabled' : ''),
          onClick: function () { if (item.disabled) return; props.onClose(); item.onSelect(); },
        }, item.label);
      }
      return h('div', {
        className: 'rw-ctx-backdrop',
        onMouseDown: props.onClose,
        onContextMenu: function (event) { event.preventDefault(); props.onClose(); },
      }, h('div', {
        className: 'rw-ctx-menu',
        style: style,
        onMouseDown: function (event) { event.stopPropagation(); },
      }, items.map(renderItem)));
    }

    // ── first-run welcome card ──────────────────────────────────────────────

    // Shown once per browser profile: the flag lives in localStorage so the
    // dialog never reopens on refresh, and a fresh DSH install opens it again.
    var WELCOME_KEY = 'dsh-linked-workspace:welcome';

    function welcomeSeen() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return true;
        return window.localStorage.getItem(WELCOME_KEY) === '1';
      } catch (error) {
        return true;
      }
    }

    function welcomeRemember() {
      try {
        if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(WELCOME_KEY, '1');
      } catch (error) { /* storage unavailable: the card simply shows again */ }
    }

    function WelcomeRow(props) {
      return h('div', { className: 'rw-welcome-row' },
        h('div', { className: 'rw-welcome-row-main' }, props.main),
        h('div', { className: 'rw-welcome-row-where' }, props.where));
    }

    function WelcomeCard(props) {
      var locale = useLocale(props.ctx);
      var t = useMemo(function () { return makeT(locale); }, [locale]);
      var state = useState(function () { return !welcomeSeen(); });
      var open = state[0];
      var setOpen = state[1];
      function close() { welcomeRemember(); setOpen(false); }
      useEffect(function () {
        if (!open) return undefined;
        function onKey(event) {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          welcomeRemember();
          setOpen(false);
        }
        window.addEventListener('keydown', onKey, true);
        return function () { window.removeEventListener('keydown', onKey, true); };
      }, [open]);
      if (!open) return null;
      var rows = [
        { main: t('welcomeCreate'), where: t('welcomeCreateWhere') },
        { main: t('welcomeBrowse'), where: t('welcomeBrowseWhere') },
        { main: t('welcomeTools'), where: t('welcomeToolsWhere') },
        { main: t('welcomePassword'), where: t('welcomePasswordWhere') },
      ];
      return h('div', {
        className: 'rw-welcome-backdrop',
        onMouseDown: function (event) { if (event.target === event.currentTarget) close(); },
      }, h('div', {
        className: 'rw-welcome',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('welcomeTitle'),
      },
        h('button', {
          type: 'button',
          className: 'rw-welcome-x',
          'aria-label': t('close'),
          onClick: close,
        }, IconClose(14)),
        h('div', { className: 'rw-welcome-eyebrow' }, h('span', { className: 'rw-welcome-dot' }), t('welcomeEyebrow')),
        h('div', { className: 'rw-welcome-title' }, t('welcomeTitle')),
        h('div', { className: 'rw-welcome-lead' }, t('welcomeLead')),
        h('div', { className: 'rw-welcome-rows' }, rows.map(function (row, index) {
          return h(WelcomeRow, { key: String(index), main: row.main, where: row.where });
        })),
        h('div', { className: 'rw-welcome-foot' },
          h('a', {
            className: 'rw-btn rw-btn-primary',
            href: 'https://github.com/jiahui-huang1/dsh-linked-workspace',
            target: '_blank',
            rel: 'noreferrer',
          }, t('welcomeStar')),
          h('button', { type: 'button', className: 'rw-btn', onClick: close }, t('welcomeDone')))));
    }

    function DialogShell(props) {
      return h('div', {
        className: 'rw-dialog-backdrop',
        onMouseDown: function (event) { if (event.target === event.currentTarget) props.onClose(); },
      }, h('div', { className: 'rw-dialog' },
        h('div', { className: 'rw-dialog-title' }, props.title),
        props.children));
    }

    function PromptDialog(props) {
      var state = useState(props.value || '');
      var value = state[0];
      var setValue = state[1];
      var statusState = useState({ busy: false, error: '' });
      var status = statusState[0];
      var setStatus = statusState[1];
      var pendingRef = useRef(false);
      var mountedRef = useRef(true);
      useEffect(function () {
        mountedRef.current = true;
        return function () { mountedRef.current = false; };
      }, []);
      function close() { if (!pendingRef.current) props.onClose(); }
      function submit() {
        if (value.trim() === '' || pendingRef.current) return;
        pendingRef.current = true;
        setStatus({ busy: true, error: '' });
        Promise.resolve().then(function () { return props.onSubmit(value.trim()); }).then(function () {
          pendingRef.current = false;
          if (mountedRef.current) setStatus({ busy: false, error: '' });
        }).catch(function (error) {
          pendingRef.current = false;
          if (mountedRef.current) setStatus({ busy: false, error: messageOf(error, props.t, props.locale) });
        });
      }
      return h(DialogShell, { title: props.title, onClose: close },
        h('label', { className: 'rw-dialog-label' }, props.label),
        h('input', {
          className: 'rw-dialog-input',
          value: value,
          disabled: status.busy,
          autoFocus: true,
          spellCheck: false,
          onChange: function (event) { setValue(event.currentTarget.value); },
          onKeyDown: function (event) {
            if (event.key === 'Enter' && (!event.nativeEvent || !event.nativeEvent.isComposing)) { event.preventDefault(); submit(); }
            else if (event.key === 'Escape') close();
          },
        }),
        status.error ? h(Banner, { kind: 'error' }, status.error) : null,
        h('div', { className: 'rw-dialog-actions' },
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', disabled: status.busy, onClick: close }, props.t('cancel')),
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary', disabled: status.busy || value.trim() === '', onClick: submit }, props.t(status.busy ? 'loading' : 'confirm'))));
    }

    function ConfirmDialog(props) {
      return h(DialogShell, { title: props.title, onClose: props.onClose },
        h('div', { className: 'rw-dialog-message' }, props.message),
        h('div', { className: 'rw-dialog-actions' },
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: props.onClose }, props.t('cancel')),
          props.secondaryLabel
            ? h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary', onClick: props.onSecondary }, props.secondaryLabel)
            : null,
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-danger', onClick: props.onConfirm }, props.confirmLabel)));
    }

    function PropertiesDialog(props) {
      return h(DialogShell, { title: props.title, onClose: props.onClose },
        h('div', { className: 'rw-props' }, props.rows.map(function (row) {
          return h(React.Fragment, { key: row.key },
            h('div', { className: 'rw-props-key' }, row.label),
            h('div', { className: 'rw-props-value', title: String(row.value) }, String(row.value)));
        })),
        h('div', { className: 'rw-dialog-actions' },
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: props.onClose }, props.t('close'))));
    }

    function joinRelativePath(parent, relative, side) {
      var sep = side === 'remote' ? '/' : (String(parent || '').indexOf('\\') >= 0 ? '\\' : '/');
      var base = String(parent || '').replace(/[\\/]+$/, '');
      var tail = String(relative || '').split('/').filter(function (part) { return part !== ''; }).join(sep);
      if (base === '') return sep + tail;
      if (base === '/') return '/' + tail;
      return base + sep + tail;
    }

    function CompareDialog(props) {
      var t = props.t;
      var data = props.data;
      function rowAction(side, row, kind) {
        var label = kind === 'push' ? t('comparePush') : t('comparePull');
        var title = label + ' · ' + row.path;
        return h('button', {
          key: kind,
          type: 'button',
          className: 'rw-btn rw-btn-sm rw-compare-act',
          title: title,
          onClick: function () {
            if (kind === 'push') props.onPush(row.path);
            else props.onPull(row.path);
          },
        }, label);
      }
      function section(key, title, rows, count, side, actions) {
        return h('div', { key: key, className: 'rw-compare-section' },
          h('div', { className: 'rw-compare-title' }, title + ' (' + count + ')'),
          count === 0
            ? h('div', { className: 'rw-compare-empty' }, t('compareNone'))
            : rows.map(function (row) {
              var size = row.size != null ? row.size : row.localSize;
              return h('div', { key: row.path, className: 'rw-compare-item' },
                h('button', {
                  type: 'button',
                  className: 'rw-compare-row',
                  title: row.path,
                  onClick: function () { props.onOpen(side, row.path); },
                },
                h('span', { className: 'rw-compare-path' }, row.path),
                h('span', { className: 'rw-compare-size' }, typeof size === 'number' ? formatBytes(size) : '')),
                actions && actions.length > 0 ? h('span', { className: 'rw-compare-actions' }, actions.map(function (kind) { return rowAction(side, row, kind); })) : null);
            }));
      }
      var notes = [];
      if (data.localMissing) notes.push(t('compareLocalMissing'));
      if (data.remoteTruncated) notes.push(t('compareTruncatedRemote'));
      if (data.localTruncated) notes.push(t('compareTruncatedLocal'));
      var note = notes.length > 0
        ? h('div', { className: 'rw-dialog-note' }, notes.join(' '))
        : null;
      return h(DialogShell, { title: props.title, onClose: props.onClose },
        h('div', { className: 'rw-dialog-message rw-compare-root', title: data.localPath }, data.localPath),
        note,
        section('onlyLocal', t('compareOnlyLocal'), data.onlyLocal || [], data.counts.onlyLocal, 'local', ['push']),
        section('onlyRemote', t('compareOnlyRemote'), data.onlyRemote || [], data.counts.onlyRemote, 'remote', ['pull']),
        section('changed', t('compareChanged'), data.changed || [], data.counts.changed, 'remote', ['push', 'pull']),
        data.truncated ? h('div', { className: 'rw-dialog-note' }, t('compareTruncated')) : null,
        h('div', { className: 'rw-dialog-actions' },
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: props.onClose }, t('close'))));
    }

    function MoveDialog(props) {
      var picker = props.side === 'local'
        ? h(LocalPathPicker, {
          t: props.t, locale: props.locale, initialPath: props.initialPath, root: props.root,
          onPick: props.onPick,
        })
        : h(ScopePathPicker, {
          t: props.t, locale: props.locale, scope: props.scope, root: props.root,
          initialPath: props.initialPath, onPick: props.onPick,
        });
      return h(DialogShell, { title: props.title, onClose: props.onClose },
        h('div', { className: 'rw-dialog-message' }, props.message),
        picker,
        h('div', { className: 'rw-dialog-actions' },
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: props.onClose }, props.t('cancel'))));
    }

    function QueueDialog(props) {
      return h(DialogShell, { title: props.title, onClose: props.onClose },
        props.queue.length === 0
          ? h('div', { className: 'rw-dialog-message' }, props.t('queueEmpty'))
          : props.queue.map(function (entry) {
            return h('div', { key: entry.id, className: 'rw-queue-row' },
              h('span', { className: 'rw-queue-label', title: entry.path }, entry.label),
              h('span', { className: 'rw-queue-state' }, entry.message || entry.state),
              entry.state === 'error' && props.onRetry
                ? h('button', {
                  type: 'button',
                  className: 'rw-btn rw-btn-sm',
                  onClick: function () { props.onRetry(entry); },
                }, props.t('queueRetry'))
                : null);
          }),
        h('div', { className: 'rw-dialog-actions' },
          props.queue.some(function (entry) { return entry.state === 'done' || entry.state === 'error'; })
            ? h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: props.onClear }, props.t('queueClear'))
            : null,
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: props.onClose }, props.t('close'))));
    }

    function DocumentPane(props) {
      var ctx = props.ctx;
      var t = props.t;
      var locale = props.locale;
      var scope = props.scope;
      var path = props.path;
      var local = props.local === true;
      var onSaved = props.onSaved;
      var settings = useRuntimeSettings();
      var kind = documentKindOf(path);
      var stateRef = useState({
        loading: true, error: '', data: null, text: '', dirty: false, saving: false,
        preview: false, html: '', previewLoading: false, page: 0, sheet: 0, slide: 0,
        updates: {}, pptxUpdates: {}, rotations: {}, deleted: {}, pdfLoading: false, notice: '',
        findOpen: false, findQuery: '', findIndex: 0,
      });
      var state = stateRef[0];
      var setState = stateRef[1];
      var docTextareaRef = useRef(null);

      function patch(next) {
        setState(function (previous) { return Object.assign({}, previous, next); });
      }

      function params(extra) {
        var base = local ? { path: path } : Object.assign({ path: path }, scopeParams(scope));
        return Object.assign(base, extra || {});
      }

      function load() {
        patch({ loading: true, error: '', notice: '' });
        apiCall('docs.read', params()).then(function (result) {
          patch({
            loading: false, error: '', data: result,
            text: result.kind === 'markdown' ? String(result.text || '') : '',
            preview: false, html: '', page: 0, sheet: 0, slide: 0,
            updates: {}, pptxUpdates: {}, rotations: {}, deleted: {}, pdfLoading: false, dirty: false,
          });
        }).catch(function (error) {
          patch({ loading: false, error: messageOf(error, t, locale) });
        });
      }

      useEffect(function () { load(); }, [path, local, scope && scope.kind, scope && scope.id]);

      useEffect(function () {
        if (typeof props.onDirtyChange === 'function') props.onDirtyChange(state.dirty);
      }, [state.dirty]);

      function save() {
        if (state.saving) return Promise.resolve(false);
        patch({ saving: true, error: '', notice: '' });
        var data = {};
        if (kind === 'markdown') data = { text: state.text };
        if (kind === 'docx' && state.data) data = { paragraphs: state.data.paragraphs || [], tables: state.data.tables || [] };
        if (kind === 'xlsx') data = { updates: Object.keys(state.updates).map(function (key) { return state.updates[key]; }) };
        if (kind === 'pptx') data = { updates: Object.keys(state.pptxUpdates).map(function (key) { return state.pptxUpdates[key]; }) };
        if (kind === 'pdf' && state.data) {
          data = {
            metadata: state.data.metadata || {},
            rotations: Object.keys(state.rotations).map(function (index) { return { index: Number(index), degrees: state.rotations[index] }; }),
            deleted: Object.keys(state.deleted).filter(function (index) { return state.deleted[index]; }).map(Number),
          };
        }
        return apiCall('docs.write', params({ data: data, expectedMtime: state.data ? state.data.mtime : undefined })).then(function (result) {
          patch({
            saving: false,
            dirty: false,
            notice: t('saved'),
            data: state.data ? Object.assign({}, state.data, { mtime: result.mtime, size: result.size }) : state.data,
          });
          if (onSaved) onSaved();
          return true;
        }).catch(function (error) {
          patch({ saving: false, error: messageOf(error, t, locale) });
          return false;
        });
      }

      var saveRef = useRef(null);
      saveRef.current = save;
      useEffect(function () {
        var notify = props.onSaveReady;
        if (typeof notify === 'function') notify(function () { return saveRef.current(); });
        return function () {
          if (typeof notify === 'function') notify(null);
        };
      }, [path, local]);

      useEffect(function () {
        if (props.visible === false) return undefined;
        function onKey(event) {
          var mod = event.ctrlKey || event.metaKey;
          if (!mod) return;
          var key = String(event.key || '').toLowerCase();
          if (key === 's') {
            event.preventDefault();
            saveRef.current();
            return;
          }
          // Read-only find inside the document editor (no replace).
          if (key === 'f' && kind === 'markdown' && !state.preview) {
            event.preventDefault();
            patch({ findOpen: true });
          }
        }
        window.addEventListener('keydown', onKey, true);
        return function () { window.removeEventListener('keydown', onKey, true); };
      }, [props.visible, kind, state.preview]);

      function docMatches() {
        var query = state.findQuery;
        if (!query) return [];
        var haystack = state.text;
        var needle = query.toLowerCase();
        var lower = haystack.toLowerCase();
        var found = [];
        var from = 0;
        while (found.length < 2000) {
          var at = lower.indexOf(needle, from);
          if (at < 0) break;
          found.push(at);
          from = at + Math.max(needle.length, 1);
        }
        return found;
      }

      function stepDocMatch(delta) {
        var matches = docMatches();
        if (matches.length === 0) return;
        var next = ((state.findIndex + delta) % matches.length + matches.length) % matches.length;
        patch({ findIndex: next });
        var area = docTextareaRef.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(matches[next], matches[next] + state.findQuery.length);
        var ratio = matches[next] / Math.max(area.value.length, 1);
        area.scrollTop = Math.max(0, ratio * area.scrollHeight - area.clientHeight / 2);
      }

      function closeDocFind() {
        patch({ findOpen: false });
        if (docTextareaRef.current) docTextareaRef.current.focus();
      }

      useEffect(function () {
        if (!settings.autoSave || !state.dirty || state.saving) return undefined;
        var timer = setTimeout(function () { saveRef.current(); }, 900);
        return function () { clearTimeout(timer); };
      }, [settings.autoSave, state.dirty, state.saving, state.text, state.data, state.updates, state.pptxUpdates, state.rotations, state.deleted]);

      function showPreview() {
        var next = !state.preview;
        patch({ preview: next, previewLoading: next && !state.html });
        if (!next || state.html) return;
        apiCall('docs.mdPreview', params({ text: state.text })).then(function (result) {
          patch({ previewLoading: false, html: sanitizeDocumentHtml(result.html) });
        }).catch(function (error) {
          patch({ previewLoading: false, error: messageOf(error, t, locale) });
        });
      }

      function exportPdf() {
        patch({ saving: true, error: '', notice: '' });
        apiCall('docs.mdPdf', params({ text: state.text })).then(function (result) {
          patch({ saving: false, notice: t('docExportDone', { path: result.path }) });
          if (onSaved) onSaved();
        }).catch(function (error) {
          patch({ saving: false, error: messageOf(error, t, locale) });
        });
      }

      function updateParagraph(index, value) {
        var data = state.data || {};
        var paragraphs = (data.paragraphs || []).slice();
        paragraphs[index] = Object.assign({}, paragraphs[index], { text: value });
        patch({ data: Object.assign({}, data, { paragraphs: paragraphs }), dirty: true });
      }

      function updateTableCell(tableIndex, rowIndex, cellIndex, value) {
        var data = state.data || {};
        var tables = (data.tables || []).map(function (rows) { return rows.map(function (row) { return row.slice(); }); });
        if (!tables[tableIndex] || !tables[tableIndex][rowIndex]) return;
        tables[tableIndex][rowIndex][cellIndex] = value;
        patch({ data: Object.assign({}, data, { tables: tables }), dirty: true });
      }

      function updateCell(sheetName, cell, value) {
        var key = sheetName + '!' + cell;
        var updates = Object.assign({}, state.updates);
        updates[key] = { sheet: sheetName, cell: cell, value: value };
        patch({ updates: updates, dirty: true });
      }

      function updateSlideText(slideIndex, shapeIndex, value) {
        var key = slideIndex + ':' + shapeIndex;
        var updates = Object.assign({}, state.pptxUpdates);
        updates[key] = { slide: slideIndex, shape: shapeIndex, text: value };
        patch({ pptxUpdates: updates, dirty: true });
      }

      function goPdfPage(index) {
        if (index < 0 || index >= (state.data.pageCount || 0)) return;
        var cached = (state.data.pages || []).filter(function (page) { return page.index === index; })[0];
        if (cached) {
          patch({ page: index });
          return;
        }
        patch({ pdfLoading: true, error: '' });
        apiCall('docs.pdfPage', params({ page: index })).then(function (result) {
          var pages = (state.data.pages || []).filter(function (page) { return page.index !== result.pages[0].index; }).concat(result.pages);
          pages.sort(function (left, right) { return left.index - right.index; });
          patch({ data: Object.assign({}, state.data, { pages: pages }), page: index, pdfLoading: false });
        }).catch(function (error) {
          patch({ pdfLoading: false, error: messageOf(error, t, locale) });
        });
      }

      function stepPdfPage(delta) {
        var total = state.data.pageCount || 0;
        var next = state.page + delta;
        while (next >= 0 && next < total) {
          if (!state.deleted[next]) {
            goPdfPage(next);
            return;
          }
          next += delta;
        }
      }

      var toolbar = h('div', { className: 'rw-doc-toolbar' },
        h('span', { className: 'rw-chip' }, kind.toUpperCase()),
        h('span', { className: 'rw-hint', style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: path }, path),
        kind === 'markdown' ? h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: showPreview }, state.preview ? t('docEdit') : t('docPreview')) : null,
        kind === 'markdown' ? h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: exportPdf, disabled: state.saving }, IconDownload(12), t('exportPdf')) : null,
        h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary', onClick: save, disabled: state.saving || !state.dirty }, state.saving ? Spinner(12) : IconSave(12), state.saving ? t('saving') : t('save')));

      if (state.loading) {
        return h('div', { className: 'rw-doc' }, toolbar, h('div', { className: 'rw-editor-message' }, Spinner(14), t('loading')));
      }
      if (state.error && !state.data) {
        return h('div', { className: 'rw-doc' }, toolbar,
          h('div', { className: 'rw-editor-message' },
            h(Banner, { kind: 'error' }, state.error),
            h('button', { type: 'button', className: 'rw-btn', onClick: load }, IconRefresh(13), t('reload'))));
      }

      var body = null;
      if (kind === 'markdown') {
        body = state.preview
          ? h('div', { className: 'rw-doc-body' },
            state.previewLoading ? h('div', { className: 'rw-editor-message' }, Spinner(14), t('loading')) : null,
            state.html ? h('div', { className: 'rw-doc-preview', dangerouslySetInnerHTML: { __html: state.html } }) : null)
          : h('div', { className: 'rw-doc-body' },
            state.findOpen ? h('div', { className: 'rw-find-bar rw-doc-find' },
              h('input', {
                className: 'rw-input',
                value: state.findQuery,
                placeholder: t('findPlaceholder'),
                'aria-label': t('findPlaceholder'),
                spellCheck: false,
                autoFocus: true,
                onChange: function (event) { patch({ findQuery: event.currentTarget.value, findIndex: 0 }); },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') { event.preventDefault(); stepDocMatch(event.shiftKey ? -1 : 1); }
                  if (event.key === 'Escape') { event.preventDefault(); closeDocFind(); }
                },
              }),
              h('span', { className: 'rw-find-counter', 'aria-live': 'polite' },
                (function () {
                  var total = docMatches().length;
                  if (state.findQuery === '') return '';
                  return total === 0 ? t('findNoMatch') : t('findCounter', { index: state.findIndex + 1, total: total });
                })()),
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', title: t('findPrev'), onClick: function () { stepDocMatch(-1); } }, h('span', { style: { display: 'inline-flex', transform: 'rotate(180deg)' } }, IconChevron(12))),
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', title: t('findNext'), onClick: function () { stepDocMatch(1); } }, IconChevron(12)),
              h('button', { type: 'button', className: 'rw-icon-btn', title: t('close'), onClick: closeDocFind }, IconClose(12)))
              : null,
            h('textarea', {
              ref: docTextareaRef,
              className: 'rw-doc-textarea', value: state.text, spellCheck: false,
              onChange: function (event) { patch({ text: event.currentTarget.value, dirty: true, html: '' }); },
            }));
      } else if (kind === 'pdf' && state.data) {
        var total = state.data.pageCount || 0;
        var current = (state.data.pages || []).filter(function (page) { return page.index === state.page; })[0] || null;
        body = h('div', { className: 'rw-doc-body' },
          h('div', { className: 'rw-doc-field' },
            h('label', null, t('docPdfTitle')),
            h('input', { className: 'rw-doc-input', style: { flex: '1 1 auto' }, value: (state.data.metadata && state.data.metadata.title) || '', onChange: function (event) { patch({ data: Object.assign({}, state.data, { metadata: Object.assign({}, state.data.metadata, { title: event.currentTarget.value }) }), dirty: true }); } }),
            h('label', null, t('docPdfAuthor')),
            h('input', { className: 'rw-doc-input', style: { flex: '1 1 auto' }, value: (state.data.metadata && state.data.metadata.author) || '', onChange: function (event) { patch({ data: Object.assign({}, state.data, { metadata: Object.assign({}, state.data.metadata, { author: event.currentTarget.value }) }), dirty: true }); } })),
          h('div', { className: 'rw-inline', style: { justifyContent: 'space-between', margin: '6px 0' } },
            h('div', { className: 'rw-inline' },
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', disabled: state.page <= 0, onClick: function () { stepPdfPage(-1); } }, '‹'),
              h('span', { className: 'rw-hint' }, t('docPageOf', { page: state.page + 1, total: total })),
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', disabled: state.page >= total - 1, onClick: function () { stepPdfPage(1); } }, '›')),
            h('div', { className: 'rw-inline' },
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', disabled: !current, onClick: function () { var rotations = Object.assign({}, state.rotations); rotations[state.page] = ((rotations[state.page] || (current && current.rotation) || 0) + 90) % 360; patch({ rotations: rotations, dirty: true }); } }, t('docRotate')),
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-danger', disabled: total <= 1, onClick: function () { var deleted = Object.assign({}, state.deleted); deleted[state.page] = true; var next = state.page + 1; while (next < total && deleted[next]) next += 1; if (next >= total) { next = state.page - 1; while (next >= 0 && deleted[next]) next -= 1; } var nextPage = next >= 0 ? next : state.page; patch({ deleted: deleted, dirty: true, page: nextPage }); if (next >= 0 && !((state.data.pages || []).some(function (page) { return page.index === next; }))) goPdfPage(next); } }, t('docDeletePage')))),
          state.pdfLoading ? h('div', { className: 'rw-editor-message' }, Spinner(14), t('loading')) : null,
          current ? h('img', { className: 'rw-doc-pdf-page', src: current.png, style: { transform: 'rotate(' + ((state.rotations[current.index] || current.rotation || 0) % 360) + 'deg)' } }) : null);
      } else if (kind === 'docx' && state.data) {
        var paragraphs = state.data.paragraphs || [];
        var tables = state.data.tables || [];
        body = h('div', { className: 'rw-doc-body' },
          paragraphs.map(function (paragraph, index) {
            return h('div', { key: 'p' + index, className: 'rw-doc-block' },
              h('div', { className: 'rw-doc-block-label' }, (paragraph.style || t('docParagraph')) + ' · ' + (index + 1)),
              h('textarea', { value: paragraph.text || '', onChange: function (event) { updateParagraph(index, event.currentTarget.value); } }));
          }),
          tables.map(function (rows, tableIndex) {
            return h('div', { key: 't' + tableIndex },
              h('div', { className: 'rw-doc-block-label' }, t('docTable') + ' ' + (tableIndex + 1)),
              h('table', { className: 'rw-doc-table' }, h('tbody', null,
                rows.map(function (row, rowIndex) {
                  return h('tr', { key: rowIndex }, row.map(function (cell, cellIndex) {
                    return h('td', { key: cellIndex }, h('input', { value: cell || '', onChange: function (event) { updateTableCell(tableIndex, rowIndex, cellIndex, event.currentTarget.value); } }));
                  }));
                }))));
          }));
      } else if (kind === 'xlsx' && state.data) {
        var sheets = state.data.sheets || [];
        var active = sheets[Math.min(state.sheet, Math.max(sheets.length - 1, 0))] || { name: '', rows: [] };
        var columns = Math.max(active.maxCol || 0, 8);
        var header = h('tr', null, h('th', null, ''), Array.from({ length: columns }, function (_, index) { return h('th', { key: index }, String.fromCharCode(65 + index)); }));
        var gridRows = (active.rows || []).map(function (row, rowIndex) {
          return h('tr', { key: rowIndex },
            h('th', null, String(rowIndex + 1)),
            Array.from({ length: columns }, function (_, colIndex) {
              var cell = String.fromCharCode(65 + colIndex) + (rowIndex + 1);
              var value = row[colIndex];
              return h('td', { key: colIndex }, h('input', {
                value: value === null || value === undefined ? '' : String(value),
                onChange: function (event) { updateCell(active.name, cell, event.currentTarget.value); },
              }));
            }));
        });
        body = h('div', { className: 'rw-doc-body', style: { padding: 0, overflow: 'hidden' } },
          h('div', { className: 'rw-doc-tabs' }, sheets.map(function (sheet, index) {
            return h('button', { key: sheet.name, type: 'button', className: 'rw-doc-tab' + (index === state.sheet ? ' is-on' : ''), onClick: function () { patch({ sheet: index }); } }, sheet.name);
          })),
          active.truncated
            ? h('div', { className: 'rw-doc-note' }, t('sheetTruncated', { rows: active.maxRow || 0, cols: active.maxCol || 0 }))
            : null,
          (state.data.sheetCount || sheets.length) > sheets.length
            ? h('div', { className: 'rw-doc-note' }, t('sheetMore'))
            : null,
          h('div', { style: { flex: '1 1 auto', overflow: 'auto', padding: 8 } },
            h('table', { className: 'rw-doc-grid' },
              h('thead', null, header),
              h('tbody', null, gridRows))));
      } else if (kind === 'pptx' && state.data) {
        var slides = state.data.slides || [];
        var slide = slides[Math.min(state.slide, Math.max(slides.length - 1, 0))] || { texts: [] };
        body = h('div', { className: 'rw-doc-body' },
          h('div', { className: 'rw-inline', style: { justifyContent: 'space-between', marginBottom: 6 } },
            h('div', { className: 'rw-inline' },
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', disabled: state.slide <= 0, onClick: function () { patch({ slide: state.slide - 1 }); } }, '‹'),
              h('span', { className: 'rw-hint' }, (state.slide + 1) + ' / ' + slides.length),
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', disabled: state.slide >= slides.length - 1, onClick: function () { patch({ slide: state.slide + 1 }); } }, '›'))),
          (slide.texts || []).map(function (item) {
            return h('div', { key: item.shape, className: 'rw-doc-block' },
              h('div', { className: 'rw-doc-block-label' }, (item.name || t('docSlide')) + ' · ' + item.shape),
              h('textarea', { value: (state.pptxUpdates[state.slide + ':' + item.shape] || item).text || '', onChange: function (event) { updateSlideText(state.slide, item.shape, event.currentTarget.value); } }));
          }));
      }

      return h('div', { className: 'rw-doc' }, toolbar,
        state.notice ? h('div', { style: { padding: '6px 10px 0' } }, h(Banner, { kind: 'success' }, state.notice)) : null,
        state.error ? h('div', { style: { padding: '6px 10px 0' } }, h(Banner, { kind: 'error' }, state.error)) : null,
        body,
        h('div', { className: 'rw-doc-status' },
          h('span', null, kind.toUpperCase()),
          h('span', null, path),
          state.dirty ? h('span', { className: 'rw-status-chip rw-status-warn' }, t('dirty')) : null));
    }

    function RemoteDirectoryTab(props) {
      var ctx = props.ctx;
      var t = props.t;
      var locale = props.locale;
      var scope = props.scope;
      var remoteOnly = props.variant === 'remote';
      var data = useRemoteData(ctx);
      var settings = useRuntimeSettings();
      var sidebar = sidebarService(ctx);
      var selectedState = useState('');
      var selectedKey = selectedState[0];
      var setSelectedKey = selectedState[1];
      var modeState = useState('files');
      var mode = modeState[0];
      var setMode = modeState[1];
      var searchOpenState = useState(false);
      var searchOpen = searchOpenState[0];
      var setSearchOpen = searchOpenState[1];
      var searchQueryState = useState('');
      var searchQuery = searchQueryState[0];
      var setSearchQuery = searchQueryState[1];
      var searchModeState = useState('name');
      var searchMode = searchModeState[0];
      var setSearchMode = searchModeState[1];
      var searchState = useState({ loading: false, remote: [], local: [], error: null });
      var search = searchState[0];
      var setSearch = searchState[1];
      var gitState = useState({ loading: false, remote: null, local: null, error: null });
      var git = gitState[0];
      var setGit = gitState[1];
      var versionState = useState(0);
      var version = versionState[0];
      var bumpVersion = versionState[1];
      var noticeState = useState(null);
      var notice = noticeState[0];
      var setNotice = noticeState[1];
      var noticeTimer = useRef(null);
      var ctxState = useState(null);
      var ctxMenu = ctxState[0];
      var setCtxMenu = ctxState[1];
      var dialogState = useState(null);
      var dialog = dialogState[0];
      var setDialog = dialogState[1];
      var clipboardState = useState(null);
      var clipboard = clipboardState[0];
      var setClipboard = clipboardState[1];
      var queueState = useState([]);
      var queueList = queueState[0];
      var setQueueList = queueState[1];
      var queueRef = useRef([]);
      var queueRunning = useRef(false);
      var selectedEntryState = useState(null);
      var selectedEntry = selectedEntryState[0];
      var setSelectedEntry = selectedEntryState[1];
      var multiState = useState([]);
      var multi = multiState[0];
      var setMulti = multiState[1];
      // Anchor for Shift+click range selection (a ref: it must not re-render).
      var selectionAnchorRef = useRef(null);
      var showHiddenState = useState(true);
      var showHidden = showHiddenState[0];
      var setShowHidden = showHiddenState[1];

      // Rename tabs persisted before 0.3.0 (type alias keeps the title "远程目录").
      useEffect(function () {
        var tab = props.tab;
        if (!sidebar || typeof sidebar.updateTab !== 'function' || !tab || !tab.id) return;
        var wanted = remoteOnly ? t('remoteTabTitle') : t('tabTitle');
        if (tab.title === wanted) return;
        try {
          sidebar.updateTab(tab.id, { title: wanted }, props.sessionId);
        } catch (error) { /* title refresh is cosmetic */ }
      }, []);

      var tabMeta = props.tab && props.tab.meta ? props.tab.meta : {};
      var pinnedLinkedId = tabMeta.linkedId ? String(tabMeta.linkedId) : '';
      var pinnedRemoteId = tabMeta.remoteId ? String(tabMeta.remoteId) : '';
      var sources = useMemo(function () {
        var pinned = remoteOnly ? pinnedRemoteId : pinnedLinkedId;
        var scopeKey = linkedScopeKey(scope && scope.cwd);
        var all = (remoteOnly ? (data.data.remotes || []) : (data.data.links || []));
        function pathOf(item) {
          return remoteOnly ? item.placeholderPath : item.localPath;
        }
        function toSource(item) {
          if (remoteOnly) {
            return {
              key: 'remote:' + item.id,
              kind: 'remote',
              id: item.id,
              name: item.name,
              localPath: null,
              placeholderPath: item.placeholderPath,
              remotePath: item.remotePath,
              host: item.host,
              username: item.username,
              hostName: item.hostName,
              mirror: false,
              status: item.status,
            };
          }
          return {
            key: 'linked:' + item.id,
            kind: 'linked',
            id: item.id,
            name: item.name,
            localPath: item.localPath,
            remotePath: item.remotePath,
            host: item.host,
            username: item.username,
            hostName: item.hostName,
            mirror: item.mirror,
            status: item.status,
          };
        }
        var matched = all.filter(function (item) {
          if (pinned) return String(item.id) === pinned;
          if (!scopeKey) return true;
          return linkedScopeKey(pathOf(item)) === scopeKey;
        });
        // 标签页也可能从起始页或设置页直接打开：当前会话不属于任何联动/远程工作区时，
        // 列出全部，而不是让标签页空着。
        return (matched.length === 0 && !pinned ? all : matched).map(toSource);
      }, [data.data.links, data.data.remotes, remoteOnly, scope && scope.cwd, pinnedLinkedId, pinnedRemoteId]);

      var selected = useMemo(function () {
        return sources.filter(function (source) { return source.key === selectedKey; })[0] || sources[0] || null;
      }, [sources, selectedKey]);

      useEffect(function () {
        if (sources.length === 0) {
          if (selectedKey !== '') setSelectedKey('');
          return;
        }
        var exists = sources.some(function (source) { return source.key === selectedKey; });
        if (!exists) setSelectedKey(sources[0].key);
      }, [sources.length, selectedKey]);

      var scopeRef = selected ? sourceScopeOf(selected) : null;

      var openFilesState = useState([]);
      var openFiles = openFilesState[0];
      var setOpenFiles = openFilesState[1];
      var activeFileKeyState = useState('');
      var activeFileKey = activeFileKeyState[0];
      var setActiveFileKey = activeFileKeyState[1];
      var directoryOpenState = useState(true);
      var directoryOpen = directoryOpenState[0];
      var setDirectoryOpen = directoryOpenState[1];
      var directoryWidthState = useState(function () {
        try {
          var saved = parseInt(window.localStorage.getItem('dsh-linked-workspace:directory-width'), 10);
          return saved >= 240 && saved <= 900 ? saved : 300;
        } catch (error) { return 300; }
      });
      var directoryWidth = directoryWidthState[0];
      var setDirectoryWidth = directoryWidthState[1];
      var directoryWidthRef = useRef(directoryWidth);
      var workbenchRef = useRef(null);
      var localTickState = useState(0);
      var localTick = localTickState[0];
      var setLocalTick = localTickState[1];
      var fileDirtyState = useState({});
      var fileDirty = fileDirtyState[0];
      var setFileDirty = fileDirtyState[1];

      // Closing the browser tab or reloading the page would silently drop
      // unsaved edits: ask for confirmation while any open file is dirty.
      useEffect(function () {
        var dirty = openFiles.some(function (file) { return Boolean(fileDirty[file.key]); });
        if (!dirty) return undefined;
        function onBeforeUnload(event) {
          event.preventDefault();
          event.returnValue = '';
          return '';
        }
        window.addEventListener('beforeunload', onBeforeUnload);
        return function () { window.removeEventListener('beforeunload', onBeforeUnload); };
      }, [openFiles, fileDirty]);
      var saveHandlersRef = useRef({});
      var directoryTabId = props.tab && props.tab.id;

      useEffect(function () {
        directoryWidthRef.current = directoryWidth;
        try { window.localStorage.setItem('dsh-linked-workspace:directory-width', String(directoryWidth)); } catch (error) { /* storage unavailable */ }
      }, [directoryWidth]);

      useEffect(function () {
        if (!directoryOpen) return undefined;
        var bump = function () {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          setLocalTick(function (value) { return value + 1; });
        };
        var timer = setInterval(bump, 4000);
        if (timer && typeof timer.unref === 'function') timer.unref();
        window.addEventListener('focus', bump);
        return function () {
          clearInterval(timer);
          window.removeEventListener('focus', bump);
        };
      }, [directoryOpen, selectedKey]);

      function beginResize(event) {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        var startX = event.clientX;
        var startWidth = directoryWidthRef.current;
        var workbench = workbenchRef.current;
        var maxWidth = workbench ? Math.max(260, workbench.clientWidth - 320) : 720;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        function move(moveEvent) {
          var next = Math.max(240, Math.min(maxWidth, startWidth + (startX - moveEvent.clientX)));
          setDirectoryWidth(next);
        }
        function finish() {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', finish);
          document.removeEventListener('pointercancel', finish);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', finish);
        document.addEventListener('pointercancel', finish);
      }
      function restoreDirectoryTab() {
        if (!sidebar || typeof sidebar.activateTab !== 'function' || !directoryTabId) return;
        setTimeout(function () {
          try { sidebar.activateTab(directoryTabId, scope); } catch (error) { /* cosmetic */ }
        }, 0);
      }

      useEffect(function () {
        return function () { if (noticeTimer.current) clearTimeout(noticeTimer.current); };
      }, []);

      function showNotice(kind, text) {
        if (noticeTimer.current) clearTimeout(noticeTimer.current);
        setNotice({ kind: kind, text: text });
        noticeTimer.current = setTimeout(function () { setNotice(null); }, 4200);
      }

      function refreshAll() {
        bumpVersion(function (value) { return value + 1; });
        data.reload();
      }

      function refreshTree() {
        bumpVersion(function (value) { return value + 1; });
        data.reload();
      }

      function openCompare(path) {
        if (!selected) return;
        setDialog({ kind: 'compare', loading: true, error: '', data: null });
        apiCall('fs.compare', Object.assign({ path: path }, scopeParams(scopeRef))).then(function (result) {
          setDialog({
            kind: 'compare', loading: false, error: '',
            data: result, root: result.path, localPath: result.localPath,
          });
        }).catch(function (error) {
          setDialog({ kind: 'compare', loading: false, error: t('compareFailed') + '：' + messageOf(error, t, locale), data: null });
        });
      }

      function updateOpenMode(next) {
        apiCall('settings.update', { fileOpenMode: next }).then(function (result) {
          runtimeSettings.apply({ fileOpenMode: result && result.fileOpenMode ? result.fileOpenMode : next });
          showNotice('success', t('openModeSaved'));
        }).catch(function (error) {
          showNotice('error', messageOf(error, t, locale));
        });
      }

      function openTerminal(side, atPath) {
        if (!selected) return;
        if (side === 'local' && selected.kind !== 'linked') {
          showNotice('info', t('localSideMissing'));
          return;
        }
        var request = Object.assign({ side: side }, scopeParams(selected));
        if (typeof atPath === 'string' && atPath !== '') request.path = atPath;
        apiCall('terminal.open', request).then(function () {
          showNotice('success', t('terminalOpened'));
        }).catch(function (error) {
          showNotice('error', t('terminalOpenFailed') + '：' + messageOf(error, t, locale));
        });
      }

      function pinByMode(side, filePath) {
        var mode = settings.fileOpenMode || 'editor';
        if (mode !== 'editor') return;
        openByMode(side, filePath, { pinned: true, preview: false });
      }

      function openByMode(side, filePath, options) {
        if (!selected || !filePath) return;
        var openMode = settings.fileOpenMode || 'editor';
        if (openMode === 'copy') {
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(filePath).then(function () { showNotice('success', t('copyPathDone')); }).catch(function () {});
            }
          } catch (error) { /* clipboard unavailable */ }
          return;
        }
        if (openMode === 'system') {
          var method = side === 'remote' ? 'fs.openExternal' : 'local.openExternal';
          var params = side === 'remote' ? Object.assign({ path: filePath }, scopeParams(scopeRef)) : { path: filePath };
          apiCall(method, params).catch(function (error) {
            showNotice('error', t('openFailed') + '：' + messageOf(error, t, locale));
          });
          return;
        }
        openInternalFile(side, filePath, options || { pinned: true });
      }

      function openInternalFile(side, filePath, options) {
        var opts = options || { pinned: true };
        var key = side + ':' + (side === 'remote' ? scopeKeyOf(scopeRef) : 'local') + ':' + filePath;
        setOpenFiles(function (previous) {
          var existing = previous.filter(function (file) { return file.key === key; })[0];
          if (existing) {
            if (opts.pinned && !existing.pinned) {
              return previous.map(function (file) { return file.key === key ? Object.assign({}, file, { pinned: true }) : file; });
            }
            return previous;
          }
          if (opts.preview === true) {
            var activeIndex = -1;
            previous.forEach(function (file, index) { if (file.key === activeFileKey) activeIndex = index; });
            if (activeIndex >= 0) {
              var active = previous[activeIndex];
              if (!active.pinned && !fileDirty[active.key]) {
                var replaced = previous.slice();
                replaced[activeIndex] = { key: key, side: side, path: filePath, name: basename(filePath), pinned: false };
                setFileDirty(function (dirtyMap) { var copy = Object.assign({}, dirtyMap); delete copy[active.key]; return copy; });
                return replaced;
              }
            }
          }
          return previous.concat([{ key: key, side: side, path: filePath, name: basename(filePath), pinned: Boolean(opts.pinned) }]);
        });
        setActiveFileKey(key);
        setDirectoryOpen(true);
      }

      function closeInternalFile(key) {
        setOpenFiles(function (previous) {
          var next = previous.filter(function (file) { return file.key !== key; });
          setFileDirty(function (dirtyMap) { var copy = Object.assign({}, dirtyMap); delete copy[key]; return copy; });
          delete saveHandlersRef.current[key];
          if (activeFileKey === key) setActiveFileKey(next.length > 0 ? next[next.length - 1].key : '');
          return next;
        });
      }

      function requestCloseInternalFile(key) {
        if (!fileDirty[key]) { closeInternalFile(key); return; }
        var file = openFiles.filter(function (entry) { return entry.key === key; })[0];
        setDialog({ kind: 'closeDirty', key: key, name: file ? file.name : '' });
      }

      function saveAndCloseInternalFile(key) {
        var handler = saveHandlersRef.current[key];
        setDialog(null);
        if (!handler) { closeInternalFile(key); return; }
        handler().then(function (ok) {
          if (ok) closeInternalFile(key);
          else showNotice('error', t('saveFailed'));
        });
      }

      useEffect(function () {
        function onKey(event) {
          var mod = event.ctrlKey || event.metaKey;
          if (!mod) return;
          var key = String(event.key || '').toLowerCase();
          if (key === 'w') {
            if (!activeFileKey) return;
            event.preventDefault();
            event.stopPropagation();
            requestCloseInternalFile(activeFileKey);
            return;
          }
          if (key === 'tab') {
            if (openFiles.length < 2) return;
            event.preventDefault();
            event.stopPropagation();
            var index = -1;
            openFiles.forEach(function (file, i) { if (file.key === activeFileKey) index = i; });
            var step = event.shiftKey ? -1 : 1;
            var nextIndex = (index + step + openFiles.length) % openFiles.length;
            setActiveFileKey(openFiles[nextIndex].key);
            return;
          }
          if (key === 'b') {
            event.preventDefault();
            event.stopPropagation();
            setDirectoryOpen(function (open) { return !open; });
            return;
          }
          if (key === 'f' && event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            setSearchOpen(true);
          }
        }
        window.addEventListener('keydown', onKey, true);
        return function () { window.removeEventListener('keydown', onKey, true); };
      }, [activeFileKey, openFiles, directoryOpen]);

      function closeContextMenu() { setCtxMenu(null); }

      function openContextMenu(side, info) {
        setCtxMenu({
          side: side,
          path: info.path,
          name: info.name,
          isDir: Boolean(info.isDir),
          x: info.event ? info.event.clientX : 40,
          y: info.event ? info.event.clientY : 40,
        });
      }

      function noticeError(error) {
        showNotice('error', t('actionFailed') + '：' + messageOf(error, t, locale));
      }

      // Ctrl/Cmd-click toggles an entry in the multi-selection; a plain click
      // collapses the selection to that entry (Shift extends it).
      function updateSelection(side, info) {
        if (!info || typeof info.path !== 'string') return;
        var event = info.event;
        var entry = { side: side, path: info.path, name: info.name, isDir: Boolean(info.isDir) };
        setSelectedEntry(entry);
        var toggle = Boolean(event && (event.ctrlKey || event.metaKey));
        var extend = Boolean(event && event.shiftKey);
        if (extend) {
          var anchor = selectionAnchorRef.current;
          var siblings = Array.isArray(info.siblings) ? info.siblings : [];
          if (anchor && anchor.side === side && siblings.length > 0) {
            var anchorIndex = -1;
            var targetIndex = -1;
            siblings.forEach(function (item, index) {
              if (item.path === anchor.path) anchorIndex = index;
              if (item.path === info.path) targetIndex = index;
            });
            if (anchorIndex >= 0 && targetIndex >= 0) {
              var start = Math.min(anchorIndex, targetIndex);
              var end = Math.max(anchorIndex, targetIndex);
              setMulti(siblings.slice(start, end + 1).map(function (item) {
                return { side: side, path: item.path, name: item.name, isDir: Boolean(item.isDir) };
              }));
              return;
            }
          }
        }
        setMulti(function (previous) {
          var exists = previous.some(function (item) { return item.side === side && item.path === entry.path; });
          if (extend) return exists ? previous : previous.concat([entry]);
          if (toggle) {
            return exists
              ? previous.filter(function (item) { return !(item.side === side && item.path === entry.path); })
              : previous.concat([entry]);
          }
          return [entry];
        });
        if (!extend) selectionAnchorRef.current = toggle ? selectionAnchorRef.current : { side: side, path: info.path };
      }

      function selectedOn(side) {
        return multi.filter(function (item) { return item.side === side; });
      }

      function selectionFor(side) {
        var list = selectedOn(side);
        if (list.length > 0) return list;
        if (selectedEntry && selectedEntry.side === side) return [selectedEntry];
        return [];
      }

      function transferSelection() {
        var list = multi.length > 0 ? multi : (selectedEntry ? [selectedEntry] : []);
        list.forEach(function (item) { enqueueTransfer(item.side, item.path, item.name); });
      }

      function deleteSelection() {
        var list = multi.length > 0 ? multi : (selectedEntry ? [selectedEntry] : []);
        if (list.length === 0) return;
        setDialog({ kind: 'deleteMany', entries: list });
      }

      function copyPathToClipboard(text) {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { showNotice('success', t('copyPathDone')); }).catch(function () {});
            return;
          }
        } catch (error) { /* clipboard unavailable */ }
      }

      function enqueueTransfer(side, filePath, name) {
        var entry = {
          id: String(Date.now()) + Math.random().toString(16).slice(2),
          side: side || 'remote',
          path: filePath,
          label: name,
          state: 'queued',
          message: t('queueQueued'),
        };
        queueRef.current = queueRef.current.concat([entry]);
        setQueueList(queueRef.current.slice());
        pumpQueue();
      }

      function pumpQueue() {
        if (queueRunning.current) return;
        var next = queueRef.current.filter(function (entry) { return entry.state === 'queued'; })[0];
        if (!next) return;
        queueRunning.current = true;
        next.state = 'running';
        next.message = t('queueRunning');
        setQueueList(queueRef.current.slice());
        apiCall('fs.transfer', Object.assign({ side: next.side || 'remote', path: next.path }, scopeParams(scopeRef))).then(function (result) {
          next.state = 'done';
          next.message = t('transferDone', { files: result.files, size: formatBytes(result.bytes) }) + (result.truncated ? t('transferTruncated') : '');
          showNotice('success', next.message);
          refreshTree();
        }).catch(function (error) {
          next.state = 'error';
          next.message = messageOf(error, t, locale);
        }).then(function () {
          setQueueList(queueRef.current.slice());
          queueRunning.current = false;
          pumpQueue();
        });
      }

      function downloadEntry(entry) {
        apiCall('fs.download', Object.assign({ path: entry.path }, scopeParams(scopeRef))).then(function (result) {
          showNotice('success', t('downloadDone', { path: result.path }));
        }).catch(noticeError);
      }

      function editNotepad(side, filePath) {
        var method = side === 'remote' ? 'fs.edit' : 'local.edit';
        var params = side === 'remote'
          ? Object.assign({ path: filePath, app: 'notepad' }, scopeParams(scopeRef))
          : { path: filePath, app: 'notepad' };
        apiCall(method, params).catch(noticeError);
      }

      function pasteEntry(menu) {
        if (!clipboard) return;
        if (clipboard.side === 'remote') {
          apiCall('fs.copy', Object.assign({ path: clipboard.path, targetDir: menu.path }, scopeParams(scopeRef))).then(function () {
            showNotice('success', t('pasteDone'));
            refreshTree();
          }).catch(noticeError);
          return;
        }
        apiCall('local.copy', { path: clipboard.path, targetDir: menu.path }).then(function () {
          showNotice('success', t('pasteDone'));
          refreshTree();
        }).catch(noticeError);
      }

      function showProperties(side, targetPath) {
        var method = side === 'remote' ? 'fs.stat' : 'local.stat';
        var params = side === 'remote'
          ? Object.assign({ path: targetPath }, scopeParams(scopeRef))
          : { path: targetPath };
        apiCall(method, params).then(function (stat) {
          var stamp = typeof stat.mtime === 'number' ? stat.mtime : 0;
          if (stamp > 0 && stamp < 1e12) stamp *= 1000;
          setDialog({
            kind: 'props',
            title: t('propsTitle'),
            rows: [
              { key: 'name', label: t('propsName'), value: parentPathOf(targetPath, side) === targetPath ? targetPath : (targetPath.split(side === 'remote' ? '/' : '\\').pop() || targetPath) },
              { key: 'path', label: t('propsPath'), value: stat.path || targetPath },
              { key: 'type', label: t('propsType'), value: stat.type === 'dir' ? t('propsDir') : t('propsFile') },
              { key: 'size', label: t('propsSize'), value: stat.type === 'dir' ? '-' : formatBytes(stat.size || 0) },
              { key: 'mtime', label: t('propsMtime'), value: stamp > 0 ? new Date(stamp).toLocaleString() : '-' },
              { key: 'mode', label: t('propsMode'), value: formatFileMode(stat.mode) || '-' },
            ],
          });
        }).catch(noticeError);
      }

      function confirmDelete(entry) {
        var method = entry.side === 'remote' ? 'fs.delete' : 'local.delete';
        var params = entry.side === 'remote'
          ? Object.assign({ path: entry.path }, scopeParams(scopeRef))
          : { path: entry.path, root: selected.localPath };
        apiCall(method, params).then(function () {
          showNotice('success', t('deleteDone'));
          refreshTree();
        }).catch(noticeError);
      }

      function confirmDeleteMany(entries) {
        var list = Array.isArray(entries) ? entries : [];
        var failures = [];
        var chain = Promise.resolve();
        list.forEach(function (entry) {
          chain = chain.then(function () {
            var method = entry.side === 'remote' ? 'fs.delete' : 'local.delete';
            var params = entry.side === 'remote'
              ? Object.assign({ path: entry.path }, scopeParams(scopeRef))
              : { path: entry.path, root: selected.localPath };
            return apiCall(method, params).then(function () {
              setMulti(function (previous) {
                return previous.filter(function (item) { return !(item.side === entry.side && item.path === entry.path); });
              });
            }).catch(function (error) { failures.push(error); });
          });
        });
        chain.then(function () {
          if (failures.length > 0) showNotice('error', messageOf(failures[0], t, locale));
          else showNotice('success', t('deleteDone'));
          refreshTree();
        });
      }

      var DRAG_MIME = 'application/x-dsh-linked-entry';

      function beginDragRow(side, event, info) {
        if (!event.dataTransfer || !info) return;
        try {
          event.dataTransfer.setData(DRAG_MIME, JSON.stringify({
            side: side, path: info.path, name: info.name, isDir: Boolean(info.isDir),
          }));
          event.dataTransfer.effectAllowed = 'copy';
        } catch (error) { /* drag payload unsupported */ }
      }

      // A drop that would replace an existing file asks first: file transfer is
      // destructive and previously overwrote the target silently.
      function openConflict(error, method, params) {
        if (!error || String(error.code || '') !== 'FS_EXISTS') return false;
        setDialog({ kind: 'conflict', message: messageOf(error, t, locale), method: method, params: params });
        return true;
      }

      function resolveConflict(choice) {
        var current = dialog;
        setDialog(null);
        if (!current || current.kind !== 'conflict' || choice === 'cancel') return;
        var params = Object.assign({}, current.params, { conflict: choice === 'overwrite' ? 'overwrite' : 'unique' });
        apiCall(current.method, params).then(function (result) {
          var skipped = Number(result && result.skipped) || 0;
          var count = current.method === 'fs.upload' ? Number(result && result.files) || 0 : 1;
          if (count > 0) showNotice('success', t('dropImported', { count: count }));
          if (skipped > 0) showNotice('warn', t('dropSkipped', { count: skipped }));
          refreshTree();
        }).catch(noticeError);
      }

      // Drop target handling for both trees: OS files are imported into the
      // target directory, while an entry dragged from the other tree is pushed
      // across the boundary (remote→local or local→remote).
      function dropOnPath(side, targetDir, event) {
        event.preventDefault();
        event.stopPropagation();
        var transfer = event.dataTransfer;
        if (!transfer || typeof targetDir !== 'string' || targetDir === '') return;
        var files = Array.prototype.slice.call(transfer.files || []);
        var osPaths = files.map(function (file) {
          return file && typeof file.path === 'string' ? file.path : '';
        }).filter(Boolean);
        if (files.length > 0 && osPaths.length === 0) {
          showNotice('error', t('dropNeedsDesktop'));
          return;
        }
        if (osPaths.length > 0) {
          var payload = side === 'remote'
            ? Object.assign({ path: targetDir, paths: osPaths }, scopeParams(scopeRef))
            : { dir: targetDir, paths: osPaths };
          var method = side === 'remote' ? 'fs.upload' : 'local.import';
          apiCall(method, payload).then(function (result) {
            var count = side === 'remote' ? Number(result.files) || 0 : Number(result.copied) || 0;
            showNotice('success', t('dropImported', { count: count }));
            if (Number(result.skipped) > 0) showNotice('warn', t('dropSkipped', { count: result.skipped }));
            refreshTree();
          }).catch(function (error) {
            if (openConflict(error, method, payload)) return;
            noticeError(error);
          });
          return;
        }
        var raw = '';
        try { raw = transfer.getData(DRAG_MIME); } catch (error) { raw = ''; }
        if (!raw) return;
        var entry;
        try { entry = JSON.parse(raw); } catch (error) { return; }
        if (!entry || typeof entry.path !== 'string') return;
        if (entry.side === side) {
          showNotice('error', t('dropSameSide'));
          return;
        }
        if (entry.side === 'remote') {
          if (entry.isDir) {
            showNotice('error', t('dropDirUnsupported'));
            return;
          }
          var pullParams = Object.assign({ path: entry.path, targetDir: targetDir }, scopeParams(scopeRef));
          apiCall('fs.pullToLocal', pullParams).then(function () {
            showNotice('success', t('dropImported', { count: 1 }));
            refreshTree();
          }).catch(function (error) {
            if (openConflict(error, 'fs.pullToLocal', pullParams)) return;
            noticeError(error);
          });
          return;
        }
        if (entry.isDir) {
          showNotice('error', t('dropLocalDirUnsupported'));
          return;
        }
        var pushParams = Object.assign({ path: targetDir, paths: [entry.path] }, scopeParams(scopeRef));
        apiCall('fs.upload', pushParams).then(function (result) {
          if (Number(result.skipped) > 0) showNotice('warn', t('dropSkipped', { count: result.skipped }));
          else showNotice('success', t('dropImported', { count: Number(result.files) || 1 }));
          refreshTree();
        }).catch(function (error) {
          if (openConflict(error, 'fs.upload', pushParams)) return;
          noticeError(error);
        });
      }

      function submitRenamed(side, oldPath, name) {
        var target = joinChildPath(parentPathOf(oldPath, side), name, side);
        if (target === oldPath) return;
        var method = side === 'remote' ? 'fs.rename' : 'local.rename';
        var params = side === 'remote'
          ? Object.assign({ from: oldPath, to: target }, scopeParams(scopeRef))
          : { from: oldPath, to: target };
        apiCall(method, params).then(function () {
          showNotice('success', t('renameDone'));
          refreshTree();
        }).catch(noticeError);
      }

      function pathUnder(filePath, parentPath) {
        if (!filePath || !parentPath) return false;
        var normalized = String(filePath).replace(/\\/g, '/').replace(/\/+$/, '');
        var parent = String(parentPath).replace(/\\/g, '/').replace(/\/+$/, '');
        return normalized === parent || normalized.indexOf(parent + '/') === 0 || normalized.indexOf(parent + '\\') === 0;
      }

      function moveEntry(side, oldPath, targetDir) {
        var blocked = openFiles.some(function (file) {
          return file.side === side && pathUnder(file.path, oldPath) && fileDirty[file.key];
        });
        if (blocked) {
          showNotice('error', t('moveDirty'));
          return;
        }
        var method = side === 'remote' ? 'fs.move' : 'local.move';
        var params = side === 'remote'
          ? Object.assign({ path: oldPath, targetDir: targetDir }, scopeParams(scopeRef))
          : { path: oldPath, targetDir: targetDir, root: selected.localPath };
        apiCall(method, params).then(function (result) {
          var nextPath = result && result.path ? result.path : oldPath;
          setOpenFiles(function (previous) {
            return previous.filter(function (file) {
              return !(file.side === side && pathUnder(file.path, oldPath));
            });
          });
          setActiveFileKey(function (activeKey) {
            var stillOpen = openFiles.filter(function (file) {
              return file.key === activeKey && !(file.side === side && pathUnder(file.path, oldPath));
            });
            if (stillOpen.length > 0) return activeKey;
            var remaining = openFiles.filter(function (file) {
              return !(file.side === side && pathUnder(file.path, oldPath));
            });
            return remaining.length > 0 ? remaining[remaining.length - 1].key : null;
          });
          setFileDirty(function (previous) {
            var next = Object.assign({}, previous);
            openFiles.forEach(function (file) {
              if (file.side === side && pathUnder(file.path, oldPath)) delete next[file.key];
            });
            return next;
          });
          setDialog(null);
          showNotice('success', t('moveDone'));
          refreshTree();
          if (nextPath !== oldPath) refreshTree();
        }).catch(noticeError);
      }

      function submitNew(side, dirPath, name, isDir) {
        var request = newEntryRequest(side, dirPath, name, isDir, scopeParams(scopeRef));
        return apiCall(request.method, request.params).then(function () {
          setDialog(null);
          showNotice('success', t('newDone'));
          refreshTree();
          if (!isDir && request.kind) openInternalFile(side, request.path);
        });
      }

      function submitChmod(side, targetPath, mode) {
        var method = side === 'remote' ? 'fs.chmod' : 'local.chmod';
        var params = side === 'remote'
          ? Object.assign({ path: targetPath, mode: mode }, scopeParams(scopeRef))
          : { path: targetPath, mode: mode };
        apiCall(method, params).then(function () {
          showNotice('success', t('chmodDone'));
          refreshTree();
        }).catch(noticeError);
      }

      function submitDialog(current, value) {
        if (current.kind === 'new') return submitNew(current.side, current.dir, value, current.isDir);
        setDialog(null);
        if (current.kind === 'rename') submitRenamed(current.side, current.path, value);
        else if (current.kind === 'chmod') submitChmod(current.side, current.path, value);
      }

      function buildContextItems(menu) {
        var isRemote = menu.side === 'remote';
        if (remoteOnly) {
          var readOnlyItems = [];
          if (isRemote) readOnlyItems.push({ label: t('ctxDownload'), onSelect: function () { downloadEntry(menu); } });
          if (!menu.isDir) readOnlyItems.push({ label: t('ctxOpen'), onSelect: function () { openByMode(menu.side, menu.path); } });
          readOnlyItems.push({ separator: true });
          readOnlyItems.push({ label: t('ctxCopyPath'), onSelect: function () { copyPathToClipboard(menu.path); } });
          readOnlyItems.push({ separator: true });
          readOnlyItems.push({ label: t('ctxProperties'), onSelect: function () { showProperties(menu.side, menu.path); } });
          return readOnlyItems;
        }
        var canPaste = clipboard !== null && clipboard.side === menu.side && menu.isDir;
        var items = [];
        var batch = multi.filter(function (item) { return item.side === menu.side; });
        if (batch.length > 1) {
          items.push({ label: t('ctxTransferSelected', { count: batch.length }), onSelect: function () {
            batch.forEach(function (item) { enqueueTransfer(item.side, item.path, item.name); });
          } });
          items.push({ label: t('ctxDeleteSelected', { count: batch.length }), onSelect: deleteSelection });
          items.push({ separator: true });
        }
        if (isRemote) {
          items.push({ label: t('ctxTransfer'), onSelect: function () { enqueueTransfer('remote', menu.path, menu.name); } });
          items.push({ label: t('ctxDownload'), onSelect: function () { downloadEntry(menu); } });
          items.push({ label: t('ctxQueue'), onSelect: function () { setDialog({ kind: 'queue' }); } });
          items.push({ separator: true });
        } else {
          items.push({ label: t('ctxTransferLocal'), onSelect: function () { enqueueTransfer('local', menu.path, menu.name); } });
          items.push({ label: t('ctxQueue'), onSelect: function () { setDialog({ kind: 'queue' }); } });
          items.push({ separator: true });
        }
        if (!menu.isDir) {
          items.push({ label: t('ctxOpen'), onSelect: function () { openByMode(menu.side, menu.path); } });
          items.push({ label: t('ctxNotepad'), onSelect: function () { editNotepad(menu.side, menu.path); } });
          items.push({ separator: true });
        }
        items.push({ label: t('ctxCopy'), onSelect: function () {
          setClipboard({ side: menu.side, path: menu.path, isDir: menu.isDir, name: menu.name });
          showNotice('success', t('copiedEntry'));
        } });
        items.push({ label: t('ctxPaste'), disabled: !canPaste, onSelect: function () { pasteEntry(menu); } });
        items.push({ separator: true });
        items.push({ label: t('ctxCopyPath'), onSelect: function () { copyPathToClipboard(menu.path); } });
        items.push({ separator: true });
        var rootPath = menu.side === 'remote' ? selected.remotePath : selected.localPath;
        if (menu.path !== rootPath) {
          items.push({ label: t('ctxMove'), onSelect: function () {
            setDialog({
              kind: 'move', side: menu.side, path: menu.path, name: menu.name, isDir: menu.isDir,
              initialPath: parentPathOf(menu.path, menu.side),
            });
          } });
        }
        items.push({ label: t('ctxRename'), onSelect: function () {
          setDialog({ kind: 'rename', side: menu.side, path: menu.path, value: menu.name, title: t('renameTitle'), label: t('renameLabel') });
        } });
        items.push({ label: t('ctxDelete'), onSelect: function () {
          setDialog({ kind: 'delete', side: menu.side, path: menu.path, name: menu.name, isDir: menu.isDir });
        } });
        items.push({ label: t('ctxChmod'), onSelect: function () {
          setDialog({ kind: 'chmod', side: menu.side, path: menu.path, title: t('chmodTitle'), label: t('chmodLabel'), value: '644' });
        } });
        if (menu.isDir) {
          items.push({ separator: true });
          items.push({ label: t('ctxTerminalHere'), onSelect: function () { openTerminal(menu.side, menu.path); } });
          items = items.concat(newEntryMenuItems(menu, t, setDialog));
        }
        if (menu.isDir && menu.side === 'remote' && selected && selected.kind === 'linked') {
          items.push({ label: t('ctxCompare'), onSelect: function () { openCompare(menu.path); } });
        }
        items.push({ separator: true });
        items.push({ label: t('ctxProperties'), onSelect: function () { showProperties(menu.side, menu.path); } });
        return items;
      }

      function renderDialog() {
        if (!dialog) return null;
        if (dialog.kind === 'compare') {
          return dialog.loading
            ? h(DialogShell, { title: t('compareTitle'), onClose: function () { setDialog(null); } },
              h('div', { className: 'rw-dialog-message' }, Spinner(13), t('loading')))
            : dialog.error
              ? h(DialogShell, { title: t('compareTitle'), onClose: function () { setDialog(null); } },
                h('div', { className: 'rw-dialog-message rw-dialog-error' }, dialog.error),
                h('div', { className: 'rw-dialog-actions' },
                  h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: function () { setDialog(null); } }, t('close'))))
              : h(CompareDialog, {
                t: t,
                title: t('compareTitle'),
                data: dialog.data,
                onClose: function () { setDialog(null); },
                onOpen: function (side, relative) {
                  setDialog(null);
                  var target = side === 'local' ? dialog.localPath : dialog.root;
                  openInternalFile(side === 'local' ? 'local' : 'remote', joinRelativePath(target, relative, side === 'local' ? 'local' : 'remote'));
                },
                onPush: function (relative) {
                  var source = joinRelativePath(dialog.localPath, relative, 'local');
                  var remoteDir = parentPathOf(joinRelativePath(dialog.root, relative, 'remote'), 'remote');
                  apiCall('fs.upload', Object.assign({ path: remoteDir, paths: [source], conflict: 'overwrite' }, scopeParams(scopeRef))).then(function () {
                    showNotice('success', t('comparePushed', { name: relative.split('/').pop() }));
                    setDialog(null);
                    refreshTree();
                  }).catch(noticeError);
                },
                onPull: function (relative) {
                  var remoteFile = joinRelativePath(dialog.root, relative, 'remote');
                  var localDir = parentPathOf(joinRelativePath(dialog.localPath, relative, 'local'), 'local');
                  apiCall('fs.pullToLocal', Object.assign({ path: remoteFile, targetDir: localDir, conflict: 'overwrite' }, scopeParams(scopeRef))).then(function () {
                    showNotice('success', t('comparePulled', { name: relative.split('/').pop() }));
                    setDialog(null);
                    refreshTree();
                  }).catch(noticeError);
                },
              });
        }
        if (dialog.kind === 'props') {
          return h(PropertiesDialog, { t: t, title: dialog.title, rows: dialog.rows, onClose: function () { setDialog(null); } });
        }
        if (dialog.kind === 'queue') {
          return h(QueueDialog, {
            t: t,
            title: t('queueTitle'),
            queue: queueList,
            onClose: function () { setDialog(null); },
            onClear: function () {
              queueRef.current = queueRef.current.filter(function (entry) { return entry.state !== 'done' && entry.state !== 'error'; });
              setQueueList(queueRef.current.slice());
            },
            onRetry: function (entry) { enqueueTransfer(entry.side, entry.path, entry.label); },
          });
        }
        if (dialog.kind === 'delete') {
          return h(ConfirmDialog, {
            t: t,
            title: t('deleteTitle'),
            message: t('deleteMessage', { name: dialog.name }),
            confirmLabel: t('deleteConfirm'),
            onClose: function () { setDialog(null); },
            onConfirm: function () { setDialog(null); confirmDelete(dialog); },
          });
        }
        if (dialog.kind === 'deleteMany') {
          return h(ConfirmDialog, {
            t: t,
            title: t('deleteManyTitle'),
            message: t('deleteManyMessage', { count: dialog.entries.length }),
            confirmLabel: t('deleteConfirm'),
            onClose: function () { setDialog(null); },
            onConfirm: function () { setDialog(null); confirmDeleteMany(dialog.entries); },
          });
        }
        if (dialog.kind === 'conflict') {
          return h(DialogShell, { title: t('conflictDropTitle'), onClose: function () { resolveConflict('cancel'); } },
            h('div', { className: 'rw-dialog-message' }, dialog.message),
            h('div', { className: 'rw-dialog-actions' },
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: function () { resolveConflict('cancel'); } }, t('conflictCancel')),
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: function () { resolveConflict('unique'); } }, t('conflictKeepBoth')),
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-danger', onClick: function () { resolveConflict('overwrite'); } }, t('conflictOverwrite'))));
        }
        if (dialog.kind === 'move') {
          return h(MoveDialog, {
            t: t, locale: locale,
            title: t('moveTitle'),
            message: t('moveMessage', { name: dialog.name }),
            side: dialog.side,
            scope: dialog.side === 'remote' ? sourceScopeOf(selected) : null,
            root: dialog.side === 'remote' ? selected.remotePath : selected.localPath,
            initialPath: dialog.initialPath,
            onClose: function () { setDialog(null); },
            onPick: function (targetDir) { moveEntry(dialog.side, dialog.path, targetDir); },
          });
        }
        if (dialog.kind === 'closeDirty') {
          return h(ConfirmDialog, {
            t: t,
            title: t('dirtyCloseTitle'),
            message: t('dirtyCloseMessage', { name: dialog.name }),
            secondaryLabel: t('dirtyCloseSave'),
            confirmLabel: t('dirtyCloseDiscard'),
            onClose: function () { setDialog(null); },
            onSecondary: function () { saveAndCloseInternalFile(dialog.key); },
            onConfirm: function () { setDialog(null); closeInternalFile(dialog.key); },
          });
        }
        return h(PromptDialog, {
          t: t,
          locale: locale,
          title: dialog.title,
          label: dialog.label,
          value: dialog.value,
          onClose: function () { setDialog(null); },
          onSubmit: function (value) { return submitDialog(dialog, value); },
        });
      }

      useEffect(function () {
        if (mode === 'files' || !selected) return undefined;
        var alive = true;
        setGit({ loading: true, remote: null, local: null, error: null });
        var scopeNow = sourceScopeOf(selected);
        var remoteJob = apiCall('git.status', Object.assign({ side: 'remote' }, scopeParams(scopeNow))).catch(function (error) {
          return { ok: false, repo: false, error: messageOf(error, t, locale), changes: [] };
        });
        var jobs = [remoteJob];
        if (selected.kind === 'linked') {
          jobs.push(apiCall('git.status', Object.assign({ side: 'local' }, scopeParams(scopeNow))).catch(function (error) {
            return { ok: false, repo: false, error: messageOf(error, t, locale), changes: [] };
          }));
        } else {
          jobs.push(Promise.resolve(null));
        }
        Promise.all(jobs).then(function (results) {
          if (!alive) return;
          setGit({ loading: false, remote: results[0], local: results[1], error: null });
        });
        return function () { alive = false; };
      }, [mode, selectedKey, version]);

      useEffect(function () {
        if (!searchOpen) {
          setSearch({ loading: false, remote: [], local: [], error: null });
          return undefined;
        }
        var query = searchQuery.trim();
        if (query.length < 2 || !selected) {
          setSearch({ loading: false, remote: [], local: [], error: null });
          return undefined;
        }
        var alive = true;
        var timer = setTimeout(function () {
          setSearch(function (previous) { return { loading: true, remote: previous.remote, local: previous.local, truncated: false, error: null }; });
          var scopeNow = sourceScopeOf(selected);
          var method = searchMode === 'content' ? 'fs.grep' : 'fs.search';
          var jobs = [apiCall(method, Object.assign({ side: 'remote', query: query, maxResults: 200 }, scopeParams(scopeNow))).catch(function (error) {
            return { ok: false, entries: [], error: messageOf(error, t, locale) };
          })];
          if (selected.kind === 'linked') {
            jobs.push(apiCall(method, Object.assign({ side: 'local', query: query, maxResults: 200 }, scopeParams(scopeNow))).catch(function (error) {
              return { ok: false, entries: [], error: messageOf(error, t, locale) };
            }));
          } else {
            jobs.push(Promise.resolve({ ok: true, entries: [] }));
          }
          Promise.all(jobs).then(function (results) {
            if (!alive) return;
            setSearch({
              loading: false,
              remote: results[0] && results[0].entries ? results[0].entries : [],
              local: results[1] && results[1].entries ? results[1].entries : [],
              truncated: Boolean((results[0] && results[0].truncated) || (results[1] && results[1].truncated)),
              error: (results[0] && results[0].error) || (results[1] && results[1].error) || null,
            });
          });
        }, 320);
        return function () { alive = false; clearTimeout(timer); };
      }, [searchOpen, searchQuery, selectedKey, version, searchMode]);

      if (!selected) {
      return h('div', { className: 'rw-workbench rw-workspace', ref: workbenchRef },
          h('div', { className: 'rw-tree-scroll' },
            data.data.loading
              ? h('div', { className: 'rw-row-msg' }, Spinner(13), t('loading'))
              : h('div', { className: 'rw-empty' },
                h('div', { className: 'rw-empty-title' }, t('emptyTitle')),
                h('div', { className: 'rw-empty-body' }, t('noTarget')))));
      }

      var info = null;
      if (notice) info = h('div', { className: 'rw-linked-notice' }, h(Banner, { kind: notice.kind }, notice.text));
      else if (data.data.error) info = h('div', { className: 'rw-linked-notice' }, h(Banner, { kind: 'error' }, t('workspacesFailed') + '：' + messageOf(data.data.error, t, locale)));

      var body;
      if (searchOpen && searchQuery.trim().length >= 2) {
        body = h(SearchResults, {
          t: t, locale: locale, state: search,
          hasLocal: selected.kind === 'linked',
          showHidden: showHidden,
          onOpen: openByMode,
        });
      } else if (mode !== 'files') {
        body = h(GitChangesView, {
          t: t, locale: locale, git: git, mode: mode, selected: selected, onOpen: openByMode,
        });
      } else {
        body = h('div', { className: 'rw-linked-body' },
          h(TreeSection, {
            key: 'remote:' + selected.key + ':' + version + ':' + (showHidden ? 'h' : 's'),
            title: t('remoteTree'),
            icon: IconRemoteWorkspace(11),
          }, h(TreePanel, {
            key: 'remote:' + selected.key + ':' + version + ':' + (showHidden ? 'h' : 's'),
            kind: 'remote',
            scope: scopeRef,
            rootPath: selected.remotePath,
            rootName: t('allFiles'),
            t: t,
            locale: locale,
            showHidden: showHidden,
            selectedPath: selectedEntry && selectedEntry.side === 'remote' ? selectedEntry.path : '',
            selectedPaths: selectionFor('remote').map(function (item) { return item.path; }),
            onSelectPath: function (info) { updateSelection('remote', info); },
            onDragStartRow: beginDragRow,
            onDropOnPath: dropOnPath,
            onSelect: function (filePath) { openByMode('remote', filePath, { pinned: false, preview: true }); },
            onPin: function (filePath) { pinByMode('remote', filePath); },
            onContextMenu: function (info) { setSelectedEntry(Object.assign({ side: 'remote' }, info)); openContextMenu('remote', info); },
          })),
          selected.kind === 'linked'
            ? h(TreeSection, {
              key: 'local:' + selected.key + ':' + version + ':' + (showHidden ? 'h' : 's'),
              title: t('localTree'),
              icon: IconFolder(11, false),
              bottom: true,
            }, h(TreePanel, {
              key: 'local:' + selected.key + ':' + version + ':' + (showHidden ? 'h' : 's'),
              kind: 'local',
              scope: null,
              rootPath: selected.localPath,
              rootName: t('allFiles'),
              t: t,
              locale: locale,
              showHidden: showHidden,
              selectedPath: selectedEntry && selectedEntry.side === 'local' ? selectedEntry.path : '',
              selectedPaths: selectionFor('local').map(function (item) { return item.path; }),
              onSelectPath: function (info) { updateSelection('local', info); },
              onDragStartRow: beginDragRow,
              onDropOnPath: dropOnPath,
              onSelect: function (filePath) { openByMode('local', filePath, { pinned: false, preview: true }); },
              onPin: function (filePath) { pinByMode('local', filePath); },
              refreshTick: localTick,
              onContextMenu: function (info) { setSelectedEntry(Object.assign({ side: 'local' }, info)); openContextMenu('local', info); },
            }))
            : null);
      }

      var activeFile = openFiles.filter(function (file) { return file.key === activeFileKey; })[0] || null;
      var activeDocKind = activeFile ? documentKindOf(activeFile.name) : '';
      var contentArea = activeFile
        ? (activeDocKind === 'image'
          ? h(ImagePreview, {
            ctx: ctx, t: t, locale: locale,
            scope: activeFile.side === 'remote' ? sourceScopeOf(selected) : undefined,
            path: activeFile.path,
            local: activeFile.side === 'local',
          })
          : activeDocKind === 'html'
          ? h(HtmlPreview, {
            ctx: ctx, t: t, locale: locale,
            scope: activeFile.side === 'remote' ? sourceScopeOf(selected) : undefined,
            path: activeFile.path,
            local: activeFile.side === 'local',
          })
          : activeDocKind && activeDocKind !== 'csv'
          ? h(DocumentPane, {
            ctx: ctx, t: t, locale: locale,
            scope: activeFile.side === 'remote' ? sourceScopeOf(selected) : undefined,
            path: activeFile.path,
            local: activeFile.side === 'local',
            onSaved: refreshTree,
            onSaveReady: function (handler) {
              if (handler) saveHandlersRef.current[activeFile.key] = handler;
              else delete saveHandlersRef.current[activeFile.key];
            },
            onDirtyChange: function (dirty) {
              setFileDirty(function (previous) {
                if (Boolean(previous[activeFile.key]) === Boolean(dirty)) return previous;
                var next = Object.assign({}, previous);
                next[activeFile.key] = Boolean(dirty);
                return next;
              });
            },
          })
          : h(RemoteFileEditor, {
          ctx: ctx, t: t, locale: locale,
          scope: activeFile.side === 'remote' ? sourceScopeOf(selected) : undefined,
          path: activeFile.path,
          local: activeFile.side === 'local',
          readOnly: remoteOnly,
          hideHeader: true,
          onSaveReady: function (handler) {
            if (handler) saveHandlersRef.current[activeFile.key] = handler;
            else delete saveHandlersRef.current[activeFile.key];
          },
          onDirtyChange: function (dirty) {
            setFileDirty(function (previous) {
              if (Boolean(previous[activeFile.key]) === Boolean(dirty)) return previous;
              var next = Object.assign({}, previous);
              next[activeFile.key] = Boolean(dirty);
              return next;
            });
          },
        }))
        : h('div', { className: 'rw-placeholder' },
          h('span', { style: { display: 'inline-flex', opacity: 0.7 } }, IconFolder(30, false)),
          h('div', { className: 'rw-placeholder-title' }, t('openFileTitle')),
          h('div', { className: 'rw-placeholder-hint' }, t('openFileHint')));

      return h('div', { className: 'rw-workbench rw-workspace' },
        h(LinkedDirectoryToolbar, {
          t: t,
          title: remoteOnly ? t('remoteTabTitle') : t('tabTitle'),
          mode: mode,
          searchOpen: searchOpen,
          openMode: settings.fileOpenMode || 'editor',
          directoryOpen: directoryOpen,
          onToggleDirectory: function () { setDirectoryOpen(!directoryOpen); },
          onOpenTerminal: openTerminal,
          localEnabled: !remoteOnly && selected.kind === 'linked',
          showHidden: showHidden,
          onToggleHidden: function () { setShowHidden(!showHidden); },
          transferEnabled: !remoteOnly && (multi.length > 0 || Boolean(selectedEntry)),
          transferSelected: function () {
            if (multi.length === 0 && !selectedEntry) {
              showNotice('info', t('selectFirst'));
              return;
            }
            transferSelection();
          },
          onMode: function (next) { setMode(next); },
          onToggleSearch: function () { setSearchOpen(!searchOpen); },
          onOpenMode: updateOpenMode,
          onRefresh: refreshAll,
        }),
        searchOpen
          ? h('div', { className: 'rw-searchbar' },
            IconSearch(13),
            h('span', { className: 'rw-search-mode' },
              h('button', {
                type: 'button',
                className: 'rw-chip-btn' + (searchMode === 'name' ? ' is-on' : ''),
                title: t('searchModeName'),
                onClick: function () { setSearchMode('name'); },
              }, t('searchModeName')),
              h('button', {
                type: 'button',
                className: 'rw-chip-btn' + (searchMode === 'content' ? ' is-on' : ''),
                title: t('searchModeContent'),
                onClick: function () { setSearchMode('content'); },
              }, t('searchModeContent'))),
            h('input', {
              value: searchQuery,
              placeholder: searchMode === 'content' ? t('searchPlaceholderContent') : t('searchPlaceholder'),
              spellCheck: false,
              autoFocus: true,
              onChange: function (event) { setSearchQuery(event.currentTarget.value); },
            }),
            h('button', {
              type: 'button', className: 'rw-icon-btn', title: t('cancel'),
              onClick: function () { setSearchOpen(false); setSearchQuery(''); },
            }, IconClose(12)))
          : null,
        sources.length > 1
          ? h('div', { className: 'rw-chips' },
            sources.map(function (source) {
              return h('button', {
                key: source.key,
                type: 'button',
                className: 'rw-chip-btn' + (selected.key === source.key ? ' is-on' : ''),
                title: source.name + ' · ' + source.remotePath + ' · ' + statusTitle(t, source),
                onClick: function () { setSelectedKey(source.key); },
              }, source.kind === 'linked' ? IconLinkedWorkspace(11) : source.kind === 'remote' ? IconRemoteWorkspace(11) : IconFolderTree(11), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, source.name));
            }))
          : null,
        info,
        h('div', { className: 'rw-workspace-body' },
          h('div', { className: 'rw-content-pane' },
            openFiles.length > 0
              ? h('div', { className: 'rw-file-tabs' },
                openFiles.map(function (file) {
                  return h('div', {
                    key: file.key,
                    className: 'rw-file-tab' + (file.key === activeFileKey ? ' is-on' : ''),
                    title: file.path,
                    onClick: function () { setActiveFileKey(file.key); },
                  },
                    fileDirty && fileDirty[file.key] ? h('span', { className: 'rw-file-tab-dot' }) : null,
                    h('span', { className: 'rw-file-tab-name' }, file.name),
                    h('button', {
                      type: 'button', className: 'rw-file-tab-close', title: t('closeFile'),
                      onClick: function (event) { event.stopPropagation(); requestCloseInternalFile(file.key); },
                    }, IconClose(10)));
                }))
              : null,
            h('div', { className: 'rw-content-body' }, contentArea)),
          directoryOpen
            ? h('div', {
              className: 'rw-pane-resizer',
              role: 'separator',
              'aria-orientation': 'vertical',
              title: t('resizeDirectory'),
              onPointerDown: beginResize,
              onDoubleClick: function () { setDirectoryWidth(300); },
            })
            : null,
          directoryOpen
            ? h('div', { className: 'rw-directory-pane', style: { flexBasis: directoryWidth + 'px' } },
              h('div', { className: 'rw-directory-head' },
                IconFolder(11, false),
                h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, remoteOnly ? t('remoteTabTitle') : t('tabTitle')),
                h('button', { type: 'button', className: 'rw-icon-btn', title: t('toggleDirectory'), onClick: function () { setDirectoryOpen(false); } }, IconClose(11))),
              h('div', { className: 'rw-directory-body' }, body))
            : null),
        ctxMenu ? h(ContextMenu, { menu: ctxMenu, items: buildContextItems(ctxMenu), t: t, onClose: closeContextMenu }) : null,
        dialog ? renderDialog() : null);
    }

    function RemoteFileTab(props) {
      var ctx = props.ctx;
      var t = props.t;
      var locale = props.locale;
      var tab = props.tab;
      var meta = tab && tab.meta ? tab.meta : {};
      var scope = meta.linkedId
        ? { kind: 'linked', id: meta.linkedId }
        : meta.remoteId
          ? { kind: 'remote', id: meta.remoteId }
          : { kind: 'workspace', id: meta.workspaceId };
      var filePath = tab && tab.path ? tab.path : '';
      return h('div', { className: 'rw-editor-pane' },
        h(RemoteFileEditor, {
          ctx: ctx, t: t, locale: locale,
          scope: scope,
          path: filePath,
          visible: props.visible !== false,
          tabId: tab ? tab.id : undefined,
          sessionId: props.scope ? props.scope.sessionId : undefined,
        }));
    }

    // ── tree ───────────────────────────────────────────────────────────────

    function TreeDirectory(props) {
      var path = props.path;
      var name = props.name;
      var depth = props.depth;
      var source = props.source;
      var t = props.t;
      var locale = props.locale;
      var expanded = props.expanded;
      var toggle = props.toggle;
      var state = props.state;
      var onSelect = props.onSelect;
      var onPin = props.onPin;
      var onSelectPath = props.onSelectPath;
      var onContextMenu = props.onContextMenu;
      var selectedPath = props.selectedPath;
      var isOpen = expanded.has(path);
      var entry = state.entries.get(path) || { loading: false, error: null, entries: [] };
      var childSiblings = entry.entries.map(function (item) {
        return { path: item.path, name: item.name, isDir: item.type === 'dir' };
      });
      // Hovering over a collapsed folder during a drag expands it after a short
      // delay, so dropping into a nested folder does not require two passes.
      var dragOpenTimer = useRef(null);

      useEffect(function () {
        return function () {
          if (dragOpenTimer.current) clearTimeout(dragOpenTimer.current);
        };
      }, []);

      useEffect(function () {
        if (isOpen && !entry.loading && !entry.loaded && !entry.error) props.load(path);
      }, [isOpen]);

      var children = [];
      if (isOpen) {
        if (entry.loading) children.push(h('div', { key: 'loading', className: 'rw-row-msg' }, Spinner(12), t('loading')));
        else if (entry.error) children.push(h('button', {
          key: 'error',
          type: 'button',
          className: 'rw-row-msg',
          style: { color: 'var(--dsw-alias-state-error-primary)', width: '100%', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' },
          onClick: function () { props.load(path); },
        }, IconAlert(12), messageOf(entry.error, t, locale)));
        else if (entry.entries.length === 0) children.push(h('div', { key: 'empty', className: 'rw-row-msg' }, t('noEntries')));
        else {
          entry.entries.forEach(function (child) {
            if (child.type === 'dir') {
              children.push(h(TreeDirectory, {
                key: child.path,
                path: child.path,
                name: child.name,
                depth: depth + 1,
                source: source,
                t: t,
                locale: locale,
                expanded: expanded,
                toggle: toggle,
                state: state,
                load: props.load,
                loadMore: props.loadMore,
                onSelect: onSelect,
                onPin: onPin,
                onSelectPath: onSelectPath,
                onContextMenu: onContextMenu,
                onDragStart: props.onDragStart,
                onDropOnPath: props.onDropOnPath,
                selectedPath: selectedPath,
                selectedSet: props.selectedSet,
                siblings: childSiblings,
              }));
            } else if (child.type === 'file' || child.type === 'symlink') {
              var active = selectedPath === child.path || Boolean(props.selectedSet && props.selectedSet.has(child.path));
              children.push(h('button', {
                key: child.path,
                type: 'button',
                role: 'treeitem',
                'aria-level': depth + 1,
                'aria-selected': active,
                className: 'rw-row' + (active ? ' is-active' : ''),
                style: { paddingLeft: 6 + (depth + 1) * 12 },
                title: child.path,
                draggable: Boolean(props.onDragStart),
                onDragStart: function (event) {
                  if (props.onDragStart) props.onDragStart(event, { path: child.path, name: child.name, isDir: false });
                },
                onClick: function (event) {
                  if (onSelectPath) onSelectPath({ path: child.path, name: child.name, isDir: false, siblings: childSiblings, event: event });
                  if (event.detail !== 2) onSelect(child.path);
                },
                onDoubleClick: function () { if (onPin) onPin(child.path); },
                onContextMenu: function (event) {
                  if (!onContextMenu) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onContextMenu({ path: child.path, name: child.name, isDir: false, event: event });
                },
              },
                h('span', { className: 'rw-chevron' }),
                h(FileGlyph, { name: child.name, size: 13 }),
                h('span', { className: 'rw-row-name' }, child.name),
                h('span', { className: 'rw-row-size' }, formatBytes(child.size))));
            }
          });
          if (entry.hasMore) {
            children.push(h('button', {
              key: 'more',
              type: 'button',
              className: 'rw-row-msg rw-load-more',
              style: { paddingLeft: 6 + (depth + 1) * 12 },
              disabled: Boolean(entry.loadingMore),
              onClick: function () { if (props.loadMore) props.loadMore(path); },
            }, entry.loadingMore ? Spinner(12) : null,
            entry.moreError
              ? messageOf(entry.moreError, t, locale)
              : t('loadMore', { count: Math.max((entry.total || 0) - (Number.isFinite(entry.raw) ? entry.raw : entry.entries.length), 0) })));
          }
        }
      }

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          role: 'treeitem',
          'aria-level': depth + 1,
          'aria-expanded': isOpen,
          className: 'rw-row' + (selectedPath === path || (props.selectedSet && props.selectedSet.has(path)) ? ' is-active' : ''),
          style: { paddingLeft: 6 + depth * 12 },
          title: path,
          draggable: Boolean(props.onDragStart),
          onDragStart: function (event) {
            if (props.onDragStart) props.onDragStart(event, { path: path, name: name, isDir: true });
          },
          onClick: function (event) {
            if (onSelectPath) onSelectPath({ path: path, name: name, isDir: true, siblings: props.siblings || [], event: event });
            if (event.detail !== 2) toggle(path);
          },
          onKeyDown: function (event) {
            if (event.key === 'ArrowRight' && !isOpen) { event.preventDefault(); toggle(path); }
            else if (event.key === 'ArrowLeft' && isOpen) { event.preventDefault(); toggle(path); }
          },
          onDragOver: function (event) {
            if (!props.onDropOnPath) return;
            event.preventDefault();
            event.stopPropagation();
            try { event.dataTransfer.dropEffect = 'copy'; } catch (error) { /* ignore */ }
            event.currentTarget.classList.add('is-drop-target');
            if (!isOpen && !dragOpenTimer.current) {
              dragOpenTimer.current = setTimeout(function () {
                dragOpenTimer.current = null;
                toggle(path);
              }, 700);
            }
          },
          onDragLeave: function (event) {
            event.currentTarget.classList.remove('is-drop-target');
            if (dragOpenTimer.current) {
              clearTimeout(dragOpenTimer.current);
              dragOpenTimer.current = null;
            }
          },
          onDrop: function (event) {
            event.currentTarget.classList.remove('is-drop-target');
            if (dragOpenTimer.current) {
              clearTimeout(dragOpenTimer.current);
              dragOpenTimer.current = null;
            }
            if (props.onDropOnPath) props.onDropOnPath(path, event);
          },
          onContextMenu: function (event) {
            if (!onContextMenu) return;
            event.preventDefault();
            event.stopPropagation();
            onContextMenu({ path: path, name: name, isDir: true, event: event });
          },
        },
          h('span', { className: 'rw-chevron' + (isOpen ? ' is-open' : '') }, IconChevron(12)),
          h(FileGlyph, { name: name, dir: true, open: isOpen, size: 13 }),
          h('span', { className: 'rw-row-name' }, name)),
        children);
    }

    function WorkspaceTreeSource(props) {
      var source = props.source;
      var t = props.t;
      var locale = props.locale;
      var openState = useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var expandedState = useState(function () { return new Set(); });
      var expanded = expandedState[0];
      var setExpanded = expandedState[1];
      var cacheState = useState({ entries: new Map() });
      var cache = cacheState[0];
      var setCache = cacheState[1];

      function toggle(path) {
        setExpanded(function (previous) {
          var next = new Set(previous);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      }

      function listRequest(path, offset) {
        return Object.assign({ path: path, limit: TREE_PAGE_SIZE, offset: offset }, scopeParams(source));
      }

      function load(path) {
        // Ref-based guard: a state setter callback is not a lock, so checking
        // record.loading inside setCache would still fire duplicate requests.
        if (pending.current.has(path)) return;
        pending.current.add(path);
        setCache(function (previous) {
          var entries = new Map(previous.entries);
          var existing = entries.get(path) || {};
          entries.set(path, { loading: true, error: null, entries: existing.entries || [], loaded: existing.loaded });
          return { entries: entries };
        });
        apiCall('fs.list', listRequest(path, 0)).then(function (result) {
          pending.current.delete(path);
          setCache(function (previous) {
            var entries = new Map(previous.entries);
            entries.set(path, {
              loading: false,
              error: null,
              loaded: true,
              entries: result.entries || [],
              raw: (result.entries || []).length,
              total: Number(result.total) || (result.entries || []).length,
              hasMore: Boolean(result.hasMore),
            });
            return { entries: entries };
          });
          setExpanded(function (previous) {
            var next = new Set(previous);
            next.add(path);
            return next;
          });
        }).catch(function (error) {
          pending.current.delete(path);
          setCache(function (previous) {
            var entries = new Map(previous.entries);
            entries.set(path, { loading: false, error: error, loaded: false, entries: [] });
            return { entries: entries };
          });
        });
      }

      function loadMore(path) {
        var record = cache.entries.get(path);
        if (!record || record.loadingMore || !record.hasMore) return;
        var offset = Number.isFinite(Number(record.raw)) ? Number(record.raw) : (record.entries || []).length;
        setCache(function (previous) {
          var entries = new Map(previous.entries);
          var current = entries.get(path);
          if (current) entries.set(path, Object.assign({}, current, { loadingMore: true }));
          return { entries: entries };
        });
        apiCall('fs.list', listRequest(path, offset)).then(function (result) {
          setCache(function (previous) {
            var entries = new Map(previous.entries);
            var current = entries.get(path) || { entries: [] };
            entries.set(path, Object.assign({}, current, {
              loadingMore: false,
              loaded: true,
              entries: current.entries.concat(result.entries || []),
              raw: offset + (result.entries || []).length,
              total: Number(result.total) || current.total,
              hasMore: Boolean(result.hasMore),
            }));
            return { entries: entries };
          });
        }).catch(function (error) {
          setCache(function (previous) {
            var entries = new Map(previous.entries);
            var current = entries.get(path);
            if (current) entries.set(path, Object.assign({}, current, { loadingMore: false, moreError: error }));
            return { entries: entries };
          });
        });
      }

      useEffect(function () {
        if (!open) return;
        var root = source.remotePath;
        setExpanded(function (previous) {
          if (previous.has(root)) return previous;
          var next = new Set(previous);
          next.add(root);
          return next;
        });
        var record = cache.entries.get(root);
        if (!record || (!record.loaded && !record.loading && !record.error)) load(root);
      }, [open]);

      return h('div', { className: 'rw-tree-ws' },
        h('button', {
          type: 'button',
          className: 'rw-tree-ws-head',
          onClick: function () { setOpen(function (value) { return !value; }); },
          'aria-expanded': open,
          title: source.name + ' · ' + statusTitle(t, source),
        },
          h('span', { className: 'rw-chevron' + (open ? ' is-open' : '') }, IconChevron(12)),
          h('span', { className: 'rw-icon-chip' + (source.kind === 'linked' ? ' rw-icon-chip-link' : ''), style: { width: 24, height: 24, borderRadius: 7 } },
            source.kind === 'linked' ? IconLinkedWorkspace(13) : source.kind === 'remote' ? IconRemoteWorkspace(13) : IconFolderTree(13)),
          h('span', { className: 'rw-tree-ws-title' },
            h('span', { className: 'rw-tree-ws-name' }, source.name),
            h('span', { className: 'rw-tree-ws-sub' }, source.username + '@' + source.host
              + (source.kind === 'linked' ? ' · ' + t('linkedChip') : source.kind === 'remote' ? ' · ' + t('remoteChip') : ''))),
          h(StatusPill, { status: source.status, t: t })),
        open
          ? h('div', { className: 'rw-tree-body', role: 'tree', 'aria-label': source.name },
            h(TreeDirectory, {
              path: source.remotePath,
              name: '/',
              depth: 0,
              source: source,
              t: t,
              locale: locale,
              expanded: expanded,
              toggle: toggle,
              state: { entries: cache.entries },
              load: load,
              loadMore: loadMore,
              onSelect: props.onSelect,
              selectedPath: props.selectedPath,
            }))
          : null);
    }

    // ── add workspace flows ────────────────────────────────────────────────

    function HostList(props) {
      var t = props.t;
      var hosts = props.hosts || [];
      if (props.loading) return h('div', { className: 'rw-inline rw-muted', style: { padding: '10px 2px', fontSize: 12 } }, Spinner(13), t('loading'));
      if (hosts.length === 0) return h(Banner, { kind: 'warn' }, t('emptyHint'));
      return h('div', { className: 'rw-host-list', role: 'listbox', 'aria-label': t('stepHost') },
        hosts.map(function (host) {
          var on = host.id === props.selectedId;
          var usable = host.hasCredential !== false;
          return h('button', {
            key: host.id,
            type: 'button',
            role: 'option',
            'aria-selected': on,
            title: host.name,
            className: 'rw-host' + (on ? ' is-on' : ''),
            onClick: function () { if (props.onSelect) props.onSelect(host); },
          },
            h('span', { className: 'rw-file-icon', style: { color: on ? 'var(--dsw-alias-brand-primary)' : undefined } }, IconServer(16)),
            h('span', { className: 'rw-host-main' },
              h('span', { className: 'rw-host-name' }, host.name),
              h('span', { className: 'rw-host-meta' }, host.username + '@' + host.host + ':' + host.port)),
            usable
              ? h('span', { className: 'rw-chip' }, host.source === 'ssh-config' ? t('sourceConfig') : t('sourceManager'))
              : h('span', { className: 'rw-chip', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, t('needPassword')));
        }));
    }

    // Password field for a host that has no usable key. The plugin keeps the
    // secret itself, so this works without the optional `dsh-ssh-tunnel` plugin.
    function SshCredentialField(props) {
      var t = props.t;
      var host = props.host;
      if (!host) return null;
      var stored = host.hasStoredPassword === true;
      var needed = host.hasCredential === false || host.authType === 'password';
      if (!needed && !stored) return null;
      var checkState = useState({ busy: false, ok: false, message: '' });
      var check = checkState[0];
      var setCheck = checkState[1];
      var inputRef = useRef(null);
      // Selecting a host that still needs a secret should put the cursor in the
      // password box, so the dialog asks for it instead of leaving the user to
      // find the field.
      useEffect(function () {
        if (!needed && !stored) return;
        var node = inputRef.current;
        if (node && typeof node.focus === 'function') node.focus();
      }, [host.id, needed, stored]);
      function verify() {
        if (check.busy || props.busy) return;
        var value = props.value || '';
        if (value === '') { setCheck({ busy: false, ok: false, message: t('sshPasswordRequired') }); return; }
        setCheck({ busy: true, ok: false, message: '' });
        apiCall('hosts.credentials', { hostId: host.id, password: value })
          .then(function () { return apiCall('hosts.browse', { hostId: host.id, path: '' }); })
          .then(function () {
            setCheck({ busy: false, ok: true, message: t('sshPasswordOk') });
            if (props.onVerified) props.onVerified();
          })
          .catch(function (err) {
            setCheck({ busy: false, ok: false, message: t('sshPasswordFailed') + ' ' + messageOf(err, t, props.locale) });
            if (props.onVerified) props.onVerified();
          });
      }
      return h('div', { className: 'rw-field' },
        h('div', { className: 'rw-label' }, t('sshPassword')),
        h('div', { className: 'rw-inline' },
          h('input', {
            className: 'rw-input',
            type: 'password',
            ref: inputRef,
            value: props.value || '',
            placeholder: stored ? t('sshPasswordStored') : t('sshPasswordPlaceholder'),
            autoComplete: 'new-password',
            spellCheck: false,
            disabled: props.busy,
            onChange: function (event) { props.onChange(event.currentTarget.value); },
            onKeyDown: function (event) { if (event.key === 'Enter' && props.onSubmit) props.onSubmit(); },
          }),
          h('button', {
            type: 'button',
            className: 'rw-btn rw-btn-sm',
            disabled: check.busy || props.busy,
            onClick: verify,
          }, check.busy ? t('sshVerifying') : t('sshVerify'))),
        check.message
          ? h('div', { className: 'rw-hint', style: check.ok ? { color: '#3fb950' } : { color: '#f85149' } }, check.message)
          : h('div', { className: 'rw-hint' }, needed && !stored ? t('sshPasswordHint') : t('sshPasswordStoredHint')));
    }

    function AddWorkspaceFlow(props) {      var ctx = props.ctx;
      var t = props.t;
      var locale = props.locale;
      var onDone = props.onDone;
      var onCancel = props.onCancel;

      var hostState = useState({ loading: true, hosts: [], error: null });
      var hostData = hostState[0];
      var setHostData = hostState[1];
      var selectedState = useState('');
      var selectedHostId = selectedState[0];
      var setSelectedHostId = selectedState[1];
      var pathState = useState('');
      var remotePath = pathState[0];
      var setRemotePath = pathState[1];
      var localPathState = useState('');
      var localPath = localPathState[0];
      var setLocalPath = localPathState[1];
      var nameState = useState('');
      var name = nameState[0];
      var setName = nameState[1];
      var mirrorState = useState(false);
      var mirror = mirrorState[0];
      var setMirror = mirrorState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState('');
      var error = errorState[0];
      var setError = errorState[1];
      var remoteOpenState = useState(false);
      var remoteOpen = remoteOpenState[0];
      var setRemoteOpen = remoteOpenState[1];
      var localOpenState = useState(false);
      var localOpen = localOpenState[0];
      var setLocalOpen = localOpenState[1];
      var passwordState = useState('');
      var password = passwordState[0];
      var setPassword = passwordState[1];

      var loadHosts = useCallback(function () {
        setHostData(function (previous) { return { loading: previous.hosts.length === 0, hosts: previous.hosts, error: null }; });
        apiCall('hosts.list', {}).then(function (result) {
          setHostData({ loading: false, hosts: result.hosts || [], error: null });
          setSelectedHostId(function (current) {
            if (current) return current;
            return result.hosts && result.hosts.length > 0 ? result.hosts[0].id : '';
          });
        }).catch(function (err) {
          setHostData({ loading: false, hosts: [], error: err });
        });
      }, []);

      useEffect(function () { loadHosts(); }, [loadHosts]);

      function chooseHost(host) {
        setSelectedHostId(host.id);
        setPassword('');
        setError('');
        setRemoteOpen(false);
        if (remotePath.trim() === '' && host && host.hasCredential !== false) {
          apiCall('hosts.browse', { hostId: host.id }).then(function (result) {
            setRemotePath(function (current) { return current.trim() === '' ? result.home : current; });
          }).catch(function () { /* silent prefill */ });
        }
      }

      function selectedHost() {
        return hostData.hosts.filter(function (item) { return item.id === selectedHostId; })[0] || null;
      }

      function needsPassword(host) {
        if (!host) return false;
        if (host.hasCredential === false) return true;
        return host.authType === 'password' && host.hasStoredPassword !== true;
      }

      function submit() {
        if (busy) return;
        if (!selectedHostId) { setError(t('stepHost')); return; }
        var trimmedRemote = remotePath.trim();
        if (trimmedRemote === '') { setError(t('stepPath')); return; }
        var trimmedLocal = localPath.trim();
        if (trimmedLocal === '') { setBusy(false); setError(t('stepLocalPath')); return; }
        var typedPassword = password;
        if (needsPassword(selectedHost()) && typedPassword === '') { setError(t('sshPasswordRequired')); return; }
        setBusy(true);
        setError('');
        var stored = typedPassword === ''
          ? Promise.resolve()
          : apiCall('hosts.credentials', { hostId: selectedHostId, password: typedPassword }).then(loadHosts);
        stored.then(function () {
          return apiCall('linked.create', {
            hostId: selectedHostId,
            remotePath: trimmedRemote,
            localPath: trimmedLocal,
            name: name.trim(),
            mirror: mirror,
          });
        }).then(function () {
          setBusy(false);
          bus.emit();
          if (onDone) onDone();
        }).catch(function (err) {
          setBusy(false);
          setError(t('addLinkedFailed') + '：' + messageOf(err, t, locale));
        });
      }

      if (props.submitRef) props.submitRef.current = { submit: submit, busy: busy };

      return h('div', { className: 'rw-add' },
        h('div', { className: 'rw-inline', style: { justifyContent: 'space-between' } },
          h('div', { className: 'rw-add-title' }, t('createLinked'))),
        h('div', { className: 'rw-field' },
          h('div', { className: 'rw-label' }, t('stepHost')),
          h(HostList, { t: t, hosts: hostData.hosts, loading: hostData.loading, selectedId: selectedHostId, onSelect: chooseHost }),
          hostData.error ? h(Banner, { kind: 'error' }, t('hostsFailed') + '：' + messageOf(hostData.error, t, locale)) : null),
        h(SshCredentialField, {
          t: t, locale: locale, host: selectedHost(), value: password, busy: busy,
          onChange: setPassword, onSubmit: submit, onVerified: loadHosts,
        }),
        h('div', { className: 'rw-field' },
          h('div', { className: 'rw-label' }, t('stepPath')),
          h('div', { className: 'rw-input-row' },
            h('input', {
              className: 'rw-input rw-input-mono',
              value: remotePath,
              placeholder: t('pathPlaceholder'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: function (event) { setRemotePath(event.currentTarget.value); },
              onKeyDown: function (event) { if (event.key === 'Enter') submit(); },
            }),
            h('button', {
              type: 'button', className: 'rw-btn',
              onClick: function () { setRemoteOpen(function (value) { return !value; }); },
              disabled: !selectedHostId,
            }, IconFolder(13), remoteOpen ? t('cancel') : t('browse'))),
          remoteOpen
            ? h(RemotePathPicker, {
              t: t, locale: locale, hostId: selectedHostId,
              initialPath: remotePath,
              onPick: function (picked) { setRemotePath(picked); setRemoteOpen(false); },
            })
            : null,
          h('div', { className: 'rw-hint' }, t('diskHint'))),
        h('div', { className: 'rw-field' },
            h('div', { className: 'rw-label' }, t('stepLocalPath')),
            h('div', { className: 'rw-input-row' },
              h('input', {
                className: 'rw-input rw-input-mono',
                value: localPath,
                placeholder: t('localPathPlaceholder'),
                spellCheck: false,
                onChange: function (event) { setLocalPath(event.currentTarget.value); },
              }),
              h('button', {
                type: 'button', className: 'rw-btn',
                onClick: function () { setLocalOpen(function (value) { return !value; }); },
              }, IconFolder(13), localOpen ? t('cancel') : t('browse'))),
            localOpen
              ? h(LocalPathPicker, {
                t: t, locale: locale, initialPath: localPath,
                onPick: function (picked) { setLocalPath(picked); setLocalOpen(false); },
              })
              : null,
            h('div', { className: 'rw-hint' }, t('linkedFlowHint')),
            h('div', { className: 'rw-inline', style: { marginTop: 4 } },
              h(Switch, {
                checked: mirror, onChange: setMirror, label: t('mirrorLabel'),
                text: t('mirrorLabel'),
              })),
            h('div', { className: 'rw-hint' }, t('mirrorHint'))),
        h('div', { className: 'rw-field' },
          h('div', { className: 'rw-label' }, t('stepName')),
          h('input', {
            className: 'rw-input',
            value: name,
            placeholder: basename(localPath) || t('namePlaceholder'),
            maxLength: 120,
            onChange: function (event) { setName(event.currentTarget.value); },
            onKeyDown: function (event) { if (event.key === 'Enter') submit(); },
          })),
        error ? h(Banner, { kind: 'error' }, error) : null,
        props.compact ? null : h('div', { className: 'rw-actions' },
          h('button', { type: 'button', className: 'rw-btn', disabled: busy, onClick: onCancel }, t('cancel')),
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-primary',
            disabled: busy || !selectedHostId || remotePath.trim() === '' || localPath.trim() === '',
            onClick: submit,
          }, busy ? Spinner(13) : IconLinkedWorkspace(13), busy ? t('creating') : t('create'))));
    }

    // ── remote workspace flow (sessions run inside the remote folder) ──────

    function AddRemoteWorkspaceFlow(props) {
      var t = props.t;
      var locale = props.locale;
      var onDone = props.onDone;
      var onCancel = props.onCancel;

      var hostState = useState({ loading: true, hosts: [], error: null });
      var hostData = hostState[0];
      var setHostData = hostState[1];
      var selectedState = useState('');
      var selectedHostId = selectedState[0];
      var setSelectedHostId = selectedState[1];
      var pathState = useState('');
      var remotePath = pathState[0];
      var setRemotePath = pathState[1];
      var nameState = useState('');
      var name = nameState[0];
      var setName = nameState[1];
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errorState = useState('');
      var error = errorState[0];
      var setError = errorState[1];
      var remoteOpenState = useState(false);
      var remoteOpen = remoteOpenState[0];
      var setRemoteOpen = remoteOpenState[1];
      var passwordState = useState('');
      var password = passwordState[0];
      var setPassword = passwordState[1];

      var loadHosts = useCallback(function () {
        setHostData(function (previous) { return { loading: previous.hosts.length === 0, hosts: previous.hosts, error: null }; });
        apiCall('hosts.list', {}).then(function (result) {
          setHostData({ loading: false, hosts: result.hosts || [], error: null });
          setSelectedHostId(function (current) {
            if (current) return current;
            return result.hosts && result.hosts.length > 0 ? result.hosts[0].id : '';
          });
        }).catch(function (err) {
          setHostData({ loading: false, hosts: [], error: err });
        });
      }, []);

      useEffect(function () { loadHosts(); }, [loadHosts]);

      function chooseHost(host) {
        setSelectedHostId(host.id);
        setPassword('');
        setError('');
        setRemoteOpen(false);
        if (remotePath.trim() === '' && host && host.hasCredential !== false) {
          apiCall('hosts.browse', { hostId: host.id }).then(function (result) {
            setRemotePath(function (current) { return current.trim() === '' ? result.home : current; });
          }).catch(function () { /* silent prefill */ });
        }
      }

      function selectedHost() {
        return hostData.hosts.filter(function (item) { return item.id === selectedHostId; })[0] || null;
      }

      function needsPassword(host) {
        if (!host) return false;
        if (host.hasCredential === false) return true;
        return host.authType === 'password' && host.hasStoredPassword !== true;
      }

      function submit() {
        if (busy) return;
        if (!selectedHostId) { setError(t('stepHost')); return; }
        var trimmedRemote = remotePath.trim();
        if (trimmedRemote === '') { setError(t('stepPath')); return; }
        var typedPassword = password;
        if (needsPassword(selectedHost()) && typedPassword === '') { setError(t('sshPasswordRequired')); return; }
        setBusy(true);
        setError('');
        var stored = typedPassword === ''
          ? Promise.resolve()
          : apiCall('hosts.credentials', { hostId: selectedHostId, password: typedPassword }).then(loadHosts);
        stored.then(function () {
          return apiCall('remote_workspaces.create', {
            hostId: selectedHostId,
            remotePath: trimmedRemote,
            name: name.trim(),
          });
        }).then(function () {
          setBusy(false);
          bus.emit();
          if (onDone) onDone();
        }).catch(function (err) {
          setBusy(false);
          setError(t('remoteCreateFailed') + '：' + messageOf(err, t, locale));
        });
      }

      if (props.submitRef) props.submitRef.current = { submit: submit, busy: busy };

      return h('div', { className: 'rw-add' },
        h('div', { className: 'rw-inline', style: { justifyContent: 'space-between' } },
          h('div', { className: 'rw-add-title' }, t('createRemote'))),
        h('div', { className: 'rw-hint' }, t('flowRemoteDesc')),
        h('div', { className: 'rw-field' },
          h('div', { className: 'rw-label' }, t('stepHost')),
          h(HostList, { t: t, hosts: hostData.hosts, loading: hostData.loading, selectedId: selectedHostId, onSelect: chooseHost }),
          hostData.error ? h(Banner, { kind: 'error' }, t('hostsFailed') + '：' + messageOf(hostData.error, t, locale)) : null),
        h(SshCredentialField, {
          t: t, locale: locale, host: selectedHost(), value: password, busy: busy,
          onChange: setPassword, onSubmit: submit, onVerified: loadHosts,
        }),
        h('div', { className: 'rw-field' },
          h('div', { className: 'rw-label' }, t('stepPath')),
          h('div', { className: 'rw-input-row' },
            h('input', {
              className: 'rw-input rw-input-mono',
              value: remotePath,
              placeholder: t('pathPlaceholder'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: function (event) { setRemotePath(event.currentTarget.value); },
              onKeyDown: function (event) { if (event.key === 'Enter') submit(); },
            }),
            h('button', {
              type: 'button', className: 'rw-btn',
              onClick: function () { setRemoteOpen(function (value) { return !value; }); },
              disabled: !selectedHostId,
            }, IconFolder(13), remoteOpen ? t('cancel') : t('browse'))),
          remoteOpen
            ? h(RemotePathPicker, {
              t: t, locale: locale, hostId: selectedHostId,
              initialPath: remotePath,
              onPick: function (picked) { setRemotePath(picked); setRemoteOpen(false); },
            })
            : null,
          h('div', { className: 'rw-hint' }, t('diskHint'))),
        h('div', { className: 'rw-field' },
          h('div', { className: 'rw-label' }, t('remoteStepName')),
          h('input', {
            className: 'rw-input',
            value: name,
            placeholder: basename(remotePath) || t('namePlaceholder'),
            maxLength: 120,
            onChange: function (event) { setName(event.currentTarget.value); },
            onKeyDown: function (event) { if (event.key === 'Enter') submit(); },
          })),
        h('div', { className: 'rw-hint' }, t('remotePlaceholderHint')),
        error ? h(Banner, { kind: 'error' }, error) : null,
        props.compact ? null : h('div', { className: 'rw-actions' },
          h('button', { type: 'button', className: 'rw-btn', disabled: busy, onClick: onCancel }, t('cancel')),
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-primary',
            disabled: busy || !selectedHostId || remotePath.trim() === '',
            onClick: submit,
          }, busy ? Spinner(13) : IconRemoteWorkspace(13), busy ? t('creating') : t('create'))));
    }

    // ── directory flow (sidebar / hero "add workspace" hole) ───────────────

    function WorkspaceDirectoryFlow(props) {
      var ctx = props.ctx;
      var t = props.t;
      var locale = props.locale;
      var flowState = useState('local');
      var flow = flowState[0];
      var setFlow = flowState[1];
      var localPathState = useState('');
      var localPath = localPathState[0];
      var setLocalPath = localPathState[1];
      var localNameState = useState('');
      var localName = localNameState[0];
      var setLocalName = localNameState[1];
      var localBusyState = useState(false);
      var localBusy = localBusyState[0];
      var setLocalBusy = localBusyState[1];
      var localErrorState = useState('');
      var localError = localErrorState[0];
      var setLocalError = localErrorState[1];
      var flowLocalOpenState = useState(false);
      var flowLocalOpen = flowLocalOpenState[0];
      var setFlowLocalOpen = flowLocalOpenState[1];
      var flowSubmitRef = useRef(null);

      function createLocal() {
        var target = localPath.trim();
        if (localBusy) return;
        // Keep the button looking the same as the linked/remote ones and report
        // the missing folder instead of silently ignoring the click.
        if (target === '') { setLocalError(t('localPathRequired')); return; }
        setLocalBusy(true);
        setLocalError('');
        apiCall('localWorkspace.create', { path: target, name: localName.trim() }).then(function () {
          setLocalBusy(false);
          bus.emit();
          if (props.onCancel) props.onCancel();
        }).catch(function (error) {
          setLocalBusy(false);
          setLocalError(messageOf(error, t, locale));
        });
      }

      var modalRef = useRef(null);
      var focusablesOf = function () {
        var node = modalRef.current;
        if (!node) return [];
        return Array.prototype.filter.call(
          node.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'),
          function (element) { return !element.disabled && element.offsetParent !== null; });
      };

      useEffect(function () {
        if (!props.open) return;
        var node = modalRef.current;
        if (!node) return;
        // Focus the first real field, not the tab strip, so typing works at once.
        var target = node.querySelector('.rw-modal-body input, .rw-modal-body textarea') || focusablesOf()[0];
        if (target && typeof target.focus === 'function') target.focus();
      }, [props.open, flow]);

      // The app shell listens for wheel gestures on the document root and moves
      // the conversation behind the dialog, so a wheel over the host list (or
      // anywhere else in the dialog) never reaches the dialog's own scroll
      // areas. Take the gesture in the capture phase: scroll the innermost
      // scrollable element inside the dialog, chain to the next one at the
      // edges, and never let the page behind move while the dialog is open.
      useEffect(function () {
        if (!props.open) return undefined;
        var node = modalRef.current;
        if (!node) return undefined;
        var overlay = node.closest ? (node.closest('.rw-modal-backdrop') || node) : node;

        function firstScrollable(start) {
          var el = start;
          while (el && el !== overlay) {
            if (el.scrollHeight > el.clientHeight + 1) {
              var overflow = getComputedStyle(el).overflowY;
              if (overflow === 'auto' || overflow === 'scroll') return el;
            }
            el = el.parentElement;
          }
          return null;
        }

        function onWheel(event) {
          if (!event.deltaY) return;
          if (!overlay.contains(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          var step = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
          var el = firstScrollable(event.target && event.target.nodeType === 1 ? event.target : overlay);
          while (el) {
            var before = el.scrollTop;
            el.scrollTop = before + step;
            if (el.scrollTop !== before) return;
            el = firstScrollable(el.parentElement);
          }
        }

        window.addEventListener('wheel', onWheel, { passive: false, capture: true });
        return function () { window.removeEventListener('wheel', onWheel, { capture: true }); };
      }, [props.open]);

      function onModalKeyDown(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (props.onCancel) props.onCancel();
          return;
        }
        if (event.key !== 'Tab') return;
        // Keep Tab inside the dialog: without this the focus escapes to the
        // page behind the backdrop.
        var focusables = focusablesOf();
        if (focusables.length === 0) return;
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }

      if (!props.open) return null;

      return h('div', { className: 'rw-modal-backdrop', role: 'presentation' },
        h('div', {
          ref: modalRef,
          className: 'rw-modal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('flowTitle'),
          onKeyDown: onModalKeyDown,
        },
          h('div', { className: 'rw-modal-head' },
            h('span', { className: 'rw-icon-chip' }, IconFolderTree(16)),
            h('span', { className: 'rw-modal-title' }, t('flowTitle')),
            h('button', { type: 'button', className: 'rw-icon-btn', title: t('cancel'), onClick: function () { if (props.onCancel) props.onCancel(); } }, IconClose(14))),
          h('div', { className: 'rw-modal-body' },
            h('div', { className: 'rw-tabs' },
              h('button', { type: 'button', className: 'rw-tab' + (flow === 'local' ? ' is-on' : ''), onClick: function () { setFlow('local'); } }, IconFolder(13), t('flowLocal')),
              h('button', { type: 'button', className: 'rw-tab' + (flow === 'linked' ? ' is-on' : ''), onClick: function () { setFlow('linked'); } }, IconLinkedWorkspace(13), t('flowLinked')),
              h('button', { type: 'button', className: 'rw-tab' + (flow === 'remote' ? ' is-on' : ''), onClick: function () { setFlow('remote'); } }, IconRemoteWorkspace(13), t('flowRemote'))),
            h('div', { className: 'rw-hint' }, flow === 'local' ? t('localFlowHint') : flow === 'remote' ? t('flowRemoteDesc') : t('linkedFlowHint')),
            flow === 'local'
              ? h('div', { className: 'rw-add' },
                h('div', { className: 'rw-field' },
                  h('div', { className: 'rw-label' }, t('localDirStep')),
                  h('div', { className: 'rw-input-row' },
                    h('input', {
                      className: 'rw-input rw-input-mono',
                      value: localPath,
                      placeholder: t('localPathPlaceholder'),
                      spellCheck: false,
                      onChange: function (event) { setLocalPath(event.currentTarget.value); if (localError) setLocalError(''); },
                    }),
                    h('button', {
                      type: 'button', className: 'rw-btn',
                      onClick: function () { setFlowLocalOpen(function (value) { return !value; }); },
                    }, IconFolder(13), flowLocalOpen ? t('cancel') : t('browse'))),
                  flowLocalOpen
                    ? h(LocalPathPicker, {
                      t: t, locale: locale, initialPath: localPath,
                      onPick: function (picked) { setLocalPath(picked); setFlowLocalOpen(false); },
                    })
                    : null),
                h('div', { className: 'rw-field' },
                  h('div', { className: 'rw-label' }, t('nameStep')),
                  h('input', {
                    className: 'rw-input',
                    value: localName,
                    placeholder: basename(localPath) || t('namePlaceholder'),
                    maxLength: 120,
                    onChange: function (event) { setLocalName(event.currentTarget.value); },
                    onKeyDown: function (event) { if (event.key === 'Enter') createLocal(); },
                  })),
                localError ? h(Banner, { kind: 'error' }, localError) : null)
              : flow === 'remote'
                ? h(AddRemoteWorkspaceFlow, {
                  ctx: ctx, t: t, locale: locale, compact: true, submitRef: flowSubmitRef,
                  onDone: function () { if (props.onCancel) props.onCancel(); },
                  onCancel: function () { if (props.onCancel) props.onCancel(); },
                })
                : h(AddWorkspaceFlow, {
                  ctx: ctx, t: t, locale: locale, compact: true, submitRef: flowSubmitRef,
                  onDone: function () { if (props.onCancel) props.onCancel(); },
                  onCancel: function () { if (props.onCancel) props.onCancel(); },
                })),
          h('div', { className: 'rw-modal-foot' },
            h('span', { className: 'rw-hint', style: { flex: '1 1 auto' } }, props.busy ? t('wsFlowBusy') : flow === 'linked' ? t('linkedFlowHint') : flow === 'remote' ? t('flowRemoteDesc') : t('useLocalDirHint')),
            h('button', {
              type: 'button', className: 'rw-btn', disabled: Boolean(props.busy) || localBusy,
              onClick: function () { if (props.onCancel) props.onCancel(); },
            }, t('cancel')),
            flow === 'local'
              ? h('button', {
                type: 'button', className: 'rw-btn rw-btn-primary',
                disabled: Boolean(props.busy) || localBusy,
                onClick: createLocal,
              }, localBusy ? Spinner(13) : IconPlus(13), localBusy ? t('creating') : t('create'))
              : h('button', {
                type: 'button', className: 'rw-btn rw-btn-primary',
                disabled: Boolean(props.busy),
                onClick: function () {
                  var ref = flowSubmitRef.current;
                  if (ref && typeof ref.submit === 'function') ref.submit();
                },
              }, IconPlus(13), t('create')))));
    }

    // ── settings section ───────────────────────────────────────────────────

    function LinkedWorkspaceCard(props) {
      var link = props.link;
      var t = props.t;
      var ctx = props.ctx;
      var locale = props.locale;
      var refresh = props.refresh;
      var state = useState({ busy: '', message: null, removing: false, removeWorkspace: false, deleteLocalState: false });
      var local = state[0];
      var setLocal = state[1];
      var pollRef = useRef(null);

      useEffect(function () {
        return function () { if (pollRef.current) clearTimeout(pollRef.current); };
      }, []);

      function openWorkspace() {
        if (!link.workspaceId) return;
        var uiWorkspace = null;
        try { uiWorkspace = ctx.get('uiWorkspace'); } catch (error) { uiWorkspace = null; }
        if (!uiWorkspace && ctx.root && typeof ctx.root.get === 'function') {
          try { uiWorkspace = ctx.root.get('uiWorkspace'); } catch (error) { uiWorkspace = null; }
        }
        if (uiWorkspace && typeof uiWorkspace.openWorkspace === 'function') {
          try {
            var navigation = uiWorkspace.openWorkspace(link.workspaceId);
            if (navigation && typeof navigation.catch === 'function') navigation.catch(function () { /* navigation aborted */ });
          } catch (error) { /* ignore */ }
        }
        dismissSettingsOverlay();
      }

      function registerWorkspace() {
        setLocal(function (previous) { return Object.assign({}, previous, { busy: 'register', message: null }); });
        apiCall('linked.update', { id: link.id, ensureWorkspace: true }).then(function () {
          setLocal(function (previous) {
            return Object.assign({}, previous, { busy: '', message: { kind: 'success', text: t('workspaceRegistered') } });
          });
          refresh();
        }).catch(function (error) {
          setLocal(function (previous) {
            return Object.assign({}, previous, { busy: '', message: { kind: 'error', text: messageOf(error, t, locale) } });
          });
        });
      }

      function pollSync(job) {
        if (!job) {
          setLocal(function (previous) { return Object.assign({}, previous, { busy: '', message: null }); });
          return;
        }
        if (job.state === 'running') {
          setLocal(function (previous) {
            return Object.assign({}, previous, {
              busy: 'sync',
              message: { kind: 'info', text: t('syncRunning', { files: job.files, size: formatBytes(job.bytes) }) },
            });
          });
          pollRef.current = setTimeout(function () {
            apiCall('linked.syncStatus', { id: link.id }).then(function (result) {
              pollSync(result.job);
            }).catch(function (error) {
              setLocal(function (previous) { return Object.assign({}, previous, { busy: '', message: { kind: 'error', text: messageOf(error, t, locale) } }); });
            });
          }, 900);
          return;
        }
        var message
        if (job.state === 'done') {
          message = {
            kind: 'success',
            text: t('syncDone2', { files: job.files, size: formatBytes(job.bytes) })
              + (job.skipped ? ' · ' + t('syncSkipped', { n: job.skipped }) : '')
              + (job.truncated ? ' · ' + t('syncTruncated') : ''),
          };
        } else if (job.state === 'cancelled') {
          message = { kind: 'info', text: t('syncCancelled') };
        } else {
          message = { kind: 'error', text: t('syncFailed') + (job.error ? '：' + job.error : '') };
        }
        setLocal(function (previous) { return Object.assign({}, previous, { busy: '', message: message }); });
        refresh();
      }

      function sync() {
        if (local.busy === 'sync') return;
        setLocal(function (previous) { return Object.assign({}, previous, { busy: 'sync', message: { kind: 'info', text: t('syncStarting') } }); });
        apiCall('linked.sync', { id: link.id }).then(function (result) {
          pollSync(result.job);
        }).catch(function (error) {
          setLocal(function (previous) { return Object.assign({}, previous, { busy: '', message: { kind: 'error', text: messageOf(error, t, locale) } }); });
        });
      }

      function cancelSync() {
        apiCall('linked.syncCancel', { id: link.id }).catch(function () { /* best effort */ });
      }

      function toggleMirror(next) {
        setLocal(function (previous) { return Object.assign({}, previous, { busy: 'mirror', message: null }); });
        apiCall('linked.update', { id: link.id, mirror: next }).then(function () {
          setLocal(function (previous) { return Object.assign({}, previous, { busy: '', message: { kind: 'success', text: next ? t('mirrorOn') : t('mirrorOff') } }); });
          refresh();
        }).catch(function (error) {
          setLocal(function (previous) { return Object.assign({}, previous, { busy: '', message: { kind: 'error', text: messageOf(error, t, locale) } }); });
        });
      }

      function remove() {
        if (!local.removing) {
          setLocal(function (previous) { return Object.assign({}, previous, { removing: true, message: null }); });
          return;
        }
        setLocal(function (previous) { return Object.assign({}, previous, { busy: 'remove' }); });
        apiCall('linked.remove', {
          id: link.id,
          removeWorkspace: local.removeWorkspace,
          deleteLocalState: local.deleteLocalState,
        }).then(function () {
          setLocal(function (previous) { return Object.assign({}, previous, { busy: '', removing: false }); });
          bus.emit();
        }).catch(function (error) {
          setLocal(function (previous) { return Object.assign({}, previous, { busy: '', message: { kind: 'error', text: messageOf(error, t, locale) } }); });
        });
      }

      return h('div', { className: 'rw-card', title: link.name + ' · ' + statusTitle(t, link) },
        h('div', { className: 'rw-card-head' },
          h('span', { className: 'rw-icon-chip rw-icon-chip-link' }, IconLinkedWorkspace(16)),
          h('div', { className: 'rw-fill', style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { className: 'rw-card-title' },
              h('span', { className: 'rw-name', title: link.name }, link.name),
              h('span', { className: 'rw-chip rw-chip-link' }, t('linkedBadge')),
              h(StatusPill, { status: link.status, t: t })),
            h('div', { className: 'rw-pair' },
              h('div', { className: 'rw-pair-item' },
                h('span', { className: 'rw-pair-label' }, t('pathLocalShort')),
                h('span', { className: 'rw-path', title: link.localPath }, link.localPath)),
              h('div', { className: 'rw-pair-item' },
                h('span', { className: 'rw-pair-label' }, t('pathRemoteShort') + ' · ' + link.username + '@' + link.host),
                h('span', { className: 'rw-path', title: link.remotePath }, link.remotePath)))),
          h('div', { className: 'rw-actions' },
            link.workspaceId
              ? h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: openWorkspace }, IconExternal(12), t('openWorkspace'))
              : h('button', {
                type: 'button', className: 'rw-btn rw-btn-sm',
                onClick: registerWorkspace,
                disabled: local.busy === 'register',
                title: t('workspaceMissing'),
              }, local.busy === 'register' ? Spinner(12) : IconPlus(12), t('workspaceRegister')),
            h('button', {
              type: 'button', className: 'rw-btn rw-btn-sm',
              onClick: sync, disabled: local.busy !== '' || !link.mirror, title: link.mirror ? t('sync') : t('mirrorHint'),
            }, local.busy === 'sync' ? Spinner(12) : IconSync(12), local.busy === 'sync' ? t('syncing') : t('sync')),
            local.busy === 'sync'
              ? h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-ghost', onClick: cancelSync }, t('syncCancel'))
              : null,
            h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-ghost', onClick: remove }, IconTrash(12), t('removeLinked')))),
        h('div', { className: 'rw-meta' },
          h('span', { className: 'rw-chip' }, link.mirror ? t('mirrorOn') : t('mirrorOff')),
          h(Switch, {
            checked: Boolean(link.mirror),
            onChange: toggleMirror,
            label: t('mirrorLabel'),
            text: t('mirrorLabel'),
          })),
        h('div', { className: 'rw-hint' }, t('mirrorHint')),
        local.removing
          ? h('div', { className: 'rw-warn-box' },
            h('div', null, t('removeWorkspaceHint')),
            h('div', { className: 'rw-inline', style: { marginTop: 6 } },
              h(Switch, {
                checked: local.removeWorkspace,
                onChange: function (next) { setLocal(function (previous) { return Object.assign({}, previous, { removeWorkspace: next }); }); },
                label: t('removeLinkedAndWorkspace'), text: t('removeLinkedAndWorkspace'),
              }),
              h(Switch, {
                checked: local.deleteLocalState,
                onChange: function (next) { setLocal(function (previous) { return Object.assign({}, previous, { deleteLocalState: next }); }); },
                label: t('removeLocalState'), text: t('removeLocalState'),
              })),
            h('div', { className: 'rw-actions', style: { marginTop: 8 } },
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: function () { setLocal(function (previous) { return Object.assign({}, previous, { removing: false }); }); } }, t('cancel')),
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-danger', onClick: remove, disabled: local.busy === 'remove' }, IconTrash(12), t('removeLinkedOnly'))))
          : null,
        local.message
          ? h(Banner, {
            kind: local.message.kind === 'success' ? 'success' : local.message.kind === 'error' ? 'error' : undefined,
            onClose: function () { setLocal(function (previous) { return Object.assign({}, previous, { message: null }); }); },
          }, local.message.text)
          : null);
    }

    function RemoteWorkspaceCard(props) {
      var workspace = props.workspace;
      var t = props.t;
      var ctx = props.ctx;
      var locale = props.locale;
      var refresh = props.refresh;
      var state = useState({ busy: '', message: null, removing: false, renaming: false, draft: workspace.name });
      var local = state[0];
      var setLocal = state[1];

      function openWorkspace() {
        if (!workspace.workspaceId) return;
        var uiWorkspace = null;
        try { uiWorkspace = ctx.get('uiWorkspace'); } catch (error) { uiWorkspace = null; }
        if (!uiWorkspace && ctx.root && typeof ctx.root.get === 'function') {
          try { uiWorkspace = ctx.root.get('uiWorkspace'); } catch (error) { uiWorkspace = null; }
        }
        if (uiWorkspace && typeof uiWorkspace.openWorkspace === 'function') {
          try {
            var navigation = uiWorkspace.openWorkspace(workspace.workspaceId);
            if (navigation && typeof navigation.catch === 'function') navigation.catch(function () { /* navigation aborted */ });
          } catch (error) { /* ignore */ }
        }
        dismissSettingsOverlay();
      }

      function openTree() {
        var sidebar = sidebarService(ctx);
        if (!sidebar || typeof sidebar.openTab !== 'function') return;
        sidebar.openTab({
          type: REMOTE_TREE_TAB_TYPE,
          id: REMOTE_TREE_TAB_TYPE,
          title: workspace.name,
          path: '/',
          meta: { remoteId: workspace.id },
        });
        dismissSettingsOverlay();
      }

      function startRename() {
        setLocal(function (previous) { return Object.assign({}, previous, { renaming: true, draft: workspace.name, message: null }); });
      }

      function submitRename() {
        var next = String(local.draft == null ? '' : local.draft).trim();
        if (next === '' || next === workspace.name) {
          setLocal(function (previous) { return Object.assign({}, previous, { renaming: false }); });
          return;
        }
        setLocal(function (previous) { return Object.assign({}, previous, { busy: 'rename', message: null }); });
        apiCall('remote_workspaces.update', { id: workspace.id, name: next }).then(function () {
          setLocal(function (previous) { return Object.assign({}, previous, { busy: '', renaming: false }); });
          refresh();
        }).catch(function (error) {
          setLocal(function (previous) {
            return Object.assign({}, previous, { busy: '', message: { kind: 'error', text: t('remoteUpdateFailed') + '：' + messageOf(error, t, locale) } });
          });
        });
      }

      function testConnection() {
        setLocal(function (previous) { return Object.assign({}, previous, { busy: 'test', message: null }); });
        apiCall('remote_workspaces.test', { id: workspace.id }).then(function (result) {
          var ok = result && result.ok;
          var text = ok
            ? t('testOk', { ms: result.latencyMs == null ? '' : result.latencyMs })
            : (t('testFailed') + '：' + (result && result.error ? result.error : t('testFailed')));
          setLocal(function (previous) { return Object.assign({}, previous, { busy: '', message: { kind: ok ? 'success' : 'error', text: text } }); });
        }).catch(function (error) {
          setLocal(function (previous) {
            return Object.assign({}, previous, { busy: '', message: { kind: 'error', text: t('testFailed') + '：' + messageOf(error, t, locale) } });
          });
        });
      }

      function remove() {
        if (!local.removing) {
          setLocal(function (previous) { return Object.assign({}, previous, { removing: true, message: null }); });
          return;
        }
        setLocal(function (previous) { return Object.assign({}, previous, { busy: 'remove' }); });
        apiCall('remote_workspaces.remove', { id: workspace.id }).then(function () {
          setLocal(function (previous) { return Object.assign({}, previous, { busy: '', removing: false, message: { kind: 'success', text: t('remoteRemoved') } }); });
          bus.emit();
          refresh();
        }).catch(function (error) {
          setLocal(function (previous) {
            return Object.assign({}, previous, { busy: '', message: { kind: 'error', text: t('remoteRemoveFailed') + '：' + messageOf(error, t, locale) } });
          });
        });
      }

      var hostLabel = (workspace.username ? workspace.username + '@' : '') + (workspace.host || workspace.hostName || '');

      return h('div', { className: 'rw-card', title: workspace.name + ' · ' + statusTitle(t, workspace) },
        h('div', { className: 'rw-card-head' },
          h('span', { className: 'rw-icon-chip' }, IconRemoteWorkspace(16)),
          h('div', { className: 'rw-fill', style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { className: 'rw-card-title' },
              local.renaming
                ? h('input', {
                  className: 'rw-input',
                  value: local.draft,
                  autoFocus: true,
                  onChange: function (event) { setLocal(function (previous) { return Object.assign({}, previous, { draft: event.target.value }); }); },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') { event.preventDefault(); submitRename(); }
                    if (event.key === 'Escape') { event.preventDefault(); setLocal(function (previous) { return Object.assign({}, previous, { renaming: false }); }); }
                  },
                })
                : h('span', { className: 'rw-name', title: workspace.name }, workspace.name),
              h('span', { className: 'rw-chip' }, t('remoteChip')),
              h(StatusPill, { status: workspace.status, t: t })),
            local.renaming
              ? null
              : h('div', { className: 'rw-pair' },
                h('div', { className: 'rw-pair-item' },
                  h('span', { className: 'rw-pair-label' }, t('pathRemoteShort') + (hostLabel ? ' · ' + hostLabel : '')),
                  h('span', { className: 'rw-path', title: workspace.remotePath }, workspace.remotePath)),
                h('div', { className: 'rw-pair-item' },
                  h('span', { className: 'rw-pair-label' }, t('remotePlaceholderLabel')),
                  h('span', { className: 'rw-path', title: workspace.placeholderPath }, workspace.placeholderPath)))),
          h('div', { className: 'rw-actions' },
            local.renaming
              ? h('span', null,
                h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-ghost', onClick: function () { setLocal(function (previous) { return Object.assign({}, previous, { renaming: false }); }); } }, t('cancel')),
                h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary', onClick: submitRename, disabled: local.busy === 'rename' }, local.busy === 'rename' ? Spinner(12) : null, t('save')))
              : h('span', null,
                workspace.workspaceId
                  ? h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: openWorkspace }, IconExternal(12), t('openWorkspace'))
                  : null,
                h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: openTree }, IconFolderTree(12), t('openTree')),
                h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-ghost', onClick: testConnection, disabled: local.busy !== '' }, local.busy === 'test' ? Spinner(12) : IconRefresh(12), t('testConnection')),
                h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-ghost', onClick: startRename, disabled: local.busy !== '' }, t('rename')),
                h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-ghost', onClick: remove, disabled: local.busy === 'remove' }, IconTrash(12), t('removeRemote'))))),
        h('div', { className: 'rw-hint' }, t('remoteSessionHint')),
        local.removing
          ? h('div', { className: 'rw-warn-box' },
            h('div', null, t('remoteRemoveHint')),
            h('div', { className: 'rw-actions', style: { marginTop: 8 } },
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: function () { setLocal(function (previous) { return Object.assign({}, previous, { removing: false }); }); } }, t('cancel')),
              h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-danger', onClick: remove, disabled: local.busy === 'remove' }, IconTrash(12), t('confirmRemove'))))
          : null,
        local.message
          ? h(Banner, {
            kind: local.message.kind === 'success' ? 'success' : local.message.kind === 'error' ? 'error' : undefined,
            onClose: function () { setLocal(function (previous) { return Object.assign({}, previous, { message: null }); }); },
          }, local.message.text)
          : null);
    }

    function ThemeGroup(props) {
      var t = props.t;
      var locale = props.locale;
      var settings = useRuntimeSettings();
      var state = useState({ saving: '', message: null });
      var local = state[0];
      var setLocal = state[1];
      var mode = settings.editorThemeMode || 'system';
      var effective = resolveEditorTheme(settings);

      function chooseMode(next) {
        if (mode === next || local.saving) return;
        setLocal({ saving: next, message: null });
        runtimeSettings.saveThemeMode(next).then(function () {
          setLocal({ saving: '', message: { kind: 'success', text: t('themeModeSaved') } });
          bus.emit();
        }).catch(function (error) {
          setLocal({ saving: '', message: { kind: 'error', text: messageOf(error, t, locale) } });
        });
      }

      function chooseFamily(familyId) {
        if (settings.editorThemeFamily === familyId || local.saving) return;
        setLocal({ saving: familyId, message: null });
        runtimeSettings.saveThemeFamily(familyId).then(function () {
          setLocal({ saving: '', message: { kind: 'success', text: t('themeSaved') } });
          bus.emit();
        }).catch(function (error) {
          setLocal({ saving: '', message: { kind: 'error', text: messageOf(error, t, locale) } });
        });
      }

      var modes = [
        { id: 'system', label: t('themeModeSystem'), desc: t('themeModeSystemDesc') },
        { id: 'light', label: t('themeModeLight'), desc: t('themeModeLightDesc') },
        { id: 'dark', label: t('themeModeDark'), desc: t('themeModeDarkDesc') },
      ];

      return h('div', { className: 'rw-group' },
        h('div', { className: 'rw-group-head' },
          h('span', { className: 'rw-group-title' }, t('themeModeTitle')),
          h('span', { className: 'rw-group-hint' }, t('themeModeHint'))),
        h('div', { className: 'rw-mode-grid' },
          modes.map(function (item) {
            var active = mode === item.id;
            return h('button', {
              key: item.id,
              type: 'button',
              className: 'rw-mode-card' + (active ? ' is-on' : ''),
              onClick: function () { chooseMode(item.id); },
              'aria-pressed': active,
            }, h('span', { className: 'rw-mode-name' }, item.label), h('span', { className: 'rw-mode-desc' }, item.desc));
          })),
        h('div', { className: 'rw-group-head', style: { marginTop: 12 } },
          h('span', { className: 'rw-group-title' }, t('themeSpecific')),
          h('span', { className: 'rw-group-hint' }, t('themeSpecificHint'))),
        h('div', { className: 'rw-theme-grid' },
          EDITOR_THEME_FAMILIES.map(function (family) {
            var active = (settings.editorThemeFamily || 'github') === family.id;
            var variant = getTheme(mode === 'dark' ? family.dark : mode === 'light' ? family.light : (settings.appThemeDark ? family.dark : family.light));
            return h('button', {
              key: family.id,
              type: 'button',
              className: 'rw-theme-card' + (active ? ' is-on' : ''),
              onClick: function () { chooseFamily(family.id); },
              'aria-pressed': active,
            },
              h(ThemeSwatch, { theme: variant }),
              h('span', { className: 'rw-theme-label' }, h('span', null, locale === 'zh' ? family.label.zh : family.label.en)));
          })),
        local.message
          ? h(Banner, {
            kind: local.message.kind === 'success' ? 'success' : 'error',
            onClose: function () { setLocal({ saving: '', message: null }); },
          }, local.message.text)
          : null);
    }

    function EditorSettingsGroup(props) {
      var t = props.t;
      var locale = props.locale;
      var settings = useRuntimeSettings();
      var state = useState({ saving: false, message: null });
      var local = state[0];
      var setLocal = state[1];
      var shortcuts = [
        ['Ctrl+S', t('shortcutSave')],
        ['Ctrl+W', t('shortcutClose')],
        ['Ctrl+Tab', t('shortcutSwitch')],
        ['Ctrl+B', t('shortcutDirectory')],
        ['Ctrl+Shift+F', t('shortcutSearch')],
      ];

      function toggleAutoSave(next) {
        if (local.saving) return;
        setLocal({ saving: true, message: null });
        runtimeSettings.saveAutoSave(next).then(function () {
          setLocal({ saving: false, message: { kind: 'success', text: t('autoSaveSaved') } });
          bus.emit();
        }).catch(function (error) {
          setLocal({ saving: false, message: { kind: 'error', text: messageOf(error, t, locale) } });
        });
      }

      return h('div', { className: 'rw-group' },
        h('div', { className: 'rw-group-head' },
          h('span', { className: 'rw-group-title' }, t('autoSaveTitle')),
          h('span', { className: 'rw-group-hint' }, t('autoSaveHint'))),
        h('div', { className: 'rw-setting-row' },
          h(Switch, {
            checked: Boolean(settings.autoSave),
            onChange: toggleAutoSave,
            label: t('autoSaveLabel'),
            text: t('autoSaveLabel'),
          }),
          local.saving ? Spinner(12) : null),
        h('div', { className: 'rw-group-head', style: { marginTop: 14 } },
          h('span', { className: 'rw-group-title' }, t('shortcutTitle')),
          h('span', { className: 'rw-group-hint' }, t('shortcutHint'))),
        h('div', { className: 'rw-shortcut-grid' },
          shortcuts.map(function (item) {
            return h('div', { key: item[0], className: 'rw-shortcut-row' },
              h('kbd', { className: 'rw-kbd' }, item[0]),
              h('span', null, item[1]));
          })),
        h('div', { className: 'rw-group-hint', style: { marginTop: 8 } }, t('shortcutWebNote')),
        local.message
          ? h(Banner, {
            kind: local.message.kind === 'success' ? 'success' : 'error',
            onClose: function () { setLocal({ saving: false, message: null }); },
          }, local.message.text)
          : null);
    }

    function ConnectionsPage(props) {
      var ctx = props.ctx;
      var locale = useLocale(ctx);
      var t = useMemo(function () { return makeT(locale); }, [locale]);
      var remote = useRemoteData(ctx);
      var addingState = useState('');
      var adding = addingState[0];
      var setAdding = addingState[1];
      var sidebarAvailable = Boolean(sidebarService(ctx));
      var links = remote.data.links || [];
      var remotes = remote.data.remotes || [];
      var hosts = remote.data.hosts || [];

      function openTree() {
        var sidebar = sidebarService(ctx);
        if (!sidebar || typeof sidebar.openTab !== 'function') return;
        sidebar.openTab({
          type: TREE_TAB_TYPE,
          id: TREE_TAB_TYPE,
          title: t('tabTitle'),
          path: '/',
          meta: {},
        });
        dismissSettingsOverlay();
      }

      function toggleAdding(mode) {
        setAdding(adding === mode ? '' : mode);
      }

      return h('div', { className: 'rw-root' },
        h('div', { className: 'rw-head-row' },
          h('div', { style: { minWidth: 0 } },
            h('h1', { className: 'rw-title' }, t('title')),
            h('p', { className: 'rw-sub' }, t('intro'))),
          h('div', { className: 'rw-actions' },
            h('button', {
              type: 'button', className: 'rw-btn' + (adding === 'linked' ? '' : ' rw-btn-primary'),
              onClick: function () { toggleAdding('linked'); },
            }, adding === 'linked' ? IconClose(13) : IconLinkedWorkspace(13), t('createLinked')),
            h('button', {
              type: 'button', className: 'rw-btn' + (adding === 'remote' ? '' : ' rw-btn-primary'),
              onClick: function () { toggleAdding('remote'); },
            }, adding === 'remote' ? IconClose(13) : IconRemoteWorkspace(13), t('createRemote')))),
        !sidebarAvailable ? h(Banner, { kind: 'warn' }, t('needsSidebar')) : null,
        h(ThemeGroup, { t: t, locale: locale }),
        h(EditorSettingsGroup, { t: t, locale: locale }),
        adding === 'linked'
          ? h(AddWorkspaceFlow, {
            ctx: ctx, t: t, locale: locale,
            onDone: function () { setAdding(''); remote.reload(); },
            onCancel: function () { setAdding(''); },
          })
          : null,
        adding === 'remote'
          ? h(AddRemoteWorkspaceFlow, {
            ctx: ctx, t: t, locale: locale,
            onDone: function () { setAdding(''); remote.reload(); },
            onCancel: function () { setAdding(''); },
          })
          : null,
        remote.data.error ? h(Banner, { kind: 'error' }, t('remoteWorkspacesFailed') + '：' + messageOf(remote.data.error, t, locale)) : null,
        remote.data.hostError ? h(Banner, { kind: 'error' }, t('hostsFailed') + '：' + messageOf(remote.data.hostError, t, locale)) : null,
        remote.data.linkError ? h(Banner, { kind: 'error' }, t('linksFailed') + '：' + messageOf(remote.data.linkError, t, locale)) : null,
        h('div', { className: 'rw-group' },
          h('div', { className: 'rw-group-head' },
            h('span', { className: 'rw-group-title' }, t('linkedTitle')),
            h('span', { className: 'rw-chip rw-chip-link' }, String(links.length)),
            h('span', { className: 'rw-group-hint' }, t('linkedHint'))),
          links.length === 0
            ? h('div', { className: 'rw-hint' }, t('linkedEmpty'))
            : h('div', { className: 'rw-list' },
              links.map(function (link) {
                return h(LinkedWorkspaceCard, {
                  key: link.id,
                  link: link,
                  t: t,
                  ctx: ctx,
                  locale: locale,
                  refresh: remote.reload,
                });
              }))),
        h('div', { className: 'rw-group' },
          h('div', { className: 'rw-group-head' },
            h('span', { className: 'rw-group-title' }, t('remoteGroup')),
            h('span', { className: 'rw-chip' }, String(remotes.length)),
            h('span', { className: 'rw-group-hint' }, t('remoteHint'))),
          remotes.length === 0
            ? h('div', { className: 'rw-hint' }, t('remoteEmpty'))
            : h('div', { className: 'rw-list' },
              remotes.map(function (workspace) {
                return h(RemoteWorkspaceCard, {
                  key: workspace.id,
                  workspace: workspace,
                  t: t,
                  ctx: ctx,
                  locale: locale,
                  refresh: remote.reload,
                });
              }))),
        h('div', { className: 'rw-inline', style: { justifyContent: 'flex-end' } },
          h('button', { type: 'button', className: 'rw-btn rw-btn-ghost rw-btn-sm', onClick: remote.reload }, IconRefresh(12), t('refresh'))));
    }

    // ── apply ──────────────────────────────────────────────────────────────

    // `sessions` is a core client service (the sidebar shell injects it too):
    // the directory entries need the focused session's cwd/workspaceId to
    // decide whether they belong in the "+" menu.
    var inject = ['slots', 'locale', 'sessions'];

    function apply(ctx) {
      ctx.effect(installStyles, 'dsh-linked-workspace: styles');
      ctx.effect(function () {
        var lastDark = null;
        var sync = function () {
          try {
            var service = ctx.get('theme');
            if (!service || typeof service.getTheme !== 'function') return;
            var snapshot = service.getTheme();
            var dark = Boolean(snapshot && snapshot.active && snapshot.active.colorScheme === 'dark');
            if (lastDark === dark) return;
            lastDark = dark;
            runtimeSettings.apply({ appThemeDark: dark });
          } catch (error) { /* theme service unavailable */ }
        };
        sync();
        var timer = setInterval(sync, 1500);
        if (timer && typeof timer.unref === 'function') timer.unref();
        return function () { clearInterval(timer); };
      }, 'dsh-linked-workspace: app theme sync');
      ctx.effect(function () {
        if (syncDirectoryTabsRef) syncDirectoryTabsRef();
        else refreshDirectoryAvailability().catch(function () { /* ignore */ });
        var timer = setInterval(function () {
          if (syncDirectoryTabsRef) syncDirectoryTabsRef();
          else refreshDirectoryAvailability().catch(function () { /* ignore */ });
        }, 5000);
        if (timer && typeof timer.unref === 'function') timer.unref();
        return function () { clearInterval(timer); };
      }, 'dsh-linked-workspace: running icon poll');
      ctx.effect(function () {
        return function () {
          var tag = document.querySelector('style[data-plugin-css="dsh-linked-workspace/workspace-icons"]');
          if (tag) tag.remove();
        };
      }, 'dsh-linked-workspace: workspace row icons');

      // The settings list draws a default glyph unless a plugin claims the icon
      // seat; the id has to match the section id above.
      try {
        ctx.slots.inject('settings.section.icon', function () {
          return ctx.slots.register({
            name: 'settings.section.icon',
            id: 'linked-workspaces',
            order: 52,
            label: function () { return makeT(readLocale(ctx))('settingsNav'); },
          }, function (props) {
            return IconSettingsNav(props && props.size ? props.size : 16);
          });
        });
      } catch (error) {
        console.error('[dsh-linked-workspace] settings icon registration failed', error && error.message ? error.message : error);
      }

      // First-run welcome card: shell.overlay is the frame-wide floating layer,
      // so the card lands above every column without touching any panel.
      try {
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'linked-workspace-welcome',
            order: 80,
            label: function () { return makeT(readLocale(ctx))('welcomeTitle'); },
          }, function (props) {
            return h(WelcomeCard, Object.assign({}, props, { ctx: ctx }));
          });
        });
      } catch (error) {
        console.error('[dsh-linked-workspace] welcome card registration failed', error && error.message ? error.message : error);
      }

      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'linked-workspaces',
            order: 52,
            label: function () { return makeT(readLocale(ctx))('settingsNav'); },
          }, function (props) {
            return h(ConnectionsPage, Object.assign({}, props, { ctx: ctx }));
          });
        });
      } catch (error) {
        console.error('[dsh-linked-workspace] settings section registration failed', error && error.message ? error.message : error);
      }

      // The sidebar's "+" opens the directory-flow hole; shadowing the shipped
      // browser (lowest priority wins) lets that one button offer BOTH a plain
      // local folder and a local ⇄ remote linked workspace.
      FLOW_SLOTS.forEach(function (slotName) {
        try {
          ctx.slots.inject(slotName, function () {
            return ctx.slots.register({
              name: slotName,
              priority: -2,
            }, function (props) {
              var locale = useLocale(ctx);
              var t = useMemo(function () { return makeT(locale); }, [locale]);
              return h(WorkspaceDirectoryFlow, Object.assign({}, props, { ctx: ctx, t: t, locale: locale }));
            });
          });
        } catch (error) {
          console.error('[dsh-linked-workspace] directory flow registration failed for ' + slotName, error && error.message ? error.message : error);
        }
      });

      var sidebarRegistered = false;
      var tabDisposers = [];
      var tabPollTimer = null;

      function registerSidebarTabs() {
        if (sidebarRegistered) return;
        var sidebar = sidebarService(ctx);
        if (!sidebar || typeof sidebar.registerTab !== 'function') return;
        sidebarRegistered = true;
        if (tabPollTimer !== null) {
          clearInterval(tabPollTimer);
          tabPollTimer = null;
        }
        var syncDirectoryTabsInFlight = false;

        // The "+" menu filters on `descriptor.hidden` and only maps `available`
        // to a disabled flag, so a per-session entry has to be hidden rather
        // than marked unavailable. These two helpers resolve the session on
        // screen right when the menu asks, which keeps the entries in sync with
        // the workspace kind without unregistering anything (an unregistered
        // kind would orphan its open pages and break "Open directory tree").
        var activeScopeCache = { cwd: '', workspaceId: '' };

        function readActiveScope() {
          var info = { cwd: '', workspaceId: '' };
          try {
            var snapshot = typeof sidebar.getSnapshot === 'function' ? sidebar.getSnapshot() : null;
            var sessionId = snapshot && snapshot.sessionId;
            if (!sessionId) return info;
            var sessions = ctx.sessions || (ctx.get && ctx.get('sessions'));
            var list = sessions && sessions.list ? sessions.list : sessions;
            var sessionState = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null;
            var record = sessionState && sessionState.byId ? sessionState.byId[sessionId] : null;
            if (record) {
              info.cwd = record.cwd || '';
              info.workspaceId = record.workspaceId || '';
            }
          } catch (error) { /* fall back to an empty scope */ }
          return info;
        }

        function activeScope() {
          activeScopeCache = readActiveScope();
          return activeScopeCache;
        }

        function linkedTabHidden() {
          var scope = activeScope();
          return !(isLinkedScope(scope) || isLinkedWorkspaceId(scope.workspaceId));
        }

        function remoteTabHidden() {
          var scope = activeScope();
          return !(isRemoteScope(scope) || isRemoteWorkspaceId(scope.workspaceId));
        }

        // `hidden` is read whenever the sidebar builds its "+" entries, so the
        // answer is always fresh — but the sidebar only rebuilds those entries
        // when something notifies it. Re-registering the same two descriptors
        // notifies without touching the stored tabs, so open pages survive.
        var visibilitySignature = '';

        function currentVisibilitySignature() {
          return (linkedTabHidden() ? '0' : '1') + (remoteTabHidden() ? '0' : '1');
        }

        function syncTabVisibility() {
          var next = currentVisibilitySignature();
          if (next === visibilitySignature) return;
          visibilitySignature = next;
          if (linkedTabDisposer === null && remoteTabDisposer === null) return;
          disposeLinkedTab();
          disposeRemoteTab();
          installLinkedTab(false);
          installRemoteTab(false);
        }

        function watchSessionScope() {
          visibilitySignature = currentVisibilitySignature();
          try {
            var sessions = ctx.sessions || (ctx.get && ctx.get('sessions'));
            var list = sessions && (sessions.list || sessions);
            if (!list || typeof list.subscribe !== 'function') return;
            var unsubscribe = list.subscribe(function () { syncTabVisibility(); });
            if (typeof unsubscribe === 'function') tabDisposers.push(unsubscribe);
          } catch (error) { /* without a store the entries simply stay as they are */ }
        }

        function installLinkedTab(track) {
          if (linkedTabDisposer !== null) return;
          linkedTabDisposer = sidebar.registerTab({
            id: TREE_TAB_TYPE,
            title: function () { return makeT(readLocale(ctx))('tabTitle'); },
            description: function () { return makeT(readLocale(ctx))('tabDesc'); },
            icon: function (size) { return IconLinkedWorkspace(size); },
            order: 62,
            single: true,
            get hidden() { return linkedTabHidden(); },
            available: function () { return true; },
            component: function (props) {
              var currentLocale = useLocale(ctx);
              var t = useMemo(function () { return makeT(currentLocale); }, [currentLocale]);
              return h(RemoteDirectoryTab, Object.assign({}, props, { ctx: ctx, t: t, locale: currentLocale, variant: 'linked' }));
            },
          });
          if (track !== false) tabDisposers.push(function () { disposeLinkedTab(); });
        }

        function disposeLinkedTab() {
          if (linkedTabDisposer === null) return;
          try { linkedTabDisposer(); } catch (error) { /* ignore */ }
          linkedTabDisposer = null;
        }

        function installRemoteTab(track) {
          if (remoteTabDisposer !== null) return;
          remoteTabDisposer = sidebar.registerTab({
            id: REMOTE_TREE_TAB_TYPE,
            title: function () { return makeT(readLocale(ctx))('remoteTabTitle'); },
            description: function () { return makeT(readLocale(ctx))('remoteTabDesc'); },
            icon: function (size) { return IconRemoteWorkspace(size); },
            order: 61,
            single: true,
            get hidden() { return remoteTabHidden(); },
            available: function () { return true; },
            component: function (props) {
              var currentLocale = useLocale(ctx);
              var t = useMemo(function () { return makeT(currentLocale); }, [currentLocale]);
              return h(RemoteDirectoryTab, Object.assign({}, props, { ctx: ctx, t: t, locale: currentLocale, variant: 'remote' }));
            },
          });
          if (track !== false) tabDisposers.push(function () { disposeRemoteTab(); });
        }

        function disposeRemoteTab() {
          if (remoteTabDisposer === null) return;
          try { remoteTabDisposer(); } catch (error) { /* ignore */ }
          remoteTabDisposer = null;
        }

        // Both page kinds stay registered for the whole session: `available`
        // only greys out the "+" entry for a mismatched session, while
        // `openTab` refuses a kind it has never seen. Registering lazily per
        // session meant "open the tree" from the settings page silently did
        // nothing whenever the workspace was not the one on screen.
        function syncDirectoryTabs() {
          if (syncDirectoryTabsInFlight) return;
          syncDirectoryTabsInFlight = true;
          refreshDirectoryAvailability().catch(function () { /* ignore */ }).then(function () {
            syncDirectoryTabsInFlight = false;
          });
        }

        syncDirectoryTabsRef = syncDirectoryTabs;
        refreshTabVisibilityRef = syncTabVisibility;
        installLinkedTab();
        installRemoteTab();
        watchSessionScope();
        syncTabVisibility();
        try {
          tabDisposers.push(sidebar.subscribeState(function () { syncDirectoryTabs(); }));
        } catch (error) { /* state subscription is optional */ }
        syncDirectoryTabs();
        try {
          tabDisposers.push(sidebar.registerTab({
            id: FILE_TAB_TYPE,
            title: function () { return makeT(readLocale(ctx))('fileTabTitle'); },
            hidden: true,
            order: 63,
            dedupeKey: function (tab) { return tab.id; },
            component: function (props) {
              var currentLocale = useLocale(ctx);
              var t = useMemo(function () { return makeT(currentLocale); }, [currentLocale]);
              return h(RemoteFileTab, Object.assign({}, props, { ctx: ctx, t: t, locale: currentLocale }));
            },
          }));
        } catch (error) {
          console.error('[dsh-linked-workspace] file tab registration failed', error && error.message ? error.message : error);
        }

        // One hidden page kind per file slot: the native sidebar dedupes page
        // tabs by kind, so distinct kinds are what keep several files open at once.
        for (let slot = 1; slot <= FILE_SLOT_COUNT; slot += 1) {
          const slotKind = FILE_SLOT_PREFIX + slot;
          try {
            tabDisposers.push(sidebar.registerTab({
              id: slotKind,
              title: function () { return makeT(readLocale(ctx))('fileTabTitle'); },
              hidden: true,
              order: 63 + slot,
              dedupeKey: function (tab) { return tab.id; },
              onClose: function (tab) { releaseRemoteFileSlot(tab && tab.type ? tab.type : slotKind); },
              component: function (props) {
                var currentLocale = useLocale(ctx);
                var t = useMemo(function () { return makeT(currentLocale); }, [currentLocale]);
                return h(RemoteFileTab, Object.assign({}, props, { ctx: ctx, t: t, locale: currentLocale }));
              },
            }));
          } catch (error) {
            console.error('[dsh-linked-workspace] file slot registration failed', error && error.message ? error.message : error);
          }
        }

        // Tabs persisted before the 0.3.0 rename still carry the old file type
        // id; register a hidden alias so a reloaded page restores it instead of
        // showing "no available view" for the legacy tab. The legacy tree kind
        // ("dsh-remote-workspace") is now the real remote-workspace tab.
        try {
          tabDisposers.push(sidebar.registerTab({
            id: 'dsh-remote-workspace:file',
            title: function () { return makeT(readLocale(ctx))('fileTabTitle'); },
            hidden: true,
            order: 64,
            dedupeKey: function (tab) { return tab.id; },
            component: function (props) {
              var currentLocale = useLocale(ctx);
              var t = useMemo(function () { return makeT(currentLocale); }, [currentLocale]);
              return h(RemoteFileTab, Object.assign({}, props, { ctx: ctx, t: t, locale: currentLocale }));
            },
          }));
        } catch (error) {
          console.error('[dsh-linked-workspace] legacy tab alias registration failed', error && error.message ? error.message : error);
        }
      }

      ctx.effect(function () {
        registerSidebarTabs();
        if (!sidebarRegistered) {
          tabPollTimer = setInterval(registerSidebarTabs, 400);
          if (tabPollTimer && typeof tabPollTimer.unref === 'function') tabPollTimer.unref();
        }
        return function () {
          if (tabPollTimer !== null) {
            clearInterval(tabPollTimer);
            tabPollTimer = null;
          }
          for (var index = 0; index < tabDisposers.length; index += 1) {
            try {
              tabDisposers[index]();
            } catch (error) {
              /* ignore */
            }
          }
          tabDisposers = [];
        };
      }, 'dsh-linked-workspace: sidebar tabs');

      if (!sidebarRegistered) {
        console.warn('[dsh-linked-workspace] dsh-better-sidebar is not available yet; waiting for it in the background');
      }
    }

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  },
});
