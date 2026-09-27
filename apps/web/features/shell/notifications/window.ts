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

/** The window of at most 50 notifications ending at sequence `to`. */
export async function readWindow(main: MainClient, generation: string, to: string):
  Promise<Loaded<Omit<NotificationWindow, 'head'>>> {
  const end = BigInt(to);
  const start = end > BigInt(NOTIFICATION_WINDOW) ? end - BigInt(NOTIFICATION_WINDOW) : 0n;
  const limit = Number(end - start);
  if (limit === 0) return { ok: true, data: { generation, readThrough: '0', items: [], groups: [], from: '0' } };
  const page = await settle(() => main.v1.me.notifications.get({ query: { after: `${generation}:${start}`, limit } }));
  if (!page.ok) return page;
  return { ok: true, data: { generation: page.data.generation, readThrough: page.data.readThrough,
    items: [...page.data.items].reverse(), groups: page.data.groups, from: String(start) } };
}

/** The newest window: the stream's head first, then the window ending there. */
export async function readLatest(main: MainClient): Promise<Loaded<NotificationWindow>> {
  const hint = await settle(() => main.v1.me.notifications.hint.get());
  if (!hint.ok) return hint;
  const window = await readWindow(main, hint.data.generation, hint.data.head);
  return window.ok ? { ok: true, data: { ...window.data, head: hint.data.head } } : window;
}
