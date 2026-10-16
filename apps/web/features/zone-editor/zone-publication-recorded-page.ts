import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { addressKey, spaceHref } from '../address/path.ts';
import { browserMainApi } from '../api/browser.ts';
import { gateFor, parsePlatformAccess } from '../api/platform-access.ts';
import { readMemberBan } from '../realm-appeal/ban-read.ts';
import { zoneText } from '../realm/adapt.ts';
import { readMembership } from '../realm/membership-state.ts';
import type { ZoneText } from '@rezics/zone-sdk';
import type { ZonePresentationRead } from '../realm/types.ts';
import { realmFrameReads } from '../realm/zone-presentation-read.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import type { PublicationChoice } from './model.ts';
import { mapZoneSiteHome, readZoneSiteRecorded, zoneSitePrefix, type ZoneSiteMapped, type ZoneSiteRecordedLoad } from '../zones/zone-site-recorded-page.ts';

/**
 * Publication's public page is the Zone site. The site route and this page call
 * the same frame reader and mapping, so a story cannot show a cut the presentation
 * did not carry. A signed-in visit puts `actingSubject` on the personal client;
 * the anonymous address and Realm header do not.
 */

const recordedOrigin = 'https://recorded.invalid';

/** Replay the selected public reads through the typed client and the shared site mapping. */
export function readZonePublicationRecorded(
  fetcher: typeof fetch,
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): Promise<ZoneSiteRecordedLoad> {
  return readZoneSiteRecorded(fetcher, record, persona, selections);
}

export interface ZonePublicationFrameView {
  kind: 'attached' | 'standalone' | 'refusal';
  mapped: ZoneSiteMapped;
  presentation: ZonePresentationRead | null;
  realmName: ZoneText | null;
  realmId: string | null;
  realmRef: string | null;
  ref: string | null;
  backHref: string | null;
}

export type ZonePublicationTarget =
  | { mode: 'frame'; space: string; actingSubject: string | null; homeRoute: boolean }
  | { mode: 'route'; space: string; path: string; actingSubject: string | null };

function sampleUrl(sample: AnswerSample): URL {
  return new URL(sample.path, recordedOrigin);
}

function zoneOf(sample: AnswerSample): string | null {
  return /\/v1\/zones\/([0-9a-f-]{36})(?:\/|$)/.exec(sampleUrl(sample).pathname)?.[1] ?? null;
}

/** The space, actor and route the selected production samples name. */
export function publicationTarget(
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): ZonePublicationTarget {
  const samples = selections.map(selection => sampleOf(record, persona, selection.label));
  const presentation = samples.find(sample => sampleUrl(sample).pathname.endsWith('/presentation'));
  const route = samples.find(sample => sampleUrl(sample).pathname.endsWith('/routes'));
  const address = samples.find(sample => sampleUrl(sample).pathname.endsWith('/addresses/resolve'));
  if (presentation) {
    const space = zoneOf(presentation);
    if (!space) throw new Error(`Publication presentation ${record.row}/${persona} has no Zone`);
    const homeRoute = route ? sampleUrl(route).searchParams.get('path') === '/' : false;
    return { mode: 'frame', space, actingSubject: sampleUrl(presentation).searchParams.get('actingSubject'), homeRoute };
  }
  if (route && address) {
    const space = sampleUrl(address).searchParams.get('key');
    const path = sampleUrl(route).searchParams.get('path');
    if (!space || path === null) throw new Error(`Publication route ${record.row}/${persona} has no space`);
    return { mode: 'route', space, path, actingSubject: sampleUrl(route).searchParams.get('actingSubject') };
  }
  throw new Error(`Publication visit ${record.row}/${persona} has no presentation or route`);
}

function clients(fetcher: typeof fetch, actingSubject: string | null) {
  const anonymous = browserMainApi(recordedOrigin, { anonymous: true, fetcher });
  const personal = browserMainApi(recordedOrigin, { anonymous: actingSubject === null, fetcher });
  return { anonymous, personal, frames: realmFrameReads({
    main: anonymous, personal, actingSubject: actingSubject ?? undefined,
  }) };
}

function siteRef(presentation: ZonePresentationRead): string | null {
  const address = presentation.address;
  if (!address || address.prefix !== zoneSitePrefix || typeof address.key !== 'string' || typeof address.suffixSource !== 'string') {
    return null;
  }
  return addressKey({ prefix: zoneSitePrefix, key: address.key, suffixSource: address.suffixSource });
}

/**
 * The public frame visit: anonymous address and Realm header, personal presentation,
 * then membership, platform access and the member ban when an acting Person is present.
 */
export async function readZonePublicationFrame(
  fetcher: typeof fetch,
  space: string,
  locale: UiLocale,
  actingSubject: string | null,
  homeRoute = false,
): Promise<ZonePublicationFrameView> {
  const { personal, frames } = clients(fetcher, actingSubject);
  const resolved = await frames.resolveRealm(space, locale, 'site');
  if (resolved.kind === 'realm' && resolved.zone) {
    if (actingSubject) {
      await readMembership(personal, resolved.header.id, actingSubject);
      const access = await browserMainApi(recordedOrigin, { fetcher }).v1.me['platform-access'].get();
      await readMemberBan(personal, resolved.header.id, actingSubject, gateFor(parsePlatformAccess(access.data)));
    }
    const publication = await frames.readCompletePresentation(resolved.zone.id);
    if (!publication.ok) {
      return { kind: 'attached', mapped: { kind: 'unavailable', failure: publication.failure }, presentation: null,
        realmName: zoneText(resolved.header.name), realmId: resolved.header.id, realmRef: resolved.ref,
        ref: resolved.siteRef ?? null, backHref: null };
    }
    if (homeRoute) await frames.readZoneRoute(resolved.zone.id, '/');
    return {
      kind: 'attached', mapped: mapZoneSiteHome(publication.data), presentation: publication.data,
      realmName: zoneText(resolved.header.name), realmId: resolved.header.id, realmRef: resolved.ref,
      ref: resolved.siteRef ?? siteRef(publication.data), backHref: null,
    };
  }
  const publication = await frames.readCompletePresentation(space);
  if (!publication.ok) {
    return { kind: 'standalone', mapped: { kind: 'unavailable', failure: publication.failure }, presentation: null,
      realmName: null, realmId: null, realmRef: null, ref: null, backHref: null };
  }
  if (homeRoute) await frames.readZoneRoute(space, '/');
  return {
    kind: 'standalone', mapped: mapZoneSiteHome(publication.data), presentation: publication.data,
    realmName: null, realmId: null, realmRef: null, ref: siteRef(publication.data), backHref: null,
  };
}

/** A missing mounted path: the anonymous address, then the route refusal. */
export async function readZonePublicationRoute(
  fetcher: typeof fetch,
  space: string,
  locale: UiLocale,
  path: string,
  actingSubject: string | null,
): Promise<ZonePublicationFrameView> {
  const { frames } = clients(fetcher, actingSubject);
  const address = await frames.readAddress(space, locale);
  const route = await frames.readZoneRoute(space, path);
  const canonical = address.kind === 'resolved' ? address.data.canonical : null;
  const backHref = canonical?.prefix === zoneSitePrefix ? spaceHref(canonical, 'site') : null;
  const ref = canonical?.prefix === zoneSitePrefix ? addressKey(canonical) : null;
  if (!route.ok && route.failure === 'missing' && route.problem && typeof route.problem === 'object') {
    const problem = route.problem as { title?: unknown; code?: unknown; status?: unknown };
    if (typeof problem.title === 'string' && typeof problem.code === 'string' && route.status) {
      return { kind: 'refusal', mapped: { kind: 'refusal', problem: { status: route.status, title: problem.title, code: problem.code } },
        presentation: null, realmName: null, realmId: null, realmRef: null, ref, backHref };
    }
  }
  return { kind: 'refusal', mapped: { kind: 'discrepancy', detail: 'publication route was not a recorded refusal' },
    presentation: null, realmName: null, realmId: null, realmRef: null, ref, backHref };
}

function sampleOf(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(sample => sample.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

/** The Zone the management configuration names, and the acting Person on that read. */
export function managementVisit(
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): { space: string; actingSubject: string } {
  const actingSubject = recordedActingPerson(record, persona, selections);
  if (!actingSubject) throw new Error(`Management visit ${record.row}/${persona} has no acting Person`);
  for (const selection of selections) {
    const space = /\/v1\/zones\/([0-9a-f-]{36})\/configuration(?:\?|$)/.exec(sampleOf(record, persona, selection.label).path)?.[1];
    if (space) return { space, actingSubject };
  }
  throw new Error(`Management visit ${record.row}/${persona} has no configuration read`);
}

/** The production publish body, taken from the recorded command rather than assembled again. */
export function recordedPublicationChoice(record: AnswerRecord, persona: AnswerPersona, label: string): {
  zoneId: string;
  actingSubject: string;
  choice: PublicationChoice;
} {
  const sample = sampleOf(record, persona, label);
  const zoneId = zoneOf(sample);
  const body = sample.body;
  if (!zoneId || !body || typeof body !== 'object') throw new Error(`Recorded ${record.row}/${persona}/${label} is not a publication command`);
  const wire = body as { expectedHead?: unknown; actingSubject?: unknown; navigationRevision?: unknown; pages?: unknown };
  const page = Array.isArray(wire.pages) ? wire.pages[0] as Record<string, unknown> | undefined : undefined;
  if (typeof wire.expectedHead !== 'string' || typeof wire.actingSubject !== 'string' || typeof wire.navigationRevision !== 'string'
    || typeof page?.page !== 'string' || typeof page.variantId !== 'string' || typeof page.revisionId !== 'string'
    || typeof page.byteDigest !== 'string' || typeof page.contentEpoch !== 'string') {
    throw new Error(`Recorded ${record.row}/${persona}/${label} publication body is incomplete`);
  }
  return {
    zoneId, actingSubject: wire.actingSubject,
    choice: {
      routesRevision: wire.navigationRevision, navigationRevision: wire.navigationRevision, zoneHead: wire.expectedHead,
      page: page.page, variantId: page.variantId, revisionId: page.revisionId, byteDigest: page.byteDigest,
      contentEpoch: page.contentEpoch,
    },
  };
}

/** The viewer's acting Person on these reads. Absent when the recorded request has none. */
export function recordedActingPerson(
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
): string | null {
  for (const selection of selections) {
    const acting = new URL(sampleOf(record, persona, selection.label).path, 'https://recorded.invalid')
      .searchParams.get('actingSubject');
    if (acting) return acting;
  }
  return null;
}
