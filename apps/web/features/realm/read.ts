import { cache } from 'react';
import { recordedReplayGap, settleFrame, zonePresentationReads, type RealmFrameRead } from './zone-presentation-read.ts';
export type { RealmFrameRead } from './zone-presentation-read.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken, readPlatformAccess } from '../api/main.ts';
import { operationOpen } from '../api/platform-access.ts';
import { idOf } from './route.ts';
import { SPACE_MISSING_HEADER } from './missing.ts';
import { resolveAddress } from '../address/server.ts';
import { addressKey } from '../address/path.ts';
import { resolvedAddress, type AddressRead, type ResolvedAddress } from '../address/client.ts';
import type { MainClient } from '../discover/types.ts';
import { isOfflineError } from '../feed/types.ts';
import { cookies, headers } from 'next/headers';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState, sessionReadSubject } from '../auth/session.ts';
import { displayLanguages } from '../../i18n/display-languages.ts';
import { readSpacePage } from '../address/space-read.ts';
import type { JoinPage } from '../manage/settings-api.ts';
import { readBrowseAnswer, settleRealmRead as settle } from './browse-page-read.ts';
import {
  type AgentRead,
  type FacetList,
  type Loaded,
  type ModReleasePage,
  type RankingMetric,
  type RankingPage,
  type RealmDecisionsPage,
  type RealmDecisionRead,
  type RealmDirectoryPage,
  type ReadFailure,
  type RealmHeader,
  type RealmRoster,
  type RealmWorksPage,
  type RealmZoneRead,
  type ZoneChapterPage,
  type ZoneDecisionPage,
  type ZoneEditorLists,
  type ZoneBrowsePage,
  type ZoneBrowseQuery,
  type ZoneGenrePage,
  type ZonePresentationRead,
  type ZoneReplyPage,
  type ZoneRouteRead,
  type ZoneWorkPage,
} from './types.ts';

// Published modules use the public viewer. Member-readable Realm and Zone
// reads carry the eligible saved Agent; every cache is scoped to this request.

const main = () => mainApiWithToken(undefined);

const readerMain = cache(async () => {
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  const actingSubject = sessionReadSubject(token ? await sessionAgentState() : null) ?? undefined;
  return { main: mainApiWithToken(actingSubject ? token : undefined), actingSubject };
});

export type RealmResolution =
  | {
      kind: 'realm';
      ref: string;
      realm: string;
      header: RealmHeader;
      zone: { id: string; segment: string | null } | null;
      /** The attached Zone may occupy a different Space from this Realm. */
      siteRef?: string;
    }
  | { kind: 'missing' }
  | { kind: 'join'; page: JoinPage }
  | { kind: 'unavailable'; failure?: ReadFailure; reference?: string };

/** Public header adapter retained for rules readers and their recorded surfaces. */
export function readPublishedRealmHeader(client: MainClient, realm: string, keepProblem = false): Promise<RealmFrameRead<RealmHeader>> {
  return realmFrameReads({ main: client, keepProblem }).readRealmHeader(realm);
}

export type SiteResolution =
  | { kind: 'site'; address: ResolvedAddress; zone: string; realm: string | null }
  | { kind: 'join'; page: JoinPage }
  | { kind: 'missing' }
  | { kind: 'unavailable'; failure?: ReadFailure; reference?: string };

/**
 * The shared frame reader. Public reads use main; member-readable presentation,
 * and routes use personal with the eligible acting subject.
 * Host address admission and private landing adapters retain their request caches,
 * language headers and conditional requests at the production boundary.
 */
export function realmFrameReads({ main, personal = main, actingSubject, resolution, keepProblem = true }: {
  main: MainClient;
  personal?: MainClient;
  actingSubject?: string;
  /** Production keeps its existing Loaded contract; recorded frames retain the HTTP problem. */
  keepProblem?: boolean;
  resolution?: {
    resolveAddress?: typeof resolveAddress;
    readPrivateRealm?: typeof readPrivateRealm;
    readRealmHeader?: typeof readRealmHeader;
    readCompletePresentation?: typeof readCompletePresentation;
  };
}) {
  const presentation = zonePresentationReads(personal, actingSubject, keepProblem);
  const readRealmHeader = (realm: string): Promise<RealmFrameRead<RealmHeader>> =>
    settleFrame(() => main.v1.realms({ realm }).get({ query: {} }), undefined, keepProblem);
  const readHeader = resolution?.readRealmHeader ?? ((realm: string, _locale: UiLocale) => readRealmHeader(realm));
  const readPublication = resolution?.readCompletePresentation
    ?? presentation.readCompletePresentation;
  const resolve = resolution?.resolveAddress ?? (async (_scope: 'space', key: string, _locale: UiLocale, _fresh = false): Promise<AddressRead> => {
    try {
      const answer = await main.v1.addresses.resolve.get({ query: { scope: 'space', key } });
      if (answer.error) {
        if (!answer.response && answer.error.value instanceof Error) throw answer.error.value;
        const status = Number(answer.error.status);
        if ([400, 404, 422].includes(status)) return { kind: 'missing' };
        if (status === 410) return { kind: 'retired' };
        if (status === 429) {
          const seconds = Number(answer.response.headers.get('retry-after'));
          return { kind: 'unavailable', status: 429,
            retryAfter: String(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60) };
        }
        return { kind: 'unavailable' };
      }
      const data = resolvedAddress(answer.data);
      return data?.scope === 'space' ? { kind: 'resolved', data } : { kind: 'unavailable' };
    } catch (error) {
      if (recordedReplayGap(error)) throw error;
      return isOfflineError(error) ? { kind: 'unavailable', failure: 'offline' } : { kind: 'unavailable' };
    }
  });
  // Private landing belongs to the existing address reader. Replay must supply
  // its supporting read explicitly rather than enter the host's session boundary.
  const privateRealm = resolution?.readPrivateRealm ?? (async (ref: string) => {
    throw new Error(`Missing supporting Realm frame private-resolution reader: ${ref}`);
  });
  return {
    readRealmHeader,
    readRealmZone: (realm: string): Promise<RealmFrameRead<RealmZoneRead>> =>
      settleFrame(() => personal.v1.realms({ realm }).zone.get({ query: { actingSubject } }), undefined, keepProblem),
    readFacets: (): Promise<RealmFrameRead<FacetList>> => settleFrame(() => main.v1.facets.get(), undefined, keepProblem),
    readAddress: (ref: string, locale: UiLocale, fresh = false) => resolve('space', ref, locale, fresh),
    ...presentation,
    readZoneRoute: (zone: string, path: string, cursor?: string): Promise<RealmFrameRead<ZoneRouteRead>> =>
      settleFrame(() => personal.v1.zones({ id: zone }).routes.get({ query: { actingSubject, path, cursor } }), cursor),
    resolveRealm: async (ref: string, locale: UiLocale, surface: 'community' | 'site' = 'community'): Promise<RealmResolution> => {
      const resolved = await resolve('space', ref, locale);
      if (resolved.kind !== 'resolved') {
        if (resolved.kind !== 'missing')
          return resolved.kind === 'unavailable'
            ? { kind: 'unavailable', ...(resolved.failure ? { failure: resolved.failure } : {}) }
            : { kind: 'missing' };
        const fallback = await privateRealm(ref, locale);
        if (fallback.kind !== 'realm') return fallback;
        // Keep an admitted legacy identity when no public landing address exists;
        // never guess a Zone or Space name from a private header.
        return {
          kind: 'realm',
          ref,
          realm: idOf(fallback.header.id)!,
          header: fallback.header,
          zone: null,
        };
      }
      const zoneId = idOf(resolved.data.capabilities?.zone ?? '');
      let realm = idOf(resolved.data.capabilities?.realm ?? '');
      const attached = zoneId && (surface === 'site' || !realm);
      if (attached) {
        const publication = await readPublication(zoneId);
        if (!publication.ok) return publication.failure === 'missing' ? { kind: 'missing' }
          : { kind: 'unavailable', failure: publication.failure, ...(publication.reference ? { reference: publication.reference } : {}) };
        realm = idOf(publication.data.realm ?? '');
      }
      if (!realm) return { kind: 'missing' };
      const header = await readHeader(realm, locale);
      const page = header.ok
        ? { kind: 'realm' as const, header: header.data }
        : header.failure === 'missing'
          ? await privateRealm(attached ? realm : ref, locale, attached ? undefined : resolved.data)
          : { kind: 'unavailable' as const, failure: header.failure, ...(header.reference ? { reference: header.reference } : {}) };
      if (page.kind !== 'realm') return page;
      return {
        kind: 'realm',
        ref: attached ? idOf(page.header.space)! : addressKey(resolved.data.canonical),
        ...(surface === 'site' ? { siteRef: addressKey(resolved.data.canonical) } : {}),
        realm,
        header: page.header,
        zone: zoneId ? { id: zoneId, segment: null } : null,
      };
    },
    resolveSite: async (ref: string, locale: UiLocale, fresh = false): Promise<SiteResolution> => {
      const resolved = await resolve('space', ref, locale, fresh);
      if (resolved.kind !== 'resolved') {
        if (resolved.kind !== 'missing')
          return resolved.kind === 'unavailable'
            ? { kind: 'unavailable', ...(resolved.failure ? { failure: resolved.failure } : {}) }
            : { kind: 'missing' };
        const fallback = await privateRealm(ref, locale);
        return fallback.kind === 'realm' ? { kind: 'missing' } : fallback;
      }
      const zone = idOf(resolved.data.capabilities?.zone ?? '');
      if (!zone) {
        const fallback = await privateRealm(ref, locale, resolved.data);
        return fallback.kind === 'realm' ? { kind: 'missing' } : fallback;
      }
      const publication = await readPublication(zone);
      if (!publication.ok) return publication.failure === 'missing' ? { kind: 'missing' }
        : { kind: 'unavailable', failure: publication.failure, ...(publication.reference ? { reference: publication.reference } : {}) };
      return { kind: 'site', address: resolved.data, zone,
        realm: idOf(publication.data.realm ?? '') };
    },
  };
}

export const readRealmHeader = cache(
  async (realm: string, _locale: UiLocale): Promise<RealmFrameRead<RealmHeader>> =>
    realmFrameReads({ keepProblem: false, main: main() }).readRealmHeader(realm),
);

const readPrivateRealm = cache(async (ref: string, locale: UiLocale, address?: ResolvedAddress) => {
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const token = jar.get(ACCESS_COOKIE)?.value;
  const session = token ? await sessionAgentState() : null;
  return readSpacePage(
    ref,
    displayLanguages({ pageUrl: incoming.get('x-rezics-page-url'), uiLocale: locale }).join(','),
    {
      address,
      token,
      actingSubject: session?.sessionAgent.eligible
        ? (session.sessionAgent.actingSubject ?? undefined)
        : undefined,
    },
  );
});

const frameReader = cache(async () => {
  const { main: personal, actingSubject } = await readerMain();
  return realmFrameReads({ keepProblem: false, main: main(), personal, actingSubject,
    resolution: { resolveAddress, readPrivateRealm, readRealmHeader } });
});

/** Main's shared Space resolver, retaining the proxy's concealed-address shortcut. */
export const resolveRealm = cache(async (ref: string, locale: UiLocale, surface: 'community' | 'site' = 'community'): Promise<RealmResolution> => {
  if ((await headers()).get(SPACE_MISSING_HEADER) === '1') return { kind: 'missing' };
  return realmFrameReads({ keepProblem: false, main: main(), resolution: { resolveAddress, readPrivateRealm, readRealmHeader, readCompletePresentation } }).resolveRealm(ref, locale, surface);
});

export const readRealmZone = cache(async (realm: string): Promise<RealmFrameRead<RealmZoneRead>> =>
  (await frameReader()).readRealmZone(realm),
);

/** Site resolution never guesses a Zone segment or requires a Realm capability. */
export const resolveSite = cache(async (ref: string, locale: UiLocale, fresh = false): Promise<SiteResolution> => {
  if (!fresh && (await headers()).get(SPACE_MISSING_HEADER) === '1') return { kind: 'missing' };
  return realmFrameReads({ keepProblem: false, main: main(), resolution: { resolveAddress, readPrivateRealm, readRealmHeader, readCompletePresentation } }).resolveSite(ref, locale, fresh);
});

export const readPresentation = cache(async (zone: string, after?: string): Promise<RealmFrameRead<ZonePresentationRead>> => {
  try { return await (await frameReader()).readPresentation(zone, after); }
  catch (error) {
    if (recordedReplayGap(error)) throw error;
    return { ok: false, failure: isOfflineError(error) ? 'offline' : 'unavailable' };
  }
});

export const readCompletePresentation = cache(async (zone: string): Promise<RealmFrameRead<ZonePresentationRead>> =>
  realmFrameReads({ keepProblem: false, main: main() }).readCompletePresentation(zone, readPresentation),
);

/** Main conceals private routes from readers without live membership or Zone authority. */
export const readZoneRoute = cache(
  async (zone: string, path: string, cursor?: string): Promise<RealmFrameRead<ZoneRouteRead>> => {
    try { return await (await frameReader()).readZoneRoute(zone, path, cursor); }
    catch (error) {
      if (recordedReplayGap(error)) throw error;
      return { ok: false, failure: isOfflineError(error) ? 'offline' : 'unavailable' };
    }
  },
);

export const readRealmWorks = cache(
  async (realm: string, _locale: UiLocale, cursor?: string): Promise<Loaded<RealmWorksPage>> =>
    settle(async () => {
      const { main, actingSubject } = await readerMain();
      return main.v1.realms({ realm }).works.get({ query: { actingSubject, cursor } });
    }, cursor),
);

export const readRealmDecisions = cache(
  async (realm: string, cursor?: string): Promise<Loaded<RealmDecisionsPage>> =>
    settle(async () => {
      const { main, actingSubject } = await readerMain();
      return main.v1.realms({ realm }).decisions.get({ query: { actingSubject, cursor } });
    }, cursor),
);

export const readRealmDecision = cache(
  async (realm: string, decision: string): Promise<Loaded<RealmDecisionRead>> =>
    settle(async () => {
      const { main, actingSubject } = await readerMain();
      return main.v1.realms({ realm }).decisions({ decision }).get({ query: { actingSubject } });
    }),
);

export const readNewAdoptions = cache(
  async (realm: string, _locale: UiLocale): Promise<Loaded<ZoneWorkPage>> =>
    settle(() => main().v1.realms({ realm }).modules['new-adoptions'].get({ query: {} })),
);

export const readRecentlyCompleted = cache(
  async (realm: string, _locale: UiLocale): Promise<Loaded<ZoneWorkPage>> =>
    settle(() => main().v1.realms({ realm }).modules['recently-completed'].get({ query: {} })),
);

export const readLatestChapters = cache(
  async (realm: string, _locale: UiLocale): Promise<Loaded<ZoneChapterPage>> =>
    settle(() => main().v1.realms({ realm }).modules['latest-chapters'].get({ query: {} })),
);

/** One page of the Realm's chart for an interval: the most-read Works first. */
export const readRankings = cache(
  async (
    realm: string,
    _locale: UiLocale,
    interval: 'day' | 'week' | 'month',
    metric: RankingMetric,
  ): Promise<Loaded<RankingPage>> =>
    settle(() =>
      main()
        .v1.realms({ realm })
        .rankings.get({ query: { metric, interval, limit: 10 } }),
    ),
);

/** Works gaining readers fastest against the previous interval. */
export const readRising = cache(
  async (realm: string, _locale: UiLocale): Promise<Loaded<RankingPage>> =>
    settle(() =>
      main()
        .v1.realms({ realm })
        .modules.rising.get({ query: { interval: 'week', limit: 8 } }),
    ),
);

export const readRecentDecisions = cache(async (realm: string): Promise<Loaded<ZoneDecisionPage>> =>
  settle(() => main().v1.realms({ realm }).modules['recent-decisions'].get({ query: {} })),
);

export const readZoneQuotes = cache(
  async (realm: string, _locale: UiLocale): Promise<Loaded<ZoneReplyPage>> =>
    settle(() => main().v1.realms({ realm }).modules['reader-quotes'].get({ query: {} })),
);

export const readZoneDiscussions = cache(
  async (realm: string, _locale: UiLocale): Promise<Loaded<ZoneReplyPage>> =>
    settle(() => main().v1.realms({ realm }).modules.discussions.get({ query: {} })),
);

export const readZoneEditorLists = cache(
  async (realm: string, _locale: UiLocale): Promise<Loaded<ZoneEditorLists>> =>
    settle(() => main().v1.realms({ realm }).modules['editor-lists'].get({ query: {} })),
);

export const readZoneGenres = cache(
  async (realm: string, context: string, _locale: UiLocale): Promise<Loaded<ZoneGenrePage>> =>
    settle(() => main().v1.realms({ realm }).modules.genres({ context }).get({ query: {} })),
);

const browsePage = cache(
  async (realm: string, _locale: UiLocale, query: string): Promise<Loaded<ZoneBrowsePage>> => {
    const parsed = JSON.parse(query) as ZoneBrowseQuery;
    return readBrowseAnswer(main(), realm, parsed);
  },
);

/** One page of the Zone's browse read for a Query (cached per request by its exact Query). */
export const readZoneBrowse = (realm: string, locale: UiLocale, query: ZoneBrowseQuery) =>
  browsePage(realm, locale, JSON.stringify(query));

/** Main's admitted Facets, for the labels of the Facets a browse page shows. */
export const readFacets = cache(async (): Promise<RealmFrameRead<FacetList>> =>
  realmFrameReads({ keepProblem: false, main: main() }).readFacets(),
);

/** A mod Work's disclosed releases, newest first; `closed` while the platform has not opened the read. */
export const readModReleases = cache(async (work: string): Promise<Loaded<ModReleasePage>> => {
  return settle(async () => {
    if (operationOpen('getV1Mod-releasesByWork', await readPlatformAccess())) {
      return main().v1['mod-releases']({ work }).get({ query: { limit: 20 } });
    }
    return { data: null, error: { status: 403, value: { code: 'platform_closed' } } };
  });
});

/** A few active public Realms, for "Other communities". */
export const readRealmDirectory = cache(
  async (_locale: UiLocale): Promise<Loaded<RealmDirectoryPage>> =>
    settle(() => main().v1.realms.get({ query: { limit: 6, sort: 'activity' } })),
);

/** The members who chose to be listed (G-314's public roster), featured first by the moderators' choice. */
export const readRoster = cache(
  async (realm: string, cursor?: string): Promise<Loaded<RealmRoster>> =>
    settle(
      () =>
        main()
          .v1.realms({ realm })
          .roster.get({ query: { limit: 24, after: cursor } }),
      cursor,
    ),
);

/** An Agent's public profile, for a moderator's name and profile link. */
export const readAgent = cache(async (agent: string): Promise<Loaded<AgentRead>> =>
  settle(() => main().v1.agents({ id: agent }).get({ query: {} })),
);
