/**
 * Markdown → HTML fragment, matching DSH's native pipeline
 * (micromark + GFM + math, math rendered by KaTeX).
 *
 * The preview is injected into the host page with dangerouslySetInnerHTML, so
 * this module returns a **fragment** (no doctype/head/body) that carries the
 * KaTeX stylesheet with it — the host page does not ship KaTeX rules, and a
 * CDN <link> is unreachable offline. Font files are served by the plugin
 * itself under /dsh-linked-workspace/assets/katex/fonts/.
 *
 * Rendering happens in-process: shelling out to `node` would depend on a
 * `node` that the DSH process may not have on its PATH (the plugin only needs
 * to run inside DSH), and a missing one silently degraded every formula to
 * raw `$$…$$` text.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { math, mathHtml } from 'micromark-extension-math';
import katex from 'katex';

export const FONT_BASE = '/dsh-linked-workspace/assets/katex/fonts/';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[ch];
  });
}

let cachedCss = '';

export function katexCss() {
  if (cachedCss) return cachedCss;
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('katex/package.json');
  const cssPath = join(dirname(pkg), 'dist', 'katex.min.css');
  let css = readFileSync(cssPath, 'utf8');
  // KaTeX's stylesheet points at fonts/<name>.woff2; the plugin serves those.
  css = css.replace(/url\((['"]?)fonts\//g, (match, quote) => `url(${quote}${FONT_BASE}`);
  cachedCss = css;
  return css;
}

/**
 * Render markdown text to an HTML fragment that already contains everything it
 * needs to look right (KaTeX rules + preview-scoped layout tweaks).
 */
export function renderMarkdownFragment(markdown) {
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
    // Keep KaTeX's own block layout: the equation number (`\tag`) is absolutely
    // positioned at the right edge of the block, so shrinking the block to the
    // formula's width (inline-block) parks the number on top of the formula.
    // `min-width:max-content` is what still lets an over-wide formula scroll.
    '.rw-doc-preview .katex-display>.katex{display:block;min-width:max-content;text-align:center}',
    // KaTeX pins the equation number with `position:absolute; right:0`, which
    // lands on top of the formula whenever the formula is (nearly) as wide as
    // the column. Lay the number out after the formula instead, so it can never
    // collide; `min-width:max-content` above keeps over-wide lines scrollable.
    '.rw-doc-preview .katex-display>.katex:has(>.katex-html>.tag)>.katex-html{white-space:nowrap}',
    '.rw-doc-preview .katex-display>.katex:has(>.katex-html>.tag)>.katex-html>.tag{position:static;right:auto;margin:0 0 0 1.6em;vertical-align:middle;white-space:nowrap}',
    '.rw-doc-preview .katex-error{color:var(--dsw-alias-state-error-primary,#d73a49);font-family:ui-monospace,Consolas,monospace;font-size:.9em}',
    '.rw-doc-preview .rw-md-fallback{white-space:pre-wrap}',
    '</style>',
    body,
  ].join('\n');

  return html;
}
