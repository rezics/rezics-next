import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../../infrastructure/immutable-objects.ts';
import { GRAPHS, RV } from '../work/activate.ts';
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

/** One graph scan, O(Q) engine work and O(M log M) client sort for M manifest references. */
export async function graphObjectReferences(fuseki: FusekiClient): Promise<GraphObjectReference[]> {
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?graph ?subject ?manifest ?component ?model ?shape WHERE {
      GRAPH ?graph { ?subject rv:manifest ?manifest .
        OPTIONAL { ?subject rv:component ?component }
        OPTIONAL { ?subject rv:modelRevision ?model }
        OPTIONAL { ?subject rv:shapeRevision ?shape }
      }
    }`);
  if (!result.results?.bindings) throw new ObjectRecoveryConflict('graph object reference scan is incomplete');
  const references = result.results.bindings.map(row => {
    if (row.graph?.type !== 'uri' || row.subject?.type !== 'uri'
      || row.manifest?.type !== 'uri' || (row.component && row.component.type !== 'uri')
      || (row.model && row.model.type !== 'uri') || (row.shape && row.shape.type !== 'uri')) {
      throw new ObjectRecoveryConflict('graph object reference is not an IRI');
    }
    return { graph: row.graph.value, subject: row.subject.value,
      manifest: row.manifest.value, component: row.component?.value ?? null,
      model: row.model?.value ?? null, shape: row.shape?.value ?? null };
  });
  for (const reference of references) {
    if (!reference.graph || !reference.subject || !MANIFEST.test(reference.manifest)
      || (reference.component !== null && !reference.component)
      || (reference.model !== null && !reference.model)
      || (reference.shape !== null && !reference.shape)) {
      throw new ObjectRecoveryConflict('graph object reference is malformed');
    }
  }
  references.sort((a, b) => record(a).localeCompare(record(b)));
  return references;
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
  const references = await graphObjectReferences(fuseki);
  const referenceHash = createHash('sha256');
  const anchorHash = createHash('sha256');
  const objectHash = createHash('sha256');
  let anchorCount = 0;
  const objects = new Map<string, number>();
  const manifests = new Map<string, Record<string, unknown>>();
  const payloads = new Map<string, ParsedPayload>();
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
    const bytes = await exactBytes(store, digest);
    let body: Record<string, unknown>;
    try { body = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
    catch { throw new ObjectRecoveryConflict('committed payload is corrupt', 'corrupt'); }
    const parsed = { length: bytes.length, component: body.component,
      format: body.format, state: body.state };
    objects.set(digest, bytes.length);
    retainedDigests?.add(digest);
    payloads.set(digest, parsed);
    return parsed;
  };
  const structureObject = async (digest: string): Promise<Uint8Array> => {
    const bytes = await exactBytes(store, digest, 'structure');
    objects.set(digest, bytes.length);
    retainedDigests?.add(digest);
    return bytes;
  };
  const checkedPages = new Set<string>();
  const checkedStructureRoots = new Set<string>();
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
    checkedStructureRoots.add(key);
  };
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
    if (manifest.format !== 'rezics-manifest-v1' || manifest.mediaType !== 'application/json'
      || typeof manifest.component !== 'string' || !manifest.component
      || (ref.component !== null && manifest.component !== ref.component)
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
