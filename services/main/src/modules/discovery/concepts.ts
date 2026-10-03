import { t } from 'elysia';
import { listRequestFields, listResponse, listResult, type ListRequest } from '../../api-list.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { readId, readName, readPosition, WORK_READ_COST } from '../work/read-contract.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  WorkReadInvalid,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import {
  indexedLabels,
  publicNamePage,
  type LabelAfter,
  type DirectoryAfter,
} from '../search/labels.ts';
import { discoveryReader, fenceDiscoveryReader } from './reader.ts';
import type { DiscoveryReadGeneration } from './store.ts';
import type { OwnedDiscoveryBasis } from './contract.ts';

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
  stale: t.Boolean(),
});
export interface ConceptSearchQuery extends ListRequest {
  scope?: 'global' | 'realm';
  realm?: string;
  actingSubject?: string;
  personalization?: boolean;
}
/** Text reads fill from Concept-only name documents within the 512-document
 * scan bound. Empty search seeks followed identities, then immutable Discovery
 * term counts, then zero-use public names; no count aggregation runs per page. */
export const CONCEPT_SEARCH_COST = {
  candidates: 512,
  indexDocuments: 512,
  rankReads: 8,
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
/** Projection lag is served explicitly; it is not an expired client read. */
export async function conceptCountBasis(
  session: WorkReadSession,
  realm?: string,
  generation?: string,
) {
  if (!session.deps.discovery) throw new WorkReadUnavailable('Discovery projection is unavailable');
  const basis: OwnedDiscoveryBasis = {
    scope: realm ? 'realm' : 'global',
    realm: realm ?? null,
    context: null,
    owner: null,
  };
  const active = await session.deps.discovery.active(basis, session.position, generation);
  return { basis, active };
}
export async function conceptCounts(
  session: WorkReadSession,
  active: DiscoveryReadGeneration,
  ids: string[],
) {
  const rows = await session.deps.discovery!.conceptCounts(active, ids);
  return new Map(
    ids.map((id) => [id, Number(rows.find((row) => row.concept === id)?.work_count ?? 0)]),
  );
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
  // Existing follows remain navigation when recommendations are switched off.
  const topics = reader?.signals.topics ?? [];
  const binding = [
    'concept-search-v1',
    q,
    input.realm ?? null,
    limit,
    reader?.signals ?? null,
    session.displayLanguages,
    session.viewer,
  ];
  const cursor = decodeReadCursor(input.cursor, binding, session.position);
  let prior: {
    after?: LabelAfter;
    directory?: DirectoryAfter;
    count: number;
    followed?: number;
    usage?: string;
  } = {
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
  const { basis, active } = await conceptCountBasis(session, input.realm);
  let ids: string[] = [],
    more = false,
    after = '',
    order = { ...prior };
  let counts = new Map<string, number>();
  const names = new Map<string, Awaited<ReturnType<WorkReadSession['summaries']>>[number]>();
  // Fill a Concept page from Concept-only units. Other resource names and
  // private labels never participate in the collector or its continuation.
  if (q) {
    let scanned = 0;
    for (let read = 0; read < CONCEPT_SEARCH_COST.rankReads && ids.length < limit; read++) {
      const page = await indexedLabels(
        session,
        q,
        Math.min(64, 512 - scanned),
        order.after,
        'concept',
      );
      const visibleRows = page.ids.length
        ? await session.query(
            `SELECT DISTINCT ?concept WHERE {
        VALUES ?concept { ${page.ids.map(iri).join(' ')} } ${visibleConcept('?concept', input.realm)}
      } LIMIT ${page.ids.length + 1}`,
            page.ids.length,
          )
        : [];
      const refs = visibleRows.map((row) => row.concept!.value);
      for (const summary of await session.summaries(refs.filter((id) => !names.has(id))))
        names.set(summary.reference, summary);
      const summaries = refs.map((id) => names.get(id)!);
      const visible = new Set(
        summaries.flatMap((row) =>
          row.status === 'available' && row.type === 'concept' ? [row.reference] : [],
        ),
      );
      for (const [offset, hit] of page.hits.entries()) {
        const id = 'https://rezics.com/id/' + hit.id.split(':').at(-1);
        if (hit.key && visible.has(id)) {
          if (ids.length === limit) {
            more = true;
            break;
          }
          ids.push(id);
        }
        scanned++;
        order.after = { id: hit.id, score: hit.score, document: hit.document, commit: page.commit };
        more = offset + 1 < page.hits.length || page.more;
      }
      if (!more) break;
    }
    counts = await conceptCounts(session, active, ids);
    after = order.after?.id ?? '';
  } else {
    // Followed identities, then the indexed most-used projection, then zero-use
    // public names. Every seek retains at most 64 candidates, <=512 per read.
    let phase = prior.followed ?? 2;
    let key = cursor?.after ?? '';
    let usage = prior.usage;
    let scanned = 0;
    while (ids.length < limit && scanned < 512) {
      const ask = Math.min(64, 512 - scanned);
      let candidates: string[],
        candidateCounts = new Map<string, number>(),
        tail = false;
      const candidateAfters = new Map<string, DirectoryAfter>();
      let available: Set<string> | undefined;
      if (phase === 2) {
        candidates = topics
          .filter((id) => id > key)
          .sort()
          .slice(0, ask);
        tail = topics.filter((id) => id > key).length > ask;
      } else if (phase === 1) {
        const rows = await session.deps.discovery!.conceptPage(
          active,
          ask,
          key ? { count: usage ?? '0', concept: key } : undefined,
        );
        candidates = rows.slice(0, ask).map((row) => row.concept);
        candidateCounts = new Map(rows.map((row) => [row.concept, Number(row.work_count)]));
        tail = rows.length > ask;
      } else {
        const page = await publicNamePage(session, 'concept', 'identity', ask, order.directory);
        candidates = page.rows.map((row) => row.id);
        tail = page.more;
        for (const row of page.rows) candidateAfters.set(row.id, row.after);
        available = new Set(page.rows.filter((row) => row.available).map((row) => row.id));
      }
      if (!candidates.length) {
        if (phase === 0) {
          more = false;
          break;
        }
        phase--;
        key = '';
        usage = undefined;
        continue;
      }
      const rows = await session.query(
        `SELECT DISTINCT ?concept WHERE {
        VALUES ?concept { ${candidates.map(iri).join(' ')} } ${visibleConcept('?concept', input.realm)}
      } LIMIT ${candidates.length + 1}`,
        candidates.length,
      );
      const visible = new Set(rows.map((row) => row.concept!.value));
      const batchCounts = await conceptCounts(session, active, candidates);
      for (const id of candidates) {
        if (ids.length === limit) break;
        key = id;
        usage = String(candidateCounts.get(id) ?? batchCounts.get(id) ?? 0);
        scanned++;
        if (candidateAfters.has(id)) order.directory = candidateAfters.get(id);
        if (
          !visible.has(id) ||
          (available && !available.has(id)) ||
          (phase < 2 && topics.includes(id)) ||
          (phase === 0 && batchCounts.get(id)! > 0)
        )
          continue;
        ids.push(id);
        counts.set(id, batchCounts.get(id)!);
      }
      more = key !== candidates.at(-1) || tail || phase > 0;
      if (key === candidates.at(-1) && !tail && ids.length < limit) {
        if (phase === 0) {
          more = false;
          break;
        }
        phase--;
        key = '';
        usage = undefined;
      }
    }
    after = key;
    order = { count: prior.count, followed: phase, usage, directory: order.directory };
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
  const unnamed = resources.filter((resource) => !names.has(resource));
  for (let offset = 0; offset < unnamed.length; offset += 64) {
    for (const summary of await session.summaries(unnamed.slice(offset, offset + 64)))
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
  const final = await session.deps.discovery!.active(basis, session.position, active.generation_id);
  const stale = active.stale || final.stale;
  order.count += items.length;
  const next = more
    ? encodeReadCursor(binding, session.position, after, JSON.stringify(order))
    : null;
  return {
    profile: 'concept-search-v1' as const,
    sourcePosition: session.position,
    stale,
    ...listResult(items, next, prior.count),
  };
}
