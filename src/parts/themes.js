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

export const DEFAULT_THEME_ID = 'github-light'

export const EDITOR_THEMES = [
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

export const DEFAULT_THEME_FAMILY = 'github'

export const EDITOR_THEME_FAMILIES = [
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

export function getTheme(id) {
  return THEME_find(id) || THEME_find(DEFAULT_THEME_ID) || EDITOR_THEMES[0]
}
