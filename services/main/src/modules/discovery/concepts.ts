import { t } from 'elysia';
import { listRequestFields, listResponse, listResult, type ListRequest } from '../../api-list.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readId, readName, readPosition, WORK_READ_COST } from '../work/read-contract.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  publicWork,
  WorkReadInvalid,
  WorkReadMoved,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import { indexedLabels, type LabelAfter } from '../search/labels.ts';
import { discoveryReader, fenceDiscoveryReader } from './reader.ts';
import { acceptedClassification, countDisclosure } from '../query/classification.ts';
import type { ClassificationAudience } from './audience.ts';

export const conceptSearchQuery = t.Object(
  {
    ...listRequestFields,
    scope: t.Optional(t.Union([t.Literal('global'), t.Literal('realm')])),
    realm: t.Optional(readId),
    actingSubject: t.Optional(readId),
    personalization: t.Optional(t.Boolean()),
  },
  { additionalProperties: false },
);
export const conceptSearchItem = t.Object({
  id: readId,
  name: readName,
  broader: t.Array(t.Object({ id: readId, name: readName }), { maxItems: 16 }),
  usageCount: t.Integer({ minimum: 0 }),
  followed: t.Boolean(),
});
export const conceptSearchPage = t.Object({
  ...listResponse(conceptSearchItem).properties,
  profile: t.Literal('concept-search-v1'),
  sourcePosition: readPosition,
});
export interface ConceptSearchQuery extends ListRequest {
  scope?: 'global' | 'realm';
  realm?: string;
  actingSubject?: string;
  personalization?: boolean;
}
/** Text pages collect 64 indexed label documents at most. Empty search uses
 * following, then current accepted public Work usage, then identity. Usage
 * aggregation is performed in the graph under the enclosing read deadline;
 * there is no 256-Concept/2,048-label inventory cap. */
export const CONCEPT_SEARCH_COST = {
  candidates: 65,
  indexDocuments: 64,
  broaderPerConcept: 16,
  graphCalls: WORK_READ_COST.graphCalls,
  deadlineMs: WORK_READ_COST.deadlineMs,
  graphBytes: WORK_READ_COST.graphBytes,
} as const;

export function visibleConcept(concept: string, realm?: string) {
  return `GRAPH ${iri(GRAPHS.current)} { ${concept} a skos:Concept ; rv:conceptState rv:Active .
    ${
      realm
        ? `FILTER NOT EXISTS { ${concept} rv:conceptRealm ?owner . FILTER(?owner != ${iri(realm)}) }`
        : `FILTER NOT EXISTS { ${concept} rv:conceptRealm ?owner }`
    }
    FILTER NOT EXISTS { ${concept} rv:protectionHead ?protected }
    FILTER NOT EXISTS { ${concept} rv:conceptState rv:Retired }
    FILTER NOT EXISTS { ${concept} skos:inScheme ?scheme . ?scheme rv:schemeState rv:Retired } }`;
}
function usage(concept: string, audience: ClassificationAudience, realm?: string) {
  return `${publicWork('?work', '?main')}
    ${acceptedClassification('?main', concept, audience, realm)}
    ${countDisclosure('?work', audience)}
    ${
      realm
        ? `GRAPH ${iri(GRAPHS.current)} { ?adoption a rv:RealmPublicationSlot ;
      rv:realm ${iri(realm)} ; rv:work ?work ; rv:mainVersion ?main ; rv:selectionHead ?adoptionHead }`
        : ''
    }`;
}

export async function readConceptSearch(
  session: WorkReadSession,
  input: ConceptSearchQuery,
  request = session.request,
) {
  const q = input.q?.trim() ?? '',
    limit = input.limit ?? 20;
  if ((input.scope === 'realm') !== !!input.realm)
    throw new WorkReadInvalid('Realm is required only for Realm scope');
  if (input.realm && (await session.realm(input.realm)).visibility !== 'public')
    throw new WorkReadInvalid('Scope is not public');
  const reader = await discoveryReader(
    session,
    input.actingSubject,
    input.personalization !== false,
    request,
  );
  if (!session.deps.discoveryAudience)
    throw new WorkReadUnavailable('Concept count audience is unavailable');
  const audience = await session.deps.discoveryAudience.classificationAudience(
    session.viewer,
    input.realm,
  );
  // Existing follows remain navigation when recommendations are switched off.
  const topics = reader?.signals.topics ?? [];
  const binding = [
    'concept-search-v1',
    q,
    input.realm ?? null,
    limit,
    audience,
    reader?.signals ?? null,
    session.displayLanguages,
    session.viewer,
  ];
  const cursor = decodeReadCursor(input.cursor, binding, session.position);
  let prior: { after?: LabelAfter; count: number; followed?: number; usage?: string } = {
    count: 0,
  };
  if (cursor) {
    try {
      prior = JSON.parse(cursor.order);
    } catch {
      throw new WorkReadInvalid('Concept cursor is invalid');
    }
    if (!Number.isSafeInteger(prior.count) || prior.count < 0)
      throw new WorkReadInvalid('Concept cursor is invalid');
  }
  let ids: string[], more: boolean, after: string, order: typeof prior;
  const aggregate = (ids?: string[]) => `SELECT ?concept (COUNT(DISTINCT ?work) AS ?usage) WHERE {
    ${ids ? `VALUES ?concept { ${ids.map(iri).join(' ')} }` : ''}
    ${visibleConcept('?concept', input.realm)} OPTIONAL { ${usage('?concept', audience, input.realm)} }
    } GROUP BY ?concept`;
  let counts = new Map<string, number>();
  if (q) {
    const page = await indexedLabels(session, q, limit, prior.after);
    const rows = page.ids.length
      ? await session.query(`${aggregate(page.ids)} LIMIT ${limit + 1}`, limit)
      : [];
    const available = new Map(rows.map((row) => [row.concept!.value, Number(row.usage!.value)]));
    ids = page.ids.filter((id) => available.has(id));
    counts = available;
    more = page.more;
    after = page.after?.id ?? '';
    order = { count: prior.count, after: page.after };
  } else {
    const rows = await session.query(
      `SELECT ?concept ?usage ?followed WHERE {
      { ${aggregate()} }
      BIND(${topics.length ? `IF(?concept IN (${topics.map(iri).join(',')}),1,0)` : '0'} AS ?followed)
      ${
        cursor
          ? `FILTER(?followed < ${prior.followed ?? 0} || (?followed = ${prior.followed ?? 0}
        && (?usage < ${lit(prior.usage ?? '0')}^^<http://www.w3.org/2001/XMLSchema#integer>
          || (?usage = ${lit(prior.usage ?? '0')}^^<http://www.w3.org/2001/XMLSchema#integer>
            && STR(?concept) > ${lit(cursor.after)}))))`
          : ''
      }
      } ORDER BY DESC(?followed) DESC(?usage) STR(?concept) LIMIT ${limit + 1}`,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    ids = page.map((row) => row.concept!.value);
    counts = new Map(page.map((row) => [row.concept!.value, Number(row.usage!.value)]));
    more = rows.length > limit;
    after = ids.at(-1) ?? '';
    order = {
      count: prior.count,
      usage: page.at(-1)?.usage?.value,
      followed: Number(page.at(-1)?.followed?.value ?? 0),
    };
  }
  if ([...counts.values()].some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new WorkReadUnavailable('Concept usage count is invalid');
  }
  const relations = ids.length
    ? await session.query(
        `SELECT DISTINCT ?concept ?broader WHERE {
    VALUES ?concept { ${ids.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { { ?concept skos:broader ?broader } UNION { ?broader skos:narrower ?concept } }
    ${visibleConcept('?broader', input.realm)} } LIMIT ${ids.length * 16 + 1}`,
        ids.length * 16,
      )
    : [];
  const resources = [...new Set([...ids, ...relations.map((row) => row.broader!.value)])];
  const names = new Map<
    string,
    NonNullable<Awaited<ReturnType<WorkReadSession['summaries']>>>[number]
  >();
  for (let offset = 0; offset < resources.length; offset += 64) {
    for (const summary of await session.summaries(resources.slice(offset, offset + 64)))
      names.set(summary.reference, summary);
  }
  const disclosed = await session.disclosure(
    resources.map((resource) => ({
      owner: 'graph' as const,
      resource,
      component: 'name' as const,
    })),
    'typeahead',
  );
  const visible = new Set(resources.filter((_, index) => disclosed[index] === 'visible'));
  const items = ids.flatMap((id) => {
    const summary = names.get(id);
    if (!visible.has(id) || summary?.status !== 'available' || summary.type !== 'concept')
      return [];
    const broader = relations
      .filter((row) => row.concept!.value === id)
      .flatMap((row) => {
        const parent = names.get(row.broader!.value);
        return visible.has(row.broader!.value) &&
          parent?.status === 'available' &&
          parent.type === 'concept'
          ? [{ id: row.broader!.value, name: parent.name }]
          : [];
      });
    if (broader.length > 16)
      throw new WorkReadUnavailable('Concept broader relation exceeds its bound');
    return [
      {
        id,
        name: summary.name,
        usageCount: counts.get(id)!,
        followed: topics.includes(id),
        broader,
      },
    ];
  });
  await fenceDiscoveryReader(session, reader, input.personalization !== false);
  if (
    JSON.stringify(
      await session.deps.discoveryAudience.classificationAudience(session.viewer, input.realm),
    ) !== JSON.stringify(audience)
  ) {
    throw new WorkReadMoved('Concept count audience changed');
  }
  order.count += items.length;
  const next = more
    ? encodeReadCursor(binding, session.position, after, JSON.stringify(order))
    : null;
  return {
    profile: 'concept-search-v1' as const,
    sourcePosition: session.position,
    ...listResult(items, next, prior.count),
  };
}
