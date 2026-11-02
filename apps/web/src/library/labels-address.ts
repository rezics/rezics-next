export const LABELS_PREFIX_MAX_SCALARS = 100;
export const LABELS_CURSOR_MAX_LENGTH = 4096;

export type LabelsAddress = { cursor: string | null; query: string | null };
export type LabelsAddressIssue = 'prefix' | 'cursor';
export type LabelsAddressResult =
  | ({ valid: true } & LabelsAddress)
  | ({
      valid: false;
      issue: LabelsAddressIssue;
      rawQuery: string | null;
      rawCursor: string | null;
    } & LabelsAddress);

function validPrefix(value: string): boolean {
  let scalarCount = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    if (++scalarCount > LABELS_PREFIX_MAX_SCALARS) return false;
  }
  return true;
}

/** Validate the saved route address without changing user-entered prefix text. */
export function parseLabelsAddress(value: unknown): LabelsAddressResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { valid: false, issue: 'prefix', cursor: null, query: null, rawQuery: null, rawCursor: null };

  const input = value as Record<string, unknown>;
  const queryPresent = input.query !== undefined;
  const cursorPresent = input.cursor !== undefined;
  const rawQuery = typeof input.query === 'string' ? input.query : null;
  const rawCursor = typeof input.cursor === 'string' ? input.cursor : null;
  const queryValid =
    !queryPresent ||
    (typeof input.query === 'string' && validPrefix(input.query));
  const cursorValid =
    !cursorPresent ||
    (typeof input.cursor === 'string' && input.cursor.length <= LABELS_CURSOR_MAX_LENGTH);

  if (!queryValid)
    return { valid: false, issue: 'prefix', cursor: null, query: null, rawQuery, rawCursor };
  const query = typeof input.query === 'string' ? input.query : null;

  if (!cursorValid)
    return { valid: false, issue: 'cursor', cursor: null, query, rawQuery, rawCursor };

  const cursor = typeof input.cursor === 'string' && input.cursor !== '' ? input.cursor : null;
  return { valid: true, cursor, query };
}
