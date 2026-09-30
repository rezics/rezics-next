import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readWorkBasis, fenceWorkBasis } from '../work/read-header.ts';
import { decodeReadCursor, encodeReadCursor, WorkReadInvalid, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { recordedLanguageTag } from '../release/languages.ts';
import { readSeriesProgress } from '../session/series-read.ts';
import { readableSeriesCoverage } from '../session/series-coverage.ts';
import type { SessionOwner } from '../session/store.ts';
import { WORK_PROGRESS_COST } from './contract.ts';
import { readProgressCoverage } from './coverage.ts';
import { workProgress } from './policy.ts';

export async function readProgressSummary(session: WorkReadSession, owner: SessionOwner, resource: string,
  options: Parameters<typeof readSeriesProgress>[3]) {
  const basis = await readWorkBasis(session, resource);
  // Probe existence, not disclosed part count: empty and hidden compositions
  // must retain the series policy, and broken compositions must still fail.
  const structures = await session.query(`SELECT ?structure WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?structure a rv:Structure ; rv:structureOf ${iri(basis.card.mainVersion)} ; rv:structureProfile rv:WorkComposition
  } } LIMIT 2`, 1);
  if (structures.length) return readSeriesProgress(session, owner, resource, options, basis);
  if (options.parent || options.after) throw new WorkReadInvalid('This Work has no composition continuation');
  const { seriesSessions, editionPreferences, libraryStatus } = session.deps;
  if (!seriesSessions || !editionPreferences || !libraryStatus) throw new WorkReadUnavailable('Progress summaries are unavailable');
  const preferences = await editionPreferences.batch(owner, [resource]);
  const preference = preferences.get(resource) ?? null;
  const language = preference?.language ?? options.language;
  const binding = ['work-progress-releases-v1', resource, owner.agent, owner.principal.subject];
  const after = decodeReadCursor(options.releaseCursor, binding, session.position)?.after;
  const limit = WORK_PROGRESS_COST.releaseCandidates;
  // Indexed Work coverage lookup, bounded independently of the edition inventory.
  const rows = await session.query(`SELECT DISTINCT ?release WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?release a rv:Release ; rv:work|rv:coverageWork ${iri(resource)}
  } ${after ? `FILTER(STR(?release) > ${lit(after)})` : ''} } ORDER BY STR(?release) LIMIT ${limit + 1}`, limit + 1);
  const releases = rows.slice(0, limit).map(row => row.release!.value);
  const releaseNext = rows.length > limit ? encodeReadCursor(binding, session.position, releases.at(-1)!) : null;
  const attempts = await seriesSessions.batch(owner, [resource], releases, session.position, options.sessionCursor);
  const candidates = await readProgressCoverage(session, attempts.items);
  const pins = await readableSeriesCoverage(session, [resource], candidates);
  const library = await libraryStatus.batch(owner.agent, [resource]);
  const partial = Boolean(options.sessionCursor || attempts.next || options.releaseCursor || releaseNext);
  const summary = workProgress(resource, attempts.items, pins, partial, library);
  await fenceWorkBasis(session, basis);
  return { resource, scope: 'work' as const, ...summary,
    language: language ? recordedLanguageTag(language) : null, preference,
    revisions: { work: { resource, revision: basis.card.revision },
      sessions: attempts.items.map(attempt => ({ id: attempt.id, version: attempt.version })),
      library: library.filter(item => item.version > 0).map(item => ({ work: item.work, version: item.version })),
      selections: pins.map(pin => ({ resource: pin.resource, revision: pin.revision })), graph: session.position },
    continuation: { sessions: attempts.next, releases: releaseNext } };
}
