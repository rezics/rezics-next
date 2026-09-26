import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { DATASET, GRAPHS, IdempotencyConflict, PendingActivation, RV, hash, iri, lit,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';

// One graph command family for Contexts, selections, Statements and decisions.
// It is the classification decision pattern (classification/decision.ts and
// decision-admitted.ts) factored once: an OperationReceipt keyed by admission,
// one control-sequence advance, one outbox batch, a sealed stale/unavailable
// terminal and replay through the receipt. The relay must register these event
// kinds before the operations are enabled for delivery.

export class InvalidContextCommand extends Error {}
export class ContextCommandUnavailable extends Error {}
export class StaleContextCommand extends Error {}
export class PendingContextCommand extends PendingActivation {
  readonly operationId: string;
  constructor(admissionId: string, readonly family: string) {
    super(`${family} outcome requires reconciliation`);
    this.operationId = `urn:rezics:operation:${hash(admissionId)}`;
  }
}

export type TerminalReason = 'stale-head' | 'unavailable';
export interface ContextCommandReceipt {
  outcome: 'succeeded' | 'cancelled';
  reason?: TerminalReason;
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string;
  operation?: string; component?: string; revision?: string; expectedHead?: string | null;
}

/** An external IRI term (vocabulary, definition or native). Native-only fields use `iri`. */
export function term(value: string): string {
  if (!/^https?:\/\/[^\s<>"{}|\\^`]{1,2040}$/.test(value) && !/^urn:rezics:[A-Za-z0-9:._-]+$/.test(value)) {
    throw new InvalidContextCommand('invalid IRI term');
  }
  return `<${value}>`;
}

export function commandReceiptIri(admissionId: string, family: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0${family}`)}`;
}

const EVENT_TYPES: Record<string, { committed: string; stale: string; cancelled: string }> = {
  'context-create-v1': { committed: 'ContextCreatedEvent', stale: 'ContextCreateStaleEvent',
    cancelled: 'ContextCreateCancelledEvent' },
  'context-revise-v1': { committed: 'ContextSemanticRevisedEvent', stale: 'ContextChangeStaleEvent',
    cancelled: 'ContextChangeCancelledEvent' },
  'context-state-v1': { committed: 'ContextStateChangedEvent', stale: 'ContextStateStaleEvent',
    cancelled: 'ContextStateCancelledEvent' },
  'context-realm-selection-v1': { committed: 'ContextSelectionChangedEvent',
    stale: 'ContextSelectionStaleEvent', cancelled: 'ContextSelectionCancelledEvent' },
  'statement-record-v1': { committed: 'StatementRecordedEvent', stale: 'StatementChangeStaleEvent',
    cancelled: 'StatementChangeCancelledEvent' },
  'statement-withdraw-v1': { committed: 'StatementWithdrawnEvent', stale: 'StatementWithdrawalStaleEvent',
    cancelled: 'StatementWithdrawalCancelledEvent' },
  'statement-decision-v1': { committed: 'StatementDecisionChangedEvent',
    stale: 'StatementDecisionStaleEvent', cancelled: 'StatementDecisionCancelledEvent' },
  'statement-migrate-v1': { committed: 'StatementMigratedEvent',
    stale: 'StatementMigrationStaleEvent', cancelled: 'StatementMigrationCancelledEvent' },
  'statement-cutover-v1': { committed: 'StatementCutoverEvent',
    stale: 'StatementCutoverStaleEvent', cancelled: 'StatementCutoverCancelledEvent' },
};

function eventType(family: string, outcome: 'committed' | 'stale' | 'cancelled'): string {
  const type = EVENT_TYPES[family]?.[outcome];
  if (!type) throw new InvalidContextCommand('unknown Context command family');
  return type;
}

export async function readCommandReceipt(env: WorkActivationEnvironment, admissionId: string,
  family: string): Promise<ContextCommandReceipt | null> {
  const receipt = commandReceiptIri(admissionId, family);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?reason ?digest ?id ?epoch
    ?scope ?dataEpoch ?sequence ?operation ?component ?revision ?expectedHead WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:commandFamily ${lit(family)} ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
      OPTIONAL { ${iri(receipt)} rv:operation ?operation ; rv:component ?component ; rv:revision ?revision .
        OPTIONAL { ${iri(receipt)} rv:expectedHead ?expectedHead } }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const reason = value('reason') === `${RV}StaleHead` ? 'stale-head'
    : value('reason') === `${RV}Unavailable` ? 'unavailable' : undefined;
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id') || !value('epoch')
    || !value('scope') || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (value('reason') && !reason)
    || (outcome === 'succeeded' && (!value('operation') || reason))
    || (outcome === 'cancelled' && (value('operation') || !reason))) {
    throw new ContextCommandUnavailable(`${family} receipt is incomplete`);
  }
  return { outcome, ...(reason ? { reason } : {}), receipt, admissionId: value('id')!,
    requestDigest: value('digest')!, authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { operation: value('operation'), component: value('component'),
      revision: value('revision'), expectedHead: value('expectedHead') ?? null } : {}) };
}

/** Replays only the same admission and request; a cancelled receipt reports its sealed reason. */
export function checkedCommandReceipt(receipt: ContextCommandReceipt, admission: RegisteredAdmission,
  digest: string): ContextCommandReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('command receipt differs from admission');
  }
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new StaleContextCommand('expected head is stale');
    throw new ContextCommandUnavailable('command target is unavailable');
  }
  return receipt;
}

const control = (env: WorkActivationEnvironment) => `GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`;

function receiptTriples(env: WorkActivationEnvironment, receipt: string, family: string,
  admission: RegisteredAdmission, digest: string): string {
  return `${iri(receipt)} a rv:OperationReceipt ; rv:commandFamily ${lit(family)} ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next`;
}

/** Seal a terminal cancellation. `guard` must still prove the reason inside the same update. */
export async function sealCommandTerminal(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  family: string, reason: TerminalReason, guard = ''): Promise<ContextCommandReceipt | null> {
  const receipt = commandReceiptIri(admission.id, family);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0${reason}`)}`;
  const event = `urn:rezics:event:${hash(`${batch}\0event`)}`;
  const kind = eventType(family, reason === 'stale-head' ? 'stale' : 'cancelled');
  try {
    await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, validations: [],
      deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, receipt, family, admission, admission.requestDigest)} ;
        rv:outcome rv:Cancelled ; rv:reason rv:${reason === 'stale-head' ? 'StaleHead' : 'Unavailable'} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
        rv:event ${iri(event)} .
        ${iri(event)} a rv:${kind} ; rv:ordinal 0 ; rv:action ${lit(admission.action)} ;
          rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      ${control(env)}
      ${guard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` });
  } catch { /* an ambiguous response resolves through the receipt */ }
  return readCommandReceipt(env, admission.id, family);
}

export interface CommandPlan {
  family: string;
  digest: string;
  validations: CommandValidation[];
  operation: string;
  component: string;
  revision: string;
  expectedHead: string | null;
  /** Triples removed from named graphs; `GRAPH` blocks written by the caller. */
  remove?: string;
  insert: string;
  /** Guards proving the exact heads, absence and dependencies the plan was built from. */
  where: string;
}

/** Commit one guarded plan. Returns null when its guards no longer hold. */
export async function commitCommand(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  plan: CommandPlan): Promise<ContextCommandReceipt | null> {
  const receipt = commandReceiptIri(admission.id, plan.family);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(`${batch}\0event`)}`;
  const kind = eventType(plan.family, 'committed');
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingContextCommand(admission.id, plan.family);
  let failure: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest: plan.digest, validations: plan.validations,
      deadlineMs: 10_000, update: `PREFIX rv: <${RV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${plan.remove ?? ''}
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      ${plan.insert}
      GRAPH ${iri(GRAPHS.receipts)} { ${receiptTriples(env, receipt, plan.family, admission, plan.digest)} ;
        rv:outcome rv:Succeeded ; rv:operation ${iri(plan.operation)} ;
        rv:component ${iri(plan.component)} ; rv:revision ${iri(plan.revision)}
        ${plan.expectedHead ? `; rv:expectedHead ${iri(plan.expectedHead)}` : ''} . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
        rv:event ${iri(event)} .
        ${iri(event)} a rv:${kind} ; rv:ordinal 0 ; rv:action ${lit(admission.action)} ;
          rv:receipt ${iri(receipt)} ; rv:operation ${iri(plan.operation)} ;
          rv:component ${iri(plan.component)} ; rv:revision ${iri(plan.revision)} . }
    }
    WHERE {
      ${control(env)}
      ${plan.where}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') throw new InvalidContextCommand(`${plan.family} validation failed: ${String(result.report ?? '')}`);
  } catch (error) {
    if (error instanceof InvalidContextCommand || error instanceof CommandRejected) throw error;
    failure = error;
  }
  const committed = await readCommandReceipt(env, admission.id, plan.family);
  if (committed) return committed;
  if (failure) throw new PendingContextCommand(admission.id, plan.family);
  return null;
}

/** Admission for one command: the operation runs only for a claimed, dispatchable admission. */
export interface AdmittedCommand<I> {
  family: string;
  oauthScope: string;
  scope: string;
  action: string;
  actingSubject: string;
  digest: string;
  input: I;
  idempotencyKey: string;
  execute: (admission: RegisteredAdmission, principal: VerifiedPrincipal) => Promise<ContextCommandReceipt>;
}

export async function runAdmittedCommand<I>(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, command: AdmittedCommand<I>): Promise<ContextCommandReceipt & { replayed: boolean }> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [command.oauthScope]);
  const registered = await access.register({ principal, actingSubject: command.actingSubject,
    scope: command.scope, action: command.action, idempotencyKey: command.idempotencyKey,
    requestDigest: command.digest });
  try {
    await assertNotInvalidProfileReceipt(env.fuseki, commandReceiptIri(registered.id, command.family));
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, command.digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed' && !await readCommandReceipt(env, registered.id, command.family)) {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealCommandTerminal(env, admission, command.family, 'unavailable');
      } else {
        try { await command.execute(admission, principal); }
        catch (error) {
          if (error instanceof IdempotencyConflict || error instanceof InvalidContextCommand
            || error instanceof CommandRejected) throw error;
          if (error instanceof ContextCommandUnavailable) {
            await sealCommandTerminal(env, admission, command.family, 'unavailable');
          }
        }
      }
    }
    const terminal = await readCommandReceipt(env, registered.id, command.family);
    if (!terminal) throw new PendingContextCommand(registered.id, command.family);
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedCommandReceipt(terminal, registered, command.digest), replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleContextCommand
      || error instanceof ContextCommandUnavailable || error instanceof InvalidContextCommand
      || error instanceof CommandRejected) throw error;
    throw new PendingContextCommand(registered.id, command.family);
  }
}
