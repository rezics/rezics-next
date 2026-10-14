import { cache } from 'react';
import { recordedReplayGap, realmFrameReads, type RealmFrameRead, type RealmResolution, type SiteResolution } from './zone-presentation-read.ts';
export type { RealmFrameRead, RealmResolution, SiteResolution } from './zone-presentation-read.ts';
export { realmFrameReads } from './zone-presentation-read.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken, readPlatformAccess } from '../api/main.ts';
import { operationOpen } from '../api/platform-access.ts';
import { SPACE_MISSING_HEADER } from './missing.ts';
import { resolveAddress } from '../address/server.ts';
import type { ResolvedAddress } from '../address/client.ts';
import type { MainClient } from '../discover/types.ts';
import { isOfflineError } from '../feed/types.ts';
import { cookies, headers } from 'next/headers';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState, sessionReadSubject } from '../auth/session.ts';
import { displayLanguages } from '../../i18n/display-languages.ts';
import { readSpacePage } from '../address/space-read.ts';
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

/** Public header adapter retained for rules readers and their recorded surfaces. */
export function readPublishedRealmHeader(client: MainClient, realm: string, keepProblem = false): Promise<RealmFrameRead<RealmHeader>> {
  return realmFrameReads({ main: client, keepProblem }).readRealmHeader(realm);
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
