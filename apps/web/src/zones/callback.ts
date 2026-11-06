import type { ZoneVisit } from './visit.ts';
import { zoneVisitIdentity } from './visit.ts';

/** Stable Zone callback identity: locale, Zone, target and quoted revision. Not a second scope engine. */
export type ZoneCallbackIdentity = {
  key: string;
  visit: ZoneVisit;
  revision: string;
};

export function zoneCallbackIdentity(visit: ZoneVisit, revision: string): ZoneCallbackIdentity {
  return { key: zoneVisitIdentity(visit, revision), visit, revision };
}

export function sameZoneCallback(left: ZoneCallbackIdentity, right: ZoneCallbackIdentity): boolean {
  return left.key === right.key;
}

/** A source replacement or configure/publish advances revision and retires the previous callback. */
export function replaceZoneCallback(
  current: ZoneCallbackIdentity,
  nextRevision: string,
): ZoneCallbackIdentity | undefined {
  if (current.revision === nextRevision) return current;
  return zoneCallbackIdentity(current.visit, nextRevision);
}
