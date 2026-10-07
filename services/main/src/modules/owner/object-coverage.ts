import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../../infrastructure/immutable-objects.ts';
import { GRAPHS, RV } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import { visitModelGenerationArtifacts } from '../semantic/model-custody.ts';
import { MODEL_COMPONENT, PROFILES } from '../semantic/schema.ts';
import { checkStructureManifest, checkStructurePage, checkStructureSealManifest,
  InvalidStructureObject, STRUCTURE_MANIFEST_FORMAT, STRUCTURE_SEAL_FORMAT }
  from '../structure/format.ts';

export class ObjectRecoveryConflict extends Error {
  constructor(message: string, readonly kind: 'unavailable' | 'corrupt' | 'mismatch' = 'mismatch') {
    super(message);
  }
}

export interface ObjectRecoveryStore {
  directory: string;
  workObjects?: ImmutableObjects;
  structureObjects?: ImmutableObjects;
  /** Maintenance commands may overlap a bounded window of immutable reads. */
  readConcurrency?: number;
}

/** A graph reference, including retained anchors and mutable context dependencies. */
export interface GraphObjectReference {
  graph: string;
  subject: string;
  manifest: string;
  component: string | null;
  model: string | null;
  shape: string | null;
}

export interface ObjectRecoveryCoverage {
  version: 1;
  referenceCount: string;
  referenceDigest: string;
  anchorCount: string;
  anchorDigest: string;
  objectCount: string;
  objectDigest: string;
}

interface ParsedPayload {
  length: number;
  component: unknown;
  format: unknown;
  state: unknown;
}

const SHA = /^[0-9a-f]{64}$/;
const MANIFEST = /^urn:rezics:sha256:([0-9a-f]{64})$/;
const OBJECT = /^sha256:([0-9a-f]{64})$/;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** Four predicate-index scans avoid a large OPTIONAL join and its request timeout.
 * Writers must be quiesced for recovery. O(Q + M log M) work, O(M) references. */
export async function graphObjectReferences(fuseki: FusekiClient): Promise<GraphObjectReference[]> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?graph ?subject ?manifest WHERE {
      { GRAPH ?graph { ?subject rv:manifest ?manifest } }
      UNION { ?subject rv:manifest ?manifest . BIND(<urn:x-arq:DefaultGraphNode> AS ?graph) }
    }`);
  if (!result.results?.bindings) throw new ObjectRecoveryConflict('graph object reference scan is incomplete');
  const references = result.results.bindings.map(row => {
    if (row.graph?.type !== 'uri' || row.subject?.type !== 'uri'
      || row.manifest?.type !== 'uri') {
      throw new ObjectRecoveryConflict('graph object reference is not an IRI');
    }
    return { graph: row.graph.value, subject: row.subject.value,
      manifest: row.manifest.value };
  });
  const identity = (graph: string, subject: string) => JSON.stringify([graph, subject]);
  const subjects = new Set(references.map(ref => identity(ref.graph, ref.subject)));
  const fields = new Map<string, Map<string, string[]>>();
  for (const [field, predicate] of [['component', 'component'], ['model', 'modelRevision'],
    ['shape', 'shapeRevision']] as const) {
    const scanned = await fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?graph ?subject ?value WHERE {
        { GRAPH ?graph { ?subject rv:${predicate} ?value } }
        UNION { ?subject rv:${predicate} ?value . BIND(<urn:x-arq:DefaultGraphNode> AS ?graph) }
      }`);
    if (!scanned.results?.bindings) throw new ObjectRecoveryConflict('graph object reference scan is incomplete');
    const values = new Map<string, string[]>();
    for (const row of scanned.results.bindings) {
      const key = identity(row.graph?.value ?? '', row.subject?.value ?? '');
      if (!subjects.has(key)) continue;
      if (row.value?.type !== 'uri') throw new ObjectRecoveryConflict('graph object reference is not an IRI');
      const found = values.get(key) ?? [];
      found.push(row.value.value);
      values.set(key, found);
    }
    fields.set(field, values);
  }
  // Preserve the OPTIONAL join's Cartesian product, including absent metadata.
  const expanded: GraphObjectReference[] = [];
  for (const ref of references) {
    const key = identity(ref.graph, ref.subject);
    for (const component of fields.get('component')!.get(key) ?? [null])
      for (const model of fields.get('model')!.get(key) ?? [null])
        for (const shape of fields.get('shape')!.get(key) ?? [null])
          expanded.push({ ...ref, component, model, shape });
  }
  for (const reference of expanded) {
    if (!reference.graph || !reference.subject || !MANIFEST.test(reference.manifest)
      || (reference.component !== null && !reference.component)
      || (reference.model !== null && !reference.model)
      || (reference.shape !== null && !reference.shape)) {
      throw new ObjectRecoveryConflict('graph object reference is malformed');
    }
  }
  expanded.sort((a, b) => record(a).localeCompare(record(b)));
  return expanded;
}

async function exactBytes(store: ObjectRecoveryStore, digest: string,
  kind: 'work' | 'structure' = 'work'): Promise<Buffer> {
  if (!SHA.test(digest)) throw new ObjectRecoveryConflict('immutable object digest is malformed');
  if (kind === 'structure') {
    if (!store.structureObjects) {
      throw new ObjectRecoveryConflict('Structure immutable object owner is unavailable', 'unavailable');
    }
    try { return Buffer.from(await store.structureObjects.get(digest)); }
    catch (error) {
      if (error instanceof ObjectIntegrityError) {
        throw new ObjectRecoveryConflict('Structure immutable object is corrupt', 'corrupt');
      }
      if (error instanceof ObjectUnavailable) {
        throw new ObjectRecoveryConflict('Structure immutable object is unavailable', 'unavailable');
      }
      throw error;
    }
  }
  if (store.workObjects) {
    try { return Buffer.from(await store.workObjects.get(digest)); }
    catch (error) {
      if (error instanceof ObjectIntegrityError) throw new ObjectRecoveryConflict('immutable object is corrupt', 'corrupt');
      if (!(error instanceof ObjectUnavailable)) throw error;
    }
  }
  let bytes: Buffer;
  try { bytes = await readFile(join(store.directory, digest)); }
  catch { throw new ObjectRecoveryConflict('committed immutable object is unavailable', 'unavailable'); }
  if (sha(bytes) !== digest) throw new ObjectRecoveryConflict('committed immutable object is corrupt', 'corrupt');
  return bytes;
}

/**
 * Read each referenced manifest and payload exactly once, O(M + B) object work
 * for M distinct manifests and B total bytes. Memory is O(M + largest object)
 * rather than retaining all payload bytes. Unreferenced newer objects are
 * outside this cut and cannot become adopted by the graph.
 */
export async function captureObjectRecoveryCoverage(
  fuseki: FusekiClient, store: ObjectRecoveryStore, retainedDigests?: Set<string>,
): Promise<ObjectRecoveryCoverage> {
  if (!store?.directory) throw new ObjectRecoveryConflict('immutable object owner is unavailable');
  const concurrency = store.readConcurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new ObjectRecoveryConflict('immutable read concurrency is outside 1..32');
  const references = await graphObjectReferences(fuseki);
  const referenceHash = createHash('sha256');
  const anchorHash = createHash('sha256');
  const objectHash = createHash('sha256');
  let anchorCount = 0;
  const objects = new Map<string, number>();
  const manifests = new Map<string, Record<string, unknown>>();
  const payloads = new Map<string, Promise<ParsedPayload>>();
  const manifestObject = async (digest: string, kind: 'work' | 'structure' = 'work'):
    Promise<Record<string, unknown>> => {
    const cached = manifests.get(digest);
    if (cached) return cached;
    const bytes = await exactBytes(store, digest, kind);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
    catch { throw new ObjectRecoveryConflict('committed manifest is corrupt', 'corrupt'); }
    objects.set(digest, bytes.length);
    retainedDigests?.add(digest);
    manifests.set(digest, parsed);
    return parsed;
  };
  const payloadObject = async (digest: string): Promise<ParsedPayload> => {
    const cached = payloads.get(digest);
    if (cached) return cached;
    const pending = (async () => {
      const bytes = await exactBytes(store, digest);
      let body: Record<string, unknown>;
      try { body = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
      catch { throw new ObjectRecoveryConflict('committed payload is corrupt', 'corrupt'); }
      const parsed = { length: bytes.length, component: body.component,
        format: body.format, state: body.state };
      objects.set(digest, bytes.length);
      retainedDigests?.add(digest);
      return parsed;
    })();
    payloads.set(digest, pending);
    return pending;
  };
  const structureObject = async (digest: string): Promise<Uint8Array> => {
    const bytes = await exactBytes(store, digest, 'structure');
    objects.set(digest, bytes.length);
    retainedDigests?.add(digest);
    return bytes;
  };
  const checkedPages = new Set<string>();
  const checkedStructureRoots = new Set<string>();
  const checkedModelGenerations = new Set<string>();
  const objectDigest = (reference: string): string => {
    const digest = OBJECT.exec(reference)?.[1];
    if (!digest) throw new ObjectRecoveryConflict('Structure object reference is malformed', 'corrupt');
    return digest;
  };
  const tree = async (reference: string, expectedTree: 'record' | 'order' | 'pin',
    level: number, expectedCount: number): Promise<void> => {
    const key = `${reference}\0${expectedTree}\0${level}\0${expectedCount}`;
    if (checkedPages.has(key)) return;
    let page;
    try { page = checkStructurePage(await structureObject(objectDigest(reference))); }
    catch (error) {
      if (error instanceof InvalidStructureObject) {
        throw new ObjectRecoveryConflict('Structure page is corrupt', 'corrupt');
      }
      throw error;
    }
    if (page.tree !== expectedTree || page.level !== level) {
      throw new ObjectRecoveryConflict('Structure page tree differs from root', 'corrupt');
    }
    if (page.level === 0) {
      if (page.entries.length !== expectedCount) {
        throw new ObjectRecoveryConflict('Structure leaf count differs from root', 'corrupt');
      }
      checkedPages.add(key);
      return;
    }
    const children = page.entries as Array<{ page: string; count: number }>;
    if (children.reduce((sum, child) => sum + child.count, 0) !== expectedCount) {
      throw new ObjectRecoveryConflict('Structure branch count differs from root', 'corrupt');
    }
    for (const child of children) await tree(child.page, expectedTree, level - 1, child.count);
    checkedPages.add(key);
  };
  const structureManifest = async (digest: string, component?: string | null): Promise<void> => {
    const key = `${digest}\0${component ?? ''}`;
    if (checkedStructureRoots.has(key)) return;
    let manifest;
    try { manifest = checkStructureManifest(await structureObject(digest)); }
    catch (error) {
      if (error instanceof InvalidStructureObject) {
        throw new ObjectRecoveryConflict('Structure manifest is corrupt', 'corrupt');
      }
      throw error;
    }
    if (component && manifest.structure !== component) {
      throw new ObjectRecoveryConflict('Structure manifest differs from graph component', 'corrupt');
    }
    await tree(manifest.records.page, 'record', manifest.records.level, manifest.records.count);
    await tree(manifest.order.page, 'order', manifest.order.level, manifest.order.count);
    if (manifest.topGroups) {
      await tree(manifest.topGroups.page, 'order', manifest.topGroups.level, manifest.topGroups.count);
    }
    checkedStructureRoots.add(key);
  };
  // Unique Work manifests share payload promises; Structure's paged traversal
  // keeps its own serial validation. Refill each bounded worker immediately;
  // after a failure, stop scheduling and settle every read already started.
  const workDigests = [...new Set(references
    .filter(ref => ref.model !== 'https://rezics.com/definition/structure-composition-v1')
    .map(ref => ref.manifest.slice(-64)))];
  if (concurrency > 1) {
    let next = 0;
    let failed = false;
    const results = await Promise.allSettled(Array.from(
      { length: Math.min(concurrency, workDigests.length) }, async () => {
        while (!failed && next < workDigests.length) {
          const digest = workDigests[next++]!;
          try {
            const manifest = await manifestObject(digest);
            if (typeof manifest.payload === 'string' && /^sha256:[0-9a-f]{64}$/.test(manifest.payload))
              await payloadObject(manifest.payload.slice(7));
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  for (const ref of references) {
    referenceHash.update(record(ref));
    if (ref.graph === GRAPHS.revisions) {
      anchorHash.update(record(ref));
      anchorCount++;
    }
    const digest = ref.manifest.slice(-64);
    // Structure revisions and seals retain paged trees, not Work payload objects.
    if (ref.model === 'https://rezics.com/definition/structure-composition-v1') {
      const bytes = await structureObject(digest);
      let format: unknown;
      try { format = (JSON.parse(new TextDecoder().decode(bytes)) as { format?: unknown }).format; }
      catch { throw new ObjectRecoveryConflict('Structure root is corrupt', 'corrupt'); }
      if (format === STRUCTURE_SEAL_FORMAT) {
        let seal;
        try { seal = checkStructureSealManifest(bytes); }
        catch (error) {
          if (error instanceof InvalidStructureObject) {
            throw new ObjectRecoveryConflict('Structure seal manifest is corrupt', 'corrupt');
          }
          throw error;
        }
        await structureManifest(objectDigest(seal.structureManifest), seal.structure);
        await tree(seal.pins.page, 'pin', seal.pins.level, seal.pins.count);
      } else if (format === STRUCTURE_MANIFEST_FORMAT) {
        await structureManifest(digest, ref.component);
      } else throw new ObjectRecoveryConflict('Structure root format is unknown', 'corrupt');
      continue;
    }
    const manifest = await manifestObject(digest);
    // Model anchors name the logical owner; their immutable state belongs to
    // the exact generation, so both identities must match this retained anchor.
    const generationComponent = manifest.model === PROFILES.generation
      && ref.component === MODEL_COMPONENT && manifest.component === ref.subject;
    if (manifest.format !== 'rezics-manifest-v1' || manifest.mediaType !== 'application/json'
      || typeof manifest.component !== 'string' || !manifest.component
      || (ref.component !== null && manifest.component !== ref.component && !generationComponent)
      || (ref.model !== null && manifest.model !== ref.model)
      || (ref.shape !== null && manifest.shape !== ref.shape)
      || typeof manifest.model !== 'string' || typeof manifest.shape !== 'string'
      || typeof manifest.payload !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.payload)) {
      throw new ObjectRecoveryConflict('committed manifest differs from graph reference', 'corrupt');
    }
    const payload = await payloadObject(manifest.payload.slice(7));
    if (manifest.payloadBytes !== payload.length) {
      throw new ObjectRecoveryConflict('committed payload length differs', 'corrupt');
    }
    if (payload.format !== 'rezics-component-v1' || payload.component !== manifest.component
      || !payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) {
      throw new ObjectRecoveryConflict('committed payload differs from manifest', 'corrupt');
    }
    if (manifest.model === PROFILES.generation && !checkedModelGenerations.has(manifest.component)) {
      const state = payload.state as Record<string, unknown>;
      if (state.modelManifestSha256 !== manifest.component.slice(-64)
        || state.entailment !== 'none') {
        throw new ObjectRecoveryConflict('model generation payload differs from its anchor', 'corrupt');
      }
      try {
        const model = await visitModelGenerationArtifacts(manifest.component, key => exactBytes(store, key),
          (key, bytes) => { objects.set(key, bytes.length); retainedDigests?.add(key); });
        if (model.commandModule !== state.commandModule) {
          throw new ObjectRecoveryConflict('model generation command module differs', 'corrupt');
        }
      } catch (error) {
        if (error instanceof RevisionCorrupt) throw new ObjectRecoveryConflict(error.message, 'corrupt');
        throw error;
      }
      checkedModelGenerations.add(manifest.component);
    }
  }
  for (const digest of [...objects.keys()].sort()) {
    objectHash.update(record([digest, objects.get(digest)!]));
  }
  return { version: 1, referenceCount: String(references.length),
    referenceDigest: referenceHash.digest('hex'), anchorCount: String(anchorCount),
    anchorDigest: anchorHash.digest('hex'), objectCount: String(objects.size),
    objectDigest: objectHash.digest('hex') };
}

export async function assertObjectRecoveryCoverage(
  fuseki: FusekiClient, store: ObjectRecoveryStore, expected: ObjectRecoveryCoverage,
): Promise<void> {
  if (expected?.version !== 1 || !['referenceCount', 'anchorCount', 'objectCount']
    .every(key => /^(0|[1-9][0-9]*)$/.test(String(expected[key as keyof ObjectRecoveryCoverage])))
    || !['referenceDigest', 'anchorDigest', 'objectDigest']
      .every(key => SHA.test(String(expected[key as keyof ObjectRecoveryCoverage])))) {
    throw new ObjectRecoveryConflict('object recovery coverage is invalid');
  }
  const actual = await captureObjectRecoveryCoverage(fuseki, store);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ObjectRecoveryConflict('graph or immutable objects differ from recovery coverage');
  }
}
