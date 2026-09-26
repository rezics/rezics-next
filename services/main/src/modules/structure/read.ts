import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { checkStructureManifest, InvalidStructureObject, type OccurrenceRecord } from './format.ts';
import { orderTree, recordTree, structureObjects } from './change.ts';
import { CompositionCorrupt, CompositionUnavailable, NATIVE_ID, orderTreeKey,
  readCompositionHeader } from './graph.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable, newCost, type TreeCost } from './tree.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';

export interface CompositionPage {
  structure: string;
  work: string;
  mainVersion: string;
  revision: string;
  predecessor: string | null;
  placementCount: number;
  occurrences: OccurrenceRecord[];
  next: string | null;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  cost: TreeCost;
}

/** Exact revision reads begin at the immutable root, never at today's projection. */
export async function readCompositionPage(env: WorkActivationEnvironment, input: {
  structure: string; revision?: string; parent?: string; occurrence?: string; after?: string; limit: number;
  canReadTarget: (target: string) => Promise<boolean>;
}): Promise<CompositionPage> {
  if (!NATIVE_ID.test(input.structure) || input.revision && !NATIVE_ID.test(input.revision)
    || input.parent && !NATIVE_ID.test(input.parent)
    || input.occurrence && !NATIVE_ID.test(input.occurrence) || !Number.isInteger(input.limit)
    || input.limit < 1 || input.limit > 100) throw new CompositionUnavailable('invalid composition page');
  const header = await readCompositionHeader(env, input.structure);
  if (!header) throw new CompositionUnavailable('composition is unavailable');
  const revision = input.revision ?? header.head;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?predecessor ?count ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(revision)} a rv:StructureRevision ; rv:component ${iri(input.structure)} ;
        rv:manifest ?manifest ; rv:placementCount ?count ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) throw new CompositionUnavailable('composition revision is unavailable');
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  if (rows.length !== 1 || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(value('manifest') ?? '')
    || !/^[0-9]+$/.test(value('count') ?? '') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || !value('epoch')) throw new CompositionCorrupt('composition revision is ambiguous');
  if (!input.revision && value('manifest') !== header.manifest) {
    throw new CompositionCorrupt('composition head moved during read');
  }
  const objects = structureObjects(env);
  let bytes: Uint8Array;
  try { bytes = await objects.get(value('manifest')!.slice(-64)); }
  catch (error) {
    if (error instanceof ObjectIntegrityError) throw new StructureObjectCorrupt(error.message);
    if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
    throw error;
  }
  let manifest;
  try { manifest = checkStructureManifest(bytes); }
  catch (error) {
    if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
    throw error;
  }
  if (manifest.structure !== input.structure || manifest.structureOf !== header.mainVersion
    || manifest.profile !== header.profile || manifest.placementCount !== Number(value('count'))
    || !input.revision && manifest.generation !== header.generation) {
    throw new StructureObjectCorrupt('composition manifest differs from revision');
  }
  const cost = newCost();
  cost.pagesRead++;
  if (input.occurrence) {
    const record = (await recordTree(objects).lookup(manifest.records, [input.occurrence], cost))
      .get(input.occurrence);
    if (!record) throw new CompositionUnavailable('occurrence is unavailable');
    const visible = record.target && !await input.canReadTarget(record.target)
      ? { ...record, target: undefined, selection: undefined, labels: [] } : record;
    return { structure: input.structure, work: header.work, mainVersion: header.mainVersion,
      revision, predecessor: value('predecessor') ?? null, placementCount: manifest.placementCount,
      occurrences: [visible], next: null,
      sourcePosition: { datasetId: 'product', dataEpoch: value('epoch')!, sequence: value('sequence')! },
      cost };
  }
  const parent = input.parent ?? input.structure;
  if (parent !== input.structure) {
    const found = await recordTree(objects).lookup(manifest.records, [parent], cost);
    const record = found.get(parent);
    if (!record || record.state !== 'active' || record.role !== 'group') {
      throw new CompositionUnavailable('composition parent is unavailable');
    }
  }
  const prefix = `${parent}\u0001`;
  if (input.after && (!input.after.startsWith(prefix) || input.after.length > 512)) {
    throw new CompositionUnavailable('composition cursor is invalid');
  }
  const ordered = await orderTree(objects).range(manifest.order,
    input.after ? `${input.after}\u0000` : prefix, `${parent}\u0002`, input.limit + 1, cost);
  const page = ordered.slice(0, input.limit);
  const found = await recordTree(objects).lookup(manifest.records,
    page.map(entry => entry.occurrence), cost);
  const occurrences: OccurrenceRecord[] = [];
  for (const entry of page) {
    const record = found.get(entry.occurrence);
    if (!record || record.state !== 'active' || record.parent !== parent
      || record.segmentKey !== entry.segmentKey || record.orderKey !== entry.orderKey) {
      throw new StructureObjectCorrupt('composition order and occurrence records differ');
    }
    if (record.target && !await input.canReadTarget(record.target)) {
      occurrences.push({ ...record, target: undefined, selection: undefined, labels: [] });
    } else occurrences.push(record);
  }
  return { structure: input.structure, work: header.work, mainVersion: header.mainVersion,
    revision, predecessor: value('predecessor') ?? null, placementCount: manifest.placementCount,
    occurrences, next: ordered.length > input.limit ? orderTreeKey(page.at(-1)!) : null,
    sourcePosition: { datasetId: 'product', dataEpoch: value('epoch')!, sequence: value('sequence')! },
    cost };
}
