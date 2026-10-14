import type { ZoneWork } from '@rezics/zone-sdk';
import { zoneWork } from './adapt.ts';
import { rankingAuthor, rankingPosition, rankingRealm, rankingStateSource } from './ranking-contract-states.ts';
import type { RankingPage } from './types.ts';
import type { PresentationModule } from '../zones/presentation.ts';

export const rankingModule: PresentationModule = { id: 'ranking-garden-chart', type: 'ranking', title: 'Ranking garden',
  source: { kind: 'query-block', block: 'realm-ranking' }, options: { layout: 'rows', metric: 'reads' } };
export const rankingIntervals = ['day', 'week', 'month'] as const;
export type RankingModuleState = 'populated' | 'empty' | 'error' | 'missing' | 'underfilled';

/** Contract states awaiting capture: GET /v1/realms/{realm}/rankings?interval={day|week|month}&metric=reads&limit=10. */
export function rankingModuleContractPage(interval: RankingPage['interval'], state: RankingModuleState): RankingPage {
  const id = 'https://rezics.com/id/00000100-1234-4123-8123-123456789abc';
  const work: RankingPage['items'][number] = { id, revision: id, mainVersion: id,
    title: { value: 'Original ranking garden', language: 'en', direction: 'ltr', basis: 'requested' },
    cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'ranking-garden', resourceType: 'work' },
    types: [], tagline: null, completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null,
    score: 42, growth: 3 };
  return { profile: 'read-rankings-v1', realm: rankingRealm, metric: 'reads', interval, bucket: '2026-10-14',
    contentPosition: rankingPosition, sourcePosition: rankingPosition,
    items: state === 'empty' ? [] : [work], nextCursor: state === 'underfilled' ? 'contract:chart:next' : null,
    count: { value: state === 'empty' ? 0 : 1, kind: 'exact-page', total: null } };
}

/** The module's normal card enrichment keeps the independent original's author credit. */
export function rankingModuleContractCards(): Map<string, ZoneWork> {
  const work = rankingModuleContractPage('week', 'populated').items[0]!;
  const context = { realm: rankingRealm, ref: 'ranking-garden', locale: 'en' as const };
  return new Map([[work.id, zoneWork({ ...work, inZone: false, primaryCredits: [{ agent: rankingAuthor,
    handle: null, displayName: 'Ranking garden author', provider: null, key: null }] }, context, null)]]);
}

export function rankingModuleContractFetch(state: RankingModuleState): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    const interval = rankingIntervals.find(value => value === url.searchParams.get('interval'));
    if (request.method !== 'GET' || url.pathname !== `/api/main/v1/realms/${rankingRealm.slice(-36)}/rankings` ||
      !interval || url.searchParams.get('metric') !== 'reads' || url.searchParams.get('limit') !== '10' ||
      [...url.searchParams].length !== 3) throw new Error(`Unexpected ranking module request (${rankingStateSource})`);
    if (state === 'missing' || state === 'error') {
      const status = state === 'missing' ? 404 : 503, code = state === 'missing' ? 'work_unavailable' : 'rankings_unavailable';
      return Response.json({ type: `https://rezics.com/problems/${code}`, status, code,
        title: state === 'missing' ? 'Resource is unavailable' : 'Rankings are unavailable' }, { status });
    }
    return Response.json(rankingModuleContractPage(interval, state));
  }) as typeof fetch;
}
