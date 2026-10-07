import { GRAPHS, iri, lit } from '../work/activate.ts';
import { NATIVE_ID } from '../structure/graph.ts';
import { STRUCTURE_LIMITS } from '../structure/format.ts';
import { WorkReadInvalid, WorkReadMissing, WorkReadUnavailable, type WorkReadSession, type ReadRow } from '../work/read-session.ts';
import type { ReadingOccurrence } from './boundary.ts';
import { READING_POSITION_COST } from './contract.ts';
import { normalizePositionQuery } from './store.ts';
import { ReadingOrderIndex, readingOrderRead } from './immutable-order.ts';
import { searchOccurrenceLabels } from './label-index.ts';
import { readingWorkScope } from './work-scope.ts';
import { ReadingSeekUnavailable } from './errors.ts';

/** Bounded results and live traversal state, independent of chapter inventory.
 * Each seek returns <=101 placements, with <=16 labels each. Configured stores
 * use immutable counted trees for ranges, numeric rank and ordinals. Graph-only
 * adapters retain the prior projection path. Configured search seeks the native
 * Lucene text index; chapter labels are never scanned.
 * Traversal retains only the ancestor stack and the current seek's candidates.
 * The surrounding Work read bounds graph calls, bytes and elapsed time. */
export const READING_CHOOSER_COST = { probe: 101, contextDepth: 16, workBatch: 50 } as const;
const edge = 'rv:mainVersion/^rv:structureOf/rv:selectedGeneration/^rv:generation/rv:composedWork';
const current = iri(GRAPHS.current);
export interface ReadingWork { work: string; structure: string | null; revision: string | null; generation: string | null }
export interface ReadingFrame { work: string; parent: string; after?: ReadingOccurrence }
export interface ReadingLocation { item: ReadingOccurrence; frames: ReadingFrame[] }
interface Candidate { item: ReadingOccurrence; matches: boolean }
type Disclose = (resources: string[]) => Promise<ReadonlySet<string>>;

function tuple(item: ReadingOccurrence) { return `${item.segmentKey}\0${item.orderKey}`; }
export function compareReadingLocations(a: ReadingLocation, b: ReadingLocation): number {
  const left = a.frames.map(frame => tuple(frame.after!)), right = b.frames.map(frame => tuple(frame.after!));
  for (let at = 0; at < Math.min(left.length, right.length); at++) {
    if (left[at] !== right[at]) return left[at]! < right[at]! ? -1 : 1;
  }
  return left.length - right.length;
}

function placementPattern(generation: string, parent?: string) {
  return `?placement a rv:OccurrencePlacement ; rv:generation ${generation} ;
    rv:occurrence ?occurrence ; rv:orderSegment ?segment ; rv:orderKey ?orderKey ; rv:occurrenceRole ?role .
    ?segment rv:parent ${parent ? iri(parent) : '?parent'} ; rv:segmentKey ?segmentKey .
    FILTER NOT EXISTS { ?placement rv:removedBy ?removed }`;
}
function itemOf(row: ReadRow, meta?: ReadingWork): ReadingOccurrence {
  const value = (key: string) => row[key]?.value;
  const role = value('role')?.split('/').at(-1);
  if (!['ChapterRole', 'PartRole', 'GroupRole'].includes(role ?? '')
    || ['occurrence', 'parent', 'segmentKey', 'orderKey'].some(key => !value(key))
    || !meta && ['work', 'structure', 'revision'].some(key => !value(key))) {
    throw new WorkReadUnavailable('Reading placement is incomplete');
  }
  return { work: meta?.work ?? value('work')!, structure: meta?.structure ?? value('structure')!,
    revision: meta?.revision ?? value('revision')!, occurrence: value('occurrence')!, parent: value('parent')!,
    segmentKey: value('segmentKey')!, orderKey: value('orderKey')!,
    role: role === 'ChapterRole' ? 'chapter' : role === 'PartRole' ? 'part' : 'group',
    target: value('target') ?? null, ...(value('displayLabel') ? { displayLabel: value('displayLabel')! } : {}) };
}

/** Current selected generations own ordering and search. No local catalogue,
 * full-composition cache, OFFSET continuation or inventory-sized response. */
export class ReadingPositionTraversal {
  private readonly metadata = new Map<string, Promise<ReadingWork>>();
  private readonly records = new Map<string, ReadingOccurrence | null>();
  private readonly paths = new Map<string, Promise<ReadingFrame[] | null>>();
  private readonly order: ReadingOrderIndex | null;
  private labelsIndexing = false;
  constructor(readonly session: WorkReadSession, readonly root: string, private readonly disclose: Disclose) {
    this.order = session.deps?.structureObjects ? new ReadingOrderIndex(session, session.deps.structureObjects) : null;
  }

  async requireWork(work: string) {
    if (!(await this.disclose([work])).has(work)) throw new WorkReadMissing('Work is unavailable');
  }
  metadataFor(work: string): Promise<ReadingWork> {
    if (!this.metadata.has(work)) this.metadata.set(work, this.readMetadata(work));
    return this.metadata.get(work)!;
  }
  async hasNestedComposition(meta: ReadingWork): Promise<boolean> {
    const rows = await this.session.query(`# reading-position:nested-composition
      SELECT ?work WHERE { GRAPH ${current} {
        ?placement rv:generation ${iri(meta.generation!)} ; rv:composedWork ?work .
        FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
        ?work rv:mainVersion ?main .
        ?structure rv:structureOf ?main ; rv:structureProfile ?profile .
        FILTER(?profile IN (rv:WorkComposition, rv:BookComposition))
      } } LIMIT 1`, 1);
    return rows.length > 0;
  }
  private async readMetadata(work: string): Promise<ReadingWork> {
    // A PartRole can target any admitted resource. Only targets with a
    // selected supported composition descend; Episodes remain terminal.
    const rows = await this.session.query(`# reading-position:work
      SELECT ?work ?structure ?revision ?generation WHERE {
        BIND(${iri(work)} AS ?work) GRAPH ${current} {
          OPTIONAL { ${iri(work)} rv:mainVersion ?main .
            ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile ?profile ;
            rv:structureHead ?revision ; rv:selectedGeneration ?generation .
            FILTER(?profile IN (rv:WorkComposition, rv:BookComposition))
            ?generation rv:generationState rv:Active . }
        } } LIMIT 2`, 2);
    if (rows.length !== 1) throw new WorkReadUnavailable('Reading composition is ambiguous');
    return this.workOf(rows[0]!);
  }
  private workOf(row: ReadRow): ReadingWork {
    const meta = { work: row.work!.value, structure: row.structure?.value ?? null,
      revision: row.revision?.value ?? null, generation: row.generation?.value ?? null };
    if (meta.structure && (!meta.revision || !meta.generation)) throw new WorkReadUnavailable('Reading composition is incomplete');
    return meta;
  }

  /** Seek scoped owner metadata for reader state; chapter placements are never
   * selected. This permits a long Book without materializing its chapters. */
  async *works(): AsyncGenerator<ReadingWork[]> {
    let after: string | undefined;
    for (;;) {
      const rows = await this.session.query(`# reading-position:works
        SELECT DISTINCT ?work ?structure ?revision ?generation WHERE { GRAPH ${current} {
          { ${readingWorkScope(this.root)} } ?work rv:mainVersion ?main .
          ${after ? `FILTER(STR(?work) > ${lit(after)})` : ''}
          OPTIONAL { ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile ?profile ;
            rv:structureHead ?revision ; rv:selectedGeneration ?generation .
            FILTER(?profile IN (rv:WorkComposition, rv:BookComposition))
            ?generation rv:generationState rv:Active . }
        } } ORDER BY STR(?work) LIMIT ${READING_CHOOSER_COST.workBatch}`, READING_CHOOSER_COST.workBatch);
      if (!rows.length) return;
      const batch = rows.map(row => this.workOf(row));
      if (new Set(batch.map(meta => meta.work)).size !== batch.length) throw new WorkReadUnavailable('Reading composition is ambiguous');
      yield batch;
      if (batch.length < READING_CHOOSER_COST.workBatch) return;
      after = batch.at(-1)!.work;
    }
  }

  /** Numeric chapter selection requires the counted immutable index. */
  private async numbered(meta: ReadingWork, parent: string, q: string): Promise<string | null> {
    if (!/^[1-9]\d*$/.test(q) || !Number.isSafeInteger(Number(q)) || Number(q) > STRUCTURE_LIMITS.maxPlacements) return null;
    if (!this.order) throw new ReadingSeekUnavailable('An indexed reading-position seek is unavailable');
    return readingOrderRead(() => this.order!.numbered(meta, parent, Number(q)));
  }

  private async range(meta: ReadingWork, parent: string, after: ReadingOccurrence | undefined,
    q: string, reverse = false, probe: number = READING_CHOOSER_COST.probe): Promise<Candidate[]> {
    if (!meta.structure) return [];
    if (!q && this.order) {
      const items = await readingOrderRead(() => this.order!.range(meta, parent, after, reverse, probe));
      return items.map(item => ({ item, matches: true }));
    }
    if (/^[+-]?\d+(?:[./]\d+)?$/.test(q) && this.order
      && (await readingOrderRead(() => this.order!.manifest(meta))).profile === 'work-composition') {
      throw new ReadingSeekUnavailable('Episode-number seek is unavailable until its indexed Structure read is ready');
    }
    const numbered = q ? await this.numbered(meta, parent, q) : null;
    if (q && this.order) {
      const page = await readingOrderRead(() => searchOccurrenceLabels(this.session,
        this.order!, meta, parent, q, after, probe, numbered));
      this.labelsIndexing ||= !page.current;
      return page.candidates;
    }
    if (q) throw new WorkReadUnavailable('Reading label search requires the configured order store');
    const matches = 'true';
    const op = reverse ? '<' : '>';
    const rows = await this.session.query(`# reading-position:range
      SELECT ?placement ?occurrence ?parent ?segmentKey ?orderKey ?role ?target ?label ?displayLabel ?matches WHERE {
        { SELECT ?placement ?occurrence ?segmentKey ?orderKey ?role ?matches WHERE { GRAPH ${current} {
          ${placementPattern(iri(meta.generation!), parent)}
          ${after ? `FILTER(?segmentKey ${op} ${lit(after.segmentKey)} || (?segmentKey = ${lit(after.segmentKey)}
            && ?orderKey ${op} ${lit(after.orderKey)}))` : ''}
          BIND(${matches} AS ?matches)
          FILTER(?matches || ?role IN (rv:GroupRole, rv:PartRole))
        } } ORDER BY ${reverse ? 'DESC(?segmentKey) DESC(?orderKey) DESC(?occurrence)' : '?segmentKey ?orderKey ?occurrence'} LIMIT ${probe} }
        BIND(${iri(parent)} AS ?parent)
        GRAPH ${current} {
          OPTIONAL { ?placement schema:item ?target }
          OPTIONAL { ?placement rv:occurrenceLabel ?label }
          OPTIONAL { ?placement rv:qualifier/rv:displayLabel ?displayLabel }
        }
      } ORDER BY ${reverse ? 'DESC(?segmentKey) DESC(?orderKey) DESC(?occurrence)' : '?segmentKey ?orderKey ?occurrence'}`,
    probe * READING_POSITION_COST.labels);
    const candidates = new Map<string, Candidate & { placement: string }>();
    for (const row of rows) {
      const item = itemOf(row, meta), previous = candidates.get(item.occurrence);
      if (previous && (previous.placement !== row.placement?.value
        || JSON.stringify({ ...previous.item, labels: undefined }) !== JSON.stringify(item))) {
        throw new WorkReadUnavailable('Reading placement is ambiguous');
      }
      const selected = previous ?? { item, placement: row.placement!.value, matches: row.matches?.value === 'true' };
      if (row.label) {
        if (!row.label['xml:lang']) throw new WorkReadUnavailable('Reading label language is unavailable');
        selected.item.labels ??= [];
        if (!selected.item.labels.some(label => label.value === row.label!.value && label.language === row.label!['xml:lang'])) {
          selected.item.labels.push({ value: row.label.value, language: row.label['xml:lang'] });
        }
        if (selected.item.labels.length > READING_POSITION_COST.labels) throw new WorkReadUnavailable('Reading labels exceed their cost');
      }
      candidates.set(item.occurrence, selected);
    }
    if (candidates.size > probe) throw new WorkReadUnavailable('Reading seek exceeds its cost');
    const out = [...candidates.values()];
    await this.ordinals(meta, out.map(row => row.item));
    return out;
  }

  private async ordinals(meta: ReadingWork, items: ReadingOccurrence[]) {
    if (!items.length) return;
    if (this.order) {
      await readingOrderRead(async () => {
        for (const item of items) item.ordinal = await this.order!.ordinal(meta, item);
      });
      return;
    }
    const values = `VALUES (?occurrence ?parent ?segmentKey ?orderKey) {
      ${items.map(item => `(${iri(item.occurrence)} ${iri(item.parent)} ${lit(item.segmentKey)} ${lit(item.orderKey)})`).join(' ')} }`;
    const segments = new Map(items.map(item => [`${item.parent}\0${item.segmentKey}`, item]));
    const segmentValues = `VALUES (?parent ?segmentKey) {
      ${[...segments.values()].map(item => `(${iri(item.parent)} ${lit(item.segmentKey)})`).join(' ')} }`;
    // These comparisons need both the VALUES row and the graph bindings.
    // A FILTER inside GRAPH cannot see the sibling VALUES group's keys:
    // https://www.w3.org/TR/sparql11-query/#scopeFilters
    const rows = await this.session.query(`# reading-position:ordinals
      SELECT ?occurrence (COALESCE(?prior, 0) + COALESCE(?local, 0) + 1 AS ?ordinal) WHERE {
        ${values}
        OPTIONAL { SELECT ?parent ?segmentKey (SUM(?count) AS ?prior) WHERE { ${segmentValues} GRAPH ${current} {
          ?before a rv:OrderSegment ; rv:generation ${iri(meta.generation!)} ; rv:parent ?parent ;
            rv:segmentKey ?key ; rv:memberCount ?count .
        } FILTER(?key < ?segmentKey) } GROUP BY ?parent ?segmentKey }
        OPTIONAL { SELECT ?occurrence (COUNT(?earlier) AS ?local) WHERE { ${values} GRAPH ${current} {
          ?segment rv:generation ${iri(meta.generation!)} ; rv:parent ?parent ; rv:segmentKey ?segmentKey .
          ?earlier a rv:OccurrencePlacement ; rv:generation ${iri(meta.generation!)} ;
            rv:orderSegment ?segment ; rv:orderKey ?key .
          FILTER NOT EXISTS { ?earlier rv:removedBy ?removed }
        } FILTER(?key < ?orderKey) } GROUP BY ?occurrence }
      }`, items.length);
    const ordinals = new Map(rows.map(row => [row.occurrence!.value, Number(row.ordinal?.value)]));
    for (const item of items) {
      const ordinal = ordinals.get(item.occurrence);
      if (!Number.isSafeInteger(ordinal) || ordinal! < 1) throw new WorkReadUnavailable('Reading ordinal is unavailable');
      item.ordinal = ordinal;
    }
  }

  async recordsFor(occurrences: readonly string[]): Promise<ReadingOccurrence[]> {
    if (occurrences.length > READING_CHOOSER_COST.workBatch) throw new WorkReadInvalid('Reading lookup batch exceeds its cost');
    const wanted = occurrences.filter(record => !this.records.has(record));
    if (wanted.length) {
      const rows = await this.session.query(`# reading-position:records
        SELECT ?work ?structure ?revision ?occurrence ?parent ?segmentKey ?orderKey ?role ?target WHERE {
          GRAPH ${current} { VALUES ?occurrence { ${wanted.map(iri).join(' ')} }
            ?occurrence rv:structure ?structure .
            ?work rv:mainVersion ?main . ?structure a rv:Structure ; rv:structureOf ?main ;
              rv:structureProfile ?profile ; rv:structureHead ?revision ; rv:selectedGeneration ?generation .
            FILTER(?profile IN (rv:WorkComposition, rv:BookComposition)) ?generation rv:generationState rv:Active .
            ${placementPattern('?generation')}
            OPTIONAL { ?placement schema:item ?target }
          } } LIMIT ${wanted.length + 1}`, wanted.length + 1);
      const seen = new Set<string>();
      for (const row of rows) {
        const item = itemOf(row);
        if (seen.has(item.occurrence)) throw new WorkReadUnavailable('Reading placement is ambiguous');
        seen.add(item.occurrence); this.records.set(item.occurrence, item);
      }
      for (const record of wanted) if (!seen.has(record)) this.records.set(record, null);
    }
    return occurrences.flatMap(record => this.records.get(record) ? [this.records.get(record)!] : []);
  }

  private async workPath(work: string, ancestors = new Set<string>()): Promise<ReadingFrame[] | null> {
    if (work === this.root) return [];
    if (ancestors.has(work) || ancestors.size >= READING_POSITION_COST.workDepth) throw new WorkReadUnavailable('Reading composition is cyclic');
    if (!this.paths.has(work)) this.paths.set(work, (async () => {
      const rows = await this.session.query(`# reading-position:parent-work
        SELECT ?occurrence WHERE { GRAPH ${current} {
          ?owner rv:mainVersion/^rv:structureOf/rv:selectedGeneration ?generation .
          ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrence ?occurrence ;
            rv:occurrenceRole rv:PartRole ; schema:item ${iri(work)} .
          FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
          FILTER EXISTS { ?owner (^(${edge}))* ${iri(this.root)} }
        } } LIMIT 2`, 2);
      if (!rows.length) return null;
      if (rows.length !== 1) throw new WorkReadUnavailable('Reading Work has multiple uses in this continuity');
      const [part] = await this.recordsFor([rows[0]!.occurrence!.value]);
      if (!part) throw new WorkReadUnavailable('Reading Work ancestry is unavailable');
      const prefix = await this.workPath(part.work, new Set([...ancestors, work]));
      return prefix ? [...prefix, ...await this.localPath(part)] : null;
    })());
    return this.paths.get(work)!;
  }
  private async localPath(item: ReadingOccurrence): Promise<ReadingFrame[]> {
    const frames: ReadingFrame[] = [{ work: item.work, parent: item.parent, after: item }];
    const seen = new Set([item.occurrence]);
    while (frames.at(-1)!.parent !== item.structure) {
      const parent = frames.at(-1)!.parent;
      if (seen.has(parent) || frames.length >= READING_CHOOSER_COST.contextDepth) throw new WorkReadUnavailable('Reading placement is cyclic');
      seen.add(parent);
      const [group] = await this.recordsFor([parent]);
      if (!group || group.role !== 'group' || group.structure !== item.structure) throw new WorkReadUnavailable('Reading ancestry is unavailable');
      frames.push({ work: group.work, parent: group.parent, after: group });
    }
    return frames.reverse();
  }
  async location(occurrence: string): Promise<ReadingLocation | null> {
    const [item] = await this.recordsFor([occurrence]);
    if (!item || item.role === 'group') return null;
    const prefix = await this.workPath(item.work);
    return prefix ? { item, frames: [...prefix, ...await this.localPath(item)] } : null;
  }
  async requireLocation(location: ReadingLocation) {
    const works = [...new Set(location.frames.map(frame => frame.work))];
    const readable = await this.disclose(works);
    if (works.some(work => !readable.has(work))) throw new WorkReadMissing('Reading position is unavailable');
    if (location.item.role === 'part' && location.item.target && !(await this.disclose([location.item.target])).has(location.item.target)) {
      throw new WorkReadMissing('Reading position is unavailable');
    }
  }

  private async child(item: ReadingOccurrence, frames: ReadingFrame[]): Promise<ReadingFrame | null> {
    if (item.role === 'group') {
      if (frames.filter(frame => frame.work === item.work).length >= READING_CHOOSER_COST.contextDepth
        || frames.some(frame => frame.parent === item.occurrence)) throw new WorkReadUnavailable('Reading placement is cyclic');
      return { work: item.work, parent: item.occurrence };
    }
    if (item.role !== 'part' || !item.target) return null;
    if (frames.some(frame => frame.work === item.target)
      || new Set(frames.map(frame => frame.work)).size >= READING_POSITION_COST.workDepth) throw new WorkReadUnavailable('Reading composition is cyclic');
    const meta = await this.metadataFor(item.target);
    if (meta.structure && await this.workPath(item.target) === null) throw new WorkReadUnavailable('Reading Work ancestry is unavailable');
    return meta.structure ? { work: item.target, parent: meta.structure } : null;
  }

  async page(input: { limit: number; after?: string; q?: string }) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > READING_POSITION_COST.chooserPage) throw new WorkReadInvalid('Reading page size is invalid');
    const q = normalizePositionQuery(input.q);
    await this.requireWork(this.root);
    const meta = await this.metadataFor(this.root);
    const frames: ReadingFrame[] = [];
    if (input.after) {
      const previous = await this.location(input.after);
      if (!previous) throw new WorkReadInvalid('Reading position cursor is invalid');
      await this.requireLocation(previous);
      frames.push(...previous.frames);
      const child = await this.child(previous.item, frames); if (child) frames.push(child);
    } else if (meta.structure) frames.push({ work: this.root, parent: meta.structure });
    const items: ReadingOccurrence[] = [];
    while (frames.length && items.length <= input.limit) {
      this.session.checkDeadline();
      const frame = frames.at(-1)!, owner = await this.metadataFor(frame.work);
      const probe = this.order ? Math.min(READING_CHOOSER_COST.probe, input.limit - items.length + 1)
        : READING_CHOOSER_COST.probe;
      const candidates = await this.range(owner, frame.parent, frame.after, q, false, probe);
      const targets = [...new Set(candidates.flatMap(row => row.item.target && NATIVE_ID.test(row.item.target) ? [row.item.target] : []))];
      const disclosed = await this.disclose(targets);
      let descended = false;
      for (const candidate of candidates) {
        const item = candidate.item; frame.after = item;
        if (item.role === 'part' && item.target && !disclosed.has(item.target)) continue;
        const redacted = item.target && NATIVE_ID.test(item.target) && !disclosed.has(item.target);
        if (item.role !== 'group' && candidate.matches && (!redacted || !q || String(item.ordinal) === q)) {
          items.push(redacted ? { ...item, target: null, labels: [] } : item);
        }
        if (items.length > input.limit) break;
        const child = await this.child(item, frames);
        if (child) { frames.push(child); descended = true; break; }
      }
      if (!descended && candidates.length < probe) frames.pop();
    }
    const complete = items.length <= input.limit;
    items.splice(input.limit);
    const delivered: ReadingOccurrence[] = items.map(({ ordinal: _ordinal, ...item }) => item);
    return { items: delivered, next: complete ? null : items.at(-1)!.occurrence, complete: complete && !this.labelsIndexing,
      ...(q ? { search: { status: this.labelsIndexing ? 'indexing' as const : 'current' as const } } : {}) };
  }

  /** Reverse seeks locate the end of a finished Work without reading its prefix. */
  async last(work: string): Promise<ReadingLocation | null> {
    const prefix = await this.workPath(work);
    if (prefix === null) return null;
    const meta = await this.metadataFor(work);
    const frames: ReadingFrame[] = meta.structure ? [{ work, parent: meta.structure }] : [];
    while (frames.length) {
      const frame = frames.at(-1)!, owner = await this.metadataFor(frame.work);
      const [candidate] = await this.range(owner, frame.parent, frame.after, '', true, 1);
      if (!candidate) {
        frames.pop();
        const parent = frames.at(-1)?.after;
        if (parent?.role === 'part' && frame.parent === owner.structure) return this.location(parent.occurrence);
        continue;
      }
      frame.after = candidate.item;
      const child = await this.child(candidate.item, [...prefix, ...frames]);
      if (child) { frames.push(child); continue; }
      if (candidate.item.role !== 'group') return this.location(candidate.item.occurrence);
    }
    const part = prefix.at(-1)?.after;
    return part ? this.location(part.occurrence) : null;
  }
}
