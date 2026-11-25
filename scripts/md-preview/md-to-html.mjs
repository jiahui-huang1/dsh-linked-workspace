#!/usr/bin/env node
/**
 * Markdown to HTML renderer matching DSH's native pipeline:
 * micromark + micromark-extension-gfm + micromark-extension-math + KaTeX
 */

import { readFileSync } from 'node:fs';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { math, mathHtml } from 'micromark-extension-math';
import katex from 'katex';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: md-to-html.mjs <markdown-file>');
  process.exit(1);
}

const path = args[0];
const markdown = readFileSync(path, 'utf8');

// Render markdown with GFM and math extensions
const html = micromark(markdown, {
  extensions: [gfm(), math()],
  htmlExtensions: [
    gfmHtml(),
    mathHtml({
      // Render math with KaTeX
      renderInline: (text) => {
        try {
          return katex.renderToString(text, { throwOnError: false, displayMode: false });
        } catch (err) {
          return `<span class="katex-error">${escapeHtml(text)}</span>`;
        }
      },
      renderBlock: (text) => {
        try {
          return katex.renderToString(text, { throwOnError: false, displayMode: true });
        } catch (err) {
          return `<div class="katex-error">${escapeHtml(text)}</div>`;
        }
      },
    }),
  ],
});

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[m];
  });
}

// Wrap in a styled document matching DSH's preview style
const styledHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>
body {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.65;
  color: #1f2328;
  max-width: 900px;
  margin: 0 auto;
  padding: 28px;
  font-size: 15px;
}
h1, h2, h3, h4 {
  line-height: 1.3;
  margin: 1.2em 0 0.55em;
}
h1 {
  font-size: 1.8em;
  border-bottom: 1px solid #e5e7eb;
  padding-bottom: 0.25em;
}
pre {
  background: #f6f8fa;
  padding: 12px;
  border-radius: 8px;
  overflow: auto;
}
code {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.92em;
}
pre code {
  background: none;
  padding: 0;
}
blockquote {
  border-left: 4px solid #d0d7de;
  margin: 0;
  padding: 0 1em;
  color: #57606a;
}
table {
  border-collapse: collapse;
  margin: 1em 0;
}
th, td {
  border: 1px solid #d0d7de;
  padding: 6px 10px;
  text-align: left;
}
img {
  max-width: 100%;
}
a {
  color: #0969da;
}
hr {
  border: 0;
  border-top: 1px solid #d0d7de;
  margin: 1.5em 0;
}
.katex-error {
  color: #d73a49;
  font-family: monospace;
}
</style>
</head>
<body>
${html}
</body>
</html>`;

// Output as JSON for doc_tool.py to consume
console.log(JSON.stringify({ kind: 'markdown-preview', html: styledHtml }));
