/** Native script survives. A long word is bounded at a grapheme boundary;
 * ordinary and unspaced CJK text use the last word boundary within 60 points.
 * Readable suffix derivation is independent of the alias registry and its Unicode tables. */
export function deriveAddressSuffix(value: string): string {
  const normalized = value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if ([...normalized].length <= 60) return normalized;
  const words = new Intl.Segmenter('und', { granularity: 'word' }).segment(normalized);
  let end = 0;
  for (const word of words) {
    if ([...normalized.slice(0, word.index + word.segment.length)].length > 60) break;
    if (word.isWordLike) end = word.index + word.segment.length;
  }
  if (end) return normalized.slice(0, end).replace(/-+$/g, '');
  let result = '';
  for (const grapheme of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(
    normalized,
  )) {
    if ([...(result + grapheme.segment)].length > 60) break;
    result += grapheme.segment;
  }
  return result;
}
