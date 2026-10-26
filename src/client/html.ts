export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Emphasis tags prompts use, such as `<IMPORTANT>` or `<EXTREMELY_IMPORTANT>`: an all-caps name of
 * two or more characters, so single-letter generics and ordinary HTML in text stay untouched.
 */
export const PSEUDO_TAG = /<\/?[A-Z][A-Z0-9_-]+>/;
export const PSEUDO_TAG_AT_START = /^<\/?[A-Z][A-Z0-9_-]+>/;
const ESCAPED_PSEUDO_TAG = /&lt;(\/?[A-Z][A-Z0-9_-]+)&gt;/g;

/** Wraps pseudo-tags in already-escaped text so they stand out from the prose around them. */
export function markPseudoTags(escaped: string): string {
  return escaped.replace(ESCAPED_PSEUDO_TAG, '<span class="ptag">&lt;$1&gt;</span>');
}

export function renderPlain(text: string): string {
  return `<pre class="plain">${markPseudoTags(escapeHtml(text))}</pre>`;
}
