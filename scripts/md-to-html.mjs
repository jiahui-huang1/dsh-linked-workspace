#!/usr/bin/env node
/**
 * Markdown → HTML fragment, matching DSH's native pipeline
 * (micromark + GFM + math, math rendered by KaTeX).
 *
 * The preview is injected into the host page with dangerouslySetInnerHTML, so
 * this script must return a **fragment** (no doctype/head/body) and carry the
 * KaTeX stylesheet with it — the host page does not ship KaTeX rules, and a
 * CDN <link> is unreachable offline. Font files are served by the plugin
 * itself under /dsh-linked-workspace/assets/katex/fonts/.
 *
 * usage: node md-to-html.mjs <markdown-file>
 * output: {"kind":"markdown-preview","html":"..."}
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { math, mathHtml } from 'micromark-extension-math';
import katex from 'katex';

const FONT_BASE = '/dsh-linked-workspace/assets/katex/fonts/';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[ch];
  });
}

function katexCss() {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('katex/package.json');
  const cssPath = join(dirname(pkg), 'dist', 'katex.min.css');
  let css = readFileSync(cssPath, 'utf8');
  // KaTeX's stylesheet points at fonts/<name>.woff2; the plugin serves those.
  css = css.replace(/url\((['"]?)fonts\//g, (match, quote) => `url(${quote}${FONT_BASE}`);
  return css;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: md-to-html.mjs <markdown-file>');
  process.exit(1);
}

const markdown = readFileSync(args[0], 'utf8');

let body = '';
try {
  body = micromark(markdown, {
    extensions: [gfm(), math()],
    htmlExtensions: [
      gfmHtml(),
      // mathHtml() forwards these straight to katex.renderToString(), so they
      // are KaTeX options — not renderer callbacks.
      mathHtml({ throwOnError: false, errorColor: '#d73a49', strict: 'ignore', trust: false, output: 'html' }),
    ],
  });
} catch (error) {
  // Never fail the preview: fall back to a plain <pre> of the source.
  const message = error && error.message ? error.message : String(error);
  body = `<pre class="rw-md-fallback">${escapeHtml(markdown)}</pre><!-- ${escapeHtml(message)} -->`;
}

// Only KaTeX rules live in the fragment: they are namespaced under .katex*,
// so inserting them into the host page cannot restyle the app itself. The
// handful of layout tweaks below are scoped to the preview container.
const html = [
  '<style data-rw-katex="1">',
  katexCss(),
  '.rw-doc-preview .katex{font-size:1.05em}',
  '.rw-doc-preview .katex-display{overflow-x:auto;overflow-y:hidden;margin:1.1em 0;padding:2px 0}',
  '.rw-doc-preview .katex-display>.katex{display:inline-block;text-align:initial}',
  '.rw-doc-preview .katex-error{color:var(--dsw-alias-state-error-primary,#d73a49);font-family:ui-monospace,Consolas,monospace;font-size:.9em}',
  '.rw-doc-preview .rw-md-fallback{white-space:pre-wrap}',
  '</style>',
  body,
].join('\n');

console.log(JSON.stringify({ kind: 'markdown-preview', html }));
