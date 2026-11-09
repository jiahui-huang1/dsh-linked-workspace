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

// ---- themes.js ----
/*
 * dsh-linked-workspace — editor colour themes.
 *
 * These palettes are plain data: no imports, no DOM, no React. The build
 * script (scripts/build-client.mjs) inlines this file into the browser bundle
 * by stripping the leading `export ` keywords, so every export below must stay
 * a top-level named declaration.
 *
 * Twelve colour keys are shared by every theme; the renderer maps token types
 * (`keyword`, `string`, `comment`, `number`, `functionName`, `typeName`,
 * `operator`, `punctuation`) directly onto them. Plain text between tokens uses
 * `colors.plain`. Note that `literal` tokens have no dedicated colour key — the
 * editor maps them onto `colors.number` (numbers / literals read alike).
 */

const DEFAULT_THEME_ID = 'github-light'

const EDITOR_THEMES = [
  {
    id: 'github-dark',
    label: { zh: 'GitHub 深色', en: 'GitHub Dark' },
    kind: 'dark',
    colors: {
      bg: '#0d1117',
      fg: '#c9d1d9',
      gutterBg: '#010409',
      gutterFg: '#6e7681',
      border: '#30363d',
      selection: '#264f78',
      lineHighlight: '#161b22',
      caret: '#c9d1d9',
      keyword: '#ff7b72',
      string: '#a5d6ff',
      comment: '#8b949e',
      number: '#79c0ff',
      functionName: '#d2a8ff',
      typeName: '#ffa657',
      operator: '#ff7b72',
      punctuation: '#8b949e',
      plain: '#c9d1d9'
    }
  },
  {
    id: 'github-light',
    label: { zh: 'GitHub 浅色', en: 'GitHub Light' },
    kind: 'light',
    colors: {
      bg: '#ffffff',
      fg: '#24292f',
      gutterBg: '#f6f8fa',
      gutterFg: '#8c959f',
      border: '#d0d7de',
      selection: '#cce5ff',
      lineHighlight: '#f6f8fa',
      caret: '#24292f',
      keyword: '#cf222e',
      string: '#0a3069',
      comment: '#6e7781',
      number: '#0550ae',
      functionName: '#8250df',
      typeName: '#953800',
      operator: '#0550ae',
      punctuation: '#57606a',
      plain: '#24292f'
    }
  },
  {
    id: 'one-dark',
    label: { zh: 'One Dark 深色', en: 'One Dark' },
    kind: 'dark',
    colors: {
      bg: '#282c34',
      fg: '#abb2bf',
      gutterBg: '#21252b',
      gutterFg: '#5c6370',
      border: '#3e4451',
      selection: '#3e4451',
      lineHighlight: '#2c313c',
      caret: '#528bff',
      keyword: '#c678dd',
      string: '#98c379',
      comment: '#5c6370',
      number: '#d19a66',
      functionName: '#61afef',
      typeName: '#e5c07b',
      operator: '#56b6c2',
      punctuation: '#abb2bf',
      plain: '#abb2bf'
    }
  },
  {
    id: 'dracula',
    label: { zh: 'Dracula 深色', en: 'Dracula' },
    kind: 'dark',
    colors: {
      bg: '#282a36',
      fg: '#f8f8f2',
      gutterBg: '#21222c',
      gutterFg: '#6272a4',
      border: '#44475a',
      selection: '#44475a',
      lineHighlight: '#343746',
      caret: '#f8f8f2',
      keyword: '#ff79c6',
      string: '#f1fa8c',
      comment: '#6272a4',
      number: '#bd93f9',
      functionName: '#50fa7b',
      typeName: '#8be9fd',
      operator: '#ff79c6',
      punctuation: '#f8f8f2',
      plain: '#f8f8f2'
    }
  },
  {
    id: 'monokai',
    label: { zh: 'Monokai 深色', en: 'Monokai' },
    kind: 'dark',
    colors: {
      bg: '#272822',
      fg: '#f8f8f2',
      gutterBg: '#1e1f1c',
      gutterFg: '#75715e',
      border: '#3e3d32',
      selection: '#49483e',
      lineHighlight: '#3e3d32',
      caret: '#f8f8f2',
      keyword: '#f92672',
      string: '#e6db74',
      comment: '#75715e',
      number: '#ae81ff',
      functionName: '#a6e22e',
      typeName: '#66d9ef',
      operator: '#f92672',
      punctuation: '#f8f8f2',
      plain: '#f8f8f2'
    }
  },
  {
    id: 'nord',
    label: { zh: 'Nord 深色', en: 'Nord' },
    kind: 'dark',
    colors: {
      bg: '#2e3440',
      fg: '#d8dee9',
      gutterBg: '#272c36',
      gutterFg: '#616e88',
      border: '#3b4252',
      selection: '#434c5e',
      lineHighlight: '#3b4252',
      caret: '#d8dee9',
      keyword: '#81a1c1',
      string: '#a3be8c',
      comment: '#616e88',
      number: '#b48ead',
      functionName: '#88c0d0',
      typeName: '#8fbcbb',
      operator: '#81a1c1',
      punctuation: '#d8dee9',
      plain: '#d8dee9'
    }
  },
  {
    id: 'solarized-dark',
    label: { zh: 'Solarized 深色', en: 'Solarized Dark' },
    kind: 'dark',
    colors: {
      bg: '#002b36',
      fg: '#839496',
      gutterBg: '#00252e',
      gutterFg: '#586e75',
      border: '#073642',
      selection: '#073642',
      lineHighlight: '#073642',
      caret: '#93a1a1',
      keyword: '#859900',
      string: '#2aa198',
      comment: '#586e75',
      number: '#d33682',
      functionName: '#268bd2',
      typeName: '#b58900',
      operator: '#859900',
      punctuation: '#839496',
      plain: '#839496'
    }
  },
  {
    id: 'solarized-light',
    label: { zh: 'Solarized 浅色', en: 'Solarized Light' },
    kind: 'light',
    colors: {
      bg: '#fdf6e3',
      fg: '#657b83',
      gutterBg: '#eee8d5',
      gutterFg: '#93a1a1',
      border: '#eee8d5',
      selection: '#eee8d5',
      lineHighlight: '#eee8d5',
      caret: '#586e75',
      keyword: '#859900',
      string: '#2aa198',
      comment: '#93a1a1',
      number: '#d33682',
      functionName: '#268bd2',
      typeName: '#b58900',
      operator: '#859900',
      punctuation: '#657b83',
      plain: '#657b83'
    }
  },
  {
    id: 'vs-dark',
    label: { zh: 'VS Code 深色', en: 'VS Dark' },
    kind: 'dark',
    colors: {
      bg: '#1e1e1e',
      fg: '#d4d4d4',
      gutterBg: '#252526',
      gutterFg: '#858585',
      border: '#333333',
      selection: '#264f78',
      lineHighlight: '#2a2d2e',
      caret: '#aeafad',
      keyword: '#569cd6',
      string: '#ce9178',
      comment: '#6a9955',
      number: '#b5cea8',
      functionName: '#dcdcaa',
      typeName: '#4ec9b0',
      operator: '#d4d4d4',
      punctuation: '#d4d4d4',
      plain: '#d4d4d4'
    }
  },
  {
    id: 'xcode-light',
    label: { zh: 'Xcode 浅色', en: 'Xcode Light' },
    kind: 'light',
    colors: {
      bg: '#ffffff',
      fg: '#1f1f1f',
      gutterBg: '#f5f5f5',
      gutterFg: '#8e8e93',
      border: '#dedede',
      selection: '#b5d5ff',
      lineHighlight: '#f2f6fc',
      caret: '#1f1f1f',
      keyword: '#ad3da4',
      string: '#c41a16',
      comment: '#007400',
      number: '#1c00cf',
      functionName: '#326d74',
      typeName: '#0f68a0',
      operator: '#1f1f1f',
      punctuation: '#1f1f1f',
      plain: '#1f1f1f'
    }
  }
]

const DEFAULT_THEME_FAMILY = 'github'

const EDITOR_THEME_FAMILIES = [
  { id: 'github', label: { zh: 'GitHub', en: 'GitHub' }, light: 'github-light', dark: 'github-dark' },
  { id: 'solarized', label: { zh: 'Solarized', en: 'Solarized' }, light: 'solarized-light', dark: 'solarized-dark' },
  { id: 'one', label: { zh: 'One Dark / Light', en: 'One Dark / Light' }, light: 'one-light', dark: 'one-dark' },
  { id: 'dracula', label: { zh: 'Dracula', en: 'Dracula' }, light: 'dracula-light', dark: 'dracula' },
  { id: 'monokai', label: { zh: 'Monokai', en: 'Monokai' }, light: 'monokai-light', dark: 'monokai' },
  { id: 'nord', label: { zh: 'Nord', en: 'Nord' }, light: 'nord-light', dark: 'nord' },
  { id: 'vscode', label: { zh: 'VS Code Dark+ / Light+', en: 'VS Code Dark+ / Light+' }, light: 'vs-light', dark: 'vs-dark' },
  { id: 'xcode', label: { zh: 'Xcode Light / Dark', en: 'Xcode Light / Dark' }, light: 'xcode-light', dark: 'xcode-dark' },
  { id: 'catppuccin', label: { zh: 'Catppuccin Latte / Mocha', en: 'Catppuccin Latte / Mocha' }, light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
]

// 0.5.3: every family needs both a light and a dark variant. The extra
// palettes reuse an existing companion palette so the card grid stays compact
// while every preview honestly switches with the mode card.
function THEME_addVariant(id, zh, en, kind, baseId) {
  const base = EDITOR_THEMES.find((theme) => theme.id === baseId)
  if (!base) return
  EDITOR_THEMES.push({
    id,
    label: { zh, en },
    kind,
    colors: { ...base.colors },
  })
}

THEME_addVariant('one-light', 'One Light', 'One Light', 'light', 'xcode-light')
THEME_addVariant('dracula-light', 'Dracula Light', 'Dracula Light', 'light', 'github-light')
THEME_addVariant('monokai-light', 'Monokai Light', 'Monokai Light', 'light', 'solarized-light')
THEME_addVariant('nord-light', 'Nord Light', 'Nord Light', 'light', 'github-light')
THEME_addVariant('vs-light', 'VS Code Light+', 'VS Code Light+', 'light', 'xcode-light')
THEME_addVariant('xcode-dark', 'Xcode Dark', 'Xcode Dark', 'dark', 'vs-dark')
THEME_addVariant('catppuccin-latte', 'Catppuccin Latte', 'Catppuccin Latte', 'light', 'github-light')
THEME_addVariant('catppuccin-mocha', 'Catppuccin Mocha', 'Catppuccin Mocha', 'dark', 'one-dark')

// Internal lookup with tolerant id matching; exported getTheme() never throws.
function THEME_find(id) {
  if (typeof id !== 'string') return null
  const key = id.trim().toLowerCase()
  if (!key) return null
  for (let i = 0; i < EDITOR_THEMES.length; i += 1) {
    if (EDITOR_THEMES[i].id === key) return EDITOR_THEMES[i]
  }
  return null
}

function getTheme(id) {
  return THEME_find(id) || THEME_find(DEFAULT_THEME_ID) || EDITOR_THEMES[0]
}

// ---- highlight.js ----
/*
 * dsh-linked-workspace — dependency-free syntax tokenizer.
 *
 * Pure JavaScript (no imports, no DOM, no Node APIs): scripts/build-client.mjs
 * inlines this file into the browser bundle after stripping the leading
 * `export ` keywords. Keep exports top-level named declarations only.
 *
 * Public API
 *   languageOf(filePath) -> language id (see HL_CONFIGS)
 *   tokenize(source, language) -> [{ start, end, type }]
 *
 * Tokens are non-overlapping, sorted by start, end-exclusive, and only cover
 * ranges that deserve a colour of their own (plain text is implied between
 * tokens). `tokenize` never throws: bad input yields [] and huge input switches
 * to a cheap comments/strings pass.
 */

// ── language detection ─────────────────────────────────────────────────────

const HL_EXTENSION_LANGUAGES = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  es6: 'js',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
  py: 'py',
  pyi: 'py',
  pyw: 'py',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  geojson: 'json',
  webmanifest: 'json',
  ipynb: 'json',
  md: 'md',
  mdx: 'md',
  markdown: 'md',
  mdown: 'md',
  txt: 'txt',
  text: 'txt',
  log: 'txt',
  rst: 'txt',
  csv: 'txt',
  tsv: 'txt',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  ksh: 'sh',
  fish: 'sh',
  bat: 'sh',
  cmd: 'sh',
  ps1: 'sh',
  psm1: 'sh',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  'c++': 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  hh: 'cpp',
  ipp: 'cpp',
  cs: 'cs',
  csx: 'cs',
  rs: 'rs',
  go: 'go',
  java: 'java',
  jav: 'java',
  kt: 'kt',
  kts: 'kt',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'html',
  svelte: 'html',
  xml: 'html',
  svg: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'scss',
  sql: 'sql',
  psql: 'sql',
  mysql: 'sql',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  properties: 'ini',
  env: 'ini',
  gitconfig: 'ini',
  npmrc: 'ini'
}

const HL_SPECIAL_LANGUAGES = {
  dockerfile: 'sh',
  containerfile: 'sh',
  makefile: 'sh',
  gnumakefile: 'sh',
  'cmakelists.txt': 'sh',
  'package.json': 'json',
  'package-lock.json': 'json',
  'tsconfig.json': 'json',
  'pnpm-lock.yaml': 'yaml',
  'yarn.lock': 'yaml',
  'cargo.toml': 'toml',
  'cargo.lock': 'toml',
  'pyproject.toml': 'toml',
  'setup.py': 'py',
  'requirements.txt': 'txt',
  'go.mod': 'txt',
  'go.sum': 'txt',
  'go.work': 'txt',
  'readme': 'txt',
  'license': 'txt',
  'changelog': 'txt',
  '.gitignore': 'txt',
  '.gitattributes': 'txt',
  '.gitmodules': 'ini',
  '.gitconfig': 'ini',
  '.npmrc': 'ini',
  '.editorconfig': 'ini',
  '.env': 'ini'
}

function HL_lookup(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

function languageOf(filePath) {
  if (typeof filePath !== 'string') return 'txt'
  const normalized = filePath.replace(/\\/g, '/')
  const cut = normalized.lastIndexOf('/')
  const base = (cut >= 0 ? normalized.slice(cut + 1) : normalized).toLowerCase()
  if (!base) return 'txt'

  const special = HL_lookup(HL_SPECIAL_LANGUAGES, base)
  if (special) return special
  if (base.indexOf('dockerfile.') === 0 || base.indexOf('containerfile.') === 0) return 'sh'
  if (base.indexOf('.env') === 0) return 'ini'
  if (base.indexOf('tsconfig') === 0) return 'json'
  if (base.indexOf('makefile') === 0) return 'sh'
  if (base.indexOf('cmakelists') === 0) return 'sh'

  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'txt'
  const extension = base.slice(dot + 1)
  return HL_lookup(HL_EXTENSION_LANGUAGES, extension) || 'txt'
}

// ── small character helpers ────────────────────────────────────────────────

function HL_isDigit(code) {
  return code >= 48 && code <= 57
}

function HL_isHexDigit(code) {
  return (
    HL_isDigit(code) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  )
}

function HL_isIdStart(code) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code >= 128
  )
}

function HL_isIdPart(code) {
  return HL_isIdStart(code) || HL_isDigit(code)
}

function HL_lineEnd(src, from) {
  const n = src.length
  let i = from
  while (i < n) {
    const code = src.charCodeAt(i)
    if (code === 10 || code === 13) return i
    i += 1
  }
  return n
}

// A comment marker is a boundary marker only at the start of a shell-ish word:
// after whitespace or one of the common separators, never after a dollar sign
// or a letter.
function HL_isCommentBoundary(src, at) {
  if (at <= 0) return true
  const code = src.charCodeAt(at - 1)
  return (
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 13 ||
    code === 40 ||
    code === 41 ||
    code === 44 ||
    code === 59 ||
    code === 91 ||
    code === 93 ||
    code === 123 ||
    code === 125 ||
    code === 124 ||
    code === 38
  )
}

// ── string literal scanners (all return an exclusive end index) ────────────

function HL_scanEscaped(src, start, quoteCode, allowNewline) {
  const n = src.length
  let j = start + 1
  while (j < n) {
    const code = src.charCodeAt(j)
    if (code === 92) {
      j += 2
      continue
    }
    if (code === quoteCode) return j + 1
    if (!allowNewline && (code === 10 || code === 13)) return j
    j += 1
  }
  return n
}

function HL_scanRaw(src, start, quoteCode) {
  const n = src.length
  let j = start + 1
  while (j < n) {
    if (src.charCodeAt(j) === quoteCode) return j + 1
    j += 1
  }
  return n
}

function HL_scanShellSingle(src, start) {
  const n = src.length
  let j = start + 1
  while (j < n) {
    const code = src.charCodeAt(j)
    if (code === 39) return j + 1
    if (code === 10 || code === 13) return j
    j += 1
  }
  return n
}

function HL_scanDoubled(src, start, quoteCode) {
  const n = src.length
  let j = start + 1
  while (j < n) {
    const code = src.charCodeAt(j)
    if (code === quoteCode) {
      if (src.charCodeAt(j + 1) === quoteCode) {
        j += 2
        continue
      }
      return j + 1
    }
    if (code === 10 || code === 13) return j
    j += 1
  }
  return n
}

function HL_scanTriple(src, start, quoteCode) {
  const n = src.length
  const quote = String.fromCharCode(quoteCode)
  const pattern = quote + quote + quote
  const close = src.indexOf(pattern, start + 3)
  return close < 0 ? n : close + 3
}

// Rust lifetimes (`'a`) share the apostrophe with char literals (`'a'`); only
// treat it as a string when a closing quote actually follows one character.
function HL_rustCharEnd(src, start) {
  const n = src.length
  let j = start + 1
  if (j >= n) return -1
  const code = src.charCodeAt(j)
  if (code === 92) {
    j += 2
    if (src.charAt(j - 1) === 'u' && src.charAt(j) === '{') {
      const close = src.indexOf('}', j + 1)
      if (close < 0) return -1
      j = close + 1
    }
  } else if (code === 10 || code === 13) {
    return -1
  } else {
    j += 1
    if (code >= 55296 && code <= 56319) j += 1
  }
  if (j < n && src.charCodeAt(j) === 39) return j + 1
  return -1
}

function HL_scanStringAt(src, start, cfg) {
  const code = src.charCodeAt(start)
  if (code === 34) {
    if (cfg.triple && src.slice(start, start + 3) === '"""') return HL_scanTriple(src, start, 34)
    if (cfg.dqKind === 'doubled') return HL_scanDoubled(src, start, 34)
    if (cfg.dqKind === 'multiline') return HL_scanEscaped(src, start, 34, true)
    return HL_scanEscaped(src, start, 34, false)
  }
  if (code === 39) {
    if (cfg.triple && src.slice(start, start + 3) === "'''") return HL_scanTriple(src, start, 39)
    if (cfg.sqKind === 'rust') return HL_rustCharEnd(src, start)
    if (cfg.sqKind === 'shell' || cfg.sqKind === 'literal') return HL_scanShellSingle(src, start)
    if (cfg.sqKind === 'doubled') return HL_scanDoubled(src, start, 39)
    if (cfg.sqKind === 'raw') return HL_scanRaw(src, start, 39)
    return HL_scanEscaped(src, start, 39, false)
  }
  if (code === 96) {
    if (cfg.bqKind === 'raw') return HL_scanRaw(src, start, 96)
    if (cfg.bqKind === 'escapes') return HL_scanEscaped(src, start, 96, true)
    return -1
  }
  return -1
}

// ── number scanner ─────────────────────────────────────────────────────────

function HL_numberSuffix(src, from) {
  const n = src.length
  if (from >= n) return from
  const lower = src.charAt(from).toLowerCase()
  if (lower === 'n' || lower === 'l' || lower === 'f' || lower === 'd' || lower === 'h') {
    return from + 1
  }
  if (lower === 'u' || lower === 'i') {
    let j = from + 1
    while (j < n && HL_isDigit(src.charCodeAt(j))) j += 1
    return j
  }
  return from
}

function HL_scanNumber(src, start) {
  const n = src.length
  let j = start
  if (src.charCodeAt(j) === 48) {
    const next = src.charCodeAt(j + 1)
    if (next === 120 || next === 88) {
      j += 2
      while (j < n && (HL_isHexDigit(src.charCodeAt(j)) || src.charCodeAt(j) === 95)) j += 1
      return HL_numberSuffix(src, j)
    }
    if (next === 98 || next === 66) {
      j += 2
      while (j < n && (src.charCodeAt(j) === 48 || src.charCodeAt(j) === 49 || src.charCodeAt(j) === 95)) j += 1
      return HL_numberSuffix(src, j)
    }
    if (next === 111 || next === 79) {
      j += 2
      while (j < n) {
        const code = src.charCodeAt(j)
        if (code === 95 || (code >= 48 && code <= 55)) {
          j += 1
          continue
        }
        break
      }
      return HL_numberSuffix(src, j)
    }
  }
  while (j < n && (HL_isDigit(src.charCodeAt(j)) || src.charCodeAt(j) === 95)) j += 1
  if (j < n && src.charCodeAt(j) === 46 && HL_isDigit(src.charCodeAt(j + 1))) {
    j += 1
    while (j < n && (HL_isDigit(src.charCodeAt(j)) || src.charCodeAt(j) === 95)) j += 1
  }
  const exponent = src.charCodeAt(j)
  if (exponent === 101 || exponent === 69) {
    let k = j + 1
    const sign = src.charCodeAt(k)
    if (sign === 43 || sign === 45) k += 1
    if (HL_isDigit(src.charCodeAt(k))) {
      k += 1
      while (k < n && (HL_isDigit(src.charCodeAt(k)) || src.charCodeAt(k) === 95)) k += 1
      j = k
    }
  }
  return HL_numberSuffix(src, j)
}

// ── operator tables ────────────────────────────────────────────────────────

const HL_PUNCTUATION_CHARS = '(){}[],;:.'
const HL_SINGLE_OPERATOR_CHARS = "+-*/%=<>!&|^~?@$#\\'\"\x60"
const HL_OPERATORS3 = new Set(['===', '!==', '>>>', '<<=', '>>=', '**=', '??=', '...', '<=>'])
const HL_OPERATORS2 = new Set([
  '->', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '**', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::', ':=', '<<', '>>',
  '?.', '|>', '..'
])

// ── keyword sets ───────────────────────────────────────────────────────────

function HL_words(list) {
  const set = new Set()
  const parts = list.split(/\s+/)
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i]) set.add(parts[i])
  }
  return set
}

const HL_PY_STRING_PREFIX = /^(?:r|u|b|f|br|rb|fr|rf|ur)$/i

const HL_LITERALS = new Set([
  'true', 'false', 'null', 'nil', 'none', 'None', 'True', 'False',
  'undefined', 'nan', 'NaN', 'Infinity', 'infinity', 'nullptr', 'NULL',
  'yes', 'no', 'on', 'off'
])

const HL_KEYWORDS_JS = HL_words(
  'abstract as async await break case catch class const continue debugger ' +
    'declare default delete do else enum export extends finally for from ' +
    'function get if implements import in infer instanceof interface keyof ' +
    'let namespace new of private protected public readonly return ' +
    'satisfies set static super switch this throw try type typeof var void ' +
    'while with yield asserts is override'
)
const HL_KEYWORDS_PY = HL_words(
  'and as assert async await break class continue def del elif else except ' +
    'finally for from global if import in is lambda nonlocal not or pass ' +
    'raise return try while with yield match case self cls'
)
const HL_KEYWORDS_RS = HL_words(
  'as async await break const continue crate dyn else enum extern fn for if ' +
    'impl in let loop match mod move mut pub ref return self Self static ' +
    'struct super trait type unsafe use where while union'
)
const HL_KEYWORDS_GO = HL_words(
  'break case chan const continue default defer else fallthrough for func go ' +
    'goto if import interface map package range return select struct switch ' +
    'type var'
)
const HL_KEYWORDS_JVM = HL_words(
  'abstract assert boolean break byte case catch char class const continue ' +
    'default do double else enum extends final finally float for if ' +
    'implements import instanceof int interface long native new package ' +
    'private protected public return short static strictfp super switch ' +
    'synchronized this throw throws transient try void volatile while record ' +
    'sealed permits yields var as fun in is object typealias val when by ' +
    'constructor delegate dynamic field file get init param property ' +
    'receiver set setparam where actual annotation companion crossinline ' +
    'data expect external infix inline inner internal lateinit noinline open ' +
    'operator out override reified suspend tailrec vararg'
)
const HL_KEYWORDS_C = HL_words(
  'auto break case char const continue default do double else enum extern ' +
    'float for goto if inline int long register restrict return short signed ' +
    'sizeof static struct switch typedef union unsigned void volatile while ' +
    'include define ifdef ifndef endif elif pragma undef error line class ' +
    'namespace template typename public private protected virtual override ' +
    'final new delete this try catch throw using operator friend explicit ' +
    'constexpr consteval constinit noexcept static_cast dynamic_cast ' +
    'reinterpret_cast const_cast alignas alignof decltype mutable ' +
    'thread_local export import module and or not bool readonly sealed ' +
    'partial record delegate event where out ref params yield foreach lock ' +
    'fixed unsafe checked unchecked nameof implicit nint nuint stackalloc ' +
    'async await base global required init with file'
)
const HL_KEYWORDS_SH = HL_words(
  'if then else elif fi for while until do done case esac in function select ' +
    'time coproc declare local export readonly return break continue shift ' +
    'set unset read trap source eval exec exit test alias wait'
)
const HL_KEYWORDS_SQL = HL_words(
  'add all alter and any as asc begin between by case cast check column ' +
    'commit constraint create cross database default delete desc distinct ' +
    'drop else end exists fetch foreign from full grant group having if in ' +
    'index inner insert into is join key left like limit loop next not offset ' +
    'on only or order outer over partition primary procedure references ' +
    'return returns revoke right rollback row rows schema select set table ' +
    'then to transaction trigger truncate union unique update user values ' +
    'view when where while window with'
)
const HL_KEYWORDS_CSS = HL_words(
  'important media import charset keyframes font-face supports page ' +
    'namespace layer container property scope'
)

const HL_DECL_FN_JS = HL_words('function')
const HL_DECL_TYPE_JS = HL_words('class interface enum type namespace')
const HL_DECL_FN_PY = HL_words('def')
const HL_DECL_TYPE_PY = HL_words('class')
const HL_DECL_FN_RS = HL_words('fn')
const HL_DECL_TYPE_RS = HL_words('struct enum trait impl union type mod')
const HL_DECL_FN_GO = HL_words('func')
const HL_DECL_TYPE_GO = HL_words('type struct interface')
const HL_DECL_FN_JVM = HL_words('fun')
const HL_DECL_TYPE_JVM = HL_words('class interface enum record object typealias')
const HL_DECL_FN_C = HL_words('')
const HL_DECL_TYPE_C = HL_words('struct union enum typedef class interface namespace record')
const HL_DECL_FN_SH = HL_words('function')
const HL_DECL_FN_SQL = HL_words('function procedure')
const HL_DECL_TYPE_SQL = HL_words('table view index schema database')

// ── per-language scanner configuration ─────────────────────────────────────

const HL_QUOTES_C = '"\''
const HL_QUOTES_JS = '"\'`'

function HL_makeConfig(options) {
  const cfg = {
    mode: 'code',
    quoteChars: '',
    slashLine: false,
    slashBlock: false,
    dashLine: false,
    semiLine: false,
    hashMode: 0,
    triple: false,
    dqKind: 'escaped',
    sqKind: 'escaped',
    bqKind: '',
    pyPrefix: false,
    caseInsensitive: false,
    keys: false,
    keyChars: '',
    atRules: false,
    keywords: null,
    fnDecl: null,
    typeDecl: null
  }
  if (options) {
    const names = Object.keys(options)
    for (let i = 0; i < names.length; i += 1) cfg[names[i]] = options[names[i]]
  }
  return cfg
}

const HL_CONFIG_JS = HL_makeConfig({
  quoteChars: HL_QUOTES_JS,
  slashLine: true,
  slashBlock: true,
  bqKind: 'escapes',
  keywords: HL_KEYWORDS_JS,
  fnDecl: HL_DECL_FN_JS,
  typeDecl: HL_DECL_TYPE_JS
})
const HL_CONFIG_PY = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  hashMode: 1,
  triple: true,
  pyPrefix: true,
  keywords: HL_KEYWORDS_PY,
  fnDecl: HL_DECL_FN_PY,
  typeDecl: HL_DECL_TYPE_PY
})
const HL_CONFIG_JSON = HL_makeConfig({
  quoteChars: '"',
  keywords: null
})
const HL_CONFIG_RS = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  slashLine: true,
  slashBlock: true,
  dqKind: 'multiline',
  sqKind: 'rust',
  keywords: HL_KEYWORDS_RS,
  fnDecl: HL_DECL_FN_RS,
  typeDecl: HL_DECL_TYPE_RS
})
const HL_CONFIG_GO = HL_makeConfig({
  quoteChars: HL_QUOTES_JS,
  slashLine: true,
  slashBlock: true,
  bqKind: 'raw',
  keywords: HL_KEYWORDS_GO,
  fnDecl: HL_DECL_FN_GO,
  typeDecl: HL_DECL_TYPE_GO
})
const HL_CONFIG_JVM = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  slashLine: true,
  slashBlock: true,
  keywords: HL_KEYWORDS_JVM,
  fnDecl: HL_DECL_FN_JVM,
  typeDecl: HL_DECL_TYPE_JVM
})
const HL_CONFIG_C = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  slashLine: true,
  slashBlock: true,
  keywords: HL_KEYWORDS_C,
  fnDecl: HL_DECL_FN_C,
  typeDecl: HL_DECL_TYPE_C
})
const HL_CONFIG_SH = HL_makeConfig({
  quoteChars: HL_QUOTES_JS,
  hashMode: 2,
  sqKind: 'shell',
  bqKind: 'escapes',
  keywords: HL_KEYWORDS_SH,
  fnDecl: HL_DECL_FN_SH
})
const HL_CONFIG_SQL = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  slashBlock: true,
  dashLine: true,
  hashMode: 2,
  dqKind: 'doubled',
  sqKind: 'doubled',
  caseInsensitive: true,
  keywords: HL_KEYWORDS_SQL,
  fnDecl: HL_DECL_FN_SQL,
  typeDecl: HL_DECL_TYPE_SQL
})
const HL_CONFIG_YAML = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  hashMode: 2,
  sqKind: 'doubled',
  keys: true,
  keyChars: ':'
})
const HL_CONFIG_TOML = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  hashMode: 2,
  triple: true,
  sqKind: 'literal',
  keys: true,
  keyChars: '='
})
const HL_CONFIG_INI = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  hashMode: 2,
  semiLine: true,
  keys: true,
  keyChars: '='
})
const HL_CONFIG_CSS = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  slashBlock: true,
  atRules: true,
  keywords: HL_KEYWORDS_CSS
})
const HL_CONFIG_SCSS = HL_makeConfig({
  quoteChars: HL_QUOTES_C,
  slashLine: true,
  slashBlock: true,
  atRules: true,
  keywords: HL_KEYWORDS_CSS
})

const HL_CONFIGS = {
  js: HL_CONFIG_JS,
  ts: HL_CONFIG_JS,
  jsx: HL_CONFIG_JS,
  tsx: HL_CONFIG_JS,
  json: HL_CONFIG_JSON,
  py: HL_CONFIG_PY,
  md: HL_makeConfig({ mode: 'md' }),
  sh: HL_CONFIG_SH,
  yaml: HL_CONFIG_YAML,
  toml: HL_CONFIG_TOML,
  c: HL_CONFIG_C,
  cpp: HL_CONFIG_C,
  cs: HL_CONFIG_C,
  rs: HL_CONFIG_RS,
  go: HL_CONFIG_GO,
  java: HL_CONFIG_JVM,
  kt: HL_CONFIG_JVM,
  html: HL_makeConfig({ mode: 'html' }),
  css: HL_CONFIG_CSS,
  scss: HL_CONFIG_SCSS,
  sql: HL_CONFIG_SQL,
  ini: HL_CONFIG_INI,
  txt: null
}

const HL_LANGUAGE_ALIASES = {
  javascript: 'js',
  typescript: 'ts',
  node: 'js',
  python: 'py',
  rust: 'rs',
  golang: 'go',
  kotlin: 'kt',
  'c++': 'cpp',
  cxx: 'cpp',
  csharp: 'cs',
  'c#': 'cs',
  shell: 'sh',
  bash: 'sh',
  zsh: 'sh',
  console: 'sh',
  powershell: 'sh',
  yml: 'yaml',
  markdown: 'md',
  mdx: 'md',
  plaintext: 'txt',
  text: 'txt',
  plain: 'txt',
  none: 'txt',
  xml: 'html',
  svg: 'html',
  vue: 'html',
  scss: 'scss',
  sass: 'scss',
  less: 'scss',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json'
}

function HL_normalizeLanguage(language) {
  if (typeof language !== 'string') return 'txt'
  const key = language.trim().toLowerCase()
  if (!key) return 'txt'
  const alias = HL_lookup(HL_LANGUAGE_ALIASES, key)
  if (alias) return alias
  if (HL_lookup(HL_CONFIGS, key)) return key
  return 'txt'
}

function HL_keyFollows(src, start, keyChars) {
  const n = src.length
  let i = start
  while (i < n) {
    const code = src.charCodeAt(i)
    if (code === 32 || code === 9) {
      i += 1
      continue
    }
    return keyChars.indexOf(src.charAt(i)) >= 0
  }
  return false
}

// ── generic code scanner ───────────────────────────────────────────────────

function HL_scanCode(src, cfg) {
  const out = []
  const n = src.length
  const quoteChars = cfg.quoteChars
  const keywords = cfg.keywords
  let i = 0
  let pending = 0 // 0 none, 1 functionName, 2 typeName

  while (i < n) {
    const code = src.charCodeAt(i)

    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11) {
      i += 1
      continue
    }
    const c = src.charAt(i)

    // line comments
    if (cfg.hashMode && c === '#') {
      if (cfg.hashMode === 1 || HL_isCommentBoundary(src, i)) {
        const end = HL_lineEnd(src, i)
        out.push({ start: i, end, type: 'comment' })
        i = end
        pending = 0
        continue
      }
    }
    if (cfg.slashLine && c === '/' && src.charCodeAt(i + 1) === 47) {
      const end = HL_lineEnd(src, i)
      out.push({ start: i, end, type: 'comment' })
      i = end
      pending = 0
      continue
    }
    if (cfg.dashLine && c === '-' && src.charCodeAt(i + 1) === 45) {
      const end = HL_lineEnd(src, i)
      out.push({ start: i, end, type: 'comment' })
      i = end
      pending = 0
      continue
    }
    if (cfg.semiLine && c === ';' && HL_isCommentBoundary(src, i)) {
      const end = HL_lineEnd(src, i)
      out.push({ start: i, end, type: 'comment' })
      i = end
      pending = 0
      continue
    }

    // block comments
    if (cfg.slashBlock && c === '/' && src.charCodeAt(i + 1) === 42) {
      const close = src.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      out.push({ start: i, end, type: 'comment' })
      i = end
      pending = 0
      continue
    }

    // CSS/SCSS at-rules: @media, @import, @mixin ...
    if (cfg.atRules && c === '@' && HL_isIdStart(src.charCodeAt(i + 1))) {
      let j = i + 1
      while (j < n && (HL_isIdPart(src.charCodeAt(j)) || src.charAt(j) === '-')) j += 1
      out.push({ start: i, end: j, type: 'keyword' })
      i = j
      pending = 0
      continue
    }

    // strings
    if (quoteChars.indexOf(c) >= 0) {
      const end = HL_scanStringAt(src, i, cfg)
      if (end > i) {
        out.push({ start: i, end, type: 'string' })
        i = end
        pending = 0
        continue
      }
    }

    // numbers
    if (HL_isDigit(code) || (c === '.' && HL_isDigit(src.charCodeAt(i + 1)))) {
      const end = HL_scanNumber(src, i)
      out.push({ start: i, end, type: 'number' })
      i = end
      pending = 0
      continue
    }

    // identifiers, keywords and declared names
    if (HL_isIdStart(code)) {
      const start = i
      let j = i + 1
      while (j < n && HL_isIdPart(src.charCodeAt(j))) j += 1
      const word = src.slice(start, j)

      // Python f/r/b string prefixes: colour the whole literal, prefix included.
      if (cfg.pyPrefix && j < n && (src.charCodeAt(j) === 34 || src.charCodeAt(j) === 39) && HL_PY_STRING_PREFIX.test(word)) {
        const end = HL_scanStringAt(src, j, cfg)
        if (end > j) {
          out.push({ start, end, type: 'string' })
          i = end
          pending = 0
          continue
        }
      }

      const lookup = cfg.caseInsensitive ? word.toLowerCase() : word
      let type = ''
      if (HL_LITERALS.has(lookup)) {
        type = 'literal'
        pending = 0
      } else if (keywords && keywords.has(lookup)) {
        type = 'keyword'
        if (cfg.fnDecl && cfg.fnDecl.has(lookup)) pending = 1
        else if (cfg.typeDecl && cfg.typeDecl.has(lookup)) pending = 2
        else pending = 0
      } else if (pending) {
        type = pending === 1 ? 'functionName' : 'typeName'
        pending = 0
      } else if (cfg.keys && HL_keyFollows(src, j, cfg.keyChars)) {
        type = 'typeName'
        pending = 0
      } else {
        pending = 0
      }
      if (type) out.push({ start, end: j, type })
      i = j
      continue
    }

    // operators / punctuation
    const three = i + 3 <= n ? src.slice(i, i + 3) : ''
    const two = i + 2 <= n ? src.slice(i, i + 2) : ''
    let end = i
    let type = ''
    if (three && HL_OPERATORS3.has(three)) {
      end = i + 3
      type = 'operator'
    } else if (two && HL_OPERATORS2.has(two)) {
      end = i + 2
      type = 'operator'
    } else if (HL_PUNCTUATION_CHARS.indexOf(c) >= 0) {
      end = i + 1
      type = 'punctuation'
    } else if (HL_SINGLE_OPERATOR_CHARS.indexOf(c) >= 0) {
      end = i + 1
      type = 'operator'
    }
    if (end > i) {
      out.push({ start: i, end, type })
      if (c !== '*' && c !== '&' && c !== '@') pending = 0
      i = end
    } else {
      i += 1
    }
  }
  return out
}

// ── markdown scanner ───────────────────────────────────────────────────────

function HL_scanMarkdown(src) {
  const out = []
  const n = src.length
  let i = 0

  while (i < n) {
    const lineStart = i
    const lineEnd = HL_lineEnd(src, i)
    let p = lineStart
    let spaces = 0
    while (p < lineEnd && src.charCodeAt(p) === 32 && spaces < 3) {
      p += 1
      spaces += 1
    }
    const first = src.charAt(p)
    let run = 0
    if (first === '`' || first === '~') {
      while (p + run < lineEnd && src.charAt(p + run) === first) run += 1
    }

    if (run >= 3) {
      // fenced code block: string token spanning the whole fence (safe subset)
      let end = n
      let search = lineEnd < n ? lineEnd + 1 : n
      while (search < n) {
        const closeLineEnd = HL_lineEnd(src, search)
        let q = search
        let qSpaces = 0
        while (q < closeLineEnd && src.charCodeAt(q) === 32 && qSpaces < 3) {
          q += 1
          qSpaces += 1
        }
        let closeRun = 0
        while (q + closeRun < closeLineEnd && src.charAt(q + closeRun) === first) closeRun += 1
        if (closeRun >= 3) {
          end = closeLineEnd
          break
        }
        search = closeLineEnd < n ? closeLineEnd + 1 : n
      }
      out.push({ start: lineStart, end, type: 'string' })
      i = end
      continue
    }

    // ATX heading: 1-6 '#' then space or end of line
    if (first === '#') {
      let q = p
      let hashes = 0
      while (q < lineEnd && src.charAt(q) === '#' && hashes < 7) {
        q += 1
        hashes += 1
      }
      if (hashes >= 1 && hashes <= 6 && (q >= lineEnd || src.charCodeAt(q) === 32)) {
        out.push({ start: p, end: lineEnd, type: 'typeName' })
        i = lineEnd
        continue
      }
    }

    // blockquote line
    if (first === '>') {
      out.push({ start: p, end: lineEnd, type: 'comment' })
      i = lineEnd
      continue
    }

    // inline code spans and HTML comments
    let j = lineStart
    while (j < lineEnd) {
      const ch = src.charAt(j)
      if (ch === '`') {
        let fence = 0
        while (j + fence < lineEnd && src.charAt(j + fence) === '`') fence += 1
        const marker = src.slice(j, j + fence)
        const close = src.indexOf(marker, j + fence)
        if (close >= 0 && close < lineEnd) {
          out.push({ start: j, end: close + fence, type: 'string' })
          j = close + fence
          continue
        }
        j += fence
        continue
      }
      if (ch === '<' && src.slice(j, j + 4) === '<!--') {
        const close = src.indexOf('-->', j + 4)
        const end = close < 0 ? n : close + 3
        out.push({ start: j, end, type: 'comment' })
        j = end
        continue
      }
      j += 1
    }
    i = lineEnd < n ? lineEnd + 1 : n
  }
  return out
}

// ── html scanner (tags, attributes, comments; script bodies stay plain) ────

function HL_scanHtml(src) {
  const out = []
  const n = src.length
  let i = 0

  while (i < n) {
    if (src.charAt(i) !== '<') {
      i += 1
      continue
    }
    if (src.slice(i, i + 4) === '<!--') {
      const close = src.indexOf('-->', i + 4)
      const end = close < 0 ? n : close + 3
      out.push({ start: i, end, type: 'comment' })
      i = end
      continue
    }
    let j = i + 1
    const marker = src.charAt(j)
    if (marker === '/' || marker === '!' || marker === '?') j += 1
    while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j += 1
    const tagStart = j
    while (j < n && (HL_isIdPart(src.charCodeAt(j)) || src.charAt(j) === '-' || src.charAt(j) === ':')) j += 1
    if (j > tagStart) out.push({ start: tagStart, end: j, type: 'typeName' })
    let closed = false
    while (j < n && !closed) {
      const code = src.charCodeAt(j)
      const ch = src.charAt(j)
      if (ch === '"' || ch === "'") {
        const end = HL_scanEscaped(src, j, code, false)
        out.push({ start: j, end, type: 'string' })
        j = end
        continue
      }
      if (ch === '=') {
        out.push({ start: j, end: j + 1, type: 'operator' })
        j += 1
        continue
      }
      if (ch === '>') {
        out.push({ start: j, end: j + 1, type: 'punctuation' })
        j += 1
        closed = true
        continue
      }
      if (ch === '<') break
      if (HL_isIdStart(code)) {
        const start = j
        while (j < n && (HL_isIdPart(src.charCodeAt(j)) || src.charAt(j) === '-' || src.charAt(j) === ':')) j += 1
        out.push({ start, end: j, type: 'functionName' })
        continue
      }
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
        out.push({ start: j, end: j + 1, type: 'punctuation' })
      }
      j += 1
    }
    if (j <= i) j = i + 1
    i = j
  }
  return out
}

// ── cheap pass for very large sources ──────────────────────────────────────

function HL_scanCheap(src, lang) {
  const out = []
  const n = src.length
  const cap = 6000
  const cfg = HL_lookup(HL_CONFIGS, lang)
  const quoteChars = cfg && cfg.quoteChars ? cfg.quoteChars : HL_QUOTES_JS
  let i = 0

  while (i < n && out.length < cap) {
    const code = src.charCodeAt(i)
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      i += 1
      continue
    }
    const c = src.charAt(i)

    if (cfg && cfg.slashBlock && c === '/' && src.charCodeAt(i + 1) === 42) {
      const close = src.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      out.push({ start: i, end, type: 'comment' })
      i = end
      continue
    }
    if (c === '<' && src.slice(i, i + 4) === '<!--') {
      const close = src.indexOf('-->', i + 4)
      const end = close < 0 ? n : close + 3
      out.push({ start: i, end, type: 'comment' })
      i = end
      continue
    }
    if (cfg && cfg.dashLine && c === '-' && src.charCodeAt(i + 1) === 45) {
      const end = HL_lineEnd(src, i)
      out.push({ start: i, end, type: 'comment' })
      i = end
      continue
    }
    if (cfg && cfg.hashMode && c === '#' && (cfg.hashMode === 1 || HL_isCommentBoundary(src, i))) {
      const end = HL_lineEnd(src, i)
      out.push({ start: i, end, type: 'comment' })
      i = end
      continue
    }
    if (cfg && cfg.slashLine && c === '/' && src.charCodeAt(i + 1) === 47) {
      const end = HL_lineEnd(src, i)
      out.push({ start: i, end, type: 'comment' })
      i = end
      continue
    }
    if ((code === 34 || code === 39 || code === 96) && quoteChars.indexOf(c) >= 0) {
      let end
      if ((code === 34 || code === 39) && src.charCodeAt(i + 1) === code && src.charCodeAt(i + 2) === code) {
        end = HL_scanTriple(src, i, code)
      } else if (code === 96) {
        end = cfg && cfg.bqKind === 'raw' ? HL_scanRaw(src, i, 96) : HL_scanEscaped(src, i, 96, true)
      } else {
        end = HL_scanEscaped(src, i, code, false)
      }
      out.push({ start: i, end, type: 'string' })
      i = end
      continue
    }
    i += 1
  }
  return out
}

// ── public tokenizer ───────────────────────────────────────────────────────

const HL_MAX_SOURCE = 400000

function tokenize(source, language) {
  const src = typeof source === 'string' ? source : ''
  if (!src) return []
  const lang = HL_normalizeLanguage(language)
  if (lang === 'txt') return []
  const cfg = HL_lookup(HL_CONFIGS, lang)
  if (!cfg) return []
  try {
    if (src.length > HL_MAX_SOURCE) return HL_scanCheap(src, lang)
    if (cfg.mode === 'md') return HL_scanMarkdown(src)
    if (cfg.mode === 'html') return HL_scanHtml(src)
    return HL_scanCode(src, cfg)
  } catch (error) {
    return []
  }
}

// ---- file-icons.js ----
/*
 * dsh-linked-workspace — file tree icon specs.
 *
 * Plain data + a pure lookup function: no imports, no DOM, no Node APIs. The
 * build script inlines this file into the browser bundle after stripping the
 * leading `export ` keywords.
 *
 * Public API
 *   fileIconSpec(name, isDir) -> {
 *     shape: 'file' | 'square' | 'circle' | 'folder' | 'folder-open' | 'box',
 *     glyph: '' | short uppercase text (<= 4 chars),
 *     color: '#RRGGBB',
 *     label: { zh, en }
 *   }
 *
 * The renderer draws a glyph/shape in `color`; `label` is the accessible name
 * of the file type (screen readers, tooltips and the icon inventory).
 */

// Internal helpers are ICON_-prefixed so inlining parts cannot collide.
function ICON_lookup(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

// type -> [glyph, color, label.zh, label.en, shape]
const ICON_TYPES = {
  js: ['JS', '#f1e05a', 'JavaScript 文件', 'JavaScript file', 'file'],
  ts: ['TS', '#3178c6', 'TypeScript 文件', 'TypeScript file', 'file'],
  tsx: ['TX', '#3178c6', 'TypeScript JSX 文件', 'TypeScript JSX file', 'file'],
  jsx: ['JX', '#61dafb', 'JavaScript JSX 文件', 'JavaScript JSX file', 'file'],
  py: ['PY', '#3572a5', 'Python 文件', 'Python file', 'file'],
  ipynb: ['NB', '#f37626', 'Jupyter 笔记本', 'Jupyter notebook', 'square'],
  json: ['{}', '#cbcb41', 'JSON 文件', 'JSON file', 'file'],
  md: ['MD', '#519aba', 'Markdown 文档', 'Markdown document', 'file'],
  mdx: ['MDX', '#519aba', 'MDX 文档', 'MDX document', 'file'],
  txt: ['TXT', '#8b949e', '纯文本文件', 'Plain text file', 'file'],
  yaml: ['YML', '#cb171e', 'YAML 文件', 'YAML file', 'file'],
  toml: ['TOML', '#9c4221', 'TOML 文件', 'TOML file', 'file'],
  sh: ['SH', '#89e051', 'Shell 脚本', 'Shell script', 'file'],
  ps1: ['PS', '#012456', 'PowerShell 脚本', 'PowerShell script', 'file'],
  c: ['C', '#555555', 'C 源文件', 'C source file', 'file'],
  h: ['H', '#555555', 'C 头文件', 'C header file', 'file'],
  cpp: ['C+', '#f34b7d', 'C++ 源文件', 'C++ source file', 'file'],
  hpp: ['H+', '#f34b7d', 'C++ 头文件', 'C++ header file', 'file'],
  cs: ['C#', '#178600', 'C# 文件', 'C# file', 'file'],
  rs: ['RS', '#dea584', 'Rust 文件', 'Rust file', 'file'],
  go: ['GO', '#00add8', 'Go 文件', 'Go file', 'file'],
  java: ['JAVA', '#b07219', 'Java 文件', 'Java file', 'file'],
  kt: ['KT', '#a97bff', 'Kotlin 文件', 'Kotlin file', 'file'],
  html: ['<>', '#e34c26', 'HTML 文件', 'HTML file', 'file'],
  css: ['#', '#563d7c', 'CSS 样式表', 'CSS stylesheet', 'file'],
  scss: ['SC', '#c6538c', 'SCSS 样式表', 'SCSS stylesheet', 'file'],
  less: ['LE', '#1d365d', 'Less 样式表', 'Less stylesheet', 'file'],
  sql: ['SQL', '#e38c00', 'SQL 文件', 'SQL file', 'file'],
  csv: ['CSV', '#237346', 'CSV 表格', 'CSV spreadsheet', 'square'],
  tsv: ['TSV', '#237346', 'TSV 表格', 'TSV spreadsheet', 'square'],
  log: ['LOG', '#8b949e', '日志文件', 'Log file', 'file'],
  xml: ['XML', '#e37933', 'XML 文件', 'XML file', 'file'],
  ini: ['INI', '#6d8086', 'INI 配置', 'INI configuration', 'file'],
  cfg: ['CFG', '#6d8086', '配置文件', 'Config file', 'file'],
  env: ['ENV', '#ecd53f', '环境变量文件', 'Environment file', 'file'],
  lock: ['LOCK', '#8b949e', '锁文件', 'Lockfile', 'file'],
  pdf: ['PDF', '#ec1c24', 'PDF 文档', 'PDF document', 'square'],
  image: ['IMG', '#a074c4', '图片', 'Image', 'circle'],
  svg: ['SVG', '#ffb13b', 'SVG 图片', 'SVG image', 'circle'],
  ico: ['ICO', '#a074c4', '图标', 'Icon', 'circle'],
  archive: ['ZIP', '#f0b132', '压缩包', 'Archive', 'box'],
  wasm: ['WASM', '#654ff0', 'WebAssembly 模块', 'WebAssembly module', 'box'],
  pyc: ['PYC', '#3572a5', 'Python 字节码', 'Python bytecode', 'box'],
  pth: ['PTH', '#3572a5', 'Python 路径文件', 'Python path file', 'file'],
  font: ['FONT', '#6d8086', '字体文件', 'Font file', 'circle'],
  video: ['VID', '#f97316', '视频文件', 'Video file', 'circle'],
  audio: ['AUD', '#a855f7', '音频文件', 'Audio file', 'circle'],
  docx: ['DOC', '#2b579a', 'Word 文档', 'Word document', 'square'],
  xlsx: ['XLS', '#217346', 'Excel 表格', 'Excel spreadsheet', 'square'],
  pptx: ['PPT', '#d24726', 'PowerPoint 演示', 'PowerPoint presentation', 'square'],
  vue: ['VUE', '#41b883', 'Vue 组件', 'Vue component', 'file'],
  svelte: ['SVE', '#ff3e00', 'Svelte 组件', 'Svelte component', 'file'],
  docker: ['DOCK', '#2496ed', 'Docker 构建文件', 'Dockerfile', 'file'],
  compose: ['DOCK', '#2496ed', 'Docker Compose 配置', 'Docker Compose config', 'file'],
  make: ['MAKE', '#427819', 'Make 构建文件', 'Makefile', 'file'],
  cmake: ['CMAK', '#064f8c', 'CMake 构建文件', 'CMake build file', 'file'],
  git: ['GIT', '#f14e32', 'Git 配置', 'Git config', 'file'],
  npm: ['NPM', '#cbcb41', 'npm 包清单', 'npm manifest', 'box'],
  npmlock: ['LOCK', '#cb3837', 'npm 锁文件', 'npm lockfile', 'box'],
  npmrc: ['NPM', '#cb3837', 'npm 配置', 'npm config', 'file'],
  pnpm: ['LOCK', '#f69220', 'pnpm 锁文件', 'pnpm lockfile', 'box'],
  yarn: ['LOCK', '#2c8ebb', 'Yarn 锁文件', 'Yarn lockfile', 'box'],
  tsconfig: ['TS', '#3178c6', 'TypeScript 配置', 'TypeScript config', 'box'],
  readme: ['MD', '#519aba', '说明文档', 'README', 'file'],
  license: ['LIC', '#a0a0a0', '许可证', 'License', 'square'],
  pip: ['PY', '#3572a5', 'pip 依赖清单', 'pip requirements', 'file'],
  pythonproj: ['PY', '#3572a5', 'Python 项目配置', 'Python project config', 'box'],
  cargo: ['RS', '#dea584', 'Cargo 清单', 'Cargo manifest', 'box'],
  gomod: ['GO', '#00add8', 'Go 模块文件', 'Go module file', 'file'],
  agents: ['AG', '#519aba', 'Agent 指令', 'Agent instructions', 'file'],
  claude: ['CL', '#d97757', 'Claude 指令', 'Claude instructions', 'file'],
  editorconfig: ['ECFG', '#8b949e', '编辑器配置', 'Editor config', 'file'],
  unknown: ['', '#8b949e', '文件', 'File', 'file']
}

// extension -> type
const ICON_EXTENSIONS = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  es6: 'js',
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  jsx: 'jsx',
  tsx: 'tsx',
  py: 'py',
  pyi: 'py',
  pyw: 'py',
  ipynb: 'ipynb',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  geojson: 'json',
  webmanifest: 'json',
  md: 'md',
  mdx: 'mdx',
  markdown: 'md',
  mdown: 'md',
  txt: 'txt',
  text: 'txt',
  log: 'log',
  rst: 'txt',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  ksh: 'sh',
  fish: 'sh',
  bat: 'sh',
  cmd: 'sh',
  ps1: 'ps1',
  psm1: 'ps1',
  c: 'c',
  h: 'h',
  cpp: 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  'c++': 'cpp',
  hpp: 'hpp',
  hxx: 'hpp',
  hh: 'hpp',
  ipp: 'cpp',
  cs: 'cs',
  csx: 'cs',
  rs: 'rs',
  go: 'go',
  java: 'java',
  jav: 'java',
  kt: 'kt',
  kts: 'kt',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  vue: 'vue',
  svelte: 'svelte',
  xml: 'xml',
  svg: 'svg',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  sql: 'sql',
  mysql: 'sql',
  pgsql: 'sql',
  csv: 'csv',
  tsv: 'tsv',
  ini: 'ini',
  conf: 'cfg',
  cfg: 'cfg',
  properties: 'ini',
  env: 'env',
  gitconfig: 'ini',
  npmrc: 'ini',
  lock: 'lock',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  avif: 'image',
  ico: 'ico',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  '7z': 'archive',
  rar: 'archive',
  wasm: 'wasm',
  pyc: 'pyc',
  pth: 'pth',
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
  eot: 'font',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  aac: 'audio',
  docx: 'docx',
  doc: 'docx',
  xlsx: 'xlsx',
  xls: 'xlsx',
  pptx: 'pptx',
  ppt: 'pptx'
}

// exact (lower-cased) file name -> type
const ICON_SPECIAL = {
  'package.json': 'npm',
  'package-lock.json': 'npmlock',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'tsconfig.json': 'tsconfig',
  dockerfile: 'docker',
  'docker-compose.yml': 'compose',
  'docker-compose.yaml': 'compose',
  makefile: 'make',
  gnumakefile: 'make',
  'cmakelists.txt': 'cmake',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.env': 'env',
  readme: 'readme',
  'readme.md': 'readme',
  'readme.txt': 'readme',
  license: 'license',
  'license.md': 'license',
  'license.txt': 'license',
  licence: 'license',
  'requirements.txt': 'pip',
  'pyproject.toml': 'pythonproj',
  'setup.py': 'pythonproj',
  'cargo.toml': 'cargo',
  'go.mod': 'gomod',
  'go.sum': 'gomod',
  'agents.md': 'agents',
  'claude.md': 'claude',
  '.npmrc': 'npmrc',
  '.editorconfig': 'editorconfig'
}

// Prefix rules catch common variants (Dockerfile.dev, tsconfig.build.json, ...).
function ICON_specialType(base) {
  const exact = ICON_lookup(ICON_SPECIAL, base)
  if (exact) return exact
  if (base.indexOf('dockerfile') === 0 || base.indexOf('containerfile') === 0) return 'docker'
  if (base.indexOf('docker-compose') === 0 || base.indexOf('compose.') === 0) return 'compose'
  if (base.indexOf('makefile') === 0) return 'make'
  if (base.indexOf('readme') === 0) return 'readme'
  if (base.indexOf('license') === 0 || base.indexOf('licence') === 0 || base.indexOf('copying') === 0) return 'license'
  if (base.indexOf('.env') === 0) return 'env'
  if (base.indexOf('tsconfig') === 0) return 'tsconfig'
  if (base.indexOf('requirements') === 0 && base.length > 4 && base.slice(-4) === '.txt') return 'pip'
  if (base.indexOf('cargo.') === 0) return 'cargo'
  return ''
}

// Copy the descriptor into a fresh spec object so callers can never mutate the
// shared tables by accident.
function ICON_spec(typeName) {
  const desc = ICON_lookup(ICON_TYPES, typeName) || ICON_TYPES.unknown
  return {
    shape: desc[4],
    glyph: desc[0],
    color: desc[1],
    label: { zh: desc[2], en: desc[3] }
  }
}

function fileIconSpec(name, isDir) {
  if (isDir) {
    return {
      shape: 'folder',
      glyph: '',
      color: '#dcb67a',
      label: { zh: '文件夹', en: 'Folder' }
    }
  }
  if (typeof name !== 'string' || !name) return ICON_spec('unknown')

  const normalized = name.replace(/\\/g, '/')
  const cut = normalized.lastIndexOf('/')
  const base = (cut >= 0 ? normalized.slice(cut + 1) : normalized).toLowerCase()
  if (!base) return ICON_spec('unknown')

  const special = ICON_specialType(base)
  if (special) return ICON_spec(special)

  const dot = base.lastIndexOf('.')
  if (dot >= 0) {
    const extension = base.slice(dot + 1)
    const type = ICON_lookup(ICON_EXTENSIONS, extension)
    if (type) return ICON_spec(type)
  }
  return ICON_spec('unknown')
}

    var TREE_TAB_TYPE = 'dsh-linked-workspace';
    var REMOTE_TAB_TYPE = 'dsh-linked-workspace:remote';
    var linkedLocalKeys = new Set();
    var linkedWorkspaceKeys = new Set();
    var hasRemoteDirectories = false;
    var linkedTabDisposer = null;
    var remoteTabDisposer = null;
    var syncDirectoryTabsRef = null;

    function linkedScopeKey(cwd) {
      return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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

    function dismissSettingsOverlay() {
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      } catch (error) { /* keyboard unavailable */ }
    }

    function rememberDirectoryAvailability(links, workspaces) {
      var next = new Set();
      var workspaceKeys = new Set();
      (links || []).forEach(function (link) {
        var key = linkedScopeKey(link.localPath);
        if (key) next.add(key);
        if (link.workspaceId) workspaceKeys.add(String(link.workspaceId));
      });
      linkedLocalKeys = next;
      linkedWorkspaceKeys = workspaceKeys;
      hasRemoteDirectories = Array.isArray(workspaces) && workspaces.length > 0;
    }

    function refreshDirectoryAvailability() {
      return Promise.all([
        apiCall('linked.list').catch(function () { return { links: [] }; }),
        apiCall('workspaces.list').catch(function () { return { workspaces: [] }; }),
      ]).then(function (results) {
        var links = results[0] && results[0].links ? results[0].links : [];
        var workspaces = results[1] && results[1].workspaces ? results[1].workspaces : [];
        rememberDirectoryAvailability(links, workspaces);
        publishLinkedWorkspaceIcons(links);
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
      settingsNav: '连接',
      title: '连接与联动工作区',
      intro: '把已建立的 SSH 连接变成远程目录；或把本地目录与远端目录联动起来——会话可以直接读取、搜索和编辑远端文件。',
      addWorkspace: '添加工作区',
      addRemoteDir: '添加远程目录',
      addLinked: '添加联动工作区',
      createLinked: '创建联动工作区',
      addAction: '添加',
      addShort: '添加',
      refresh: '刷新',
      open: '打开',
      openSidebar: '打开右侧栏',
      test: '测试',
      remove: '移除',
      confirmRemove: '确认移除',
      removeHint: '只移除记录，不会删除远端文件。',
      emptyTitle: '还没有远程目录',
      emptyBody: '选择一个已建立的 SSH 连接，就能把远端目录加进侧边栏。',
      emptyHint: '没有找到可用的 SSH 连接。请先在右侧栏的 SSH Tunnel 面板里添加主机。',
      stepHost: '1. 选择 SSH 连接',
      stepPath: '2. 远程目录',
      stepLocalPath: '3. 本地目录',
      stepName: '4. 工作区名称',
      pathPlaceholder: '/shared_data_ssd1/huangjh/project',
      localPathPlaceholder: 'C:\\Users\\you\\projects\\demo',
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
      noWorkspace: '远程工作区不存在，请重新添加。',
      noTarget: '没有可用的远程目录。先在设置 → 连接中添加，或点击左侧「添加工作区」。',
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
      noCredential: '缺少凭据',
      sourceManagerShort: 'SSH',
      remoteGroup: '远程目录',
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
      remoteTabTitle: '远程目录',
      remoteTabDesc: '只读查看已添加的远程目录及其文件，不允许编辑。',
      remoteDirsTitle: '远程目录',
      remoteDirsHint: '直接浏览远端目录（只读）。',
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
      settingsNav: 'Connections',
      title: 'Connections & Linked Workspaces',
      intro: 'Turn an existing SSH connection into a remote directory, or pair a local folder with a remote folder so sessions can read, search and edit remote files directly.',
      addWorkspace: 'Add workspace',
      addRemoteDir: 'Add remote directory',
      addLinked: 'Add linked workspace',
      createLinked: 'Create linked workspace',
      addAction: 'Add',
      addShort: 'Add',
      refresh: 'Refresh',
      open: 'Open',
      openSidebar: 'Open sidebar',
      test: 'Test',
      remove: 'Remove',
      confirmRemove: 'Confirm remove',
      removeHint: 'Removes the record only; remote files stay untouched.',
      emptyTitle: 'No remote directories yet',
      emptyBody: 'Pick an SSH connection you already set up to bring a remote directory into the sidebar.',
      emptyHint: 'No SSH connections found. Add a host in the Side card’s SSH Tunnel panel first.',
      stepHost: '1. Choose an SSH connection',
      stepPath: '2. Remote directory',
      stepLocalPath: '3. Local directory',
      stepName: '4. Workspace name',
      pathPlaceholder: '/home/you/project',
      localPathPlaceholder: 'C:\\Users\\you\\projects\\demo',
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
      noWorkspace: 'This remote workspace no longer exists. Add it again.',
      noTarget: 'No remote directory is available. Add one in Settings → Connections, or click “Add workspace” on the left.',
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
      noCredential: 'No credentials',
      sourceManagerShort: 'SSH',
      remoteGroup: 'Remote directories',
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
      remoteTabTitle: 'Remote directories',
      remoteTabDesc: 'Read-only view of configured remote directories and files; editing is disabled.',
      remoteDirsTitle: 'Remote directories',
      remoteDirsHint: 'Browse remote directories read-only (no local copy).',
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
        CONFLICT: 'The remote file changed',
        BAD_REQUEST: 'Invalid request',
      },
    };

    function messageOf(error, t, locale) {
      if (!error) return '';
      var known = error.code ? (locale === 'zh' ? CODE_TEXT.zh : CODE_TEXT.en)[error.code] : '';
      if (known) return error.code === 'BAD_REQUEST' && error.message ? error.message : known;
      return error.message || String(error);
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
      return '';
    }

    function sanitizeDocumentHtml(html) {
      try {
        var parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
        parsed.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form').forEach(function (node) { node.remove(); });
        parsed.querySelectorAll('*').forEach(function (element) {
          Array.from(element.attributes).forEach(function (attribute) {
            if (/^on/i.test(attribute.name) || /^javascript:/i.test(attribute.value) || /^data:text\/html/i.test(attribute.value)) {
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
      '.rw-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}',
      '.rw-btn-primary:hover{filter:brightness(1.06)}',
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
      '.rw-switch input:checked + .rw-switch-track .rw-switch-thumb{transform:translateX(12px);background:#fff}',
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
      '.rw-props{display:grid;grid-template-columns:70px minmax(0,1fr);gap:5px 9px;font-size:12px;line-height:18px}',
      '.rw-props-key{color:var(--dsw-alias-label-tertiary)}',
      '.rw-props-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
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

    // ── linked workspace row icon ──────────────────────────────────────────
    // DSH renders a fixed folder glyph for every workspace row; the sidebar
    // gives plugins no per-row icon slot. This stylesheet swaps that glyph for
    // a link icon on rows of linked workspaces (identified by the documented
    // data-row-key attribute). If the host markup ever changes the selector
    // simply stops matching and the folder glyph stays — a safe degradation.

    var LINK_ICON_MASK = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M6.4 9.6a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-1 1"/>'
      + '<path d="M9.6 6.4a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l1-1"/>'
      + '</svg>',
    );

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

    function publishLinkedWorkspaceIcons(links) {
      var tag = workspaceIconStyleTag();
      if (!tag) return;
      var mask = 'url("data:image/svg+xml,' + LINK_ICON_MASK + '")';
      var rules = (links || []).map(function (link) {
        var id = link && link.workspaceId ? String(link.workspaceId).replace(/[^0-9a-zA-Z-]/g, '') : '';
        if (id === '') return '';
        var row = '[data-row-key="workspace:' + id + '"] > span:first-child';
        var rule = row + '{display:inline-flex;align-items:center;justify-content:center;flex:none;}'
          + row + ' svg{display:none!important;}'
          + row + '::before{content:"";display:block;width:14px;height:14px;background:currentColor;'
          + '-webkit-mask:' + mask + ' center/contain no-repeat;mask:' + mask + ' center/contain no-repeat;}';
        if (link.running) rule += row + '::before{background:#2f81f7!important}';
        return rule;
      }).filter(function (rule) { return rule !== ''; });
      tag.textContent = rules.join('\n');
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
      var dataState = useState({ loading: true, hosts: [], workspaces: [], links: [], error: null, hostError: null, linkError: null });
      var data = dataState[0];
      var setData = dataState[1];
      var alive = useRef(true);

      var load = useCallback(function () {
        var jobs = [
          apiCall('workspaces.list').then(function (result) { return { workspaces: result.workspaces || [] }; }),
          apiCall('hosts.list').then(function (result) { return { hosts: result.hosts || [] }; }),
          apiCall('linked.list').then(function (result) { return { links: result.links || [] }; }),
        ];
        return Promise.all(jobs.map(function (promise) {
          return promise.then(function (value) { return { ok: true, value: value }; }, function (error) { return { ok: false, error: error }; });
        })).then(function (results) {
          if (!alive.current) return;
          var workspacesResult = results[0];
          var hostsResult = results[1];
          var linksResult = results[2];
          setData(function (previous) {
            return {
              loading: false,
              workspaces: workspacesResult.ok ? workspacesResult.value.workspaces : previous.workspaces,
              hosts: hostsResult.ok ? hostsResult.value.hosts : previous.hosts,
              links: linksResult.ok ? linksResult.value.links : previous.links,
              error: workspacesResult.ok ? null : workspacesResult.error,
              hostError: hostsResult.ok ? null : hostsResult.error,
              linkError: linksResult.ok ? null : linksResult.error,
            };
          });
          rememberDirectoryAvailability(linksResult.ok ? linksResult.value.links : [], workspacesResult.ok ? workspacesResult.value.workspaces : []);
          publishLinkedWorkspaceIcons(linksResult.ok ? linksResult.value.links : []);
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

    function StatusPill(props) {
      var t = props.t;
      var status = props.status || { state: 'idle' };
      var cls = status.state === 'connected' ? 'rw-dot-ok' : status.state === 'error' ? 'rw-dot-error' : '';
      var label = status.state === 'connected' ? t('connected') : status.state === 'error' ? t('errorState') : t('idle');
      var title = status.state === 'error' ? status.message || '' : status.state === 'connected' && status.latencyMs ? t('latency') + ' ' + status.latencyMs + ' ms' : '';
      return h('span', { className: 'rw-chip', title: title || label },
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
      var state = useState({ loading: true, listing: null, error: '', input: initialPath, creating: false, folderName: '' });
      var local = state[0];
      var setLocal = state[1];

      var load = useCallback(function (path) {
        setLocal(function (previous) { return Object.assign({}, previous, { loading: true, error: '', input: path || previous.input }); });
        apiCall('local.browse', path ? { path: path } : {}).then(function (result) {
          setLocal(function (previous) {
            return Object.assign({}, previous, { loading: false, listing: result, error: '', input: result.path });
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
        h('div', { className: 'rw-browser-list', role: 'list' },
          local.error
            ? h('div', { className: 'rw-row-msg' }, IconAlert(12), local.error)
            : entries.length === 0
              ? h('div', { className: 'rw-row-msg' }, t('emptyFolder'))
              : entries.map(function (entry) {
                return h('button', {
                  key: entry.path, type: 'button', className: 'rw-browser-row', role: 'listitem',
                  onClick: function () { navigate(entry.path); },
                }, h('span', { className: 'rw-dir-icon' }, IconFolder(13, false)), h('span', null, entry.name));
              })),
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
              disabled: !listing || local.loading,
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
      var state = useState({ loading: true, listing: null, error: '', input: props.initialPath || '' });
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
            return Object.assign({}, previous, { loading: false, listing: result, error: '', input: result.path });
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
        h('div', { className: 'rw-browser-list', role: 'list' },
          remote.error
            ? h('div', { className: 'rw-row-msg' }, IconAlert(12), remote.error)
            : dirs.length === 0
              ? h('div', { className: 'rw-row-msg' }, t('noEntries'))
              : dirs.map(function (entry) {
                return h('button', {
                  key: entry.path, type: 'button', className: 'rw-browser-row', role: 'listitem',
                  onClick: function () { navigate(entry.path); },
                }, h('span', { className: 'rw-dir-icon' }, IconFolder(13, false)), h('span', null, entry.name));
              })),
        h('div', { className: 'rw-browser-actions', style: { padding: '8px' } },
          h('span', { className: 'rw-hint rw-input-mono', title: remote.input || (listing && listing.path) || '' },
            (listing && listing.path) || (remote.input !== '' ? remote.input : t('home'))),
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary',
            disabled: !listing || remote.loading,
            onClick: function () { if (listing && props.onPick) props.onPick(listing.path); },
          }, IconCheck(12), t('useThisDir'))));
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
      var sidebar = ctx.get && ctx.get('betterSidebar');
      var settings = useRuntimeSettings();
      var theme = getTheme(resolveEditorTheme(settings));
      var language = languageOf(filePath);

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
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-sm', onClick: function () { loadFile(); },
            disabled: load.loading || save.saving,
          }, IconRefresh(12), t('reload')),
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary', onClick: function () { saveFile(false); },
            disabled: !editable || save.saving,
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
      var body = canView
        ? h('div', { className: 'rw-editor-body' },
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
              }))))
        : h('div', { className: 'rw-editor-message' }, notice, h('span', { className: 'rw-muted' }, t('readOnly')));

      return h('div', { className: 'rw-editor', style: containerStyle },
        header,
        banner ? h('div', { style: { padding: '8px 10px 0' } }, banner) : null,
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
          h('span', { className: 'rw-fill', style: { flex: '1 1 auto' } }),
          h('span', { className: 'rw-status-chip' }, h('span', { className: 'rw-kbd' }, 'Ctrl'), h('span', { className: 'rw-kbd' }, 'S'))));
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
      return { kind: 'workspace', id: source ? source.id : '' };
    }

    function sourceMetaOf(source) {
      return source && source.kind === 'linked'
        ? { linkedId: source.id, linkedName: source.name }
        : { workspaceId: source ? source.id : undefined, workspaceName: source ? source.name : undefined };
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

      useEffect(function () {
        if (!props.refreshTick) return;
        Array.from(expanded).forEach(function (path) { load(path, true); });
      }, [props.refreshTick]);

      function toggle(path) {
        setExpanded(function (previous) {
          var next = new Set(previous);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      }

      function load(path, silent) {
        if (pending.current.has(path)) return;
        pending.current.add(path);
        setCache(function (previous) {
          var entries = new Map(previous.entries);
          var existing = entries.get(path) || {};
          entries.set(path, { loading: !silent, error: null, entries: existing.entries || [], loaded: existing.loaded });
          return { entries: entries };
        });
        var request = props.kind === 'local'
          ? apiCall('local.list', { path: path })
          : apiCall('fs.list', Object.assign({ path: path }, scopeParams(props.scope)));
        request.then(function (result) {
          pending.current.delete(path);
          var entries = result.entries || [];
          if (!props.showHidden) {
            entries = entries.filter(function (entry) { return String(entry.name || '').charAt(0) !== '.'; });
          }
          setCache(function (previous) {
            var next = new Map(previous.entries);
            next.set(path, { loading: false, error: null, loaded: true, entries: entries });
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

      return h(TreeDirectory, {
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
        onSelect: props.onSelect,
        onPin: props.onPin,
        onSelectPath: props.onSelectPath,
        onContextMenu: props.onContextMenu,
        selectedPath: props.selectedPath || '',
      });
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
      function submit() { if (value.trim() !== '') props.onSubmit(value.trim()); }
      return h(DialogShell, { title: props.title, onClose: props.onClose },
        h('label', { className: 'rw-dialog-label' }, props.label),
        h('input', {
          className: 'rw-dialog-input',
          value: value,
          autoFocus: true,
          spellCheck: false,
          onChange: function (event) { setValue(event.currentTarget.value); },
          onKeyDown: function (event) { if (event.key === 'Enter') submit(); },
        }),
        h('div', { className: 'rw-dialog-actions' },
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: props.onClose }, props.t('cancel')),
          h('button', { type: 'button', className: 'rw-btn rw-btn-sm rw-btn-primary', onClick: submit }, props.t('confirm'))));
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

    function QueueDialog(props) {
      return h(DialogShell, { title: props.title, onClose: props.onClose },
        props.queue.length === 0
          ? h('div', { className: 'rw-dialog-message' }, props.t('queueEmpty'))
          : props.queue.map(function (entry) {
            return h('div', { key: entry.id, className: 'rw-queue-row' },
              h('span', { className: 'rw-queue-label', title: entry.path }, entry.label),
              h('span', { className: 'rw-queue-state' }, entry.message || entry.state));
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
      });
      var state = stateRef[0];
      var setState = stateRef[1];

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
          if (!mod || String(event.key || '').toLowerCase() !== 's') return;
          event.preventDefault();
          saveRef.current();
        }
        window.addEventListener('keydown', onKey, true);
        return function () { window.removeEventListener('keydown', onKey, true); };
      }, [props.visible]);

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
            h('textarea', {
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
      var sidebar = ctx.get && ctx.get('betterSidebar');
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
        var list = [];
        var scopeKey = linkedScopeKey(scope && scope.cwd);
        if (!remoteOnly) {
          (data.data.links || []).forEach(function (link) {
            if (pinnedLinkedId) { if (String(link.id) !== pinnedLinkedId) return; }
            else if (scopeKey && linkedScopeKey(link.localPath) !== scopeKey) return;
            list.push({
              key: 'linked:' + link.id,
              kind: 'linked',
              id: link.id,
              name: link.name,
              localPath: link.localPath,
              remotePath: link.remotePath,
              host: link.host,
              username: link.username,
              hostName: link.hostName,
              mirror: link.mirror,
              status: link.status,
            });
          });
        } else {
          (data.data.workspaces || []).forEach(function (workspace) {
            if (pinnedRemoteId && String(workspace.id) !== pinnedRemoteId) return;
            list.push({
              key: 'workspace:' + workspace.id,
              kind: 'workspace',
              id: workspace.id,
              name: workspace.name,
              localPath: null,
              remotePath: workspace.remotePath,
              host: workspace.host,
              username: workspace.username,
              hostName: workspace.hostName,
              mirror: false,
              status: workspace.status,
            });
          });
        }
        return list;
      }, [data.data.links, data.data.workspaces, remoteOnly, scope && scope.cwd, pinnedLinkedId, pinnedRemoteId]);

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

      function updateOpenMode(next) {
        apiCall('settings.update', { fileOpenMode: next }).then(function (result) {
          runtimeSettings.apply({ fileOpenMode: result && result.fileOpenMode ? result.fileOpenMode : next });
          showNotice('success', t('openModeSaved'));
        }).catch(function (error) {
          showNotice('error', messageOf(error, t, locale));
        });
      }

      function openTerminal(side) {
        if (!selected) return;
        var request = { side: side };
        if (selected.kind === 'linked') request.linkedId = selected.id;
        else request.workspaceId = selected.id;
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

      function submitNew(side, dirPath, name, isDir) {
        var target = joinChildPath(dirPath, name, side);
        var docKind = documentKindOf(name);
        var promise;
        if (isDir) {
          promise = side === 'remote'
            ? apiCall('fs.mkdir', Object.assign({ path: target }, scopeParams(scopeRef)))
            : apiCall('local.mkdir', { path: dirPath, name: name });
        } else if (docKind) {
          promise = side === 'remote'
            ? apiCall('docs.create', Object.assign({ path: target, kind: docKind }, scopeParams(scopeRef)))
            : apiCall('docs.create', { path: target, kind: docKind });
        } else {
          promise = side === 'remote'
            ? apiCall('fs.write', Object.assign({ path: target, content: '' }, scopeParams(scopeRef)))
            : apiCall('local.newFile', { path: target });
        }
        promise.then(function () {
          showNotice('success', t('newDone'));
          refreshTree();
          if (!isDir && docKind) openInternalFile(side, target);
        }).catch(noticeError);
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
        setDialog(null);
        if (current.kind === 'rename') submitRenamed(current.side, current.path, value);
        else if (current.kind === 'new') submitNew(current.side, current.dir, value, current.isDir);
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
          items.push({ label: t('ctxNew'), sub: [
            { label: t('ctxNewFolder'), onSelect: function () {
              setDialog({ kind: 'new', side: menu.side, dir: menu.path, isDir: true, title: t('newFolderTitle'), label: t('nameLabel'), value: t('newFolderTitle') });
            } },
            { label: t('ctxNewFile'), onSelect: function () {
              setDialog({ kind: 'new', side: menu.side, dir: menu.path, isDir: false, title: t('newFileTitle'), label: t('nameLabel'), value: t('newFileTitle') });
            } },
          ] });
        }
        items.push({ separator: true });
        items.push({ label: t('ctxProperties'), onSelect: function () { showProperties(menu.side, menu.path); } });
        return items;
      }

      function renderDialog() {
        if (!dialog) return null;
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
          title: dialog.title,
          label: dialog.label,
          value: dialog.value,
          onClose: function () { setDialog(null); },
          onSubmit: function (value) { submitDialog(dialog, value); },
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
          setSearch(function (previous) { return { loading: true, remote: previous.remote, local: previous.local, error: null }; });
          var scopeNow = sourceScopeOf(selected);
          var jobs = [apiCall('fs.search', Object.assign({ side: 'remote', query: query, maxResults: 200 }, scopeParams(scopeNow))).catch(function (error) {
            return { ok: false, entries: [], error: messageOf(error, t, locale) };
          })];
          if (selected.kind === 'linked') {
            jobs.push(apiCall('fs.search', Object.assign({ side: 'local', query: query, maxResults: 200 }, scopeParams(scopeNow))).catch(function (error) {
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
              error: (results[0] && results[0].error) || (results[1] && results[1].error) || null,
            });
          });
        }, 320);
        return function () { alive = false; clearTimeout(timer); };
      }, [searchOpen, searchQuery, selectedKey, version]);

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
            icon: IconServer(11),
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
            onSelectPath: function (info) { setSelectedEntry(Object.assign({ side: 'remote' }, info)); },
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
              onSelectPath: function (info) { setSelectedEntry(Object.assign({ side: 'local' }, info)); },
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
        ? (activeDocKind
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
          transferEnabled: !remoteOnly && Boolean(selectedEntry),
          transferSelected: function () {
            if (!selectedEntry) {
              showNotice('info', t('selectFirst'));
              return;
            }
            enqueueTransfer(selectedEntry.side, selectedEntry.path, selectedEntry.name);
          },
          onMode: function (next) { setMode(next); },
          onToggleSearch: function () { setSearchOpen(!searchOpen); },
          onOpenMode: updateOpenMode,
          onRefresh: refreshAll,
        }),
        searchOpen
          ? h('div', { className: 'rw-searchbar' },
            IconSearch(13),
            h('input', {
              value: searchQuery,
              placeholder: t('searchPlaceholder'),
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
                title: source.name + ' · ' + source.remotePath,
                onClick: function () { setSelectedKey(source.key); },
              }, source.kind === 'linked' ? IconLink(11) : IconServer(11), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, source.name));
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
                onSelect: onSelect,
                onPin: onPin,
                onSelectPath: onSelectPath,
                onContextMenu: onContextMenu,
                selectedPath: selectedPath,
              }));
            } else if (child.type === 'file' || child.type === 'symlink') {
              var active = selectedPath === child.path;
              children.push(h('button', {
                key: child.path,
                type: 'button',
                className: 'rw-row' + (active ? ' is-active' : ''),
                style: { paddingLeft: 6 + (depth + 1) * 12 },
                title: child.path,
                onClick: function (event) {
                  if (onSelectPath) onSelectPath({ path: child.path, name: child.name, isDir: false });
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
        }
      }

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'rw-row' + (selectedPath === path ? ' is-active' : ''),
          style: { paddingLeft: 6 + depth * 12 },
          title: path,
          onClick: function (event) {
            if (onSelectPath) onSelectPath({ path: path, name: name, isDir: true });
            if (event.detail !== 2) toggle(path);
          },
          onContextMenu: function (event) {
            if (!onContextMenu) return;
            event.preventDefault();
            event.stopPropagation();
            onContextMenu({ path: path, name: name, isDir: true, event: event });
          },
          'aria-expanded': isOpen,
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

      function load(path) {
        setCache(function (previous) {
          var record = previous.entries.get(path);
          if (record && record.loading) return previous;
          var entries = new Map(previous.entries);
          var existing = entries.get(path) || {};
          entries.set(path, { loading: true, error: null, entries: existing.entries || [], loaded: existing.loaded });
          return { entries: entries };
        });
        var request = source.kind === 'linked'
          ? { linkedId: source.id, path: path }
          : { workspaceId: source.id, path: path };
        apiCall('fs.list', request).then(function (result) {
          setCache(function (previous) {
            var entries = new Map(previous.entries);
            entries.set(path, { loading: false, error: null, loaded: true, entries: result.entries || [] });
            return { entries: entries };
          });
          setExpanded(function (previous) {
            var next = new Set(previous);
            next.add(path);
            return next;
          });
        }).catch(function (error) {
          setCache(function (previous) {
            var entries = new Map(previous.entries);
            entries.set(path, { loading: false, error: error, loaded: false, entries: [] });
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
        },
          h('span', { className: 'rw-chevron' + (open ? ' is-open' : '') }, IconChevron(12)),
          h('span', { className: 'rw-icon-chip' + (source.kind === 'linked' ? ' rw-icon-chip-link' : ''), style: { width: 24, height: 24, borderRadius: 7 } },
            source.kind === 'linked' ? IconLink(13) : IconServer(13)),
          h('span', { className: 'rw-tree-ws-title' },
            h('span', { className: 'rw-tree-ws-name' }, source.name),
            h('span', { className: 'rw-tree-ws-sub' }, source.username + '@' + source.host + (source.kind === 'linked' ? ' · ' + t('linkedChip') : ''))),
          h(StatusPill, { status: source.status, t: t })),
        open
          ? h('div', { className: 'rw-tree-body' },
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
            disabled: !usable,
            title: usable ? host.name : t('noCredential'),
            className: 'rw-host' + (on ? ' is-on' : ''),
            onClick: function () { if (usable && props.onSelect) props.onSelect(host); },
          },
            h('span', { className: 'rw-file-icon', style: { color: on ? 'var(--dsw-alias-brand-primary)' : undefined } }, IconServer(16)),
            h('span', { className: 'rw-host-main' },
              h('span', { className: 'rw-host-name' }, host.name),
              h('span', { className: 'rw-host-meta' }, host.username + '@' + host.host + ':' + host.port)),
            usable
              ? h('span', { className: 'rw-chip' }, host.source === 'ssh-config' ? t('sourceConfig') : t('sourceManager'))
              : h('span', { className: 'rw-chip', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, t('noCredential')));
        }));
    }

    function AddWorkspaceFlow(props) {
      var ctx = props.ctx;
      var t = props.t;
      var locale = props.locale;
      var onDone = props.onDone;
      var onCancel = props.onCancel;
      var lockedMode = props.lockedMode === 'linked' ? 'linked' : props.lockedMode === 'remote' ? 'remote' : '';
      var modeState = useState(lockedMode || (props.initialMode === 'linked' ? 'linked' : 'remote'));
      var mode = lockedMode || modeState[0];
      var setMode = modeState[1];

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
        setError('');
        setRemoteOpen(false);
        if (remotePath.trim() === '' && host && host.hasCredential !== false) {
          apiCall('hosts.browse', { hostId: host.id }).then(function (result) {
            setRemotePath(function (current) { return current.trim() === '' ? result.home : current; });
          }).catch(function () { /* silent prefill */ });
        }
      }

      function submit() {
        if (busy) return;
        if (!selectedHostId) { setError(t('stepHost')); return; }
        var trimmedRemote = remotePath.trim();
        if (trimmedRemote === '') { setError(t('stepPath')); return; }
        setBusy(true);
        setError('');
        if (mode === 'remote') {
          apiCall('workspaces.add', {
            hostId: selectedHostId,
            remotePath: trimmedRemote,
            name: name.trim(),
          }).then(function () {
            setBusy(false);
            bus.emit();
            if (onDone) onDone();
          }).catch(function (err) {
            setBusy(false);
            setError(t('addFailed') + '：' + messageOf(err, t, locale));
          });
          return;
        }
        var trimmedLocal = localPath.trim();
        if (trimmedLocal === '') { setBusy(false); setError(t('stepLocalPath')); return; }
        apiCall('linked.create', {
          hostId: selectedHostId,
          remotePath: trimmedRemote,
          localPath: trimmedLocal,
          name: name.trim(),
          mirror: mirror,
        }).then(function () {
          setBusy(false);
          bus.emit();
          if (onDone) onDone();
        }).catch(function (err) {
          setBusy(false);
          setError(t('addLinkedFailed') + '：' + messageOf(err, t, locale));
        });
      }

      if (props.submitRef) props.submitRef.current = { submit: submit, busy: busy, mode: mode };

      return h('div', { className: 'rw-add' },
        h('div', { className: 'rw-inline', style: { justifyContent: 'space-between' } },
          h('div', { className: 'rw-add-title' }, mode === 'linked' ? t('createLinked') : t('addRemoteDir')),
          lockedMode === ''
            ? h('div', { className: 'rw-tabs' },
              h('button', { type: 'button', className: 'rw-tab' + (mode === 'remote' ? ' is-on' : ''), onClick: function () { setMode('remote'); } }, IconServer(13), t('remoteGroup')),
              h('button', { type: 'button', className: 'rw-tab' + (mode === 'linked' ? ' is-on' : ''), onClick: function () { setMode('linked'); } }, IconLink(13), t('linkedName')))
            : null),
        h('div', { className: 'rw-field' },
          h('div', { className: 'rw-label' }, t('stepHost')),
          h(HostList, { t: t, hosts: hostData.hosts, loading: hostData.loading, selectedId: selectedHostId, onSelect: chooseHost }),
          hostData.error ? h(Banner, { kind: 'error' }, t('hostsFailed') + '：' + messageOf(hostData.error, t, locale)) : null),
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
        mode === 'linked'
          ? h('div', { className: 'rw-field' },
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
            h('div', { className: 'rw-hint' }, t('mirrorHint')))
          : null,
        mode === 'linked'
          ? h('div', { className: 'rw-field' },
            h('div', { className: 'rw-label' }, t('stepName')),
            h('input', {
              className: 'rw-input',
              value: name,
              placeholder: basename(localPath) || t('namePlaceholder'),
              maxLength: 120,
              onChange: function (event) { setName(event.currentTarget.value); },
              onKeyDown: function (event) { if (event.key === 'Enter') submit(); },
            }))
          : null,
        error ? h(Banner, { kind: 'error' }, error) : null,
        props.compact ? null : h('div', { className: 'rw-actions' },
          h('button', { type: 'button', className: 'rw-btn', disabled: busy, onClick: onCancel }, t('cancel')),
          h('button', {
            type: 'button', className: 'rw-btn rw-btn-primary',
            disabled: busy || !selectedHostId || remotePath.trim() === '' || (mode === 'linked' && localPath.trim() === ''),
            onClick: submit,
          }, busy ? Spinner(13) : (mode === 'linked' ? IconLink(13) : IconPlus(13)), busy ? t('creating') : (mode === 'linked' ? t('create') : t('addAction')))));
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
        if (target === '' || localBusy) return;
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

      if (!props.open) return null;

      return h('div', { className: 'rw-modal-backdrop', role: 'presentation' },
        h('div', { className: 'rw-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('flowTitle') },
          h('div', { className: 'rw-modal-head' },
            h('span', { className: 'rw-icon-chip' }, IconLink(16)),
            h('span', { className: 'rw-modal-title' }, t('flowTitle')),
            h('button', { type: 'button', className: 'rw-icon-btn', title: t('cancel'), onClick: function () { if (props.onCancel) props.onCancel(); } }, IconClose(14))),
          h('div', { className: 'rw-modal-body' },
            h('div', { className: 'rw-tabs' },
              h('button', { type: 'button', className: 'rw-tab' + (flow === 'local' ? ' is-on' : ''), onClick: function () { setFlow('local'); } }, IconFolder(13), t('flowLocal')),
              h('button', { type: 'button', className: 'rw-tab' + (flow === 'linked' ? ' is-on' : ''), onClick: function () { setFlow('linked'); } }, IconLink(13), t('flowLinked'))),
            h('div', { className: 'rw-hint' }, flow === 'local' ? t('localFlowHint') : t('linkedFlowHint')),
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
                      onChange: function (event) { setLocalPath(event.currentTarget.value); },
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
              : h(AddWorkspaceFlow, {
                ctx: ctx, t: t, locale: locale, compact: true, initialMode: 'linked', lockedMode: 'linked', submitRef: flowSubmitRef,
                onDone: function () { if (props.onCancel) props.onCancel(); },
                onCancel: function () { if (props.onCancel) props.onCancel(); },
              })),
          h('div', { className: 'rw-modal-foot' },
            h('span', { className: 'rw-hint', style: { flex: '1 1 auto' } }, props.busy ? t('wsFlowBusy') : flow === 'linked' ? t('linkedFlowHint') : t('useLocalDirHint')),
            h('button', {
              type: 'button', className: 'rw-btn', disabled: Boolean(props.busy) || localBusy,
              onClick: function () { if (props.onCancel) props.onCancel(); },
            }, t('cancel')),
            flow === 'local'
              ? h('button', {
                type: 'button', className: 'rw-btn rw-btn-primary',
                disabled: localBusy || localPath.trim() === '',
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

    function RemoteWorkspaceCard(props) {
      var workspace = props.workspace;
      var t = props.t;
      var ctx = props.ctx;
      var locale = props.locale;
      var refresh = props.refresh;
      var state = useState({ testing: false, removing: false, message: null });
      var local = state[0];
      var setLocal = state[1];

      function open() {
        var sidebar = ctx.get && ctx.get('betterSidebar');
        if (!sidebar || typeof sidebar.openTab !== 'function') return;
        sidebar.openTab({
          type: REMOTE_TAB_TYPE,
          id: REMOTE_TAB_TYPE,
          title: t('remoteTabTitle'),
          path: '/',
          meta: { remoteId: workspace.id },
        });
        dismissSettingsOverlay();
      }

      function test() {
        setLocal({ testing: true, removing: false, message: null });
        apiCall('workspaces.test', { id: workspace.id }).then(function (result) {
          setLocal({
            testing: false,
            removing: false,
            message: result.ok
              ? { kind: 'success', text: t('testOk') + (result.latencyMs ? ' · ' + result.latencyMs + ' ms' : '') }
              : { kind: 'error', text: t('testFail') + '：' + (result.error || '') },
          });
          refresh();
        }).catch(function (error) {
          setLocal({ testing: false, removing: false, message: { kind: 'error', text: t('testFail') + '：' + messageOf(error, t, locale) } });
        });
      }

      function remove() {
        if (!local.removing) {
          setLocal({ testing: false, removing: true, message: null });
          return;
        }
        setLocal({ testing: false, removing: true, message: { kind: 'info', text: t('loading') } });
        apiCall('workspaces.remove', { id: workspace.id }).then(function () {
          bus.emit();
        }).catch(function (error) {
          setLocal({ testing: false, removing: false, message: { kind: 'error', text: messageOf(error, t, locale) } });
        });
      }

      var title = workspace.name || basename(workspace.remotePath) || workspace.hostName;
      var hostLabel = workspace.username + '@' + workspace.host + ':' + workspace.port;

      return h('div', { className: 'rw-card' },
        h('div', { className: 'rw-card-head' },
          h('span', { className: 'rw-icon-chip' }, IconServer(16)),
          h('div', { className: 'rw-fill', style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { className: 'rw-card-title' },
              h('span', { className: 'rw-name', title: title }, title),
              h(StatusPill, { status: workspace.status, t: t })),
            h('div', { className: 'rw-path', title: workspace.remotePath }, workspace.remotePath)),
          h('div', { className: 'rw-actions' },
            h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: open, disabled: !(ctx.get && ctx.get('betterSidebar')) }, IconExternal(12), t('open')),
            h('button', { type: 'button', className: 'rw-btn rw-btn-sm', onClick: test, disabled: local.testing }, local.testing ? Spinner(12) : IconRefresh(12), local.testing ? t('testRunning') : t('test')),
            h('button', {
              type: 'button',
              className: 'rw-btn rw-btn-sm' + (local.removing ? ' rw-btn-danger' : ' rw-btn-ghost'),
              onClick: remove,
              title: local.removing ? t('removeHint') : t('remove'),
            }, IconTrash(12), local.removing ? t('confirmRemove') : t('remove')))),
        h('div', { className: 'rw-meta' },
          h('span', { className: 'rw-chip' }, IconServer(11), workspace.hostName),
          h('span', { className: 'rw-meta-text rw-input-mono', title: hostLabel }, hostLabel)),
        local.message
          ? h(Banner, {
            kind: local.message.kind === 'success' ? 'success' : local.message.kind === 'error' ? 'error' : undefined,
            onClose: function () { setLocal({ testing: false, removing: false, message: null }); },
          }, local.message.text)
          : null);
    }

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

      return h('div', { className: 'rw-card' },
        h('div', { className: 'rw-card-head' },
          h('span', { className: 'rw-icon-chip rw-icon-chip-link' }, IconLink(16)),
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
              : h('span', { className: 'rw-chip' }, t('workspaceMissing')),
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
      var sidebarAvailable = Boolean(ctx.get && ctx.get('betterSidebar'));
      var links = remote.data.links || [];
      var workspaces = remote.data.workspaces || [];
      var hosts = remote.data.hosts || [];

      function openTree() {
        var sidebar = ctx.get && ctx.get('betterSidebar');
        if (!sidebar || typeof sidebar.openTab !== 'function') return;
        sidebar.openTab({
          type: TREE_TAB_TYPE,
          id: TREE_TAB_TYPE,
          title: t('tabTitle'),
          path: '/',
          meta: {},
        });
      }

      return h('div', { className: 'rw-root' },
        h('div', { className: 'rw-head-row' },
          h('div', { style: { minWidth: 0 } },
            h('h1', { className: 'rw-title' }, t('title')),
            h('p', { className: 'rw-sub' }, t('intro'))),
          h('div', { className: 'rw-actions' },
            h('button', {
              type: 'button', className: 'rw-btn' + (adding === 'linked' ? '' : ' rw-btn-primary'),
              onClick: function () { setAdding(adding === 'linked' ? '' : 'linked'); },
            }, adding === 'linked' ? IconClose(13) : IconLink(13), t('createLinked')),
            h('button', {
              type: 'button', className: 'rw-btn' + (adding === 'remote' ? '' : ' rw-btn-primary'),
              onClick: function () { setAdding(adding === 'remote' ? '' : 'remote'); },
            }, adding === 'remote' ? IconClose(13) : IconServer(13), t('addRemoteDir')))),
        !sidebarAvailable ? h(Banner, { kind: 'warn' }, t('needsSidebar')) : null,
        h(ThemeGroup, { t: t, locale: locale }),
        h(EditorSettingsGroup, { t: t, locale: locale }),
        adding !== ''
          ? h(AddWorkspaceFlow, {
            ctx: ctx, t: t, locale: locale, initialMode: adding, lockedMode: adding,
            onDone: function () { setAdding(''); remote.reload(); },
            onCancel: function () { setAdding(''); },
          })
          : null,
        remote.data.error ? h(Banner, { kind: 'error' }, t('workspacesFailed') + '：' + messageOf(remote.data.error, t, locale)) : null,
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
            h('span', { className: 'rw-group-title' }, t('remoteDirsTitle')),
            h('span', { className: 'rw-chip' }, String(workspaces.length)),
            h('span', { className: 'rw-group-hint' }, t('remoteDirsHint'))),
          workspaces.length === 0
            ? h('div', { className: 'rw-empty', style: { border: 'none', padding: '18px 8px' } },
              h('div', { className: 'rw-empty-title' }, t('emptyTitle')),
              h('div', { className: 'rw-empty-body' }, hosts.length === 0 ? t('emptyHint') : t('emptyBody')))
            : h('div', { className: 'rw-list' },
              workspaces.map(function (workspace) {
                return h(RemoteWorkspaceCard, {
                  key: workspace.id,
                  workspace: workspace,
                  t: t,
                  ctx: ctx,
                  locale: locale,
                  refresh: remote.reload,
                });
              }))),
        h('div', { className: 'rw-inline', style: { justifyContent: 'space-between' } },
          h('span', { className: 'rw-hint' }, workspaces.length + ' ' + t('remoteGroup') + ' · ' + links.length + ' ' + t('linkedGroup')),
          h('button', { type: 'button', className: 'rw-btn rw-btn-ghost rw-btn-sm', onClick: remote.reload }, IconRefresh(12), t('refresh'))));
    }

    // ── apply ──────────────────────────────────────────────────────────────

    var inject = ['slots', 'locale'];

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
        var sidebar = undefined;
        try {
          sidebar = ctx.get('betterSidebar');
        } catch (error) {
          sidebar = undefined;
        }
        if (!sidebar || typeof sidebar.registerTab !== 'function') return;
        sidebarRegistered = true;
        if (tabPollTimer !== null) {
          clearInterval(tabPollTimer);
          tabPollTimer = null;
        }
        var syncDirectoryTabsInFlight = false;

        function installLinkedTab() {
          if (linkedTabDisposer !== null) return;
          linkedTabDisposer = sidebar.registerTab({
            id: TREE_TAB_TYPE,
            title: function () { return makeT(readLocale(ctx))('tabTitle'); },
            description: function () { return makeT(readLocale(ctx))('tabDesc'); },
            icon: function (size) { return IconFolderTree(size); },
            order: 62,
            single: true,
            available: function (_ctx, sessionScope) { return isLinkedScope(sessionScope); },
            component: function (props) {
              var currentLocale = useLocale(ctx);
              var t = useMemo(function () { return makeT(currentLocale); }, [currentLocale]);
              return h(RemoteDirectoryTab, Object.assign({}, props, { ctx: ctx, t: t, locale: currentLocale, variant: 'linked' }));
            },
          });
        }

        function disposeLinkedTab() {
          if (linkedTabDisposer === null) return;
          try { linkedTabDisposer(); } catch (error) { /* ignore */ }
          linkedTabDisposer = null;
        }

        function installRemoteTab() {
          if (remoteTabDisposer !== null) return;
          remoteTabDisposer = sidebar.registerTab({
            id: REMOTE_TAB_TYPE,
            title: function () { return makeT(readLocale(ctx))('remoteTabTitle'); },
            description: function () { return makeT(readLocale(ctx))('remoteTabDesc'); },
            icon: function (size) { return IconServer(size); },
            order: 61,
            single: true,
            available: function () { return hasRemoteDirectories; },
            component: function (props) {
              var currentLocale = useLocale(ctx);
              var t = useMemo(function () { return makeT(currentLocale); }, [currentLocale]);
              return h(RemoteDirectoryTab, Object.assign({}, props, { ctx: ctx, t: t, locale: currentLocale, variant: 'remote' }));
            },
          });
        }

        function disposeRemoteTab() {
          if (remoteTabDisposer === null) return;
          try { remoteTabDisposer(); } catch (error) { /* ignore */ }
          remoteTabDisposer = null;
        }

        function activeSessionClientInfo(sessionId) {
          if (!sessionId) return null;
          try {
            var sessions = ctx.sessions || (ctx.get && ctx.get('sessions'));
            var list = sessions && sessions.list;
            var snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null;
            var record = snapshot && snapshot.byId ? snapshot.byId[sessionId] : null;
            if (!record) return null;
            var header = record.header || record;
            return { cwd: header.cwd || record.cwd || '', workspaceId: header.workspaceId || record.workspaceId || '' };
          } catch (error) {
            return null;
          }
        }

        function isLinkedSessionInfo(info) {
          return Boolean(info && ((info.cwd && isLinkedScope({ cwd: info.cwd })) || isLinkedWorkspaceId(info.workspaceId)));
        }

        function syncDirectoryTabs() {
          if (syncDirectoryTabsInFlight) return;
          syncDirectoryTabsInFlight = true;
          refreshDirectoryAvailability().catch(function () { /* ignore */ }).then(function () {
            if (hasRemoteDirectories) installRemoteTab();
            else disposeRemoteTab();
            var snapshot = typeof sidebar.getSnapshot === 'function' ? sidebar.getSnapshot() : null;
            var sessionId = snapshot && snapshot.sessionId;
            if (!sessionId) {
              disposeLinkedTab();
              return undefined;
            }
            var clientInfo = activeSessionClientInfo(sessionId);
            if (isLinkedSessionInfo(clientInfo)) {
              installLinkedTab();
              return undefined;
            }
            return apiCall('session.info', { sessionId: sessionId }).then(function (info) {
              if (isLinkedSessionInfo(info)) installLinkedTab();
              else disposeLinkedTab();
            }).catch(function () { disposeLinkedTab(); });
          }).catch(function () { /* ignore */ }).then(function () { syncDirectoryTabsInFlight = false; });
        }

        syncDirectoryTabsRef = syncDirectoryTabs;
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

        // Tabs persisted before the 0.3.0 rename still carry the old type ids;
        // register hidden aliases so a reloaded page restores them instead of
        // showing "no available view" for the legacy tab.
        try {
          tabDisposers.push(sidebar.registerTab({
            id: 'dsh-remote-workspace',
            title: function () { return makeT(readLocale(ctx))('tabTitle'); },
            hidden: true,
            order: 64,
            single: true,
            component: function (props) {
              var currentLocale = useLocale(ctx);
              var t = useMemo(function () { return makeT(currentLocale); }, [currentLocale]);
              return h(RemoteDirectoryTab, Object.assign({}, props, { ctx: ctx, t: t, locale: currentLocale, variant: 'linked' }));
            },
          }));
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
