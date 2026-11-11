/**
 * Build lib/client.js from src/client.js + src/parts/*.js.
 *
 * The DSH client loader takes ONE browser bundle file, so the editor assets
 * (themes, tokenizer, file icons) are authored as plain ESM modules for
 * testability and inlined into the factory scope here. `export ` prefixes are
 * stripped so the parts become ordinary declarations in the bundle closure.
 *
 *   node scripts/build-client.mjs
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const PART_FILES = ['themes.js', 'highlight.js', 'file-icons.js', 'file-creation.js']

function partCode(name) {
  const file = join(root, 'src', 'parts', name)
  if (!fs.existsSync(file)) {
    return `// ${name}: missing in this checkout\n`
  }
  const code = fs.readFileSync(file, 'utf8')
  const stripped = code.replace(/^export\s+/gm, '')
  return `// ---- ${name} ----\n${stripped.trim()}\n`
}

const source = fs.readFileSync(join(root, 'src', 'client.js'), 'utf8')
const marker = '    // __INLINE_PARTS__\n'
if (!source.includes(marker)) throw new Error('src/client.js is missing the // __INLINE_PARTS__ marker')

const parts = PART_FILES.map(partCode).join('\n')
const out = source.replace(marker, () => parts)
fs.writeFileSync(join(root, 'lib', 'client.js'), out)
console.log(`built lib/client.js: ${Buffer.byteLength(out)} bytes (parts: ${PART_FILES.join(', ')})`)
