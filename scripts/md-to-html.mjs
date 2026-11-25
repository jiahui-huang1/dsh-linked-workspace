#!/usr/bin/env node
/**
 * CLI wrapper around lib/markdown.js, kept for standalone rendering and tests.
 *
 * usage: node md-to-html.mjs <markdown-file>
 * output: {"kind":"markdown-preview","html":"..."}
 */

import { readFileSync } from 'node:fs';
import { renderMarkdownFragment } from '../lib/markdown.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: md-to-html.mjs <markdown-file>');
  process.exit(1);
}

const markdown = readFileSync(args[0], 'utf8');
console.log(JSON.stringify({ kind: 'markdown-preview', html: renderMarkdownFragment(markdown) }));
