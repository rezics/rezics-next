import { notFound } from '@tanstack/react-router';

/** A subject view cursor stays opaque and bounded before it reaches a server read. */
export function validateViewCursor(cursor: unknown): string | undefined {
  if (cursor === undefined) return;
  if (typeof cursor !== 'string' || cursor.length === 0) throw notFound();
  return cursor;
}

/** Realm and node are selectors, never editorial Context overrides. Native routes own cursor size admission. */
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
