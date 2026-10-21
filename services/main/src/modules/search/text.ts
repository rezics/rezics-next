export type SearchMatchMode = 'phrase' | 'keywords';

export const normalizeSearchText = (text: string) => text.normalize('NFC').trim().replace(/\s+/gu, ' ');

/** Quotes retain literal query syntax. Each keyword is independently required;
 * omission keeps the existing exact phrase contract. Length counts code points. */
export function searchText(text: string, matchMode?: SearchMatchMode,
  Invalid: new (message: string) => Error = TypeError) {
  const normalized = normalizeSearchText(text);
  const length = [...normalized].length;
  const mode = matchMode ?? 'phrase';
  // Existing omitted-mode callers retain their admission as well as meaning.
  // Explicit intent permits a single code point, including CJK and emoji.
  if (length < (matchMode === undefined ? 2 : 1) || length > 80 || /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(normalized)
    || !['phrase', 'keywords'].includes(mode)) throw new Invalid('invalid public search text');
  const tokens = mode === 'keywords' ? [...new Set(normalized.split(' '))] : [normalized];
  const lucene = tokens.map(token => `"${token.replace(/[\\"]/gu, '\\$&')}"`).join(' AND ');
  return { text: normalized, matchMode: mode, tokens, lucene };
}
