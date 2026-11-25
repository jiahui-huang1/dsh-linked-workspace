import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = 'scripts/md-to-html.mjs';
const dir = mkdtempSync(join(tmpdir(), 'rw-md-'));

function render(markdown) {
  const file = join(dir, `${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, markdown, 'utf8');
  const raw = execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw).html;
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('md preview: the KaTeX stylesheet travels with the fragment', () => {
  const html = render('# hi\n\n$$\na^2+b^2=c^2\n$$\n');
  // Inline stylesheet, served fonts — no CDN, no external <link>.
  assert.match(html, /<style data-rw-katex="1">/);
  assert.match(html, /\.katex/);
  assert.match(html, /url\(\/dsh-linked-workspace\/assets\/katex\/fonts\//);
  assert.doesNotMatch(html, /cdn\.jsdelivr/);
  assert.doesNotMatch(html, /<link\b/i);
  // A fragment, not a document: it is injected into the host page as innerHTML.
  assert.doesNotMatch(html, /<!doctype|<html|<body/i);
});

test('md preview: an equation number stays beside the formula', () => {
  const html = render('$$\na^2+b^2=c^2\\tag{1.1}\n$$\n');
  assert.match(html, /class="tag"/);
  // KaTeX pins the number with `position:absolute; right:0`, which parks it on
  // top of any formula that fills the column. The preview lays it out in flow.
  assert.match(html, /\.katex-html>\.tag\{position:static/);
  assert.match(html, /:has\(>\.katex-html>\.tag\)/);
});

test('md preview: a broken formula degrades to one red span', () => {
  const html = render('# broken\n\n$\\frac{a$\n\nstill here\n');
  assert.match(html, /katex-error/);
  assert.match(html, /still here/);
});

test('md preview: GFM tables and inline math share one fragment', () => {
  const html = render('| a | b |\n| - | - |\n| 1 | 2 |\n\ninline $x^2$ done\n');
  assert.match(html, /<table>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /math-inline/);
});

test('md preview: the host renders in-process instead of spawning node', () => {
  // A DSH process may not have `node` on its PATH; shelling out silently
  // degraded every formula to raw `$$…$$`. Rendering must stay in-process.
  const host = readFileSync('lib/index.js', 'utf8');
  assert.match(host, /from '\.\/markdown\.js'/);
  assert.match(host, /renderMarkdownFragment\(/);
  assert.doesNotMatch(host, /runDocTool\(\['md-preview'/);
});
