export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderPlain(text: string): string {
  return `<pre class="plain">${escapeHtml(text)}</pre>`;
}
