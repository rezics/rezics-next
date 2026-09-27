import { GRAPHS, WORK_SEMANTIC_TYPES, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, publicWork,
  WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { WorkCard } from '../work/read-header.ts';
import { readEpochOrder } from './lineage.ts';

/** Recently edited public Works. The sequence/IRI pair is a total order in one epoch. */
export async function readRecentWorks(session: WorkReadSession) {
  const limit = session.options.limit ?? 20;
  const binding = ['recent-works-v1', session.options.language ?? null];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const order = cursor?.order.split(':');
  if (order && (order.length !== 2 || !order.every(value => /^\d+$/.test(value)))) {
    throw new WorkReadUnavailable('Cursor ordering is unavailable');
  }
  const epochs = await readEpochOrder(session);
  const rows = await session.query(`SELECT DISTINCT ?work ?head ?main ?sequence ?epochOrder WHERE {
    ${epochs}
    ${publicWork('?work', '?main')}
    GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ; rv:component ?work ;
      rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence }
    ${cursor && order ? `FILTER(?epochOrder > ${order[0]} || (?epochOrder = ${order[0]}
      && (?sequence < ${order[1]} || (?sequence = ${order[1]} && STR(?work) > ${lit(cursor.after)}))))` : ''}
  } ORDER BY ?epochOrder DESC(?sequence) STR(?work) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.work || !row.head || !row.main || !/^\d+$/.test(row.sequence?.value ?? ''))
    || new Set(rows.map(row => row.work!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Recent Work relation is ambiguous');
  }
  const page = rows.slice(0, limit);
  const ids = page.map(row => row.work!.value);
  const summaries = await session.summaries(ids);
  const typeRows = ids.length ? await session.query(`SELECT ?work ?type WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
  } LIMIT 161`, 160) : [];
  // A second owner read catches a protection change while the batch was hydrated.
  const fenced = await session.summaries(ids);
  const types = new Map<string, string[]>();
  for (const row of typeRows) {
    if (!row.work || !row.type) throw new WorkReadUnavailable('Work type relation is incomplete');
    const values = types.get(row.work.value) ?? [];
    values.push(row.type.value);
    types.set(row.work.value, values);
  }
  const items: WorkCard[] = page.flatMap((row, index) => {
    const summary = summaries[index];
    if (summary?.status !== 'available' || fenced[index]?.status !== 'available') return [];
    return [{ id: row.work!.value, revision: row.head!.value, mainVersion: row.main!.value,
      title: summary.name, cover: summary.avatar,
      types: (types.get(row.work!.value) ?? []).sort() }];
  });
  const last = page.at(-1);
  return { profile: 'recent-works-v1' as const, order: 'metadata-updated-desc' as const,
    ...pageResult(session, items, rows.length > limit && last
      ? encodeReadCursor(binding, session.position, last.work!.value, `${last.epochOrder!.value}:${last.sequence!.value}`) : null) };
}
