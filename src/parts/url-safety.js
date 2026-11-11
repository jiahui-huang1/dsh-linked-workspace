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
// a single line of script.
export function attributeViolation(name, value, tagName) {
  if (String(name || '').toLowerCase() === 'style') return 'inline style';
  return urlAttributeViolation(name, value, tagName);
}
