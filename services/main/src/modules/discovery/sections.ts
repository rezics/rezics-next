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
import { RV, iri } from '../work/activate.ts';
import { resourceCard } from '../query/resource-contract.ts';
import {
  readResourceList,
  resourceCards,
  publicResources,
  resourceConditions,
} from '../query/resources.ts';
import { discoveryReader, fenceDiscoveryReader } from './reader.ts';
import { visibleConcept } from './concepts.ts';
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
 * with the same read and `section` selector. 64 candidates per selected section,
 * explicit topic inventory <=1,000, and the existing Work read envelope.
 * Ranking retains its own generation cursor. */
export const DISCOVERY_SECTIONS_COST = {
  sections: 3,
  candidatesPerSection: 64,
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
  const audience = topics.length
    ? await session.deps.discoveryAudience!.classificationAudience(session.viewer)
    : undefined;
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
  let publicGeneration: string | null = null;
  for (const section of sections) {
    let cards,
      next: string | null,
      seen = prior.seen;
    if (section === 'popular') {
      if (!session.deps.recommendations)
        throw new WorkReadUnavailable('Public ranking owner is unavailable');
      const ranked = await session.deps.recommendations.publicCandidates(
        limit,
        prior.cursor ?? undefined,
      );
      publicGeneration = ranked.generation;
      const ids = ranked.items.map((item) => item.candidate);
      const rows = ids.length
        ? await session.query(
            `SELECT DISTINCT ?r ?kind ?summary WHERE {
        VALUES ?r { ${ids.map(iri).join(' ')} } ${publicResources()}
        ${topics.length ? resourceConditions([{ facet: 'concept', operator: 'any', values: topics }], undefined, audience) : ''}
        ${q ? indexedNameMatch('?nameResource', q) : ''}
      } LIMIT ${limit + 1}`,
            limit,
          )
        : [];
      const candidates = ids.flatMap((id) =>
        rows
          .filter((row) => row.r!.value === id)
          .map((row) => ({
            id,
            kind: 'work' as const,
            summary: row.summary!.value,
            order: '',
          })),
      );
      cards = await resourceCards(session, candidates);
      next = ranked.continuation;
    } else {
      const type = `${RV}${section === 'communities' ? 'Realm' : 'Zone'}`;
      const plan = {
        input: {
          profile: 'resource-list-v1' as const,
          context: 'global' as const,
          scope: { kind: 'all' as const },
          sort: 'newest' as const,
          limit,
          q,
          cursor: prior.cursor ?? undefined,
        },
        conditions: [
          { facet: 'type' as const, operator: 'any' as const, values: [type] },
          ...(section === 'communities' && languages.length
            ? [{ facet: 'language' as const, operator: 'any' as const, values: languages }]
            : []),
        ],
      };
      const page = await readResourceList(session, plan);
      cards = page.items;
      next = page.nextCursor;
    }
    if (reader && cards.length) {
      const flags = await session.deps.discoveryAudience!.flags(
        reader.principal,
        reader.actor,
        cards.map((card) => card.id),
      );
      cards = cards.filter((card) => !flags.get(card.id)?.following);
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
  if (publicGeneration) await session.deps.recommendations!.fencePublicCandidates(publicGeneration);
  if (
    audience &&
    JSON.stringify(await session.deps.discoveryAudience!.classificationAudience(session.viewer)) !==
      JSON.stringify(audience)
  ) {
    throw new WorkReadUnavailable('Classification audience changed');
  }
  if (index) await fenceLabelIndex(session, index);
  return {
    profile: 'discovery-sections-v1' as const,
    personalized,
    sourcePosition: session.position,
    ...listResult(items, null),
  };
}
