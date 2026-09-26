import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import type { ProtectionAdmissionSigner } from '../access/protection-admission.ts';
import { CommandRejected, type CommandEnvelope } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CONTINUITY, DATASET, GRAPHS, ID, PROFILE, RV, hash, iri, lit,
  metadataWorkRequestDigest, prepareComponent, prepareWorkComponent, workMetadataValidations,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { readWorkPayloadForRevision } from '../work/history.ts';
import { PROTECTION_RULE } from './schema.ts';
import { protectionReceiptIri, workReceiptFamilies, type WorkProtectionAdmissionAction } from './receipt-family.ts';

const PROTECTION_PROFILE = 'https://rezics.com/definition/protection-revision-v1';
const PROPOSAL_PROFILE = 'https://rezics.com/definition/correction-proposal-v1';
const DECISION_PROFILE = 'https://rezics.com/definition/correction-decision-v1';
const CONTROL_PROFILE = 'https://rezics.com/definition/work-title-control-v1';
const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAX_EVIDENCE = 32;
const JSON_LIMIT = 16_000;

export interface WorkEditorialBasis {
  work: string; expectedHead: string; expectedProtection: string | null;
  expectedControl: string | null; expectedControlEpoch: string; expectedRuleRevision: typeof PROTECTION_RULE;
  actingSubject: string; reason: string; evidence: string[]; idempotencyKey: string;
}
export interface WorkProtectionChange extends WorkEditorialBasis { action: 'tighten' | 'confirm' | 'relax' }
export interface WorkCorrectionProposal extends WorkEditorialBasis { title: string; predecessor: string | null }
export interface WorkCorrectionReview extends WorkEditorialBasis {
  proposalRevision: string; candidateDigest: string; expectedDecisionHead: null; outcome: 'approved' | 'rejected';
}
export interface WorkProtectionReceipt {
  outcome: 'succeeded' | 'cancelled'; action: WorkProtectionAdmissionAction;
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string; scope: string;
  dataEpoch: string; sequence: string; work?: string; protectionRevision?: string;
  proposalRevision?: string; decision?: string; reviewOutcome?: 'approved' | 'rejected';
  control?: string; workRevision?: string; operation?: string; replayed: boolean;
}
export class WorkProtectionInvalid extends Error {}
export class WorkProtectionConflict extends Error {
  constructor(message: string, readonly terminal?: WorkProtectionReceipt) { super(message); }
}
export class WorkProtectionPending extends Error {
  constructor(readonly admissionId: string) { super('protected Work outcome is pending'); }
}
export class WorkProtectionUnavailable extends Error {}
export class WorkProtectionMissing extends Error {}

const family = (action: WorkProtectionAdmissionAction) => workReceiptFamilies[action];
const eventKind = (action: WorkProtectionAdmissionAction, outcome: 'Succeeded' | 'Cancelled') => ({
  'work.protection.tighten': outcome === 'Succeeded' ? 'WorkProtectionTightenedEvent' : 'WorkProtectionTighteningCancelledEvent',
  'work.protection.confirm': outcome === 'Succeeded' ? 'WorkProtectionConfirmedEvent' : 'WorkProtectionConfirmationCancelledEvent',
  'work.protection.relax': outcome === 'Succeeded' ? 'WorkProtectionRelaxedEvent' : 'WorkProtectionRelaxationCancelledEvent',
  'work.correction.propose': outcome === 'Succeeded' ? 'WorkCorrectionProposedEvent' : 'WorkCorrectionProposalCancelledEvent',
  'work.correction.review': outcome === 'Succeeded' ? 'WorkCorrectionReviewedEvent' : 'WorkCorrectionReviewCancelledEvent',
})[action];
const operationId = (admission: RegisteredAdmission) => ID + admission.id;

function validateBasis(input: WorkEditorialBasis) {
  if (!NATIVE.test(input.work) || !NATIVE.test(input.expectedHead)
    || (input.expectedProtection !== null && !NATIVE.test(input.expectedProtection))
    || (input.expectedControl !== null && !NATIVE.test(input.expectedControl))
    || !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedControlEpoch)
    || (input.expectedControl === null) !== (input.expectedControlEpoch === '0')
    || input.expectedRuleRevision !== PROTECTION_RULE || !NATIVE.test(input.actingSubject)
    || input.reason.trim().length < 1 || input.reason.length > 2000
    || input.evidence.length > MAX_EVIDENCE || new Set(input.evidence).size !== input.evidence.length
    || input.evidence.some(value => !/^(?:https:\/\/rezics\.com\/id\/[0-9a-f-]{36}|urn:rezics:[A-Za-z0-9:._-]{1,250})$/.test(value))) {
    throw new WorkProtectionInvalid('exact bounded Work editorial basis is required');
  }
}

function digest(profile: string, value: WorkProtectionChange | WorkCorrectionProposal | WorkCorrectionReview) {
  const basis = { profile, work: value.work, expectedHead: value.expectedHead,
    expectedProtection: value.expectedProtection, expectedControl: value.expectedControl,
    expectedControlEpoch: value.expectedControlEpoch, expectedRuleRevision: value.expectedRuleRevision,
    actingSubject: value.actingSubject, reason: value.reason, evidence: [...value.evidence].sort() };
  return hash(JSON.stringify('action' in value ? { ...basis, action: value.action }
    : 'title' in value ? { ...basis, title: value.title, predecessor: value.predecessor }
      : { ...basis, proposalRevision: value.proposalRevision, candidateDigest: value.candidateDigest,
        expectedDecisionHead: value.expectedDecisionHead, outcome: value.outcome }));
}
export const workProtectionDigest = digest;
function put(env: WorkActivationEnvironment, component: string, state: object, profile: string) {
  return env.workObjects ? prepareWorkComponent(env.workObjects, component, state, profile)
    : Promise.resolve(prepareComponent(env.objectDirectory, component, state, profile));
}
function expected(value: string | null) { return value === null ? 'rv:Absent' : iri(value); }
function guard(input: WorkEditorialBasis, extra = '') {
  return `GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:head ${iri(input.expectedHead)} ;
    <http://www.w3.org/2000/01/rdf-schema#label> ?oldTitle .
    OPTIONAL { ${iri(input.work)} rv:protectionHead ?oldProtection }
    OPTIONAL { ${iri(input.work)} rv:titleControlHead ?oldControl } }
    FILTER(${input.expectedProtection ? `?oldProtection = ${iri(input.expectedProtection)}` : '!BOUND(?oldProtection)'})
    FILTER(${input.expectedControl ? `?oldControl = ${iri(input.expectedControl)}` : '!BOUND(?oldControl)'})
    ${extra}`;
}
function envelope(env: WorkActivationEnvironment, admission: RegisteredAdmission, effect: string,
  outcome: 'Succeeded' | 'Cancelled', extraReceipt = '') {
  const receipt = protectionReceiptIri(admission.id, admission.action as WorkProtectionAdmissionAction);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
  const common = `rv:action ${lit(admission.action)} ; rv:admissionId ${lit(admission.id)} ;
    rv:requestDigest ${lit(admission.requestDigest)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
    rv:admittedScope ${lit(admission.scope)} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next`;
  return { receipt, batch, event,
    receiptTriples: `${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:${outcome} ; ${common}${extraReceipt ? ` ; ${extraReceipt}` : ''} .`,
    outboxTriples: `${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
      ${iri(event)} a rv:${eventKind(admission.action as WorkProtectionAdmissionAction, outcome)} ;
      rv:ordinal 0 ; rv:action ${lit(admission.action)} ; rv:receipt ${iri(receipt)} .`,
    operation: effect };
}

export async function readWorkProtectionReceipt(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  admissionId: string, action: WorkProtectionAdmissionAction): Promise<WorkProtectionReceipt | null> {
  const receipt = protectionReceiptIri(admissionId, action);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?recordedAction ?digest ?authority
    ?scope ?epoch ?sequence ?work ?protection ?proposal ?decision ?review ?control ?revision ?operation WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
      rv:action ?recordedAction ; rv:requestDigest ?digest ; rv:authorityEpoch ?authority ;
      rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:work ?work }
      OPTIONAL { ${iri(receipt)} rv:protectionRevision ?protection }
      OPTIONAL { ${iri(receipt)} rv:proposalRevision ?proposal }
      OPTIONAL { ${iri(receipt)} rv:decision ?decision }
      OPTIONAL { ${iri(receipt)} rv:reviewOutcome ?review }
      OPTIONAL { ${iri(receipt)} rv:titleControl ?control }
      OPTIONAL { ${iri(receipt)} rv:workRevision ?revision }
      OPTIONAL { ${iri(receipt)} rv:operation ?operation }
    }
  } LIMIT 2`, 16_384)).results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || row.recordedAction?.value !== action || !row.digest || !row.authority
    || !row.scope || !row.epoch || !row.sequence) throw new WorkProtectionUnavailable('ambiguous Work protection receipt');
  if (![`${RV}Succeeded`, `${RV}Cancelled`].includes(row.outcome?.value ?? '')
    || (row.review && ![`${RV}Accepted`, `${RV}Rejected`].includes(row.review.value))) {
    throw new WorkProtectionUnavailable('Work protection receipt outcome is invalid');
  }
  const succeeded = row.outcome?.value === `${RV}Succeeded`;
  if (!succeeded && (row.work || row.protection || row.proposal || row.decision
    || row.review || row.control || row.revision || row.operation)) {
    throw new WorkProtectionUnavailable('cancelled Work receipt has an effect');
  }
  if (succeeded && (!row.work || !row.operation
    || (action.startsWith('work.protection.') && !row.protection)
    || (action === 'work.correction.propose' && !row.proposal)
    || (action === 'work.correction.review' && (!row.proposal || !row.decision || !row.review)))) {
    throw new WorkProtectionUnavailable('protected Work receipt has an incomplete effect');
  }
  return { outcome: succeeded ? 'succeeded' : 'cancelled', action, receipt, admissionId,
    requestDigest: row.digest.value, authorityEpoch: row.authority.value, scope: row.scope.value,
    dataEpoch: row.epoch.value, sequence: row.sequence.value, replayed: true,
    ...(row.work ? { work: row.work.value } : {}),
    ...(row.protection ? { protectionRevision: row.protection.value } : {}),
    ...(row.proposal ? { proposalRevision: row.proposal.value } : {}),
    ...(row.decision ? { decision: row.decision.value } : {}),
    ...(row.review ? { reviewOutcome: row.review.value === `${RV}Accepted` ? 'approved' as const : 'rejected' as const } : {}),
    ...(row.control ? { control: row.control.value } : {}),
    ...(row.revision ? { workRevision: row.revision.value } : {}),
    ...(row.operation ? { operation: row.operation.value } : {}) };
}

export async function cancelWorkProtection(env: WorkActivationEnvironment, admission: RegisteredAdmission) {
  if (!Object.hasOwn(workReceiptFamilies, admission.action)) throw new WorkProtectionInvalid('wrong Work protection action');
  const e = envelope(env, admission, '', 'Cancelled');
  const update = `PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${e.receiptTriples} }
      GRAPH ${iri(GRAPHS.outbox)} { ${e.outboxTriples} } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(e.receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next) }`;
  await env.fuseki.commandWithReceipt({ receipt: e.receipt, digest: admission.requestDigest,
    update, validations: [], deadlineMs: 10_000 });
  const terminal = await readWorkProtectionReceipt(env, admission.id, admission.action as WorkProtectionAdmissionAction);
  if (!terminal) throw new WorkProtectionPending(admission.id);
  return terminal;
}

async function currentWork(env: WorkActivationEnvironment, work: string, head: string) {
  const state = await readWorkEditorialState(env, work);
  if (!state) throw new WorkProtectionUnavailable('Work is unavailable');
  if (state.contentHead !== head) throw new WorkProtectionConflict('Work head changed');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?main ?manifest WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a <https://schema.org/CreativeWork> ; rv:head ${iri(head)} ;
      rv:mainVersion ?main . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} a rv:RevisionAnchor ; rv:component ${iri(work)} ;
      rv:manifest ?manifest ; rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} . }
  } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.main || !rows[0]?.manifest) throw new WorkProtectionUnavailable('Work head is unavailable');
  const payload = await readWorkPayloadForRevision(env, rows[0].manifest.value, work);
  if (payload.mainVersion !== rows[0].main.value) throw new WorkProtectionUnavailable('Work payload differs from current head');
  return payload;
}

async function changeCommand(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: WorkProtectionChange): Promise<CommandEnvelope> {
  const prior = await currentWork(env, input.work, input.expectedHead);
  const protection = ID + Bun.randomUUIDv7();
  const control = input.action === 'confirm' ? ID + Bun.randomUUIDv7() : null;
  const operation = operationId(admission);
  const intent = { ...input, action: admission.action, operation };
  if (JSON.stringify(intent).length > JSON_LIMIT) throw new WorkProtectionInvalid('protection intent exceeds its bound');
  const manifest = await put(env, input.work, { intent, protection, control }, PROTECTION_PROFILE);
  const controlManifest = control ? await put(env, input.work,
    { intent, control, workRevision: input.expectedHead }, CONTROL_PROFILE) : null;
  const e = envelope(env, admission, operation, 'Succeeded', `rv:work ${iri(input.work)} ;
    rv:expectedHead ${iri(input.expectedHead)} ; rv:expectedProtection ${expected(input.expectedProtection)} ;
    rv:expectedControl ${expected(input.expectedControl)} ; rv:expectedControlEpoch ${input.expectedControlEpoch} ;
    rv:protectionRevision ${iri(protection)} ; rv:operation ${iri(operation)}${control ? ` ; rv:titleControl ${iri(control)}` : ''}`);
  const predecessor = input.expectedProtection ? `rv:predecessor ${iri(input.expectedProtection)} ;` : '';
  const controlPredecessor = input.expectedControl ? `rv:predecessor ${iri(input.expectedControl)} ;` : '';
  const evidence = input.evidence.map(item => `rv:evidence ${iri(item)} ;`).join(' ');
  const mode = input.action === 'relax' ? 'Open' : 'ReviewRequired';
  const kind = input.action[0]!.toUpperCase() + input.action.slice(1);
  const deleteControl = control ? `${iri(input.work)} rv:titleControlHead ?oldControl .` : '';
  const insertControl = control ? `${iri(input.work)} rv:titleControlHead ${iri(control)} .` : '';
  const controlTriples = control ? `${iri(control)} a rv:RevisionAnchor, rv:EditorialControlRevision ;
    rv:component ${iri(input.work)} ; rv:controlField "title:en" ; rv:controlMode rv:HumanControlled ;
    rv:controlEpoch ${BigInt(input.expectedControlEpoch) + 1n} ; rv:workRevision ${iri(input.expectedHead)} ;
    rv:operation ${iri(operation)} ; ${controlPredecessor} rv:controlIntent ${lit(JSON.stringify(intent))} ;
    rv:manifest ${iri(`urn:rezics:sha256:${controlManifest}`)} ; rv:modelRevision ${iri(CONTROL_PROFILE)} ;
    rv:shapeRevision ${iri(CONTROL_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .` : '';
  const update = `PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:protectionHead ?oldProtection . ${deleteControl} } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:protectionHead ${iri(protection)} . ${insertControl} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(protection)} a rv:RevisionAnchor, rv:ProtectionRevision ;
        rv:component ${iri(input.work)} ; rv:protectedSlot "title:en" ; rv:adoptionContext rv:GlobalNative ;
        rv:protectionAction rv:${kind} ; rv:protectionMode rv:${mode} ;
        rv:protectionEpoch ${input.expectedProtection ? '?nextProtectionEpoch' : '1'} ; ${predecessor}
        rv:ruleRevision ${iri(PROTECTION_RULE)} ; rv:workRevision ${iri(input.expectedHead)} ;
        ${control ? `rv:controlRevision ${iri(control)} ;` : ''} ${evidence}
        rv:operation ${iri(operation)} ; rv:protectionIntent ${lit(JSON.stringify(intent))} ;
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:modelRevision ${iri(PROTECTION_PROFILE)} ;
        rv:shapeRevision ${iri(PROTECTION_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . ${controlTriples} }
      GRAPH ${iri(GRAPHS.receipts)} { ${e.receiptTriples} }
      GRAPH ${iri(GRAPHS.outbox)} { ${e.outboxTriples} } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      ${guard(input, input.expectedProtection ? `GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.expectedProtection)} rv:protectionEpoch ?priorProtectionEpoch . }
        BIND(?priorProtectionEpoch + 1 AS ?nextProtectionEpoch)` : '')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(e.receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next) }`;
  const validations = await profileValidations(env.fuseki, 'protection-revision-v1', [
    { shape: `${PROTECTION_PROFILE}/target-shape`, focus: [input.work], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${PROTECTION_PROFILE}/protection-shape`, focus: [protection], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  if (control) validations.push(...await profileValidations(env.fuseki, 'work-title-control-v1', [
    { shape: `${CONTROL_PROFILE}/control-shape`, focus: [control], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]));
  // A protection decision leaves the exact Work payload unchanged.
  if (prior.title.length < 1) throw new WorkProtectionUnavailable('Work title is unavailable');
  return { receipt: e.receipt, digest: admission.requestDigest, update, validations, deadlineMs: 10_000 };
}

function correctionLog(work: string) { return `urn:rezics:correction-log:${hash(`${work}\0title:en`)}`; }
function decisionId(proposal: string) { return `urn:rezics:correction-decision:${hash(proposal)}`; }
function applicationId(proposal: string) { return `urn:rezics:correction-application:${hash(proposal)}`; }

async function proposeCommand(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: WorkCorrectionProposal): Promise<CommandEnvelope> {
  const prior = await currentWork(env, input.work, input.expectedHead);
  metadataWorkRequestDigest(input.title);
  if (input.predecessor !== null) throw new WorkProtectionInvalid('amendment requires a separate proposal profile');
  const proposal = ID + Bun.randomUUIDv7(), candidate = ID + Bun.randomUUIDv7();
  const operation = operationId(admission), log = correctionLog(input.work);
  const logRows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?count WHERE {
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(log)} rv:proposalHead ?head ; rv:proposalCount ?count . } }
  } LIMIT 2`, 2048)).results?.bindings ?? [];
  if (logRows.length !== 1 || (logRows[0]?.head && !logRows[0]?.count)
    || (!logRows[0]?.head && logRows[0]?.count)) throw new WorkProtectionUnavailable('correction log is ambiguous');
  const logHead = logRows[0]?.head?.value ?? null;
  const logCount = logRows[0]?.count?.value ?? '0';
  if (!/^(0|[1-9][0-9]{0,17})$/.test(logCount)) throw new WorkProtectionUnavailable('correction log count is invalid');
  const intent = { ...input, action: admission.action, proposal, candidate, operation };
  if (JSON.stringify(intent).length > JSON_LIMIT) throw new WorkProtectionInvalid('proposal intent exceeds its bound');
  const candidateDigest = hash(input.title);
  const candidateManifest = await put(env, input.work, { mainVersion: prior.mainVersion,
    continuityProfile: CONTINUITY, title: input.title, language: 'en',
    ...(prior.semanticTypes.length ? { semanticTypes: prior.semanticTypes } : {}),
    ...(prior.scalarValue === undefined ? {} : { scalarValue: prior.scalarValue }) }, PROFILE);
  const proposalManifest = await put(env, input.work, { intent, proposal, candidate, candidateDigest }, PROPOSAL_PROFILE);
  const e = envelope(env, admission, operation, 'Succeeded', `rv:work ${iri(input.work)} ;
    rv:expectedHead ${iri(input.expectedHead)} ; rv:expectedProtection ${expected(input.expectedProtection)} ;
    rv:expectedControl ${expected(input.expectedControl)} ; rv:expectedControlEpoch ${input.expectedControlEpoch} ;
    rv:proposalRevision ${iri(proposal)} ; rv:operation ${iri(operation)}`);
  const evidence = input.evidence.map(item => `rv:evidence ${iri(item)} ;`).join(' ');
  const update = `PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(log)} rv:proposalHead ?oldLogHead ; rv:proposalCount ?oldLogCount . } }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(log)} a rv:CorrectionLog ; rv:component ${iri(input.work)} ;
        rv:protectedSlot "title:en" ; rv:adoptionContext rv:GlobalNative ; rv:proposalHead ${iri(proposal)} ;
        rv:proposalCount ${BigInt(logCount) + 1n} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(proposal)} a rv:RevisionAnchor, rv:CorrectionProposal ;
        rv:proposal ${iri(proposal)} ; rv:proposalRevisionNumber 1 ;
        ${logHead ? `rv:logPredecessor ${iri(logHead)} ;` : ''} rv:logOrdinal ${BigInt(logCount) + 1n} ;
        rv:component ${iri(input.work)} ; rv:protectedSlot "title:en" ; rv:adoptionContext rv:GlobalNative ;
        rv:baseRevision ${iri(input.expectedHead)} ; rv:baseProtection ${expected(input.expectedProtection)} ;
        rv:baseControl ${expected(input.expectedControl)} ; rv:baseControlEpoch ${input.expectedControlEpoch} ;
        rv:ruleRevision ${iri(PROTECTION_RULE)} ; rv:proposalOrigin rv:HumanProposal ;
        rv:candidateRevision ${iri(candidate)} ; rv:candidateManifest ${iri(`urn:rezics:sha256:${candidateManifest}`)} ;
        rv:candidateDigest ${lit(candidateDigest)} ; rv:proposalAdmission ${lit(admission.id)} ;
        ${evidence} rv:agent ${iri(input.actingSubject)} ; rv:operation ${iri(operation)} ;
        rv:proposalIntent ${lit(JSON.stringify(intent))} ; rv:manifest ${iri(`urn:rezics:sha256:${proposalManifest}`)} ;
        rv:modelRevision ${iri(PROPOSAL_PROFILE)} ; rv:shapeRevision ${iri(PROPOSAL_PROFILE)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${iri(candidate)} a rv:RevisionAnchor ; rv:component ${iri(input.work)} ;
        rv:predecessor ${iri(input.expectedHead)} ; rv:operation ${iri(operation)} ;
        rv:manifest ${iri(`urn:rezics:sha256:${candidateManifest}`)} ; rv:modelRevision ${iri(PROFILE)} ;
        rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${e.receiptTriples} }
      GRAPH ${iri(GRAPHS.outbox)} { ${e.outboxTriples} } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      ${guard(input)}
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(log)} rv:proposalHead ?oldLogHead ;
        rv:proposalCount ?oldLogCount . } }
      FILTER(${logHead ? `?oldLogHead = ${iri(logHead)} && ?oldLogCount = ${logCount}`
        : '!BOUND(?oldLogHead) && !BOUND(?oldLogCount)'})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(e.receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next) }`;
  const validations = await profileValidations(env.fuseki, 'correction-proposal-v1', [
    { shape: `${PROPOSAL_PROFILE}/log-shape`, focus: [log], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${PROPOSAL_PROFILE}/proposal-shape`, focus: [proposal], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  return { receipt: e.receipt, digest: admission.requestDigest, update, validations, deadlineMs: 10_000 };
}

interface StoredProposal {
  work: string; baseHead: string; baseProtection: string | null; baseControl: string | null;
  baseControlEpoch: string; candidate: string; candidateDigest: string; candidateManifest: string;
  proposerAdmissionId: string; title: string; proposal: string;
}

export async function readWorkCorrectionProposal(env: WorkActivationEnvironment,
  proposal: string): Promise<StoredProposal | null> {
  if (!NATIVE.test(proposal)) throw new WorkProtectionInvalid('invalid proposal revision');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?head ?protection ?control ?controlEpoch
    ?candidate ?digest ?manifest ?admission ?intent WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(proposal)} a rv:CorrectionProposal ; rv:component ?work ;
      rv:baseRevision ?head ; rv:baseProtection ?protection ; rv:baseControl ?control ;
      rv:baseControlEpoch ?controlEpoch ; rv:candidateRevision ?candidate ; rv:candidateDigest ?digest ;
      rv:candidateManifest ?manifest ; rv:proposalAdmission ?admission ; rv:proposalIntent ?intent . }
  } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.work || !row.head || !row.protection || !row.control || !row.controlEpoch
    || !row.candidate || !row.digest || !row.manifest || !row.admission || !row.intent) {
    throw new WorkProtectionUnavailable('correction proposal is incomplete');
  }
  let intent: { title?: string };
  try { intent = JSON.parse(row.intent.value); }
  catch { throw new WorkProtectionUnavailable('correction proposal intent is invalid'); }
  if (!intent.title || hash(intent.title) !== row.digest.value) throw new WorkProtectionUnavailable('candidate title digest differs');
  const stored = await readWorkPayloadForRevision(env, row.manifest.value, row.work.value);
  if (stored.title !== intent.title) throw new WorkProtectionUnavailable('candidate Work payload differs');
  return { proposal, work: row.work.value, baseHead: row.head.value,
    baseProtection: row.protection.value === `${RV}Absent` ? null : row.protection.value,
    baseControl: row.control.value === `${RV}Absent` ? null : row.control.value,
    baseControlEpoch: row.controlEpoch.value, candidate: row.candidate.value,
    candidateDigest: row.digest.value, candidateManifest: row.manifest.value,
    proposerAdmissionId: row.admission.value, title: intent.title };
}

async function reviewCommand(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: WorkCorrectionReview, proposal: StoredProposal): Promise<CommandEnvelope> {
  if (proposal.work !== input.work || proposal.baseHead !== input.expectedHead
    || proposal.baseProtection !== input.expectedProtection || proposal.baseControl !== input.expectedControl
    || proposal.baseControlEpoch !== input.expectedControlEpoch || proposal.candidateDigest !== input.candidateDigest) {
    throw new WorkProtectionConflict('proposal and review basis differ');
  }
  const current = await currentWork(env, input.work, input.expectedHead);
  const approved = input.outcome === 'approved';
  const decision = decisionId(input.proposalRevision);
  const application = applicationId(input.proposalRevision);
  const control = approved ? ID + Bun.randomUUIDv7() : null;
  const operation = operationId(admission);
  const intent = { ...input, action: admission.action, decision, application: approved ? application : null,
    control, title: proposal.title, operation };
  if (JSON.stringify(intent).length > JSON_LIMIT) throw new WorkProtectionInvalid('decision intent exceeds its bound');
  const decisionManifest = await put(env, input.work, { intent, proposal: input.proposalRevision, decision }, DECISION_PROFILE);
  const applicationManifest = approved ? await put(env, input.work,
    { intent, proposal: input.proposalRevision, decision, application }, DECISION_PROFILE) : null;
  const controlManifest = approved ? await put(env, input.work,
    { intent, control, workRevision: proposal.candidate }, CONTROL_PROFILE) : null;
  const e = envelope(env, admission, operation, 'Succeeded', `rv:work ${iri(input.work)} ;
    rv:expectedHead ${iri(input.expectedHead)} ; rv:expectedProtection ${expected(input.expectedProtection)} ;
    rv:expectedControl ${expected(input.expectedControl)} ; rv:expectedControlEpoch ${input.expectedControlEpoch} ;
    rv:proposalRevision ${iri(input.proposalRevision)} ; rv:expectedDecision rv:Absent ; rv:decision ${iri(decision)} ;
    rv:reviewOutcome rv:${approved ? 'Accepted' : 'Rejected'} ; rv:operation ${iri(operation)}
    ${approved ? ` ; rv:workRevision ${iri(proposal.candidate)} ; rv:titleControl ${iri(control!)}` : ''}`);
  const evidence = input.evidence.map(item => `rv:evidence ${iri(item)} ;`).join(' ');
  const independence = `urn:rezics:independence:${hash(`${proposal.proposerAdmissionId}\0${admission.id}`)}`;
  const deleted = approved ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:head ${iri(input.expectedHead)} ;
    <http://www.w3.org/2000/01/rdf-schema#label> ?oldTitle ; rv:titleControlHead ?oldControl . }` : '';
  const inserted = approved ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:head ${iri(proposal.candidate)} ;
    <http://www.w3.org/2000/01/rdf-schema#label> ${lit(proposal.title)}@en ; rv:titleControlHead ${iri(control!)} . }` : '';
  const extraRevisions = approved ? `${iri(application)} a rv:RevisionAnchor, rv:CorrectionApplication ;
    rv:proposalRevision ${iri(input.proposalRevision)} ; rv:decision ${iri(decision)} ;
    rv:component ${iri(input.work)} ; rv:baseRevision ${iri(input.expectedHead)} ;
    rv:workRevision ${iri(proposal.candidate)} ; rv:controlRevision ${iri(control!)} ;
    rv:protectionRevision ${expected(input.expectedProtection)} ; rv:operation ${iri(operation)} ;
    rv:manifest ${iri(`urn:rezics:sha256:${applicationManifest}`)} ;
    rv:modelRevision ${iri(DECISION_PROFILE)} ; rv:shapeRevision ${iri(DECISION_PROFILE)} ;
    rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
    ${iri(control!)} a rv:RevisionAnchor, rv:EditorialControlRevision ;
    rv:component ${iri(input.work)} ; rv:controlField "title:en" ; rv:controlMode rv:HumanControlled ;
    rv:controlEpoch ${BigInt(input.expectedControlEpoch) + 1n} ; rv:workRevision ${iri(proposal.candidate)} ;
    ${input.expectedControl ? `rv:predecessor ${iri(input.expectedControl)} ;` : ''}
    rv:operation ${iri(operation)} ; rv:controlIntent ${lit(JSON.stringify(intent))} ;
    rv:manifest ${iri(`urn:rezics:sha256:${controlManifest}`)} ; rv:modelRevision ${iri(CONTROL_PROFILE)} ;
    rv:shapeRevision ${iri(CONTROL_PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .` : '';
  const update = `PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${deleted} }
    INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      ${inserted}
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} a rv:RevisionAnchor, rv:CorrectionDecision ;
        rv:proposalRevision ${iri(input.proposalRevision)} ; rv:component ${iri(input.work)} ;
        rv:candidateDigest ${lit(input.candidateDigest)} ; rv:outcome rv:${approved ? 'Accepted' : 'Rejected'} ;
        rv:ruleRevision ${iri(PROTECTION_RULE)} ; rv:independenceProof ${iri(independence)} ;
        ${evidence} rv:agent ${iri(input.actingSubject)} ; rv:operation ${iri(operation)} ;
        rv:decisionIntent ${lit(JSON.stringify(intent))} ; rv:manifest ${iri(`urn:rezics:sha256:${decisionManifest}`)} ;
        rv:modelRevision ${iri(DECISION_PROFILE)} ; rv:shapeRevision ${iri(DECISION_PROFILE)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${extraRevisions} }
      GRAPH ${iri(GRAPHS.receipts)} { ${e.receiptTriples} }
      GRAPH ${iri(GRAPHS.outbox)} { ${e.outboxTriples} } }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      ${guard(input)}
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.proposalRevision)} a rv:CorrectionProposal ;
        rv:component ${iri(input.work)} ; rv:baseRevision ${iri(input.expectedHead)} ;
        rv:candidateRevision ${iri(proposal.candidate)} ; rv:candidateDigest ${lit(input.candidateDigest)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?priorPredicate ?priorValue } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(e.receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next) }`;
  const validations = await profileValidations(env.fuseki, 'correction-decision-v1', [
    { shape: `${DECISION_PROFILE}/decision-shape`, focus: [decision], graphs: [GRAPHS.current, GRAPHS.revisions] },
    ...(approved ? [{ shape: `${DECISION_PROFILE}/application-shape`, focus: [application],
      graphs: [GRAPHS.current, GRAPHS.revisions] }] : []),
  ]);
  if (control) validations.push(...await profileValidations(env.fuseki, 'work-title-control-v1', [
    { shape: `${CONTROL_PROFILE}/control-shape`, focus: [control], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]));
  if (approved) validations.push(...await workMetadataValidations(env, input.work, current.mainVersion));
  return { receipt: e.receipt, digest: admission.requestDigest, update, validations, deadlineMs: 10_000 };
}

type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>;
type Account = Pick<AccountAssertionVerifier, 'verify'>;

async function dispatch(env: WorkActivationEnvironment, account: Account, access: Access,
  signer: ProtectionAdmissionSigner, request: Request, input: WorkEditorialBasis,
  action: WorkProtectionAdmissionAction, oauthScope: 'work:protect' | 'work:correct' | 'work:review',
  requestDigest: string,
  build: (admission: RegisteredAdmission) => Promise<{ command: CommandEnvelope;
    proposerAdmissionId: string | null }>): Promise<WorkProtectionReceipt> {
  validateBasis(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [oauthScope]);
  const scope = `${action.startsWith('work.protection.') ? 'work:protect:'
    : action === 'work.correction.propose' ? 'work:correct:' : 'work:review:'}${input.work}`;
  const registered = await access.register({ principal, actingSubject: input.actingSubject, scope,
    action, idempotencyKey: input.idempotencyKey, requestDigest });
  let terminal = await readWorkProtectionReceipt(env, registered.id, action);
  const wasTerminal = !!terminal;
  let lostResponse = false;
  if (!terminal && registered.state !== 'sealed') {
    let admission = registered;
    try { if (admission.dispatchEligible) admission = await access.claim(admission.id, requestDigest); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
    if (admission.state === 'claimed' && admission.dispatchEligible) {
      const prepared = await build(admission);
      const { command } = prepared;
      try { command.titleAdmission = await signer.issue(admission, command, prepared.proposerAdmissionId); }
      catch (error) {
        if (error instanceof AdmissionDenied) {
          const cancelled = await cancelWorkProtection(env, admission);
          await access.recordGraphOutcome(admission.id, cancelled);
        }
        throw error;
      }
      try {
        const result = await env.fuseki.commandWithReceipt(command);
        if (['guard-unmatched', 'invalid'].includes(result.status)) await cancelWorkProtection(env, admission);
        else if (result.status === 'unknown-profile') throw new CommandRejected(result);
      } catch (error) {
        if (error instanceof CommandRejected) throw error;
        lostResponse = true; // The exact receipt, rather than transport acknowledgement, resolves the outcome.
      }
    } else await cancelWorkProtection(env, admission);
    terminal = await readWorkProtectionReceipt(env, registered.id, action);
  }
  if (!terminal) throw new WorkProtectionPending(registered.id);
  if (terminal.requestDigest !== requestDigest || terminal.action !== action || terminal.scope !== registered.scope
    || terminal.authorityEpoch !== registered.authorityEpoch) {
    throw new WorkProtectionConflict('protection receipt differs from admitted request');
  }
  await access.recordGraphOutcome(registered.id, terminal);
  if (terminal.outcome === 'cancelled') throw new WorkProtectionConflict('Work editorial basis changed', terminal);
  return { ...terminal, replayed: wasTerminal || lostResponse };
}

export async function changeWorkProtection(env: WorkActivationEnvironment, account: Account, access: Access,
  signer: ProtectionAdmissionSigner, request: Request, input: WorkProtectionChange): Promise<WorkProtectionReceipt> {
  validateBasis(input);
  const action = `work.protection.${input.action}` as WorkProtectionAdmissionAction;
  const requestDigest = digest('work-title-protection-v1', input);
  return dispatch(env, account, access, signer, request, input, action, 'work:protect', requestDigest,
    async admission => ({ command: await changeCommand(env, admission, input), proposerAdmissionId: null }));
}

export async function proposeWorkCorrection(env: WorkActivationEnvironment, account: Account, access: Access,
  signer: ProtectionAdmissionSigner, request: Request, input: WorkCorrectionProposal): Promise<WorkProtectionReceipt> {
  validateBasis(input);
  metadataWorkRequestDigest(input.title);
  const requestDigest = digest('work-title-correction-v1', input);
  return dispatch(env, account, access, signer, request, input, 'work.correction.propose', 'work:correct',
    requestDigest, async admission => ({ command: await proposeCommand(env, admission, input), proposerAdmissionId: null }));
}

export async function reviewWorkCorrection(env: WorkActivationEnvironment, account: Account, access: Access,
  signer: ProtectionAdmissionSigner, request: Request, input: WorkCorrectionReview): Promise<WorkProtectionReceipt> {
  validateBasis(input);
  if (input.expectedDecisionHead !== null) throw new WorkProtectionInvalid('explicit absent decision head is required');
  const requestDigest = digest('work-title-correction-review-v1', input);
  return dispatch(env, account, access, signer, request, input, 'work.correction.review', 'work:review',
    requestDigest, async admission => {
      const proposal = await readWorkCorrectionProposal(env, input.proposalRevision);
      if (!proposal) throw new WorkProtectionMissing('correction proposal does not exist');
      if (proposal.candidateDigest !== input.candidateDigest) throw new WorkProtectionConflict('candidate digest differs');
      return { command: await reviewCommand(env, admission, input, proposal),
        proposerAdmissionId: proposal.proposerAdmissionId };
    });
}

export async function readWorkEditorialState(env: WorkActivationEnvironment, work: string) {
  if (!NATIVE.test(work)) throw new WorkProtectionInvalid('invalid Work');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?protection ?mode ?protectionEpoch
    ?control ?controlEpoch WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} a <https://schema.org/CreativeWork> ; rv:head ?head .
      OPTIONAL { ${iri(work)} rv:protectionHead ?protection }
      OPTIONAL { ${iri(work)} rv:titleControlHead ?control } }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?protection a rv:ProtectionRevision ;
      rv:component ${iri(work)} ; rv:protectionMode ?mode ; rv:protectionEpoch ?protectionEpoch . } }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?control a rv:EditorialControlRevision ;
      rv:component ${iri(work)} ; rv:controlEpoch ?controlEpoch . } }
  } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.head || (row.protection && (!row.mode || !row.protectionEpoch))
    || (row.control && !row.controlEpoch)) throw new WorkProtectionUnavailable('Work editorial state is incomplete');
  if (row.protection && ![`${RV}Open`, `${RV}ReviewRequired`].includes(row.mode!.value)) {
    throw new WorkProtectionUnavailable('Work protection mode is unsupported');
  }
  return { work, fieldKey: 'title:en' as const, context: 'global-native' as const,
    contentHead: row.head.value, protectionHead: row.protection?.value ?? null,
    protectionMode: row.mode?.value === `${RV}ReviewRequired` ? 'review-required' as const : 'open' as const,
    protectionEpoch: row.protectionEpoch?.value ?? '0',
    controlHead: row.control?.value ?? null, controlEpoch: row.controlEpoch?.value ?? '0',
    ruleRevision: PROTECTION_RULE };
}

export async function readWorkCorrectionRecord(env: WorkActivationEnvironment, proposalId: string) {
  const proposal = await readWorkCorrectionProposal(env, proposalId);
  if (!proposal) return null;
  const decision = decisionId(proposalId);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?operation ?agent ?intent WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} a rv:CorrectionDecision ;
      rv:proposalRevision ${iri(proposalId)} ; rv:outcome ?outcome ; rv:operation ?operation ;
      rv:agent ?agent ; rv:decisionIntent ?intent . }
  } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (rows.length > 1) throw new WorkProtectionUnavailable('correction decision is ambiguous');
  if (rows.length && (!rows[0]?.operation || !rows[0]?.agent
    || ![`${RV}Accepted`, `${RV}Rejected`].includes(rows[0]?.outcome?.value ?? ''))) {
    throw new WorkProtectionUnavailable('correction decision is incomplete');
  }
  return { proposal, decision: rows.length ? { decision, outcome: rows[0]!.outcome?.value === `${RV}Accepted`
    ? 'approved' as const : 'rejected' as const, operation: rows[0]!.operation?.value,
  agent: rows[0]!.agent?.value } : null };
}

type ClosureAccess = Pick<AccessAdmissionRegistry, 'strongCloseScope' | 'listUnsealed'
  | 'strongDeactivatePrincipal' | 'listUnsealedPrincipal' | 'recordGraphOutcome'>;

async function sealPendingWork(env: WorkActivationEnvironment, access: ClosureAccess,
  pending: RegisteredAdmission[]) {
  for (const admission of pending) {
    if (!Object.hasOwn(workReceiptFamilies, admission.action)) continue;
    try {
      const action = admission.action as WorkProtectionAdmissionAction;
      const terminal = await readWorkProtectionReceipt(env, admission.id, action)
        ?? await cancelWorkProtection(env, admission);
      await access.recordGraphOutcome(admission.id, terminal);
    } catch { /* The Access fence stays pending until its exact receipt is reconciled. */ }
  }
}

/** Fence dispatch first, then race cancellation against each exact owner receipt. */
export async function strongRevokeWorkProtectionScope(env: WorkActivationEnvironment,
  access: ClosureAccess, scope: string, expectedEpoch: string) {
  const closed = await access.strongCloseScope(scope, expectedEpoch);
  await sealPendingWork(env, access, await access.listUnsealed(scope, 100));
  const current = await access.strongCloseScope(scope, closed.authorityEpoch);
  return { scope, authorityEpoch: current.authorityEpoch,
    status: current.pending === 0 ? 'complete' as const : 'pending' as const, pending: current.pending };
}

export async function strongRevokeWorkProtectionPrincipal(env: WorkActivationEnvironment,
  access: ClosureAccess, principalId: string, expectedEpoch: string) {
  const closed = await access.strongDeactivatePrincipal(principalId, expectedEpoch);
  await sealPendingWork(env, access, await access.listUnsealedPrincipal(principalId, 100));
  const current = await access.strongDeactivatePrincipal(principalId, closed.enforcementEpoch);
  return { principalId, enforcementEpoch: current.enforcementEpoch,
    status: current.pending === 0 ? 'complete' as const : 'pending' as const, pending: current.pending };
}
