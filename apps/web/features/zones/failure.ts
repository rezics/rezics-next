import type { ReadFailure } from '../realm/types.ts';

/** What a Zone list shows for one failed read. Identity is the Zone being unavailable; a closed read is absent. */
export function zoneFailureView(
  reason: ReadFailure | 'identity' | 'sign-in',
  reference?: string,
): { failure: ReadFailure | 'sign-in'; reference?: string } | null {
  const failure = reason === 'identity' ? 'unavailable' : reason;
  if (failure === 'closed') return null;
  return { failure, ...(reference ? { reference } : {}) };
}

/**
 * A site without a Realm needs both its route and its presentation. The first
 * failure is the one the page names; a closed read stays absent.
 */
export function shownZoneFailure(
  route: { ok: true } | { ok: false; failure: ReadFailure; reference?: string },
  presentation: { ok: true } | { ok: false; failure: ReadFailure; reference?: string },
): { failure: ReadFailure | 'sign-in'; reference?: string } | null {
  if (!route.ok) return zoneFailureView(route.failure, route.reference);
  if (!presentation.ok) return zoneFailureView(presentation.failure, presentation.reference);
  return null;
}
