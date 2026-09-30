import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readWorkParts } from '../composition/read.ts';
import { readWorkBasis, fenceWorkBasis } from '../work/read-header.ts';
import { WorkReadInvalid, WorkReadMissing, WorkReadUnavailable, encodeReadCursor, decodeReadCursor,
  type WorkReadSession } from '../work/read-session.ts';
import { parseStoredRealization } from '../realization/schema.ts';
import { parseStoredRelease } from '../release/schema.ts';
import { recordedLanguageTag } from '../release/languages.ts';
import { furthestSeriesOccurrence } from './series-boundary.ts';
import type { SessionOwner } from './store.ts';
import { SERIES_COST, SERIES_POLICY, seriesProgress, type CoveragePin, type SeriesPart } from './series-policy.ts';

export async function readSeriesProgress(session: WorkReadSession, owner: SessionOwner, resource: string,
  options: { language?: string; parent?: string; after?: string; sessionCursor?: string; releaseCursor?: string;
    sessionLimit?: number; releaseLimit?: number }) {
  const deps = session.deps;
  if (!deps.seriesSessions || !deps.editionPreferences) throw new WorkReadUnavailable('Progress summaries are unavailable');
  const basis = await readWorkBasis(session, resource);
  const composition = await readWorkParts(session, resource, { limit: SERIES_COST.parts,
    parent: options.parent, after: options.after });
  const parts: SeriesPart[] = composition.parts.flatMap(part => part.work ? [{
    occurrence: part.occurrence, work: part.work, displayLabel: part.displayLabel ?? '',
    inclusion: part.inclusion ?? 'required', available: false }] : []);
  const works = [...new Set(parts.map(part => part.work))];
  const preferences = await deps.editionPreferences.batch(owner, [resource, ...works]);
  const preference = preferences.get(resource) ?? null;
  const language = preference?.language ?? (options.language ? recordedLanguageTag(options.language) : undefined);
  if (!language) throw new WorkReadInvalid('Choose a realization language or save an edition preference');
  const availability = works.length ? await session.query(`SELECT ?work
    (EXISTS { GRAPH ${iri(GRAPHS.current)} { ?text a rv:Realization ; rv:work ?work ; rv:contentLanguage ${lit(language)} } }
      || EXISTS { GRAPH ${iri(GRAPHS.current)} { ?text a rv:TextContribution ; rv:work ?work ;
        rv:publicationHead ?publication ; rv:language ${lit(language)} } }
      AS ?available)
    WHERE { VALUES ?work { ${works.map(iri).join(' ')} } }`, works.length) : [];
  const available = new Set(availability.filter(row => row.available?.value === 'true').map(row => row.work!.value));
  for (const part of parts) part.available = available.has(part.work);
  const binding = [SERIES_POLICY, resource, composition.revision, owner.agent, owner.principal.subject, language];
  const releaseLimit = options.releaseLimit ?? SERIES_COST.releaseCandidates;
  if (!Number.isInteger(releaseLimit) || releaseLimit < 1 || releaseLimit > SERIES_COST.releaseCandidates) {
    throw new WorkReadInvalid('Invalid release batch size');
  }
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
    session.position, options.sessionCursor, options.sessionLimit);
  const targets = new Map(attempts.items.flatMap(attempt => attempt.selections
    .filter(selection => selection.target.base === 'realization' || selection.target.base === 'release')
    .map(selection => [`${selection.target.resource}|${selection.target.revision}`, selection.target] as const)));
  const pins: CoveragePin[] = [];
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
  const readable = new Map<string, boolean>(works.map(work => [work, true]));
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
    const check = [...new Set(pin.entries.map(entry => entry.work))].filter(work => !readable.has(work));
    for (let offset = 0; offset < check.length; offset += 64) {
      for (const summary of await session.summaries(check.slice(offset, offset + 64))) {
        readable.set(summary.reference, summary.status === 'available');
      }
    }
    if (pin.entries.every(entry => readable.get(entry.work))) pins.push(pin);
  }
  const groups = composition.parts.filter(part => part.role === 'group').map(part => part.occurrence);
  const partial = Boolean(composition.next || groups.length || options.parent || options.after
    || options.sessionCursor || attempts.next || releaseNext || options.releaseCursor);
  const summary = seriesProgress(parts, attempts.items, pins, language, composition.completion.status, partial);
  if (summary.furthestCompleted) {
    const boundary = await furthestSeriesOccurrence(session, summary.furthestCompleted.part.work, language, attempts.items);
    summary.furthestCompleted.occurrence = boundary.occurrence;
    summary.states.correspondenceUnresolved ||= boundary.unresolved;
  }
  const nextPreference = summary.next ? preferences.get(summary.next.part.work) : undefined;
  // Recheck every disclosed part/covered Work at response time. A policy change
  // cannot make the cached count or spoiler boundary disclose a private part.
  const disclosed = [...readable].filter(([, allowed]) => allowed).map(([work]) => work);
  for (let offset = 0; offset < disclosed.length; offset += 64) {
    if ((await session.summaries(disclosed.slice(offset, offset + 64))).some(row => row.status !== 'available')) {
      throw new WorkReadMissing('Progress inputs are unavailable');
    }
  }
  await fenceWorkBasis(session, basis);
  return { resource, scope: 'disclosed-composition' as const, ...summary, preference, primaryAction: summary.next
    ? { work: summary.next.part.work, edition: nextPreference?.language === language ? nextPreference.edition : null, language } : null,
    revisions: { composition: { structure: composition.structure, revision: composition.revision },
      sessions: attempts.items.map(attempt => ({ id: attempt.id, version: attempt.version })),
      selections: pins.map(pin => ({ resource: pin.resource, revision: pin.revision })),
      graph: session.position },
    continuation: { parts: composition.next, groups, sessions: attempts.next, releases: releaseNext } };
}
