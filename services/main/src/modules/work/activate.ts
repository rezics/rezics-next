import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FusekiClient } from '../../infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { readWorkTerminalReceipt, workReceiptIri } from './receipt.ts';

const execFileAsync = promisify(execFile);
export const RV = 'https://rezics.com/vocab/';
export const ID = 'https://rezics.com/id/';
export const PROFILE = 'https://rezics.com/definition/work-metadata-v1';
export const CONTINUITY = 'https://rezics.com/definition/continuity/native-work-v1';
export const DATASET = 'urn:rezics:dataset:product';
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
  candidateDirectory: string;
  repositoryRoot: string;
  jenaHome: string;
  javaHome: string;
  python: string;
}

export interface CreateMetadataWorkIntent {
  /** Trusted Access record; never populated from a browser request body. */
  admission: Pick<RegisteredAdmission, 'id' | 'scope' | 'action' | 'idempotencyKey' | 'requestDigest' | 'authorityEpoch' | 'expiresAt'>;
  title: string;
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

export function metadataWorkRequestDigest(title: string): string {
  if (title.length < 1 || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error('invalid title');
  }
  return hash(JSON.stringify({ family: 'create-metadata-work-v1', title, continuity: CONTINUITY }));
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

export function prepareComponent(directory: string, component: string, state: object): string {
  const payload = Buffer.from(JSON.stringify({ format: 'rezics-component-v1', component, state }));
  const payloadDigest = prepareImmutable(directory, payload);
  const manifest = Buffer.from(JSON.stringify({
    format: 'rezics-manifest-v1', component, payload: `sha256:${payloadDigest}`,
    payloadBytes: payload.length, mediaType: 'application/json', model: PROFILE, shape: PROFILE,
  }));
  return prepareImmutable(directory, manifest);
}

function candidate(work: string, main: string, title: string): string {
  return `@prefix schema: <https://schema.org/> .\n@prefix rv: <${RV}> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n` +
    `${iri(work)} a schema:CreativeWork ; rv:mainVersion ${iri(main)} ; rv:continuityProfile ${iri(CONTINUITY)} ; rdfs:label ${lit(title)}@en .\n` +
    `${iri(main)} a rv:MainVersion ; rv:work ${iri(work)} ; rv:hostingPolicy rv:MetadataOnly .\n`;
}

export async function validateCandidate(env: WorkActivationEnvironment, work: string, main: string, title: string): Promise<void> {
  mkdirSync(env.candidateDirectory, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(env.candidateDirectory, 'work-'));
  const data = join(temp, 'candidate.ttl');
  try {
    writeFileSync(data, candidate(work, main, title), { mode: 0o600 });
    const { stdout } = await execFileAsync(env.python, [
      join(env.repositoryRoot, 'model/tools/validate_work_metadata.py'),
      '--data', data, '--work', work, '--main', main,
      '--jena-home', env.jenaHome, '--java-home', env.javaHome,
      '--temp-root', env.candidateDirectory,
    ], { cwd: env.repositoryRoot, timeout: 20_000, maxBuffer: 128 * 1024 });
    const report = JSON.parse(stdout) as { conforms: boolean; profile_sha256: string };
    if (report.conforms !== true || !report.profile_sha256) throw new Error('candidate validation incomplete');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function updateText(env: WorkActivationEnvironment, args: {
  work: string; main: string; workRevision: string; mainRevision: string;
  operation: string; receipt: string; digest: string; title: string;
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
    `  ${iri(args.work)} a schema:CreativeWork ; rv:mainVersion ${iri(args.main)} ; rv:continuityProfile ${iri(CONTINUITY)} ; rdfs:label ${lit(args.title)}@en ; rv:head ${iri(args.workRevision)} .\n` +
    `  ${iri(args.main)} a rv:MainVersion ; rv:work ${iri(args.work)} ; rv:hostingPolicy rv:MetadataOnly ; rv:head ${iri(args.mainRevision)} .\n` +
    ` }\n` +
    ` GRAPH ${iri(g.revisions)} {\n` +
    `  ${iri(args.workRevision)} a rv:RevisionAnchor ; rv:component ${iri(args.work)} ; rv:operation ${iri(args.operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${args.workManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .\n` +
    `  ${iri(args.mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(args.main)} ; rv:operation ${iri(args.operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${args.mainManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .\n` +
    ` }\n` +
    ` GRAPH ${iri(g.receipts)} { ${iri(args.receipt)} a rv:OperationReceipt ; rv:operation ${iri(args.operation)} ; rv:requestDigest ${lit(args.digest)} ; rv:admissionId ${lit(args.admission.id)} ; rv:authorityEpoch ${lit(args.admission.authorityEpoch)} ; rv:admittedScope ${lit(args.admission.scope)} ; rv:outcome rv:Succeeded ; rv:work ${iri(args.work)} ; rv:mainVersion ${iri(args.main)} ; rv:workRevision ${iri(args.workRevision)} ; rv:mainRevision ${iri(args.mainRevision)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }\n` +
    ` GRAPH ${iri(g.outbox)} { ${iri(outbox)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} . ${iri(event)} rv:operation ${iri(args.operation)} ; rv:work ${iri(args.work)} . }\n` +
    `}\nWHERE {\n` +
    ` GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} . }\n` +
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
  const digest = metadataWorkRequestDigest(intent.title);
  if (admission.requestDigest !== digest) throw new IdempotencyConflict('admission digest does not match Work intent');
  const receipt = workReceiptIri(admission.id);
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
  await validateCandidate(env, work, main, intent.title);
  const workManifest = prepareComponent(env.objectDirectory, work, { mainVersion: main, continuityProfile: CONTINUITY, title: intent.title, language: 'en' });
  const mainManifest = prepareComponent(env.objectDirectory, main, { work, hostingPolicy: 'metadata-only' });
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('admission expired before graph update');
  let updateError: unknown;
  try {
    await env.fuseki.update(updateText(env, { work, main, workRevision, mainRevision, operation, receipt,
      digest, title: intent.title, admission, workManifest, mainManifest }));
  } catch (error) {
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
  await fuseki.update(`PREFIX rv: <${RV}> INSERT { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
      rv:sequence 0 ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} .
  } } WHERE { FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} ?p ?o } } }`);
  const result = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(lineage.dataEpoch)} ; rv:routingEpoch ${lit(lineage.routingEpoch)} ;
      rv:sequence 0 ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} .
  } }`);
  if (result.boolean !== true) throw new Error('dataset control already initialized or invalid');
}
