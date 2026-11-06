import type { InboxViewer } from './inbox-viewer';

/** One composed private list read; disclosure and destinations arrive with each admitted item. */
export const INBOX_PAGE_SIZE = 20;
export const INBOX_PAGE_KERNEL_READ_CEILING = 1;
export const INBOX_COUNT_KERNEL_READ_CEILING = 1;
export const INBOX_HYDRATION_KERNEL_READ_CEILING = 0;
export const MAX_INBOX_PRIOR_ADDRESSES = 8;
export const MAX_INBOX_CURSOR_LENGTH = 4096;
/** Eight prior addresses, the current address and one return receipt at the cursor bound. */
export const MAX_INBOX_CURSOR_PAYLOAD_BYTES = 80 * 1024;
export const INBOX_CONTENT_DISCLOSURE_EVIDENCE = {
  owner: 'Content',
  cost: 'services/kernel/src/content/README.md#cost-current-inbox-disclosure',
  growth: [
    'services/kernel/test/content/growth-notice-inbox.test.ts',
    'services/kernel/test/content/growth-notices.test.ts',
  ],
  list: 'inbox list and unread summary examine bounded index rows as a recipient inbox grows',
  disclosure: 'native inbox disclosure of a real post notice stays bounded as the recipient range grows',
} as const;

export type InboxComposedWork = Readonly<{
  listRequests: number;
  countRequests: number;
  commandRequests: number;
  hydrationRequests: number;
  retainedRows: number;
  priorAddresses: number;
  cursorPayloadBytes: number;
  visits: number;
  content: typeof INBOX_CONTENT_DISCLOSURE_EVIDENCE;
}>;

export function inboxCursorCodeUnits(cursor: string | undefined): number {
  return cursor?.length ?? 0;
}

/** UTF-16 payload for the retained addresses; each cursor is independently at most 4,096 code units. */
export function inboxCursorPayloadBytes(cursors: readonly (string | undefined)[]): number {
  let units = 0;
  for (const cursor of cursors) {
    const length = inboxCursorCodeUnits(cursor);
    if (length > MAX_INBOX_CURSOR_LENGTH) throw new RangeError('Inbox cursor exceeds the admitted bound');
    units += length;
  }
  return units * 2;
}

export function composeInboxWork(input: {
  listRequests: number;
  countRequests: number;
  commandRequests?: number;
  hydrationRequests?: number;
  retainedRows: number;
  priorAddresses: number;
  cursors: readonly (string | undefined)[];
  visits: number;
}): InboxComposedWork {
  const cursorPayloadBytes = inboxCursorPayloadBytes(input.cursors);
  const hydrationRequests = input.hydrationRequests ?? 0;
  const commandRequests = input.commandRequests ?? 0;
  if (input.retainedRows > INBOX_PAGE_SIZE) throw new RangeError('Inbox retains at most one 20-row body');
  if (input.priorAddresses > MAX_INBOX_PRIOR_ADDRESSES)
    throw new RangeError('Inbox retains at most eight prior addresses');
  if (cursorPayloadBytes > MAX_INBOX_CURSOR_PAYLOAD_BYTES) throw new RangeError('Inbox cursor payload exceeds 80 KiB');
  if (hydrationRequests > INBOX_HYDRATION_KERNEL_READ_CEILING)
    throw new RangeError('Inbox pages do not hydrate actors or targets');
  return Object.freeze({
    listRequests: input.listRequests,
    countRequests: input.countRequests,
    commandRequests,
    hydrationRequests,
    retainedRows: input.retainedRows,
    priorAddresses: input.priorAddresses,
    cursorPayloadBytes,
    visits: input.visits,
    content: INBOX_CONTENT_DISCLOSURE_EVIDENCE,
  });
}

const unreadCountInFlight = new WeakMap<InboxViewer, Promise<unknown>>();

/** Concurrent count consumers for one viewer episode share one native observation. */
export function coalesceInboxViewerCount<T>(viewer: InboxViewer, load: () => Promise<T>): Promise<T> {
  const existing = unreadCountInFlight.get(viewer);
  if (existing) return existing as Promise<T>;
  const pending = load().finally(() => {
    if (unreadCountInFlight.get(viewer) === pending) unreadCountInFlight.delete(viewer);
  });
  unreadCountInFlight.set(viewer, pending);
  return pending;
}
