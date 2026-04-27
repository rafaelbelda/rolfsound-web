// static/js/core/adoptStyles.js
//
// Load a CSS file once and return a constructible CSSStyleSheet that every
// component instance can adopt via `shadowRoot.adoptedStyleSheets`.
//
// Why: on a Raspberry Pi, reparsing the same stylesheet for every Web
// Component instance is measurable CPU cost. A single shared CSSStyleSheet
// means N instances of <rolfsound-seek-bar> share ONE parsed rule table.
//
// Usage:
//   const sheet = await adoptStyles('/static/js/components/seek-bar/seek-bar.css');
//   this.shadowRoot.adoptedStyleSheets = [tokensSheet, sheet];

const _cache = new Map();
const SHADOW_CURSOR_RESET = `
:host {
  cursor: none !important;
}

*,
*::before,
*::after {
  cursor: none !important;
}
`;

export async function adoptStyles(url) {
  if (_cache.has(url)) return _cache.get(url);

  const promise = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`adoptStyles: failed to fetch ${url} (${response.status})`);
    }
    const text = await response.text();
    const sheet = new CSSStyleSheet();
    await sheet.replace(`${text}\n${SHADOW_CURSOR_RESET}`);
    return sheet;
  })();

  _cache.set(url, promise);
  return promise;
}

export function clearAdoptedStylesCache() {
  _cache.clear();
}
