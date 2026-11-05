import { preferenceRetryDeadline } from '../settings/preference-failure-retry';
import type { NativeInboxFailure } from './inbox-read';

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
  observedAt = Date.now(),
): InboxAcknowledgementRecovery<T> {
  return Object.freeze({ attempt, failure, retryAt: preferenceRetryDeadline(failure.retryAfter, observedAt) });
}

/** Retained callbacks must consult the live recovery record at dispatch time. */
export function inboxAcknowledgementRetryAllowed<T>(
  recovery: InboxAcknowledgementRecovery<T> | null,
  attempt: T,
  now = Date.now(),
): boolean {
  return recovery !== null && recovery.attempt === attempt && recovery.retryAt <= now;
}

export function inboxObservationRecovery(
  failure: NativeInboxFailure,
  source: { page?: boolean; count?: boolean } = {},
  observedAt = Date.now(),
): InboxObservationRecovery {
  return Object.freeze({
    failure,
    retryAt: preferenceRetryDeadline(failure.retryAfter, observedAt),
    page: source.page === true,
    count: source.count === true,
  });
}

export function inboxObservationRetryAllowed(recovery: InboxObservationRecovery | null, now = Date.now()): boolean {
  return recovery !== null && recovery.retryAt <= now;
}
