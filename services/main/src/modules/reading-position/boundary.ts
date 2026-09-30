import { GRAPHS, RV, iri } from '../work/activate.ts';
import { NATIVE_ID } from '../structure/graph.ts';
import { targetSummaryReader } from '../target/resolve.ts';
import { readResourceSummaries } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { parseStoredRelease } from '../release/schema.ts';
import { WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { REVELATION_COST, type Revelation } from './store.ts';

/** Linear in the selected composition, never the wiki/catalogue inventory.
 * A 1000-chapter, two-volume composition uses two graph batches (one per Work
 * level), not a query per chapter. Cycles, ambiguity and overflow fail closed. */
export const READING_POSITION_COST = { occurrences: 10_000, workDepth: 16, workBatch: 50,
  queryBytes: 4 * 1024 * 1024, chooserPage: 100, sessionPages: 32, releasePins: 4096 } as const;
export interface ReadingOccurrence {
  occurrence: string; work: string; structure: string; revision: string;
  parent: string; segmentKey: string; orderKey: string; role: 'part' | 'chapter' | 'group'; target: string | null;
}
export interface ReadingComposition { work: string; occurrences: ReadingOccurrence[]; structures: string[]; works: string[] }

function disclosureSummaries(session: WorkReadSession, resources: string[]) {
  const reader = { ...targetSummaryReader(session) };
  // Boundary infrastructure reads owner disclosure, without invoking the policy
  // whose position it is resolving. No names from this batch are delivered.
  delete reader.visibleRecords;
  return readResourceSummaries(session.deps.environment, session.deps.media?.store, reader,
    { resources, context: DEFAULT_MEDIA_CONTEXT, language: null });
}

export async function readReadingComposition(session: WorkReadSession, work: string): Promise<ReadingComposition> {
  const root = await disclosureSummaries(session, [work]);
  if (root.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) throw new WorkReadMoved('Reading composition changed');
  if (root.summaries[0]?.status !== 'available' || root.summaries[0].type !== 'work') throw new WorkReadMissing('Work is unavailable');
  const byWork = new Map<string, ReadingOccurrence[]>();
  const identities = new Set<string>();
  const structures = new Set<string>();
  let pending = [work], size = 0;
  for (let depth = 0; pending.length; depth++) {
    if (depth >= READING_POSITION_COST.workDepth) throw new WorkReadUnavailable('Reading composition depth exceeds its cost');
    const next = new Set<string>();
    for (let at = 0; at < pending.length; at += READING_POSITION_COST.workBatch) {
      const works = pending.slice(at, at + READING_POSITION_COST.workBatch);
      const result = await session.deps.environment.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        SELECT ?work ?structure ?revision ?occurrence ?parent ?segmentKey ?orderKey ?role ?target WHERE {
        VALUES ?work { ${works.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} {
          ?work rv:mainVersion ?main .
          ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile ?profile ;
            rv:structureHead ?revision ; rv:selectedGeneration ?generation .
          FILTER(?profile IN (rv:WorkComposition, rv:BookComposition))
          ?generation rv:generationState rv:Active .
          ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?occurrence ;
            rv:orderSegment ?segment ; rv:orderKey ?orderKey ; rv:occurrenceRole ?role .
          FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
          ?segment rv:parent ?parent ; rv:segmentKey ?segmentKey .
          OPTIONAL { ?placement schema:item ?target }
        } } LIMIT ${READING_POSITION_COST.occurrences + 1}`, READING_POSITION_COST.queryBytes);
      const rows = result.results?.bindings ?? [];
      size += rows.length;
      if (size > READING_POSITION_COST.occurrences) throw new WorkReadUnavailable('Reading composition exceeds its cost');
      for (const row of rows) {
        const value = (key: string) => row[key]?.value;
        const role = value('role') === `${RV}PartRole` ? 'part' : value('role') === `${RV}ChapterRole` ? 'chapter'
          : value('role') === `${RV}GroupRole` ? 'group' : null;
        if (!role || ['work', 'structure', 'revision', 'occurrence', 'parent', 'segmentKey', 'orderKey'].some(key => !value(key))) {
          throw new WorkReadUnavailable('Reading composition is incomplete');
        }
        const item: ReadingOccurrence = { work: value('work')!, structure: value('structure')!, revision: value('revision')!,
          occurrence: value('occurrence')!, parent: value('parent')!, segmentKey: value('segmentKey')!, orderKey: value('orderKey')!,
          role, target: value('target') ?? null };
        const inventory = byWork.get(item.work) ?? [];
        const identity = `${item.work}|${item.occurrence}`;
        if (identities.has(identity)
          || inventory[0] && (inventory[0].structure !== item.structure || inventory[0].revision !== item.revision)) {
          throw new WorkReadUnavailable('Reading composition is ambiguous');
        }
        identities.add(identity);
        inventory.push(item);
        byWork.set(item.work, inventory);
        structures.add(item.structure);
        if (role === 'part' && item.target && !byWork.has(item.target)) next.add(item.target);
      }
      // Remember leaves as well as composed Works.
      for (const resource of works) if (!byWork.has(resource)) byWork.set(resource, []);
    }
    pending = [...next].filter(resource => !byWork.has(resource));
  }
  const ordered: ReadingOccurrence[] = [];
  const walk = (resource: string, ancestors: Set<string>) => {
    if (ancestors.has(resource)) throw new WorkReadUnavailable('Reading composition is cyclic');
    const path = new Set([...ancestors, resource]);
    const items = byWork.get(resource) ?? [];
    const children = new Map<string, ReadingOccurrence[]>();
    for (const item of items) {
      const bucket = children.get(item.parent) ?? [];
      bucket.push(item);
      children.set(item.parent, bucket);
    }
    const visited = new Set<string>();
    const visit = (parent: string) => {
      const siblings = (children.get(parent) ?? []).sort((a, b) => {
        const ak = `${a.segmentKey}\0${a.orderKey}`, bk = `${b.segmentKey}\0${b.orderKey}`;
        return ak < bk ? -1 : ak > bk ? 1 : 0;
      });
      for (const item of siblings) {
        if (visited.has(item.occurrence)) throw new WorkReadUnavailable('Reading placement is cyclic');
        visited.add(item.occurrence);
        if (item.role === 'group') visit(item.occurrence);
        else {
          ordered.push(item);
          if (item.role === 'part' && item.target) walk(item.target, path);
        }
      }
    };
    if (items[0]) visit(items[0].structure);
    if (visited.size !== items.length) throw new WorkReadUnavailable('Reading composition has detached placements');
  };
  walk(work, new Set());
  if (new Set(ordered.map(item => item.occurrence)).size !== ordered.length) {
    throw new WorkReadUnavailable('An occurrence has multiple uses in this continuity');
  }
  if (ordered.length > READING_POSITION_COST.occurrences) throw new WorkReadUnavailable('Reading traversal exceeds its cost');
  return { work, occurrences: ordered, structures: [...structures], works: [...byWork.keys()] };
}

export function prefixVisible(composition: ReadingComposition, position: string | null, revelation: Revelation): boolean {
  if (!position || composition.work !== revelation.continuityWork) return false;
  const boundary = composition.occurrences.findIndex(item => item.occurrence === position);
  const revealed = composition.occurrences.findIndex(item => item.occurrence === revelation.occurrence);
  return revealed >= 0 && boundary >= revealed;
}

export class ReadingBoundary {
  private readonly records = new Map<string, Revelation[]>();
  private readonly compositions = new Map<string, Promise<ReadingComposition>>();
  private readonly positions = new Map<string, Promise<string | null>>();
  private generation: Promise<string> | null = null;
  private reader: Promise<boolean> | null = null;
  private snapshot: Promise<string | null> | null = null;
  readonly selection: string;
  constructor(readonly session: WorkReadSession, selection?: string) {
    this.selection = selection ?? new URL(session.request.url).searchParams.get('position') ?? 'mine';
    if (!['mine', 'all', 'start'].includes(this.selection) && !NATIVE_ID.test(this.selection)) {
      throw new WorkReadInvalid('Position must be an occurrence IRI or all');
    }
  }
  composition(work: string) {
    if (!this.compositions.has(work)) this.compositions.set(work, readReadingComposition(this.session, work));
    return this.compositions.get(work)!;
  }
  async position(work: string): Promise<string | null> {
    if (!this.positions.has(work)) this.positions.set(work, this.resolve(work));
    return this.positions.get(work)!;
  }
  private async resolve(work: string) {
    if (this.selection === 'start') return null;
    if (this.selection === 'mine' && !await this.ownReader()) return null;
    const composition = await this.composition(work);
    if (this.selection !== 'mine' && this.selection !== 'all') {
      return composition.occurrences.some(item => item.occurrence === this.selection) ? this.selection : null;
    }
    if (this.selection === 'all') return composition.occurrences.at(-1)?.occurrence ?? null;
    const { principal, deps, options } = this.session;
    if (!principal) return null;
    if (!principal || !options.actingSubject) return null;
    const completed = await deps.readingPositions?.completed(principal, composition.structures) ?? new Set<string>();
    const finishWork = (resource: string) => {
      const descendants = new Set([resource]);
      for (const item of composition.occurrences) {
        if (item.role === 'part' && item.target && descendants.has(item.work)) descendants.add(item.target);
        if (descendants.has(item.work) || item.target === resource) completed.add(item.occurrence);
      }
    };
    const releases = new Map<string, { resource: string; revision: string }>();
    if (deps.seriesSessions) {
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= READING_POSITION_COST.sessionPages) throw new WorkReadUnavailable('Reader history exceeds its cost');
        const attempts = await deps.seriesSessions.batch({ principal, agent: options.actingSubject }, composition.works, [], this.session.position, cursor);
        for (const attempt of attempts.items) if (attempt.state === 'finished') for (const selected of attempt.selections) {
          const target = selected.target;
          if (target.base === 'occurrence') {
            // A reordered revision needs correspondence; today's ordinal does not reinterpret its pin.
            if (composition.occurrences.some(item => item.occurrence === target.resource && item.revision === target.revision)) completed.add(target.resource);
          } else if (target.base === 'work') {
            finishWork(target.resource);
          } else if (target.base === 'realization' && target.work) {
            finishWork(target.work);
          } else if (target.base === 'release' && target.revision) {
            releases.set(`${target.resource}|${target.revision}`, { resource: target.resource, revision: target.revision });
          }
        }
        if (!attempts.next) break;
        cursor = attempts.next;
      }
    }
    if (releases.size > READING_POSITION_COST.releasePins) throw new WorkReadUnavailable('Reader release pins exceed their cost');
    const releasePins = [...releases.values()];
    for (let at = 0; at < releasePins.length; at += REVELATION_COST.batch) {
      const batch = releasePins.slice(at, at + REVELATION_COST.batch);
      const rows = await this.session.query(`SELECT ?resource ?revision ?state WHERE {
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
            if (covered) finishWork(covered.work);
          }
        }
      }
    }
    if (deps.readingPositions) for (let at = 0; at < composition.works.length; at += REVELATION_COST.batch) {
      const finished = await deps.readingPositions.finishedWorks(options.actingSubject, composition.works.slice(at, at + REVELATION_COST.batch));
      for (const resource of finished) finishWork(resource);
    }
    return [...composition.occurrences].reverse().find(item => completed.has(item.occurrence))?.occurrence ?? null;
  }
  async binding() {
    const store = this.session.deps.readingPositions;
    this.generation ??= store ? this.currentGeneration() : Promise.resolve('unconfigured');
    this.snapshot ??= this.privateSnapshot();
    return [this.selection, await this.generation, await this.snapshot];
  }
  private currentGeneration() {
    return this.session.deps.readingPositions!.generation();
  }
  private currentReader() {
    const { principal, options, deps } = this.session;
    return principal?.emailVerified && options.actingSubject
      ? Promise.resolve(deps.access.canReadAsBaselineMember?.(principal, options.actingSubject) ?? false)
      : Promise.resolve(false);
  }
  private ownReader() {
    this.reader ??= this.currentReader();
    return this.reader;
  }
  private async privateSnapshot() {
    if (this.selection !== 'mine' || !this.session.deps.readingPositions || !await this.ownReader()) return null;
    return this.session.deps.readingPositions.privateSnapshot(this.session.principal!, this.session.options.actingSubject!);
  }
  async visible(records: readonly string[]): Promise<Set<string>> {
    const store = this.session.deps.readingPositions;
    await this.binding();
    const missing = [...new Set(records)].filter(record => !this.records.has(record));
    for (let at = 0; at < missing.length; at += REVELATION_COST.batch) {
      const batch = missing.slice(at, at + REVELATION_COST.batch);
      const found = await store?.lookup(batch) ?? new Map<string, Revelation[]>();
      for (const record of batch) this.records.set(record, found.get(record) ?? []);
    }
    const visible = new Set<string>();
    for (const record of records) {
      const rows = this.records.get(record)!;
      if (!rows.length || this.selection === 'all') { visible.add(record); continue; }
      if (this.selection === 'start' || this.selection === 'mine' && !this.session.principal) continue;
      for (const row of rows) {
        try {
          const position = await this.position(row.continuityWork);
          if (position && prefixVisible(await this.composition(row.continuityWork), position, row)) {
            visible.add(record); break;
          }
        } catch (error) {
          // A record with an unreadable, foreign or unavailable continuity is
          // withheld alone. It cannot make an otherwise readable page fail.
          if (!(error instanceof WorkReadMissing || error instanceof WorkReadInvalid || error instanceof WorkReadUnavailable)) throw error;
        }
      }
    }
    await this.fence(false);
    return visible;
  }
  async require(resource: string) {
    if (!(await this.visible([resource])).has(resource)) throw new WorkReadMissing('Resource is unavailable');
  }
  async fence(privateState = true) {
    if (this.session.deps.readingPositions && this.generation
      && await this.currentGeneration() !== await this.generation) {
      throw new WorkReadMoved('Wiki revelations changed during the read');
    }
    if (privateState && this.snapshot && await this.snapshot !== null
      && (!await this.currentReader() || await this.privateSnapshot() !== await this.snapshot)) {
      throw new WorkReadMoved('Reader position changed during the read');
    }
  }
  async chooser(work: string, limit: number, after?: string) {
    const composition = await this.composition(work);
    const disclosed = new Set<string>();
    for (let at = 0; at < composition.works.length; at += 24) {
      const targets = await disclosureSummaries(this.session, composition.works.slice(at, at + 24));
      if (targets.generation.graph !== `${this.session.position.dataEpoch}:${this.session.position.sequence}`) {
        throw new WorkReadMoved('Reading composition changed');
      }
      targets.summaries.forEach(target => { if (target.status === 'available') disclosed.add(target.reference); });
    }
    const items = composition.occurrences.filter(item => disclosed.has(item.work)
      && !(item.role === 'part' && item.target && !disclosed.has(item.target)));
    const offset = after ? items.findIndex(item => item.occurrence === after) + 1 : 0;
    if (after && !offset) throw new WorkReadInvalid('Reading position cursor is invalid');
    const page = items.slice(offset, offset + limit);
    const resolved = this.selection === 'all' ? 'all' : await this.position(work) ?? 'start';
    if (resolved !== 'all' && resolved !== 'start' && !items.some(item => item.occurrence === resolved)) {
      throw new WorkReadMissing('Reading position is unavailable');
    }
    await this.fence();
    return { work, resolved, items: page, next: offset + limit < items.length ? page.at(-1)!.occurrence : null };
  }
}

const boundaries = new WeakMap<WorkReadSession, ReadingBoundary>();
export function readingBoundary(session: WorkReadSession): ReadingBoundary {
  let boundary = boundaries.get(session);
  if (!boundary) { boundary = new ReadingBoundary(session); boundaries.set(session, boundary); }
  return boundary;
}
