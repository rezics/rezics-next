import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RegisteredAdmission } from '../access/admission.ts';
import { REVIEW_POLICY, SELECTION_POLICY } from '../space/create.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { realmSelectionSlotIri } from './select-realm.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from './activate.ts';

export const REALM_REJECTION_PROFILE = 'https://rezics.com/definition/realm-local-rejection-v1';
const execFileAsync = promisify(execFile);
const NONE = 'urn:rezics:none';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class InvalidRealmRejectionInput extends Error {}
export class StaleRealmRejection extends Error {}
export class RealmRejectionUnavailable extends Error {}

export interface RejectRealmLocalInput {
  context: { kind: 'realm-local'; id: string };
  work: string;
  mainVersion: string;
  expectedSelectionHead: string | null;
  decisionBasis: 'realm-manager-review';
  reasonCode: 'not-approved';
  actingSubject: string;
}

export interface RealmRejectionReceipt {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  operation?: string;
  work?: string;
  mainVersion?: string;
  realm?: string;
  slot?: string;
  rejection?: string;
  expectedHead?: string | null;
  reasonCode?: 'not-approved';
}

export function realmRejectionDigest(input: RejectRealmLocalInput): string {
  if (input.context?.kind !== 'realm-local' || !nativeId.test(input.context.id)
    || !nativeId.test(input.work) || !nativeId.test(input.mainVersion)
    || !nativeId.test(input.actingSubject)
    || (input.expectedSelectionHead !== null && !nativeId.test(input.expectedSelectionHead))
    || input.decisionBasis !== 'realm-manager-review'
    || input.reasonCode !== 'not-approved') {
    throw new InvalidRealmRejectionInput('invalid Realm rejection');
  }
  return hash(JSON.stringify({ family: 'reject-realm-local-v1', context: input.context,
    work: input.work, mainVersion: input.mainVersion,
    expectedSelectionHead: input.expectedSelectionHead,
    decisionBasis: input.decisionBasis, reasonCode: input.reasonCode,
    actor: input.actingSubject, selectionPolicy: SELECTION_POLICY,
    reviewPolicy: REVIEW_POLICY }));
}

export function realmRejectionReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0reject-realm-local`)}`;
}

export async function readRealmRejectionReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<RealmRejectionReceipt | null> {
  const receipt = realmRejectionReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?epoch ?scope ?dataEpoch ?sequence
    ?operation ?work ?main ?realm ?slot ?rejection ?prior ?reasonCode WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:operation ?operation ; rv:work ?work ;
        rv:mainVersion ?main ; rv:realm ?realm ; rv:slot ?slot ;
        rv:rejection ?rejection ; rv:reasonCode ?reasonCode .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?prior } }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Realm rejection receipt cardinality violation');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}StaleHead` ? 'stale-head' : undefined;
  const reasonCode = value('reasonCode') === `${RV}NotApproved` ? 'not-approved' : undefined;
  if (!outcome || !value('digest') || !value('id') || !value('epoch') || !value('scope')
    || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (value('reason') && !reason) || (value('reasonCode') && !reasonCode)
    || (outcome === 'succeeded' && (!value('operation') || !value('work')
      || !value('main') || !value('realm') || !value('slot') || !value('rejection')
      || !reasonCode || reason))
    || (outcome === 'cancelled' && (value('operation') || value('work')
      || value('main') || value('realm') || value('slot') || value('rejection')
      || value('prior') || value('reasonCode')))) {
    throw new Error('Realm rejection receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { operation: value('operation'), work: value('work'),
      mainVersion: value('main'), realm: value('realm'), slot: value('slot'),
      rejection: value('rejection'), expectedHead: value('prior') ?? null,
      reasonCode } : {}) };
}

function matches(receipt: RealmRejectionReceipt, admission: RegisteredAdmission,
  digest: string): boolean {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

export function checkedRealmRejectionReceipt(receipt: RealmRejectionReceipt,
  admission: RegisteredAdmission, input: RejectRealmLocalInput,
  digest: string): RealmRejectionReceipt {
  if (!matches(receipt, admission, digest)) {
    throw new IdempotencyConflict('Realm rejection receipt differs');
  }
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleRealmRejection('Realm rejection is stale');
    throw new RealmRejectionUnavailable('Realm rejection was cancelled');
  }
  if (receipt.work !== input.work || receipt.mainVersion !== input.mainVersion
    || receipt.realm !== input.context.id
    || receipt.slot !== realmSelectionSlotIri(input.context.id, input.mainVersion)
    || receipt.expectedHead !== input.expectedSelectionHead
    || receipt.reasonCode !== input.reasonCode) {
    throw new IdempotencyConflict('Realm rejection receipt targets another intent');
  }
  return receipt;
}

async function sealTerminal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'stale-head', input?: RejectRealmLocalInput): Promise<RealmRejectionReceipt | null> {
  const receipt = realmRejectionReceiptIri(admission.id);
  const suffix = hash(`${receipt}\0${reason ? 'stale' : 'cancel'}`);
  const batch = `urn:rezics:outbox:${suffix}`;
  const event = `urn:rezics:event:${suffix}`;
  const slot = input && realmSelectionSlotIri(input.context.id, input.mainVersion);
  const staleGuard = reason && input && slot ? `GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.context.id)} a rv:Realm ; rv:realmState rv:Active .
      ${iri(input.work)} rv:mainVersion ${iri(input.mainVersion)} .
      OPTIONAL { ${iri(slot)} rv:selectionHead ?prior }
    }
    FILTER(COALESCE(?prior, ${iri(NONE)}) != ${iri(input.expectedSelectionHead ?? NONE)})` : '';
  try { await env.fuseki.update(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          ${reason ? 'rv:reason rv:StaleHead ;' : ''}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:${reason ? 'RealmPublicationSuppressionRejectedEvent' : 'RealmPublicationSuppressionCancelledEvent'} ;
          rv:ordinal 0 ; rv:action "publication.reject" ; rv:receipt ${iri(receipt)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      ${staleGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`); } catch { /* resolve ambiguous update through the receipt */ }
  return readRealmRejectionReceipt(env, admission.id);
}

export async function sealRealmRejectionAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<RealmRejectionReceipt> {
  if (admission.action !== 'publication.reject') throw new Error('unsupported Realm rejection admission');
  const existing = await readRealmRejectionReceipt(env, admission.id);
  if (existing) {
    if (!matches(existing, admission, admission.requestDigest)) {
      throw new IdempotencyConflict('Realm rejection receipt differs from admission');
    }
    return existing;
  }
  const terminal = await sealTerminal(env, admission);
  if (!terminal || !matches(terminal, admission, admission.requestDigest)) {
    throw new PendingActivation('Realm rejection cancellation is unknown');
  }
  return terminal;
}

async function validateCandidate(env: WorkActivationEnvironment, rejection: string,
  slot: string, input: RejectRealmLocalInput): Promise<void> {
  mkdirSync(env.candidateDirectory, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(env.candidateDirectory, 'realm-rejection-'));
  try {
    const data = join(temp, 'candidate.ttl');
    writeFileSync(data, `@prefix rv: <${RV}> .\n` +
      `${iri(rejection)} a rv:RealmPublicationRejection ; ` +
      `rv:context ${iri(input.context.id)} ; rv:slot ${iri(slot)} ; ` +
      `rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.mainVersion)} ; ` +
      `rv:decisionBasis rv:RealmManagerReview ; rv:reasonCode rv:NotApproved ; ` +
      `rv:selectionPolicy ${iri(SELECTION_POLICY)} ; ` +
      `rv:reviewPolicy ${iri(REVIEW_POLICY)} ; rv:outcome rv:Rejected .\n`,
    { mode: 0o600 });
    const { stdout } = await execFileAsync(env.python, [
      join(env.repositoryRoot, 'model/tools/validate_realm_local_rejection.py'),
      '--data', data, '--rejection', rejection,
      '--jena-home', env.jenaHome, '--java-home', env.javaHome,
      '--temp-root', env.candidateDirectory,
    ], { cwd: env.repositoryRoot, timeout: 20_000, maxBuffer: 128 * 1024 });
    const report = JSON.parse(stdout) as { conforms: boolean; profile_sha256: string };
    if (report.conforms !== true || !report.profile_sha256) {
      throw new Error('Realm rejection candidate validation incomplete');
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

/** Reject publication for one Realm/Main Version slot, suppressing Main fallback. */
export async function rejectRealmLocal(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: RejectRealmLocalInput): Promise<RealmRejectionReceipt> {
  const digest = realmRejectionDigest(input);
  if (admission.action !== 'publication.reject'
    || admission.scope !== `publication:reject:${input.context.id}`
    || admission.actingSubject !== input.actingSubject
    || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('Realm rejection admission differs from intent');
  }
  const existing = await readRealmRejectionReceipt(env, admission.id);
  if (existing) return checkedRealmRejectionReceipt(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Realm rejection expired');
  const slot = realmSelectionSlotIri(input.context.id, input.mainVersion);
  const current = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?prior WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(input.context.id)} ; rv:disclosure rv:Public .
        ${iri(input.context.id)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} ; rv:reviewPolicy ${iri(REVIEW_POLICY)} .
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
        OPTIONAL { ${iri(slot)} rv:selectionHead ?prior }
      }
    }`);
  const rows = current.results?.bindings ?? [];
  if (rows.length !== 1) {
    throw new RealmRejectionUnavailable('Realm or Main Version is unavailable');
  }
  if ((rows[0]?.prior?.value ?? null) !== input.expectedSelectionHead) {
    const stale = await sealTerminal(env, admission, 'stale-head', input);
    if (stale) return checkedRealmRejectionReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale Realm rejection was not sealed');
  }
  const rejection = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  await validateCandidate(env, rejection, slot, input);
  const manifest = prepareComponent(env.objectDirectory, slot,
    { context: input.context, slot, work: input.work, mainVersion: input.mainVersion,
      decisionBasis: input.decisionBasis, reasonCode: input.reasonCode,
      reviewer: input.actingSubject, predecessor: input.expectedSelectionHead,
      selectionPolicy: SELECTION_POLICY, reviewPolicy: REVIEW_POLICY,
      outcome: 'rejected' }, REALM_REJECTION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('Realm rejection expired');
  const receipt = realmRejectionReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const predecessorTriple = input.expectedSelectionHead
    ? `rv:predecessor ${iri(input.expectedSelectionHead)} ;` : '';
  const receiptPredecessor = input.expectedSelectionHead
    ? `rv:expectedHead ${iri(input.expectedSelectionHead)} ;` : '';
  try { await env.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:selectionHead ?prior }
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?oldUnit ?oldPredicate ?oldValue }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(slot)} a rv:RealmPublicationSlot ; rv:realm ${iri(input.context.id)} ;
          rv:mainVersion ${iri(input.mainVersion)} ; rv:work ${iri(input.work)} ;
          rv:selectionHead ${iri(rejection)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(rejection)} a rv:RealmPublicationRejection, rv:RevisionAnchor ;
          rv:component ${iri(slot)} ; ${predecessorTriple}
          rv:operation ${iri(operation)} ; rv:context ${iri(input.context.id)} ;
          rv:slot ${iri(slot)} ; rv:work ${iri(input.work)} ;
          rv:mainVersion ${iri(input.mainVersion)} ;
          rv:decisionBasis rv:RealmManagerReview ; rv:reasonCode rv:NotApproved ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} ;
          rv:reviewPolicy ${iri(REVIEW_POLICY)} ; rv:reviewer ${iri(input.actingSubject)} ;
          rv:outcome rv:Rejected ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(REALM_REJECTION_PROFILE)} ;
          rv:shapeRevision ${iri(REALM_REJECTION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.mainVersion)} ;
          rv:realm ${iri(input.context.id)} ; rv:slot ${iri(slot)} ;
          rv:rejection ${iri(rejection)} ; rv:reasonCode rv:NotApproved ;
          ${receiptPredecessor}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:RealmPublicationSuppressedEvent ; rv:ordinal 0 ;
          rv:action "publication.reject" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:work ${iri(input.work)} ;
          rv:realm ${iri(input.context.id)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(input.context.id)} ; rv:disclosure rv:Public .
        ${iri(input.context.id)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:selectionPolicy ${iri(SELECTION_POLICY)} ; rv:reviewPolicy ${iri(REVIEW_POLICY)} .
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
        OPTIONAL { ${iri(slot)} rv:selectionHead ?prior }
      }
      OPTIONAL {
        FILTER(BOUND(?prior))
        GRAPH ${iri(GRAPHS.revisions)} { ?prior rv:matchUnit ?oldUnit ; rv:slot ${iri(slot)} }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} {
          ?oldUnit a rv:MatchUnit ; rv:slot ${iri(slot)} ; rv:selection ?prior .
          ?oldUnit ?oldPredicate ?oldValue .
        }
      }
      OPTIONAL {
        FILTER(BOUND(?prior))
        GRAPH ${iri(GRAPHS.revisions)} {
          ?prior a rv:RealmPublicationRejection ; rv:slot ${iri(slot)} .
        }
        BIND(true AS ?priorRejected)
      }
      FILTER(COALESCE(?prior, ${iri(NONE)}) = ${iri(input.expectedSelectionHead ?? NONE)})
      FILTER(!BOUND(?prior) || (BOUND(?oldUnit) != BOUND(?priorRejected)))
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(rejection)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`); } catch { /* resolve by terminal receipt */ }
  const committed = await readRealmRejectionReceipt(env, admission.id);
  if (committed) return checkedRealmRejectionReceipt(committed, admission, input, digest);
  const stale = await sealTerminal(env, admission, 'stale-head', input);
  if (stale) return checkedRealmRejectionReceipt(stale, admission, input, digest);
  throw new PendingActivation('Realm rejection guard did not match');
}
