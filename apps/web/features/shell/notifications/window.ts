import type { MainClient } from '../../feed/types.ts';
import { settle, type Loaded } from '../../feed/types.ts';

// Main pages filtered matches forward, oldest first. Its continuation owns
// coverage: sequence gaps cannot tell the client whether more matches remain.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type StreamPage = Ok<MainClient['v1']['me']['notifications']['get']>;
export type StreamItem = StreamPage['items'][number];
type StreamGroup = StreamPage['groups'][number];

/** Matches per page: Main's largest page. */
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
  reset: boolean;
  /** Newest first within this page. */
  items: StreamItem[];
  groups: StreamGroup[];
  /** Main's forward continuation, or null after the last matching item. */
  next: string | null;
}

/** Read at most 50 matches using Main's continuation unchanged. */
export async function readWindow(main: MainClient, after: string | null,
  selection: NotificationSelection = { view: 'inbox', reason: null }):
  Promise<Loaded<NotificationWindow>> {
  const query: { after?: string; limit: number; view?: 'saved' | 'done'; reason?: InboxReason } = {
    limit: NOTIFICATION_WINDOW };
  if (after !== null) query.after = after;
  if (selection.view !== 'inbox') query.view = selection.view;
  if (selection.reason) query.reason = selection.reason;
  const page = await settle(() => main.v1.me.notifications.get({ query }));
  if (!page.ok) return page;
  return { ok: true, data: { generation: page.data.generation, head: page.data.head,
    readThrough: page.data.readThrough, reset: page.data.reset,
    items: [...page.data.items].reverse(), groups: page.data.groups, next: page.data.next } };
}

/** Start the selected list; the page response carries the current head too. */
export async function readLatest(main: MainClient,
  selection: NotificationSelection = { view: 'inbox', reason: null }): Promise<Loaded<NotificationWindow>> {
  return readWindow(main, null, selection);
}
