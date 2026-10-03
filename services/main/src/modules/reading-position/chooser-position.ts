import { GRAPHS, iri } from '../work/activate.ts';
import { parseStoredRelease } from '../release/schema.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { READING_POSITION_COST } from './contract.ts';
import { compareReadingLocations, READING_CHOOSER_COST, type ReadingLocation, type ReadingPositionTraversal } from './traversal.ts';

/** Same progress/session/Library sources as the wiki boundary. Only current
 * positions mentioned by reader state are looked up, then compared by stored
 * ancestor order keys. Chapter inventory is never fetched to resolve Mine. */
export async function chooserPosition(session: WorkReadSession, traversal: ReadingPositionTraversal,
  selection: string, ownReader: boolean): Promise<string> {
  if (selection === 'all') return 'all';
  if (selection === 'start' || selection === 'mine' && !ownReader) return 'start';
  if (selection !== 'mine') {
    const location = await traversal.location(selection);
    if (!location) return 'start';
    await traversal.requireLocation(location);
    return location.item.occurrence;
  }
  const { principal, options, deps } = session;
  if (!principal || !options.actingSubject) return 'start';
  let furthest: ReadingLocation | null = null;
  const consider = (location: ReadingLocation | null) => {
    if (location && (!furthest || compareReadingLocations(location, furthest) > 0)) furthest = location;
  };
  const finishes = new Map<string, Promise<ReadingLocation | null>>();
  const finish = (work: string) => {
    if (!finishes.has(work)) finishes.set(work, traversal.last(work));
    return finishes.get(work)!;
  };
  const releases = new Map<string, { resource: string; revision: string }>();
  for await (const batch of traversal.works()) {
    const works = batch.map(meta => meta.work), structures = batch.flatMap(meta => meta.structure ? [meta.structure] : []);
    if (deps.readingPositions && structures.length) {
      let after: string | undefined;
      do {
        const progress = await deps.readingPositions.completedPage(principal, structures, after);
        await traversal.recordsFor(progress.items);
        for (const occurrence of progress.items) consider(await traversal.location(occurrence));
        after = progress.next ?? undefined;
      } while (after);
    }
    if (deps.seriesSessions) {
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= READING_POSITION_COST.sessionPages) throw new WorkReadUnavailable('Reader history exceeds its cost');
        const attempts = await deps.seriesSessions.batch({ principal, agent: options.actingSubject }, works, [], session.position, cursor);
        for (const attempt of attempts.items) if (attempt.state === 'finished') {
          const occurrences = attempt.selections.flatMap(selected => selected.target.base === 'occurrence' ? [selected.target] : []);
          for (let at = 0; at < occurrences.length; at += READING_CHOOSER_COST.workBatch) {
            const pins = occurrences.slice(at, at + READING_CHOOSER_COST.workBatch);
            await traversal.recordsFor(pins.map(pin => pin.resource));
            for (const pin of pins) {
              const location = await traversal.location(pin.resource);
              if (location?.item.revision === pin.revision) consider(location);
            }
          }
          for (const selected of attempt.selections) {
            const target = selected.target;
            if (target.base === 'work') consider(await finish(target.resource));
            else if (target.base === 'realization' && target.work) consider(await finish(target.work));
            else if (target.base === 'release' && target.revision) {
              releases.set(`${target.resource}|${target.revision}`, { resource: target.resource, revision: target.revision });
            }
          }
        }
        if (!attempts.next) break;
        cursor = attempts.next;
      }
    }
    if (deps.readingPositions) {
      for (const work of await deps.readingPositions.finishedWorks(options.actingSubject, works)) consider(await finish(work));
    }
  }
  if (releases.size > READING_POSITION_COST.releasePins) throw new WorkReadUnavailable('Reader release pins exceed their cost');
  const releasePins = [...releases.values()];
  for (let at = 0; at < releasePins.length; at += READING_CHOOSER_COST.workBatch) {
    const batch = releasePins.slice(at, at + READING_CHOOSER_COST.workBatch);
    const rows = await session.query(`SELECT ?resource ?revision ?state WHERE {
      VALUES (?resource ?revision) { ${batch.map(pin => `(${iri(pin.resource)} ${iri(pin.revision)})`).join(' ')} }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ReleaseRevision ; rv:component ?resource ; rv:releaseState ?state }
    } LIMIT ${batch.length + 1}`, batch.length);
    if (rows.length !== batch.length) throw new WorkReadUnavailable('Pinned release coverage is unavailable');
    for (const row of rows) {
      const release = parseStoredRelease(row.state!.value);
      if (release.id !== row.resource?.value) throw new WorkReadUnavailable('Pinned release identity differs');
      if (release.profile === 'release-v2') for (const entry of release.coverage) {
        if (entry.completeness === 'complete') {
          const covered = release.resolvedCoverage.find(pin => pin.realization === entry.realization);
          if (covered) consider(await finish(covered.work));
        }
      }
    }
  }
  // Assignment through consider is synchronous, but TypeScript cannot infer it.
  const selected = furthest as ReadingLocation | null;
  if (!selected) return 'start';
  await traversal.requireLocation(selected);
  return selected.item.occurrence;
}
