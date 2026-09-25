import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, IdempotencyConflict,
  type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const evidenceUrl = /^https:\/\/[^\s<>"{}|\\^`]{1,2040}$/;
const PROFILE = 'https://rezics.com/definition/work-derivation-v1';
const SHAPE = `${PROFILE}/derivation-shape`;
const kinds = { adaptation: 'Adaptation', 'new-recording': 'NewRecording',
  'software-fork': 'SoftwareFork' } as const;

export class InvalidWorkDerivation extends Error {}
export class WorkDerivationUnavailable extends Error {}
export class WorkDerivationStale extends Error {}
export class WorkDerivationConflict extends Error {}

export interface WorkDerivationInput {
  targetWork: string;
  targetMainVersion: string;
  expectedTargetHead: string;
  sourceWork: string;
  sourceMainVersion: string;
  sourceMainRevision: string;
  kind: keyof typeof kinds;
  evidence: string;
  actingSubject: string;
}

export interface WorkDerivation extends Omit<WorkDerivationInput, 'expectedTargetHead' | 'actingSubject'> {
  derivation: string;
  targetMainRevision: string;
  linkedBy: string;
}

export interface WorkDerivationReceipt {
  derivation: string;
  receipt: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}

export function validateWorkDerivation(input: WorkDerivationInput): void {
  if (![input.targetWork, input.targetMainVersion, input.expectedTargetHead,
    input.sourceWork, input.sourceMainVersion, input.sourceMainRevision,
    input.actingSubject].every(value => nativeId.test(value))
    || input.targetWork === input.sourceWork || !Object.hasOwn(kinds, input.kind)
    || !evidenceUrl.test(input.evidence)) {
    throw new InvalidWorkDerivation('invalid derivation identity, kind or evidence');
  }
}

export function workDerivationDigest(input: WorkDerivationInput & { idempotencyKey: string }): string {
  validateWorkDerivation(input);
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(input.idempotencyKey)) {
    throw new InvalidWorkDerivation('invalid derivation idempotency key');
  }
  // Recovery recomputes the exact original admission from the retained event
  // and Access's saved key, independent of the caller's JSON property order.
  return hash(JSON.stringify({ family: 'work-derivation-v1', targetWork: input.targetWork,
    targetMainVersion: input.targetMainVersion, expectedTargetHead: input.expectedTargetHead,
    sourceWork: input.sourceWork, sourceMainVersion: input.sourceMainVersion,
    sourceMainRevision: input.sourceMainRevision, kind: input.kind,
    evidence: input.evidence, actingSubject: input.actingSubject,
    idempotencyKey: input.idempotencyKey }));
}

export function workDerivationReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0work-derivation-v1`)}`;
}

interface TerminalDerivation {
  outcome: 'succeeded' | 'cancelled';
  derivation: string | null;
  requestDigest: string;
  admissionId: string;
  scope: string;
  authorityEpoch: string;
  dataEpoch: string;
  sequence: string;
  receipt: string;
}

export async function readWorkDerivationTerminal(env: WorkActivationEnvironment,
  admissionId: string): Promise<TerminalDerivation | null> {
  const receipt = workDerivationReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?derivation ?digest ?admission ?scope ?authorityEpoch ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?admission ; rv:admittedScope ?scope ;
        rv:authorityEpoch ?authorityEpoch ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:workDerivation ?derivation }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0];
  if (rows.length !== 1 || !row?.outcome || !row.digest || !row.admission
    || !row.scope || !row.authorityEpoch || !row.epoch || !row.sequence) {
    throw new Error('work derivation receipt is incomplete');
  }
  const outcome = row.outcome.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome || (outcome === 'succeeded') !== !!row.derivation) {
    throw new Error('work derivation receipt outcome is inconsistent');
  }
  return { outcome, derivation: row.derivation?.value ?? null, requestDigest: row.digest.value,
    admissionId: row.admission.value, scope: row.scope.value,
    authorityEpoch: row.authorityEpoch.value, dataEpoch: row.epoch.value,
    sequence: row.sequence.value, receipt };
}

async function sealCancelled(env: WorkActivationEnvironment,
  registered: RegisteredAdmission): Promise<void> {
  const receipt = workDerivationReceiptIri(registered.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0cancel`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(registered.requestDigest)} ;
          rv:admissionId ${lit(registered.id)} ; rv:authorityEpoch ${lit(registered.authorityEpoch)} ;
          rv:admittedScope ${lit(registered.scope)} ; rv:outcome rv:Cancelled ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 0 . }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  await env.fuseki.commandWithReceipt({ receipt, digest: registered.requestDigest,
    update, validations: [], deadlineMs: 10_000 });
}

/** Strong closure races the cancellation receipt against the derivation command. */
export async function sealWorkDerivationAdmission(env: WorkActivationEnvironment,
  registered: RegisteredAdmission): Promise<TerminalDerivation> {
  if (registered.action !== 'work.derive') throw new Error('unsupported derivation admission');
  if (!await readWorkDerivationTerminal(env, registered.id)) await sealCancelled(env, registered);
  const terminal = await readWorkDerivationTerminal(env, registered.id);
  if (!terminal || terminal.admissionId !== registered.id
    || terminal.requestDigest !== registered.requestDigest || terminal.scope !== registered.scope
    || terminal.authorityEpoch !== registered.authorityEpoch) {
    throw new Error('work derivation cancellation outcome is unavailable');
  }
  return terminal;
}

async function relationState(env: WorkActivationEnvironment, input: WorkDerivationInput): Promise<{
  target: boolean; head: boolean; source: boolean; linked: boolean;
}> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?target ?head ?source ?linked WHERE {
    BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.targetWork)} rv:mainVersion ${iri(input.targetMainVersion)} .
      ${iri(input.targetMainVersion)} a rv:MainVersion ; rv:work ${iri(input.targetWork)} .
    } } AS ?target)
    BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.targetMainVersion)} rv:head ${iri(input.expectedTargetHead)} .
    } GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(input.expectedTargetHead)} a rv:RevisionAnchor ; rv:component ${iri(input.targetMainVersion)} .
    } } AS ?head)
    BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.sourceWork)} rv:mainVersion ${iri(input.sourceMainVersion)} .
      ${iri(input.sourceMainVersion)} a rv:MainVersion ; rv:work ${iri(input.sourceWork)} .
    } GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(input.sourceMainRevision)} a rv:RevisionAnchor ; rv:component ${iri(input.sourceMainVersion)} .
    } } AS ?source)
    BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
      ?derivation a rv:WorkDerivation ; rv:targetMainRevision ${iri(input.expectedTargetHead)} .
    } } AS ?linked)
  }`);
  const row = result.results?.bindings?.[0];
  if (!row?.target || !row.head || !row.source || !row.linked) throw new Error('relation state unavailable');
  return { target: row.target.value === 'true', head: row.head.value === 'true',
    source: row.source.value === 'true', linked: row.linked.value === 'true' };
}

async function activate(env: WorkActivationEnvironment, registered: RegisteredAdmission,
  input: WorkDerivationInput, digest: string): Promise<void> {
  const derivation = ID + Bun.randomUUIDv7();
  const receipt = workDerivationReceiptIri(registered.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0work-derived`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(derivation)} a rv:WorkDerivation ; rv:targetWork ${iri(input.targetWork)} ;
          rv:targetMainVersion ${iri(input.targetMainVersion)} ;
          rv:targetMainRevision ${iri(input.expectedTargetHead)} ;
          rv:sourceWork ${iri(input.sourceWork)} ;
          rv:sourceMainVersion ${iri(input.sourceMainVersion)} ;
          rv:sourceMainRevision ${iri(input.sourceMainRevision)} ;
          rv:derivationKind rv:${kinds[input.kind]} ; rv:evidence ${lit(input.evidence)} ;
          rv:linkedBy ${iri(input.actingSubject)} ; rv:modelRevision ${iri(PROFILE)} ;
          rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(registered.id)} ; rv:admittedScope ${lit(registered.scope)} ;
          rv:authorityEpoch ${lit(registered.authorityEpoch)} ; rv:outcome rv:Succeeded ;
          rv:workDerivation ${iri(derivation)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:WorkDerivedEvent ; rv:ordinal 0 ;
          rv:action ${lit(registered.action)} ; rv:receipt ${iri(receipt)} ;
          rv:workDerivation ${iri(derivation)} .
      }
    } WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.targetWork)} rv:mainVersion ${iri(input.targetMainVersion)} .
        ${iri(input.targetMainVersion)} a rv:MainVersion ; rv:work ${iri(input.targetWork)} ;
          rv:head ${iri(input.expectedTargetHead)} .
        ${iri(input.sourceWork)} rv:mainVersion ${iri(input.sourceMainVersion)} .
        ${iri(input.sourceMainVersion)} a rv:MainVersion ; rv:work ${iri(input.sourceWork)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.expectedTargetHead)} a rv:RevisionAnchor ;
          rv:component ${iri(input.targetMainVersion)} .
        ${iri(input.sourceMainRevision)} a rv:RevisionAnchor ;
          rv:component ${iri(input.sourceMainVersion)} .
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
        ?prior a rv:WorkDerivation ; rv:targetMainRevision ${iri(input.expectedTargetHead)} . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      BIND(?n + 1 AS ?next)
    }`;
  const validations = await profileValidations(env.fuseki, 'work-derivation-v1', [{
    shape: SHAPE, focus: [derivation],
    graphs: [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control],
  }], { derivation, 'target-work': input.targetWork,
    'target-main': input.targetMainVersion, 'target-revision': input.expectedTargetHead,
    'source-work': input.sourceWork, 'source-main': input.sourceMainVersion,
    'source-revision': input.sourceMainRevision, kind: input.kind,
    evidence: input.evidence, actor: input.actingSubject, receipt,
    scope: registered.scope, epoch: registered.authorityEpoch });
  const result = await validatedCommand(env, { receipt, digest, update,
    validations, deadlineMs: 10_000 }, registered);
  if (result.status === 'invalid' || result.status === 'unknown-profile'
    || result.status === 'conflict') throw new CommandRejected(result);
}

export async function createAdmittedWorkDerivation(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: WorkDerivationInput & { idempotencyKey: string },
): Promise<WorkDerivationReceipt> {
  const digest = workDerivationDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `derivation:link:${input.targetWork}`, action: 'work.derive',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealWorkDerivationAdmission(env, admission);
      } else {
        const state = await relationState(env, input);
        if (!state.target || !state.source || !state.head || state.linked) {
          await sealWorkDerivationAdmission(env, admission);
          const cancelled = await readWorkDerivationTerminal(env, registered.id);
          if (cancelled) await access.recordGraphOutcome(registered.id, cancelled);
          if (!state.target || !state.source) throw new WorkDerivationUnavailable('source or target unavailable');
          if (!state.head) throw new WorkDerivationStale('target Main Version head changed');
          throw new WorkDerivationConflict('target revision already has a derivation');
        }
        try { await activate(env, admission, input, digest); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          const state = await relationState(env, input);
          if (!state.target || !state.source || !state.head || state.linked) {
            await sealWorkDerivationAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readWorkDerivationTerminal(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-derivation');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
      || terminal.scope !== registered.scope || terminal.authorityEpoch !== registered.authorityEpoch) {
      throw new IdempotencyConflict('derivation receipt differs from admission');
    }
    if (terminal.outcome !== 'succeeded' || !terminal.derivation) {
      throw new WorkDerivationConflict('derivation admission was cancelled');
    }
    return { derivation: terminal.derivation, receipt: terminal.receipt,
      dataEpoch: terminal.dataEpoch, sequence: terminal.sequence, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof WorkDerivationConflict
      || error instanceof WorkDerivationUnavailable || error instanceof WorkDerivationStale) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-derivation');
  }
}

/** One retained target revision has at most one explicit derivation. */
export async function readWorkDerivations(env: WorkActivationEnvironment,
  mainVersion: string, mainRevision: string): Promise<WorkDerivation[]> {
  if (!nativeId.test(mainVersion) || !nativeId.test(mainRevision)) {
    throw new InvalidWorkDerivation('invalid Main Version revision');
  }
  const available = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(mainVersion)} a rv:MainVersion ; rv:work ?work . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(mainRevision)} a rv:RevisionAnchor ; rv:component ${iri(mainVersion)} .
    }
  }`);
  if (available.boolean !== true) throw new WorkDerivationUnavailable('target revision unavailable');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?derivation ?targetWork ?sourceWork ?sourceMain ?sourceRevision ?kind ?evidence ?linkedBy WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ?derivation a rv:WorkDerivation ; rv:targetWork ?targetWork ;
        rv:targetMainVersion ${iri(mainVersion)} ; rv:targetMainRevision ${iri(mainRevision)} ;
        rv:sourceWork ?sourceWork ; rv:sourceMainVersion ?sourceMain ;
        rv:sourceMainRevision ?sourceRevision ; rv:derivationKind ?kind ;
        rv:evidence ?evidence ; rv:linkedBy ?linkedBy ;
        rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} .
    }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > 1) throw new WorkDerivationConflict('ambiguous target derivations');
  return rows.map(row => {
    const kind: WorkDerivation['kind'] | undefined = Object.entries(kinds)
      .find(([, value]) => row.kind?.value === `${RV}${value}`)?.[0] as WorkDerivation['kind'] | undefined;
    if (!kind || !row.derivation || !row.targetWork || !row.sourceWork || !row.sourceMain
      || !row.sourceRevision || !row.evidence || !row.linkedBy) {
      throw new WorkDerivationConflict('incomplete derivation');
    }
    return { derivation: row.derivation.value, targetWork: row.targetWork.value,
      targetMainVersion: mainVersion, targetMainRevision: mainRevision,
      sourceWork: row.sourceWork.value, sourceMainVersion: row.sourceMain.value,
      sourceMainRevision: row.sourceRevision.value, kind, evidence: row.evidence.value,
      linkedBy: row.linkedBy.value };
  });
}
