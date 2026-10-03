import { GRAPHS, iri } from '../work/activate.ts';
import { checkStructureManifest, checkOccurrenceRecord, type OccurrenceRecord } from '../structure/format.ts';
import { structureProfileFor, structureProfileForGraph } from '../structure/profiles.ts';
import { structureObjects, orderTree, recordTree } from '../structure/change.ts';
import { orderTreeKey, type CompositionHeader } from '../structure/graph.ts';
import { newCost } from '../structure/tree.ts';
import { READING_ORDER_COST } from '../structure/reading-order.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

/** Feed loads the selected immutable roots in one graph transaction. Point
 * and order reads thereafter use the Structure owner's trees and validators;
 * graph heads are fenced once by the request envelope, not once per card. */
export async function feedCompositions(session: WorkReadSession, resources: readonly string[]) {
  const ids = [...new Set(resources)];
  if (!ids.length) return new Map<string, FeedComposition>();
  const facts = `GRAPH ${iri(GRAPHS.current)} { ?structure rv:structureProfile ?profile ; rv:structureHead ?head ; rv:selectedGeneration ?generation .
      ?generation rv:structure ?structure ; rv:generationState rv:Active ; rv:placementCount ?count . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StructureRevision ; rv:component ?structure ; rv:manifest ?manifest . }`;
  const rows = await session.query(`SELECT ?resource ?structure ?component ?profile ?head ?generation ?count ?manifest WHERE {
    { VALUES ?resource { ${ids.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?resource rv:mainVersion ?component .
        ?structure a rv:Structure ; rv:structureOf ?component ; rv:structureProfile rv:BookComposition . } ${facts} }
    UNION { VALUES ?resource { ${ids.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?resource a rv:Collection ; rv:structure ?structure .
        ?structure a rv:Structure ; rv:structureOf ?resource . } BIND(?resource AS ?component) ${facts} }
  } LIMIT ${ids.length + 1}`, ids.length + 1);
  const result = new Map<string, FeedComposition>();
  for (const row of rows) {
    const id = row.resource?.value;
    if (!id || result.has(id) || !row.structure || !row.component || !row.profile || !row.head || !row.generation
      || !/^\d+$/.test(row.count?.value ?? '') || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(row.manifest?.value ?? ''))
      throw new WorkReadUnavailable('Feed composition is ambiguous');
    const profile = structureProfileForGraph(row.profile.value);
    const header: CompositionHeader = { structure: row.structure.value, component: row.component.value,
      mainVersion: row.component.value, owner: id, work: id, profile: profile.id, head: row.head.value,
      generation: row.generation.value, placementCount: Number(row.count!.value), manifest: row.manifest!.value };
    const objects = structureObjects(session.deps.environment);
    const manifest = checkStructureManifest(await objects.get(header.manifest.slice(-64)));
    if (manifest.structure !== header.structure || manifest.structureOf !== header.component
      || manifest.profile !== header.profile || manifest.generation !== header.generation
      || manifest.placementCount !== header.placementCount) throw new WorkReadUnavailable('Feed composition root differs');
    result.set(id, new FeedComposition(objects, header, manifest));
  }
  return result;
}

export class FeedComposition {
  readonly cost = newCost();
  constructor(private readonly objects: ReturnType<typeof structureObjects>, readonly header: CompositionHeader,
    private readonly manifest: ReturnType<typeof checkStructureManifest>) {}

  async lookup(ids: readonly string[]) {
    const rows = await recordTree(this.objects).lookup(this.manifest.records, ids, this.cost);
    const p = structureProfileFor(this.header.profile);
    for (const row of rows.values()) checkOccurrenceRecord(row, p.id, p.catalogTargetTypes,
      p.selectionRequiredRoles ?? p.targetRoles, p.selectionOptionalRoles);
    return rows;
  }
  async page(parent = this.header.structure, after?: OccurrenceRecord, limit = 1) {
    const prefix = `${parent}\u0001`;
    const from = after ? `${orderTreeKey(after as Required<Pick<OccurrenceRecord,'parent'|'segmentKey'|'orderKey'>>)}\u0000` : prefix;
    const order = await orderTree(this.objects).range(this.manifest.order, from, `${prefix}\uffff`, limit, this.cost);
    const rows = await this.lookup(order.map(row => row.occurrence));
    return order.map(row => {
      const record = rows.get(row.occurrence);
      if (!record || record.state !== 'active') throw new WorkReadUnavailable('Feed composition order differs');
      return record;
    });
  }
  async path(record: OccurrenceRecord) {
    if (record.state !== 'active' || !record.segmentKey || !record.orderKey) return null;
    const path = [`${record.segmentKey}\u0001${record.orderKey}`];
    if (record.parent !== this.header.structure) {
      const parent = (await this.lookup([record.parent])).get(record.parent);
      if (!parent || parent.state !== 'active' || parent.role !== 'group' || parent.parent !== this.header.structure
        || !parent.segmentKey || !parent.orderKey) throw new WorkReadUnavailable('Book ancestry differs');
      path.unshift(`${parent.segmentKey}\u0001${parent.orderKey}`);
    }
    return path.join('\u0000');
  }
  async ordinal(record: OccurrenceRecord) {
    const tree = orderTree(this.objects);
    return await tree.countBefore(this.manifest.order, orderTreeKey(record as Required<Pick<OccurrenceRecord,'parent'|'segmentKey'|'orderKey'>>), this.cost)
      - await tree.countBefore(this.manifest.order, `${record.parent}\u0001`, this.cost) + 1;
  }
  /** Same bounded depth-first walk as Structure's reading-order owner. */
  async next(from?: OccurrenceRecord) {
    let parent = from?.parent ?? this.header.structure, after = from;
    const entered = new Map<string, OccurrenceRecord>();
    for (let step = 0; step < READING_ORDER_COST.steps; step++) {
      const item = (await this.page(parent, after))[0];
      if (item?.role === 'chapter') return item;
      if (item?.role === 'group') { entered.set(item.occurrence, item); parent = item.occurrence; after = undefined; continue; }
      if (item) throw new WorkReadUnavailable('Book contains an invalid role');
      if (parent === this.header.structure) return null;
      const group = entered.get(parent) ?? (await this.lookup([parent])).get(parent);
      if (!group || group.state !== 'active' || group.role !== 'group') throw new WorkReadUnavailable('Book group differs');
      after = group; parent = group.parent;
    }
    return null;
  }
}
