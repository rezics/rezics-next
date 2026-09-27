import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { checkOccurrenceRecord, checkStructureManifest, InvalidStructureObject, STRUCTURE_LIMITS,
  type OccurrenceRecord, type RecipeMeasure } from './format.ts';
import { orderTree, recordTree, structureObjects } from './change.ts';
import { CompositionCorrupt, CompositionUnavailable, NATIVE_ID, orderTreeKey,
  readCompositionHeader } from './graph.ts';
import { isCatalogTarget, structureProfileFor } from './profiles.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable, newCost, type TreeCost } from './tree.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';

export interface CompositionPage {
  structure: string;
  owner: string;
  component: string;
  work: string;
  mainVersion: string;
  revision: string;
  predecessor: string | null;
  placementCount: number;
  occurrences: OccurrenceRecord[];
  next: string | null;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  cost: TreeCost;
  occurrenceContext?: { ordinal: number; path: Array<{ occurrence: string;
    labels: OccurrenceRecord['labels'] }> };
}

/** The measure set is part of an exact immutable revision, including an empty set. */
export async function readStructureMeasures(env: WorkActivationEnvironment, input: {
  structure: string; revision?: string;
}): Promise<{ structure: string; owner: string; revision: string; predecessor: string | null;
  measures: RecipeMeasure[]; sourcePosition: { datasetId: 'product'; dataEpoch: string;
    sequence: string }; cost: TreeCost }> {
  if (!NATIVE_ID.test(input.structure) || input.revision && !NATIVE_ID.test(input.revision)) {
    throw new CompositionUnavailable('invalid Structure measure read');
  }
  const header = await readCompositionHeader(env, input.structure);
  if (!header || header.profile !== 'recipe-composition') {
    throw new CompositionUnavailable('Recipe Structure is unavailable');
  }
  const revision = input.revision ?? header.head;
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?predecessor ?count ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(revision)} a rv:StructureRevision ; rv:component ${iri(input.structure)} ;
        rv:manifest ?manifest ; rv:placementCount ?count ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) throw new CompositionUnavailable('Structure revision is unavailable');
  const row = rows[0]!;
  const get = (name: string) => row[name]?.value;
  if (rows.length !== 1 || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(get('manifest') ?? '')
    || !/^[0-9]+$/.test(get('count') ?? '') || !/^[0-9]+$/.test(get('sequence') ?? '')
    || !get('epoch')) throw new CompositionCorrupt('Structure revision is ambiguous');
  if (!input.revision && get('manifest') !== header.manifest) {
    throw new CompositionCorrupt('Structure head moved during measure read');
  }
  let bytes: Uint8Array;
  try { bytes = await structureObjects(env).get(get('manifest')!.slice(-64)); }
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
  if (manifest.structure !== input.structure || manifest.structureOf !== header.component
    || manifest.profile !== header.profile || manifest.placementCount !== Number(get('count'))
    || !input.revision && manifest.generation !== header.generation) {
    throw new StructureObjectCorrupt('Structure measure manifest differs from revision');
  }
  const cost = newCost();
  cost.pagesRead++;
  return { structure: input.structure, owner: header.owner, revision,
    predecessor: get('predecessor') ?? null, measures: manifest.measures,
    sourcePosition: { datasetId: 'product', dataEpoch: get('epoch')!, sequence: get('sequence')! },
    cost };
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
  const profile = structureProfileFor(header.profile);
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
  if (manifest.structure !== input.structure || manifest.structureOf !== header.component
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
    try { checkOccurrenceRecord(record, header.profile, profile.catalogTargetTypes,
      profile.selectionRequiredRoles ?? profile.targetRoles); }
    catch (error) {
      if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
      throw error;
    }
    const visible = record.target && !isCatalogTarget(profile, record.target)
      && !await input.canReadTarget(record.target)
      ? { ...record, target: undefined, selection: undefined, labels: [] } : record;
    let occurrenceContext: CompositionPage['occurrenceContext'];
    if (record.state === 'active' && record.segmentKey && record.orderKey) {
      const key = orderTreeKey(record as Required<Pick<OccurrenceRecord,
        'parent' | 'segmentKey' | 'orderKey'>>);
      const before = await orderTree(objects).countBefore(manifest.order, key, cost);
      const first = await orderTree(objects).countBefore(manifest.order, `${record.parent}\u0001`, cost);
      const path: NonNullable<CompositionPage['occurrenceContext']>['path'] = [];
      let parent = record.parent;
      for (let depth = 0; parent !== input.structure && depth < STRUCTURE_LIMITS.maxDepth; depth++) {
        const ancestor = (await recordTree(objects).lookup(manifest.records, [parent], cost)).get(parent);
        if (!ancestor || ancestor.state !== 'active' || ancestor.role !== 'group') {
          throw new StructureObjectCorrupt('Chapter ancestry is unavailable');
        }
        path.unshift({ occurrence: ancestor.occurrence, labels: ancestor.labels });
        parent = ancestor.parent;
      }
      if (parent !== input.structure) throw new StructureObjectCorrupt('Chapter ancestry exceeds depth');
      occurrenceContext = { ordinal: before - first + 1, path };
    }
    return { structure: input.structure, owner: header.owner, component: header.component,
      work: header.work, mainVersion: header.mainVersion,
      revision, predecessor: value('predecessor') ?? null, placementCount: manifest.placementCount,
      occurrences: [visible], next: null,
      sourcePosition: { datasetId: 'product', dataEpoch: value('epoch')!, sequence: value('sequence')! },
      cost, occurrenceContext };
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
    try { checkOccurrenceRecord(record, header.profile, profile.catalogTargetTypes,
      profile.selectionRequiredRoles ?? profile.targetRoles); }
    catch (error) {
      if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
      throw error;
    }
    if (record.target && !isCatalogTarget(profile, record.target)
      && !await input.canReadTarget(record.target)) {
      occurrences.push({ ...record, target: undefined, selection: undefined, labels: [] });
    } else occurrences.push(record);
  }
  return { structure: input.structure, owner: header.owner, component: header.component,
    work: header.work, mainVersion: header.mainVersion,
    revision, predecessor: value('predecessor') ?? null, placementCount: manifest.placementCount,
    occurrences, next: ordered.length > input.limit ? orderTreeKey(page.at(-1)!) : null,
    sourcePosition: { datasetId: 'product', dataEpoch: value('epoch')!, sequence: value('sequence')! },
    cost };
}
