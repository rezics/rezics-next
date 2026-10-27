import { requireAccessDeadline } from './unavailable.ts';

export const ACCESS_EVIDENCE_TTL_MS = 1_000;

/** Evidence is live only for the caller's request and its short real-time TTL. */
export function accessEvidenceDeadline(requestDeadline: number, ttlMs = ACCESS_EVIDENCE_TTL_MS): number {
  requireAccessDeadline(requestDeadline);
  if (!Number.isFinite(requestDeadline) || !Number.isFinite(ttlMs) || ttlMs <= 0)
    throw new TypeError('Evidence deadline and TTL must be positive finite milliseconds');
  return Math.min(requestDeadline, Date.now() + ttlMs);
}
