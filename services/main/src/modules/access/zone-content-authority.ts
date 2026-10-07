import type { PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { zoneSpaceCreatorAllowed } from '../space/create-authority.ts';
import { platformAdministratorTargetAllowed } from './platform-administrator.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** Pins a content.draft or content.publish baseline proof to a Zone page.
 * author_work holds the Zone; a null author generation keeps it off the Work path. */
export const ZONE_PAGE_CONTENT_PROOF = 'zone-page';

export interface ZonePageContentRequest {
  action: string;
  /** Set only by withZonePageContentTarget after the server resolves the page. */
  resolvedZonePage?: string;
  baselineRelatedWork?: string | null;
  baselineSourceRevision?: string | null;
  baselineContribution?: string | null;
  baselineCollectionCreate?: boolean;
}

export type ZonePageContentResolution =
  | { kind: 'absent' }
  | { kind: 'refused' }
  | { kind: 'zone'; zone: string };

/** Content calls this with the Zone its server resolution returned, then registers
 * the same content.draft or content.publish request. The zone is covered by
 * requestDigest. Draft reads call zonePageContentAllowed with that same zone.
 * Published bundle reads do not: they stay on the Zone's public visibility. */
export function withZonePageContentTarget<T extends ZonePageContentRequest>(
  request: T, zone: string,
): T & { resolvedZonePage: string } {
  return { ...request, resolvedZonePage: zone };
}

export function zoneEditScope(zone: string): string {
  return `zone:edit:${zone}`;
}

/** Absent for Work, Post and every action other than content draft or publish.
 * Refused when a zone-page marker is mixed with a reply, contribution or an id
 * that is not a native resource, so that request cannot fall through to Work authority. */
export function resolveZonePageContent(request: ZonePageContentRequest): ZonePageContentResolution {
  if (request.action !== 'content.draft' && request.action !== 'content.publish') return { kind: 'absent' };
  if (request.resolvedZonePage === undefined) return { kind: 'absent' };
  if (request.baselineRelatedWork || request.baselineSourceRevision || request.baselineContribution
    || request.baselineCollectionCreate === true || !native.test(request.resolvedZonePage)) {
    return { kind: 'refused' };
  }
  return { kind: 'zone', zone: request.resolvedZonePage };
}

export function savedZonePageContent(saved: {
  realm_membership?: string | null;
  author_work?: string | null;
  author_generation?: string | null;
}, action: string): string | null {
  if ((action !== 'content.draft' && action !== 'content.publish')
    || saved.realm_membership !== ZONE_PAGE_CONTENT_PROOF
    || saved.author_generation != null
    || !saved.author_work || !native.test(saved.author_work)) return null;
  return saved.author_work;
}

/** The zone.edit decision for a server-resolved Zone page. Content calls this
 * for a draft read, passing the verified-email flag from the account assertion.
 * Stewardship counts only for a verified account, matching zone.edit's baseline.
 * A platform administrator is admitted on the zone.edit resource grant either way.
 * Draft and publish admissions call it at register and again at claim.
 * Published bundle reads do not: they stay on the Zone's public visibility.
 * Cost: one Zone stewardship lookup for a verified account, then one bounded
 * platform permission read and at most one Zone ownership ASK when that misses. */
export async function zonePageContentAllowed(
  client: PoolClient,
  graph: Pick<FusekiClient, 'query'> | undefined,
  principalId: string,
  actingSubject: string,
  zone: string,
  emailVerified: boolean,
): Promise<boolean> {
  if (!native.test(zone) || !native.test(actingSubject)) return false;
  if (emailVerified && await zoneSpaceCreatorAllowed(client, graph, principalId, actingSubject, zone)) return true;
  return platformAdministratorTargetAllowed(client, graph, principalId, actingSubject,
    'zone.edit', zoneEditScope(zone));
}

/** True when the pinned zone page is still covered by the platform resource grant.
 * Claim uses it so an administrator does not also need the steward's verified email. */
export async function zonePageAdministratorAllowed(
  client: PoolClient,
  graph: Pick<FusekiClient, 'query'> | undefined,
  principalId: string,
  actingSubject: string,
  saved: { realm_membership?: string | null; author_work?: string | null; author_generation?: string | null },
  action: string,
): Promise<boolean> {
  const zone = savedZonePageContent(saved, action);
  if (!zone) return false;
  return platformAdministratorTargetAllowed(client, graph, principalId, actingSubject,
    'zone.edit', zoneEditScope(zone));
}
