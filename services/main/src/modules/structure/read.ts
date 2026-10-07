import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { checkOccurrenceRecord, checkStructureManifest, checkStructurePage, InvalidStructureObject, STRUCTURE_LIMITS,
  type OccurrenceRecord, type RecipeMeasure, type StructureManifest } from './format.ts';
import { orderTree, recordTree, structureObjects } from './change.ts';
import { CompositionCorrupt, CompositionUnavailable, NATIVE_ID, orderTreeKey,
  readCompositionHeader, type CompositionHeader } from './graph.ts';
import { isCatalogTarget, structureProfileFor } from './profiles.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable, newCost, type TreeCost } from './tree.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { resolvePreparedGroups } from './group-root.ts';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { encodeReadCursor, decodeReadCursor, WorkReadMoved } from '../work/read-session.ts';
import { qualifierKeyTree, qualifierKeyPrefix, qualifierKeyOf, requireQualifierKeyIndex, resolvePreparedQualifierKeys,
  QUALIFIER_KEY_COST, type QualifierKey } from './qualifier-index.ts';

/** Source-bound candidates refine existing immutable membership. A miss never
 * falls back to a complete order/record inventory or invents legacy coverage. */
export async function readCompositionOccurrenceByQualifierKey(env: WorkActivationEnvironment, input: {
  structure: string; revision?: string; parent?: string; key: QualifierKey; header?: CompositionHeader;
  canReadOwner: (owner: string) => Promise<boolean>;
  canReadTarget: (target: string) => Promise<boolean>;
  canReadTargets?: (targets: readonly string[]) => Promise<ReadonlySet<string>>;
  visible?: (record: OccurrenceRecord) => boolean;
}) {
  if (!NATIVE_ID.test(input.structure) || input.revision && !NATIVE_ID.test(input.revision)
    || input.parent && !NATIVE_ID.test(input.parent)) throw new CompositionUnavailable('invalid qualifier key scope');
  const prefix = qualifierKeyPrefix(input.key);
  const header = input.header ?? await readCompositionHeader(env, input.structure);
  if (!header || header.structure !== input.structure || !await input.canReadOwner(header.owner)) {
    throw new CompositionUnavailable('Composition is unavailable');
  }
  const revision = input.revision ?? header.head;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?count ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StructureRevision ; rv:component ${iri(input.structure)} ;
      rv:manifest ?manifest ; rv:placementCount ?count ; rv:dataEpoch ?epoch ; rv:sequence ?sequence }
  } LIMIT 2`)).results?.bindings ?? [];
  const row = rows[0], manifestRef = row?.manifest?.value;
  if (!rows.length) throw new CompositionUnavailable('Composition revision is unavailable');
  if (rows.length !== 1 || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifestRef ?? '')
    || !/^\d+$/.test(row?.count?.value ?? '') || !row?.epoch || !/^\d+$/.test(row?.sequence?.value ?? '')) {
    throw new CompositionCorrupt('Composition revision is ambiguous');
  }
  if (!input.revision && manifestRef !== header.manifest) throw new CompositionCorrupt('Composition head moved during key read');
  const sourceObjects = structureObjects(env), cost = newCost(), cached = new Map<string, Promise<Uint8Array>>();
  let bytesRead = 0;
  const deadline = Date.now() + QUALIFIER_KEY_COST.deadlineMs;
  const check = () => {
    fusekiReadBudget.getStore()?.signal.throwIfAborted();
    if (Date.now() > deadline) throw new StructureObjectUnavailable('Qualifier key read deadline exceeded');
  };
  const objects = { put: sourceObjects.put.bind(sourceObjects), get: async (digest: string) => {
    check();
    if (!cached.has(digest)) {
      if (cached.size >= QUALIFIER_KEY_COST.objectPages) throw new StructureObjectUnavailable('Qualifier key object page budget exceeded');
      cached.set(digest, (async () => {
        const bytes = await sourceObjects.get(digest);
        check();
        bytesRead += bytes.length;
        if (bytesRead > QUALIFIER_KEY_COST.objectBytes) throw new StructureObjectUnavailable('Qualifier key object byte budget exceeded');
        return bytes;
      })());
    }
    return cached.get(digest)!;
  } };
  let manifest;
  try { manifest = checkStructureManifest(await objects.get(manifestRef!.slice(-64))); }
  catch (error) {
    if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
    if (error instanceof InvalidStructureObject || error instanceof ObjectIntegrityError) throw new StructureObjectCorrupt(error.message);
    throw error;
  }
  cost.pagesRead++;
  if (manifest.structure !== input.structure || manifest.structureOf !== header.component || manifest.profile !== header.profile
    || manifest.placementCount !== Number(row!.count!.value) || !input.revision && manifest.generation !== header.generation) {
    throw new StructureObjectCorrupt('Qualifier key manifest differs from revision');
  }
  manifest = await resolvePreparedQualifierKeys(env, manifestRef!.slice(-64), manifest);
  const coverage = requireQualifierKeyIndex(manifest), parent = input.parent ?? input.structure;
  try {
    const root = checkStructurePage(await objects.get(coverage.root.page.slice(7)));
    const count = root.level === 0 ? root.entries.length
      : (root.entries as Array<{ count: number }>).reduce((total, child) => total + child.count, 0);
    if (root.tree !== 'qualifier-key' || root.level !== coverage.root.level || count !== coverage.root.count) {
      throw new StructureObjectCorrupt('Qualifier posting root differs from its descriptor');
    }
  } catch (error) {
    if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
    if (error instanceof InvalidStructureObject || error instanceof ObjectIntegrityError) throw new StructureObjectCorrupt(error.message);
    throw error;
  }
  if (parent !== input.structure) {
    const group = (await recordTree(objects).lookup(manifest.records, [parent], cost)).get(parent);
    if (!group || group.state !== 'active' || group.role !== 'group') throw new CompositionUnavailable('Composition parent is unavailable');
  }
  const profile = structureProfileFor(header.profile), occurrences: OccurrenceRecord[] = [];
  let after = prefix, visits = 0;
  const readable = async (records: readonly OccurrenceRecord[]) => {
    const eligible = records.filter(record => !input.visible || input.visible(record));
    const targets = [...new Set(eligible.flatMap(record => record.target ? [record.target] : []))];
    const allowed = input.canReadTargets ? await input.canReadTargets(targets)
      : new Set(await Promise.all(targets.map(async target => await input.canReadTarget(target) ? target : null)));
    return eligible.filter(record => !record.target || allowed.has(record.target));
  };
  for (;;) {
    check();
    const batch = await qualifierKeyTree(objects).range(coverage.root, after, `${prefix.slice(0, -1)}\u0002`,
      Math.min(QUALIFIER_KEY_COST.candidates, QUALIFIER_KEY_COST.visits - visits + 1), cost);
    visits += batch.length;
    if (visits > QUALIFIER_KEY_COST.visits) throw new StructureObjectUnavailable('Qualifier key candidate budget exceeded');
    const records = await recordTree(objects).lookup(manifest.records, batch.map(entry => entry.occurrence), cost);
    const scoped: OccurrenceRecord[] = [];
    for (const entry of batch) {
      const record = records.get(entry.occurrence), key = record && qualifierKeyOf(record);
      if (!record || !key || `${qualifierKeyPrefix(key)}${record.occurrence}` !== entry.key) {
        throw new StructureObjectCorrupt('Qualifier key candidate differs from authoritative record');
      }
      try { checkOccurrenceRecord(record, header.profile, profile.catalogTargetTypes,
        profile.selectionRequiredRoles ?? profile.targetRoles, profile.selectionOptionalRoles); }
      catch (error) {
        if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
        throw error;
      }
      if (record.parent === parent) scoped.push(record);
    }
    for (const record of await readable(scoped)) { occurrences.push(record); if (occurrences.length === 2) break; }
    if (occurrences.length === 2 || batch.length < QUALIFIER_KEY_COST.candidates) break;
    after = `${batch.at(-1)!.key}\u0000`;
  }
  if (!await input.canReadOwner(header.owner)) throw new CompositionUnavailable('Composition is unavailable');
  if ((await readable(occurrences)).length !== occurrences.length) throw new WorkReadMoved('Qualifier key disclosure changed during read');
  return { structure: input.structure, owner: header.owner, component: header.component, work: header.work,
    mainVersion: header.mainVersion, revision, occurrences,
    outcome: occurrences.length === 2 ? 'ambiguous' as const : occurrences.length ? 'found' as const : 'missing' as const,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: row!.epoch!.value, sequence: row!.sequence!.value },
    cost: { ...cost, pagesRead: cached.size } };
}

export interface CompositionPage {
  structure: string;
  owner: string;
  component: string;
  work: string;
  mainVersion: string;
  revision: string;
  predecessor: string | null;
  /** Internal compatibility count; zero for profiles that withhold aggregate counts. */
  placementCount: number;
  completion?: { status: 'concluded' | 'ongoing' | 'unknown'; evidence: string[] };
  occurrences: OccurrenceRecord[];
  next: string | null;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  cost: TreeCost;
  /** Ordinals count from 1 among an occurrence's siblings, groups included. */
  occurrenceContext?: { ordinal: number; path: Array<{ occurrence: string;
    labels: OccurrenceRecord['labels']; qualifier?: OccurrenceRecord['qualifier']; ordinal: number }> };
  /**
   * With `outline`: siblings before this page's first item, the active children of
   * each group on the page, and a group parent's own ordinal among its siblings.
   * Two order-tree descents each, never a sibling scan.
   */
  offset?: number;
  /** Total active siblings, including groups, at this exact revision. */
  siblingCount?: number;
  childCounts?: Record<string, number>;
  parentOrdinal?: number;
}

/** One exact immutable root and measured local work shared by a neighbourhood read. */
export interface CompositionSnapshot {
  header: CompositionHeader;
  revision: string;
  predecessor: string | null;
  manifest: StructureManifest;
  objects: ImmutableObjects;
  sourcePosition: CompositionPage['sourcePosition'];
  cost: TreeCost;
}

/** Resolve an exact revision once; sibling and ancestor seeks then reuse its roots. */
export async function readCompositionSnapshot(env: WorkActivationEnvironment, input: {
  structure: string; header?: CompositionHeader; revision?: string; objects?: ImmutableObjects;
}): Promise<CompositionSnapshot> {
  if (!NATIVE_ID.test(input.structure) || input.revision && !NATIVE_ID.test(input.revision)) {
    throw new CompositionUnavailable('invalid composition revision');
  }
  const header = input.header ?? await readCompositionHeader(env, input.structure);
  if (!header || header.structure !== input.structure) throw new CompositionUnavailable('composition is unavailable');
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
  if (revision === header.head && (value('manifest') !== header.manifest
    || Number(value('count')) !== header.placementCount)) {
    throw new CompositionCorrupt('composition head moved during read');
  }
  const objects = input.objects ?? structureObjects(env);
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
    || manifest.order.count !== manifest.placementCount
    || revision === header.head && manifest.generation !== header.generation) {
    throw new StructureObjectCorrupt('composition manifest differs from revision');
  }
  const cost = newCost();
  cost.pagesRead++;
  manifest = await resolvePreparedGroups(env, value('manifest')!.slice(-64), manifest);
  return { header, revision, predecessor: value('predecessor') ?? null, manifest, objects,
    sourcePosition: { datasetId: 'product', dataEpoch: value('epoch')!, sequence: value('sequence')! }, cost };
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
  canReadTarget: (target: string) => Promise<boolean>; outline?: boolean;
  /** Descending sibling order; `after` remains an exclusive continuation anchor. */
  reverse?: boolean;
  /** One disclosure pass per immutable range, including visible lookahead.
   * The returned set is local to that range, never a cached authorization. */
  canReadTargets?: (targets: readonly string[]) => Promise<ReadonlySet<string>>;
  /** The Structure's header when the caller already read it for this request; saves two queries. */
  header?: CompositionHeader;
  /** Reuse an exact immutable revision and accumulate its measured tree work. */
  snapshot?: CompositionSnapshot;
  /** An owner's disclosure projection filters inside the immutable range scan,
   * before lookahead, so sparse pages do not repeat graph/header reads per item. */
  visible?: (record: OccurrenceRecord) => boolean;
  signal?: AbortSignal;
}): Promise<CompositionPage> {
  input.signal?.throwIfAborted();
  if (!NATIVE_ID.test(input.structure) || input.revision && !NATIVE_ID.test(input.revision)
    || input.parent && !NATIVE_ID.test(input.parent)
    || input.occurrence && !NATIVE_ID.test(input.occurrence) || !Number.isInteger(input.limit)
    || input.limit < 1 || input.limit > 100) throw new CompositionUnavailable('invalid composition page');
  const snapshot = input.snapshot ?? await readCompositionSnapshot(env, input);
  const { header, revision, predecessor, objects, manifest, sourcePosition, cost } = snapshot;
  const headerKeys = ['structure', 'profile', 'owner', 'component', 'mainVersion', 'work',
    'head', 'generation', 'placementCount', 'manifest'] as const;
  if (header.structure !== input.structure || manifest.structure !== input.structure
    || input.revision && input.revision !== revision
    || input.header && headerKeys.some(key => input.header![key] !== header[key])) {
    throw new CompositionUnavailable('composition snapshot differs from read');
  }
  const profile = structureProfileFor(header.profile);
  if (input.occurrence) {
    const record = (await recordTree(objects).lookup(manifest.records, [input.occurrence], cost))
      .get(input.occurrence);
    if (!record) throw new CompositionUnavailable('occurrence is unavailable');
    try { checkOccurrenceRecord(record, header.profile, profile.catalogTargetTypes,
      profile.selectionRequiredRoles ?? profile.targetRoles, profile.selectionOptionalRoles); }
    catch (error) {
      if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
      throw error;
    }
    const withheld = record.target && !isCatalogTarget(profile, record.target)
      && !(input.canReadTargets ? (await input.canReadTargets([record.target])).has(record.target)
        : await input.canReadTarget(record.target));
    if (withheld && profile.withholdUnreadableTargets) throw new CompositionUnavailable('occurrence is unavailable');
    const visible = withheld
      ? { ...record, target: undefined, selection: undefined, labels: [] } : record;
    let occurrenceContext: CompositionPage['occurrenceContext'];
    if (!profile.withholdUnreadableTargets && record.state === 'active' && record.segmentKey && record.orderKey) {
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
        const at = await orderTree(objects).countBefore(manifest.order, orderTreeKey(ancestor as Required<Pick<
          OccurrenceRecord, 'parent' | 'segmentKey' | 'orderKey'>>), cost)
          - await orderTree(objects).countBefore(manifest.order, `${ancestor.parent}\u0001`, cost);
        path.unshift({ occurrence: ancestor.occurrence, labels: ancestor.labels,
          ...(ancestor.qualifier ? { qualifier: ancestor.qualifier } : {}), ordinal: at + 1 });
        parent = ancestor.parent;
      }
      if (parent !== input.structure) throw new StructureObjectCorrupt('Chapter ancestry exceeds depth');
      occurrenceContext = { ordinal: before - first + 1, path };
    }
    return { structure: input.structure, owner: header.owner, component: header.component,
      work: header.work, mainVersion: header.mainVersion,
      revision, predecessor,
      placementCount: profile.withholdUnreadableTargets ? 0 : manifest.placementCount,
      ...(header.profile === 'work-composition' ? { completion: manifest.completion ?? { status: 'unknown', evidence: [] } } : {}),
      occurrences: !input.visible || input.visible(visible) ? [visible] : [], next: null,
      sourcePosition,
      cost, occurrenceContext };
  }
  const parent = input.parent ?? input.structure;
  let parentRecord: OccurrenceRecord | undefined;
  if (parent !== input.structure) {
    const found = await recordTree(objects).lookup(manifest.records, [parent], cost);
    parentRecord = found.get(parent);
    if (!parentRecord || parentRecord.state !== 'active' || parentRecord.role !== 'group') {
      throw new CompositionUnavailable('composition parent is unavailable');
    }
  }
  const prefix = `${parent}\u0001`;
  const cursorPosition = sourcePosition;
  const cursorBinding = { structure: input.structure, revision, parent,
    ...(input.reverse ? { reverse: true } : {}) };
  let after = input.after;
  if (profile.withholdUnreadableTargets) {
    try { after = decodeReadCursor(input.after, cursorBinding, cursorPosition)?.after; }
    catch { throw new CompositionUnavailable('composition cursor is invalid or its head changed'); }
  }
  if (after && (!after.startsWith(prefix) || after.length > 512)) {
    throw new CompositionUnavailable('composition cursor is invalid');
  }
  const occurrences: OccurrenceRecord[] = [];
  // A continuation means another disclosed item exists, never another raw placement.
  // Each immutable range/lookup is bounded; the read deadline bounds the full scan.
  let scanAfter = after;
  let page: Array<Required<Pick<OccurrenceRecord, 'parent' | 'segmentKey' | 'orderKey'>>> = [];
  let hasNext = false;
  const disclosed = profile.withholdUnreadableTargets || !!input.visible;
  const scanLimit = disclosed ? 101 : input.limit + 1;
  while (true) {
    input.signal?.throwIfAborted();
    const ordered = await orderTree(objects).range(manifest.order,
      input.reverse ? prefix : scanAfter ? `${scanAfter}\u0000` : prefix,
      input.reverse && scanAfter ? scanAfter : `${parent}\u0002`, scanLimit, cost, input.reverse);
    if (!disclosed) { page = ordered.slice(0, input.limit); hasNext = ordered.length > input.limit; }
    const candidates = disclosed ? ordered : ordered.slice(0, input.limit);
    const found = await recordTree(objects).lookup(manifest.records,
      candidates.map(entry => entry.occurrence), cost);
    // Validate the entire bounded range before handing target identities to
    // disclosure owners. Corrupt immutable records must never trigger hydration.
    const records = candidates.map(entry => {
      input.signal?.throwIfAborted();
      const record = found.get(entry.occurrence);
      if (!record || record.state !== 'active' || record.parent !== parent
        || record.segmentKey !== entry.segmentKey || record.orderKey !== entry.orderKey) {
        throw new StructureObjectCorrupt('composition order and occurrence records differ');
      }
      try { checkOccurrenceRecord(record, header.profile, profile.catalogTargetTypes,
        profile.selectionRequiredRoles ?? profile.targetRoles, profile.selectionOptionalRoles); }
      catch (error) {
        if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
        throw error;
      }
      return record;
    });
    const targets = [...new Set(records.flatMap(record => record.target && !isCatalogTarget(profile, record.target)
      ? [record.target] : []))];
    const readable = input.canReadTargets && targets.length ? await input.canReadTargets(targets) : undefined;
    for (const record of records) {
      input.signal?.throwIfAborted();
      const withheld = record.target && !isCatalogTarget(profile, record.target)
        && !(readable ? readable.has(record.target) : await input.canReadTarget(record.target));
      if (!withheld || !profile.withholdUnreadableTargets) {
        const visible = withheld ? { ...record, target: undefined, selection: undefined, labels: [] } : record;
        if (!input.visible || input.visible(visible)) occurrences.push(visible);
      }
      if (disclosed && occurrences.length > input.limit) break;
    }
    if (!disclosed || occurrences.length > input.limit || ordered.length < scanLimit) break;
    scanAfter = orderTreeKey(ordered.at(-1)!);
  }
  input.signal?.throwIfAborted();
  if (disclosed) {
    hasNext = occurrences.length > input.limit;
    occurrences.splice(input.limit);
    page = occurrences as Array<Required<Pick<OccurrenceRecord, 'parent' | 'segmentKey' | 'orderKey'>>>;
  }
  let outline: { offset: number; siblingCount: number; childCounts: Record<string, number>;
    parentOrdinal?: number } | undefined;
  if (input.outline && !profile.withholdUnreadableTargets) {
    const tree = orderTree(objects);
    const childCounts: Record<string, number> = {};
    for (const record of occurrences) {
      if (record.role !== 'group') continue;
      childCounts[record.occurrence] = await tree.countBefore(manifest.order, `${record.occurrence}\u0002`, cost)
        - await tree.countBefore(manifest.order, `${record.occurrence}\u0001`, cost);
    }
    const first = await tree.countBefore(manifest.order, prefix, cost);
    const siblingCount = await tree.countBefore(manifest.order, `${parent}\u0002`, cost) - first;
    const offset = page.length ? await tree.countBefore(manifest.order, orderTreeKey(page[0]!), cost) - first : 0;
    const parentOrdinal = parentRecord ? await tree.countBefore(manifest.order, orderTreeKey(parentRecord as
      Required<Pick<OccurrenceRecord, 'parent' | 'segmentKey' | 'orderKey'>>), cost)
      - await tree.countBefore(manifest.order, `${parentRecord.parent}\u0001`, cost) + 1 : undefined;
    outline = { offset, siblingCount, childCounts, ...(parentOrdinal ? { parentOrdinal } : {}) };
  }
  return { structure: input.structure, owner: header.owner, component: header.component,
    work: header.work, mainVersion: header.mainVersion,
    revision, predecessor,
    placementCount: profile.withholdUnreadableTargets ? 0 : manifest.placementCount,
    ...(header.profile === 'work-composition' ? { completion: manifest.completion ?? { status: 'unknown', evidence: [] } } : {}),
    occurrences, next: hasNext ? (profile.withholdUnreadableTargets
      ? encodeReadCursor(cursorBinding, cursorPosition, orderTreeKey(page.at(-1)!))
      : orderTreeKey(page.at(-1)!)) : null,
    sourcePosition,
    cost, ...outline };
}
