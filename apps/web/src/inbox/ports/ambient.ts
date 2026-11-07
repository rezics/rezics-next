import { preferenceRetryDeadline } from '../../settings/ports/ambient';
import type { NativeInboxFailure } from '../inbox-read';

/** Wall-clock milliseconds for Inbox retry admission and absolute deadlines. */
export type InboxClock = () => number;

/** Fresh acknowledgement identities. Callers keep the returned original. */
export type InboxId = () => string;

export type InboxTimerHandle = Readonly<{ cancel: () => void }>;

/** Presentation timers. Expiry never starts a fetch. */
export type InboxTimer = Readonly<{
  schedule(callback: () => void, delayMs: number): InboxTimerHandle;
}>;

/** Clock, identifier and timer for Inbox recovery. Composition supplies the adapter. */
export type InboxAmbient = Readonly<{
  now: InboxClock;
  id: InboxId;
  timer: InboxTimer;
}>;

/** A response wait belongs to the immutable command that received it. */
export type InboxAcknowledgementRecovery<T> = Readonly<{
  attempt: T;
  failure: NativeInboxFailure;
  retryAt: number;
}>;

/** Failed current page or unread-count observations after a consumed acknowledgement. */
export type InboxObservationRecovery = Readonly<{
  failure: NativeInboxFailure;
  retryAt: number;
  page: boolean;
  count: boolean;
}>;

export function inboxAcknowledgementRecovery<T>(
  attempt: T,
  failure: NativeInboxFailure,
  observedAt: number,
): InboxAcknowledgementRecovery<T> {
  return Object.freeze({ attempt, failure, retryAt: preferenceRetryDeadline(failure.retryAfter, observedAt) });
}

/** Retained callbacks must consult the live recovery record at dispatch time. */
export function inboxAcknowledgementRetryAllowed<T>(
  recovery: InboxAcknowledgementRecovery<T> | null,
  attempt: T,
  now: number,
): boolean {
  return recovery !== null && recovery.attempt === attempt && recovery.retryAt <= now;
}

export function inboxObservationRecovery(
  failure: NativeInboxFailure,
  source: { page?: boolean; count?: boolean } = {},
  observedAt: number,
): InboxObservationRecovery {
  return Object.freeze({
    failure,
    retryAt: preferenceRetryDeadline(failure.retryAfter, observedAt),
    page: source.page === true,
    count: source.count === true,
  });
}

export function inboxObservationRetryAllowed(recovery: InboxObservationRecovery | null, now: number): boolean {
  return recovery !== null && recovery.retryAt <= now;
}
