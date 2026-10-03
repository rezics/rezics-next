import { t } from 'elysia';
import type { Static } from 'typebox';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { readAvatar, readId, readName, readPosition } from '../work/read-contract.ts';
import { readRankings } from '../rankings/read.ts';
import { RankingProjectionUnavailable, type ReadRankingProjection } from '../rankings/projection.ts';
import { readRealmBasis } from '../realm-reads/read-realm.ts';
import { readZonePublication } from '../zone/publication.ts';
import { ZoneUnavailable } from '../zone/configuration.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { publicWork, WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadSession,
  WorkReadUnavailable } from '../work/read-session.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { digest } from '../recommendation/derived-generation.ts';
import type { HomeExclusion } from './personal.ts';
import { contentLanguageVisible } from './read.ts';
import { readZoneVisibility } from '../zone/route-visibility.ts';
import { realmHistoryOriginFilter } from '../realm-admin/history.ts';

export const trendingQuery = t.Object({ scope: t.Optional(t.String({ maxLength: 100 })),
  kind: t.Optional(t.Union([t.Literal('work'), t.Literal('contribution'), t.Literal('adoption')])),
  window: t.Optional(t.Union([t.Literal('day'), t.Literal('week')])),
  actingSubject: t.Optional(readId) }, { additionalProperties: false });
export const trendingResult = t.Object({ profile: t.Literal('home-trending-v1'),
  rankingVersion: t.String(), window: t.Union([t.Literal('day'), t.Literal('week')]),
  items: t.Array(t.Object({ work: readId, realm: readId, title: readName,
    cover: readAvatar, types: t.Array(t.String(), { maxItems: 8 }), rank: t.Integer({ minimum: 1 }),
    reason: t.Literal('growth-in-realm') }),
  { maxItems: 5 }), sourcePosition: readPosition });
export type TrendingQuery = Static<typeof trendingQuery>;
export type TrendingResult = Static<typeof trendingResult>;
export interface HomeTrendingReader {
  read(session: WorkReadSession, input: { query: TrendingQuery; principal: VerifiedPrincipal | null;
    agent: string | null }): Promise<TrendingResult>;
}
export const TRENDING_COST = { items: 5, realmCap: 2, candidatePool: 20, realmRelations: 100,
  responseBytes: 64 * 1024 } as const;

interface Placement { work: string; realm: string; actor: string; language: string | null; zone: string | null }
const reduced = (id: string, rule: HomeExclusion) =>
  Number.parseInt(digest([id, rule.kind, rule.target]).slice(0, 2), 16) % 4 !== 0;
const excludes = (work: string, placement: Placement, rules: readonly HomeExclusion[]) => rules.some(rule => {
  const match = rule.kind === 'work' && rule.target === work
    || rule.kind === 'realm' && rule.target === placement.realm
    || rule.kind === 'person' && rule.target === placement.actor
    || rule.kind === 'kind' && rule.target === 'work';
  return match && (rule.strength !== 'fewer' || reduced(work, rule));
});

/** The ranking owner scores Works. Realm placements provide the public home
 * context; a Zone scope uses its published default Realm. The fixed candidate
 * and relation caps keep the adapter bounded when a Work has many placements. */
export class RankingHomeTrendingReader implements HomeTrendingReader {
  constructor(private readonly projection: ReadRankingProjection) {}

  async read(session: WorkReadSession, input: { query: TrendingQuery;
    principal: VerifiedPrincipal | null; agent: string | null }): Promise<TrendingResult> {
    const { query, principal, agent } = input;
    if (query.kind && query.kind !== 'work') throw new WorkReadInvalid('Rankings currently score Works only');
    const scope = query.scope ?? (principal ? 'followed' : 'global');
    if (scope === 'followed' && (!principal || !agent)) throw new WorkReadInvalid('Following requires authentication');
    let realm: string | null = scope.startsWith('realm:') ? scope.slice(6) : null;
    if (scope.startsWith('zone:')) {
      try {
        const zone = await readZonePublication(session.deps.environment, scope.slice(5));
        await readZoneVisibility(session, zone.zone);
        if (!zone.realm) throw new WorkReadMissing('Zone is unavailable');
        realm = zone.realm;
      } catch (error) {
        if (error instanceof ZoneUnavailable) throw new WorkReadMissing('Zone is unavailable');
        throw error;
      }
    }
    if (realm) await readRealmBasis(session, realm);
    const personal = principal && agent && session.deps.homePersonal
      ? await session.deps.homePersonal.read(principal, agent) : null;
    if (principal && !personal) throw new WorkReadUnavailable('Home preferences are unavailable');
    if (personal) session.readingLanguages = personal.preferences.contentLanguages;
    const follows = principal && agent && session.deps.follows
      ? await session.deps.follows.matches(principal, agent, []) : null;
    if (scope === 'followed' && !follows) throw new WorkReadUnavailable('Follows are unavailable');
    let checkpoint: Awaited<ReturnType<ReadRankingProjection['current']>>;
    try { checkpoint = await this.projection.current(); }
    catch (error) {
      if (error instanceof RankingProjectionUnavailable) throw new WorkReadUnavailable(error.message);
      throw error;
    }
    const window = query.window ?? 'week';
    const items: TrendingResult['items'] = [];
    if (personal?.preferences.recommendations !== false) {
      const publicSession = new WorkReadSession(session.deps, session.request,
        { limit: TRENDING_COST.candidatePool, languages: session.displayLanguages.join(','),
          actingSubject: session.options.actingSubject }, session.position);
      publicSession.principal = session.principal;
      let ranked: Awaited<ReturnType<typeof readRankings>>;
      try { ranked = await readRankings(publicSession, this.projection, {
        realm, metric: 'reads', interval: window, order: 'growth' }); }
      catch (error) {
        if (error instanceof RankingProjectionUnavailable) throw new WorkReadUnavailable(error.message);
        throw error;
      }
      const ids = ranked.items.map(item => item.id);
      const history = realm ? await realmHistoryOriginFilter(session, realm, 'selection', '?work') : '';
      const rows = ids.length ? await session.query(`SELECT DISTINCT ?work ?realm ?actor ?language ?zone WHERE {
        VALUES ?work { ${ids.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} {
          ?slot a rv:RealmPublicationSlot ; rv:work ?work ; rv:realm ?realm ;
            rv:mainVersion ?main ; rv:selectionHead ?selection .
          ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
          ?space a rv:Space ; rv:realmCapability ?realm .
          ${realm ? '' : '?space rv:disclosure rv:Public .'}
          ?contribution rv:publicationHead ?decision ; rv:author ?actor .
          ${realm ? '' : 'FILTER NOT EXISTS { ?space rv:disclosure rv:Private }'}
          ${realm ? '' : 'FILTER NOT EXISTS { ?space rv:listing ?listing FILTER(?listing != "listed") }'}
          FILTER NOT EXISTS { ?realm rv:protectionHead ?protection }
          OPTIONAL { ?zone a rv:Zone ; rv:zoneState rv:Active ; rv:disclosure rv:Public ;
              rv:defaultRealm ?realm ; rv:space ?space .
            FILTER NOT EXISTS { ?zone rv:protectionHead ?zoneProtection }
            FILTER NOT EXISTS { ?zone rv:disclosure rv:Private } }
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ?selection a rv:PublicationSelection ; rv:component ?slot ;
            rv:context ?realm ; rv:work ?work ; rv:mainVersion ?main ;
            rv:contribution ?contribution ; rv:publicationDecision ?decision ;
            rv:selectedDraft ?draft .
          OPTIONAL { ?selection rv:language ?language }
          ?decision rv:disclosure rv:Public .
          FILTER NOT EXISTS { ?draft a rv:ErasedRevision }
        }
        ${publicWork('?work', '?main')}
        ${history}
        ${realm ? `FILTER(?realm = ${iri(realm)})` : ''}
      } ORDER BY STR(?work) STR(?realm) STR(?zone) LIMIT ${TRENDING_COST.realmRelations + 1}`,
      TRENDING_COST.realmRelations + 1) : [];
      if (rows.some(row => !row.work || !row.realm || !row.actor
        || !ids.includes(row.work.value))) throw new WorkReadUnavailable('Trending placement is incomplete');
      const placements = rows.map(row => ({ work: row.work!.value, realm: row.realm!.value,
        actor: row.actor!.value, language: row.language?.value ?? null, zone: row.zone?.value ?? null }));
      const followed = new Set<number>();
      if (scope === 'followed') {
        for (let offset = 0; offset < placements.length; offset += 20) {
          const match = await session.deps.follows!.matches(principal!, agent!, placements.slice(offset, offset + 20)
            .map(row => [row.work, row.realm, ...(row.zone ? [row.zone] : [])]));
          if (match.revision !== follows!.revision) throw new WorkReadMoved('Follows changed');
          match.matches.forEach((yes, index) => { if (yes) followed.add(offset + index); });
        }
      }
      const rules = personal?.exclusions ?? [];
      const tagRules = rules.filter(rule => rule.kind === 'tag');
      const realmCounts = new Map<string, number>();
      for (const work of ranked.items) {
        for (const [index, placement] of placements.entries()) {
          if (placement.work !== work.id || scope === 'followed' && !followed.has(index)
            || excludes(work.id, placement, rules)
            || !contentLanguageVisible(placement.language, [undefined, personal?.preferences.contentLanguages])
            || (realmCounts.get(placement.realm) ?? 0) >= TRENDING_COST.realmCap) continue;
          if (tagRules.length) {
            const tagSession = new WorkReadSession(session.deps, session.request,
              { scope: 'realm', realm: placement.realm, languages: session.displayLanguages.join(','),
                limit: 3 }, session.position);
            const tags = await readWorkClassifications(tagSession, work.id, tagRules.map(rule => rule.target));
            if (tagRules.some(rule => tags.items.some(tag => tag.sense === rule.target)
              && (rule.strength !== 'fewer' || reduced(work.id, rule)))) continue;
          }
          items.push({ work: work.id, realm: placement.realm, title: work.title,
            cover: work.cover, types: work.types, rank: items.length + 1, reason: 'growth-in-realm' });
          realmCounts.set(placement.realm, (realmCounts.get(placement.realm) ?? 0) + 1);
          break;
        }
        if (items.length === TRENDING_COST.items) break;
      }
    }
    if (realm) await readRealmBasis(session, realm);
    if (scope.startsWith('zone:')) await readZoneVisibility(session, scope.slice(5));
    const end = await this.projection.current();
    if (end.generation !== checkpoint.generation || end.contentSequence !== checkpoint.contentSequence
      || principal && agent && personal && (await session.deps.homePersonal!.fence(principal, agent)).revision !== personal.revision
      || follows && (await session.deps.follows!.matches(principal!, agent!, [])).revision !== follows.revision) {
      throw new WorkReadMoved('Trending changed');
    }
    return { profile: 'home-trending-v1', rankingVersion: checkpoint.generation,
      window, items, sourcePosition: session.position };
  }
}
