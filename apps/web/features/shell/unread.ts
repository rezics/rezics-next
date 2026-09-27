'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { BFF_PREFIX } from '../api/browser.ts';

// The reader's unread notifications (Main's `GET /v1/me/notifications/unread-count`),
// shared by the header bell and the phone bar. Main counts exactly through 99
// and says `overflow` beyond; it answers 503 when it cannot prove either, and
// the badge then stays as it was.

export interface Unread { count: number; overflow: boolean }

/** How often an open page asks again; focus and visibility also ask. */
const UNREAD_INTERVAL_MS = 60_000;

let current: Unread | null = null;
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function publish(next: Unread | null) {
  current = next;
  for (const listener of listeners) listener();
}

async function refresh() {
  if (document.visibilityState !== 'visible') return;
  try {
    const response = await fetch(`${BFF_PREFIX}/v1/me/notifications/unread-count`,
      { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); return; }
    const body = await response.json() as { profile?: string; count?: unknown; overflow?: unknown };
    if (body.profile === 'notification-unread-count-v1' && typeof body.count === 'number'
      && typeof body.overflow === 'boolean') publish({ count: body.count, overflow: body.overflow });
  } catch { /* Offline: the badge keeps its last value. */ }
}

const onVisible = () => void refresh();

function start() {
  users += 1;
  if (users > 1) return;
  void refresh();
  timer = setInterval(() => void refresh(), UNREAD_INTERVAL_MS);
  window.addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
}

function stop() {
  users -= 1;
  if (users > 0) return;
  clearInterval(timer);
  window.removeEventListener('focus', onVisible);
  document.removeEventListener('visibilitychange', onVisible);
}

/** The notifications page sets what it just marked read, so badges agree at once; null forgets the count. */
export function setUnread(next: Unread | null) {
  publish(next);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The unread count while signed in, or null before Main has answered. */
export function useUnread(signedIn: boolean): Unread | null {
  useEffect(() => {
    if (!signedIn) return;
    start();
    return stop;
  }, [signedIn]);
  const value = useSyncExternalStore(subscribe, () => current, () => null);
  return signedIn ? value : null;
}

/** "3", or "99+" beyond Main's exact range. */
export function unreadBadge(unread: Unread): string {
  return unread.overflow || unread.count > 99 ? '99+' : String(unread.count);
}
