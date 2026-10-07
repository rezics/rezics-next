import { assertNotInvalidProfileReceipt } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from './context.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const CLASSIFICATION_DIRECT_DECISION_PROFILE =
  'https://rezics.com/definition/classification-direct-decision-v1';

export class InvalidClassificationDecisionInput extends Error {}
export class ClassificationDecisionUnavailable extends Error {}
export class StaleClassificationDecision extends Error {}

export type ClassificationDecisionContext = { kind: 'global' }
  | { kind: 'realm-classification'; id: string };
export interface SetClassificationDecisionInput {
  context: ClassificationDecisionContext;
  work: string;
  mainVersion: string;
  sense: string;
  expectedDecisionHead: string | null;
  outcome: 'accepted' | 'rejected';
  actingSubject: string;
}
export interface ClassificationDecisionReceipt {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head';
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string;
  operation?: string; work?: string; mainVersion?: string; sense?: string;
  context?: string; realm?: string; contextRevision?: string;
  slot?: string; application?: string; decision?: string;
  expectedHead?: string | null; decisionOutcome?: 'accepted' | 'rejected';
}

export function classificationDecisionScope(context: ClassificationDecisionContext): string {
  if (context.kind === 'global') return 'classification:decide:global';
  if (context.kind === 'realm-classification' && nativeId.test(context.id)) {
    return `classification:decide:${context.id}`;
  }
  throw new InvalidClassificationDecisionInput('invalid classification decision context');
}

export function classificationDecisionDigest(input: SetClassificationDecisionInput): string {
  classificationDecisionScope(input.context);
  if (!nativeId.test(input.work) || !nativeId.test(input.mainVersion)
    || !nativeId.test(input.sense) || !nativeId.test(input.actingSubject)
    || (input.expectedDecisionHead !== null && !nativeId.test(input.expectedDecisionHead))
    || !['accepted', 'rejected'].includes(input.outcome)) {
    throw new InvalidClassificationDecisionInput('invalid classification decision request');
  }
  return hash(JSON.stringify({ family: 'classification-direct-decision-v1',
    context: input.context, work: input.work, mainVersion: input.mainVersion,
    sense: input.sense, expectedDecisionHead: input.expectedDecisionHead,
    outcome: input.outcome, actingSubject: input.actingSubject }));
}

export function classificationDecisionSlotIri(mainVersion: string, sense: string,
  context: string): string {
  if (!nativeId.test(mainVersion) || !nativeId.test(sense)
    || (context !== GLOBAL_CLASSIFICATION_CONTEXT && !nativeId.test(context))) {
    throw new InvalidClassificationDecisionInput('invalid classification decision slot');
  }
  return `urn:rezics:classification-slot:${hash(JSON.stringify({ mainVersion,
    sense, context, channel: 'curated' }))}`;
}

export function classificationDecisionReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0classification-direct-decision`)}`;
}

export async function readClassificationDecisionReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<ClassificationDecisionReceipt | null> {
  const receipt = classificationDecisionReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?reason ?digest ?id ?epoch ?scope ?dataEpoch ?sequence ?operation ?work
    ?main ?sense ?context ?realm ?contextRevision ?slot ?application ?decision
    ?expectedHead ?decisionOutcome WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:operation ?operation ; rv:work ?work ;
        rv:mainVersion ?main ; rv:sense ?sense ; rv:classificationContext ?context ;
        rv:slot ?slot ; rv:application ?application ; rv:decision ?decision ;
        rv:decisionOutcome ?decisionOutcome .
        OPTIONAL { ${iri(receipt)} rv:realm ?realm }
        OPTIONAL { ${iri(receipt)} rv:contextRevision ?contextRevision }
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?expectedHead }
      }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}StaleHead` ? 'stale-head' : undefined;
  const decisionOutcome = value('decisionOutcome') === `${RV}Accepted` ? 'accepted'
    : value('decisionOutcome') === `${RV}Rejected` ? 'rejected' : undefined;
  const refs = ['operation', 'work', 'main', 'sense', 'context', 'slot', 'application', 'decision'];
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id') || !value('epoch')
    || !value('scope') || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (value('reason') && !reason)
    || (outcome === 'succeeded' && (refs.some((key) => !value(key))
      || !decisionOutcome || reason
      || (value('realm') && !value('contextRevision'))
      || (!value('realm') && value('contextRevision'))))
    || (outcome === 'cancelled' && (refs.some((key) => value(key))
      || value('realm') || value('contextRevision') || value('expectedHead')
      || value('decisionOutcome')))) {
    throw new Error('classification decision receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), receipt,
    admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? {
      operation: value('operation'), work: value('work'), mainVersion: value('main'),
      sense: value('sense'), context: value('context'), realm: value('realm'),
      contextRevision: value('contextRevision'), slot: value('slot'),
      application: value('application'), decision: value('decision'),
      expectedHead: value('expectedHead') ?? null, decisionOutcome,
    } : {}) };
}

function matches(receipt: ClassificationDecisionReceipt, admission: RegisteredAdmission,
  digest: string): boolean {
  return receipt.admissionId === admission.id && receipt.requestDigest === digest
    && receipt.authorityEpoch === admission.authorityEpoch && receipt.scope === admission.scope;
}

export function checkedClassificationDecisionReceipt(receipt: ClassificationDecisionReceipt,
  admission: RegisteredAdmission, input: SetClassificationDecisionInput,
  digest: string): ClassificationDecisionReceipt {
  if (!matches(receipt, admission, digest)) {
    throw new IdempotencyConflict('classification decision receipt differs from admission');
  }
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleClassificationDecision('classification decision is stale');
    throw new ClassificationDecisionUnavailable('classification decision was cancelled');
  }
  if (receipt.work !== input.work || receipt.mainVersion !== input.mainVersion
    || receipt.sense !== input.sense || receipt.decisionOutcome !== input.outcome
    || receipt.expectedHead !== input.expectedDecisionHead
    || receipt.realm !== (input.context.kind === 'realm-classification' ? input.context.id : undefined)
    || receipt.slot !== classificationDecisionSlotIri(input.mainVersion, input.sense,
      receipt.context!)) {
    throw new IdempotencyConflict('classification decision receipt targets another intent');
  }
  return receipt;
}

async function sealTerminal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  reason?: 'stale-head', slot?: string, expectedHead?: string | null,
): Promise<ClassificationDecisionReceipt | null> {
  const receipt = classificationDecisionReceiptIri(admission.id);
  const suffix = hash(`${receipt}\0${reason ? 'stale' : 'cancel'}`);
  const batch = `urn:rezics:outbox:${suffix}`;
  const event = `urn:rezics:event:${suffix}`;
  const staleGuard = reason && slot ? (expectedHead
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
         ?application rv:applicationKey ${iri(slot)} ; rv:decisionHead ${iri(expectedHead)} . } }`
    : `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} {
         ?application rv:applicationKey ${iri(slot)} ; rv:decisionHead ?prior . } }`) : '';
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
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
        ${iri(event)} a rv:${reason ? 'ClassificationDecisionStaleEvent' : 'ClassificationDecisionCancelledEvent'} ;
          rv:ordinal 0 ; rv:action "classification.decision.set" ; rv:receipt ${iri(receipt)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      ${staleGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch { /* resolve ambiguous update through terminal receipt */ }
  return readClassificationDecisionReceipt(env, admission.id);
}

export async function sealClassificationDecisionAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<ClassificationDecisionReceipt> {
  if (admission.action !== 'classification.decision.set'
    || !admission.scope.startsWith('classification:decide:')) {
    throw new IdempotencyConflict('unsupported classification decision admission');
  }
  const existing = await readClassificationDecisionReceipt(env, admission.id);
  if (existing) {
    if (!matches(existing, admission, admission.requestDigest)) {
      throw new IdempotencyConflict('classification decision receipt differs from admission');
    }
    return existing;
  }
  const terminal = await sealTerminal(env, admission);
  if (!terminal || !matches(terminal, admission, admission.requestDigest)) {
    throw new PendingActivation('classification decision cancellation outcome unknown');
  }
  return terminal;
}

/** Create or revise one curated decision without mutating a prior Decision record. */
export async function setClassificationDecision(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: SetClassificationDecisionInput,
): Promise<ClassificationDecisionReceipt> {
  const digest = classificationDecisionDigest(input);
  if (admission.action !== 'classification.decision.set'
    || admission.scope !== classificationDecisionScope(input.context)
    || admission.actingSubject !== input.actingSubject
    || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('classification decision admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, classificationDecisionReceiptIri(admission.id));
  const existing = await readClassificationDecisionReceipt(env, admission.id);
  if (existing) return checkedClassificationDecisionReceipt(existing, admission, input, digest);
  // Retained receipts still replay. Pending legacy admissions settle as cancellations;
  // no new ClassificationApplication or ClassificationDecision can be written.
  const cancelled = await sealTerminal(env, admission);
  if (!cancelled) throw new PendingActivation('retired classification admission outcome unknown');
  return checkedClassificationDecisionReceipt(cancelled, admission, input, digest);
}
