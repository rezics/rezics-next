import { notFound } from '@tanstack/react-router';

export const SUBJECT_VIEW_CURSOR_LIMIT = 4096;

/** Kernel's sealed relation cursors can carry a full position sort key within its 4096-character token limit. */
export function validateViewCursor(cursor: unknown): string | undefined {
  if (cursor === undefined) return;
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > SUBJECT_VIEW_CURSOR_LIMIT) throw notFound();
  return cursor;
}

/** Realm and node are selectors, never editorial Context overrides. */
export function validatePageRealm(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
    throw notFound();
  return value;
}
/** A supplied Board is an exact ContentId operand, validated like a Realm operand. */
export function validatePageBoard(value: unknown): string | undefined {
  return validatePageRealm(value);
}
export function validatePageNode(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw notFound();
  return value;
}
