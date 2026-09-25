import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { DATASET, GRAPHS, PROFILE, hash, iri, type WorkActivationEnvironment } from './activate.ts';

export class RevisionNotFound extends Error {}
export class RevisionUnavailable extends Error {}
export class RevisionCorrupt extends Error {}

export interface ExactWorkRevision {
  revision: string;
  work: string;
  predecessor?: string;
  operation: string;
  mainVersion: string;
  title: string;
  language: 'en';
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

export interface ExactMainRevision {
  revision: string;
  mainVersion: string;
  work: string;
  predecessor?: string;
  operation: string;
  hostingPolicy: 'metadata-only';
  defaultSelection: string | null;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

export interface MainPayload {
  work: string;
  hostingPolicy: 'metadata-only';
  defaultSelection: string | null;
  predecessor: string | null;
}

export interface WorkPayload {
  mainVersion: string;
  title: string;
  language: 'en';
}

function objectBytes(directory: string, digest: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new RevisionCorrupt('invalid immutable object reference');
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(directory, digest));
  } catch {
    throw new RevisionUnavailable('committed revision bytes are unavailable');
  }
  if (hash(bytes) !== digest) throw new RevisionCorrupt('immutable object digest differs');
  return bytes;
}

export function readComponentState(
  objectDirectory: string, manifestIri: string, component: string, profile = PROFILE,
): Record<string, unknown> {
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifestIri)) throw new RevisionCorrupt('invalid manifest reference');
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(objectBytes(objectDirectory, manifestIri.slice(-64)).toString('utf8')); }
  catch (error) { if (error instanceof RevisionUnavailable || error instanceof RevisionCorrupt) throw error;
    throw new RevisionCorrupt('manifest is not JSON'); }
  if (manifest.format !== 'rezics-manifest-v1' || manifest.component !== component
    || manifest.model !== profile || manifest.shape !== profile
    || manifest.mediaType !== 'application/json'
    || typeof manifest.payload !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.payload)) {
    throw new RevisionCorrupt('manifest does not match revision');
  }
  const payload = objectBytes(objectDirectory, manifest.payload.slice(7));
  if (manifest.payloadBytes !== payload.length) throw new RevisionCorrupt('payload byte count differs');
  let stored: Record<string, unknown>;
  try { stored = JSON.parse(payload.toString('utf8')); }
  catch { throw new RevisionCorrupt('payload is not JSON'); }
  const state = stored.state as Record<string, unknown> | undefined;
  if (stored.format !== 'rezics-component-v1' || stored.component !== component || !state
    || Array.isArray(state)) throw new RevisionCorrupt('payload does not match component profile');
  return state;
}

async function storedObjectBytes(objects: ImmutableObjects, digest: string): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new RevisionCorrupt('invalid immutable object reference');
  try { return Buffer.from(await objects.get(digest)); }
  catch (error) {
    if (error instanceof ObjectIntegrityError) throw new RevisionCorrupt(error.message);
    if (error instanceof ObjectUnavailable) throw new RevisionUnavailable(error.message);
    throw error;
  }
}

async function readComponentStateFromObjects(
  objects: ImmutableObjects, manifestIri: string, component: string, profile = PROFILE,
): Promise<Record<string, unknown>> {
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifestIri)) throw new RevisionCorrupt('invalid manifest reference');
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse((await storedObjectBytes(objects, manifestIri.slice(-64))).toString('utf8')); }
  catch (error) { if (error instanceof RevisionUnavailable || error instanceof RevisionCorrupt) throw error;
    throw new RevisionCorrupt('manifest is not JSON'); }
  if (manifest.format !== 'rezics-manifest-v1' || manifest.component !== component
    || manifest.model !== profile || manifest.shape !== profile
    || manifest.mediaType !== 'application/json'
    || typeof manifest.payload !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.payload)) {
    throw new RevisionCorrupt('manifest does not match revision');
  }
  const payload = await storedObjectBytes(objects, manifest.payload.slice(7));
  if (manifest.payloadBytes !== payload.length) throw new RevisionCorrupt('payload byte count differs');
  let stored: Record<string, unknown>;
  try { stored = JSON.parse(payload.toString('utf8')); }
  catch { throw new RevisionCorrupt('payload is not JSON'); }
  const state = stored.state as Record<string, unknown> | undefined;
  if (stored.format !== 'rezics-component-v1' || stored.component !== component || !state
    || Array.isArray(state)) throw new RevisionCorrupt('payload does not match component profile');
  return state;
}

/** New Work revisions use S3; exact verified filesystem bytes remain a migration read. */
export async function readWorkComponentState(
  env: WorkActivationEnvironment, manifestIri: string, component: string, profile = PROFILE,
): Promise<Record<string, unknown>> {
  if (env.workObjects) {
    try { return await readComponentStateFromObjects(env.workObjects, manifestIri, component, profile); }
    catch (error) {
      if (!(error instanceof RevisionUnavailable)) throw error;
    }
  }
  return readComponentState(env.objectDirectory, manifestIri, component, profile);
}

/** Verify exact retained manifest and payload before offline replay or a read. */
export function readWorkPayloadFromManifest(
  objectDirectory: string, manifestIri: string, work: string,
): WorkPayload {
  const state = readComponentState(objectDirectory, manifestIri, work);
  if (typeof state.mainVersion !== 'string' || !state.mainVersion.startsWith('https://rezics.com/id/')
    || typeof state.title !== 'string' || state.language !== 'en') {
    throw new RevisionCorrupt('payload does not match Work profile');
  }
  return { mainVersion: state.mainVersion, title: state.title, language: 'en' };
}

export async function readWorkPayloadForRevision(
  env: WorkActivationEnvironment, manifestIri: string, work: string,
): Promise<WorkPayload> {
  const state = await readWorkComponentState(env, manifestIri, work);
  if (typeof state.mainVersion !== 'string' || !state.mainVersion.startsWith('https://rezics.com/id/')
    || typeof state.title !== 'string' || state.language !== 'en') {
    throw new RevisionCorrupt('payload does not match Work profile');
  }
  return { mainVersion: state.mainVersion, title: state.title, language: 'en' };
}

export async function readMainPayloadForRevision(
  env: WorkActivationEnvironment, manifestIri: string, mainVersion: string, work: string,
): Promise<MainPayload> {
  const state = await readWorkComponentState(env, manifestIri, mainVersion);
  const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
  const defaultSelection = state.defaultSelection ?? null;
  const predecessor = state.predecessor ?? null;
  if (state.work !== work || state.hostingPolicy !== 'metadata-only'
    || (defaultSelection !== null && (typeof defaultSelection !== 'string'
      || !native.test(defaultSelection)))
    || (predecessor !== null && (typeof predecessor !== 'string'
      || !native.test(predecessor)))
    || (defaultSelection === null) !== (predecessor === null)) {
    throw new RevisionCorrupt('payload does not match MainVersion profile');
  }
  return { work, hostingPolicy: 'metadata-only', defaultSelection, predecessor };
}

/** Retained MainVersion revision under current Work disclosure. */
export async function readExactMainRevision(
  env: WorkActivationEnvironment, mainVersion: string, revision: string,
  canReadWork: (work: string) => Promise<boolean>,
): Promise<ExactMainRevision> {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/>
    SELECT ?work ?operation ?manifest ?model ?shape ?dataset ?epoch ?sequence ?predecessor WHERE {
      GRAPH <${GRAPHS.current}> {
        ?work a schema:CreativeWork ; rv:mainVersion ${iri(mainVersion)} .
        ${iri(mainVersion)} a rv:MainVersion ; rv:work ?work .
      }
      GRAPH <${GRAPHS.revisions}> {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(mainVersion)} ;
          rv:operation ?operation ; rv:manifest ?manifest ; rv:modelRevision ?model ;
          rv:shapeRevision ?shape ; rv:datasetId ?dataset ; rv:dataEpoch ?epoch ;
          rv:sequence ?sequence .
        OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) throw new RevisionNotFound('MainVersion revision is unavailable');
  const owners = new Set(rows.map(row => row.work?.value));
  const work = owners.size === 1 ? rows[0]?.work?.value : undefined;
  if (!work || !await canReadWork(work)) {
    throw new RevisionNotFound('MainVersion revision is unavailable');
  }
  if (rows.length !== 1) throw new RevisionCorrupt('MainVersion revision anchor is ambiguous');
  const row = rows[0]!;
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)
    || row.model?.value !== PROFILE || row.shape?.value !== PROFILE
    || row.dataset?.value !== DATASET || !row.operation?.value || !row.epoch?.value
    || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
    throw new RevisionCorrupt('MainVersion revision anchor is incomplete');
  }
  const payload = await readMainPayloadForRevision(env, row.manifest?.value ?? '',
    mainVersion, work);
  const predecessor = row.predecessor?.value ?? null;
  if (predecessor !== payload.predecessor) {
    throw new RevisionCorrupt('MainVersion predecessor differs from retained payload');
  }
  return { revision, mainVersion, work, ...(predecessor ? { predecessor } : {}),
    operation: row.operation.value, hostingPolicy: payload.hostingPolicy,
    defaultSelection: payload.defaultSelection,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value,
      sequence: row.sequence.value } };
}

export function readMainPayloadFromManifest(
  objectDirectory: string, manifestIri: string, mainVersion: string, work: string,
): void {
  const state = readComponentState(objectDirectory, manifestIri, mainVersion);
  if (state.work !== work || state.hostingPolicy !== 'metadata-only') {
    throw new RevisionCorrupt('payload does not match MainVersion profile');
  }
}

/** The caller must supply a current authority/disclosure decision for the owning Work. */
export async function readExactWorkRevision(
  env: WorkActivationEnvironment,
  revision: string,
  canReadWork: (work: string) => Promise<boolean>,
): Promise<ExactWorkRevision> {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?work ?operation ?manifest ?model ?shape ?dataset ?epoch ?sequence ?predecessor WHERE {
      GRAPH <${GRAPHS.revisions}> {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ?work ; rv:operation ?operation ;
          rv:manifest ?manifest ; rv:modelRevision ?model ; rv:shapeRevision ?shape ;
          rv:datasetId ?dataset ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) throw new RevisionNotFound('revision is unavailable');
  const owners = new Set(rows.map(row => row.work?.value));
  const work = owners.size === 1 ? rows[0]?.work?.value : undefined;
  if (!work || !await canReadWork(work)) throw new RevisionNotFound('revision is unavailable');
  if (rows.length !== 1) throw new RevisionCorrupt('revision anchor is ambiguous');
  const row = rows[0]!;
  if (!work.startsWith('https://rezics.com/id/') || row.model?.value !== PROFILE
    || row.shape?.value !== PROFILE || row.dataset?.value !== DATASET
    || !row.operation?.value || !row.epoch?.value || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
    throw new RevisionCorrupt('revision anchor is incomplete');
  }
  const state = await readWorkPayloadForRevision(env, row.manifest?.value ?? '', work);
  return { revision, work, ...(row.predecessor ? { predecessor: row.predecessor.value } : {}),
    operation: row.operation.value, mainVersion: state.mainVersion, title: state.title,
    language: 'en', sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value,
      sequence: row.sequence.value } };
}
