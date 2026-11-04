import { preferenceRetryDeadline } from '../settings/preference-failure-retry';
import type { NativeInboxFailure } from './inbox-read';

/** A response wait belongs to the immutable command that received it. */
export type InboxAcknowledgementRecovery<T> = Readonly<{
  attempt: T;
  failure: NativeInboxFailure;
  retryAt: number;
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
