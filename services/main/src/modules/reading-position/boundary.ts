import { GRAPHS, RV, iri } from '../work/activate.ts';
import { NATIVE_ID } from '../structure/graph.ts';
import { targetSummaryReader } from '../target/resolve.ts';
import { readResourceSummaries } from '../media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import type { Revelation } from './store.ts';
import { READING_POSITION_COST, REVELATION_COST } from './contract.ts';
import { compareReadingLocations, ReadingPositionTraversal } from './traversal.ts';
import { chooserPosition } from './chooser-position.ts';
export { READING_POSITION_COST } from './contract.ts';

/** Linear in the selected composition, never the wiki/catalogue inventory.
 * A 1000-chapter, two-volume composition uses two graph batches (one per Work
 * level), not a query per chapter. Cycles, ambiguity and overflow fail closed. */
export interface ReadingOccurrence {
  occurrence: string; work: string; structure: string; revision: string;
  parent: string; segmentKey: string; orderKey: string; role: 'part' | 'chapter' | 'group'; target: string | null;
  labels?: Array<{ value: string; language: string }>;
  /** One-based among siblings, as in the composition owner's occurrence context. */
  ordinal?: number;
  displayLabel?: string;
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

/** Explicit diagnostic inventory for conformance fixtures. Reader disclosure
 * and chooser requests use exact locations, never this whole-composition read. */
export async function readReadingComposition(session: WorkReadSession, work: string): Promise<ReadingComposition> {
  const root = await disclosureSummaries(session, [work]);
  if (root.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) throw new WorkReadMoved('Reading composition changed');
  if (root.summaries[0]?.status !== 'available' || root.summaries[0].type !== 'work') throw new WorkReadMissing('Work is unavailable');
  const byWork = new Map<string, ReadingOccurrence[]>();
  const identities = new Map<string, { placement: string; item: ReadingOccurrence }>();
  const structures = new Set<string>();
  let pending = [work], size = 0;
  for (let depth = 0; pending.length; depth++) {
    if (depth >= READING_POSITION_COST.workDepth) throw new WorkReadUnavailable('Reading composition depth exceeds its cost');
    const next = new Set<string>();
    for (let at = 0; at < pending.length; at += READING_POSITION_COST.workBatch) {
      const works = pending.slice(at, at + READING_POSITION_COST.workBatch);
      const result = await session.deps.environment.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        SELECT ?work ?structure ?revision ?placement ?occurrence ?parent ?segmentKey ?orderKey ?role ?target ?label ?displayLabel WHERE {
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
          OPTIONAL { ?placement rv:occurrenceLabel ?label }
          OPTIONAL { ?placement rv:qualifier/rv:displayLabel ?displayLabel }
        } } LIMIT ${READING_POSITION_COST.occurrences * READING_POSITION_COST.labels + 1}`, READING_POSITION_COST.queryBytes);
      const rows = result.results?.bindings ?? [];
      for (const row of rows) {
        const value = (key: string) => row[key]?.value;
        const role = value('role') === `${RV}PartRole` ? 'part' : value('role') === `${RV}ChapterRole` ? 'chapter'
          : value('role') === `${RV}GroupRole` ? 'group' : null;
        if (!role || ['work', 'structure', 'revision', 'placement', 'occurrence', 'parent', 'segmentKey', 'orderKey'].some(key => !value(key))) {
          throw new WorkReadUnavailable('Reading composition is incomplete');
        }
        const item: ReadingOccurrence = { work: value('work')!, structure: value('structure')!, revision: value('revision')!,
          occurrence: value('occurrence')!, parent: value('parent')!, segmentKey: value('segmentKey')!, orderKey: value('orderKey')!,
          role, target: value('target') ?? null,
          ...(value('displayLabel') ? { displayLabel: value('displayLabel')! } : {}) };
        const inventory = byWork.get(item.work) ?? [];
        const identity = `${item.work}|${item.occurrence}`;
        const previous = identities.get(identity);
        if (previous && (previous.placement !== value('placement')
            || JSON.stringify({ ...previous.item, labels: undefined }) !== JSON.stringify(item))
          || inventory[0] && (inventory[0].structure !== item.structure || inventory[0].revision !== item.revision)) {
          throw new WorkReadUnavailable('Reading composition is ambiguous');
        }
        const selected = previous?.item ?? item;
        if (row.label) {
          const language = row.label['xml:lang'];
          if (!language) throw new WorkReadUnavailable('Reading label language is unavailable');
          selected.labels ??= [];
          if (!selected.labels.some(label => label.value === row.label!.value && label.language === language)) {
            selected.labels.push({ value: row.label.value, language });
          }
          if (selected.labels.length > READING_POSITION_COST.labels) throw new WorkReadUnavailable('Reading labels exceed their cost');
        }
        if (previous) continue;
        if (++size > READING_POSITION_COST.occurrences) throw new WorkReadUnavailable('Reading composition exceeds its cost');
        identities.set(identity, { placement: value('placement')!, item });
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
      for (const [index, item] of siblings.entries()) {
        item.ordinal = index + 1;
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
  private readonly required = new Set<string>();
  private readonly positions = new Map<string, Promise<string | null>>();
  private readonly traversals = new Map<string, ReadingPositionTraversal>();
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
  async position(work: string): Promise<string | null> {
    if (!this.positions.has(work)) this.positions.set(work, this.resolve(work));
    return this.positions.get(work)!;
  }
  /** Exact ancestor paths replace the old composition-wide wiki scan. */
  traversalFor(work: string): ReadingPositionTraversal {
    if (!this.traversals.has(work)) this.traversals.set(work, new ReadingPositionTraversal(
      this.session, work, resources => this.disclosed(resources)));
    return this.traversals.get(work)!;
  }
  private async disclosed(resources: string[]) {
    const available = new Set<string>();
    for (let at = 0; at < resources.length; at += 24) {
      const targets = await disclosureSummaries(this.session, resources.slice(at, at + 24));
      if (targets.generation.graph !== `${this.session.position.dataEpoch}:${this.session.position.sequence}`) {
        throw new WorkReadMoved('Reading composition changed');
      }
      for (const target of targets.summaries) if (target.status === 'available') available.add(target.reference);
    }
    return available;
  }
  private async resolve(work: string) {
    if (this.selection === 'start' || this.selection === 'mine' && !await this.ownReader()) return null;
    const traversal = this.traversalFor(work);
    await traversal.requireWork(work);
    if (this.selection === 'all') return (await traversal.last(work))?.item.occurrence ?? null;
    const resolved = await chooserPosition(this.session, traversal, this.selection,
      this.selection === 'mine' && await this.ownReader());
    return resolved === 'start' ? null : resolved;
  }
  private async prefixVisible(work: string, position: string, occurrence: string): Promise<boolean> {
    const traversal = this.traversalFor(work);
    await traversal.recordsFor([position, occurrence]);
    const boundary = await traversal.location(position), revealed = await traversal.location(occurrence);
    if (!boundary || !revealed) return false;
    await traversal.requireLocation(revealed);
    return compareReadingLocations(boundary, revealed) >= 0;
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
      for (const record of await store?.required(batch) ?? []) this.required.add(record);
      for (const record of batch) this.records.set(record, found.get(record) ?? []);
    }
    const visible = new Set<string>();
    for (const record of records) {
      const rows = this.records.get(record)!;
      if (!rows.length && this.required.has(record)) continue;
      if (!rows.length || this.selection === 'all') { visible.add(record); continue; }
      if (this.selection === 'start' || this.selection === 'mine' && !this.session.principal) continue;
      for (const row of rows) {
        try {
          const position = await this.position(row.continuityWork);
          if (position && await this.prefixVisible(row.continuityWork, position, row.occurrence)) {
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
  requiresPosition(record: string): boolean { return this.required.has(record); }
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
  async chooser(work: string, limit: number, after?: string, q?: string) {
    const traversal = this.traversalFor(work);
    const page = await traversal.page({ limit, after, q });
    const resolved = await chooserPosition(this.session, traversal, this.selection,
      this.selection === 'mine' && await this.ownReader());
    await this.fence();
    return { work, resolved, ...page };
  }
}

const boundaries = new WeakMap<WorkReadSession, ReadingBoundary>();
export function readingBoundary(session: WorkReadSession): ReadingBoundary {
  let boundary = boundaries.get(session);
  if (!boundary) { boundary = new ReadingBoundary(session); boundaries.set(session, boundary); }
  return boundary;
}
