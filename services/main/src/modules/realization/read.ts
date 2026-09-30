import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readWorkBasis, fenceWorkBasis } from '../work/read-header.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { parseStoredRealization, REALIZATION_COST, REALIZATION_PROFILE, type RealizationRecord } from './schema.ts';
import { readLegacyRealization, translationRealization } from './legacy.ts';
import { readTranslationLinks } from '../work/translation-links.ts';

export function realizationView(record: RealizationRecord, revision: string) {
  const { expectedHead: ignoredHead, actingSubject: ignoredActor, ...facts } = record;
  return { ...facts, revision, legacy: null };
}

async function readRealization(session: WorkReadSession, work: string, id: string, revision?: string) {
  const rows = await session.query(`SELECT ?revision ?state WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(id)} a rv:Realization ; rv:work ${iri(work)} .
      ${revision ? '' : `${iri(id)} rv:head ?revision`} }
    ${revision ? `VALUES ?revision { ${iri(revision)} }` : ''}
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RealizationRevision ; rv:component ${iri(id)} ;
      rv:modelRevision ${iri(REALIZATION_PROFILE)} ; rv:realizationState ?state }
  } LIMIT 2`, 2);
  if (rows.length > 1) throw new WorkReadUnavailable('Realization is ambiguous');
  let result;
  if (rows.length === 1 && rows[0]?.revision && rows[0].state) {
    const record = parseStoredRealization(rows[0].state.value, work);
    if (record.id !== id) throw new WorkReadUnavailable('Realization identity differs');
    result = realizationView(record, rows[0].revision.value);
  } else {
    result = await readLegacyRealization(session, work, id);
    if (!result || revision && revision !== result.revision) throw new WorkReadMissing('Realization is unavailable');
  }
  if (result.legacy && (await session.summaries([result.legacy.targetWork]))[0]?.status !== 'available') {
    throw new WorkReadMissing('Realization is unavailable');
  }
  return { ...result, sourcePosition: session.position };
}

export async function readWorkRealization(session: WorkReadSession, work: string, id: string, revision?: string) {
  const basis = await readWorkBasis(session, work);
  const result = await readRealization(session, work, id, revision);
  await fenceWorkBasis(session, basis);
  return result;
}

/** UNION retained legacy identities before slicing, so no installed record is
 * dropped by a first-page adapter. O(R log R) candidates, at most twenty texts. */
export async function readWorkRealizations(session: WorkReadSession, work: string) {
  const basis = await readWorkBasis(session, work);
  const limit = session.options.limit ?? REALIZATION_COST.page;
  const binding = ['realizations', work];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT ?realization ?revision ?state ?main ?legacyRevision ?targetWork WHERE {
    { GRAPH ${iri(GRAPHS.current)} { ?realization a rv:Realization ; rv:work ${iri(work)} ; rv:head ?revision }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RealizationRevision ; rv:component ?realization ;
        rv:modelRevision ${iri(REALIZATION_PROFILE)} ; rv:realizationState ?state } } }
    UNION { GRAPH ${iri(GRAPHS.revisions)} { ?realization a rv:TranslationLink ; rv:sourceWork ${iri(work)} ;
      rv:targetMainVersion ?main ; rv:targetMainRevision ?legacyRevision ; rv:targetWork ?targetWork } }
    ${cursor ? `FILTER(STR(?realization) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?realization) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.realization) || new Set(rows.map(row => row.realization!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Realization identities are ambiguous');
  }
  const page = rows.slice(0, limit);
  const targets = [...new Set(page.flatMap(row => row.targetWork ? [row.targetWork.value] : []))];
  const readable = new Set((await session.summaries(targets)).filter(row => row.status === 'available').map(row => row.reference));
  const items = [];
  for (const row of page) {
    if (row.main && row.legacyRevision && row.targetWork) {
      if (!readable.has(row.targetWork.value)) continue;
      const links = await readTranslationLinks(session.deps.environment, row.main.value, row.legacyRevision.value);
      const link = links.find(item => item.link === row.realization!.value);
      if (!link || link.sourceWork !== work || link.targetWork !== row.targetWork.value) {
        throw new WorkReadUnavailable('Installed translation differs from its realization');
      }
      items.push(translationRealization(link));
    } else {
      if (!row.revision || !row.state) throw new WorkReadUnavailable('Realization revision is incomplete');
      const record = parseStoredRealization(row.state.value, work);
      if (record.id !== row.realization!.value) throw new WorkReadUnavailable('Realization identity differs');
      items.push(realizationView(record, row.revision.value));
    }
  }
  for (const summary of await session.summaries(targets)) {
    if (summary.status !== 'available') readable.delete(summary.reference);
  }
  const visible = items.filter(item => !item.legacy || readable.has(item.legacy.targetWork));
  await fenceWorkBasis(session, basis);
  return pageResult(session, visible, rows.length > limit
    ? encodeReadCursor(binding, session.position, rows[limit - 1]!.realization!.value) : null);
}
