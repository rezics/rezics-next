import type { WorkUnavailabilityReason } from '../contract/vocabulary.ts';
import {
  WORK_STEP_RETRY_BACKOFF_RATE,
  WORK_STEP_RETRY_INTERVAL_SECONDS,
  WORK_STEP_RETRY_MAX_ATTEMPTS,
} from '../contract/bounds.ts';

const REASONS = new Set<WorkUnavailabilityReason>(['deadline', 'overloaded', 'contention', 'fenced', 'moved']);

function namedReason(error: unknown): WorkUnavailabilityReason | undefined {
  if (typeof error !== 'object' || error === null || !('reason' in error)) return undefined;
  const reason = (error as { reason: unknown }).reason;
  return typeof reason === 'string' && REASONS.has(reason as WorkUnavailabilityReason)
    ? (reason as WorkUnavailabilityReason)
    : undefined;
}

/** Classify durable-step unavailability from error shape, without Access or Command types. */
export function classifyWorkUnavailability(error: unknown): WorkUnavailabilityReason | undefined {
  const named = namedReason(error);
  if (named) return named;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '57014' || (error instanceof Error && /query read timeout/i.test(error.message))) return 'deadline';
  if (code === '40001' || code === '40P01' || code === '55P03') return 'contention';
  if (
    (typeof code === 'string' && /^(?:08|53)/.test(code)) ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    (error instanceof Error &&
      /timeout exceeded when trying to connect|connection (?:acquisition )?timeout/i.test(error.message))
  )
    return 'overloaded';
  return undefined;
}

export function workStepShouldRetry(error: unknown): boolean {
  const reason = classifyWorkUnavailability(error);
  return reason === 'deadline' || reason === 'contention' || reason === 'overloaded' || reason === 'fenced';
}

/** Shared retry policy for durable steps that issue kernel commands. */
export const COMMAND_STEP_RETRIES = Object.freeze({
  retriesAllowed: true,
  intervalSeconds: WORK_STEP_RETRY_INTERVAL_SECONDS,
  backoffRate: WORK_STEP_RETRY_BACKOFF_RATE,
  maxAttempts: WORK_STEP_RETRY_MAX_ATTEMPTS,
  shouldRetry: workStepShouldRetry,
});
