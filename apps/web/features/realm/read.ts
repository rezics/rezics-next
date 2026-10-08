import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { mainApiWithToken, readPlatformAccess } from '../api/main.ts';
import { operationOpen } from '../api/platform-access.ts';
import { idOf } from './route.ts';
import { SPACE_MISSING_HEADER } from './missing.ts';
import { resolveAddress } from '../address/server.ts';
import { addressKey } from '../address/path.ts';
import type { ResolvedAddress } from '../address/client.ts';
import { cookies, headers } from 'next/headers';
import { ACCESS_COOKIE } from '../auth/cookies.ts';
import { sessionAgentState } from '../auth/session.ts';
import { displayLanguages } from '../../i18n/display-languages.ts';
import { readSpacePage } from '../address/space-read.ts';
import type { JoinPage } from '../manage/settings-api.ts';
import { failedRead, isOfflineError } from '../feed/types.ts';
import {
  type AgentRead,
  failureOf,
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

// Public headers and module reads are anonymous and cached per request.
// A denied header can use Main’s authenticated admission or its limited join
// page; that exception never substitutes private module data for a public read.

const main = () => mainApiWithToken(undefined);

type Answer<T> = {
  data: T | null;
  error: { status: number; value?: unknown } | null;
  headers?: unknown;
  response?: { headers?: unknown };
};

/**
 * One Main read as a `Loaded` result. Main answers 409 when the graph moved
 * during a first-page read; that read simply starts again, once. A moved
 * cursor is the reader's to restart.
 */
async function settle<T>(call: () => Promise<Answer<T>>, cursor?: string): Promise<Loaded<T>> {
  try {
    let answer = await call();
    if (answer.error?.status === 409 && !cursor) answer = await call();
    const { data, error } = answer;
    if (error) return failedRead(failureOf(error.status, error.value), error.value,
      answer.headers ?? answer.response?.headers);
    return data === null ? { ok: false, failure: 'unavailable' } : { ok: true, data };
  } catch (error) {
    return { ok: false, failure: isOfflineError(error) ? 'offline' : 'unavailable' };
  }
}

export type RealmResolution =
  | {
      kind: 'realm';
      ref: string;
      realm: string;
      header: RealmHeader;
      zone: { id: string; segment: string | null } | null;
    }
  | { kind: 'missing' }
  | { kind: 'join'; page: JoinPage }
  | { kind: 'unavailable'; failure?: ReadFailure; reference?: string };

export const readRealmHeader = cache(
  async (realm: string, _locale: UiLocale): Promise<Loaded<RealmHeader>> =>
    settle(() => main().v1.realms({ realm }).get({ query: {} })),
);

/**
 * Main's shared resolver maps the Space address (including legacy capability
 * links) to its Realm. Shared by every community tab and its metadata.
 */
export const resolveRealm = cache(
  async (ref: string, locale: UiLocale): Promise<RealmResolution> => {
    // The edge already found nothing this reader may see; no second read can say more.
    if ((await headers()).get(SPACE_MISSING_HEADER) === '1') return { kind: 'missing' };
    const resolved = await resolveAddress('space', ref, locale);
    if (resolved.kind !== 'resolved') {
      if (resolved.kind !== 'missing')
        return resolved.kind === 'unavailable'
          ? { kind: 'unavailable', ...(resolved.failure ? { failure: resolved.failure } : {}) }
          : { kind: 'missing' };
      const fallback = await readPrivateRealm(ref, locale);
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
    const realm = idOf(resolved.data.capabilities?.realm ?? '');
    if (!realm) return { kind: 'missing' };
    const header = await readRealmHeader(realm, locale);
    const page = header.ok
      ? { kind: 'realm' as const, header: header.data }
      : header.failure === 'missing'
        ? await readPrivateRealm(ref, locale, resolved.data)
        : { kind: 'unavailable' as const, failure: header.failure, ...(header.reference ? { reference: header.reference } : {}) };
    if (page.kind !== 'realm') return page;
    const zoneId = idOf(resolved.data.capabilities?.zone ?? '');
    return {
      kind: 'realm',
      ref: addressKey(resolved.data.canonical),
      realm,
      header: page.header,
      zone: zoneId ? { id: zoneId, segment: null } : null,
    };
  },
);

export type SiteResolution =
  | { kind: 'site'; address: ResolvedAddress; zone: string; realm: string | null }
  | { kind: 'join'; page: JoinPage }
  | { kind: 'missing' }
  | { kind: 'unavailable'; failure?: ReadFailure; reference?: string };

/** Site resolution never guesses a Zone segment or requires a Realm capability. */
export const resolveSite = cache(async (ref: string, locale: UiLocale): Promise<SiteResolution> => {
  if ((await headers()).get(SPACE_MISSING_HEADER) === '1') return { kind: 'missing' };
  const resolved = await resolveAddress('space', ref, locale);
  if (resolved.kind !== 'resolved') {
    if (resolved.kind !== 'missing')
      return resolved.kind === 'unavailable'
        ? { kind: 'unavailable', ...(resolved.failure ? { failure: resolved.failure } : {}) }
        : { kind: 'missing' };
    const fallback = await readPrivateRealm(ref, locale);
    return fallback.kind === 'realm' ? { kind: 'missing' } : fallback;
  }
  const zone = idOf(resolved.data.capabilities?.zone ?? '');
  if (!zone) {
    const fallback = await readPrivateRealm(ref, locale, resolved.data);
    return fallback.kind === 'realm' ? { kind: 'missing' } : fallback;
  }
  return { kind: 'site', address: resolved.data, zone,
    realm: idOf(resolved.data.capabilities?.realm ?? '') };
});

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

export const readPresentation = cache(async (zone: string): Promise<Loaded<ZonePresentationRead>> =>
  settle(() => main().v1.zones({ id: zone }).presentation.get({ query: {} })),
);

/**
 * The page Main resolves for a path under a Zone. Like every Realm read it is public and answers the same for
 * everyone; a non-member, private and unknown path share one `missing`.
 */
export const readZoneRoute = cache(
  async (zone: string, path: string, cursor?: string): Promise<Loaded<ZoneRouteRead>> =>
    settle(() => main().v1.zones({ id: zone }).routes.get({ query: { path, cursor } }), cursor),
);

export const readRealmWorks = cache(
  async (realm: string, _locale: UiLocale, cursor?: string): Promise<Loaded<RealmWorksPage>> =>
    settle(() => main().v1.realms({ realm }).works.get({ query: { cursor } }), cursor),
);

export const readRealmDecisions = cache(
  async (realm: string, cursor?: string): Promise<Loaded<RealmDecisionsPage>> =>
    settle(() => main().v1.realms({ realm }).decisions.get({ query: { cursor } }), cursor),
);

export const readRealmDecision = cache(
  async (realm: string, decision: string): Promise<Loaded<RealmDecisionRead>> =>
    settle(() => main().v1.realms({ realm }).decisions({ decision }).get({ query: {} })),
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
    return settle(
      () => main().v1.realms({ realm }).modules.browse.get({ query: parsed }),
      parsed.cursor,
    );
  },
);

/** One page of the Zone's browse read for a Query (cached per request by its exact Query). */
export const readZoneBrowse = (realm: string, locale: UiLocale, query: ZoneBrowseQuery) =>
  browsePage(realm, locale, JSON.stringify(query));

/** Main's admitted Facets, for the labels of the Facets a browse page shows. */
export const readFacets = cache(async (): Promise<Loaded<FacetList>> =>
  settle(() => main().v1.facets.get()),
);

/** A mod Work's disclosed releases, newest first; `closed` while the platform has not opened the read. */
export const readModReleases = cache(async (work: string): Promise<Loaded<ModReleasePage>> => {
  if (!operationOpen('getV1Mod-releasesByWork', await readPlatformAccess())) return { ok: false, failure: 'closed' };
  return settle(() =>
    main()
      .v1['mod-releases']({ work })
      .get({ query: { limit: 20 } }),
  );
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
