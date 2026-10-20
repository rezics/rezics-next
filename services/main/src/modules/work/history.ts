import { canonicalLanguage } from '../display-language/select.ts';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ObjectIntegrityError, ObjectReadBudgetExceeded, ObjectUnavailable, rememberVerifiedImmutableObject,
  type ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { DATASET, GRAPHS, PROFILE, hash, iri, normalizeWorkSemanticTypes,
  type WorkActivationEnvironment } from './activate.ts';
import { checkedWorkScalarValue, InvalidWorkScalarValue,
  type WorkScalarValue } from './scalar-value.ts';
import { readMergedIdentity, type MergedIdentity } from '../identity-merge/resolution.ts';
import { MergeUnavailable } from '../identity-merge/contract.ts';
import { isOwnerTransientFailure } from '../../infrastructure/owner-failure.ts';

export class RevisionNotFound extends Error {}
export class RevisionUnavailable extends Error {}
export class RevisionCorrupt extends Error {}
export class RevisionReadBudgetExceeded extends Error {}
export interface RevisionReadBudget { bytesLeft: number; signal: AbortSignal }

interface ExactRevisionBase {
  resolution?: MergedIdentity;
  revision: string;
  work: string;
  predecessor?: string;
  operation: string;
  title: string;
  language: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

export interface ExactMetadataWorkRevision extends ExactRevisionBase {
  mainVersion: string;
  profile?: never;
  publisher?: never;
  labels?: never;
  localizedTitle?: { value: string; language: string };
  description?: { value: string; language: string };
  semanticTypes: string[];
  scalarValue?: WorkScalarValue;
}

export const POST_REVISION_PROFILE = 'https://rezics.com/definition/post-v1';
export interface PostRevisionPayload {
  publisher: string;
  labels: { value: string; language: string }[];
}

export interface ExactPostRevision extends ExactRevisionBase, PostRevisionPayload {
  profile: 'post-v1';
  mainVersion?: never;
  semanticTypes?: never;
  localizedTitle?: never;
  description?: never;
  scalarValue?: never;
}

export type ExactWorkRevision = ExactMetadataWorkRevision | ExactPostRevision;

export interface ExactMainRevision {
  resolution?: MergedIdentity;
  revision: string;
  mainVersion: string;
  work: string;
  predecessor?: string;
  operation: string;
  hostingPolicy: 'metadata-only';
  defaultSelection: string | null;
  defaultSelections: Record<string, string>;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

export interface MainPayload {
  work: string;
  hostingPolicy: 'metadata-only';
  defaultSelection: string | null;
  defaultSelections: Record<string, string>;
  predecessor: string | null;
}

export interface WorkPayload {
  mainVersion: string;
  title: string;
  language: string;
  localizedTitle?: { value: string; language: string };
  description?: { value: string; language: string };
  semanticTypes: string[];
  scalarValue?: WorkScalarValue;
}

function objectBytes(directory: string, digest: string, budget?: RevisionReadBudget,
  remember?: (digest: string, bytes: Uint8Array) => void): Buffer {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new RevisionCorrupt('invalid immutable object reference');
  let bytes: Buffer;
  try {
    if (budget && (budget.signal.aborted || statSync(join(directory, digest)).size > budget.bytesLeft)) {
      throw new RevisionReadBudgetExceeded('revision read exceeds its shared budget');
    }
    bytes = readFileSync(join(directory, digest));
    if (budget) {
      budget.bytesLeft -= bytes.length;
      if (budget.bytesLeft < 0) throw new RevisionReadBudgetExceeded('revision read exceeds its shared budget');
    }
  } catch (error) {
    if (error instanceof RevisionReadBudgetExceeded) throw error;
    throw new RevisionUnavailable('committed revision bytes are unavailable', { cause: error });
  }
  if (hash(bytes) !== digest) throw new RevisionCorrupt('immutable object digest differs');
  remember?.(digest, bytes);
  return bytes;
}

export function readComponentState(
  objectDirectory: string, manifestIri: string, component: string, profile = PROFILE,
  budget?: RevisionReadBudget, remember?: (digest: string, bytes: Uint8Array) => void,
): Record<string, unknown> {
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifestIri)) throw new RevisionCorrupt('invalid manifest reference');
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(objectBytes(objectDirectory, manifestIri.slice(-64), budget, remember).toString('utf8')); }
  catch (error) { if (error instanceof RevisionUnavailable || error instanceof RevisionCorrupt || error instanceof RevisionReadBudgetExceeded) throw error;
    throw new RevisionCorrupt('manifest is not JSON', { cause: error }); }
  if (manifest.format !== 'rezics-manifest-v1' || manifest.component !== component
    || manifest.model !== profile || manifest.shape !== profile
    || manifest.mediaType !== 'application/json'
    || typeof manifest.payload !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.payload)) {
    throw new RevisionCorrupt('manifest does not match revision');
  }
  const payload = objectBytes(objectDirectory, manifest.payload.slice(7), budget, remember);
  if (manifest.payloadBytes !== payload.length) throw new RevisionCorrupt('payload byte count differs');
  let stored: Record<string, unknown>;
  try { stored = JSON.parse(payload.toString('utf8')); }
  catch (error) { throw new RevisionCorrupt('payload is not JSON', { cause: error }); }
  const state = stored.state as Record<string, unknown> | undefined;
  if (stored.format !== 'rezics-component-v1' || stored.component !== component || !state
    || Array.isArray(state)) throw new RevisionCorrupt('payload does not match component profile');
  return state;
}

async function storedObjectBytes(objects: ImmutableObjects, digest: string, budget?: RevisionReadBudget,
  remember?: (digest: string, bytes: Uint8Array) => void): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new RevisionCorrupt('invalid immutable object reference');
  budget?.signal.throwIfAborted();
  if (budget && (!Number.isSafeInteger(budget.bytesLeft) || budget.bytesLeft < 0)) {
    throw new RevisionReadBudgetExceeded('revision read exceeds its shared budget');
  }
  try {
    const bytes = Buffer.from(await objects.get(digest, budget?.bytesLeft, budget?.signal));
    budget?.signal.throwIfAborted();
    if (budget) {
      if (bytes.length > budget.bytesLeft) throw new RevisionReadBudgetExceeded('revision read exceeds its shared budget');
      budget.bytesLeft -= bytes.length;
    }
    if (hash(bytes) !== digest) throw new RevisionCorrupt('immutable object digest differs');
    remember?.(digest, bytes);
    return bytes;
  } catch (error) {
    budget?.signal.throwIfAborted();
    if (error instanceof ObjectReadBudgetExceeded) throw new RevisionReadBudgetExceeded(error.message, { cause: error });
    if (error instanceof ObjectIntegrityError) throw new RevisionCorrupt(error.message, { cause: error });
    if (error instanceof ObjectUnavailable) throw new RevisionUnavailable(error.message, { cause: error });
    throw error;
  }
}

async function readComponentStateFromObjects(
  objects: ImmutableObjects, manifestIri: string, component: string, profile = PROFILE,
  budget?: RevisionReadBudget, remember?: (digest: string, bytes: Uint8Array) => void,
): Promise<Record<string, unknown>> {
  if (!/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifestIri)) throw new RevisionCorrupt('invalid manifest reference');
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse((await storedObjectBytes(objects, manifestIri.slice(-64), budget, remember)).toString('utf8')); }
  catch (error) {
    budget?.signal.throwIfAborted();
    if (error instanceof RevisionUnavailable || error instanceof RevisionCorrupt || error instanceof RevisionReadBudgetExceeded) throw error;
    throw new RevisionCorrupt('manifest is not JSON', { cause: error });
  }
  if (manifest.format !== 'rezics-manifest-v1' || manifest.component !== component
    || manifest.model !== profile || manifest.shape !== profile
    || manifest.mediaType !== 'application/json'
    || typeof manifest.payload !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(manifest.payload)) {
    throw new RevisionCorrupt('manifest does not match revision');
  }
  const payload = await storedObjectBytes(objects, manifest.payload.slice(7), budget, remember);
  if (manifest.payloadBytes !== payload.length) throw new RevisionCorrupt('payload byte count differs');
  let stored: Record<string, unknown>;
  try { stored = JSON.parse(payload.toString('utf8')); }
  catch (error) { throw new RevisionCorrupt('payload is not JSON', { cause: error }); }
  const state = stored.state as Record<string, unknown> | undefined;
  if (stored.format !== 'rezics-component-v1' || stored.component !== component || !state
    || Array.isArray(state)) throw new RevisionCorrupt('payload does not match component profile');
  return state;
}

/**
 * New Work revisions use S3. The store stays authoritative: a body that fails
 * its digest check is `RevisionCorrupt` and is not replaced by the local file.
 * Only `RevisionUnavailable` (the store 404s or cannot be read) falls back to
 * `objectDirectory/<digest>`. That file is hashed before use, then both the
 * manifest and the payload are remembered so the next `get` of either digest
 * does not fetch.
 */
export async function readWorkComponentState(
  env: Pick<WorkActivationEnvironment, 'objectDirectory' | 'workObjects'>,
  manifestIri: string, component: string, profile = PROFILE,
  budget?: RevisionReadBudget, remember?: (digest: string, bytes: Uint8Array) => void,
): Promise<Record<string, unknown>> {
  budget?.signal.throwIfAborted();
  if (env.workObjects) {
    try { return await readComponentStateFromObjects(env.workObjects, manifestIri, component, profile, budget, remember); }
    catch (error) {
      budget?.signal.throwIfAborted();
      if (!(error instanceof RevisionUnavailable) || isOwnerTransientFailure(error)) throw error;
    }
    return readComponentState(env.objectDirectory, manifestIri, component, profile, budget,
      (digest, bytes) => {
        rememberVerifiedImmutableObject(digest, bytes);
        remember?.(digest, bytes);
      });
  }
  return readComponentState(env.objectDirectory, manifestIri, component, profile, budget, remember);
}

/** Verify exact retained manifest and payload before offline replay or a read. */
export function readWorkPayloadFromManifest(
  objectDirectory: string, manifestIri: string, work: string,
): WorkPayload {
  const state = readComponentState(objectDirectory, manifestIri, work);
  if (typeof state.mainVersion !== 'string' || !state.mainVersion.startsWith('https://rezics.com/id/')
    || typeof state.title !== 'string' || typeof state.language !== 'string'
    || !canonicalLanguage(state.language)) {
    throw new RevisionCorrupt('payload does not match Work profile');
  }
  return { mainVersion: state.mainVersion, title: state.title, language: state.language,
    ...checkedRecordedDetails(state),
    semanticTypes: checkedWorkSemanticTypes(state.semanticTypes),
    ...checkedScalarPayload(state) };
}

function checkedScalarPayload(state: Record<string, unknown>): { scalarValue?: WorkScalarValue } {
  if (!Object.hasOwn(state, 'scalarValue')) return {};
  try {
    const value = checkedWorkScalarValue(state.scalarValue);
    if (value === undefined) throw new InvalidWorkScalarValue('undefined scalar payload');
    return { scalarValue: value };
  } catch (error) { throw new RevisionCorrupt('Work scalar manifest state is invalid', { cause: error }); }
}

function checkedRecordedDetails(state: Record<string, unknown>) {
  const checked = (value: unknown, maximum: number) => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as Record<string, unknown>).value !== 'string'
      || typeof (value as Record<string, unknown>).language !== 'string') {
      throw new RevisionCorrupt('Work localized metadata is invalid');
    }
    const record = value as { value: string; language: string };
    if (!record.value || record.value.length > maximum || /[\u0000-\u001f\u007f]/.test(record.value)
      || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(record.language)) {
      throw new RevisionCorrupt('Work localized metadata is invalid');
    }
    return record;
  };
  const localizedTitle = checked(state.localizedTitle, 500);
  const description = checked(state.description, 4000);
  return { ...(localizedTitle ? { localizedTitle } : {}),
    ...(description ? { description } : {}) };
}

function checkedWorkSemanticTypes(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(type => typeof type !== 'string')) {
    throw new RevisionCorrupt('Work semantic types are invalid');
  }
  let normalized: string[];
  try { normalized = normalizeWorkSemanticTypes(value, true); }
  catch (error) { throw new RevisionCorrupt('Work semantic types are unsupported', { cause: error }); }
  if (normalized.some((type, index) => type !== value[index])) {
    throw new RevisionCorrupt('Work semantic types are not canonical');
  }
  return normalized;
}

export async function readWorkPayloadForRevision(
  env: WorkActivationEnvironment, manifestIri: string, work: string,
): Promise<WorkPayload> {
  const state = await readWorkComponentState(env, manifestIri, work);
  if (typeof state.mainVersion !== 'string' || !state.mainVersion.startsWith('https://rezics.com/id/')
    || typeof state.title !== 'string' || typeof state.language !== 'string'
    || !canonicalLanguage(state.language)) {
    throw new RevisionCorrupt('payload does not match Work profile');
  }
  return { mainVersion: state.mainVersion, title: state.title, language: state.language,
    ...checkedRecordedDetails(state),
    semanticTypes: checkedWorkSemanticTypes(state.semanticTypes),
    ...checkedScalarPayload(state) };
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
  let defaultSelections: Record<string, string> = {};
  if (state.defaultSelections !== undefined) {
    if (!state.defaultSelections || typeof state.defaultSelections !== 'object'
      || Array.isArray(state.defaultSelections)) throw new RevisionCorrupt('Main language map is invalid');
    const entries = Object.entries(state.defaultSelections);
    if ((defaultSelection === null && entries.length !== 0) || entries.length > 64 || entries.some(([language, selection]) =>
      !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)
      || typeof selection !== 'string' || !native.test(selection))
      || (defaultSelection !== null && !entries.some(([, selection]) => selection === defaultSelection))) {
      throw new RevisionCorrupt('Main language map is invalid');
    }
    defaultSelections = Object.fromEntries(entries) as Record<string, string>;
  } else if (defaultSelection) {
    // Migrate the view of retained singleton manifests without changing their bytes.
    const rows = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?language WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(defaultSelection)} rv:mainVersion ${iri(mainVersion)} ;
        rv:language ?language } } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.language
      || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(rows[0].language.value)) {
      throw new RevisionCorrupt('Legacy Main language is absent');
    }
    defaultSelections[rows[0].language.value.toLowerCase()] = defaultSelection;
  }
  return { work, hostingPolicy: 'metadata-only', defaultSelection, defaultSelections, predecessor };
}

/** Retained MainVersion revision under current Work disclosure. */
export async function readExactMainRevision(
  env: WorkActivationEnvironment, mainVersion: string, revision: string,
  canReadWork: (work: string) => Promise<boolean>,
  options: { resolveMerges?: boolean } = {},
): Promise<ExactMainRevision> {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/>
    SELECT ?work ?operation ?manifest ?model ?shape ?dataset ?epoch ?sequence ?predecessor ?mergedInto WHERE {
      GRAPH <${GRAPHS.current}> {
        ?work a schema:CreativeWork ; rv:mainVersion ${iri(mainVersion)} .
        ${iri(mainVersion)} a rv:MainVersion ; rv:work ?work .
        OPTIONAL { ?work rv:mergedInto ?mergedInto }
      }
      GRAPH <${GRAPHS.revisions}> {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(mainVersion)} ;
          rv:operation ?operation ; rv:manifest ?manifest ; rv:modelRevision ?model ;
          rv:shapeRevision ?shape ; rv:datasetId ?dataset ; rv:dataEpoch ?epoch ;
          rv:sequence ?sequence .
        OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
        FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision }
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
  const resolution = options.resolveMerges && row.mergedInto
    ? await disclosedRevisionMerge(env, work, canReadWork) : null;
  return { revision, mainVersion, work, ...(resolution ? { resolution } : {}), ...(predecessor ? { predecessor } : {}),
    operation: row.operation.value, hostingPolicy: payload.hostingPolicy,
    defaultSelection: payload.defaultSelection, defaultSelections: payload.defaultSelections,
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

/** Post custody has no MainVersion. Read the same verified component envelope
 * used by standalone Post and chapter creation, retaining the authored label order. */
export async function readPostPayloadForRevision(env: WorkActivationEnvironment,
  manifest: string, post: string): Promise<PostRevisionPayload> {
  const state = await readWorkComponentState(env, manifest, post, POST_REVISION_PROFILE);
  const labels = state.labels;
  if (Object.keys(state).some(key => key !== 'publisher' && key !== 'labels')
    || typeof state.publisher !== 'string' || !Array.isArray(labels) || !labels.length || labels.length > 24
    || labels.some(label => !label || typeof label !== 'object' || Array.isArray(label)
      || Object.keys(label).some(key => key !== 'value' && key !== 'language')
      || typeof label.value !== 'string' || !label.value.length || label.value.length > 200
      || /[\u0000-\u001f\u007f]/.test(label.value) || typeof label.language !== 'string'
      || !canonicalLanguage(label.language) || canonicalLanguage(label.language) !== label.language)
    || new Set(labels.map(label => (label as { language: string }).language)).size !== labels.length) {
    throw new RevisionCorrupt('Post component is invalid');
  }
  try { iri(state.publisher); } catch { throw new RevisionCorrupt('Post publisher is invalid'); }
  return { publisher: state.publisher, labels: labels.map(label => ({ value: label.value as string, language: label.language as string })) };
}

/** The caller must supply a current authority/disclosure decision for the owning Work or Post. */
export async function readExactWorkRevision(
  env: WorkActivationEnvironment,
  revision: string,
  canReadWork: (work: string) => Promise<boolean>,
  options: { resolveMerges?: boolean } = {},
): Promise<ExactWorkRevision> {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT ?work ?operation ?manifest ?model ?shape ?dataset ?epoch ?sequence ?predecessor ?mergedInto WHERE {
      GRAPH <${GRAPHS.revisions}> {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ?work ; rv:operation ?operation ;
          rv:manifest ?manifest ; rv:modelRevision ?model ; rv:shapeRevision ?shape ;
          rv:datasetId ?dataset ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(revision)} rv:predecessor ?predecessor }
        FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision }
      }
      OPTIONAL { GRAPH <${GRAPHS.current}> { ?work rv:mergedInto ?mergedInto } }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) throw new RevisionNotFound('revision is unavailable');
  const owners = new Set(rows.map(row => row.work?.value));
  const work = owners.size === 1 ? rows[0]?.work?.value : undefined;
  if (!work || !await canReadWork(work)) throw new RevisionNotFound('revision is unavailable');
  if (rows.length !== 1) throw new RevisionCorrupt('revision anchor is ambiguous');
  const row = rows[0]!;
  const profile = row.model?.value;
  if (!work.startsWith('https://rezics.com/id/') || ![PROFILE, POST_REVISION_PROFILE].includes(profile ?? '')
    || row.shape?.value !== profile || row.dataset?.value !== DATASET
    || !row.operation?.value || !row.epoch?.value || !/^[0-9]+$/.test(row.sequence?.value ?? '')) {
    throw new RevisionCorrupt('revision anchor is incomplete');
  }
  const resolution = options.resolveMerges && row.mergedInto
    ? await disclosedRevisionMerge(env, work, canReadWork) : null;
  if (profile === POST_REVISION_PROFILE) {
    const state = await readPostPayloadForRevision(env, row.manifest?.value ?? '', work);
    return { revision, work, ...(resolution ? { resolution } : {}),
      ...(row.predecessor ? { predecessor: row.predecessor.value } : {}), operation: row.operation!.value,
      profile: 'post-v1', ...state, title: state.labels[0]!.value, language: state.labels[0]!.language,
      sourcePosition: { datasetId: 'product', dataEpoch: row.epoch!.value, sequence: row.sequence!.value } };
  }
  const state = await readWorkPayloadForRevision(env, row.manifest?.value ?? '', work);
  return { revision, work, ...(resolution ? { resolution } : {}), ...(row.predecessor ? { predecessor: row.predecessor.value } : {}),
    operation: row.operation.value, mainVersion: state.mainVersion, title: state.title,
    language: state.language, semanticTypes: state.semanticTypes,
    ...(state.localizedTitle ? { localizedTitle: state.localizedTitle } : {}),
    ...(state.description ? { description: state.description } : {}),
    ...(state.scalarValue === undefined ? {} : { scalarValue: state.scalarValue }),
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value,
      sequence: row.sequence.value } };
}

async function disclosedRevisionMerge(env: WorkActivationEnvironment, work: string,
  canReadWork: (work: string) => Promise<boolean>) {
  try {
    return await readMergedIdentity(env, work, async resource => {
      if (!await canReadWork(resource)) throw new RevisionNotFound('revision is unavailable');
      return true;
    });
  } catch (error) {
    if (error instanceof MergeUnavailable) throw new RevisionUnavailable('Identity resolution is unavailable', { cause: error });
    throw error;
  }
}
