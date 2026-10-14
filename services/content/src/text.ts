/** One Content body remains one unit; UTF-16 is the author's API budget. */
export const CONTENT_TEXT_COST = { textUnits: 65_536, textBytes: 196_608, languageUnits: 100 } as const;

/** Admission and public/private readers use the same Unicode and text bounds. */
export function checkedContentText(value: unknown): string {
  if (typeof value !== 'string' || value.length > CONTENT_TEXT_COST.textUnits
    || Buffer.byteLength(value, 'utf8') > CONTENT_TEXT_COST.textBytes
    || value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new Error('invalid Content text');
  }
  return value;
}
