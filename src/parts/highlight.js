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

export function languageOf(filePath) {
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

export function tokenize(source, language) {
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
