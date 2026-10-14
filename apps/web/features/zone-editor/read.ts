import { cache } from 'react';
import { headers } from 'next/headers';
import { ADDRESS_HEADER, resolvedAddress } from '../address/client.ts';
import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../manage/types.ts';
import { idOf } from '../realm/route.ts';
import { SPACE_MISSING_HEADER } from '../realm/missing.ts';
import { resolveSite, type SiteResolution } from '../realm/read.ts';
import { readManagementAddress, readZoneRecoveryReturnAddress, suppliedManagementSite, zoneAuthoringFromAddress,
  zoneLifecycleFromAddress, zoneManagementFrameFromReads, type ZoneAuthoringLoad, type ZoneLifecycleLoad,
  type ZoneManagementFrame } from './authoring-reads.ts';
import type { ZoneManagementBinding } from './management-address.ts';

export type { ZoneAuthoringLoad, ZoneAuthoringPreview, ZoneLifecycleLoad, ZoneManagementFrame } from './authoring-reads.ts';

/** Recovery can outlive a cached retired address. Revalidate with the same admission owner. */
export async function readZoneAuthoringSite(space: string, locale: UiLocale,
  resolve = resolveSite,
): Promise<SiteResolution> {
  const site = await resolve(space, locale);
  return site.kind === 'missing' ? resolve(space, locale, true) : site;
}

export const resolveZoneAuthoringSite = cache(readZoneAuthoringSite);

/** A proxy admission stands. Otherwise the acting person reads the Space, and a miss uses the host landing. */
async function hostManagementSite(main: MainClient, actingSubject: string, ref: string, locale: UiLocale,
): Promise<SiteResolution> {
  const incoming = await headers();
  if (incoming.get(SPACE_MISSING_HEADER) === '1') return { kind: 'missing' };
  const carried = incoming.get(ADDRESS_HEADER);
  if (carried) {
    try {
      const data = resolvedAddress(JSON.parse(decodeURIComponent(carried)));
      if (data?.scope === 'space' && (data.key === ref || data.holder.slice(-36) === ref)) {
        const zone = idOf(data.capabilities?.zone ?? '');
        if (zone) return { kind: 'site', address: data, zone, realm: idOf(data.capabilities?.realm ?? '') };
      }
    } catch { /* A malformed internal header is never admission. */ }
  }
  const site = await suppliedManagementSite(main, actingSubject)(ref, locale);
  return site.kind === 'missing' ? resolveZoneAuthoringSite(ref, locale) : site;
}

const resolveManagementAddress = cache((main: MainClient, space: string, locale: UiLocale, actingSubject: string) =>
  readManagementAddress(main, space, locale, actingSubject, (ref, loc) => hostManagementSite(main, actingSubject, ref, loc)));

/**
 * The home draft and the two heads a publish names. Shared by the editor and its preview
 * for one request. An editor who cannot read the draft is refused here, never shown the public page.
 */
export const loadZoneAuthoring = cache(async (
  main: MainClient, space: string, locale: UiLocale, actingSubject: string,
): Promise<ZoneAuthoringLoad> => zoneAuthoringFromAddress(main, space, actingSubject,
  await resolveManagementAddress(main, space, locale, actingSubject)));

/**
 * Authorized lifecycle entry. A retired site's public Space resolver no longer
 * yields its Zone capability, so the stable Zone UUID is also a management key.
 */
export const loadZoneLifecycle = cache(async (
  main: MainClient, space: string, locale: UiLocale, actingSubject: string,
): Promise<ZoneLifecycleLoad> => zoneLifecycleFromAddress(main, space, actingSubject,
  await resolveManagementAddress(main, space, locale, actingSubject)));

/** Validate aliases with the address owner; a retired or unavailable alias falls back to the bound Space. */
export function loadZoneRecoveryReturnAddress(main: MainClient, candidate: unknown,
  binding: Pick<ZoneManagementBinding, 'zoneId' | 'spaceId'>, actingSubject: string,
): Promise<string> {
  return readZoneRecoveryReturnAddress(main, candidate, binding, actingSubject);
}

/** The layout's frame. The two cached reads share one address admission, including a carried proxy header. */
export const loadZoneManagementFrame = cache(async (
  main: MainClient, space: string, locale: UiLocale, actingSubject: string,
): Promise<ZoneManagementFrame> => {
  const [authoring, lifecycle] = await Promise.all([
    loadZoneAuthoring(main, space, locale, actingSubject),
    loadZoneLifecycle(main, space, locale, actingSubject),
  ]);
  const pageUrl = (await headers()).get('x-rezics-page-url');
  let requestedReturn: string | null = null;
  try { requestedReturn = pageUrl ? new URL(pageUrl).searchParams.get('address') : null; } catch { /* No return override. */ }
  return zoneManagementFrameFromReads(main, space, actingSubject, authoring, lifecycle, requestedReturn);
});
