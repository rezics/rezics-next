/** Version-one label names use NFC, collapsed Unicode whitespace, and scalar-value length limits. */
export function normalizeLibraryLabelName(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/^ +| +$/g, '');
}

export type LibraryLabelNameIssue = 'empty' | 'controls' | 'surrogates' | 'too-long';

/** Validate a normalized copy; callers retain the raw draft and command operands. */
export function libraryLabelNameIssue(value: string): LibraryLabelNameIssue | undefined {
  const name = normalizeLibraryLabelName(value);
  if (!name) return 'empty';
  if (/\p{Cc}/u.test(name)) return 'controls';
  if (/\p{Cs}/u.test(name)) return 'surrogates';
  let scalars = 0;
  for (const _scalar of name) if (++scalars > 100) return 'too-long';
  return undefined;
}
