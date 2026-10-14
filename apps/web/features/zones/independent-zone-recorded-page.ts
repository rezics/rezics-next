import type { CanonicalAddress } from '@rezics/model/address';
import type { ZoneContext, ZoneTokens } from '@rezics/zone-sdk';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { addressKey } from '../address/path.ts';
import type { browserMainApi } from '../api/browser.ts';
import { isOfflineError } from '../feed/types.ts';
import { zoneContentText } from '../language/untagged.ts';
import { failureOf as managementFailure, type ReadFailure as ManagementFailure } from '../manage/types.ts';
import { zoneText } from '../realm/adapt.ts';
import { completePublicNavigation } from '../realm/public-navigation.ts';
import { idOf, siteHref } from '../realm/route.ts';
import { failureOf, type ReadFailure, type ZonePresentationRead } from '../realm/types.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { savedSiteCuts, type SiteMountCut, type SitePresentationCut } from './site-cuts.ts';
import { zoneTheme, type ReaderTheme } from './theme.ts';
import {
  mapZoneSiteRecordedPage,
  zoneSitePrefix,
  type ZoneSiteCredit,
  type ZoneSiteMapped,
  type ZoneSiteProblem,
  type ZoneSiteRead,
} from './zone-site-recorded-page.ts';

/**
 * Published home of a Zone with no Realm. The standalone route builds the same
 * context and frame; stories replay the visit through the supplied client.
 * A presentation or route that names a Realm is a different page.
 */

type MainClient = ReturnType<typeof browserMainApi>;
type TreatyAnswer<T> = {
  data: T | null;
  error: { status: number; value: unknown } | null;
  response?: unknown;
  headers?: unknown;
};

const replayGap = /Unmatched recorded request|Recorded sample|Ambiguous recorded request|cannot supply/;

function problemOf(status: number, value: unknown): ZoneSiteProblem | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.title !== 'string' || typeof body.code !== 'string') return null;
  if (typeof body.status === 'number' && body.status !== status) return null;
  return { status, title: body.title, code: body.code };
}

interface Settled<T, Failure extends string> {
  loaded: { ok: true; data: T } | { ok: false; failure: Failure };
  problem: ZoneSiteProblem | null;
}

async function settle<T, Failure extends string>(
  call: () => Promise<TreatyAnswer<T>>,
  fail: (status: number, value: unknown) => Failure,
  closed: { offline: Failure; unavailable: Failure },
): Promise<Settled<T, Failure>> {
  try {
    let answer = await call();
    if (!answer.response && answer.error) {
      const value = answer.error.value;
      throw value instanceof Error ? value : new Error(typeof value === 'string' ? value : JSON.stringify(value));
    }
    if (answer.error?.status === 409) answer = await call();
    if (answer.error) {
      return {
        loaded: { ok: false, failure: fail(answer.error.status, answer.error.value) },
        problem: problemOf(answer.error.status, answer.error.value),
      };
    }
    return answer.data == null
      ? { loaded: { ok: false, failure: closed.unavailable }, problem: null }
      : { loaded: { ok: true, data: answer.data }, problem: null };
  } catch (error) {
    if (error instanceof Error && replayGap.test(error.message)) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { loaded: { ok: false, failure: isOfflineError(error) ? closed.offline : closed.unavailable }, problem: null };
  }
}

const publicClosed = { offline: 'offline', unavailable: 'unavailable' } as const;
function readPublic<T>(call: () => Promise<TreatyAnswer<T>>) {
  return settle(call, (status, value) => failureOf(status, value), publicClosed);
}

export interface IndependentZoneIdentity {
  zone: string;
  canonical: CanonicalAddress;
}

/** The space key and acting person on the selected visit, taken from its request URLs. */
export function independentZoneVisit(record: AnswerRecord, persona: AnswerPersona, selections: readonly RecordedSelection[]): {
  space: string;
  actingSubject?: string;
} {
  const samples = selections.map(selection => {
    const found = record.personas[persona].filter(sample => sample.label === selection.label);
    if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${selection.label}`);
    return found[0]!;
  });
  const address = samples.find(sample => new URL(sample.path, 'https://recorded.invalid').pathname === '/v1/addresses/resolve');
  if (!address) throw new Error(`${record.row}/${persona} visit has no address request`);
  const addressUrl = new URL(address.path, 'https://recorded.invalid');
  const space = addressUrl.searchParams.get('key');
  if (addressUrl.searchParams.get('scope') !== 'space' || !space) {
    throw new Error(`${record.row}/${persona} address request is not a space key`);
  }
  const subjects = new Set(samples.flatMap(sample => {
    const acting = new URL(sample.path, 'https://recorded.invalid').searchParams.get('actingSubject');
    return acting ? [acting] : [];
  }));
  if (subjects.size > 1) throw new Error(`${record.row}/${persona} visit names two acting subjects`);
  const actingSubject = [...subjects][0];
  return actingSubject ? { space, actingSubject } : { space };
}

/** Realm stays null: this path is only the Zone, using the address the visit resolved. */
export function independentZoneContext(
  presentation: ZonePresentationRead,
  canonical: CanonicalAddress,
  locale: UiLocale,
): { zone: ZoneContext; ref: string } {
  const ref = addressKey(canonical);
  return {
    ref,
    zone: {
      slug: presentation.official,
      realm: null,
      name: zoneContentText(presentation.name ?? canonical.suffixSource, presentation.language),
      description: null,
      icon: null,
      hero: null,
      tokens: presentation.presentation.tokens,
      locale,
      links: {
        home: siteHref(locale, ref, []),
        browse: siteHref(locale, ref, ['browse']),
        works: siteHref(locale, ref, ['browse']),
        discussions: '',
        decisions: '',
        about: '',
      },
    },
  };
}

/** Cuts and theme the standalone frame paints, including a saved preview's token override. */
export function independentZoneFrame({ zone, address, locale, homeName, presentation, siteMounts, siteTokens,
  siteNavigation, readerTheme }: {
  zone: ZoneContext;
  address: string;
  locale: UiLocale;
  homeName: string;
  presentation: ZonePresentationRead;
  siteMounts?: readonly SiteMountCut[];
  siteTokens?: ZoneTokens;
  siteNavigation?: SitePresentationCut['navigation'];
  readerTheme: ReaderTheme;
}) {
  const tokens = siteTokens ?? presentation.presentation.tokens;
  const frameZone = siteTokens ? { ...zone, tokens: siteTokens } : zone;
  const cuts = savedSiteCuts(
    { tokens, navigation: siteNavigation ?? presentation.presentation.navigation },
    siteMounts ?? presentation.navigation.map(mount => ({ segment: mount.segment, name: zoneText(mount.name) })),
    address,
    locale,
    homeName,
  );
  return { zone: frameZone, cuts, theme: zoneTheme(cuts.tokens, { reader: readerTheme, enabled: true }) };
}

function zoneIdentity(value: unknown): IndependentZoneIdentity | { detail: string } {
  if (!value || typeof value !== 'object') return { detail: 'address answer is not a record' };
  const data = value as Record<string, unknown>;
  if (data.status !== 'resolved' || data.scope !== 'space') return { detail: 'address is not a resolved space' };
  const canonical = data.canonical;
  if (!canonical || typeof canonical !== 'object') return { detail: 'address has no canonical site' };
  const site = canonical as Record<string, unknown>;
  if (site.prefix !== zoneSitePrefix || typeof site.key !== 'string' || typeof site.suffixSource !== 'string') {
    return { detail: 'address canonical is not a zone site' };
  }
  const capabilities = data.capabilities;
  if (!capabilities || typeof capabilities !== 'object') return { detail: 'address has no capabilities' };
  const caps = capabilities as Record<string, unknown>;
  if (typeof caps.zone !== 'string') return { detail: 'address has no zone' };
  const zone = idOf(caps.zone);
  if (!zone) return { detail: 'address zone is not a native id' };
  if (caps.realm !== undefined) return { detail: 'address names a realm' };
  return { zone, canonical: { prefix: zoneSitePrefix, key: site.key, suffixSource: site.suffixSource } };
}

export type IndependentZoneEditor =
  | { ok: true }
  | { ok: false; failure: ManagementFailure; problem: ZoneSiteProblem | null };

export type IndependentZoneRead =
  | {
      kind: 'published';
      mapped: Extract<ZoneSiteMapped, { kind: 'published' }>;
      presentation: ZonePresentationRead;
      zone: ZoneContext;
      ref: string;
      zoneId: string;
      credit: ZoneSiteCredit | null;
      editor: IndependentZoneEditor | null;
    }
  | {
      kind: 'empty';
      mapped: Extract<ZoneSiteMapped, { kind: 'empty' }>;
      presentation: ZonePresentationRead;
      zone: ZoneContext;
      ref: string;
      zoneId: string;
      editor: IndependentZoneEditor | null;
    }
  | { kind: 'refusal'; problem: ZoneSiteProblem | null }
  | { kind: 'unavailable'; failure: ReadFailure }
  | { kind: 'discrepancy'; detail: string };

/**
 * The standalone home visit: anonymous address, complete presentation, home route,
 * and the editor link only when an acting person is already selected.
 * The caller supplies the client (the host's in production, a replay in a story).
 */
export async function readIndependentZonePublished(client: MainClient, input: {
  space: string;
  locale: UiLocale;
  actingSubject?: string;
}): Promise<IndependentZoneRead> {
  const actingSubject = input.actingSubject;
  const address = await readPublic(() => client.v1.addresses.resolve.get({ query: { scope: 'space', key: input.space } }));
  if (!address.loaded.ok) return { kind: 'unavailable', failure: address.loaded.failure };
  const identity = zoneIdentity(address.loaded.data);
  if ('detail' in identity) return { kind: 'discrepancy', detail: identity.detail };
  const zone = identity.zone;
  let presentationProblem: ZoneSiteProblem | null = null;
  const [presentationLoaded, route] = await Promise.all([
    completePublicNavigation(async after => {
      const read = await readPublic(() => client.v1.zones({ id: zone }).presentation.get({ query: { actingSubject, after } }));
      if (!read.loaded.ok) presentationProblem = read.problem;
      return read.loaded;
    }),
    readPublic(() => client.v1.zones({ id: zone }).routes.get({ query: { actingSubject, path: '/' } })),
  ]);
  const presentation: ZoneSiteRead<ZonePresentationRead> = {
    loaded: presentationLoaded,
    problem: presentationLoaded.ok ? null : presentationProblem,
  };
  if (presentation.loaded.ok && presentation.loaded.data.realm !== null) {
    return { kind: 'discrepancy', detail: 'presentation realm is not null' };
  }
  if (route.loaded.ok && route.loaded.data.realm !== null) {
    return { kind: 'discrepancy', detail: 'route realm is not null' };
  }
  const mapped = mapZoneSiteRecordedPage({ presentation, route });
  if (mapped.kind === 'discrepancy' || mapped.kind === 'unavailable' || mapped.kind === 'refusal') return mapped;
  if (!presentation.loaded.ok) return { kind: 'unavailable', failure: 'unavailable' };
  const editor = actingSubject ? await readEditor(client, zone, actingSubject) : null;
  const { zone: context, ref } = independentZoneContext(presentation.loaded.data, identity.canonical, input.locale);
  if (mapped.kind === 'empty') {
    return { kind: 'empty', mapped, presentation: presentation.loaded.data, zone: context, ref, zoneId: zone, editor };
  }
  return {
    kind: 'published',
    mapped,
    presentation: presentation.loaded.data,
    zone: context,
    ref,
    zoneId: zone,
    credit: mapped.credit,
    editor,
  };
}

async function readEditor(client: MainClient, zone: string, actingSubject: string): Promise<IndependentZoneEditor> {
  const read = await settle(
    () => client.v1.zones({ id: zone })['showcase-editor'].get({ query: { actingSubject } }),
    status => managementFailure(status, true),
    { offline: 'unavailable', unavailable: 'unavailable' },
  );
  if (!read.loaded.ok) return { ok: false, failure: read.loaded.failure, problem: read.problem };
  return { ok: true };
}
