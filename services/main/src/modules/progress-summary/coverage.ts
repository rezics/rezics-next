import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { parseStoredRealization } from '../realization/schema.ts';
import { parseStoredRelease } from '../release/schema.ts';
import type { SessionState } from '../session/contract.ts';
import type { CoveragePin } from '../session/series-policy.ts';

/** Resolve only immutable selection pins; today's editions and Rewrite links
 * cannot retrospectively change the Work a reading attempt covered. */
export async function readProgressCoverage(session: WorkReadSession, attempts: SessionState[]) {
  const targets = new Map(attempts.flatMap(attempt => attempt.selections
    .filter(selection => selection.target.base === 'realization' || selection.target.base === 'release')
    .map(selection => [`${selection.target.resource}|${selection.target.revision}`, selection.target] as const)));
  const candidates: CoveragePin[] = [];
  // One join over exact immutable selection pins; no read of today's coverage
  // can retrospectively change an attempt. Release entries are at most 64 each.
  const rows = targets.size ? await session.query(`SELECT ?resource ?revision ?state ?realizationState ?nativeWork ?nativeLanguage WHERE {
    VALUES (?resource ?revision) { ${[...targets.values()].map(target =>
      `(${iri(target.resource)} ${iri(target.revision)})`).join(' ')} }
    { GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:component ?resource .
      { ?revision rv:releaseState ?state } UNION { ?revision rv:realizationState ?realizationState } } }
    UNION { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:RevisionAnchor ; rv:component ?resource }
      GRAPH ${iri(GRAPHS.current)} { ?resource a rv:TextContribution ; rv:work ?nativeWork ; rv:language ?nativeLanguage } }
  } LIMIT ${targets.size + 1}`, targets.size) : [];
  for (const row of rows) {
    if (!row.resource || !row.revision) throw new WorkReadUnavailable('Coverage pin is incomplete');
    let pin: CoveragePin;
    if (row.nativeWork && row.nativeLanguage) {
      pin = { resource: row.resource.value, revision: row.revision.value, entries: [{ work: row.nativeWork.value,
        language: row.nativeLanguage.value, completeness: 'complete', realization: row.resource.value, revision: row.revision.value }] };
    } else if (row.realizationState) {
      const record = parseStoredRealization(row.realizationState.value);
      if (record.id !== row.resource.value) throw new WorkReadUnavailable('Realization identity differs');
      pin = { resource: record.id, revision: row.revision.value, entries: [{ work: record.work,
        language: record.language, completeness: 'complete', realization: record.id, revision: row.revision.value }] };
    } else if (row.state) {
      const record = parseStoredRelease(row.state.value);
      if (record.id !== row.resource.value) throw new WorkReadUnavailable('Release identity differs');
      pin = { resource: record.id, revision: row.revision.value, entries: record.profile === 'release-v2'
        ? record.coverage.map(entry => { const resolved = record.resolvedCoverage.find(item => item.realization === entry.realization)!;
          return { ...entry, work: resolved.work, language: resolved.language }; })
        : [{ work: record.work, language: null, completeness: 'unknown', realization: null, revision: null }] };
    } else throw new WorkReadUnavailable('Coverage revision is unavailable');
    candidates.push(pin);
  }
  return candidates;
}
