import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { readCompositionPage } from '../structure/read.ts';
import { canReadCompositionWork } from './disclosure-read.ts';

/** Responses contain at most 100 disclosed uses and one disclosed lookahead.
 * Each scan batch is bounded to 101 candidates; hidden batches are skipped under
 * the shared read deadline and query budget. No physical scan cost is disclosed.
 * Parts then use one VALUES query for Main Versions. Access checks are cached
 * per distinct Work for the duration of a read.
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
  const access = new Map<string, Promise<boolean>>();
  const page = await readCompositionPage(session.deps.environment, {
    structure: rows[0].structure.value, limit: input.limit,
    ...(input.parent ? { parent: input.parent } : {}), ...(input.after ? { after: input.after } : {}),
    canReadTarget: target => {
      if (!access.has(target)) access.set(target, canReadCompositionWork(session, target));
      return access.get(target)!;
    },
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
  let after = decodeReadCursor(input.after, binding, session.position)?.after;
  const wholes: Array<{ work: string; mainVersion: string; structure: string; occurrence: string;
    segmentKey: string; orderKey: string }> = [];
  const access = new Map<string, boolean>();
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
      const whole = row.whole?.value;
      if (!whole || !row.main?.value || !row.structure?.value || !row.occurrence?.value
        || !row.segment?.value || !row.order?.value) throw new WorkReadUnavailable('Whole projection is unavailable');
      if (!access.has(whole)) access.set(whole, await canReadCompositionWork(session, whole));
      if (access.get(whole)) wholes.push({ work: whole, mainVersion: row.main.value,
        structure: row.structure.value, occurrence: row.occurrence.value,
        segmentKey: row.segment.value, orderKey: row.order.value });
      if (wholes.length > input.limit) break;
    }
    if (wholes.length > input.limit || rows.length < WORK_COMPOSITION_READ_COST.candidateProbe) break;
    const last = rows.at(-1)!;
    after = `${last.whole!.value}|${last.occurrence!.value}`;
  }
  const hasNext = wholes.length > input.limit;
  wholes.splice(input.limit);
  const last = wholes.at(-1);
  return { resource, wholes, next: hasNext && last
    ? encodeReadCursor(binding, session.position, `${last.work}|${last.occurrence}`) : null,
    sourcePosition: { datasetId: 'product' as const, ...session.position } };
}
