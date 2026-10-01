import type { MainClient } from '../../feed/types.ts';
import { settle, type Loaded } from '../../feed/types.ts';

// Main's notification stream (`services/main/src/routes/notifications.ts`) is
// read forward from a cursor, oldest first, as a device syncs it. The page
// shows newest first, so it reads windows ending at the stream's head and
// walks back one window at a time.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type StreamPage = Ok<MainClient['v1']['me']['notifications']['get']>;
export type StreamItem = StreamPage['items'][number];
type StreamGroup = StreamPage['groups'][number];

/** Notifications per window: Main's largest page. */
const NOTIFICATION_WINDOW = 50;

/**
 * Main filters with `view` and `reason`. A reason is why this person receives a
 * correction (`steward`, `author`, `reviewer`, `manual`). Mentions stay in the
 * inbox as the social topic `mention`; the API has no mention reason to filter.
 */
export const inboxViews = ['inbox', 'saved', 'done'] as const;
export type InboxView = (typeof inboxViews)[number];
export const inboxReasons = ['steward', 'author', 'reviewer', 'manual'] as const;
export type InboxReason = (typeof inboxReasons)[number];
export interface NotificationSelection { view: InboxView; reason: InboxReason | null }

/** Unknown query values are the inbox with no reason, which is what Main serves when they are omitted. */
export function parseSelection(search: { view?: string; reason?: string }): NotificationSelection {
  const view = (inboxViews as readonly string[]).includes(search.view ?? '') ? search.view as InboxView : 'inbox';
  const reason = (inboxReasons as readonly string[]).includes(search.reason ?? '') ? search.reason as InboxReason : null;
  return { view, reason };
}

/** Inbox with no reason has a clean URL; every other selection is in the query so a reload asks Main again. */
export function notificationsHref(selection: NotificationSelection): string {
  const params = new URLSearchParams();
  if (selection.view !== 'inbox') params.set('view', selection.view);
  if (selection.reason) params.set('reason', selection.reason);
  const query = params.toString();
  return query ? `/notifications?${query}` : '/notifications';
}

export interface NotificationWindow {
  generation: string;
  head: string;
  readThrough: string;
  /** Newest first. */
  items: StreamItem[];
  groups: StreamGroup[];
  /** The sequence this window starts after; "0" when it reaches the oldest. */
  from: string;
}

/** The window of at most 50 notifications ending at sequence `to`, within one view and reason. */
export async function readWindow(main: MainClient, generation: string, to: string,
  selection: NotificationSelection = { view: 'inbox', reason: null }):
  Promise<Loaded<Omit<NotificationWindow, 'head'>>> {
  const end = BigInt(to);
  const start = end > BigInt(NOTIFICATION_WINDOW) ? end - BigInt(NOTIFICATION_WINDOW) : 0n;
  const limit = Number(end - start);
  if (limit === 0) return { ok: true, data: { generation, readThrough: '0', items: [], groups: [], from: '0' } };
  const query: { after: string; limit: number; view?: 'saved' | 'done'; reason?: InboxReason } = {
    after: `${generation}:${start}`, limit };
  if (selection.view !== 'inbox') query.view = selection.view;
  if (selection.reason) query.reason = selection.reason;
  const page = await settle(() => main.v1.me.notifications.get({ query }));
  if (!page.ok) return page;
  return { ok: true, data: { generation: page.data.generation, readThrough: page.data.readThrough,
    items: [...page.data.items].reverse(), groups: page.data.groups, from: String(start) } };
}

/** The newest window: the stream's head first, then the window ending there. */
export async function readLatest(main: MainClient,
  selection: NotificationSelection = { view: 'inbox', reason: null }): Promise<Loaded<NotificationWindow>> {
  const hint = await settle(() => main.v1.me.notifications.hint.get());
  if (!hint.ok) return hint;
  const window = await readWindow(main, hint.data.generation, hint.data.head, selection);
  return window.ok ? { ok: true, data: { ...window.data, head: hint.data.head } } : window;
}
