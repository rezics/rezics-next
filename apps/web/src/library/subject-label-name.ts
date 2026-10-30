/** Version-one label names use NFC, collapsed Unicode whitespace, and scalar-value length limits. */
export function normalizeLibraryLabelName(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .replace(/^ +| +$/g, '');
}
