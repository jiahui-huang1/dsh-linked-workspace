import test from 'node:test'
import assert from 'node:assert/strict'
import { newEntryMenuItems, newEntryRequest } from '../src/parts/file-creation.js'

for (const side of ['local', 'remote']) {
  test(`new-entry menu: ${side} offers clickable folder/file actions without a flyout`, () => {
    const menu = { side, path: side === 'local' ? 'C:\\项目\\子目录' : '/workspace/子目录' }
    const dialogs = []
    const items = newEntryMenuItems(menu, (key) => key, (dialog) => dialogs.push(dialog))
    assert.deepEqual(items.map((item) => item.label), ['ctxNewFolder', 'ctxNewFile'])
    for (const item of items) {
      assert.equal(item.sub, undefined, 'creation must remain inside the scrollable menu')
      item.onSelect()
    }
    assert.deepEqual(dialogs.map(({ kind, side, dir, isDir }) => ({ kind, side, dir, isDir })), [
      { kind: 'new', side, dir: menu.path, isDir: true },
      { kind: 'new', side, dir: menu.path, isDir: false },
    ])
  })

  test(`new-entry request: ${side} distinguishes preview files from document templates`, () => {
    const parent = side === 'local' ? 'C:\\项目\\子目录' : '/workspace/子目录'
    for (const name of ['普通文件', '.gitignore', 'a.txt', '数据.csv', 'data.tsv', 'index.html', 'index.htm', '图.svg', '图.png', 'PHOTO.JPG']) {
      const request = newEntryRequest(side, parent, name, false, { linkedId: 'link-1' })
      assert.equal(request.method, side === 'local' ? 'local.newFile' : 'fs.write', name)
      assert.equal(request.kind, '', name)
      if (side === 'local') assert.deepEqual(request.params, { path: `${parent}\\${name}` })
      else assert.deepEqual(request.params, { linkedId: 'link-1', path: `${parent}/${name}`, content: '', createOnly: true })
    }
    for (const [name, kind] of [['note.MD', 'markdown'], ['note.markdown', 'markdown'], ['a.pdf', 'pdf'], ['a.docx', 'docx'], ['a.xlsx', 'xlsx'], ['a.pptx', 'pptx']]) {
      const request = newEntryRequest(side, parent, name, false, { linkedId: 'link-1' })
      assert.equal(request.method, 'docs.create', name)
      assert.equal(request.params.kind, kind, name)
      assert.equal(request.params.linkedId, side === 'remote' ? 'link-1' : undefined)
    }
  })
}

test('new-entry request: folder names with document extensions still create directories', () => {
  assert.deepEqual(newEntryRequest('local', 'C:\\项目', 'report.pdf', true).params, { path: 'C:\\项目', name: 'report.pdf' })
  const remote = newEntryRequest('remote', '/workspace', 'report.docx', true, { workspaceId: 'workspace-1' })
  assert.equal(remote.method, 'fs.mkdir')
  assert.deepEqual(remote.params, { workspaceId: 'workspace-1', path: '/workspace/report.docx', createOnly: true })
})

test('new-entry request: root, trailing separators, spaces and Unicode preserve the chosen parent', () => {
  for (const [side, parent, expected] of [
    ['remote', '/', '/中文 name.txt'],
    ['remote', '/workspace/', '/workspace/中文 name.txt'],
    ['local', 'C:\\', 'C:\\中文 name.txt'],
    ['local', 'C:/workspace/', 'C:/workspace/中文 name.txt'],
    ['local', '/home/user', '/home/user/中文 name.txt'],
    ['local', '\\\\server\\share', '\\\\server\\share\\中文 name.txt'],
  ]) {
    assert.equal(newEntryRequest(side, parent, '  中文 name.txt  ', false).path, expected)
  }
})

test('new-entry request: rejects path traversal and empty names before any API call', () => {
  for (const name of ['', '  ', '.', '..', '../escape', '/escape', 'a/b', 'a\\b', 'bad\0name']) {
    assert.throws(() => newEntryRequest('remote', '/workspace', name, false), { code: 'BAD_REQUEST' }, name)
  }
})
