/*
 * Asset tests for the browser-bundle parts: editor themes, syntax tokenizer and
 * file-tree icons. Run with: node --test test/parts.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_THEME_ID, EDITOR_THEMES, getTheme } from '../src/parts/themes.js'
import { languageOf, tokenize } from '../src/parts/highlight.js'
import { fileIconSpec } from '../src/parts/file-icons.js'
import { normalizeUrlValue, urlAttributeViolation, urlSchemeOf } from '../src/parts/url-safety.js'

// ═══════════════════════════════════════════════════════════════════════════
// themes.js
// ═══════════════════════════════════════════════════════════════════════════

const HEX_COLOR = /^#[0-9a-f]{6}$/i

const THEME_COLOR_KEYS = [
  'bg',
  'fg',
  'gutterBg',
  'gutterFg',
  'border',
  'selection',
  'lineHighlight',
  'caret',
  'keyword',
  'string',
  'comment',
  'number',
  'functionName',
  'typeName',
  'operator',
  'punctuation',
  'plain'
]

const REQUIRED_THEME_IDS = [
  'github-dark',
  'github-light',
  'one-dark',
  'dracula',
  'monokai',
  'nord',
  'solarized-dark',
  'solarized-light',
  'vs-dark',
  'xcode-light'
]

function relativeLuminance(hex) {
  assert.match(hex, HEX_COLOR)
  const value = parseInt(hex.slice(1), 16)
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

test('themes: ids are unique, default exists, all ten required themes present', () => {
  assert.ok(Array.isArray(EDITOR_THEMES))
  assert.ok(EDITOR_THEMES.length >= 10)
  assert.equal(DEFAULT_THEME_ID, 'github-light')

  const ids = EDITOR_THEMES.map((theme) => theme.id)
  assert.equal(new Set(ids).size, ids.length, 'theme ids must be unique')
  assert.ok(ids.includes(DEFAULT_THEME_ID), 'default theme must exist in EDITOR_THEMES')

  for (const id of REQUIRED_THEME_IDS) {
    assert.ok(ids.includes(id), `missing theme ${id}`)
  }
})

test('themes: every palette is complete and uses #rrggbb colours', () => {
  for (const theme of EDITOR_THEMES) {
    assert.equal(typeof theme.id, 'string')
    assert.ok(theme.id.length > 0)
    assert.ok(theme.kind === 'dark' || theme.kind === 'light', `${theme.id}: bad kind`)
    assert.equal(typeof theme.label, 'object')
    assert.ok(typeof theme.label.zh === 'string' && theme.label.zh.length > 0, `${theme.id}: missing zh label`)
    assert.ok(typeof theme.label.en === 'string' && theme.label.en.length > 0, `${theme.id}: missing en label`)

    assert.equal(typeof theme.colors, 'object')
    for (const key of THEME_COLOR_KEYS) {
      const color = theme.colors[key]
      assert.equal(typeof color, 'string', `${theme.id}.colors.${key} must be a string`)
      assert.match(color, HEX_COLOR, `${theme.id}.colors.${key} = ${String(color)}`)
    }
  }
})

test('themes: dark themes are dark and light themes are readable', () => {
  const kinds = new Set(EDITOR_THEMES.map((theme) => theme.kind))
  assert.ok(kinds.has('dark') && kinds.has('light'))

  for (const theme of EDITOR_THEMES) {
    const { bg, fg } = theme.colors
    const bgLum = relativeLuminance(bg)
    const fgLum = relativeLuminance(fg)
    if (theme.kind === 'dark') {
      assert.ok(bgLum < fgLum, `${theme.id}: dark theme must have darker bg than fg`)
    } else {
      assert.ok(bgLum > fgLum, `${theme.id}: light theme must have lighter bg than fg`)
    }
    assert.ok(contrastRatio(bg, fg) >= 3, `${theme.id}: fg/bg contrast too low`)
  }
})

test('themes: getTheme returns the match or the default fallback', () => {
  const defaultTheme = EDITOR_THEMES.find((theme) => theme.id === DEFAULT_THEME_ID)
  assert.ok(defaultTheme)

  assert.equal(getTheme('github-light'), defaultTheme)
  assert.equal(getTheme('github-dark').id, 'github-dark')
  assert.equal(getTheme('one-dark').id, 'one-dark')
  assert.equal(getTheme(' Github-Light ').id, 'github-light')
  assert.equal(getTheme('nope'), defaultTheme)
  assert.equal(getTheme(''), defaultTheme)
  assert.equal(getTheme(undefined), defaultTheme)
  assert.equal(getTheme(null), defaultTheme)
  assert.equal(getTheme(42), defaultTheme)
})

// ═══════════════════════════════════════════════════════════════════════════
// highlight.js
// ═══════════════════════════════════════════════════════════════════════════

const TOKEN_TYPES = new Set([
  'comment',
  'string',
  'number',
  'keyword',
  'literal',
  'functionName',
  'typeName',
  'operator',
  'punctuation'
])

const ALL_LANGUAGES = [
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'json',
  'md',
  'sh',
  'yaml',
  'toml',
  'c',
  'cpp',
  'cs',
  'rs',
  'go',
  'java',
  'kt',
  'html',
  'css',
  'scss',
  'sql',
  'ini',
  'txt'
]

function assertTokens(source, language, tokens) {
  assert.ok(Array.isArray(tokens), `${language}: tokenize must return an array`)
  let previousEnd = -1
  for (const token of tokens) {
    assert.ok(token && typeof token === 'object', `${language}: token must be an object`)
    assert.ok(Number.isInteger(token.start), `${language}: token.start must be an integer`)
    assert.ok(Number.isInteger(token.end), `${language}: token.end must be an integer`)
    assert.ok(token.start >= 0, `${language}: token.start out of bounds`)
    assert.ok(token.end <= source.length, `${language}: token.end out of bounds`)
    assert.ok(token.end > token.start, `${language}: empty token ${JSON.stringify(token)}`)
    assert.ok(token.start >= previousEnd, `${language}: tokens overlap or are unsorted at ${JSON.stringify(token)}`)
    assert.ok(TOKEN_TYPES.has(token.type), `${language}: unexpected token type ${token.type}`)
    previousEnd = token.end
  }
  return tokens
}

function typesOf(tokens) {
  return new Set(tokens.map((token) => token.type))
}

test('highlight: languageOf maps representative paths', () => {
  const cases = [
    ['src/app.js', 'js'],
    ['module.mjs', 'js'],
    ['legacy.cjs', 'js'],
    ['index.ts', 'ts'],
    ['component.tsx', 'tsx'],
    ['widget.jsx', 'jsx'],
    ['script.py', 'py'],
    ['notebook.ipynb', 'json'],
    ['data.json', 'json'],
    ['README.md', 'md'],
    ['notes.mdx', 'md'],
    ['notes.txt', 'txt'],
    ['config.yml', 'yaml'],
    ['config.yaml', 'yaml'],
    ['Cargo.toml', 'toml'],
    ['run.sh', 'sh'],
    ['run.ps1', 'sh'],
    ['main.c', 'c'],
    ['main.h', 'c'],
    ['main.cpp', 'cpp'],
    ['main.hpp', 'cpp'],
    ['Program.cs', 'cs'],
    ['lib.rs', 'rs'],
    ['main.go', 'go'],
    ['Main.java', 'java'],
    ['Main.kt', 'kt'],
    ['index.html', 'html'],
    ['style.css', 'css'],
    ['style.scss', 'scss'],
    ['query.sql', 'sql'],
    ['.env', 'ini'],
    ['Dockerfile', 'sh'],
    ['docker-compose.yml', 'yaml'],
    ['Makefile', 'sh'],
    ['CMakeLists.txt', 'sh'],
    ['unknown.xyz', 'txt'],
    ['README', 'txt'],
    ['LICENSE', 'txt'],
    ['no-extension', 'txt'],
    ['C:\\proj\\src\\index.ts', 'ts'],
    ['/tmp/build/app.pyi', 'py']
  ]
  for (const [filePath, expected] of cases) {
    assert.equal(languageOf(filePath), expected, `languageOf(${JSON.stringify(filePath)})`)
  }

  assert.equal(languageOf('APP.JS'), 'js', 'extension matching must be case-insensitive')
  assert.equal(languageOf('DOCKERFILE'), 'sh', 'special names must be case-insensitive')
  assert.equal(languageOf('ReadMe.MD'), 'md')
})

test('highlight: languageOf is safe for non-string and empty input', () => {
  for (const value of [undefined, null, 0, 42, true, {}, [], Symbol('x')]) {
    assert.equal(languageOf(value), 'txt')
  }
  assert.equal(languageOf(''), 'txt')
  assert.equal(languageOf('/'), 'txt')
})

const SAMPLES = [
  {
    lang: 'js',
    code: [
      '// comment',
      'const answer = "forty-two" + 42',
      'function greet(name) { return `hi ${name}` }',
      'class Widget extends Base {}'
    ].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'functionName', 'typeName']
  },
  {
    lang: 'ts',
    code: [
      '// comment',
      'type User = { id: number }',
      'const label: string = "ts"',
      'const num = 42',
      'export interface Thing { run(): void }',
      'function make(value: number): string { return "done" }'
    ].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'functionName', 'typeName']
  },
  {
    lang: 'jsx',
    code: [
      '// comment',
      'const el = <div className="box">{value}</div>',
      'const num = 42',
      'function Widget() { return <span title="x">ok</span> }'
    ].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'functionName']
  },
  {
    lang: 'tsx',
    code: [
      '// comment',
      'interface Props { id: number }',
      'const label: string = "tsx"',
      'const num = 42',
      'function Widget(props: Props) { return <div title="x">{props.id}</div> }'
    ].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'functionName', 'typeName']
  },
  {
    lang: 'py',
    code: [
      '# comment',
      'def greet(name):',
      '    """doc string"""',
      '    count = 42',
      '    return f"hi {name}"'
    ].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'functionName']
  },
  {
    lang: 'json',
    code: '{"name": "demo", "count": 12, "active": true, "missing": null}',
    expected: ['string', 'number', 'literal']
  },
  {
    lang: 'md',
    code: [
      '# Title',
      '',
      'Intro `inline` text.',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      '> note'
    ].join('\n'),
    expected: ['typeName', 'string', 'comment']
  },
  {
    lang: 'sh',
    code: [
      '#!/usr/bin/env bash',
      '# deploy',
      'set -e',
      'if [ -f "$CONF" ]; then',
      '  echo "ok" 42',
      'fi'
    ].join('\n'),
    expected: ['comment', 'string', 'keyword', 'number']
  },
  {
    lang: 'yaml',
    code: ['# config', 'name: demo', 'count: 42', 'enabled: true', 'title: "hello"'].join('\n'),
    expected: ['comment', 'string', 'number', 'literal', 'typeName']
  },
  {
    lang: 'toml',
    code: ['# config', '[package]', 'name = "demo"', 'version = "0.1.0"', 'count = 42', 'ok = true'].join('\n'),
    expected: ['comment', 'string', 'number', 'literal', 'typeName']
  },
  {
    lang: 'c',
    code: ['// comment', '#include <stdio.h>', 'int main(void) {', '  const char *msg = "hi";', '  return 42;', '}'].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword']
  },
  {
    lang: 'cpp',
    code: [
      '// comment',
      'class Widget : public Base {',
      'public:',
      '    int run() { return 7; }',
      '    const char *name = "cpp";',
      '};'
    ].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'typeName']
  },
  {
    lang: 'cs',
    code: ['// comment', 'public class Program {', '    static void Main() { var x = "hi"; Console.WriteLine(42); }', '}'].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'typeName']
  },
  {
    lang: 'rs',
    code: [
      '// comment',
      "struct Holder<'a> { value: &'a str }",
      'fn main() {',
      '    let name = "rust";',
      '    let count = 42u32;',
      '}'
    ].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'functionName', 'typeName']
  },
  {
    lang: 'go',
    code: ['package main', '', '// comment', 'func main() {', '    name := "go"', '    count := 42', '}'].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'functionName']
  },
  {
    lang: 'java',
    code: ['public class Main {', '    // comment', '    static int run() { return 42; }', '    String label = "java";', '}'].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'typeName']
  },
  {
    lang: 'kt',
    code: ['fun main() {', '    // comment', '    val name = "kotlin"', '    val count = 42', '}'].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'functionName']
  },
  {
    lang: 'html',
    code: ['<!-- comment -->', '<div class="box">Hello</div>', '<script>const x = 1</script>'].join('\n'),
    expected: ['comment', 'string', 'typeName']
  },
  {
    lang: 'css',
    code: ['/* theme */', '@media (min-width: 600px) {', '  .box { color: #ff0000; content: "hi"; width: 42px; }', '}'].join('\n'),
    expected: ['comment', 'keyword', 'string', 'number']
  },
  {
    lang: 'scss',
    code: ['// comment', '$primary: #333333;', '@mixin box {', '  color: $primary;', '  content: "scss";', '  width: 42px;', '}'].join('\n'),
    expected: ['comment', 'keyword', 'string', 'number']
  },
  {
    lang: 'sql',
    code: [
      '-- comment',
      'SELECT id, name',
      'FROM users',
      'WHERE id = 42 AND active = true;',
      '/* block comment */',
      "INSERT INTO users (name) VALUES ('hi');"
    ].join('\n'),
    expected: ['comment', 'string', 'number', 'keyword', 'literal']
  },
  {
    lang: 'ini',
    code: ['; comment', '[section]', 'name = "demo"', 'count = 42', 'enabled = true'].join('\n'),
    expected: ['comment', 'string', 'number', 'literal', 'typeName']
  }
]

test('highlight: representative samples tokenize with valid geometry and expected types', () => {
  for (const sample of SAMPLES) {
    const tokens = assertTokens(sample.code, sample.lang, tokenize(sample.code, sample.lang))
    const types = typesOf(tokens)
    for (const expected of sample.expected) {
      assert.ok(types.has(expected), `${sample.lang}: expected a ${expected} token, got ${[...types].join(',')}`)
    }
  }
})

test('highlight: json has no keywords and markdown/html stay simple', () => {
  const jsonTypes = typesOf(assertTokens('{"a": 1, "b": true, "c": null}', 'json', tokenize('{"a": 1, "b": true, "c": null}', 'json')))
  assert.ok(!jsonTypes.has('keyword'))

  const mdSource = '# T\n\n`code`\n\n```\nconst x = 1\n```\n'
  const mdTypes = typesOf(assertTokens(mdSource, 'md', tokenize(mdSource, 'md')))
  for (const type of mdTypes) {
    assert.ok(type === 'string' || type === 'comment' || type === 'typeName', `markdown emitted ${type}`)
  }

  const htmlSource = '<p>const x = 1</p><script>let y = 2</script>'
  const htmlTypes = typesOf(assertTokens(htmlSource, 'html', tokenize(htmlSource, 'html')))
  assert.ok(!htmlTypes.has('keyword'), 'script body must not tokenize as keywords in the html scanner')
})

test('highlight: comments and strings take precedence over keywords', () => {
  assert.deepEqual(
    tokenize('// const let var 42 "x"', 'js').map((token) => token.type),
    ['comment']
  )
  assert.deepEqual(
    tokenize('"const let 42"', 'js').map((token) => token.type),
    ['string']
  )

  const block = tokenize('/* if while return 42 */ 42', 'js')
  assert.equal(block[0].type, 'comment')
  assert.equal(block[1].type, 'number')
  assert.ok(block[1].start > block[0].end)
  assert.equal(block[0].end, block[0].start + '/* if while return 42 */'.length)

  assert.deepEqual(
    tokenize('# if True None 42', 'py').map((token) => token.type),
    ['comment']
  )
  assert.deepEqual(
    tokenize('"""if while True"""', 'py').map((token) => token.type),
    ['string']
  )
  assert.deepEqual(
    tokenize("'# not a comment'", 'py').map((token) => token.type),
    ['string']
  )
  assert.deepEqual(
    tokenize('-- select 1 from', 'sql').map((token) => token.type),
    ['comment']
  )
  assert.deepEqual(
    tokenize('/* from where 1 */', 'sql').map((token) => token.type),
    ['comment']
  )
  assert.deepEqual(
    tokenize('# not a comment', 'yaml').map((token) => token.type),
    ['comment']
  )
})

test('highlight: unterminated block comments run to EOF', () => {
  const source = '/* open comment\nstill open'
  const tokens = assertTokens(source, 'js', tokenize(source, 'js'))
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].type, 'comment')
  assert.equal(tokens[0].start, 0)
  assert.equal(tokens[0].end, source.length)
})

test('highlight: shell # only starts comments at word boundaries', () => {
  const shebang = assertTokens('#!/bin/sh\n# real comment', 'sh', tokenize('#!/bin/sh\n# real comment', 'sh'))
  assert.equal(shebang[0].type, 'comment')
  assert.ok(shebang.some((token) => token.type === 'comment' && token.start > 0))

  const dollarHash = assertTokens('echo $#', 'sh', tokenize('echo $#', 'sh'))
  assert.ok(dollarHash.every((token) => token.type !== 'comment'))

  const source = 'echo hi # note'
  const trailing = assertTokens(source, 'sh', tokenize(source, 'sh'))
  const comments = trailing.filter((token) => token.type === 'comment')
  assert.equal(comments.length, 1)
  assert.equal(comments[0].start, 'echo hi '.length)
  assert.equal(source.slice(comments[0].start), '# note')
})

test('highlight: numbers cover ints, floats, hex and exponents', () => {
  const source = 'const a = 42, b = 3.14, c = 0xFF, d = 1e-3, e = 2_000;'
  const tokens = assertTokens(source, 'js', tokenize(source, 'js'))
  const numbers = tokens.filter((token) => token.type === 'number').map((token) => source.slice(token.start, token.end))
  assert.deepEqual(numbers, ['42', '3.14', '0xFF', '1e-3', '2_000'])
})

function makeRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('highlight: fuzz — 300 random sources across all languages never throw or misbehave', () => {
  const random = makeRng(0x5eed1234)
  const alphabet = 'abcXYZ019_ \n\t"\'`/*#<>{}[]()=+-:;,.\\|&$@~%!?^中文'
  for (let caseIndex = 0; caseIndex < 300; caseIndex += 1) {
    const length = Math.floor(random() * 200)
    let source = ''
    for (let i = 0; i < length; i += 1) source += alphabet[Math.floor(random() * alphabet.length)]
    for (let pick = 0; pick < 3; pick += 1) {
      const language = ALL_LANGUAGES[Math.floor(random() * ALL_LANGUAGES.length)]
      assertTokens(source, language, tokenize(source, language))
    }
  }
})

test('highlight: non-string and unknown inputs are safe', () => {
  for (const value of [undefined, null, 0, 42, true, {}, [], Symbol('token')]) {
    assert.doesNotThrow(() => tokenize(value, 'js'))
    assert.deepEqual(tokenize(value, 'js'), [])
    assert.doesNotThrow(() => tokenize('const x = 1', value))
    assert.deepEqual(tokenize('const x = 1', value), [])
  }
  assert.deepEqual(tokenize('', 'js'), [])
  assert.deepEqual(tokenize('const x = 1', 'txt'), [])
  assert.deepEqual(tokenize('const x = 1', 'no-such-language'), [])
  assert.deepEqual(tokenize('const x = 1', 'constructor'), [])
})

test('highlight: >400k source uses the cheap pass and returns quickly', () => {
  const chunk = 'const value = "text" + 42 // note\n'
  const source = chunk.repeat(Math.ceil(400001 / chunk.length) + 500)
  assert.ok(source.length > 400000)
  const started = Date.now()
  const tokens = tokenize(source, 'js')
  const elapsed = Date.now() - started
  assertTokens(source, 'js', tokens)
  assert.ok(tokens.length > 0)
  assert.ok(elapsed < 5000, `cheap pass took ${elapsed}ms`)

  const plain = 'x'.repeat(500000)
  assertTokens(plain, 'js', tokenize(plain, 'js'))
})

// ═══════════════════════════════════════════════════════════════════════════
// file-icons.js
// ═══════════════════════════════════════════════════════════════════════════

const ICON_SHAPES = new Set(['file', 'square', 'circle', 'folder', 'folder-open', 'box'])
const UNKNOWN_ICON = {
  shape: 'file',
  glyph: '',
  color: '#8b949e',
  label: { zh: '文件', en: 'File' }
}

function assertIconSpec(spec) {
  assert.ok(spec && typeof spec === 'object')
  assert.ok(ICON_SHAPES.has(spec.shape), `bad icon shape ${String(spec.shape)}`)
  assert.equal(typeof spec.glyph, 'string')
  assert.ok(spec.glyph.length <= 4, `glyph too long: ${spec.glyph}`)
  assert.match(spec.color, HEX_COLOR)
  assert.equal(typeof spec.label, 'object')
  assert.ok(typeof spec.label.zh === 'string' && spec.label.zh.length > 0)
  assert.ok(typeof spec.label.en === 'string' && spec.label.en.length > 0)
  return spec
}

test('file icons: directories always get the folder spec', () => {
  for (const name of ['src', 'node_modules', '', undefined, 'weird.js']) {
    const spec = assertIconSpec(fileIconSpec(name, true))
    assert.equal(spec.shape, 'folder')
    assert.equal(spec.glyph, '')
    assert.equal(spec.color, '#dcb67a')
  }
})

test('file icons: main languages have distinct brand colours and glyphs', () => {
  const cases = [
    ['index.js', 'JS', '#f1e05a'],
    ['index.ts', 'TS', '#3178c6'],
    ['script.py', 'PY', '#3572a5'],
    ['lib.rs', 'RS', '#dea584'],
    ['main.go', 'GO', '#00add8'],
    ['notes.md', 'MD', '#519aba'],
    ['data.json', '{}', '#cbcb41'],
    ['run.sh', 'SH', '#89e051'],
    ['index.html', '<>', '#e34c26'],
    ['style.css', '#', '#563d7c']
  ]
  const colors = new Set()
  const glyphs = new Set()
  for (const [name, glyph, color] of cases) {
    const spec = assertIconSpec(fileIconSpec(name, false))
    assert.equal(spec.glyph, glyph, `${name} glyph`)
    assert.equal(spec.color, color, `${name} color`)
    colors.add(spec.color)
    glyphs.add(spec.glyph)
  }
  assert.equal(colors.size, cases.length, 'main languages must not share colours')
  assert.equal(glyphs.size, cases.length, 'main languages must not share glyphs')
})

test('file icons: extension families map to the right type spec', () => {
  const canonical = {
    js: 'a.js',
    ts: 'a.ts',
    tsx: 'a.tsx',
    jsx: 'a.jsx',
    py: 'a.py',
    ipynb: 'a.ipynb',
    json: 'a.json',
    md: 'a.md',
    mdx: 'a.mdx',
    yaml: 'a.yaml',
    toml: 'a.toml',
    sh: 'a.sh',
    ps1: 'a.ps1',
    c: 'a.c',
    h: 'a.h',
    cpp: 'a.cpp',
    hpp: 'a.hpp',
    cs: 'a.cs',
    rs: 'a.rs',
    go: 'a.go',
    java: 'a.java',
    kt: 'a.kt',
    html: 'a.html',
    css: 'a.css',
    scss: 'a.scss',
    less: 'a.less',
    sql: 'a.sql',
    csv: 'a.csv',
    tsv: 'a.tsv',
    log: 'a.log',
    xml: 'a.xml',
    ini: 'a.ini',
    cfg: 'a.conf',
    env: 'a.env',
    lock: 'a.lock',
    pdf: 'a.pdf',
    image: 'a.png',
    svg: 'a.svg',
    ico: 'a.ico',
    archive: 'a.zip',
    wasm: 'a.wasm',
    pyc: 'a.pyc',
    pth: 'a.pth',
    font: 'a.ttf',
    video: 'a.mp4',
    audio: 'a.mp3',
    docx: 'a.docx',
    xlsx: 'a.xlsx',
    pptx: 'a.pptx'
  }
  const extensions = {
    mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', tsx: 'tsx', jsx: 'jsx',
    pyi: 'py', pyw: 'py', ipynb: 'ipynb', jsonc: 'json', json5: 'json',
    mdx: 'mdx', markdown: 'md', yml: 'yaml', bash: 'sh', zsh: 'sh',
    ps1: 'ps1', psm1: 'ps1', c: 'c', h: 'h', cpp: 'cpp', cxx: 'cpp',
    cc: 'cpp', hpp: 'hpp', hxx: 'hpp', hh: 'hpp', cs: 'cs', rs: 'rs',
    go: 'go', java: 'java', kt: 'kt', kts: 'kt', html: 'html', htm: 'html',
    xml: 'xml', svg: 'svg', css: 'css', scss: 'scss', sass: 'scss',
    less: 'less', sql: 'sql', csv: 'csv', tsv: 'tsv', log: 'log',
    ini: 'ini', conf: 'cfg', cfg: 'cfg', properties: 'ini', env: 'env',
    lock: 'lock', pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image',
    gif: 'image', webp: 'image', ico: 'ico', zip: 'archive', tar: 'archive',
    gz: 'archive', tgz: 'archive', '7z': 'archive', rar: 'archive',
    wasm: 'wasm', pyc: 'pyc', pth: 'pth', ttf: 'font', otf: 'font',
    woff: 'font', woff2: 'font', mp4: 'video', mov: 'video', webm: 'video',
    mp3: 'audio', wav: 'audio', flac: 'audio', docx: 'docx', xlsx: 'xlsx',
    pptx: 'pptx', toml: 'toml'
  }
  for (const [extension, type] of Object.entries(extensions)) {
    const actual = assertIconSpec(fileIconSpec(`file.${extension}`, false))
    const expected = assertIconSpec(fileIconSpec(canonical[type], false))
    assert.deepEqual(actual, expected, `.${extension} should look like ${canonical[type]}`)
  }
})

test('file icons: special names beat extensions', () => {
  const packageJson = assertIconSpec(fileIconSpec('package.json', false))
  const dataJson = assertIconSpec(fileIconSpec('data.json', false))
  assert.equal(packageJson.color, '#cbcb41')
  assert.equal(packageJson.glyph, 'NPM')
  assert.match(packageJson.label.en, /npm|manifest/i)
  assert.notDeepEqual(packageJson.label, dataJson.label)

  const packageLock = assertIconSpec(fileIconSpec('package-lock.json', false))
  assert.match(packageLock.label.en, /npm lockfile/i)

  const pnpmLock = assertIconSpec(fileIconSpec('pnpm-lock.yaml', false))
  assert.equal(pnpmLock.glyph, 'LOCK')
  assert.equal(pnpmLock.color, '#f69220')

  const yarnLock = assertIconSpec(fileIconSpec('yarn.lock', false))
  assert.equal(yarnLock.glyph, 'LOCK')
  assert.equal(yarnLock.color, '#2c8ebb')

  const tsconfig = assertIconSpec(fileIconSpec('tsconfig.json', false))
  assert.equal(tsconfig.glyph, 'TS')
  assert.equal(tsconfig.shape, 'box')

  const dockerfile = assertIconSpec(fileIconSpec('Dockerfile', false))
  assert.equal(dockerfile.glyph, 'DOCK')
  assert.equal(dockerfile.color, '#2496ed')

  const compose = assertIconSpec(fileIconSpec('docker-compose.yml', false))
  assert.equal(compose.glyph, 'DOCK')
  assert.equal(compose.color, '#2496ed')

  const makefile = assertIconSpec(fileIconSpec('Makefile', false))
  assert.equal(makefile.glyph, 'MAKE')
  assert.equal(makefile.color, '#427819')

  const cmake = assertIconSpec(fileIconSpec('CMakeLists.txt', false))
  assert.equal(cmake.glyph, 'CMAK')
  assert.equal(cmake.color, '#064f8c')

  const gitignore = assertIconSpec(fileIconSpec('.gitignore', false))
  assert.equal(gitignore.glyph, 'GIT')
  assert.equal(gitignore.color, '#f14e32')

  const gitattributes = assertIconSpec(fileIconSpec('.gitattributes', false))
  assert.equal(gitattributes.glyph, 'GIT')

  const env = assertIconSpec(fileIconSpec('.env', false))
  assert.equal(env.glyph, 'ENV')
  assert.equal(env.color, '#ecd53f')

  const readme = assertIconSpec(fileIconSpec('README.md', false))
  assert.equal(readme.glyph, 'MD')
  assert.equal(readme.color, '#519aba')
  assert.match(readme.label.zh, /说明/)

  const readmePlain = assertIconSpec(fileIconSpec('README', false))
  assert.deepEqual(readmePlain, readme)

  const license = assertIconSpec(fileIconSpec('LICENSE', false))
  assert.equal(license.glyph, 'LIC')
  assert.equal(license.shape, 'square')

  const requirements = assertIconSpec(fileIconSpec('requirements.txt', false))
  assert.equal(requirements.color, '#3572a5')
  assert.match(requirements.label.en, /pip/i)

  const pyproject = assertIconSpec(fileIconSpec('pyproject.toml', false))
  assert.equal(pyproject.color, '#3572a5')
  assert.equal(pyproject.shape, 'box')

  const setupPy = assertIconSpec(fileIconSpec('setup.py', false))
  assert.equal(setupPy.color, '#3572a5')

  const cargo = assertIconSpec(fileIconSpec('Cargo.toml', false))
  assert.equal(cargo.glyph, 'RS')
  assert.equal(cargo.color, '#dea584')
  assert.equal(cargo.shape, 'box')

  const goMod = assertIconSpec(fileIconSpec('go.mod', false))
  assert.equal(goMod.glyph, 'GO')
  assert.equal(goMod.color, '#00add8')

  const goSum = assertIconSpec(fileIconSpec('go.sum', false))
  assert.deepEqual(goSum, goMod)

  const agents = assertIconSpec(fileIconSpec('AGENTS.md', false))
  assert.equal(agents.glyph, 'AG')
  assert.equal(agents.color, '#519aba')

  const claude = assertIconSpec(fileIconSpec('CLAUDE.md', false))
  assert.equal(claude.glyph, 'CL')
  assert.equal(claude.color, '#d97757')

  const npmrc = assertIconSpec(fileIconSpec('.npmrc', false))
  assert.equal(npmrc.glyph, 'NPM')
  assert.equal(npmrc.color, '#cb3837')

  const editorconfig = assertIconSpec(fileIconSpec('.editorconfig', false))
  assert.equal(editorconfig.glyph, 'ECFG')
  assert.equal(editorconfig.color, '#8b949e')
})

test('file icons: name matching is case-insensitive where intended', () => {
  const pairs = [
    ['Dockerfile', 'dockerfile'],
    ['DOCKERFILE', 'Dockerfile'],
    ['Makefile', 'makefile'],
    ['MAKEFILE', 'Makefile'],
    ['Package.JSON', 'package.json'],
    ['AGENTS.MD', 'agents.md'],
    ['INDEX.JS', 'index.js'],
    ['LICENSE', 'license'],
    ['CMAKELISTS.TXT', 'CMakeLists.txt']
  ]
  for (const [a, b] of pairs) {
    assert.deepEqual(fileIconSpec(a, false), fileIconSpec(b, false), `${a} vs ${b}`)
  }
})

test('file icons: basenames are used for paths with separators', () => {
  assert.deepEqual(fileIconSpec('src/lib/index.js', false), fileIconSpec('index.js', false))
  assert.deepEqual(fileIconSpec('C:\\proj\\main.py', false), fileIconSpec('main.py', false))
  assert.deepEqual(fileIconSpec('/tmp/notes.md', false), fileIconSpec('notes.md', false))
})

test('file icons: unknown and odd input falls back to the plain file spec', () => {
  for (const name of ['mystery.xyz', 'no-extension', 'archive.unknownext', '', undefined, null, 42, true, {}, [], Symbol('file')]) {
    const spec = assertIconSpec(fileIconSpec(name, false))
    assert.deepEqual(spec, UNKNOWN_ICON)
  }
  assert.deepEqual(fileIconSpec('foo.js'), fileIconSpec('foo.js'))
})

// ═══════════════════════════════════════════════════════════════════════════
// url-safety.js — the document preview sanitizer's URL gate
// ═══════════════════════════════════════════════════════════════════════════

test('url safety: control characters are stripped before the scheme check', () => {
  // Browsers drop tab/newline inside a scheme, so these all resolve to
  // javascript: after URL parsing even though they do not start with it.
  assert.equal(normalizeUrlValue('jav\tascript:alert(1)'), 'javascript:alert(1)')
  assert.equal(normalizeUrlValue('java\nscript:alert(1)'), 'javascript:alert(1)')
  assert.equal(normalizeUrlValue(' \u0000javascript:alert(1)'), 'javascript:alert(1)')
  assert.equal(urlSchemeOf('jav\tascript:alert(1)'), 'javascript')
  assert.equal(urlSchemeOf('HTTPS://example.com'), 'https')
  assert.equal(urlSchemeOf('/relative/path.md'), '')
})

test('url safety: script schemes are rejected in every attribute that navigates', () => {
  const attacks = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'jav\tascript:alert(1)',
    'java\nscript:alert(1)',
    ' javascript:alert(1)',
    'jav\u0000ascript:alert(1)',
    'vbscript:msgbox(1)',
    'file:///C:/Windows/system32/calc.exe',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'blob:https://example.com/uuid',
  ]
  for (const value of attacks) {
    assert.ok(urlAttributeViolation('href', value, 'a'), `href should reject ${JSON.stringify(value)}`)
    assert.ok(urlAttributeViolation('src', value, 'img'), `src should reject ${JSON.stringify(value)}`)
    assert.ok(urlAttributeViolation('xlink:href', value, 'use'), `xlink:href should reject ${JSON.stringify(value)}`)
  }
  assert.ok(urlAttributeViolation('onclick', 'alert(1)', 'a'))
  assert.ok(urlAttributeViolation('onerror', 'alert(1)', 'img'))
})

test('url safety: ordinary links, anchors and image data URLs survive', () => {
  const safe = [
    'https://example.com/a?b=1#c',
    'http://example.com',
    'mailto:someone@example.com',
    'tel:+123456',
    '/docs/readme.md',
    './notes.txt',
    '../up/one level.md',
    '#section-2',
    '//cdn.example.com/x.png',
    '',
  ]
  for (const value of safe) {
    assert.equal(urlAttributeViolation('href', value, 'a'), '', `href should keep ${JSON.stringify(value)}`)
  }
  assert.equal(
    urlAttributeViolation('src', 'data:image/png;base64,iVBORw0KGgo=', 'img'),
    '',
  )
  assert.ok(
    urlAttributeViolation('src', 'data:image/svg+xml,<svg onload=alert(1)>', 'img'),
    'svg data URLs stay blocked',
  )
  assert.equal(urlAttributeViolation('title', 'javascript:alert(1)', 'a'), '')
  assert.equal(urlAttributeViolation('alt', 'javascript:alert(1)', 'img'), '')
})

