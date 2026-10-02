import { t } from 'elysia';
import { listRequestFields, listResponse, listResult, type ListRequest } from '../../api-list.ts';
import { readId, readPosition, WORK_READ_COST } from '../work/read-contract.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  WorkReadInvalid,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import { RV, GRAPHS, iri, lit } from '../work/activate.ts';
import { resourceCard } from '../query/resource-contract.ts';
import {
  readResourceList,
  resourceCards,
  publicResources,
  conceptResourceMatches,
} from '../query/resources.ts';
import { discoveryReader, fenceDiscoveryReader } from './reader.ts';
import { visibleConcept } from './concepts.ts';
import { RANKING_PROFILE } from '../recommendation/ranking.ts';
import { indexedNameMatch, labelIndexReady, fenceLabelIndex } from '../search/labels.ts';

const sectionId = t.Union([t.Literal('popular'), t.Literal('communities'), t.Literal('sites')]);
export const discoverySectionsQuery = t.Object(
  {
    ...listRequestFields,
    section: t.Optional(sectionId),
    actingSubject: t.Optional(readId),
    personalization: t.Optional(t.Boolean()),
  },
  { additionalProperties: false },
);
export const discoverySection = t.Object({
  id: sectionId,
  reason: t.Object({
    kind: t.Union([
      t.Literal('popular-in-followed-topics'),
      t.Literal('popular'),
      t.Literal('communities-in-reader-languages'),
      t.Literal('communities'),
      t.Literal('new-sites'),
    ]),
  }),
  page: listResponse(resourceCard),
});
export const discoverySectionsPage = t.Object({
  ...listResponse(discoverySection).properties,
  profile: t.Literal('discovery-sections-v1'),
  personalized: t.Boolean(),
  sourcePosition: readPosition,
});
export interface DiscoverySectionsQuery extends ListRequest {
  section?: 'popular' | 'communities' | 'sites';
  actingSubject?: string;
  personalization?: boolean;
}
/** Three ordered, inherently bounded sections; each nested page is traversable
 * with the same read and `section` selector. 512 candidates per selected section,
 * explicit topic inventory <=1,000, and the existing Work read envelope.
 * Ranking retains its own generation cursor. */
export const DISCOVERY_SECTIONS_COST = {
  sections: 3,
  candidatesPerSection: 512,
  rankingReads: 32,
  topics: 1000,
  graphCalls: WORK_READ_COST.graphCalls,
  deadlineMs: WORK_READ_COST.deadlineMs,
  graphBytes: WORK_READ_COST.graphBytes,
} as const;

export async function readDiscoverySections(
  session: WorkReadSession,
  input: DiscoverySectionsQuery,
  request = session.request,
) {
  if (input.cursor && !input.section)
    throw new WorkReadInvalid('A section is required for continuation');
  const limit = input.limit ?? 6,
    q = input.q?.trim() ?? '';
  const index = q ? await labelIndexReady(session) : null;
  const reader = await discoveryReader(
    session,
    input.actingSubject,
    input.personalization !== false,
    request,
  );
  const personalized = reader?.signals.enabled ?? false;
  const topicIds = personalized ? reader!.signals.topics : [];
  const topicRows = topicIds.length
    ? await session.query(
        `SELECT ?concept WHERE {
    VALUES ?concept { ${topicIds.map(iri).join(' ')} } ${visibleConcept('?concept')}
  } LIMIT ${topicIds.length + 1}`,
        topicIds.length,
      )
    : [];
  const disclosed = await session.disclosure(
    topicRows.map((row) => ({
      owner: 'graph' as const,
      resource: row.concept!.value,
      component: 'name' as const,
    })),
    'search',
  );
  const topics = topicRows
    .filter((_, index) => disclosed[index] === 'visible')
    .map((row) => row.concept!.value);
  const languages = personalized ? reader!.signals.languages : [];
  const sections = input.section ? [input.section] : (['popular', 'communities', 'sites'] as const);
  const binding = [
    'discovery-sections-v1',
    input.section,
    limit,
    q,
    reader?.signals ?? null,
    session.displayLanguages,
    session.viewer,
  ];
  const cursor = decodeReadCursor(input.cursor, binding, session.position);
  let prior: { cursor: string | null; seen: number } = { cursor: null, seen: 0 };
  if (cursor) {
    try {
      prior = JSON.parse(cursor.order);
    } catch {
      throw new WorkReadInvalid('Section cursor is invalid');
    }
    if (typeof prior.cursor !== 'string' || !Number.isSafeInteger(prior.seen) || prior.seen < 0) {
      throw new WorkReadInvalid('Section cursor is invalid');
    }
  }
  const items = [];
  for (const section of sections) {
    let cards,
      next: string | null,
      seen = prior.seen;
    cards = [];
    next = prior.cursor;
    let scanned = 0,
      reads = 0;
    while (
      cards.length <= limit &&
      scanned < DISCOVERY_SECTIONS_COST.candidatesPerSection &&
      reads++ < DISCOVERY_SECTIONS_COST.rankingReads
    ) {
      const ask = Math.min(
        20,
        Math.max(1, limit - cards.length),
        DISCOVERY_SECTIONS_COST.candidatesPerSection - scanned,
      );
      const beforeCursor = next;
      let batch;
      if (section === 'popular') {
        if (!session.deps.recommendations)
          throw new WorkReadUnavailable('Public ranking owner is unavailable');
        const ranked = await session.deps.recommendations.page(
          { public: true, principal: null, actingSubject: null },
          {
            profile: RANKING_PROFILE,
            population: { kind: 'public' },
            candidateGrain: 'work',
            semantic: null,
          },
          ask,
          next ?? undefined,
        );
        const ids = ranked.items.map((item) => item.candidate);
        const rows = ids.length
          ? await session.query(
              `SELECT DISTINCT ?r ?kind ?summary WHERE {
          VALUES ?r { ${ids.map(iri).join(' ')} } ${publicResources()}
          ${q ? indexedNameMatch('?r', q) : ''}
        } LIMIT ${ids.length + 1}`,
              ids.length,
            )
          : [];
        const candidates = ids.flatMap((id) =>
          rows
            .filter((row) => row.r!.value === id)
            .map((row) => ({ id, kind: 'work' as const, summary: row.summary!.value, order: '' })),
        );
        const matched = await conceptResourceMatches(
          session,
          candidates,
          topics.length ? [{ facet: 'concept', operator: 'any', values: topics }] : [],
        );
        batch = await resourceCards(
          session,
          candidates.filter((row) => matched.has(row.id)),
        );
        next = ranked.continuation;
        scanned += Math.max(ask, ids.length);
      } else if (section === 'communities') {
        const directory = session.deps.access.realmDirectory;
        if (!directory) throw new WorkReadUnavailable('Realm directory is unavailable');
        const page = await directory.page(session, {
          sort: 'activity',
          q: '',
          limit: ask,
          cursor: next ?? undefined,
        });
        const ids = page.rows.map((row) => row.realm);
        const languageRows = ids.length
          ? await session.query(
              `SELECT DISTINCT ?r WHERE {
          VALUES ?r { ${ids.map(iri).join(' ')} } ${publicResources()}
          ${
            languages.length
              ? `GRAPH ${iri(GRAPHS.current)} { ?r rv:space ?communitySpace .
            ?communitySpace rdfs:label ?ownName . FILTER(${languages.map((language) => `LANGMATCHES(LANG(?ownName),${lit(language)})`).join(' || ')}) }`
              : ''
          }
          ${q ? indexedNameMatch('?r', q) : ''}
        } LIMIT ${ids.length + 1}`,
              ids.length,
            )
          : [];
        const allowed = new Set(languageRows.map((row) => row.r!.value));
        batch = await resourceCards(
          session,
          ids
            .filter((id) => allowed.has(id))
            .map((id) => ({ id, kind: 'realm' as const, summary: id, order: '' })),
        );
        await directory.fence(page.position);
        next = page.next;
        scanned += Math.max(ask, ids.length);
      } else {
        const page = await readResourceList(session, {
          input: {
            profile: 'resource-list-v1',
            context: 'global',
            scope: { kind: 'all' },
            sort: 'newest',
            limit: ask,
            q,
            cursor: next ?? undefined,
          },
          conditions: [{ facet: 'type', operator: 'any', values: [RV + 'Zone'] }],
        });
        batch = page.items;
        next = page.nextCursor;
        scanned += ask;
      }
      if (reader && batch.length) {
        const flags = await session.deps.discoveryAudience!.flags(
          reader.principal,
          reader.actor,
          batch.map((card) => card.id),
        );
        batch = batch.filter((card) => !flags.get(card.id)?.following);
      }
      if (cards.length === limit && batch.length) {
        next = beforeCursor;
        break;
      }
      cards.push(...batch);
      if (!next) break;
    }
    seen += cards.length;
    const pageBinding = [
      'discovery-sections-v1',
      section,
      limit,
      q,
      reader?.signals ?? null,
      session.displayLanguages,
      session.viewer,
    ];
    const continuation = next
      ? encodeReadCursor(
          pageBinding,
          session.position,
          section,
          JSON.stringify({ cursor: next, seen }),
        )
      : null;
    items.push({
      id: section,
      reason: {
        kind:
          section === 'popular'
            ? topics.length
              ? ('popular-in-followed-topics' as const)
              : ('popular' as const)
            : section === 'communities'
              ? languages.length
                ? ('communities-in-reader-languages' as const)
                : ('communities' as const)
              : ('new-sites' as const),
      },
      page: listResult(cards, continuation, prior.seen),
    });
  }
  await fenceDiscoveryReader(session, reader, input.personalization !== false);
  if (index) await fenceLabelIndex(session, index);
  return {
    profile: 'discovery-sections-v1' as const,
    personalized,
    sourcePosition: session.position,
    ...listResult(items, null),
  };
}
