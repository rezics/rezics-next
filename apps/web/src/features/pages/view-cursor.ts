import { notFound } from '@tanstack/react-router';

/** A subject view cursor stays opaque and bounded before it reaches a server read. */
export function validateViewCursor(cursor: unknown): string | undefined {
  if (cursor === undefined) return;
  if (typeof cursor !== 'string' || cursor.length > 2048) throw notFound();
  return cursor;
}
