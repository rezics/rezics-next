import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { voteReceiptIri, type VoteAdmission } from './access.ts';

/**
 * Guarded Jena command core for vote operations. One SPARQL update changes the
 * owner facts, the receipt, the dataset sequence and one outbox batch; every
 * frozen-state, head and uniqueness expectation is a guard in the same TDB2 write
 * transaction, and the post-state is validated against the vote profiles.
 */

export const DEF = 'https://rezics.com/definition/';
export const CURRENT = GRAPHS.current;
export const REVISIONS = GRAPHS.revisions;

/** Request contradicts the frozen poll, charter or seat; retries return the same code. */
export class VoteRejected extends Error {
  constructor(readonly code: string, message = code) { super(message); }
}
/** The expected head changed; the caller re-reads and decides again. */
export class VoteStale extends Error {}
/** Poll, seat or dependency is unknown or not readable. */
export class VoteUnavailable extends Error {}
export class VoteConflict extends Error {}
/** The graph outcome is not yet resolved; retry the same key. */
export class PendingVoteWork extends Error {
  readonly operationId: string;
  constructor(admissionId: string) {
    super('vote outcome requires reconciliation');
    this.operationId = `urn:rezics:operation:${hash(admissionId)}`;
  }
}

/** Deterministic native identity; converging paths name the same component. */
export function voteId(...parts: string[]): string {
  const h = hash(JSON.stringify(parts));
  return `${ID}${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
export const newId = () => ID + Bun.randomUUIDv7();
export const digestOf = (value: unknown) => hash(JSON.stringify(value));
export const dateTime = (value: string) => `${lit(value)}^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
export function langText(text: string, language: string): string {
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) throw new VoteRejected('invalid_language');
  return `${lit(text)}@${language}`;
}

export interface VoteReceipt {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head' | 'rejected';
  code?: string;
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string;
  component?: string; revision?: string;
}

export async function readVoteReceipt(env: WorkActivationEnvironment,
  admission: VoteAdmission): Promise<VoteReceipt | null> {
  const receipt = voteReceiptIri(admission.id, admission.operation);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?reason ?code ?digest ?id ?epoch
    ?scope ?dataEpoch ?sequence ?component ?revision ?kind WHERE { GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ; rv:requestDigest ?digest ;
        rv:admissionId ?id ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
        rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:reason ?reason } OPTIONAL { ${iri(receipt)} rv:rejectionCode ?code }
      OPTIONAL { ${iri(receipt)} rv:rejectionKind ?kind }
      OPTIONAL { ${iri(receipt)} rv:voteComponent ?component ; rv:voteRevision ?revision } } }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const get = (name: string) => row[name]?.value;
  const outcome = get('outcome') === `${RV}Succeeded` ? 'succeeded'
    : get('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const invalidProfile = get('kind') === `${RV}InvalidProfile`;
  const reason = get('reason') === `${RV}StaleHead` ? 'stale-head'
    : get('reason') === `${RV}VoteRejected` || invalidProfile ? 'rejected' : undefined;
  const code = invalidProfile ? 'invalid_profile_state' : get('code');
  if (rows.length !== 1 || !outcome || !/^[0-9]+$/.test(get('sequence') ?? '')
    || (outcome === 'succeeded' && (!get('component') || !get('revision') || reason))
    || (outcome === 'cancelled' && get('component'))) {
    throw new VoteUnavailable('vote receipt is incomplete');
  }
  return { outcome, ...(reason ? { reason } : {}), ...(code ? { code } : {}),
    receipt, admissionId: get('id')!, requestDigest: get('digest')!, authorityEpoch: get('epoch')!,
    scope: get('scope')!, dataEpoch: get('dataEpoch')!, sequence: get('sequence')!,
    ...(outcome === 'succeeded' ? { component: get('component'), revision: get('revision') } : {}) };
}

/** The receipt belongs to this exact admission; a cancelled one replays its typed error. */
export function checkedVoteReceipt(receipt: VoteReceipt, admission: VoteAdmission): VoteReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== admission.requestDigest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new VoteConflict('vote receipt differs from admission');
  }
  if (receipt.outcome === 'cancelled') {
    if (receipt.reason === 'stale-head') throw new VoteStale('expected head is stale');
    if (receipt.reason === 'rejected') throw new VoteRejected(receipt.code ?? 'vote_rejected');
    throw new VoteRejected('admission_lapsed', 'the admission lapsed before dispatch');
  }
  return receipt;
}

const control = (env: WorkActivationEnvironment) => `GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }`;
const receiptFields = (env: WorkActivationEnvironment, admission: VoteAdmission) => `
  rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
  rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
  rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next`;

/** Commit a typed terminal cancellation unless this admission already has a receipt. */
export async function sealVoteTerminal(env: WorkActivationEnvironment, admission: VoteAdmission,
  reason?: 'stale-head' | 'rejected', code?: string): Promise<VoteReceipt | null> {
  const receipt = voteReceiptIri(admission.id, admission.operation);
  const suffix = hash(`${receipt}\0${reason ?? 'cancel'}`);
  const batch = `urn:rezics:outbox:${suffix}`;
  const event = `urn:rezics:event:${suffix}`;
  const cancelKinds: Record<string, string> = {
    'governance.poll.administer': 'VotePollCancelledEvent',
    'governance.seat.manage': 'VoteSeatCancelledEvent',
    'governance.ballot.operate': 'VoteBallotCancelledEvent',
    'governance.ballot.invalidate': 'VoteInvalidationCancelledEvent',
  };
  const cancelKind = cancelKinds[admission.action];
  if (!cancelKind) throw new VoteConflict('vote cancellation action is unavailable');
  try {
    await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, validations: [],
      deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Cancelled ;
          ${reason === 'stale-head' ? 'rv:reason rv:StaleHead ;' : reason === 'rejected'
            ? `rv:reason rv:VoteRejected ; rv:rejectionCode ${lit(code ?? 'vote_rejected')} ;` : ''}
          ${receiptFields(env, admission)} . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:${cancelKind} ; rv:ordinal 0 ; rv:action ${lit(admission.action)} ;
            rv:receipt ${iri(receipt)} . }
      }
      WHERE { ${control(env)}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next) }` });
  } catch { /* resolve an ambiguous update through the receipt */ }
  return readVoteReceipt(env, admission);
}

export interface VoteCommandPlan {
  admission: VoteAdmission;
  validations: CommandValidation[];
  remove?: string;
  insert: string;
  where: string;
  component: string;
  revision: string;
  operation: string;
  event: string;
}

/**
 * Run one guarded command. Returns true when this admission's success receipt
 * exists afterwards; false means the guard did not match (the caller classifies
 * stale or rejected from a fresh read). Invalid post-state is a typed rejection.
 */
export async function executeVoteCommand(env: WorkActivationEnvironment, plan: VoteCommandPlan): Promise<boolean> {
  const { admission } = plan;
  const receipt = voteReceiptIri(admission.id, admission.operation);
  if (Date.parse(admission.expiresAt) <= Date.now()) return false;
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(plan.operation)}`;
  try {
    const result = await validatedCommand(env, { receipt, digest: admission.requestDigest,
      validations: plan.validations, deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } ${plan.remove ?? ''} }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        ${plan.insert}
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
          rv:operation ${iri(plan.operation)} ; rv:voteComponent ${iri(plan.component)} ;
          rv:voteRevision ${iri(plan.revision)} ; ${receiptFields(env, admission)} . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:${plan.event} ; rv:ordinal 0 ; rv:action ${lit(admission.action)} ;
            rv:receipt ${iri(receipt)} ; rv:operation ${iri(plan.operation)} ;
            rv:voteComponent ${iri(plan.component)} . }
      }
      WHERE { ${control(env)}
        ${plan.where}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(plan.revision)} ?p ?o } }
        BIND(?n + 1 AS ?next) }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new VoteRejected('invalid_profile_state', 'vote post-state violates its profile');
    }
  } catch (error) {
    if (error instanceof VoteRejected || error instanceof CommandRejected) throw error;
  }
  const committed = await readVoteReceipt(env, admission);
  return committed?.outcome === 'succeeded';
}
