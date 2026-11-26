// URL safety helpers shared by the document sanitizer and its unit tests.
//
// Browsers strip ASCII control characters, tabs and newlines while parsing a
// URL scheme, so `jav&#9;ascript:` reaches the address bar as `javascript:`.
// The checks below normalise the value the same way before looking at it.
var SAFE_SCHEMES = { http: 1, https: 1, mailto: 1, tel: 1 };
var IMAGE_DATA = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif|x-icon)[;,]/
var URL_ATTRIBUTES = {
  href: 1,
  src: 1,
  'xlink:href': 1,
  action: 1,
  formaction: 1,
  data: 1,
  poster: 1,
  background: 1,
  cite: 1,
  longdesc: 1,
  usemap: 1,
};

export function normalizeUrlValue(value) {
  return String(value == null ? '' : value)
    // C0/C1 controls, space, zero-width and line/paragraph separators are what
    // URL parsers silently drop inside a scheme.
    .replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .trim();
}

export function urlSchemeOf(value) {
  var text = normalizeUrlValue(value);
  var match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(text);
  return match ? match[1].toLowerCase() : '';
}

// Returns '' when the attribute is safe to keep, or a short reason when the
// sanitizer has to drop it. `tagName` is only needed for data: URLs, which are
// allowed for images and rejected everywhere else.
export function urlAttributeViolation(name, value, tagName) {
  var attribute = String(name || '').toLowerCase();
  if (/^on/.test(attribute)) return 'event handler';
  if (!URL_ATTRIBUTES[attribute]) return '';
  var text = normalizeUrlValue(value);
  if (text === '') return '';
  // Relative paths, fragments and protocol-relative URLs have no scheme.
  if (text.charAt(0) === '#' || text.slice(0, 2) === '//') return '';
  var scheme = urlSchemeOf(text);
  if (scheme === '') return '';
  if (SAFE_SCHEMES[scheme]) return '';
  if (scheme === 'data' && String(tagName || '').toLowerCase() === 'img' && IMAGE_DATA.test(text)) return '';
  return scheme + ': URL';
}

// Complete attribute policy for the document preview. Inline styles are dropped
// as well: `position:fixed; inset:0; z-index:99999` can cover the whole Harness
// window, which turns a preview into a clickjacking / phishing surface without
// a single line of script. Callers may opt in to `allowInlineStyle` for KaTeX
// subtrees, where the style attribute is the layout (see katexStyleViolation).
export function attributeViolation(name, value, tagName, options) {
  if (String(name || '').toLowerCase() === 'style') {
    if (options && options.allowInlineStyle && katexStyleViolation(value) === '') return '';
    return 'inline style';
  }
  return urlAttributeViolation(name, value, tagName);
}

// KaTeX positions every glyph with an inline style — `height:1.2em` on a vlist,
// `top:-0.5em` on its children, `vertical-align:-0.2em` on the base — so a
// preview that drops them turns each formula into a pile of overlapping spans.
// Only that shape is accepted, and only inside `.katex`: lengths, `position:
// relative`, and a solid border. Anything that could escape the box
// (absolute/fixed positioning, inset, z-index, transforms, url()) is refused.
var KATEX_STYLE_PROPERTIES = {
  height: 'length',
  top: 'length',
  left: 'length',
  width: 'length',
  'min-width': 'length',
  'margin-left': 'length',
  'margin-right': 'length',
  'padding-left': 'length',
  'vertical-align': 'length',
  'border-width': 'length',
  'border-bottom-width': 'length',
  'border-style': 'keyword',
  position: 'keyword',
};

var KATEX_LENGTH = /^-?(?:\d+\.?\d*|\.\d+)(?:em|ex|px|pt|rem|%)?$/;
var KATEX_KEYWORDS = {
  'border-style': /^(?:solid|dashed|dotted)$/,
  position: /^relative$/,
};

export function katexStyleViolation(value) {
  var text = normalizeUrlValue(value);
  if (text === '') return '';
  var declarations = text.split(';');
  for (var index = 0; index < declarations.length; index += 1) {
    var declaration = declarations[index].trim();
    if (declaration === '') continue;
    var colon = declaration.indexOf(':');
    if (colon < 0) return 'unsafe style';
    var property = declaration.slice(0, colon).trim().toLowerCase();
    var kind = KATEX_STYLE_PROPERTIES[property];
    if (!kind) return 'unsafe style';
    var value = declaration.slice(colon + 1).trim();
    if (kind === 'keyword') {
      if (!KATEX_KEYWORDS[property].test(value)) return 'unsafe style';
    } else if (!KATEX_LENGTH.test(value)) {
      return 'unsafe style';
    }
  }
  return '';
}

// Turns a link found inside a document into an absolute path on the document's
// own side. Returns '' for in-page anchors ("#section") and for anything that
// is not a path at all (http(s), mailto, tel, protocol-relative), so the caller
// can decide between scrolling, the system browser and opening a file.
export function resolveLinkTarget(baseDir, href) {
  var raw = String(href == null ? '' : href).trim()
  // Browsers drop the query and the fragment before asking for a file, and so do
  // we: neither can be part of a name on either side.
  var cut = raw.indexOf('#')
  if (cut >= 0) raw = raw.slice(0, cut)
  cut = raw.indexOf('?')
  if (cut >= 0) raw = raw.slice(0, cut)
  if (raw === '') return ''
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw)) return ''
  if (raw.slice(0, 2) === '//') return ''
  try { raw = decodeURIComponent(raw) } catch (error) { /* keep the literal text */ }
  var sep = baseDir && baseDir.indexOf('\\') >= 0 ? '\\' : '/'
  var text = raw.replace(/[\\/]/g, '/')
  var parts
  if (/^[a-zA-Z]:\//.test(text) || text.charAt(0) === '/') {
    parts = text.split('/')
  } else {
    parts = String(baseDir == null ? '' : baseDir).replace(/[\\/]/g, '/').split('/')
    if (parts.length > 1) parts.pop()
    text.split('/').forEach(function (part) {
      if (part === '' || part === '.') return
      if (part === '..') { if (parts.length > 1) parts.pop(); return }
      parts.push(part)
    })
  }
  var joined = parts.join('/')
  return sep === '\\' ? joined.replace(/\//g, '\\') : joined
}

// True when `target` sits inside `root` (or is the root itself). Comparison is
// case-sensitive on purpose: both paths come from the same host listing, so the
// spelling already agrees, and Linux remotes really do distinguish case.
export function isInsideRoot(root, target) {
  var base = String(root == null ? '' : root).replace(/[\\/]+$/, '').replace(/\\/g, '/')
  var full = String(target == null ? '' : target).replace(/[\\/]+$/, '').replace(/\\/g, '/')
  if (base === '' || full === '') return false
  return full === base || full.indexOf(base + '/') === 0
}
