// Shared by the directory menu, its submit handler and API regression tests.
// Preview formats (CSV/HTML/images) are regular files; only document templates
// are sent to docs.create.
export function newEntryMenuItems(menu, t, onNew) {
  return [true, false].map(function (isDir) {
    var title = t(isDir ? 'newFolderTitle' : 'newFileTitle');
    return {
      label: t(isDir ? 'ctxNewFolder' : 'ctxNewFile'),
      onSelect: function () {
        onNew({ kind: 'new', side: menu.side, dir: menu.path, isDir: isDir,
          title: title, label: t('nameLabel'), value: title });
      },
    };
  });
}

export function newEntryRequest(side, dirPath, name, isDir, scope) {
  var child = String(name || '').trim();
  if (!child || child === '.' || child === '..' || /[/\\\0]/.test(child)) {
    var error = new Error('文件或文件夹名称无效 / Invalid file or folder name');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  var parent = String(dirPath || '');
  var separator = side === 'remote' || parent.indexOf('\\') < 0 ? '/' : '\\';
  var target = parent + (/[\\/]$/.test(parent) ? '' : separator) + child;
  var match = child.toLowerCase().match(/\.[^./\\]+$/);
  var extension = match ? match[0] : '';
  var kinds = { '.md': 'markdown', '.markdown': 'markdown', '.pdf': 'pdf',
    '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx' };
  var kind = isDir ? '' : (kinds[extension] || '');
  var method;
  var params;
  if (isDir) {
    method = side === 'remote' ? 'fs.mkdir' : 'local.mkdir';
    params = side === 'remote' ? { path: target, createOnly: true } : { path: parent, name: child };
  } else if (kind) {
    method = 'docs.create';
    params = { path: target, kind: kind };
  } else {
    method = side === 'remote' ? 'fs.write' : 'local.newFile';
    params = side === 'remote' ? { path: target, content: '', createOnly: true } : { path: target };
  }
  if (side === 'remote') params = Object.assign({}, scope, params);
  return { method: method, params: params, path: target, kind: kind };
}
