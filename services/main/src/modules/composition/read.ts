import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { readCompositionPage } from '../structure/read.ts';
import type { StructureProfileRegistration } from '../structure/profiles.ts';
import { structureProfileFor, canReadStructureTarget } from '../structure/profiles.ts';

/** Each response examines at most 100 uses plus one continuation probe. No total
 * or ordinal is disclosed. Parts read one bounded immutable sibling page, then
 * one VALUES query for native Main Versions; wholes use one current keyset page.
 * Authority costs one check per distinct returned Work, plus the requested Work.
 */
export const WORK_COMPOSITION_READ_COST = { page: 100, candidateProbe: 101, targetQueries: 1,
  ancestorLevels: 4, wholeQueries: 1 } as const;

function checkLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > WORK_COMPOSITION_READ_COST.page) {
    throw new WorkReadInvalid('Composition page size must be between 1 and 100');
  }
}

async function canRead(session: WorkReadSession, profile: StructureProfileRegistration, target: string) {
  return Boolean(session.principal && session.options.actingSubject
    && await canReadStructureTarget(profile, { access: session.deps.access, principal: session.principal,
      actingSubject: session.options.actingSubject, target }));
}

export async function readWorkParts(session: WorkReadSession, resource: string, input: {
  parent?: string; after?: string; limit: number;
}) {
  checkLimit(input.limit);
  const profile = structureProfileFor('work-composition');
  if (!await canRead(session, profile, resource)) throw new WorkReadMissing('Work is unavailable');
  const rows = await session.query(`SELECT ?structure ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(resource)} a <https://schema.org/CreativeWork> ; rv:mainVersion ?main .
    ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile rv:WorkComposition .
  } } LIMIT 2`, 2);
  if (rows.length !== 1 || !rows[0]?.structure?.value || !rows[0]?.main?.value) {
    throw new WorkReadMissing('Work composition is unavailable');
  }
  const page = await readCompositionPage(session.deps.environment, {
    structure: rows[0].structure.value, limit: input.limit,
    ...(input.parent ? { parent: input.parent } : {}), ...(input.after ? { after: input.after } : {}),
    canReadTarget: target => canRead(session, profile, target),
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
    })), next: page.next, sourcePosition: page.sourcePosition, cost: page.cost };
}

export async function readWorkWholes(session: WorkReadSession, resource: string, input: {
  after?: string; limit: number;
}) {
  checkLimit(input.limit);
  const profile = structureProfileFor('work-composition');
  if (!await canRead(session, profile, resource)) throw new WorkReadMissing('Work is unavailable');
  const binding = { resource, kind: 'work-wholes', actor: session.options.actingSubject,
    subject: session.principal?.subject };
  const after = decodeReadCursor(input.after, binding, session.position)?.after;
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
  } ORDER BY STR(?whole) STR(?occurrence) LIMIT ${input.limit + 1}`, input.limit + 1);
  const page = rows.slice(0, input.limit);
  const wholes: Array<{ work: string; mainVersion: string; structure: string; occurrence: string;
    segmentKey: string; orderKey: string }> = [];
  for (const row of page) {
    const whole = row.whole?.value;
    if (!whole || !row.main?.value || !row.structure?.value || !row.occurrence?.value
      || !row.segment?.value || !row.order?.value) throw new WorkReadUnavailable('Whole projection is unavailable');
    if (await canRead(session, profile, whole)) wholes.push({ work: whole, mainVersion: row.main.value,
      structure: row.structure.value, occurrence: row.occurrence.value,
      segmentKey: row.segment.value, orderKey: row.order.value });
  }
  const last = page.at(-1);
  return { resource, wholes, next: rows.length > input.limit && last
    ? encodeReadCursor(binding, session.position, `${last.whole!.value}|${last.occurrence!.value}`) : null,
    sourcePosition: { datasetId: 'product' as const, ...session.position },
    cost: { graphQueries: 1 } };
}
