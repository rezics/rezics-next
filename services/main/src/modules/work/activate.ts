import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRejected, FusekiClient, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileRegistry } from '../../../../../packages/model/src/generated/profiles.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { readWorkTerminalReceipt, workReceiptIri } from './receipt.ts';

export const RV = 'https://rezics.com/vocab/';
export const ID = 'https://rezics.com/id/';
export const PROFILE = 'https://rezics.com/definition/work-metadata-v1';
export const CONTINUITY = 'https://rezics.com/definition/continuity/native-work-v1';
export const WORK_SEMANTIC_TYPES = [
  'https://schema.org/Book', 'https://schema.org/DigitalDocument',
] as const;
export const DATASET = 'urn:rezics:dataset:product';
export const TEXT_INDEX_PROFILE = 'https://rezics.com/definition/search-index-cjk-bigram-v1';
export const TEXT_INDEX_PROBE_GRAPH = 'urn:rezics:search:probe';
export const TEXT_INDEX_PROBE = 'urn:rezics:search:probe:cjk-bigram-v1';
export const TEXT_INDEX_PROBE_BODY = '中文检索验证';
export const PUBLIC_SEARCH_ANCHOR = 'urn:rezics:search:public:anchor';
export const GRAPHS = {
  control: 'urn:rezics:graph:control',
  current: 'urn:rezics:graph:current',
  revisions: 'urn:rezics:graph:revisions',
  receipts: 'urn:rezics:graph:receipts',
  outbox: 'urn:rezics:graph:outbox',
} as const;

export interface GraphLineage {
  dataEpoch: string;
  routingEpoch: string;
}

export interface WorkActivationEnvironment {
  fuseki: FusekiClient;
  lineage: GraphLineage;
  objectDirectory: string;
  /** Selected for new Work semantic revisions; the directory is the migration baseline. */
  workObjects?: ImmutableObjects;
  /** Target stack's independent title signer, used only by held-owner recovery. */
  titleAdmissionKey?: string;
  /** Kept optional for older integration fixtures; command validation needs no host runtime. */
  candidateDirectory?: string;
  repositoryRoot?: string;
  jenaHome?: string;
  javaHome?: string;
  python?: string;
}

export interface CreateMetadataWorkIntent {
  /** Trusted Access record; never populated from a browser request body. */
  admission: Pick<RegisteredAdmission, 'id' | 'scope' | 'action' | 'idempotencyKey' | 'requestDigest' | 'authorityEpoch' | 'expiresAt'>;
  title: string;
  semanticTypes?: readonly string[];
}

export interface WorkActivationReceipt {
  work: string;
  mainVersion: string;
  workRevision: string;
  mainRevision: string;
  receipt: string;
  admissionId: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}

export class IdempotencyConflict extends Error {}
export class PendingActivation extends Error {}
export class CancelledActivation extends Error {}

export function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeWorkSemanticTypes(types: readonly string[] = []): string[] {
  if (types.length > WORK_SEMANTIC_TYPES.length || new Set(types).size !== types.length
    || types.some(type => !WORK_SEMANTIC_TYPES.includes(type as typeof WORK_SEMANTIC_TYPES[number]))) {
    throw new Error('invalid Work semantic types');
  }
  return [...types].sort();
}

export function metadataWorkRequestDigest(title: string,
  semanticTypes?: readonly string[]): string {
  if (title.length < 1 || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error('invalid title');
  }
  const types = normalizeWorkSemanticTypes(semanticTypes);
  return hash(JSON.stringify({ family: 'create-metadata-work-v1', title, continuity: CONTINUITY,
    ...(types.length ? { semanticTypes: types } : {}) }));
}

export function iri(value: string): string {
  if (!/^(?:https:\/\/rezics\.com\/(?:id|definition)\/[A-Za-z0-9._~/-]+|urn:rezics:[A-Za-z0-9:._-]+)$/.test(value)) {
    throw new Error('invalid native IRI');
  }
  return `<${value}>`;
}

export function lit(value: string): string {
  return JSON.stringify(value);
}

function prepareImmutable(directory: string, bytes: Uint8Array): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const digest = hash(bytes);
  const target = join(directory, digest);
  if (existsSync(target)) {
    if (hash(readFileSync(target)) !== digest) throw new Error('immutable object collision or corruption');
    return digest;
  }
  const temp = join(directory, `.stage-${Bun.randomUUIDv7()}`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  if (hash(readFileSync(target)) !== digest) throw new Error('staged immutable object verification failed');
  const dirFd = openSync(directory, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  return digest;
}

export function prepareComponent(directory: string, component: string, state: object,
  profile = PROFILE): string {
  const payload = Buffer.from(JSON.stringify({ format: 'rezics-component-v1', component, state }));
  const payloadDigest = prepareImmutable(directory, payload);
  const manifest = Buffer.from(JSON.stringify({
    format: 'rezics-manifest-v1', component, payload: `sha256:${payloadDigest}`,
    payloadBytes: payload.length, mediaType: 'application/json', model: profile, shape: profile,
  }));
  return prepareImmutable(directory, manifest);
}

export async function prepareWorkComponent(objects: ImmutableObjects, component: string, state: object,
  profile = PROFILE): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ format: 'rezics-component-v1', component, state }));
  const payloadDigest = await objects.put(payload);
  const manifest = Buffer.from(JSON.stringify({
    format: 'rezics-manifest-v1', component, payload: `sha256:${payloadDigest}`,
    payloadBytes: payload.length, mediaType: 'application/json', model: profile, shape: profile,
  }));
  return objects.put(manifest);
}

const WORK_PROFILE_ID = 'work-metadata-v1';
const [WORK_SHAPE, MAIN_VERSION_SHAPE] = profileRegistry[WORK_PROFILE_ID].shapes;

export async function workMetadataValidations(env: WorkActivationEnvironment,
  work: string, main: string): Promise<CommandValidation[]> {
  return profileValidations(env.fuseki, WORK_PROFILE_ID, [
    { shape: WORK_SHAPE!, focus: [work], graphs: [GRAPHS.current] },
    { shape: MAIN_VERSION_SHAPE!, focus: [main], graphs: [GRAPHS.current] },
  ]);
}

function updateText(env: WorkActivationEnvironment, args: {
  work: string; main: string; workRevision: string; mainRevision: string;
  operation: string; receipt: string; digest: string; title: string;
  semanticTypes: readonly string[];
  admission: CreateMetadataWorkIntent['admission'];
  workManifest: string; mainManifest: string;
}): string {
  const g = GRAPHS;
  const outbox = `urn:rezics:outbox:${hash(args.receipt)}`;
  const event = `urn:rezics:event:${hash(args.operation)}`;
  return `PREFIX rv: <${RV}>\nPREFIX schema: <https://schema.org/>\nPREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n` +
    `DELETE { GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:sequence ?n } }\n` +
    `INSERT {\n` +
    ` GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:sequence ?next }\n` +
    ` GRAPH ${iri(g.current)} {\n` +
    `  ${iri(args.work)} a schema:CreativeWork${args.semanticTypes.map(type => `, <${type}>`).join('')} ; rv:mainVersion ${iri(args.main)} ; rv:continuityProfile ${iri(CONTINUITY)} ; rdfs:label ${lit(args.title)}@en ; rv:head ${iri(args.workRevision)} .\n` +
    `  ${iri(args.main)} a rv:MainVersion ; rv:work ${iri(args.work)} ; rv:hostingPolicy rv:MetadataOnly ; rv:head ${iri(args.mainRevision)} .\n` +
    ` }\n` +
    ` GRAPH ${iri(g.revisions)} {\n` +
    `  ${iri(args.workRevision)} a rv:RevisionAnchor ; rv:component ${iri(args.work)} ; rv:operation ${iri(args.operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${args.workManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .\n` +
    `  ${iri(args.mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(args.main)} ; rv:operation ${iri(args.operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${args.mainManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .\n` +
    ` }\n` +
    ` GRAPH ${iri(g.receipts)} { ${iri(args.receipt)} a rv:OperationReceipt ; rv:operation ${iri(args.operation)} ; rv:requestDigest ${lit(args.digest)} ; rv:admissionId ${lit(args.admission.id)} ; rv:authorityEpoch ${lit(args.admission.authorityEpoch)} ; rv:admittedScope ${lit(args.admission.scope)} ; rv:outcome rv:Succeeded ; rv:work ${iri(args.work)} ; rv:mainVersion ${iri(args.main)} ; rv:workRevision ${iri(args.workRevision)} ; rv:mainRevision ${iri(args.mainRevision)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }\n` +
    ` GRAPH ${iri(g.outbox)} { ${iri(outbox)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} . ${iri(event)} a rv:WorkCreatedEvent ; rv:ordinal 0 ; rv:action "work.create" ; rv:receipt ${iri(args.receipt)} ; rv:operation ${iri(args.operation)} ; rv:work ${iri(args.work)} . }\n` +
    `}\nWHERE {\n` +
    ` GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} . }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:restoreHold true } }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.receipts)} { ${iri(args.receipt)} ?p ?o } }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.current)} { ${iri(args.work)} ?wp ?wo } }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.current)} { ${iri(args.main)} ?mp ?mo } }\n` +
    ` BIND(?n + 1 AS ?next)\n}`;
}

export async function activateMetadataWork(env: WorkActivationEnvironment, intent: CreateMetadataWorkIntent): Promise<WorkActivationReceipt> {
  const admission = intent.admission;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(admission.id)
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(admission.scope)
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(admission.idempotencyKey)
    || !/^[0-9]+$/.test(admission.authorityEpoch)
    || admission.action !== 'work.create') {
    throw new Error('invalid Work admission');
  }
  const semanticTypes = normalizeWorkSemanticTypes(intent.semanticTypes);
  const digest = metadataWorkRequestDigest(intent.title, semanticTypes);
  if (admission.requestDigest !== digest) throw new IdempotencyConflict('admission digest does not match Work intent');
  const receipt = workReceiptIri(admission.id);
  await assertNotInvalidProfileReceipt(env.fuseki, workReceiptIri(admission.id));
  const existing = await readWorkTerminalReceipt(env.fuseki, admission.id);
  if (existing) {
    if (existing.requestDigest !== digest || existing.admissionId !== admission.id
      || existing.authorityEpoch !== admission.authorityEpoch || existing.scope !== admission.scope) {
      throw new IdempotencyConflict('admission does not match stored receipt');
    }
    if (existing.outcome === 'cancelled') throw new CancelledActivation('Work admission was sealed as cancelled');
    return { work: existing.work!, mainVersion: existing.mainVersion!,
      workRevision: existing.workRevision!, mainRevision: existing.mainRevision!, receipt, admissionId: admission.id,
      dataEpoch: existing.dataEpoch, sequence: existing.sequence, replayed: true };
  }
  if (!Number.isFinite(Date.parse(admission.expiresAt)) || Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('admission expired before dispatch');
  }
  const work = ID + Bun.randomUUIDv7();
  const main = ID + Bun.randomUUIDv7();
  const workRevision = ID + Bun.randomUUIDv7();
  const mainRevision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await workMetadataValidations(env, work, main);
  const workState = { mainVersion: main, continuityProfile: CONTINUITY, title: intent.title,
    language: 'en', ...(semanticTypes.length ? { semanticTypes } : {}) };
  const mainState = { work, hostingPolicy: 'metadata-only' };
  const workManifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, work, workState)
    : prepareComponent(env.objectDirectory, work, workState);
  const mainManifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, main, mainState)
    : prepareComponent(env.objectDirectory, main, mainState);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('admission expired before graph update');
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest,
      update: updateText(env, { work, main, workRevision, mainRevision, operation, receipt,
        digest, title: intent.title, semanticTypes, admission, workManifest, mainManifest }),
      validations, deadlineMs: 10_000 }, admission);
    if (result.status === 'invalid' || result.status === 'unknown-profile'
      || result.status === 'conflict') throw new CommandRejected(result);
  } catch (error) {
    if (error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readWorkTerminalReceipt(env.fuseki, admission.id);
  if (committed) {
    if (committed.requestDigest !== digest || committed.admissionId !== admission.id
      || committed.authorityEpoch !== admission.authorityEpoch || committed.scope !== admission.scope) {
      throw new IdempotencyConflict('admission does not match stored receipt');
    }
    if (committed.outcome === 'cancelled') throw new CancelledActivation('Work admission was sealed as cancelled');
    return { work: committed.work!, mainVersion: committed.mainVersion!,
      workRevision: committed.workRevision!, mainRevision: committed.mainRevision!, receipt, admissionId: admission.id,
      dataEpoch: committed.dataEpoch, sequence: committed.sequence, replayed: committed.work !== work };
  }
  throw new PendingActivation(updateError ? 'write outcome unknown; receipt absent after update error' : 'guard did not match; no receipt committed');
}

/** Privileged fresh-dataset bootstrap. Never exposed through a product route. */
export async function initializeFreshGraph(fuseki: FusekiClient, lineage: GraphLineage): Promise<void> {
  const generation = `urn:rezics:text-index-generation:${Bun.randomUUIDv7()}`;
  const receipt = `urn:rezics:receipt:bootstrap:${hash(`${lineage.dataEpoch}\0${lineage.routingEpoch}`)}`;
  const digest = hash(JSON.stringify({ family: 'bootstrap-graph-v1', lineage }));
  const update = `PREFIX rv: <${RV}> INSERT { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
      rv:sequence 0 ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} ;
      rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} ;
      rv:textIndexGeneration ${iri(generation)} .
  } GRAPH <urn:rezics:search:public> {
    ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor .
  } GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
    ${iri(TEXT_INDEX_PROBE)} rv:searchBody ${lit(TEXT_INDEX_PROBE_BODY)}@zh .
  } GRAPH ${iri(GRAPHS.receipts)} {
    ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:sequence 0 .
  } } WHERE { FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} ?p ?o } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } }`;
  const command = await fuseki.commandWithReceipt({ receipt, digest, update,
    validations: [], deadlineMs: 10_000 });
  if (command.status !== 'committed') throw new CommandRejected(command);
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
      rv:sequence 0 ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} ;
      rv:textIndexProfile ${iri(TEXT_INDEX_PROFILE)} ; rv:textIndexGeneration ?generation .
  } GRAPH <urn:rezics:search:public> {
    ${iri(PUBLIC_SEARCH_ANCHOR)} a rv:SearchGraphAnchor .
  } GRAPH ${iri(TEXT_INDEX_PROBE_GRAPH)} {
    ${iri(TEXT_INDEX_PROBE)} rv:searchBody ${lit(TEXT_INDEX_PROBE_BODY)}@zh .
  } }`);
  if (result.boolean !== true) throw new Error('dataset control already initialized or invalid');
}
