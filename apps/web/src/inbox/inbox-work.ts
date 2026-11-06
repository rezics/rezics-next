import type { InboxViewer } from './inbox-viewer';

/** One composed private list read; disclosure and destinations arrive with each admitted item. */
export const INBOX_PAGE_SIZE = 20;
export const INBOX_PAGE_KERNEL_READ_CEILING = 1;
export const INBOX_COUNT_KERNEL_READ_CEILING = 1;
export const INBOX_HYDRATION_KERNEL_READ_CEILING = 0;
export const INBOX_COMMAND_KERNEL_WRITE_CEILING = 1;
export const MAX_INBOX_PRIOR_ADDRESSES = 8;
export const MAX_INBOX_CURSOR_LENGTH = 4096;
/** Eight prior addresses, the current address and one return receipt at the cursor bound. */
export const MAX_INBOX_RETAINED_CURSORS = MAX_INBOX_PRIOR_ADDRESSES + 2;
export const MAX_INBOX_CURSOR_PAYLOAD_BYTES = 80 * 1024;
/** Independent browser axes for sequential visits and unrelated notice history. */
export const INBOX_BROWSER_GROWTH_SCALES = [64, 512, 4096] as const;
/** Content's native SQL neighbourhood for nested disclosure, not inferred from browser requests. */
export const INBOX_CONTENT_GROWTH_SCALES = [256, 1024, 4096] as const;
export const INBOX_LIST_CANDIDATE_LIMIT = INBOX_PAGE_SIZE * 4;
export const INBOX_UNREAD_RAW_WINDOW = 201;

export const INBOX_CONTENT_DISCLOSURE_EVIDENCE = {
  owner: 'Content',
  cost: 'services/kernel/src/content/README.md#cost-current-inbox-disclosure',
  projection: 'services/kernel/src/content/README.md#cost-notification-inbox-projection',
  unread: 'services/kernel/src/content/README.md#cost-current-visible-unread-summary',
  acknowledgement: 'services/kernel/src/content/README.md#cost-exact-one-notice-acknowledgement',
  bulk: 'services/kernel/src/content/README.md#cost-bulk-seen-frontier',
  growth: [
    'services/kernel/test/content/growth-notice-inbox.test.ts',
    'services/kernel/test/content/growth-notices.test.ts',
    'services/kernel/test/content/notice-inbox-unread-prefix.test.ts',
    'services/kernel/test/content/notice-inbox-http.test.ts',
  ],
  list: 'inbox list and unread summary examine bounded index rows as a recipient inbox grows',
  disclosure: 'native inbox disclosure of a real post notice stays bounded as the recipient range grows',
  unreadClassification:
    'native unread counts classify empty, exact-100, capped and retained-frontier states at three scales',
  examined: {
    listCandidateLimit: INBOX_LIST_CANDIDATE_LIMIT,
    unreadRawWindow: INBOX_UNREAD_RAW_WINDOW,
    rows: 'constant',
    statements: 'constant',
    blocks: 'logarithmic',
    discardedCandidates: 'disclosure runs for every fetched candidate, including those beyond the output cursor',
  },
  scales: INBOX_CONTENT_GROWTH_SCALES,
  browserScales: INBOX_BROWSER_GROWTH_SCALES,
} as const;

export type InboxComposedWork = Readonly<{
  listRequests: number;
  countRequests: number;
  commandRequests: number;
  hydrationRequests: number;
  retainedRows: number;
  priorAddresses: number;
  returnReceipts: number;
  cursorPayloadBytes: number;
  visits: number;
  unrelatedNotices: number;
  discardedCandidates: number;
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
  unrelatedNotices?: number;
  discardedCandidates?: number;
  returnReceipts?: number;
}): InboxComposedWork {
  const cursorPayloadBytes = inboxCursorPayloadBytes(input.cursors);
  const hydrationRequests = input.hydrationRequests ?? 0;
  const commandRequests = input.commandRequests ?? 0;
  const returnReceipts = input.returnReceipts ?? 0;
  if (input.retainedRows > INBOX_PAGE_SIZE) throw new RangeError('Inbox retains at most one 20-row body');
  if (input.priorAddresses > MAX_INBOX_PRIOR_ADDRESSES)
    throw new RangeError('Inbox retains at most eight prior addresses');
  if (returnReceipts > 1) throw new RangeError('Inbox retains at most one return receipt');
  if (input.cursors.length > MAX_INBOX_RETAINED_CURSORS)
    throw new RangeError('Inbox retains at most eight prior addresses, the current address and one return receipt');
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
    returnReceipts,
    cursorPayloadBytes,
    visits: input.visits,
    unrelatedNotices: input.unrelatedNotices ?? 0,
    discardedCandidates: input.discardedCandidates ?? 0,
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

/** Derive list, count, acknowledgement and retained browser work before measurement. */
export function deriveInboxBrowserWork(input: {
  visits: number;
  unrelatedNotices: number;
  retainedRows: number;
  priorAddresses: number;
  currentCursor?: string;
  priorCursors?: readonly (string | undefined)[];
  returnCursor?: string;
  acknowledgements?: number;
  discardedCandidates?: number;
  countRequests?: number;
}): InboxComposedWork {
  const priorCursors = input.priorCursors ?? Array.from({ length: input.priorAddresses }, () => undefined);
  return composeInboxWork({
    listRequests: input.visits,
    countRequests: input.countRequests ?? 1,
    commandRequests: input.acknowledgements ?? 0,
    hydrationRequests: 0,
    retainedRows: input.retainedRows,
    priorAddresses: input.priorAddresses,
    cursors: [...priorCursors, input.currentCursor, input.returnCursor],
    visits: input.visits,
    unrelatedNotices: input.unrelatedNotices,
    discardedCandidates: input.discardedCandidates ?? Math.max(0, input.unrelatedNotices - input.retainedRows),
    returnReceipts: input.returnCursor === undefined ? 0 : 1,
  });
}
