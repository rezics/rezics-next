import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';
import { orderTree } from '../structure/change.ts';
import { checkStructureManifest, checkStructurePage, InvalidStructureObject,
  type OrderEntry, type StructureManifest } from '../structure/format.ts';
import { orderTreeKey, placementIri } from '../structure/graph.ts';
import { newCost, StructureObjectCorrupt, StructureObjectUnavailable } from '../structure/tree.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { ReadingOccurrence } from './boundary.ts';
import type { ReadingWork } from './traversal.ts';
import { READING_POSITION_COST } from './contract.ts';

/** Immutable pages, retained only for this request. Range and rank descend the
 * owner's counted B+tree; continuation never visits the completed prefix.
 * Hydration binds <=101 exact generation/occurrence placement identities,
 * never UUID-scattered record leaves. Limits cover corrupt, sparse and cold
 * reads as well as successful ones; exhaustion cannot become exact empty. */
export const READING_ORDER_COST = { pages: 256, bytes: 16 * 1024 * 1024 } as const;
export class ReadingOrderIndex {
  readonly objects: ImmutableObjects;
  private readonly manifests = new Map<string, Promise<StructureManifest>>();
  constructor(private readonly session: WorkReadSession, source: ImmutableObjects) {
    const pages = new Map<string, Promise<Uint8Array>>();
    let bytesLeft = READING_ORDER_COST.bytes;
    this.objects = { put: async () => { throw new WorkReadUnavailable('Reading order is read only'); },
      get: async digest => {
        session.checkDeadline();
        if (!pages.has(digest)) {
          if (pages.size >= READING_ORDER_COST.pages) throw new WorkReadUnavailable('Reading order page budget exceeded');
          pages.set(digest, (async () => {
            try {
              const bytes = await source.get(digest);
              session.checkDeadline();
              bytesLeft -= bytes.length;
              if (bytesLeft < 0) throw new WorkReadUnavailable('Reading order byte budget exceeded');
              return bytes;
            } catch (error) {
              if (error instanceof ObjectUnavailable || error instanceof ObjectIntegrityError) {
                throw new WorkReadUnavailable('Reading order object is unavailable', { cause: error });
              }
              throw error;
            }
          })());
        }
        return pages.get(digest)!;
      } };
  }
  manifest(meta: ReadingWork): Promise<StructureManifest> {
    if (!this.manifests.has(meta.revision!)) this.manifests.set(meta.revision!, (async () => {
      const rows = await this.session.query(`# reading-position:manifest
        SELECT ?manifest WHERE { GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(meta.revision!)} a rv:StructureRevision ; rv:component ${iri(meta.structure!)} ; rv:manifest ?manifest .
        } } LIMIT 2`, 2);
      const ref = rows[0]?.manifest?.value;
      if (rows.length !== 1 || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(ref ?? '')) {
        throw new WorkReadUnavailable('Reading order revision is unavailable');
      }
      const manifest = checkStructureManifest(await this.objects.get(ref!.slice(-64)));
      if (manifest.structure !== meta.structure || manifest.generation !== meta.generation || manifest.order.count !== manifest.placementCount
        || !['book-composition', 'work-composition'].includes(manifest.profile)) {
        throw new WorkReadUnavailable('Reading order manifest differs from selected generation');
      }
      return manifest;
    })());
    return this.manifests.get(meta.revision!)!;
  }
  async ordinal(meta: ReadingWork, item: ReadingOccurrence): Promise<number> {
    const manifest = await this.manifest(meta), tree = orderTree(this.objects), cost = newCost();
    const key = orderTreeKey(item), ordered = (await tree.lookup(manifest.order, [key], cost)).get(key);
    if (ordered?.occurrence !== item.occurrence) throw new WorkReadUnavailable('Reading ordinal differs from immutable order');
    return await tree.countBefore(manifest.order, orderTreeKey(item), cost)
      - await tree.countBefore(manifest.order, `${item.parent}\u0001`, cost) + 1;
  }
  async numbered(meta: ReadingWork, parent: string, number: number): Promise<string | null> {
    return (await this.numberedEntry(meta, parent, number))?.occurrence ?? null;
  }
  async numberedEntry(meta: ReadingWork, parent: string, number: number): Promise<OrderEntry | null> {
    const manifest = await this.manifest(meta), cost = newCost();
    let rank = await orderTree(this.objects).countBefore(manifest.order, `${parent}\u0001`, cost) + number - 1;
    if (rank >= manifest.order.count) return null;
    let page = manifest.order.page;
    for (let level = manifest.order.level; level >= 0; level--) {
      const node = checkStructurePage(await this.objects.get(page.slice(7)));
      if (node.tree !== 'order' || node.level !== level) throw new WorkReadUnavailable('Reading order page differs from root');
      if (node.level === 0) {
        const entry = (node.entries as OrderEntry[])[rank];
        if (!entry) throw new WorkReadUnavailable('Reading order rank differs from root');
        return entry.parent === parent ? entry : null;
      }
      const children = node.entries as Array<{ count: number; page: string }>;
      const child = children.find(candidate => {
        if (rank < candidate.count) return true;
        rank -= candidate.count; return false;
      });
      if (!child) throw new WorkReadUnavailable('Reading order rank exceeds subtree counts');
      page = child.page;
    }
    throw new WorkReadUnavailable('Reading order depth exceeds its cost');
  }
  async range(meta: ReadingWork, parent: string, after: ReadingOccurrence | undefined, reverse: boolean, limit: number) {
    const manifest = await this.manifest(meta), tree = orderTree(this.objects), cost = newCost();
    const from = !reverse && after ? `${orderTreeKey(after)}\u0000` : `${parent}\u0001`;
    const to = reverse && after ? orderTreeKey(after) : `${parent}\u0002`;
    const ordered = await tree.range(manifest.order, from, to, limit, cost, reverse);
    if (!ordered.length) return [];
    return this.hydrate(meta, ordered);
  }
  async hydrate(meta: ReadingWork, ordered: OrderEntry[], sparse = false): Promise<ReadingOccurrence[]> {
    if (!ordered.length) return [];
    const rows = await this.session.query(`# reading-position:hydrate
      SELECT ?occurrence ?parent ?segmentKey ?orderKey ?role ?target ?label ?displayLabel WHERE {
        GRAPH ${iri(GRAPHS.current)} {
          VALUES (?placement ?occurrence) { ${ordered.map(entry =>
            `(${iri(placementIri(meta.generation!, entry.occurrence))} ${iri(entry.occurrence)})`).join(' ')} }
          ?placement a rv:OccurrencePlacement ; rv:generation ${iri(meta.generation!)} ; rv:occurrence ?occurrence ;
            rv:orderSegment ?segment ; rv:orderKey ?orderKey ; rv:occurrenceRole ?role .
          ?segment rv:parent ?parent ; rv:segmentKey ?segmentKey .
          FILTER NOT EXISTS { ?placement rv:removedBy ?removed }
          OPTIONAL { ?placement schema:item ?target }
          OPTIONAL { ?placement rv:occurrenceLabel ?label }
          OPTIONAL { ?placement rv:qualifier/rv:displayLabel ?displayLabel }
        }
      }`, ordered.length * READING_POSITION_COST.labels);
    const records = new Map<string, ReadingOccurrence>();
    const wanted = new Map(ordered.map(entry => [entry.occurrence, entry]));
    for (const row of rows) {
      const entry = wanted.get(row.occurrence?.value ?? ''), role = row.role?.value.split('/').at(-1);
      if (!entry || row.parent?.value !== entry.parent || row.segmentKey?.value !== entry.segmentKey
        || row.orderKey?.value !== entry.orderKey || !['ChapterRole', 'PartRole', 'GroupRole'].includes(role ?? '')) {
        throw new WorkReadUnavailable('Reading order and placement differ');
      }
      const item: ReadingOccurrence = { work: meta.work, structure: meta.structure!, revision: meta.revision!, ...entry,
        role: role === 'ChapterRole' ? 'chapter' : role === 'PartRole' ? 'part' : 'group',
        target: row.target?.value ?? null, ...(row.displayLabel ? { displayLabel: row.displayLabel.value } : {}) };
      const previous = records.get(item.occurrence);
      if (previous && JSON.stringify({ ...previous, labels: undefined }) !== JSON.stringify(item)) {
        throw new WorkReadUnavailable('Reading placement is ambiguous');
      }
      const selected = previous ?? item;
      if (row.label) {
        const language = row.label['xml:lang'];
        if (!language) throw new WorkReadUnavailable('Reading label language is unavailable');
        selected.labels ??= [];
        if (!selected.labels.some(label => label.value === row.label!.value && label.language === language)) {
          selected.labels.push({ value: row.label.value, language });
        }
        if (selected.labels.length > READING_POSITION_COST.labels) throw new WorkReadUnavailable('Reading labels exceed their cost');
      }
      records.set(item.occurrence, selected);
    }
    const manifest = await this.manifest(meta), tree = orderTree(this.objects), cost = newCost();
    if (sparse) {
      const items: ReadingOccurrence[] = [];
      for (const entry of ordered) {
        const item = records.get(entry.occurrence);
        if (!item) throw new WorkReadUnavailable('Reading placement is unavailable');
        items.push({ ...item, ordinal: await this.ordinal(meta, item) });
      }
      return items;
    }
    const reverse = ordered.length > 1 && orderTreeKey(ordered[0]!) > orderTreeKey(ordered[1]!);
    const parent = ordered[0]!.parent;
    const offset = await tree.countBefore(manifest.order, orderTreeKey(ordered[0]!), cost)
      - await tree.countBefore(manifest.order, `${parent}\u0001`, cost) + 1;
    return ordered.map((entry, index): ReadingOccurrence => {
      const item = records.get(entry.occurrence);
      if (!item) throw new WorkReadUnavailable('Reading placement is unavailable');
      return { ...item, ordinal: offset + (reverse ? -index : index) };
    });
  }
}

export async function readingOrderRead<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof InvalidStructureObject || error instanceof StructureObjectCorrupt
      || error instanceof StructureObjectUnavailable) {
      throw new WorkReadUnavailable('Reading order is unavailable', { cause: error });
    }
    throw error;
  }
}
