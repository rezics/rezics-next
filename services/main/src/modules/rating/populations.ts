import { t } from 'elysia';
import { listRequestFields, listResponse, listResult, type ListRequest } from '../../api-list.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readId, readName, readPosition, WORK_READ_COST } from '../work/read-contract.ts';
import {
  decodeReadCursor,
  encodeReadCursor,
  WorkReadInvalid,
  WorkReadMoved,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import { resolveTargets } from '../target/resolve.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from './global.ts';
import { indexedNameMatch, labelIndexReady, fenceLabelIndex } from '../search/labels.ts';
import { discoveryReader, fenceDiscoveryReader } from '../discovery/reader.ts';
import { verifiedPopulationCounts } from './populations-proof.ts';

export const ratingPopulationsQuery = t.Object(
  { ...listRequestFields, target: readId, actingSubject: t.Optional(readId) },
  { additionalProperties: false },
);
export const ratingPopulation = t.Object({
  id: readId,
  name: readName,
  contexts: t.Array(readId, { minItems: 1, maxItems: 64 }),
  ratingCount: t.Integer({ minimum: 1 }),
  global: t.Boolean(),
  readerCommunity: t.Boolean(),
});
export const ratingPopulationsPage = t.Object({
  ...listResponse(ratingPopulation).properties,
  profile: t.Literal('rating-populations-v1'),
  target: readId,
  sourcePosition: readPosition,
});
export interface RatingPopulationsQuery extends ListRequest {
  target: string;
  actingSubject?: string;
}
/** Target-leading graph joins aggregate only current available, receipt-proven
 * observation heads. Withdrawal and retries cannot add a vote. Rank/count seek
 * returns at most 64+1 populations; hydration and membership flags are batched.
 * Graph aggregation may sort; WorkReadSession bounds time, calls and bytes. */
export const RATING_POPULATIONS_COST = {
  candidates: 65,
  page: 64,
  graphCalls: WORK_READ_COST.graphCalls,
  deadlineMs: WORK_READ_COST.deadlineMs,
  graphBytes: WORK_READ_COST.graphBytes,
} as const;

export async function readRatingPopulations(
  session: WorkReadSession,
  input: RatingPopulationsQuery,
  request = session.request,
) {
  const [resolved] = await resolveTargets(session, [input.target], 'rating');
  const target = resolved!.resource;
  let main: string | null = null;
  if (resolved!.base === 'work') {
    const rows = await session.query(
      `SELECT ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(target)} rv:mainVersion ?main } } LIMIT 2`,
      1,
    );
    if (!rows[0]?.main) throw new WorkReadUnavailable('Rating target is unavailable');
    main = rows[0].main.value;
  }
  const reader = await discoveryReader(session, input.actingSubject, true, request);
  if (main && !session.deps.ratingPopulations)
    throw new WorkReadUnavailable('Rating population owner is unavailable');
  const inherited = main ? await session.deps.ratingPopulations!.inherited(main) : [];
  const q = input.q?.trim() ?? '',
    limit = input.limit ?? 20;
  const index = q ? await labelIndexReady(session) : null;
  const binding = [
    'rating-populations-v1',
    target,
    main,
    inherited,
    q,
    limit,
    reader?.signals ?? null,
    session.displayLanguages,
    session.viewer,
  ];
  const cursor = decodeReadCursor(input.cursor, binding, session.position);
  let prior: { count: string; seen: number } = { count: '0', seen: 0 };
  if (cursor) {
    try {
      prior = JSON.parse(cursor.order);
    } catch {
      throw new WorkReadInvalid('Rating population cursor is invalid');
    }
    if (!/^\d+$/.test(prior.count) || !Number.isSafeInteger(prior.seen) || prior.seen < 0) {
      throw new WorkReadInvalid('Rating population cursor is invalid');
    }
  }
  const rows = await session.query(
    `SELECT ?population ?count ?contexts WHERE {
    { SELECT ?population (COUNT(DISTINCT ?availableSlot) AS ?count)
        (GROUP_CONCAT(DISTINCT STR(?context); SEPARATOR="|") AS ?contexts) WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?observation rv:ratingContext ?context .
        ${
          main
            ? `{ ?observation rv:targetMainVersion ${iri(main)} .
          FILTER NOT EXISTS { ?observation rv:targetRelease ?release } }
          ${
            inherited.length
              ? `UNION { VALUES (?observation ?origin) { ${inherited.map((row) => `(${iri(row.observation)} ${iri(row.origin)})`).join(' ')} }
            ?origin rv:mergedInto+ ${iri(target)} }`
              : ''
          }`
            : `{ ?observation rv:target ${iri(target)} }
          ${resolved!.base === 'release' ? `UNION { ?observation rv:targetRelease ${iri(target)} }` : ''}`
        }
        ?context rv:contextState rv:Active .
        { ?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ?population .
          FILTER(?population = ${iri(GLOBAL_RATING_POPULATION_OWNER)})
          ${q && !'global'.includes(q.toLowerCase()) ? 'FILTER(false)' : ''} }
        UNION { ?context rv:realm ?population . ?population a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
          ?space a rv:Space ; rv:realmCapability ?population ; rv:disclosure rv:Public .
          FILTER NOT EXISTS { ?population rv:visibility ?visibility . FILTER(?visibility != "public") }
          FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
          FILTER NOT EXISTS { ?population rv:protectionHead ?protected } }
      }
      ${
        q
          ? `FILTER(?population = ${iri(GLOBAL_RATING_POPULATION_OWNER)} || EXISTS {
        BIND(?space AS ?nameResource) ${indexedNameMatch('?nameResource', q)} })`
          : ''
      }
      # Keep zero-count candidates until owner verification. A partial or
      # unsealed withdrawal must not masquerade as an empty population.
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
          ?observation rv:observationHead ?head ; rv:ratingSlot ?availableSlot .
          ?context rv:head ?contextHead }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ; rv:component ?observation ;
          rv:ratingAvailability rv:Available ; rv:ratingValue ?value .
          FILTER NOT EXISTS { ?head a rv:ErasedRevision }
          ?contextHead a rv:RevisionAnchor ; rv:component ?context .
          FILTER NOT EXISTS { ?contextHead a rv:ErasedRevision } }
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:observationRevision ?head ; rv:outcome rv:Succeeded .
          ?contextReceipt a rv:OperationReceipt ; rv:ratingContextRevision ?contextHead ; rv:outcome rv:Succeeded } }
      } GROUP BY ?population }
      ${
        cursor
          ? `FILTER(?count < ${lit(prior.count)}^^<http://www.w3.org/2001/XMLSchema#integer>
        || (?count = ${lit(prior.count)}^^<http://www.w3.org/2001/XMLSchema#integer>
          && STR(?population) > ${lit(cursor.after)}))`
          : ''
      }
    } ORDER BY DESC(?count) STR(?population) LIMIT ${limit + 1}`,
    limit + 1,
  );
  const page = rows.slice(0, limit),
    ids = page.map((row) => row.population!.value);
  const realms = ids.filter((id) => id !== GLOBAL_RATING_POPULATION_OWNER);
  const flags = reader
    ? await session.deps.discoveryAudience!.flags(reader.principal, reader.actor, realms)
    : new Map();
  const summaries = new Map(
    (await session.summaries(realms)).map((summary) => [summary.reference, summary]),
  );
  const decisions = await session.disclosure(
    realms.map((resource) => ({ owner: 'graph' as const, resource, component: 'name' as const })),
    'search',
  );
  const visible = new Set(realms.filter((_, index) => decisions[index] === 'visible'));
  const contexts = page
    .filter(
      (row) =>
        row.population!.value === GLOBAL_RATING_POPULATION_OWNER ||
        visible.has(row.population!.value),
    )
    .flatMap((row) => row.contexts!.value.split('|'));
  const verified = await verifiedPopulationCounts(
    session,
    { resource: target, base: resolved!.base, main },
    contexts,
  );
  const items = page.flatMap((row) => {
    const id = row.population!.value,
      global = id === GLOBAL_RATING_POPULATION_OWNER;
    const summary = summaries.get(id),
      ratingCount = Number(row.count!.value);
    const contexts = row.contexts!.value.split('|').sort();
    if (!Number.isSafeInteger(ratingCount) || ratingCount < 0 || contexts.length > 64) {
      throw new WorkReadUnavailable('Rating population count or Contexts exceed their domain');
    }
    if (
      !global &&
      (!visible.has(id) || summary?.status !== 'available' || summary.disclosure !== 'public')
    )
      return [];
    if (contexts.reduce((sum, context) => sum + (verified.get(context) ?? 0), 0) !== ratingCount) {
      throw new WorkReadUnavailable('Rating population differs from its sealed evidence');
    }
    if (ratingCount === 0) return [];
    return [
      {
        id,
        global,
        ratingCount,
        contexts,
        readerCommunity: flags.get(id)?.community ?? false,
        name: global
          ? {
              value: 'Global',
              language: 'en',
              direction: 'ltr' as const,
              basis: 'fallback' as const,
            }
          : summary!.status === 'available'
            ? summary!.name
            : null!,
      },
    ];
  });
  if (reader) {
    const current = await session.deps.discoveryAudience!.flags(
      reader.principal,
      reader.actor,
      realms,
    );
    if (JSON.stringify([...current]) !== JSON.stringify([...flags]))
      throw new WorkReadMoved('Reader communities changed');
  }
  await fenceDiscoveryReader(session, reader);
  if (index) await fenceLabelIndex(session, index);
  if (
    main &&
    JSON.stringify(await session.deps.ratingPopulations!.inherited(main)) !==
      JSON.stringify(inherited)
  ) {
    throw new WorkReadMoved('Rating inheritance changed');
  }
  const last = page.at(-1);
  const next =
    rows.length > limit && last
      ? encodeReadCursor(
          binding,
          session.position,
          last.population!.value,
          JSON.stringify({ count: last.count!.value, seen: prior.seen + items.length }),
        )
      : null;
  return {
    profile: 'rating-populations-v1' as const,
    target,
    sourcePosition: session.position,
    ...listResult(items, next, prior.seen),
  };
}
