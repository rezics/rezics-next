import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from './proposition.ts';
import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from './context.ts';

const NONE = 'urn:rezics:none';
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

interface DecisionDependencies {
  context: string;
  realm?: string;
  contextRevision?: string;
  senseRevision: string;
  application?: string;
  prior?: string;
  proposer?: string;
}

async function readDependencies(env: WorkActivationEnvironment,
  input: SetClassificationDecisionInput): Promise<DecisionDependencies> {
  const realm = input.context.kind === 'realm-classification' ? input.context.id : undefined;
  const contextRows = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context ?contextRevision ?senseRevision WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.work)} a <https://schema.org/CreativeWork> ; rv:mainVersion ${iri(input.mainVersion)} .
      ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
      ${iri(input.sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
        rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:head ?senseRevision .
      ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
        rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
        rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
      ${realm ? `?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
        ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
          rv:classificationContext ?context .
        ?context a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ;
          rv:contextState rv:Active ; rv:realm ${iri(realm)} ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:head ?contextRevision .`
        : `BIND(${iri(GLOBAL_CLASSIFICATION_CONTEXT)} AS ?context)`}
      FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm }
      FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?globalFallback }
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?senseRevision a rv:RevisionAnchor ;
      rv:component ${iri(input.sense)} ;
      rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} . }
  }`);
  const rows = contextRows.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.context || !rows[0].senseRevision
    || (realm && !rows[0].contextRevision)) {
    throw new ClassificationDecisionUnavailable('classification target, Sense or Context is unavailable');
  }
  const context = rows[0].context.value;
  const slot = classificationDecisionSlotIri(input.mainVersion, input.sense, context);
  const applicationRows = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?application ?prior ?proposer WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      OPTIONAL { ?application a rv:ClassificationApplication ; rv:applicationKey ${iri(slot)} ;
        rv:targetMainVersion ${iri(input.mainVersion)} ; rv:sense ${iri(input.sense)} ;
        rv:classificationContext ${iri(context)} ; rv:applicationChannel rv:Curated ;
        rv:applicationState rv:Active ; rv:proposer ?proposer ; rv:decisionHead ?prior }
    }
  }`);
  const apps = applicationRows.results?.bindings ?? [];
  if (apps.length !== 1) throw new ClassificationDecisionUnavailable('classification slot is ambiguous');
  const app = apps[0]!;
  return { context, ...(realm ? { realm,
    contextRevision: rows[0].contextRevision!.value } : {}),
    senseRevision: rows[0].senseRevision.value,
    ...(app.application ? { application: app.application.value,
      prior: app.prior?.value, proposer: app.proposer?.value } : {}) };
}

async function validateCandidate(env: WorkActivationEnvironment,
  input: SetClassificationDecisionInput, dependencies: DecisionDependencies,
  application: string, decision: string, proposer: string, slot: string): Promise<CommandValidation[]> {
  for (const value of [input.work, input.mainVersion, input.sense, dependencies.context,
    dependencies.senseRevision, application, decision, proposer, slot]) iri(value);
  const profile = CLASSIFICATION_DIRECT_DECISION_PROFILE;
  const graphs = [GRAPHS.current, GRAPHS.revisions];
  return profileValidations(env.fuseki, 'classification-direct-decision-v1', [
    { shape: `${profile}/work-shape`, focus: [input.work], graphs },
    { shape: `${profile}/main-shape`, focus: [input.mainVersion], graphs },
    { shape: `${profile}/sense-shape`, focus: [input.sense], graphs },
    { shape: `${profile}/context-shape`, focus: [dependencies.context], graphs },
    { shape: `${profile}/application-shape`, focus: [application], graphs },
    { shape: `${profile}/decision-shape`, focus: [decision], graphs },
  ]);
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
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('classification decision admission expired');
  }
  const dependencies = await readDependencies(env, input);
  const slot = classificationDecisionSlotIri(input.mainVersion, input.sense,
    dependencies.context);
  if ((dependencies.prior ?? null) !== input.expectedDecisionHead) {
    const stale = await sealTerminal(env, admission, 'stale-head', slot,
      input.expectedDecisionHead);
    if (stale) return checkedClassificationDecisionReceipt(stale, admission, input, digest);
    throw new PendingActivation('stale classification decision was not sealed');
  }
  const application = dependencies.application ?? ID + Bun.randomUUIDv7();
  const proposer = dependencies.proposer ?? input.actingSubject;
  const decision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await validateCandidate(env, input, dependencies, application, decision, proposer, slot);
  const manifest = prepareComponent(env.objectDirectory, application,
    { application, slot, work: input.work, mainVersion: input.mainVersion,
      sense: input.sense, senseRevision: dependencies.senseRevision,
      context: dependencies.context, realm: dependencies.realm ?? null,
      contextRevision: dependencies.contextRevision ?? null,
      proposer, decision, predecessor: input.expectedDecisionHead,
      decider: input.actingSubject, outcome: input.outcome,
      policy: CLASSIFICATION_DIRECT_DECISION_PROFILE }, CLASSIFICATION_DIRECT_DECISION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('classification decision admission expired');
  }
  const receipt = classificationDecisionReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const realm = dependencies.realm;
  const previous = input.expectedDecisionHead;
  const createGuard = !previous
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
         ?occupied rv:applicationKey ${iri(slot)} } }
       FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(application)} ?p ?o } }`
    : `GRAPH ${iri(GRAPHS.current)} {
         ${iri(application)} a rv:ClassificationApplication ;
           rv:applicationKey ${iri(slot)} ; rv:targetMainVersion ${iri(input.mainVersion)} ;
           rv:sense ${iri(input.sense)} ; rv:classificationContext ${iri(dependencies.context)} ;
           rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ;
           rv:proposer ${iri(proposer)} ; rv:decisionHead ${iri(previous)} .
       }
       GRAPH ${iri(GRAPHS.revisions)} {
         ${iri(previous)} a rv:ClassificationDecision, rv:RevisionAnchor ;
           rv:application ${iri(application)} ; rv:component ${iri(application)} .
       }`;
  const contextGuard = realm
    ? `?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
       ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
         rv:classificationContext ${iri(dependencies.context)} .
       ${iri(dependencies.context)} a rv:ClassificationContext ;
         rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ;
         rv:realm ${iri(realm)} ; rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
         rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
         rv:head ${iri(dependencies.contextRevision!)} .`
    : '';
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${previous ? `GRAPH ${iri(GRAPHS.current)} {
        ${iri(application)} rv:decisionHead ${iri(previous)} }` : ''}
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(application)} a rv:ClassificationApplication ;
          rv:targetMainVersion ${iri(input.mainVersion)} ; rv:sense ${iri(input.sense)} ;
          rv:classificationContext ${iri(dependencies.context)} ;
          rv:applicationChannel rv:Curated ; rv:applicationState rv:Active ;
          rv:applicationKey ${iri(slot)} ; rv:proposer ${iri(proposer)} ;
          rv:decisionHead ${iri(decision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(decision)} a rv:ClassificationDecision, rv:RevisionAnchor ;
          rv:component ${iri(application)} ; rv:application ${iri(application)} ;
          rv:operation ${iri(operation)} ;
          rv:outcome rv:${input.outcome === 'accepted' ? 'Accepted' : 'Rejected'} ;
          rv:decisionBasis rv:${realm ? 'RealmManagerReview' : 'GlobalCuratorReview'} ;
          rv:decidedBy ${iri(input.actingSubject)} ;
          rv:decisionPolicy ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
          ${realm ? `rv:contextRevision ${iri(dependencies.contextRevision!)} ;` : ''}
          ${previous ? `rv:predecessor ${iri(previous)} ;` : ''}
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
          rv:shapeRevision ${iri(CLASSIFICATION_DIRECT_DECISION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:work ${iri(input.work)} ; rv:mainVersion ${iri(input.mainVersion)} ;
          rv:sense ${iri(input.sense)} ; rv:classificationContext ${iri(dependencies.context)} ;
          ${realm ? `rv:realm ${iri(realm)} ; rv:contextRevision ${iri(dependencies.contextRevision!)} ;` : ''}
          rv:slot ${iri(slot)} ; rv:application ${iri(application)} ;
          rv:decision ${iri(decision)} ;
          rv:decisionOutcome rv:${input.outcome === 'accepted' ? 'Accepted' : 'Rejected'} ;
          ${previous ? `rv:expectedHead ${iri(previous)} ;` : ''}
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ClassificationDecisionChangedEvent ; rv:ordinal 0 ;
          rv:action "classification.decision.set" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:work ${iri(input.work)} ;
          ${realm ? `rv:realm ${iri(realm)} ;` : ''}
          rv:application ${iri(application)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.work)} a schema:CreativeWork ; rv:mainVersion ${iri(input.mainVersion)} .
        ${iri(input.mainVersion)} a rv:MainVersion ; rv:work ${iri(input.work)} .
        ${iri(input.sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
          rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:head ${iri(dependencies.senseRevision)} .
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
        ${contextGuard}
        FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm }
        FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?globalFallback }
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(dependencies.senseRevision)} a rv:RevisionAnchor ;
          rv:component ${iri(input.sense)} ;
          rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} .
      }
      ${createGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new InvalidClassificationDecisionInput(`Classification decision validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidClassificationDecisionInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readClassificationDecisionReceipt(env, admission.id);
  if (committed) return checkedClassificationDecisionReceipt(committed, admission, input, digest);
  const stale = await sealTerminal(env, admission, 'stale-head', slot,
    input.expectedDecisionHead);
  if (stale) return checkedClassificationDecisionReceipt(stale, admission, input, digest);
  throw new PendingActivation(updateError
    ? 'classification decision update outcome unknown' : 'classification decision guard did not match');
}
