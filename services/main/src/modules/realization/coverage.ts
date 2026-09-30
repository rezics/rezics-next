import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { InvalidRelease, type CoveredRealization, type ReleaseV2Write } from '../release/schema.ts';
import { parseStoredRealization, REALIZATION_PROFILE } from './schema.ts';

/** One VALUES join for at most 64 exact texts, O(C) output and no language/title matching. */
export async function resolveReleaseCoverage(env: WorkActivationEnvironment,
  entries: ReleaseV2Write['coverage']): Promise<CoveredRealization[]> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?realization ?revision ?work ?state WHERE {
    VALUES (?realization ?revision) { ${entries.map(entry => `(${iri(entry.realization)} ${iri(entry.revision)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?realization a rv:Realization ; rv:work ?work }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RealizationRevision ; rv:component ?realization ;
      rv:modelRevision ${iri(REALIZATION_PROFILE)} ; rv:realizationState ?state }
  } LIMIT ${entries.length + 1}`, 640 * 1024)).results?.bindings ?? [];
  if (rows.length !== entries.length || new Set(rows.map(row => row.realization?.value)).size !== entries.length) {
    throw new InvalidRelease('Release coverage requires available exact realization revisions');
  }
  const byRealization = new Map(rows.map(row => [row.realization?.value, row]));
  return entries.map(entry => {
    const row = byRealization.get(entry.realization);
    if (!row?.state || !row.work || row.revision?.value !== entry.revision) throw new InvalidRelease('Realization coverage is incomplete');
    const record = parseStoredRealization(row.state.value, row.work.value);
    if (record.id !== entry.realization) throw new InvalidRelease('Realization identity differs');
    return { ...entry, work: record.work, language: record.language, kind: record.kind, status: record.status };
  });
}
