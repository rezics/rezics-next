import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  if (rows.length !== 1) throw new RevisionCorrupt('revision anchor is ambiguous');
  const row = rows[0]!;
  const work = row.work?.value;
  if (!work || !await canReadWork(work)) throw new RevisionNotFound('revision is unavailable');
  if (!work.startsWith('https://rezics.com/id/') || row.model?.value !== PROFILE
    || row.shape?.value !== PROFILE || row.dataset?.value !== DATASET
    || !row.operation?.value || !row.epoch?.value || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
    throw new RevisionCorrupt('revision anchor is incomplete');
  }
  const state = readWorkPayloadFromManifest(env.objectDirectory, row.manifest?.value ?? '', work);
  return { revision, work, ...(row.predecessor ? { predecessor: row.predecessor.value } : {}),
    operation: row.operation.value, mainVersion: state.mainVersion, title: state.title,
    language: 'en', sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value,
      sequence: row.sequence.value } };
}
