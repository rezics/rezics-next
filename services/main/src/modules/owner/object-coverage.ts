import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fusekiReadBudget, type FusekiClient } from '../../infrastructure/fuseki.ts';
import {
  ObjectIntegrityError,
  ObjectReadBudgetExceeded,
  ObjectUnavailable,
  type ImmutableObjects,
} from '../../infrastructure/immutable-objects.ts';
import { GRAPHS, RV } from '../work/activate.ts';
import { RevisionCorrupt } from '../work/history.ts';
import { visitModelGenerationArtifacts } from '../semantic/model-custody.ts';
import { MODEL_COMPONENT, PROFILES } from '../semantic/schema.ts';
import {
  checkStructureManifest,
  checkStructurePage,
  checkStructureSealManifest,
  InvalidStructureObject,
  STRUCTURE_LIMITS,
  STRUCTURE_MANIFEST_FORMAT,
  STRUCTURE_INDEXED_MANIFEST_FORMAT,
  STRUCTURE_SEAL_FORMAT,
  type OccurrenceRecord,
  type StructureManifest,
  type StructurePage,
} from '../structure/format.ts';
import { placementIri, structureIri } from '../structure/graph.ts';
import { StructureObjectCorrupt } from '../structure/tree.ts';
import type { StructureGroupRootStore } from '../structure/group-root.ts';
import {
  qualifierSourceRoot,
  type StructureQualifierRootStore,
} from '../structure/qualifier-index.ts';
export class ObjectRecoveryConflict extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'corrupt' | 'mismatch' = 'mismatch',
  ) {
    super(message);
  }
}

export interface ObjectRecoveryStore {
  directory: string;
  workObjects?: ImmutableObjects;
  structureObjects?: ImmutableObjects;
  /** Supplemental custody includes incomplete preparation roots, too. */
  structureGroupRoots?: Pick<StructureGroupRootStore, 'retainedRoots'>;
  structureQualifierRoots?: Pick<StructureQualifierRootStore, 'retainedRoots'>;
  /** Maintenance commands may overlap a bounded window of immutable reads. */
  readConcurrency?: number;
  /** Opt-in qualification under held, quiesced owner custody. Failure means
   * association unavailable; it is never evidence of an absent Episode key. */
  originalStructureAssociations?: {
    signal: AbortSignal;
    deadline: number;
    /** Physical placement predicate probes; Fuseki calls share this bound too. */
    maxProbes: number;
    /** Structure immutable bytes and Fuseki responses, including the original cut. */
    maxBytes: number;
  };
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
  if (!result.results?.bindings)
    throw new ObjectRecoveryConflict('graph object reference scan is incomplete');
  const references = result.results.bindings.map((row) => {
    if (row.graph?.type !== 'uri' || row.subject?.type !== 'uri' || row.manifest?.type !== 'uri') {
      throw new ObjectRecoveryConflict('graph object reference is not an IRI');
    }
    return { graph: row.graph.value, subject: row.subject.value, manifest: row.manifest.value };
  });
  const identity = (graph: string, subject: string) => JSON.stringify([graph, subject]);
  const subjects = new Set(references.map((ref) => identity(ref.graph, ref.subject)));
  const fields = new Map<string, Map<string, string[]>>();
  for (const [field, predicate] of [
    ['component', 'component'],
    ['model', 'modelRevision'],
    ['shape', 'shapeRevision'],
  ] as const) {
    const scanned = await fuseki.query(`PREFIX rv: <${RV}>
      SELECT ?graph ?subject ?value WHERE {
        { GRAPH ?graph { ?subject rv:${predicate} ?value } }
        UNION { ?subject rv:${predicate} ?value . BIND(<urn:x-arq:DefaultGraphNode> AS ?graph) }
      }`);
    if (!scanned.results?.bindings)
      throw new ObjectRecoveryConflict('graph object reference scan is incomplete');
    const values = new Map<string, string[]>();
    for (const row of scanned.results.bindings) {
      const key = identity(row.graph?.value ?? '', row.subject?.value ?? '');
      if (!subjects.has(key)) continue;
      if (row.value?.type !== 'uri')
        throw new ObjectRecoveryConflict('graph object reference is not an IRI');
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
    if (
      !reference.graph ||
      !reference.subject ||
      !MANIFEST.test(reference.manifest) ||
      (reference.component !== null && !reference.component) ||
      (reference.model !== null && !reference.model) ||
      (reference.shape !== null && !reference.shape)
    ) {
      throw new ObjectRecoveryConflict('graph object reference is malformed');
    }
  }
  expanded.sort((a, b) => record(a).localeCompare(record(b)));
  return expanded;
}

async function exactBytes(
  store: ObjectRecoveryStore,
  digest: string,
  kind: 'work' | 'structure' = 'work',
  structureByteCap: number = STRUCTURE_LIMITS.pageBytes,
): Promise<Buffer> {
  if (!SHA.test(digest)) throw new ObjectRecoveryConflict('immutable object digest is malformed');
  if (kind === 'structure') {
    if (!store.structureObjects) {
      throw new ObjectRecoveryConflict(
        'Structure immutable object owner is unavailable',
        'unavailable',
      );
    }
    const signal = fusekiReadBudget.getStore()?.signal;
    signal?.throwIfAborted();
    try {
      // Undefined retains the object's configured maintenance deadline signal.
      // Association turns pass the bytes still left; ordinary capture keeps one page.
      const bytes = await store.structureObjects.get(digest, structureByteCap, signal);
      signal?.throwIfAborted();
      if (bytes.length > structureByteCap || bytes.length > STRUCTURE_LIMITS.pageBytes)
        throw new ObjectReadBudgetExceeded('Structure object exceeds its byte bound');
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof ObjectReadBudgetExceeded) {
        throw new ObjectRecoveryConflict(
          'Structure immutable object exceeds its byte bound',
          'corrupt',
        );
      }
      if (error instanceof ObjectIntegrityError) {
        throw new ObjectRecoveryConflict('Structure immutable object is corrupt', 'corrupt');
      }
      if (error instanceof ObjectUnavailable) {
        throw new ObjectRecoveryConflict(
          'Structure immutable object is unavailable',
          'unavailable',
        );
      }
      throw error;
    }
  }
  const signal = store.originalStructureAssociations
    ? fusekiReadBudget.getStore()?.signal
    : undefined;
  signal?.throwIfAborted();
  if (store.workObjects) {
    try {
      const bytes = signal
        ? await store.workObjects.get(digest, undefined, signal)
        : await store.workObjects.get(digest);
      signal?.throwIfAborted();
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof ObjectIntegrityError)
        throw new ObjectRecoveryConflict('immutable object is corrupt', 'corrupt');
      if (!(error instanceof ObjectUnavailable)) throw error;
    }
  }
  let bytes: Buffer;
  try {
    bytes = signal
      ? await readFile(join(store.directory, digest), { signal })
      : await readFile(join(store.directory, digest));
  } catch {
    signal?.throwIfAborted();
    throw new ObjectRecoveryConflict('committed immutable object is unavailable', 'unavailable');
  }
  signal?.throwIfAborted();
  if (sha(bytes) !== digest)
    throw new ObjectRecoveryConflict('committed immutable object is corrupt', 'corrupt');
  return bytes;
}

/** Capture the complete owner object cut while writers are quiesced.
 * Work shares manifest/payload reads; Structure validates each original anchor
 * and walks every retained original and supplemental page, caching checked
 * pages. Total work scales with all references, closure pages and their bytes;
 * the per-object byte cap does not bound the full capture to a prefix. */
export async function captureObjectRecoveryCoverage(
  fuseki: FusekiClient,
  store: ObjectRecoveryStore,
  retainedDigests?: Set<string>,
): Promise<ObjectRecoveryCoverage> {
  const qualification = store?.originalStructureAssociations;
  if (!qualification) return captureCoverage(fuseki, store, retainedDigests);
  const remaining = qualification.deadline - Date.now();
  if (
    !Number.isSafeInteger(qualification.deadline) ||
    !Number.isSafeInteger(qualification.maxProbes) ||
    qualification.maxProbes < 1 ||
    !Number.isSafeInteger(qualification.maxBytes) ||
    qualification.maxBytes < 1 ||
    !qualification.signal
  )
    throw new ObjectRecoveryConflict('Structure association budget is invalid');
  qualification.signal.throwIfAborted();
  if (remaining <= 0)
    throw new ObjectRecoveryConflict('Structure association deadline expired', 'unavailable');
  const outer = fusekiReadBudget.getStore();
  const signal = AbortSignal.any([
    qualification.signal,
    AbortSignal.timeout(Math.min(remaining, 2_147_483_647)),
    ...(outer ? [outer.signal] : []),
  ]);
  let calls = qualification.maxProbes,
    bytes = qualification.maxBytes;
  // Share upstream consumption without replacing its signal for other readers.
  const budget = {
    signal,
    get callsLeft() {
      return Math.min(calls, outer?.callsLeft ?? Infinity);
    },
    set callsLeft(value: number) {
      const used = this.callsLeft - value;
      calls -= used;
      if (outer) outer.callsLeft -= used;
    },
    get bytesLeft() {
      return Math.min(bytes, outer?.bytesLeft ?? Infinity);
    },
    set bytesLeft(value: number) {
      const used = this.bytesLeft - value;
      bytes -= used;
      if (outer) outer.bytesLeft -= used;
    },
  };
  const coverage = await fusekiReadBudget.run(budget, () =>
    captureCoverage(fuseki, store, retainedDigests),
  );
  signal.throwIfAborted();
  if (Date.now() >= qualification.deadline)
    throw new ObjectRecoveryConflict('Structure association deadline expired', 'unavailable');
  return coverage;
}

async function captureCoverage(
  fuseki: FusekiClient,
  store: ObjectRecoveryStore,
  retainedDigests?: Set<string>,
): Promise<ObjectRecoveryCoverage> {
  fusekiReadBudget.getStore()?.signal.throwIfAborted();
  if (!store?.directory) throw new ObjectRecoveryConflict('immutable object owner is unavailable');
  if (store.structureObjects && (!store.structureGroupRoots || !store.structureQualifierRoots)) {
    throw new ObjectRecoveryConflict(
      'Structure supplemental custody owner is unavailable',
      'unavailable',
    );
  }
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
  const manifestObject = async (
    digest: string,
    kind: 'work' | 'structure' = 'work',
  ): Promise<Record<string, unknown>> => {
    const cached = manifests.get(digest);
    if (cached) return cached;
    const bytes = await exactBytes(store, digest, kind);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new ObjectRecoveryConflict('committed manifest is corrupt', 'corrupt');
    }
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
      try {
        body = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      } catch {
        throw new ObjectRecoveryConflict('committed payload is corrupt', 'corrupt');
      }
      const parsed = {
        length: bytes.length,
        component: body.component,
        format: body.format,
        state: body.state,
      };
      objects.set(digest, bytes.length);
      retainedDigests?.add(digest);
      return parsed;
    })();
    payloads.set(digest, pending);
    return pending;
  };
  const structureObject = async (digest: string): Promise<Uint8Array> => {
    let bytes: Buffer;
    if (qualification) {
      if (Date.now() >= qualification.deadline)
        throw new ObjectRecoveryConflict('Structure association deadline expired', 'unavailable');
      const budget = fusekiReadBudget.getStore()!;
      const remaining = budget.bytesLeft;
      // Stop before the store read once this turn has nothing left to spend.
      if (!Number.isSafeInteger(remaining) || remaining < 1)
        throw new ObjectRecoveryConflict(
          'Structure association byte budget exceeded',
          'unavailable',
        );
      const cap = Math.min(STRUCTURE_LIMITS.pageBytes, remaining);
      try {
        bytes = await exactBytes(store, digest, 'structure', cap);
      } catch (error) {
        // A short cap is the turn remainder, not proof the object exceeds one page.
        if (
          cap < STRUCTURE_LIMITS.pageBytes &&
          error instanceof ObjectRecoveryConflict &&
          error.kind === 'corrupt' &&
          error.message === 'Structure immutable object exceeds its byte bound'
        ) {
          throw new ObjectRecoveryConflict(
            'Structure association byte budget exceeded',
            'unavailable',
          );
        }
        throw error;
      }
      if (Date.now() >= qualification.deadline)
        throw new ObjectRecoveryConflict('Structure association deadline expired', 'unavailable');
      if (bytes.length > budget.bytesLeft)
        throw new ObjectRecoveryConflict(
          'Structure association byte budget exceeded',
          'unavailable',
        );
      budget.bytesLeft -= bytes.length;
    } else bytes = await exactBytes(store, digest, 'structure');
    objects.set(digest, bytes.length);
    retainedDigests?.add(digest);
    return bytes;
  };
  const checkedPages = new Set<string>();
  const decodedPages = new Map<string, StructurePage>();
  const qualification = store.originalStructureAssociations;
  let probesLeft = qualification?.maxProbes ?? 0;
  const associations = async (manifest: StructureManifest, entries: OccurrenceRecord[]) => {
    for (let start = 0; start < entries.length; start += 256) {
      const budget = fusekiReadBudget.getStore()!;
      const signal = budget.signal;
      signal.throwIfAborted();
      const batch = entries.slice(start, start + 256);
      // Each fixed subject has three independent predicate probes. Do not bind
      // expected objects: doing so would hide a second, conflicting value.
      if (batch.length * 3 > probesLeft)
        throw new ObjectRecoveryConflict(
          'Structure association probe budget exceeded',
          'unavailable',
        );
      probesLeft -= batch.length * 3;
      if (budget.bytesLeft < 1)
        throw new ObjectRecoveryConflict(
          'Structure association byte budget exceeded',
          'unavailable',
        );
      const expected = new Map(
        batch.map((entry) => [placementIri(manifest.generation, entry.occurrence), entry]),
      );
      if (expected.size !== batch.length)
        throw new ObjectRecoveryConflict(
          'Structure original association repeats a placement',
          'unavailable',
        );
      const bytesBefore = budget.bytesLeft;
      // Constant subjects in every branch keep these physical point reads;
      // qualification does not depend on VALUES being pushed through a UNION.
      const points = [...expected.keys()].map((placement) => {
        const subject = structureIri(placement);
        return `{ BIND(${subject} AS ?placement)
          { ${subject} rv:generation ?value . BIND("generation" AS ?field) }
          UNION { ${subject} rv:occurrence ?value . BIND("occurrence" AS ?field) }
          UNION { ${subject} schema:item ?value . BIND("target" AS ?field) }
        }`;
      });
      const query = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        SELECT ?placement ?field ?value WHERE {
          GRAPH ${structureIri(GRAPHS.current)} {
            ${points.join('\n UNION ')}
          }
        } LIMIT ${batch.length * 3 + 1}`;
      if (Buffer.byteLength(query) > 256 * 1024)
        throw new ObjectRecoveryConflict(
          'Structure association request exceeds its byte bound',
          'unavailable',
        );
      const response = await fuseki.query(query, Math.min(bytesBefore, 256 * 1024));
      signal.throwIfAborted();
      // Fuseki charges actual streamed bytes. In-process adapters also have to
      // account for their response, without charging the HTTP client twice.
      if (budget.bytesLeft === bytesBefore) {
        const responseBytes = Buffer.byteLength(JSON.stringify(response));
        if (responseBytes > Math.min(bytesBefore, 256 * 1024))
          throw new ObjectRecoveryConflict(
            'Structure association byte budget exceeded',
            'unavailable',
          );
        budget.bytesLeft -= responseBytes;
      }
      const rows = response.results?.bindings;
      if (!rows || rows.length > batch.length * 3)
        throw new ObjectRecoveryConflict(
          'Structure association response is incomplete or ambiguous',
          'unavailable',
        );
      const found = new Map<string, Map<string, string[]>>();
      for (const row of rows) {
        if (
          row.placement?.type !== 'uri' ||
          !expected.has(row.placement.value) ||
          row.field?.type !== 'literal' ||
          !['generation', 'occurrence', 'target'].includes(row.field.value) ||
          row.value?.type !== 'uri'
        )
          throw new ObjectRecoveryConflict(
            'Structure association identity is malformed',
            'unavailable',
          );
        const fields = found.get(row.placement.value) ?? new Map<string, string[]>();
        const values = fields.get(row.field.value) ?? [];
        values.push(row.value.value);
        fields.set(row.field.value, values);
        found.set(row.placement.value, fields);
      }
      for (const [placement, entry] of expected) {
        for (const [field, value] of [
          ['generation', manifest.generation],
          ['occurrence', entry.occurrence],
          ['target', entry.target],
        ] as const) {
          if (value === undefined) continue;
          const values = found.get(placement)?.get(field);
          if (values?.length !== 1 || values[0] !== value)
            throw new ObjectRecoveryConflict(
              'Structure original association is unavailable or differs from its record',
              'unavailable',
            );
        }
      }
    }
  };
  const checkedStructureRoots = new Set<string>();
  const checkedModelGenerations = new Set<string>();
  const objectDigest = (reference: string): string => {
    const digest = OBJECT.exec(reference)?.[1];
    if (!digest)
      throw new ObjectRecoveryConflict('Structure object reference is malformed', 'corrupt');
    return digest;
  };
  const tree = async (
    reference: string,
    expectedTree: 'record' | 'order' | 'pin' | 'qualifier-key',
    level: number,
    expectedCount: number,
    association?: StructureManifest,
  ): Promise<void> => {
    const key = `${reference}\0${expectedTree}\0${level}\0${expectedCount}\0${association ? `${association.structure}\0${association.generation}` : ''}`;
    if (checkedPages.has(key)) return;
    let page;
    try {
      page = decodedPages.get(reference);
      if (!page) {
        page = checkStructurePage(await structureObject(objectDigest(reference)));
        if (qualification) decodedPages.set(reference, page);
      }
    } catch (error) {
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
      if (association) await associations(association, page.entries as OccurrenceRecord[]);
      checkedPages.add(key);
      return;
    }
    const children = page.entries as Array<{ page: string; count: number }>;
    if (children.reduce((sum, child) => sum + child.count, 0) !== expectedCount) {
      throw new ObjectRecoveryConflict('Structure branch count differs from root', 'corrupt');
    }
    for (const child of children)
      await tree(child.page, expectedTree, level - 1, child.count, association);
    checkedPages.add(key);
  };
  const structureManifest = async (
    digest: string,
    component?: string | null,
    original?: GraphObjectReference,
    suppliedBytes?: Uint8Array,
  ): Promise<void> => {
    const key = `${digest}\0${component ?? ''}`;
    if (checkedStructureRoots.has(key) && !original) return;
    let manifest;
    try {
      manifest = checkStructureManifest(suppliedBytes ?? (await structureObject(digest)));
    } catch (error) {
      if (error instanceof InvalidStructureObject) {
        throw new ObjectRecoveryConflict('Structure manifest is corrupt', 'corrupt');
      }
      throw error;
    }
    if (component && manifest.structure !== component) {
      throw new ObjectRecoveryConflict(
        'Structure manifest differs from graph component',
        'corrupt',
      );
    }
    if (manifest.order.count !== manifest.placementCount) {
      throw new ObjectRecoveryConflict(
        'Structure order count differs from placement count',
        'corrupt',
      );
    }
    if (original) {
      // Check every graph/anchor even when its shared immutable closure was
      // already visited. Historical identity never follows today's generation.
      const terms = `?subject a rv:StructureRevision ; rv:manifest ?manifest ;
        rv:component ?component ; rv:generation ?generation ; rv:placementCount ?count .`;
      const scoped =
        original.graph === 'urn:x-arq:DefaultGraphNode'
          ? terms
          : `BIND(IRI(${JSON.stringify(original.graph)}) AS ?graph) GRAPH ?graph { ${terms} }`;
      const rows = (
        await fuseki.query(`PREFIX rv: <${RV}>
        SELECT ?manifest ?component ?generation ?count WHERE {
          BIND(IRI(${JSON.stringify(original.subject)}) AS ?subject) ${scoped}
        } LIMIT 2`)
      ).results?.bindings;
      const row = rows?.[0];
      if (
        !rows ||
        rows.length !== 1 ||
        row?.manifest?.type !== 'uri' ||
        row.component?.type !== 'uri' ||
        row.generation?.type !== 'uri' ||
        row.count?.type !== 'literal' ||
        !/^(0|[1-9][0-9]*)$/.test(row.count.value) ||
        row.manifest.value !== original.manifest ||
        row.component.value !== manifest.structure ||
        row.generation.value !== manifest.generation ||
        Number(row.count.value) !== manifest.placementCount ||
        (original.model !== null && original.model !== manifest.model) ||
        (original.shape !== null && original.shape !== manifest.shape)
      ) {
        throw new ObjectRecoveryConflict(
          'Structure manifest differs from original revision descriptor',
          'corrupt',
        );
      }
    }
    if (original && qualification)
      await tree(
        manifest.records.page,
        'record',
        manifest.records.level,
        manifest.records.count,
        manifest,
      );
    if (checkedStructureRoots.has(key)) return;
    await tree(manifest.records.page, 'record', manifest.records.level, manifest.records.count);
    await tree(manifest.order.page, 'order', manifest.order.level, manifest.order.count);
    if (manifest.topGroups) {
      await tree(
        manifest.topGroups.page,
        'order',
        manifest.topGroups.level,
        manifest.topGroups.count,
      );
    }
    if (manifest.format === STRUCTURE_INDEXED_MANIFEST_FORMAT) {
      if (manifest.qualifierKeys.sourceRoot !== qualifierSourceRoot(manifest))
        throw new ObjectRecoveryConflict('Qualifier root differs from source', 'corrupt');
      await tree(
        manifest.qualifierKeys.root.page,
        'qualifier-key',
        manifest.qualifierKeys.root.level,
        manifest.qualifierKeys.root.count,
      );
    }
    checkedStructureRoots.add(key);
  };
  // Unique Work manifests share payload promises; Structure's paged traversal
  // keeps its own serial validation. Refill each bounded worker immediately;
  // after a failure, stop scheduling and settle every read already started.
  const workDigests = [
    ...new Set(
      references
        .filter((ref) => ref.model !== 'https://rezics.com/definition/structure-composition-v1')
        .map((ref) => ref.manifest.slice(-64)),
    ),
  ];
  if (concurrency > 1) {
    let next = 0;
    let failed = false;
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, workDigests.length) }, async () => {
        while (!failed && next < workDigests.length) {
          const digest = workDigests[next++]!;
          try {
            const manifest = await manifestObject(digest);
            if (
              typeof manifest.payload === 'string' &&
              /^sha256:[0-9a-f]{64}$/.test(manifest.payload)
            )
              await payloadObject(manifest.payload.slice(7));
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
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
      try {
        format = (JSON.parse(new TextDecoder().decode(bytes)) as { format?: unknown }).format;
      } catch {
        throw new ObjectRecoveryConflict('Structure root is corrupt', 'corrupt');
      }
      if (format === STRUCTURE_SEAL_FORMAT) {
        let seal;
        try {
          seal = checkStructureSealManifest(bytes);
        } catch (error) {
          if (error instanceof InvalidStructureObject) {
            throw new ObjectRecoveryConflict('Structure seal manifest is corrupt', 'corrupt');
          }
          throw error;
        }
        await structureManifest(objectDigest(seal.structureManifest), seal.structure);
        await tree(seal.pins.page, 'pin', seal.pins.level, seal.pins.count);
      } else if (
        format === STRUCTURE_MANIFEST_FORMAT ||
        format === STRUCTURE_INDEXED_MANIFEST_FORMAT
      ) {
        await structureManifest(digest, ref.component, ref, bytes);
      } else throw new ObjectRecoveryConflict('Structure root format is unknown', 'corrupt');
      continue;
    }
    const manifest = await manifestObject(digest);
    // Model anchors name the logical owner; their immutable state belongs to
    // the exact generation, so both identities must match this retained anchor.
    const generationComponent =
      manifest.model === PROFILES.generation &&
      ref.component === MODEL_COMPONENT &&
      manifest.component === ref.subject;
    if (
      manifest.format !== 'rezics-manifest-v1' ||
      manifest.mediaType !== 'application/json' ||
      typeof manifest.component !== 'string' ||
      !manifest.component ||
      (ref.component !== null && manifest.component !== ref.component && !generationComponent) ||
      (ref.model !== null && manifest.model !== ref.model) ||
      (ref.shape !== null && manifest.shape !== ref.shape) ||
      typeof manifest.model !== 'string' ||
      typeof manifest.shape !== 'string' ||
      typeof manifest.payload !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(manifest.payload)
    ) {
      throw new ObjectRecoveryConflict(
        'committed manifest differs from graph reference',
        'corrupt',
      );
    }
    const payload = await payloadObject(manifest.payload.slice(7));
    if (manifest.payloadBytes !== payload.length) {
      throw new ObjectRecoveryConflict('committed payload length differs', 'corrupt');
    }
    if (
      payload.format !== 'rezics-component-v1' ||
      payload.component !== manifest.component ||
      !payload.state ||
      typeof payload.state !== 'object' ||
      Array.isArray(payload.state)
    ) {
      throw new ObjectRecoveryConflict('committed payload differs from manifest', 'corrupt');
    }
    if (
      manifest.model === PROFILES.generation &&
      !checkedModelGenerations.has(manifest.component)
    ) {
      const state = payload.state as Record<string, unknown>;
      if (
        state.modelManifestSha256 !== manifest.component.slice(-64) ||
        state.entailment !== 'none'
      ) {
        throw new ObjectRecoveryConflict(
          'model generation payload differs from its anchor',
          'corrupt',
        );
      }
      try {
        const model = await visitModelGenerationArtifacts(
          manifest.component,
          (key) => exactBytes(store, key),
          (key, bytes) => {
            objects.set(key, bytes.length);
            retainedDigests?.add(key);
          },
        );
        if (model.commandModule !== state.commandModule) {
          throw new ObjectRecoveryConflict('model generation command module differs', 'corrupt');
        }
      } catch (error) {
        if (error instanceof RevisionCorrupt)
          throw new ObjectRecoveryConflict(error.message, 'corrupt');
        throw error;
      }
      checkedModelGenerations.add(manifest.component);
    }
  }
  // The graph continues to name the original authored manifest. Content rows
  // retain its supplemental root and cursor; pending roots must survive the
  // same backup/GC cut as completed ones, and row loss must fail restore.
  let prepared;
  try {
    prepared = store.structureGroupRoots ? await store.structureGroupRoots.retainedRoots() : [];
    if (!Array.isArray(prepared))
      throw new Error('Structure group custody returned no retained cut');
  } catch (error) {
    throw new ObjectRecoveryConflict(
      'Structure group custody owner is unavailable or corrupt',
      error instanceof StructureObjectCorrupt ? 'corrupt' : 'unavailable',
    );
  }
  prepared.sort((a, b) =>
    a.manifestDigest < b.manifestDigest ? -1 : a.manifestDigest > b.manifestDigest ? 1 : 0,
  );
  for (const checkpoint of prepared) {
    let source;
    try {
      source = checkStructureManifest(await structureObject(checkpoint.manifestDigest));
    } catch (error) {
      if (error instanceof InvalidStructureObject) {
        throw new ObjectRecoveryConflict('prepared group source manifest is corrupt', 'corrupt');
      }
      throw error;
    }
    const same = (a: typeof checkpoint.records, b: typeof checkpoint.records) =>
      a.page === b.page && a.level === b.level && a.count === b.count;
    if (
      source.structure !== checkpoint.structure ||
      source.profile !== 'book-composition' ||
      !same(source.records, checkpoint.records) ||
      !same(source.order, checkpoint.order)
    ) {
      throw new ObjectRecoveryConflict(
        'prepared group root differs from original manifest',
        'corrupt',
      );
    }
    referenceHash.update(record(['structure-group-root', checkpoint]));
    await structureManifest(checkpoint.manifestDigest, checkpoint.structure);
    await tree(checkpoint.groups.page, 'order', checkpoint.groups.level, checkpoint.groups.count);
  }
  // The signed reference cut includes both checkpoint mapping and derived pages.
  // Loss of a restored Content row changes the cut even while original bytes remain.
  let preparedQualifiers;
  try {
    preparedQualifiers = store.structureQualifierRoots
      ? await store.structureQualifierRoots.retainedRoots()
      : [];
    if (!Array.isArray(preparedQualifiers))
      throw new Error('Qualifier custody returned no retained cut');
  } catch (error) {
    throw new ObjectRecoveryConflict(
      'Qualifier custody is unavailable or corrupt',
      error instanceof StructureObjectCorrupt ? 'corrupt' : 'unavailable',
    );
  }
  preparedQualifiers.sort((a, b) => a.manifestDigest.localeCompare(b.manifestDigest));
  for (const checkpoint of preparedQualifiers) {
    const source = checkStructureManifest(await structureObject(checkpoint.manifestDigest));
    if (checkpoint.sourceRoot !== qualifierSourceRoot(source))
      throw new ObjectRecoveryConflict(
        'Qualifier checkpoint differs from original source',
        'corrupt',
      );
    referenceHash.update(record(['structure-qualifier-root', checkpoint]));
    await structureManifest(checkpoint.manifestDigest, source.structure);
    await tree(
      checkpoint.progress.root.page,
      'qualifier-key',
      checkpoint.progress.root.level,
      checkpoint.progress.root.count,
    );
  }
  for (const digest of [...objects.keys()].sort()) {
    objectHash.update(record([digest, objects.get(digest)!]));
  }
  // An empty final custody query can finish after cancellation without a GET.
  fusekiReadBudget.getStore()?.signal.throwIfAborted();
  return {
    version: 1,
    referenceCount: String(references.length + prepared.length + preparedQualifiers.length),
    referenceDigest: referenceHash.digest('hex'),
    anchorCount: String(anchorCount),
    anchorDigest: anchorHash.digest('hex'),
    objectCount: String(objects.size),
    objectDigest: objectHash.digest('hex'),
  };
}

export async function assertObjectRecoveryCoverage(
  fuseki: FusekiClient,
  store: ObjectRecoveryStore,
  expected: ObjectRecoveryCoverage,
): Promise<void> {
  if (
    expected?.version !== 1 ||
    !['referenceCount', 'anchorCount', 'objectCount'].every((key) =>
      /^(0|[1-9][0-9]*)$/.test(String(expected[key as keyof ObjectRecoveryCoverage])),
    ) ||
    !['referenceDigest', 'anchorDigest', 'objectDigest'].every((key) =>
      SHA.test(String(expected[key as keyof ObjectRecoveryCoverage])),
    )
  ) {
    throw new ObjectRecoveryConflict('object recovery coverage is invalid');
  }
  const actual = await captureObjectRecoveryCoverage(fuseki, store);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ObjectRecoveryConflict('graph or immutable objects differ from recovery coverage');
  }
}
