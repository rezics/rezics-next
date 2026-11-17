import { isDeepStrictEqual } from 'node:util';
import type { KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { CursorResult } from '../tokens/cursor.ts';
import {
  decodeListCursor,
  encodeListCursor,
  type ListCursorBinding,
  type ListCursorPosition,
} from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';

type MemberPage = {
  members: readonly unknown[];
  next: string | null;
};

// Only the native reread can authenticate the original receipt against its current binding and frontier.
const continuationChecks = new WeakMap<MemberPage, (cursor: string) => Promise<boolean>>();

export async function nativeMemberPage<Row>(
  members: Row[],
  position: ListCursorPosition | null,
  encode: (position: ListCursorPosition) => string | Promise<string>,
  decode: (cursor: string) => CursorResult | Promise<CursorResult>,
) {
  if (position === null) return { members, next: null };
  const page = { members, next: await encode(position) };
  continuationChecks.set(page, async (cursor) => {
    const original = await decode(cursor);
    return original.ok && original.epoch === position.epoch && isDeepStrictEqual(original.after, position.after);
  });
  return page;
}

export function listMemberPage<Row>(
  members: Row[],
  tokens: KeyRing,
  binding: ListCursorBinding,
  position: ListCursorPosition | null,
  clock: KernelClock,
) {
  return nativeMemberPage(
    members,
    position,
    (next) => encodeListCursor(tokens, binding, next, clock()),
    (cursor) => decodeListCursor(tokens, binding, cursor, clock()),
  );
}

function sourcePage(page: MemberPage, listFactsAttached: boolean): unknown {
  const { next: _next, viewerFacts: _viewerFacts, ...source } = page as MemberPage & { viewerFacts?: unknown };
  return {
    ...source,
    members: source.members.map((member) => {
      if (typeof member !== 'object' || member === null || Array.isArray(member)) return member;
      if (!listFactsAttached) return member;
      const { subject: _subject, facts: _facts, ...row } = member as Record<string, unknown>;
      return row;
    }),
  };
}

/** Refuse a private overlay when the exact admitted member page is no longer current. */
export async function assertMemberPageCurrent(
  observed: MemberPage,
  current: unknown,
  options: { listFactsAttached?: boolean } = {},
) {
  if (typeof current !== 'object' || current === null || !('members' in current) || !Array.isArray(current.members))
    throw new ProblemError('semantic_not_ready');
  const page = current as MemberPage;
  const compareNativeRows = options.listFactsAttached ?? false;
  if (JSON.stringify(sourcePage(observed, compareNativeRows)) !== JSON.stringify(sourcePage(page, compareNativeRows)))
    throw new ProblemError('stale_cursor');
  const check = continuationChecks.get(page);
  // Search owns saved-catalogue receipts. A different unverified receipt must still fail closed.
  const sameContinuation =
    check && observed.next !== null && page.next !== null ? await check(observed.next) : observed.next === page.next;
  if (!sameContinuation) throw new ProblemError('stale_cursor');
}
