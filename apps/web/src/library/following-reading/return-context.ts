import { followingKind, type FollowingKind } from '../following-kind-navigation/address';
import { PERSONAL_DIRECTORY_CURSOR_LIMITS, personalDirectoryAddress } from '../personal-directory-address';

/** Private list frontier carried on the Following history entry, never a target URL. */
export type FollowingReturnFrontier = {
  locale: string;
  subject: string;
  cursor: string | null;
  kind: FollowingKind;
  targetId: string;
};

export const FOLLOWING_RETURN_STATE = 'followingReturn';
const privateOrigin = 'https://rezics.invalid';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function followingListHref(locale: string, cursor: string | null, kind: FollowingKind): string | null {
  if (!locale || locale.length > 16 || /[^A-Za-z-]/u.test(locale)) return null;
  const address = personalDirectoryAddress(cursor ?? undefined, PERSONAL_DIRECTORY_CURSOR_LIMITS.following);
  if (!address.valid) return null;
  try {
    const url = new URL(`/${locale}/library/following`, privateOrigin);
    if (address.cursor) url.searchParams.set('cursor', address.cursor);
    if (kind !== 'all') url.searchParams.set('kind', kind);
    if (url.origin !== privateOrigin || url.hash) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

export function followingReturnFrontier(
  locale: string,
  subject: string,
  cursor: string | null,
  kind: FollowingKind,
  targetId: string,
): FollowingReturnFrontier | null {
  if (!subject || subject.length > 128 || !uuid.test(targetId)) return null;
  if (followingListHref(locale, cursor, kind) === null) return null;
  return { locale, subject, cursor, kind, targetId };
}

export function followingReturnLocationState(frontier: FollowingReturnFrontier) {
  return { [FOLLOWING_RETURN_STATE]: frontier };
}

export function followingReturnFrontierFromState(
  value: unknown,
  locale: string,
  subject: string,
): FollowingReturnFrontier | null {
  const raw = record(record(value)?.[FOLLOWING_RETURN_STATE]);
  if (!raw || raw.locale !== locale || raw.subject !== subject) return null;
  if (typeof raw.targetId !== 'string' || !uuid.test(raw.targetId)) return null;
  const kind = followingKind(raw.kind);
  if (!kind) return null;
  const cursor = raw.cursor === null || raw.cursor === undefined ? null : raw.cursor;
  const address = personalDirectoryAddress(cursor ?? undefined, PERSONAL_DIRECTORY_CURSOR_LIMITS.following);
  if (!address.valid || (cursor !== null && address.cursor !== cursor)) return null;
  if (followingListHref(locale, address.cursor, kind) === null) return null;
  return { locale, subject, cursor: address.cursor, kind, targetId: raw.targetId };
}

/** Replace only this visit's history entry. Target pages never receive the private cursor. */
export function captureFollowingReturn(frontier: FollowingReturnFrontier): FollowingReturnFrontier | null {
  if (typeof window === 'undefined') return null;
  const href = followingListHref(frontier.locale, frontier.cursor, frontier.kind);
  if (!href) return null;
  try {
    const current = new URL(window.location.href);
    const expected = new URL(href, current.origin);
    if (current.origin !== expected.origin || current.pathname !== expected.pathname) return null;
    const previous = record(window.history.state) ?? {};
    window.history.replaceState({ ...previous, ...followingReturnLocationState(frontier) }, '', current.href);
    return frontier;
  } catch {
    return null;
  }
}

export function readFollowingReturn(locale: string, subject: string): FollowingReturnFrontier | null {
  if (typeof window === 'undefined') return null;
  return followingReturnFrontierFromState(window.history.state, locale, subject);
}

export function clearFollowingReturn(): void {
  if (typeof window === 'undefined') return;
  const previous = record(window.history.state);
  if (!previous || !(FOLLOWING_RETURN_STATE in previous)) return;
  const next = { ...previous };
  delete next[FOLLOWING_RETURN_STATE];
  window.history.replaceState(next, '', window.location.href);
}

export function followingReturnMatchesWindow(
  frontier: FollowingReturnFrontier,
  cursor: string | null,
  kind: FollowingKind,
): boolean {
  return frontier.cursor === cursor && frontier.kind === kind;
}

type Pointer = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
};

/** Ordinary left-click only. Modified clicks keep the native destination without a private frontier. */
export function followingDestinationClick(
  event: Pointer,
  admitted: () => boolean,
  frontier: FollowingReturnFrontier | null,
): boolean {
  if (!admitted()) {
    event.preventDefault();
    return false;
  }
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return false;
  if (frontier) captureFollowingReturn(frontier);
  return true;
}

export function followingReturnTrigger(root: Element | null, targetId: string): HTMLButtonElement | null {
  if (!root || !uuid.test(targetId)) return null;
  const row = root.querySelector(`[data-follow-target="${targetId}"]`);
  return row?.querySelector<HTMLButtonElement>('button[aria-label^="Inspect "]') ?? null;
}
