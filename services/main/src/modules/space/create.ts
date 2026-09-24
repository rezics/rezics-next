import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, CancelledActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';

const execFileAsync = promisify(execFile);
export const SPACE_REALM_PROFILE = 'https://rezics.com/definition/space-realm-v1';
export const SELECTION_POLICY = 'https://rezics.com/definition/realm-manager-fixed-main-fallback-v1';
export const MEMBERSHIP_POLICY = 'https://rezics.com/definition/realm-closed-v1';
export const REVIEW_POLICY = 'https://rezics.com/definition/realm-manager-reviewed-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class InvalidSpaceInput extends Error {}

export interface CreateRealmSpaceInput {
  name: string;
  actingSubject: string;
}

export interface SpaceCreationReceipt {
  outcome: 'succeeded' | 'cancelled';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  space?: string;
  realm?: string;
  spaceRevision?: string;
  realmRevision?: string;
  owner?: string;
}

export function spaceCreationDigest(input: CreateRealmSpaceInput): string {
  if (input.name.length < 1 || input.name.length > 120
    || /[\u0000-\u001f\u007f]/u.test(input.name)
    || !nativeId.test(input.actingSubject)) {
    throw new InvalidSpaceInput('invalid Space creation request');
  }
  return hash(JSON.stringify({ family: 'create-space-realm-v1', name: input.name,
    capabilities: ['realm'], owner: input.actingSubject,
    selectionPolicy: SELECTION_POLICY, membershipPolicy: MEMBERSHIP_POLICY,
    reviewPolicy: REVIEW_POLICY }));
}

export function spaceCreationReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0create-space-realm`)}`;
}

export async function readSpaceCreationReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<SpaceCreationReceipt | null> {
  const receipt = spaceCreationReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?digest ?id ?epoch ?scope ?dataEpoch ?sequence
    ?space ?realm ?spaceRevision ?realmRevision ?owner WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:space ?space ; rv:realm ?realm ;
        rv:spaceRevision ?spaceRevision ; rv:realmRevision ?realmRevision ; rv:owner ?owner }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Space receipt cardinality violation');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome || !value('digest') || !value('id') || !value('epoch') || !value('scope')
    || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (outcome === 'succeeded' && (!value('space') || !value('realm')
      || !value('spaceRevision') || !value('realmRevision') || !value('owner')))
    || (outcome === 'cancelled' && (value('space') || value('realm')
      || value('spaceRevision') || value('realmRevision') || value('owner')))) {
    throw new Error('Space receipt is incomplete');
  }
  return { outcome, receipt, admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { space: value('space'), realm: value('realm'),
      spaceRevision: value('spaceRevision'), realmRevision: value('realmRevision'),
      owner: value('owner') } : {}) };
}

function checked(receipt: SpaceCreationReceipt, admission: RegisteredAdmission,
  input: CreateRealmSpaceInput, digest: string): SpaceCreationReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('Space admission differs from graph receipt');
  }
  if (receipt.outcome === 'cancelled') throw new CancelledActivation('Space creation was cancelled');
  if (receipt.owner !== input.actingSubject) throw new IdempotencyConflict('Space owner differs');
  return receipt;
}

async function validateCandidate(env: WorkActivationEnvironment, space: string, realm: string,
  input: CreateRealmSpaceInput): Promise<void> {
  mkdirSync(env.candidateDirectory, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(env.candidateDirectory, 'space-'));
  try {
    const data = join(temp, 'candidate.ttl');
    writeFileSync(data, `@prefix rv: <${RV}> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n` +
      `${iri(space)} a rv:Space ; rv:owner ${iri(input.actingSubject)} ; ` +
      `rv:realmCapability ${iri(realm)} ; rdfs:label ${lit(input.name)}@en .\n` +
      `${iri(realm)} a rv:Realm ; rv:space ${iri(space)} ; rv:realmState rv:Active ; ` +
      `rv:selectionPolicy ${iri(SELECTION_POLICY)} ; ` +
      `rv:membershipPolicy ${iri(MEMBERSHIP_POLICY)} ; ` +
      `rv:reviewPolicy ${iri(REVIEW_POLICY)} .\n`, { mode: 0o600 });
    const { stdout } = await execFileAsync(env.python, [
      join(env.repositoryRoot, 'model/tools/validate_space_realm.py'),
      '--data', data, '--space', space, '--realm', realm,
      '--jena-home', env.jenaHome, '--java-home', env.javaHome,
      '--temp-root', env.candidateDirectory,
    ], { cwd: env.repositoryRoot, timeout: 20_000, maxBuffer: 128 * 1024 });
    const report = JSON.parse(stdout) as { conforms: boolean; profile_sha256: string };
    if (report.conforms !== true || !report.profile_sha256) {
      throw new Error('Space candidate validation incomplete');
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Create one public Space and its distinct Realm capability in one graph position. */
export async function createRealmSpace(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: CreateRealmSpaceInput): Promise<SpaceCreationReceipt> {
  const digest = spaceCreationDigest(input);
  if (admission.action !== 'space.create' || admission.scope !== 'space:create:root'
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Space admission differs from intent');
  }
  const existing = await readSpaceCreationReceipt(env, admission.id);
  if (existing) return checked(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Space admission expired');
  const space = ID + Bun.randomUUIDv7();
  const realm = ID + Bun.randomUUIDv7();
  const spaceRevision = ID + Bun.randomUUIDv7();
  const realmRevision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  await validateCandidate(env, space, realm, input);
  const spaceManifest = prepareComponent(env.objectDirectory, space,
    { name: input.name, owner: input.actingSubject, realmCapability: realm,
      capabilities: ['realm'], disclosure: 'public' }, SPACE_REALM_PROFILE);
  const realmManifest = prepareComponent(env.objectDirectory, realm,
    { space, state: 'active', selectionPolicy: SELECTION_POLICY,
      membershipPolicy: MEMBERSHIP_POLICY, reviewPolicy: REVIEW_POLICY }, SPACE_REALM_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Space admission expired');
  const receipt = spaceCreationReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  let updateError: unknown;
  try { await env.fuseki.update(`PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(space)} a rv:Space ; rv:owner ${iri(input.actingSubject)} ;
          rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public ;
          rdfs:label ${lit(input.name)}@en ; rv:head ${iri(spaceRevision)} .
        ${iri(realm)} a rv:Realm ; rv:space ${iri(space)} ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} ;
          rv:membershipPolicy ${iri(MEMBERSHIP_POLICY)} ;
          rv:reviewPolicy ${iri(REVIEW_POLICY)} ; rv:head ${iri(realmRevision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(spaceRevision)} a rv:RevisionAnchor ; rv:component ${iri(space)} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${spaceManifest}`)} ;
          rv:modelRevision ${iri(SPACE_REALM_PROFILE)} ; rv:shapeRevision ${iri(SPACE_REALM_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${iri(realmRevision)} a rv:RevisionAnchor ; rv:component ${iri(realm)} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${realmManifest}`)} ;
          rv:modelRevision ${iri(SPACE_REALM_PROFILE)} ; rv:shapeRevision ${iri(SPACE_REALM_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:space ${iri(space)} ; rv:realm ${iri(realm)} ;
          rv:spaceRevision ${iri(spaceRevision)} ; rv:realmRevision ${iri(realmRevision)} ;
          rv:owner ${iri(input.actingSubject)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:SpaceCreatedEvent ; rv:ordinal 0 ; rv:action "space.create" ;
          rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} ; rv:space ${iri(space)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(space)} ?sp ?so } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} ?rp ?ro } }
      BIND(?n + 1 AS ?next)
    }`); } catch (error) { updateError = error; }
  const committed = await readSpaceCreationReceipt(env, admission.id);
  if (committed) return checked(committed, admission, input, digest);
  throw new PendingActivation(updateError
    ? 'Space update outcome unknown' : 'Space creation guard did not match');
}

/** Terminal receipt for a Space creation whose Access claim cannot dispatch. */
export async function sealRealmSpaceAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<SpaceCreationReceipt> {
  if (admission.action !== 'space.create' || admission.scope !== 'space:create:root') {
    throw new IdempotencyConflict('unsupported Space admission');
  }
  const existing = await readSpaceCreationReceipt(env, admission.id);
  if (existing) return existing;
  const receipt = spaceCreationReceiptIri(admission.id);
  const digest = hash(`${receipt}\0cancel`);
  const event = `urn:rezics:event:${digest}`;
  const batch = `urn:rezics:outbox:${digest}`;
  let updateError: unknown;
  try { await env.fuseki.update(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:SpaceCreationCancelledEvent ; rv:ordinal 0 ;
          rv:action "space.create" ; rv:receipt ${iri(receipt)} ;
          rv:admissionId ${lit(admission.id)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`); } catch (error) { updateError = error; }
  const committed = await readSpaceCreationReceipt(env, admission.id);
  if (!committed || committed.requestDigest !== admission.requestDigest
    || committed.admissionId !== admission.id
    || committed.authorityEpoch !== admission.authorityEpoch
    || committed.scope !== admission.scope) {
    throw new PendingActivation(updateError
      ? 'Space cancellation outcome unknown' : 'Space cancellation guard did not match');
  }
  return committed;
}
