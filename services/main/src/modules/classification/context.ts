import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, CancelledActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';

export const CLASSIFICATION_CONTEXT_PROFILE = 'https://rezics.com/definition/classification-context-v1';
export const GLOBAL_CLASSIFICATION_CONTEXT = 'urn:rezics:classification-context:global';
export const CLASSIFICATION_ISOLATE_POLICY = 'https://rezics.com/definition/classification-isolate-v1';
export const CLASSIFICATION_INHERIT_POLICY = 'https://rezics.com/definition/classification-inherit-global-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class InvalidClassificationContextInput extends Error {}
export class ClassificationRealmUnavailable extends Error {}

export interface CreateClassificationContextInput {
  realm: string;
  actingSubject: string;
}

export interface ClassificationContextReceipt {
  outcome: 'succeeded' | 'cancelled';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  context?: string;
  realm?: string;
  revision?: string;
}

export function classificationContextDigest(input: CreateClassificationContextInput): string {
  if (!nativeId.test(input.realm) || !nativeId.test(input.actingSubject)) {
    throw new InvalidClassificationContextInput('invalid classification context request');
  }
  return hash(JSON.stringify({ family: 'classification-context-v1', realm: input.realm,
    actingSubject: input.actingSubject, global: GLOBAL_CLASSIFICATION_CONTEXT,
    inheritancePolicy: CLASSIFICATION_INHERIT_POLICY }));
}

export function classificationContextReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0classification-context-create`)}`;
}

export async function readClassificationContextReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<ClassificationContextReceipt | null> {
  const receipt = classificationContextReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?digest ?id ?epoch ?scope ?dataEpoch ?sequence ?context ?realm ?revision WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:classificationContext ?context ; rv:realm ?realm ;
        rv:contextRevision ?revision }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id') || !value('epoch')
    || !value('scope') || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (outcome === 'succeeded' && (!value('context') || !value('realm') || !value('revision')))
    || (outcome === 'cancelled' && (value('context') || value('realm') || value('revision')))) {
    throw new Error('classification context receipt is incomplete');
  }
  return { outcome, receipt, admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { context: value('context'), realm: value('realm'),
      revision: value('revision') } : {}) };
}

function checked(receipt: ClassificationContextReceipt, admission: RegisteredAdmission,
  input: CreateClassificationContextInput, digest: string): ClassificationContextReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('classification context admission differs from receipt');
  }
  if (receipt.outcome === 'cancelled') throw new CancelledActivation('classification context creation was cancelled');
  if (receipt.realm !== input.realm) throw new IdempotencyConflict('classification Realm differs');
  return receipt;
}

async function validateCandidate(env: WorkActivationEnvironment, realm: string,
  context: string): Promise<CommandValidation[]> {
  iri(realm); iri(context);
  return profileValidations(env.fuseki, 'classification-context-v1', [
    { shape: `${CLASSIFICATION_CONTEXT_PROFILE}/global-shape`, focus: [GLOBAL_CLASSIFICATION_CONTEXT], graphs: [GRAPHS.current] },
    { shape: `${CLASSIFICATION_CONTEXT_PROFILE}/realm-shape`, focus: [realm], graphs: [GRAPHS.current] },
    { shape: `${CLASSIFICATION_CONTEXT_PROFILE}/context-shape`, focus: [context], graphs: [GRAPHS.current] },
  ]);
}

/** Provision an explicit role-specific context for one active public Realm. */
export async function createClassificationContext(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: CreateClassificationContextInput,
): Promise<ClassificationContextReceipt> {
  const digest = classificationContextDigest(input);
  if (admission.action !== 'classification.context.configure'
    || admission.scope !== `classification:context:${input.realm}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('classification context admission differs from intent');
  }
  const existing = await readClassificationContextReceipt(env, admission.id);
  if (existing) return checked(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('classification context admission expired');
  }
  const realmCheck = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
    ?space a rv:Space ; rv:realmCapability ${iri(input.realm)} ; rv:disclosure rv:Public .
    ${iri(input.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
    FILTER NOT EXISTS { ${iri(input.realm)} rv:classificationContext ?context }
  } }`);
  if (realmCheck.boolean !== true) throw new ClassificationRealmUnavailable('Realm is unavailable or configured');
  const context = ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await validateCandidate(env, input.realm, context);
  const manifest = prepareComponent(env.objectDirectory, context,
    { realm: input.realm, role: 'realm-classification', state: 'active',
      fallbackContext: GLOBAL_CLASSIFICATION_CONTEXT,
      inheritancePolicy: CLASSIFICATION_INHERIT_POLICY }, CLASSIFICATION_CONTEXT_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('classification context admission expired');
  }
  const receipt = classificationContextReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
        ${iri(input.realm)} rv:classificationContext ${iri(context)} .
        ${iri(context)} a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ;
          rv:contextState rv:Active ; rv:realm ${iri(input.realm)} ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:head ${iri(revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(context)} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(CLASSIFICATION_CONTEXT_PROFILE)} ;
          rv:shapeRevision ${iri(CLASSIFICATION_CONTEXT_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:classificationContext ${iri(context)} ; rv:realm ${iri(input.realm)} ;
          rv:contextRevision ${iri(revision)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ClassificationContextCreatedEvent ; rv:ordinal 0 ;
          rv:action "classification.context.configure" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:realm ${iri(input.realm)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(input.realm)} ; rv:disclosure rv:Public .
        ${iri(input.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.realm)} rv:classificationContext ?oldContext } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(context)} ?p ?o } }
      FILTER (!EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ?globalPredicate ?globalValue } }
        || EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
            rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
            rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} . } })
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?fallback } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm } }
      BIND(?n + 1 AS ?next)
    }` });
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new InvalidClassificationContextInput(`Classification context validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidClassificationContextInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readClassificationContextReceipt(env, admission.id);
  if (committed) return checked(committed, admission, input, digest);
  const occupied = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.realm)} rv:classificationContext ?context }
  }`);
  if (occupied.boolean === true) {
    throw new ClassificationRealmUnavailable('Realm classification context is already configured');
  }
  throw new PendingActivation(updateError
    ? 'classification context update outcome unknown' : 'classification context guard did not match');
}

/** Terminal receipt for a context admission closed before dispatch. */
export async function sealClassificationContextAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<ClassificationContextReceipt> {
  if (admission.action !== 'classification.context.configure'
    || !admission.scope.startsWith('classification:context:')) {
    throw new IdempotencyConflict('unsupported classification context admission');
  }
  const existing = await readClassificationContextReceipt(env, admission.id);
  if (existing) return existing;
  const receipt = classificationContextReceiptIri(admission.id);
  const digest = hash(`${receipt}\0cancel`);
  const event = `urn:rezics:event:${digest}`;
  const batch = `urn:rezics:outbox:${digest}`;
  let updateError: unknown;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
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
        ${iri(event)} a rv:ClassificationContextCancelledEvent ; rv:ordinal 0 ;
          rv:action "classification.context.configure" ; rv:receipt ${iri(receipt)} ;
          rv:admissionId ${lit(admission.id)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch (error) { updateError = error; }
  const committed = await readClassificationContextReceipt(env, admission.id);
  if (!committed || committed.requestDigest !== admission.requestDigest
    || committed.admissionId !== admission.id
    || committed.authorityEpoch !== admission.authorityEpoch
    || committed.scope !== admission.scope) {
    throw new PendingActivation(updateError
      ? 'classification context cancellation outcome unknown' : 'classification context cancellation guard did not match');
  }
  return committed;
}
