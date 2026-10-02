/** Relative resources and web links are safe to render. Script and data URLs are never document content. */
export function safeDocumentUrl(value: unknown, media = false): string | undefined {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return undefined;
  if (/^(?:\/(?!\/)|\.\.?\/|#)/u.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return value;
    // A blob address belongs to the page that made it, so a media blob shows only where it was chosen.
    if (media && url.protocol === 'blob:') return value;
    if (!media && (url.protocol === 'mailto:' || url.protocol === 'tel:')) return value;
  } catch { /* A bare address is not a link until the author supplies a protocol. */ }
  return undefined;
}
