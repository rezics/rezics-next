'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { BFF_PREFIX } from '../api/browser.ts';

// The reader's unread notifications (Main's `GET /v1/me/notifications/unread-count`),
// shared by the header bell and the phone bar. Main counts exactly through 99
// and says `overflow` beyond; it answers 503 when it cannot prove either, and
// the badge then stays as it was.

export interface Unread { count: number; overflow: boolean; generation?: string }

/** How often an open page asks again; focus and visibility also ask. */
const UNREAD_INTERVAL_MS = 60_000;

let current: Unread | null = null;
let displayedGeneration: string | null = null;
let revision = 0;
type NotificationProducer = 'count' | 'page' | 'mark-all' | `read:${string}`;
const requestOrders = new Map<NotificationProducer, number>();
const listeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function publish(next: Unread | null) {
  current = next;
  for (const listener of listeners) listener();
}

async function refresh() {
  if (document.visibilityState !== 'visible') return;
  const request = beginNotificationRequest();
  try {
    const response = await fetch(`${BFF_PREFIX}/v1/me/notifications/unread-count`,
      { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!response.ok) { await response.body?.cancel(); return; }
    const body = await response.json() as { profile?: string; generation?: unknown; count?: unknown; overflow?: unknown };
    if (body.profile === 'notification-unread-count-v1' && typeof body.count === 'number'
      && typeof body.overflow === 'boolean' && typeof body.generation === 'string'
      && /^[1-9][0-9]{0,18}$/.test(body.generation)) {
      setUnread({ generation: body.generation, count: body.count, overflow: body.overflow }, request);
    }
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
  // A response started by an unmounted or signed-out badge cannot outlive it.
  revision += 1;
  requestOrders.clear();
  publish(null);
}

/** Badge polls and view counts share an order; independent producers keep their own. */
export interface NotificationRequest {
  readonly revision: number; readonly order: number; readonly producer: NotificationProducer;
}
export function beginNotificationRequest(producer: NotificationProducer = 'count'): NotificationRequest {
  const order = (requestOrders.get(producer) ?? 0) + 1;
  requestOrders.set(producer, order);
  return { revision, order, producer };
}

export function isNotificationRequestCurrent(request: NotificationRequest, generation?: string): boolean {
  return request.revision === revision && request.order === requestOrders.get(request.producer)
    && (generation === undefined || displayedGeneration === null || generation === displayedGeneration);
}

/** Async producers submit their issuance fence; explicit seeds/reset invalidate outstanding responses. */
export function setUnread(next: Unread | null, request?: NotificationRequest) {
  if (request && !isNotificationRequestCurrent(request, next?.generation)) return;
  if (next === null) displayedGeneration = null;
  else {
    if (displayedGeneration !== null && next.generation !== displayedGeneration) return;
    if (next.generation && current?.generation && BigInt(next.generation) < BigInt(current.generation)) return;
  }
  if (!request) { revision += 1; requestOrders.clear(); }
  publish(next);
}

/** The currently displayed notification traversal; null releases its generation fence. */
export function setUnreadGeneration(generation: string | null) {
  if (displayedGeneration === generation) return;
  displayedGeneration = generation;
  revision += 1;
  requestOrders.clear();
  if (generation !== null && current?.generation !== generation) publish(null);
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
