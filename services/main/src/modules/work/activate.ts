import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FusekiClient } from '../../infrastructure/fuseki.ts';

const execFileAsync = promisify(execFile);
const RV = 'https://rezics.com/vocab/';
const ID = 'https://rezics.com/id/';
const PROFILE = 'https://rezics.com/definition/work-metadata-v1';
const CONTINUITY = 'https://rezics.com/definition/continuity/native-work-v1';
const DATASET = 'urn:rezics:dataset:product';
const GRAPHS = {
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
  /** Trusted Access/Account admission scope; never a browser-provided field. */
  admittedScope: string;
  idempotencyKey: string;
  title: string;
}

export interface WorkActivationReceipt {
  work: string;
  mainVersion: string;
  receipt: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}

export class IdempotencyConflict extends Error {}
export class PendingActivation extends Error {}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function iri(value: string): string {
  if (!/^(?:https:\/\/rezics\.com\/(?:id|definition)\/[A-Za-z0-9._~/-]+|urn:rezics:[A-Za-z0-9:._-]+)$/.test(value)) {
    throw new Error('invalid native IRI');
  }
  return `<${value}>`;
}

function lit(value: string): string {
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

function prepareComponent(directory: string, component: string, state: object): string {
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

async function validateCandidate(env: WorkActivationEnvironment, work: string, main: string, title: string): Promise<void> {
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

async function readReceipt(fuseki: FusekiClient, receipt: string): Promise<{ digest: string; work: string; main: string; sequence: string; epoch: string } | null> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?digest ?work ?main ?sequence ?epoch WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:requestDigest ?digest ; rv:work ?work ; rv:mainVersion ?main ;
        rv:sequence ?sequence ; rv:dataEpoch ?epoch .
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('receipt cardinality violation');
  const row = rows[0]!;
  if (!row.digest || !row.work || !row.main || !row.sequence || !row.epoch) throw new Error('incomplete receipt');
  return { digest: row.digest.value, work: row.work.value, main: row.main.value, sequence: row.sequence.value, epoch: row.epoch.value };
}

function updateText(env: WorkActivationEnvironment, args: {
  work: string; main: string; workRevision: string; mainRevision: string;
  operation: string; receipt: string; digest: string; title: string;
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
    ` GRAPH ${iri(g.receipts)} { ${iri(args.receipt)} a rv:OperationReceipt ; rv:operation ${iri(args.operation)} ; rv:requestDigest ${lit(args.digest)} ; rv:outcome rv:Succeeded ; rv:work ${iri(args.work)} ; rv:mainVersion ${iri(args.main)} ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }\n` +
    ` GRAPH ${iri(g.outbox)} { ${iri(outbox)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} . ${iri(event)} rv:operation ${iri(args.operation)} ; rv:work ${iri(args.work)} . }\n` +
    `}\nWHERE {\n` +
    ` GRAPH ${iri(g.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n ; rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} . }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.receipts)} { ${iri(args.receipt)} ?p ?o } }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.current)} { ${iri(args.work)} ?wp ?wo } }\n` +
    ` FILTER NOT EXISTS { GRAPH ${iri(g.current)} { ${iri(args.main)} ?mp ?mo } }\n` +
    ` BIND(?n + 1 AS ?next)\n}`;
}

export async function activateMetadataWork(env: WorkActivationEnvironment, intent: CreateMetadataWorkIntent): Promise<WorkActivationReceipt> {
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(intent.admittedScope) || !/^[A-Za-z0-9:_./-]{1,128}$/.test(intent.idempotencyKey)) {
    throw new Error('invalid admitted scope or idempotency key');
  }
  if (intent.title.length < 1 || intent.title.length > 200 || /[\u0000-\u001f\u007f]/.test(intent.title)) {
    throw new Error('invalid title');
  }
  const digest = hash(JSON.stringify({ family: 'create-metadata-work-v1', title: intent.title, continuity: CONTINUITY }));
  const receipt = `urn:rezics:receipt:${hash(`${intent.admittedScope}\0create-metadata-work\0${intent.idempotencyKey}`)}`;
  const existing = await readReceipt(env.fuseki, receipt);
  if (existing) {
    if (existing.digest !== digest) throw new IdempotencyConflict('key already used for another request');
    return { work: existing.work, mainVersion: existing.main, receipt, dataEpoch: existing.epoch, sequence: existing.sequence, replayed: true };
  }
  const work = ID + Bun.randomUUIDv7();
  const main = ID + Bun.randomUUIDv7();
  const workRevision = ID + Bun.randomUUIDv7();
  const mainRevision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  await validateCandidate(env, work, main, intent.title);
  const workManifest = prepareComponent(env.objectDirectory, work, { mainVersion: main, continuityProfile: CONTINUITY, title: intent.title, language: 'en' });
  const mainManifest = prepareComponent(env.objectDirectory, main, { work, hostingPolicy: 'metadata-only' });
  let updateError: unknown;
  try {
    await env.fuseki.update(updateText(env, { work, main, workRevision, mainRevision, operation, receipt, digest, title: intent.title, workManifest, mainManifest }));
  } catch (error) {
    updateError = error;
  }
  const committed = await readReceipt(env.fuseki, receipt);
  if (committed) {
    if (committed.digest !== digest) throw new IdempotencyConflict('key already used for another request');
    return { work: committed.work, mainVersion: committed.main, receipt, dataEpoch: committed.epoch, sequence: committed.sequence, replayed: committed.work !== work };
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
