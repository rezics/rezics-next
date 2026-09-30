import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readWorkParts } from '../composition/read.ts';
import { readWorkBasis, fenceWorkBasis, type WorkBasis } from '../work/read-header.ts';
import { WorkReadInvalid, WorkReadUnavailable, encodeReadCursor, decodeReadCursor,
  type WorkReadSession } from '../work/read-session.ts';
import type { StatusState } from '../library/status.ts';
import { canonicalLanguage } from '../display-language/select.ts';
import { recordedLanguageTag } from '../release/languages.ts';
import { readableSeriesCoverage } from './series-coverage.ts';
import { furthestSeriesOccurrence } from './series-boundary.ts';
import { readProgressCoverage } from '../progress-summary/coverage.ts';
import type { SessionOwner } from './store.ts';
import { SERIES_COST, SERIES_POLICY, seriesProgress, type SeriesPart } from './series-policy.ts';

export async function readSeriesProgress(session: WorkReadSession, owner: SessionOwner, resource: string,
  options: { language?: string; parent?: string; after?: string; sessionCursor?: string; releaseCursor?: string },
  admittedBasis?: WorkBasis) {
  const deps = session.deps;
  if (!deps.seriesSessions || !deps.editionPreferences || !deps.libraryStatus) throw new WorkReadUnavailable('Progress summaries are unavailable');
  const basis = admittedBasis ?? await readWorkBasis(session, resource);
  const composition = await readWorkParts(session, resource, { limit: SERIES_COST.parts,
    parent: options.parent, after: options.after });
  const parts: SeriesPart[] = composition.parts.flatMap(part => part.work ? [{
    occurrence: part.occurrence, work: part.work, displayLabel: part.displayLabel ?? '',
    inclusion: part.inclusion ?? 'required', available: false }] : []);
  const works = [...new Set(parts.map(part => part.work))];
  const preferences = await deps.editionPreferences.batch(owner, [resource, ...works]);
  const preference = preferences.get(resource) ?? null;
  const chosenLanguage = preference?.language ?? options.language;
  const language = chosenLanguage ? recordedLanguageTag(chosenLanguage) : undefined;
  if (!language) throw new WorkReadInvalid('Choose a realization language or save an edition preference');
  // Aggregate distinct recorded tags, rather than one row per edition. Compare
  // through the shared contract, including legacy casing and language aliases.
  const availability = works.length ? await session.query(`SELECT ?work
    (GROUP_CONCAT(DISTINCT ?tag; separator=" ") AS ?languages) WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
      { ?text a rv:Realization ; rv:work ?work ; rv:contentLanguage ?tag }
      UNION { ?text a rv:TextContribution ; rv:work ?work ; rv:publicationHead ?publication ; rv:language ?tag }
    } }
  } GROUP BY ?work`, works.length) : [];
  const available = new Set(availability.filter(row => row.languages?.value.split(' ')
    .some(tag => canonicalLanguage(tag) === language)).map(row => row.work!.value));
  for (const part of parts) part.available = available.has(part.work);
  const binding = [SERIES_POLICY, resource, composition.revision, owner.agent, owner.principal.subject, language];
  const releaseLimit = SERIES_COST.releaseCandidates;
  const releaseAfter = decodeReadCursor(options.releaseCursor, binding, session.position)?.after;
  const releaseRows = works.length ? await session.query(`SELECT DISTINCT ?release WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?release a rv:Release ; rv:work|rv:coverageWork ?work }
    ${releaseAfter ? `FILTER(STR(?release) > ${lit(releaseAfter)})` : ''}
  } ORDER BY STR(?release) LIMIT ${releaseLimit + 1}`, releaseLimit + 1) : [];
  const releases = releaseRows.slice(0, releaseLimit).map(row => row.release!.value);
  const releaseNext = releaseRows.length > releaseLimit
    ? encodeReadCursor(binding, session.position, releases.at(-1)!) : null;
  const attempts = await deps.seriesSessions.batch(owner, [resource, ...works], releases,
    session.position, options.sessionCursor);
  const candidates = await readProgressCoverage(session, attempts.items);
  const library: StatusState[] = [];
  for (let offset = 0; offset < works.length; offset += 24) {
    library.push(...await deps.libraryStatus.batch(owner.agent, works.slice(offset, offset + 24)));
  }
  const pins = await readableSeriesCoverage(session, works, candidates);
  const groups = composition.parts.filter(part => part.role === 'group').map(part => part.occurrence);
  const partial = Boolean(composition.next || groups.length || options.parent || options.after
    || options.sessionCursor || attempts.next || releaseNext || options.releaseCursor);
  const summary = seriesProgress(parts, attempts.items, pins, language, composition.completion.status, partial, library);
  if (summary.furthestCompleted) {
    const boundary = await furthestSeriesOccurrence(session, summary.furthestCompleted.part.work, attempts.items);
    summary.furthestCompleted.occurrence = boundary.occurrence;
    summary.states.correspondenceUnresolved ||= boundary.unresolved;
  }
  const nextPreference = summary.next ? preferences.get(summary.next.part.work) : undefined;
  await fenceWorkBasis(session, basis);
  return { resource, scope: 'disclosed-composition' as const, ...summary, preference, primaryAction: summary.next
    ? { work: summary.next.part.work, edition: nextPreference && canonicalLanguage(nextPreference.language) === language ? nextPreference.edition : null, language } : null,
    revisions: { composition: { structure: composition.structure, revision: composition.revision },
      sessions: attempts.items.map(attempt => ({ id: attempt.id, version: attempt.version })),
      library: library.filter(item => item.version > 0).map(item => ({ work: item.work, version: item.version })),
      selections: pins.map(pin => ({ resource: pin.resource, revision: pin.revision })),
      graph: session.position },
    continuation: { parts: composition.next, groups, sessions: attempts.next, releases: releaseNext } };
}
