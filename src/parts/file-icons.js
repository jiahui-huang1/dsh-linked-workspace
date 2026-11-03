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

export function fileIconSpec(name, isDir) {
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
