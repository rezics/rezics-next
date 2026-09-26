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
const UNRESOLVED_PROFILE = 'https://rezics.com/definition/work-derivation-unresolved-v1';
/** Both declaration classes share one per-revision inventory, pair key and bound. */
const DECLARED = 'rv:WorkDerivation, rv:UnresolvedWorkDerivation';
const kinds = { adaptation: 'Adaptation', 'new-recording': 'NewRecording',
  'software-fork': 'SoftwareFork' } as const;
/** Declarations, including superseded ones, retained on one target revision. */
export const MAX_REVISION_DERIVATIONS = 16;

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
  /** Null declares the source Main Version without a known exact revision. */
  sourceMainRevision: string | null;
  kind: keyof typeof kinds;
  evidence: string;
  actingSubject: string;
  /** The effective declaration for the same target revision and source this one supersedes. */
  corrects?: string;
}

export interface WorkDerivation extends Omit<WorkDerivationInput,
  'expectedTargetHead' | 'actingSubject' | 'corrects'> {
  derivation: string;
  targetMainRevision: string;
  linkedBy: string;
  sourceVersionStatus: 'exact' | 'unresolved';
  corrects: string | null;
  supersededBy: string | null;
  status: 'effective' | 'superseded';
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
    input.sourceWork, input.sourceMainVersion, input.actingSubject].every(value => nativeId.test(value))
    || (input.sourceMainRevision !== null && !nativeId.test(input.sourceMainRevision))
    || (input.corrects !== undefined && !nativeId.test(input.corrects))
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
    // An unresolved source serializes as null, so exact digests are unchanged.
    sourceMainRevision: input.sourceMainRevision, kind: input.kind,
    evidence: input.evidence, actingSubject: input.actingSubject,
    // Absent for first declarations, so retained pre-correction digests stay valid.
    ...(input.corrects === undefined ? {} : { corrects: input.corrects }),
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

interface RelationState {
  target: boolean; head: boolean; source: boolean;
  /** The target revision already declares this source Main Version. */
  paired: boolean;
  /** The corrected declaration exists for this target revision and source. */
  correctable: boolean;
  /** Another declaration already supersedes the corrected one. */
  superseded: boolean;
  /** The correction repeats the corrected kind, source revision and evidence. */
  unchanged: boolean;
  total: number;
}

/** One declaration of either source-version class, bound to `?{name}`'s class variable. */
export function declared(subject: string, name: string): string {
  return `${subject} a ?${name}Class . FILTER(?${name}Class IN (${DECLARED}))`;
}

/** The corrected declaration repeats this input's kind, evidence and source version. */
function unchangedPattern(input: WorkDerivationInput & { corrects: string }): string {
  const corrects = iri(input.corrects);
  return `${corrects} rv:derivationKind rv:${kinds[input.kind]} ;
        rv:evidence ${lit(input.evidence)} .
      ${input.sourceMainRevision === null
    ? `FILTER NOT EXISTS { ${corrects} rv:sourceMainRevision ?anyRevision }`
    : `${corrects} rv:sourceMainRevision ${iri(input.sourceMainRevision)} .`}`;
}

/** The source Work, Main Version and, when exact, the retained revision anchor. */
export function sourcePattern(input: WorkDerivationInput): { current: string; revisions: string } {
  return { current: `${iri(input.sourceWork)} rv:mainVersion ${iri(input.sourceMainVersion)} .
        ${iri(input.sourceMainVersion)} a rv:MainVersion ; rv:work ${iri(input.sourceWork)} .`,
  revisions: input.sourceMainRevision === null ? '' : `${iri(input.sourceMainRevision)} a rv:RevisionAnchor ;
          rv:component ${iri(input.sourceMainVersion)} .` };
}

/** The immutable relation triples, typed and profiled by source-version certainty. */
export function derivationTriples(derivation: string, input: WorkDerivationInput,
  dataEpoch: string, sequence: string): string {
  const profile = input.sourceMainRevision === null ? UNRESOLVED_PROFILE : PROFILE;
  return `${iri(derivation)} a rv:${input.sourceMainRevision === null ? 'UnresolvedWorkDerivation'
    : 'WorkDerivation'} ; rv:targetWork ${iri(input.targetWork)} ;
          rv:targetMainVersion ${iri(input.targetMainVersion)} ;
          rv:targetMainRevision ${iri(input.expectedTargetHead)} ;
          rv:sourceWork ${iri(input.sourceWork)} ;
          rv:sourceMainVersion ${iri(input.sourceMainVersion)} ;
          ${input.sourceMainRevision === null ? 'rv:sourceVersionStatus rv:Unresolved'
    : `rv:sourceMainRevision ${iri(input.sourceMainRevision)}`} ;
          rv:derivationKind rv:${kinds[input.kind]} ; rv:evidence ${lit(input.evidence)} ;
          rv:linkedBy ${iri(input.actingSubject)} ; rv:modelRevision ${iri(profile)} ;
          rv:shapeRevision ${iri(profile)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence ${sequence}${
  input.corrects === undefined ? '' : ` ;
          rv:corrects ${iri(input.corrects)}`} .`;
}

/** The profile validation for one relation; an unresolved one binds no source revision. */
export async function derivationValidations(env: WorkActivationEnvironment, derivation: string,
  input: WorkDerivationInput, receipt: { id: string; scope: string; authorityEpoch: string }) {
  const unresolved = input.sourceMainRevision === null;
  const profile = unresolved ? UNRESOLVED_PROFILE : PROFILE;
  return profileValidations(env.fuseki, unresolved ? 'work-derivation-unresolved-v1'
    : 'work-derivation-v1', [{ shape: `${profile}/derivation-shape`, focus: [derivation],
    // The exact profile has a native receipt/control binding. The unresolved
    // profile uses the registry binding and validates against its two owner graphs.
    graphs: unresolved ? [GRAPHS.current, GRAPHS.revisions]
      : [GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.control],
  }], { derivation, 'target-work': input.targetWork,
    'target-main': input.targetMainVersion, 'target-revision': input.expectedTargetHead,
    'source-work': input.sourceWork, 'source-main': input.sourceMainVersion,
    ...(unresolved ? {} : { 'source-revision': input.sourceMainRevision! }), kind: input.kind,
    evidence: input.evidence, actor: input.actingSubject, receipt: receipt.id,
    scope: receipt.scope, epoch: receipt.authorityEpoch });
}

/** Fixed-key guards; the count reads only one target revision's bounded declarations. */
export function continuityGuard(input: WorkDerivationInput): string {
  const revision = iri(input.expectedTargetHead);
  const pair = input.corrects === undefined ? `
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
      ?prior rv:targetMainRevision ${revision} ;
        rv:sourceMainVersion ${iri(input.sourceMainVersion)} .
      ${declared('?prior', 'prior')} } }` : `
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(input.corrects)} rv:targetMainRevision ${revision} ;
        rv:targetMainVersion ${iri(input.targetMainVersion)} ;
        rv:sourceWork ${iri(input.sourceWork)} ;
        rv:sourceMainVersion ${iri(input.sourceMainVersion)} .
      ${declared(iri(input.corrects), 'corrected')}
    }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
      ?later rv:corrects ${iri(input.corrects)} . } }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
      ${unchangedPattern({ ...input, corrects: input.corrects })} } }`;
  return `${pair}
    { SELECT (COUNT(?declared) AS ?total) WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ?declared rv:targetMainRevision ${revision} . ${declared('?declared', 'declared')} } } }
    FILTER(?total < ${MAX_REVISION_DERIVATIONS})`;
}

async function relationState(env: WorkActivationEnvironment,
  input: WorkDerivationInput): Promise<RelationState> {
  const corrects = input.corrects === undefined ? null : iri(input.corrects);
  const revision = iri(input.expectedTargetHead);
  const source = sourcePattern(input);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?target ?head ?source ?paired ?correctable ?superseded ?unchanged ?total WHERE {
    BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.targetWork)} rv:mainVersion ${iri(input.targetMainVersion)} .
      ${iri(input.targetMainVersion)} a rv:MainVersion ; rv:work ${iri(input.targetWork)} .
    } } AS ?target)
    BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.targetMainVersion)} rv:head ${revision} .
    } GRAPH ${iri(GRAPHS.revisions)} {
      ${revision} a rv:RevisionAnchor ; rv:component ${iri(input.targetMainVersion)} .
    } } AS ?head)
    BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ${source.current} }${source.revisions
    ? ` GRAPH ${iri(GRAPHS.revisions)} { ${source.revisions} }` : ''} } AS ?source)
    BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
      ?derivation rv:targetMainRevision ${revision} ;
        rv:sourceMainVersion ${iri(input.sourceMainVersion)} .
      ${declared('?derivation', 'paired')}
    } } AS ?paired)
    BIND(${corrects === null ? 'false' : `EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
      ${corrects} rv:targetMainRevision ${revision} ;
        rv:targetMainVersion ${iri(input.targetMainVersion)} ;
        rv:sourceWork ${iri(input.sourceWork)} ;
        rv:sourceMainVersion ${iri(input.sourceMainVersion)} .
      ${declared(corrects, 'correctable')}
    } }`} AS ?correctable)
    BIND(${corrects === null ? 'false' : `EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
      ?later rv:corrects ${corrects} . } }`} AS ?superseded)
    BIND(${input.corrects === undefined ? 'false' : `EXISTS { GRAPH ${iri(GRAPHS.revisions)} {
      ${unchangedPattern({ ...input, corrects: input.corrects })} } }`} AS ?unchanged)
    { SELECT (COUNT(?declared) AS ?total) WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ?declared rv:targetMainRevision ${revision} . ${declared('?declared', 'declared')} } } }
  }`);
  const row = result.results?.bindings?.[0];
  const flags = ['target', 'head', 'source', 'paired', 'correctable', 'superseded', 'unchanged'] as const;
  if (!row || flags.some(flag => !row[flag]) || !row.total) throw new Error('relation state unavailable');
  const total = Number(row.total.value);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('relation state unavailable');
  return { target: row.target!.value === 'true', head: row.head!.value === 'true',
    source: row.source!.value === 'true', paired: row.paired!.value === 'true',
    correctable: row.correctable!.value === 'true', superseded: row.superseded!.value === 'true',
    unchanged: row.unchanged!.value === 'true', total };
}

/** The first failed continuity precondition, or null when the command may still commit. */
function blockedBy(state: RelationState, input: WorkDerivationInput): Error | null {
  if (!state.target || !state.source) return new WorkDerivationUnavailable('source or target unavailable');
  if (!state.head) return new WorkDerivationStale('target Main Version head changed');
  if (input.corrects === undefined) {
    if (state.paired) return new WorkDerivationConflict('target revision already declares this source');
  } else {
    if (!state.correctable) return new WorkDerivationUnavailable('corrected derivation unavailable');
    if (state.superseded) return new WorkDerivationConflict('corrected derivation is already superseded');
    if (state.unchanged) return new InvalidWorkDerivation('correction repeats the corrected declaration');
  }
  if (state.total >= MAX_REVISION_DERIVATIONS) {
    return new WorkDerivationConflict('target revision derivation limit reached');
  }
  return null;
}

async function activate(env: WorkActivationEnvironment, registered: RegisteredAdmission,
  input: WorkDerivationInput, digest: string): Promise<void> {
  const derivation = ID + Bun.randomUUIDv7();
  const receipt = workDerivationReceiptIri(registered.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0work-derived`)}`;
  const source = sourcePattern(input);
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${derivationTriples(derivation, input, env.lineage.dataEpoch, '?next')}
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
        ${source.current}
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(input.expectedTargetHead)} a rv:RevisionAnchor ;
          rv:component ${iri(input.targetMainVersion)} .
        ${source.revisions}
      }
      ${continuityGuard(input)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      BIND(?n + 1 AS ?next)
    }`;
  const validations = await derivationValidations(env, derivation, input,
    { id: receipt, scope: registered.scope, authorityEpoch: registered.authorityEpoch });
  const result = await validatedCommand(env, { receipt, digest, update,
    validations, deadlineMs: 10_000 }, registered);
  if (result.status !== 'committed') throw new CommandRejected(result);
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
        const blocked = blockedBy(await relationState(env, input), input);
        if (blocked) {
          // A lost response can find its own committed declaration blocking a retry.
          const cancelled = await sealWorkDerivationAdmission(env, admission);
          if (cancelled.outcome !== 'succeeded') {
            await access.recordGraphOutcome(registered.id, cancelled);
            throw blocked;
          }
        } else {
          try { await activate(env, admission, input, digest); }
          catch (error) {
            if (error instanceof IdempotencyConflict) throw error;
            // A concurrent declaration can win the guard between preflight and commit.
            const lost = blockedBy(await relationState(env, input), input);
            if (lost && !await readWorkDerivationTerminal(env, registered.id)) {
              const cancelled = await sealWorkDerivationAdmission(env, admission);
              if (cancelled.outcome !== 'succeeded') {
                await access.recordGraphOutcome(registered.id, cancelled);
                throw lost;
              }
            }
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
      || error instanceof WorkDerivationUnavailable || error instanceof WorkDerivationStale
      || error instanceof InvalidWorkDerivation) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-derivation');
  }
}

/**
 * The complete, bounded declaration inventory of one retained target revision, in
 * commit order. Each source Main Version has one effective declaration, exact or
 * unresolved; earlier corrected or resolved ones remain readable as superseded.
 */
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
    ?derivation ?targetWork ?sourceWork ?sourceMain ?sourceRevision ?kind ?evidence ?linkedBy
    ?sequence ?corrects ?supersededBy ?class ?sourceStatus WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ?derivation rv:targetMainRevision ${iri(mainRevision)} ; a ?class ; rv:targetWork ?targetWork ;
        rv:targetMainVersion ${iri(mainVersion)} ;
        rv:sourceWork ?sourceWork ; rv:sourceMainVersion ?sourceMain ; rv:derivationKind ?kind ;
        rv:evidence ?evidence ; rv:linkedBy ?linkedBy ; rv:sequence ?sequence ;
        rv:modelRevision ?model ; rv:shapeRevision ?model .
      FILTER(?class = rv:WorkDerivation && ?model = ${iri(PROFILE)}
        || ?class = rv:UnresolvedWorkDerivation && ?model = ${iri(UNRESOLVED_PROFILE)})
      OPTIONAL { ?derivation rv:sourceMainRevision ?sourceRevision }
      OPTIONAL { ?derivation rv:sourceVersionStatus ?sourceStatus }
      OPTIONAL { ?derivation rv:corrects ?corrects }
      OPTIONAL { ?supersededBy rv:corrects ?derivation }
    }
  } ORDER BY ?sequence LIMIT ${MAX_REVISION_DERIVATIONS + 1}`);
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_REVISION_DERIVATIONS) {
    throw new WorkDerivationConflict('target revision exceeds its derivation bound');
  }
  const relations = rows.map(row => {
    const kind: WorkDerivation['kind'] | undefined = Object.entries(kinds)
      .find(([, value]) => row.kind?.value === `${RV}${value}`)?.[0] as WorkDerivation['kind'] | undefined;
    const unresolved = row.class?.value === `${RV}UnresolvedWorkDerivation`;
    // An exact declaration names its retained revision; an unresolved one names none.
    if (!kind || !row.derivation || !row.targetWork || !row.sourceWork || !row.sourceMain
      || !row.evidence || !row.linkedBy || !row.sequence
      || (unresolved ? row.sourceRevision || row.sourceStatus?.value !== `${RV}Unresolved`
        : !row.sourceRevision || row.sourceStatus)) {
      throw new WorkDerivationConflict('incomplete derivation');
    }
    const supersededBy = row.supersededBy?.value ?? null;
    return { derivation: row.derivation.value, targetWork: row.targetWork.value,
      targetMainVersion: mainVersion, targetMainRevision: mainRevision,
      sourceWork: row.sourceWork.value, sourceMainVersion: row.sourceMain.value,
      sourceMainRevision: row.sourceRevision?.value ?? null, kind, evidence: row.evidence.value,
      linkedBy: row.linkedBy.value,
      sourceVersionStatus: unresolved ? 'unresolved' as const : 'exact' as const, corrects: row.corrects?.value ?? null, supersededBy,
      status: supersededBy === null ? 'effective' as const : 'superseded' as const };
  });
  // Duplicate rows mean a declaration was corrected twice or corrects two others.
  const ids = new Set(relations.map(item => item.derivation));
  const effective = relations.filter(item => item.status === 'effective');
  if (ids.size !== relations.length
    || new Set(effective.map(item => item.sourceMainVersion)).size !== effective.length
    || relations.some(item => item.corrects !== null && (!ids.has(item.corrects)
      || relations.find(prior => prior.derivation === item.corrects)?.sourceMainVersion
        !== item.sourceMainVersion))) {
    throw new WorkDerivationConflict('ambiguous target derivations');
  }
  return relations;
}
