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
import { selectDisplayName, type LocalizedText } from '../display-language/select.ts';

// This system population has an authored name, rather than a synthetic name
// tagged with the reader's language. Additional labels retain their own tags.
const globalPopulationName: LocalizedText = { original: 'en', labels: { en: 'Global' } };

export const ratingPopulationsQuery = t.Object(
  { ...listRequestFields, target: readId, actingSubject: t.Optional(readId) },
  { additionalProperties: false },
);
export const ratingPopulation = t.Object({
  id: readId,
  name: readName,
  ratingCount: t.Integer({ minimum: 1 }),
  global: t.Boolean(),
  readerCommunity: t.Boolean(),
});
export const ratingPopulationsPage = t.Object({
  ...listResponse(ratingPopulation).properties,
  profile: t.Literal('rating-populations-v1'),
  target: readId,
  sourcePosition: readPosition,
  stale: t.Boolean(),
});
export interface RatingPopulationsQuery extends ListRequest {
  target: string;
  actingSubject?: string;
}
/** Target-leading context counters maintained by the native command module.
 * Reads never enumerate observation heads. One counter per Context/target is
 * summed into its population; legacy migration incompleteness is explicit. */
export const RATING_POPULATIONS_COST = {
  candidates: 512,
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
  const q = input.q?.trim() ?? '',
    limit = input.limit ?? 20;
  const index = q ? await labelIndexReady(session) : null;
  const binding = [
    'rating-populations-v2',
    target,
    main,
    q,
    limit,
    reader?.signals ?? null,
    session.displayLanguages,
    session.viewer,
  ];
  const cursor = decodeReadCursor(input.cursor, binding, session.position);
  let prior: { phase: 'joined' | 'count'; count: string; seen: number } = {
    phase: reader ? 'joined' : 'count',
    count: '0',
    seen: 0,
  };
  if (cursor) {
    try {
      prior = JSON.parse(cursor.order);
    } catch {
      throw new WorkReadInvalid('Rating population cursor is invalid');
    }
    if (
      !['joined', 'count'].includes(prior.phase) ||
      !/^\d+$/.test(prior.count) ||
      !Number.isSafeInteger(prior.seen) ||
      prior.seen < 0
    ) {
      throw new WorkReadInvalid('Rating population cursor is invalid');
    }
  }
  const projection = await session.query(
    `SELECT ?complete WHERE {
    GRAPH <urn:rezics:graph:rating-population-counts> {
      <urn:rezics:rating-population-counts:v1> rv:complete ?complete }
  } LIMIT 2`,
    1,
  );
  const stale = projection[0]?.complete?.value !== 'true';
  const readCounts = (ask: number, after: string, count: string, joined?: string[]) =>
    session.query(
      `SELECT ?population ?count WHERE {
    { SELECT ?population (SUM(?availableCount) AS ?count) WHERE {
      ${joined ? `VALUES ?population { ${joined.map(iri).join(' ')} }` : ''}
      GRAPH <urn:rezics:graph:rating-population-counts> {
        ?counter rv:populationTarget ${iri(main ?? target)} ; rv:populationContext ?context ;
          rv:availableRatingCount ?availableCount . FILTER(?availableCount > 0) }
      GRAPH ${iri(GRAPHS.current)} {
        ?context rv:contextState rv:Active ; rv:head ?contextHead .
        { ?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ?population .
          FILTER(?population = ${iri(GLOBAL_RATING_POPULATION_OWNER)})
          ${q && !'global'.includes(q.toLowerCase()) ? 'FILTER(false)' : ''} }
        UNION { ?context rv:realm ?population . ?population a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
          ?space a rv:Space ; rv:realmCapability ?population ; rv:disclosure rv:Public .
          FILTER NOT EXISTS { ?space rv:listing ?listing . FILTER(?listing != "listed") }
          FILTER NOT EXISTS { ?population rv:disclosure ?disclosure . FILTER(?disclosure != rv:Public) }
          FILTER NOT EXISTS { ?population rv:listing ?listing . FILTER(?listing != "listed") }
          FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
          FILTER NOT EXISTS { ?population rv:protectionHead ?protected }
          FILTER NOT EXISTS { ?space rv:protectionHead ?protectedSpace } }
      }
      ${
        q
          ? `FILTER(?population = ${iri(GLOBAL_RATING_POPULATION_OWNER)} || EXISTS {
        ${indexedNameMatch('?population', q)} })`
          : ''
      }
      { GRAPH ${iri(GRAPHS.revisions)} {
          ?contextHead a rv:RevisionAnchor ; rv:component ?context .
          FILTER NOT EXISTS { ?contextHead a rv:ErasedRevision } }
        GRAPH ${iri(GRAPHS.receipts)} {
          ?contextReceipt a rv:OperationReceipt ; rv:ratingContextRevision ?contextHead ; rv:outcome rv:Succeeded } }
      } GROUP BY ?population HAVING(SUM(?availableCount)>0) }
      ${
        after
          ? `FILTER(?count < ${lit(count)}^^<http://www.w3.org/2001/XMLSchema#integer>
        || (?count = ${lit(count)}^^<http://www.w3.org/2001/XMLSchema#integer>
          && STR(?population) > ${lit(after)}))`
          : ''
      }
    } ORDER BY ${joined ? '' : 'DESC(?count)'} STR(?population) LIMIT ${ask + 1}`,
      ask + 1,
    );
  type Position = { phase: 'joined' | 'count'; after: string; count: string };
  const state: Position = { phase: prior.phase, after: cursor?.after ?? '', count: prior.count };
  const selected: { row: Awaited<ReturnType<typeof readCounts>>[number]; position: Position }[] =
    [];
  let scanned = 0,
    exhausted = false;
  // Seek joined identities first; the second phase excludes joined candidates
  // in bounded Access batches. The cursor retains the phase and its own key.
  while (selected.length <= limit && scanned < RATING_POPULATIONS_COST.candidates) {
    const ask = Math.min(64, RATING_POPULATIONS_COST.candidates - scanned);
    if (state.phase === 'joined') {
      const joined = await session.deps.discoveryAudience!.joinedRealms(
        reader!.principal,
        reader!.actor,
        state.after,
        ask,
      );
      const ids = joined.slice(0, ask).map((row) => row.id);
      const counts = ids.length ? await readCounts(ask, '', '0', ids) : [];
      const byId = new Map(counts.map((row) => [row.population!.value, row]));
      for (const id of ids) {
        state.after = id;
        scanned++;
        const row = byId.get(id);
        if (row) selected.push({ row, position: { ...state } });
        if (selected.length > limit) break;
      }
      if (selected.length > limit) break;
      if (joined.length <= ask) Object.assign(state, { phase: 'count', after: '', count: '0' });
    } else {
      const rows = await readCounts(ask, state.after, state.count);
      const window = rows.slice(0, ask);
      const flags = reader
        ? await session.deps.discoveryAudience!.flags(
            reader.principal,
            reader.actor,
            window.map((row) => row.population!.value),
          )
        : new Map();
      for (const row of window) {
        state.after = row.population!.value;
        state.count = row.count!.value;
        scanned++;
        if (!flags.get(state.after)?.community) selected.push({ row, position: { ...state } });
        if (selected.length > limit) break;
      }
      if (selected.length > limit) break;
      if (rows.length <= ask) {
        exhausted = true;
        break;
      }
    }
  }
  const page = selected.slice(0, limit).map((item) => item.row),
    ids = page.map((row) => row.population!.value);
  const realms = ids.filter((id) => id !== GLOBAL_RATING_POPULATION_OWNER);
  const flags = reader
    ? await session.deps.discoveryAudience!.flags(reader.principal, reader.actor, realms)
    : new Map();
  if (
    reader &&
    selected
      .slice(0, limit)
      .some(
        (item) =>
          !!flags.get(item.row.population!.value)?.community !== (item.position.phase === 'joined'),
      )
  )
    throw new WorkReadMoved('Reader communities changed');
  const summaries = new Map(
    (await session.summaries(realms)).map((summary) => [summary.reference, summary]),
  );
  const decisions = await session.disclosure(
    realms.map((resource) => ({ owner: 'graph' as const, resource, component: 'name' as const })),
    'search',
  );
  const visible = new Set(realms.filter((_, index) => decisions[index] === 'visible'));
  const items = page.flatMap((row) => {
    const id = row.population!.value,
      global = id === GLOBAL_RATING_POPULATION_OWNER;
    const summary = summaries.get(id),
      ratingCount = Number(row.count!.value);
    if (!Number.isSafeInteger(ratingCount) || ratingCount < 0) {
      throw new WorkReadUnavailable('Rating population count exceeds its domain');
    }
    if (
      !global &&
      (!visible.has(id) || summary?.status !== 'available' || summary.disclosure !== 'public')
    )
      return [];
    if (ratingCount === 0) return [];
    return [
      {
        id,
        global,
        ratingCount,
        readerCommunity: flags.get(id)?.community ?? false,
        name: global
          ? selectDisplayName(globalPopulationName, session.displayLanguages)!
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
  const last = selected.length > limit ? selected[limit - 1]!.position : state;
  const next = !exhausted
    ? encodeReadCursor(
        binding,
        session.position,
        last.after,
        JSON.stringify({ phase: last.phase, count: last.count, seen: prior.seen + items.length }),
      )
    : null;
  return {
    profile: 'rating-populations-v1' as const,
    target,
    sourcePosition: session.position,
    stale,
    ...listResult(items, next, prior.seen),
  };
}
