import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { readCompositionPage } from '../structure/read.ts';
import { canReadCompositionWork } from './disclosure-read.ts';
import { compositionWorkBatchReader } from './visible-targets.ts';
import { admittedReadPosition } from '../read-basis/admitted-position.ts';

/** Responses contain at most 100 disclosed uses and one disclosed lookahead.
 * Each scan batch is bounded to 101 candidates; hidden batches are skipped under
 * the shared read deadline and query budget. No physical scan cost is disclosed.
 * Targets are disclosed in bounded resolver batches. Parts then use one VALUES
 * query for Main Versions; wholes cache disclosure per distinct Work.
 */
export const WORK_COMPOSITION_READ_COST = { page: 100, candidateProbe: 101, targetQueries: 1,
  ancestorLevels: 4, wholeBatchQueries: 1 } as const;

function checkLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > WORK_COMPOSITION_READ_COST.page) {
    throw new WorkReadInvalid('Composition page size must be between 1 and 100');
  }
}

export async function readWorkParts(session: WorkReadSession, resource: string, input: {
  parent?: string; after?: string; limit: number;
}) {
  checkLimit(input.limit);
  if (!await canReadCompositionWork(session, resource)) throw new WorkReadMissing('Work is unavailable');
  const rows = await session.query(`SELECT ?structure ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(resource)} a <https://schema.org/CreativeWork> ; rv:mainVersion ?main .
    ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile rv:WorkComposition .
  } } LIMIT 2`, 2);
  if (rows.length !== 1 || !rows[0]?.structure?.value || !rows[0]?.main?.value) {
    throw new WorkReadMissing('Work composition is unavailable');
  }
  const canReadTargets = compositionWorkBatchReader(session);
  const page = await readCompositionPage(session.deps.environment, {
    structure: rows[0].structure.value, limit: input.limit,
    ...(input.parent ? { parent: input.parent } : {}), ...(input.after ? { after: input.after } : {}),
    canReadTarget: async target => (await canReadTargets([target])).has(target),
    canReadTargets,
  });
  const targets = [...new Set(page.occurrences.flatMap(record => record.target ? [record.target] : []))];
  const mains = targets.length ? await session.query(`SELECT ?target ?main WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?target a <https://schema.org/CreativeWork> ; rv:mainVersion ?main }
  } LIMIT ${targets.length + 1}`, targets.length + 1) : [];
  const byTarget = new Map(mains.map(row => [row.target?.value, row.main?.value]));
  if (mains.length !== targets.length || byTarget.size !== targets.length) {
    throw new WorkReadUnavailable('Part Main Versions are unavailable');
  }
  return { resource, mainVersion: rows[0].main.value, structure: page.structure, revision: page.revision,
    completion: page.completion!, parts: page.occurrences.map(record => ({
      occurrence: record.occurrence, role: record.role as 'group' | 'part', parent: record.parent,
      segmentKey: record.segmentKey!, orderKey: record.orderKey!, labels: record.labels,
      ...(record.target ? { work: record.target, mainVersion: byTarget.get(record.target)! } : {}),
      ...(record.qualifier?.type === 'work-part' ? { displayLabel: record.qualifier.displayLabel,
        inclusion: record.qualifier.inclusion } : {}),
    })), next: page.next, sourcePosition: page.sourcePosition };
}

export async function readWorkWholes(session: WorkReadSession, resource: string, input: {
  after?: string; limit: number;
}) {
  checkLimit(input.limit);
  if (!await canReadCompositionWork(session, resource)) throw new WorkReadMissing('Work is unavailable');
  const binding = { resource, kind: 'work-wholes', actor: session.options.actingSubject,
    subject: session.principal?.subject };
  let firstPage: Awaited<ReturnType<typeof workWholesPage>>;
  const position = await admittedReadPosition(session, JSON.stringify(binding), async function* (probe) {
    let after: string | undefined;
    do {
      const page = await workWholesPage(probe, resource, WORK_COMPOSITION_READ_COST.page, after);
      if (!after) firstPage = page;
      yield page.wholes;
      after = page.after;
    } while (after);
  });
  const cursor = decodeReadCursor(input.after, binding, position);
  // Retain only the first bounded owner page while hashing the relation. Its
  // selected-result fence already closes a first response's rows and lookahead.
  const wholes = !cursor ? firstPage!.wholes.slice(0, input.limit) : undefined;
  const last = wholes?.at(-1);
  const page = wholes ? { wholes, after: last && (firstPage!.wholes.length > input.limit || firstPage!.after)
    ? `${last.work}|${last.occurrence}` : undefined }
    : await session.selection(`work-wholes:${JSON.stringify([resource, cursor?.after, input.limit])}`,
      probe => workWholesPage(probe, resource, input.limit, cursor?.after));
  return { resource, wholes: page.wholes, next: page.after
    ? encodeReadCursor(binding, position, page.after) : null,
    sourcePosition: { datasetId: 'product' as const, ...position } };
}

async function workWholesPage(session: WorkReadSession, resource: string, limit: number, after?: string) {
  const wholes: Array<{ work: string; mainVersion: string; structure: string; occurrence: string;
    segmentKey: string; orderKey: string }> = [];
  const access = new Map<string, boolean>();
  const canReadTargets = compositionWorkBatchReader(session);
  while (true) {
    session.checkDeadline();
    const rows = await session.query(`SELECT ?whole ?main ?structure ?occurrence ?segment ?order WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?placement a rv:OccurrencePlacement ; rv:composedWork ${iri(resource)} ; rv:generation ?generation ;
          rv:occurrence ?occurrence ; rv:orderSegment ?orderSegment ; rv:orderKey ?order .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
        ?orderSegment rv:segmentKey ?segment .
        ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile rv:WorkComposition ;
          rv:selectedGeneration ?generation .
        ?whole a <https://schema.org/CreativeWork> ; rv:mainVersion ?main .
        BIND(CONCAT(STR(?whole), "|", STR(?occurrence)) AS ?key)
        ${after ? `FILTER(?key > ${lit(after)})` : ''}
      }
    } ORDER BY STR(?whole) STR(?occurrence) LIMIT ${WORK_COMPOSITION_READ_COST.candidateProbe}`,
    WORK_COMPOSITION_READ_COST.candidateProbe);
    for (const row of rows) {
      if (!row.whole?.value || !row.main?.value || !row.structure?.value || !row.occurrence?.value
        || !row.segment?.value || !row.order?.value) throw new WorkReadUnavailable('Whole projection is unavailable');
    }
    const candidates = [...new Set(rows.map(row => row.whole!.value))]
      .filter(whole => !access.has(whole));
    const readable = await canReadTargets(candidates);
    for (const whole of candidates) access.set(whole, readable.has(whole));
    for (const row of rows) {
      const whole = row.whole!.value;
      if (access.get(whole)) wholes.push({ work: whole, mainVersion: row.main!.value,
        structure: row.structure!.value, occurrence: row.occurrence!.value,
        segmentKey: row.segment!.value, orderKey: row.order!.value });
      if (wholes.length > limit) break;
    }
    if (wholes.length > limit || rows.length < WORK_COMPOSITION_READ_COST.candidateProbe) break;
    const last = rows.at(-1)!;
    after = `${last.whole!.value}|${last.occurrence!.value}`;
  }
  const hasNext = wholes.length > limit;
  wholes.splice(limit);
  const last = wholes.at(-1);
  return { wholes, after: hasNext && last ? `${last.work}|${last.occurrence}` : undefined };
}
