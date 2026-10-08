import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { operationOutcome } from '../operation/outcome.ts';
import { GovernanceConflict, GovernanceDenied, GovernanceInvalid, GovernanceStale, GovernanceUnavailable,
  sha256, type DecisionInput, type DecisionResult } from './store.ts';

const realmPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentPattern = realmPattern;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const hiddenKey = /^(actingSubject|acting_subject|decider|deciderId|moderator|moderatorId|principalId|principal_id)$/i;

export const APPEAL_ALREADY_OPEN = 'appeal is already open';
type AppealTransaction = <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;
export type SanctionDecider = (client: PoolClient, actingSubject: string, scopeId: string) =>
  Promise<{ principalId: string; authorityEpoch: string; proofDigest: string }>;
type AppealState = 'open' | 'decided';
export interface AppealRead {
  realm: string; receiptId: string; action: 'ban'; reason: string; bannedUntil: string | null;
  permanent: boolean; happenedAt: string;
  appeal: { state: 'none' } | { state: 'open'; caseId: string; statement: string }
    | { state: 'decided'; caseId: string; statement: string; outcome: 'dismiss' | 'restore'; rationale: string | null };
}
interface BanReceipt { reason: string; member: string; bannedUntil: string | null; happenedAt: string }
interface AppealSource {
  realm: string; receiptId: string; reason: string; bannedUntil: string | null; happenedAt: string;
  decisionActingSubject: string | null;
  appeal: { state: 'none' } | { state: 'open'; caseId: string; statement: string }
    | { state: 'decided'; caseId: string; statement: string; outcome: 'dismiss' | 'restore'; rationale: string | null };
}

function postgresCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item);

/** A ban receipt is the member_action column, or a legacy row whose ban still cites it. */
export function isBanReceipt(receipt: { memberAction: string | null; memberPresent: boolean;
  resultBanned: boolean; reasonRefMatches: boolean; banActive: boolean }): boolean {
  if (!receipt.memberPresent) return false;
  if (receipt.memberAction === 'ban') return true;
  if (receipt.memberAction !== null) return false;
  return receipt.resultBanned && receipt.reasonRefMatches && receipt.banActive;
}

export function appealStatement(value: string): string {
  if (value !== value.trim() || value.length < 1 || value.length > 2000)
    throw new GovernanceInvalid('Appeal statement must be 1 to 2000 trimmed characters');
  return value;
}

/** Only the principal who controls the banned member may open the appeal. */
export function sanctionedPrincipal(controlsMember: boolean): void {
  if (!controlsMember) throw new GovernanceDenied('appeal is unavailable');
}

/** Same key returns the original case. A different statement never overwrites it. */
export function idempotencyReplay(prior: { caseId: string; digest: string; state: AppealState } | null,
  requestDigest: string): { caseId: string; state: AppealState } | null {
  if (!prior) return null;
  if (prior.digest !== requestDigest) throw new GovernanceConflict('idempotency key reused');
  return { caseId: prior.caseId, state: prior.state };
}

/** Fast path while one appeal is still open. A decided appeal stays one row, and the receipt unique index rejects another. */
export function openAppealConflict(anotherOpen: boolean): void {
  if (anotherOpen) throw new GovernanceConflict(APPEAL_ALREADY_OPEN);
}

/**
 * A unique violation is the receipt guarantee. The same key and digest replay
 * the winning row; any other appeal for the receipt is the existing conflict.
 */
export function uniqueAppealOutcome(existing: { principalId: string; idempotencyKey: string; digest: string;
  caseId: string; state: AppealState } | null, caller: string, key: string, requestDigest: string):
  { caseId: string; state: AppealState } {
  if (existing?.principalId === caller && existing.idempotencyKey === key) {
    const replay = idempotencyReplay(existing, requestDigest);
    if (replay) return replay;
  }
  throw new GovernanceConflict(APPEAL_ALREADY_OPEN);
}

/** The sanctioned member, or a moderator of this realm, may read. Anyone else is absent. */
export function realmModerator(mayRead: boolean): void {
  if (!mayRead) throw new GovernanceDenied('appeal is unavailable');
}

/**
 * The appellant always learns the outcome. The rationale follows the public-report
 * rule: a realm moderator sees the recorded text, and the appellant sees it only
 * when the decider shared it (`parties` or `public_summary`). `private` is outcome only.
 */
export function visibleAppealRationale(moderator: boolean, disclosure: string | null,
  rationale: string | null): string | null {
  if (moderator || disclosure === 'parties' || disclosure === 'public_summary') return rationale;
  return null;
}

/** Drop decider identity wherever a caller assembled it next to the public fields. */
export function publicResolution<T>(value: T): T {
  return stripIdentity(value) as T;
}

function stripIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIdentity);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !hiddenKey.test(key))
    .map(([key, item]) => [key, stripIdentity(item)]));
}

export function appealView(source: AppealSource): AppealRead {
  const decided = source.appeal.state === 'decided';
  const appeal = decided
    ? { ...source.appeal, acting_subject: source.decisionActingSubject }
    : source.appeal;
  return publicResolution({
    realm: source.realm, receiptId: source.receiptId, action: 'ban', reason: source.reason,
    bannedUntil: source.bannedUntil, permanent: source.bannedUntil === null, happenedAt: source.happenedAt, appeal,
  });
}

async function loadBan(client: PoolClient, realm: string, receiptId: string, lock: boolean): Promise<BanReceipt | null> {
  const row = (await client.query<{ reason: string; member_action: string | null; legacy_ban: boolean; created_at: Date;
    result: { member?: unknown; banned?: unknown; bannedUntil?: unknown } | null }>(
    `SELECT r.reason, r.member_action, r.result, r.created_at,
      EXISTS (SELECT 1 FROM access.membership_ban b WHERE b.kind = 'realm' AND b.owner_subject = r.realm
        AND b.member_subject = r.result->>'member' AND b.reason_ref = r.id::text AND b.active
        AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp())) AS legacy_ban
     FROM access.realm_admin_receipt r WHERE r.id = $1 AND r.realm = $2${lock ? ' FOR SHARE' : ''}`,
    [receiptId, realm])).rows[0];
  if (!row) return null;
  const member = typeof row.result?.member === 'string' ? row.result.member : '';
  if (!isBanReceipt({ memberAction: row.member_action, memberPresent: agentPattern.test(member),
    resultBanned: row.result?.banned === true, reasonRefMatches: row.legacy_ban, banActive: row.legacy_ban })) return null;
  return { reason: row.reason, member, happenedAt: row.created_at.toISOString(),
    bannedUntil: typeof row.result?.bannedUntil === 'string' ? row.result.bannedUntil : null };
}

async function callerPrincipal(client: PoolClient, principal: VerifiedPrincipal, lock: boolean): Promise<string | null> {
  const row = (await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active LIMIT 1${lock ? ' FOR SHARE' : ''}`,
  [principal.issuer, principal.subject])).rows[0];
  return row?.id ?? null;
}

async function controlsMember(client: PoolClient, principal: VerifiedPrincipal, member: string, lock: boolean): Promise<boolean> {
  const found = await client.query(`SELECT 1 FROM access.principal p
    JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $3 AND r.action = 'agent.control'
      AND r.active AND r.valid_until > clock_timestamp()
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
    WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
    LIMIT 1${lock ? ' FOR SHARE OF p, r, s' : ''}`, [principal.issuer, principal.subject, member]);
  return (found.rowCount ?? 0) > 0;
}

async function moderatesRealm(client: PoolClient, principal: VerifiedPrincipal, scopeId: string, lock: boolean): Promise<boolean> {
  const found = await client.query(`SELECT 1 FROM access.principal p
    JOIN access.representation r ON r.principal_id = p.id AND r.active AND r.valid_until > clock_timestamp()
      AND r.action IN ('governance.moderate', 'realm.owner', 'agent.control')
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.kind = 'agent' AND s.active
    JOIN access.permission_grant g ON g.recipient_subject = s.id AND g.scope_id = $3
      AND g.action = 'governance.moderate' AND g.active AND g.valid_until > clock_timestamp()
      AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
        WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
    JOIN access.scope_gate gate ON gate.id = g.scope_id AND gate.open AND gate.dispatch_open
    WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
    LIMIT 1${lock ? ' FOR SHARE OF p, r, s, g, gate' : ''}`, [principal.issuer, principal.subject, scopeId]);
  return (found.rowCount ?? 0) > 0;
}

async function priorAppeal(client: PoolClient, principalId: string, key: string):
  Promise<{ caseId: string; digest: string; state: AppealState } | null> {
  const row = (await client.query<{ case_id: string; request_digest: string; state: string }>(
    `SELECT a.case_id, a.request_digest, c.state FROM access.realm_sanction_appeal a
     JOIN access.governance_case c ON c.id = a.case_id
     WHERE a.principal_id = $1 AND a.idempotency_key = $2`, [principalId, key])).rows[0];
  if (!row) return null;
  return { caseId: row.case_id, digest: row.request_digest, state: row.state === 'open' ? 'open' : 'decided' };
}

export async function openRealmSanctionAppeal(principal: VerifiedPrincipal, input: {
  realm: string; receiptId: string; statement: string; idempotencyKey: string;
}, transaction: AppealTransaction): Promise<{ realm: string; receiptId: string; caseId: string; state: AppealState; replayed: boolean }> {
  const statement = appealStatement(input.statement);
  if (!realmPattern.test(input.realm) || !uuidPattern.test(input.receiptId) || !keyPattern.test(input.idempotencyKey))
    throw new GovernanceInvalid('invalid sanction appeal');
  const requestDigest = sha256(canonical({ realm: input.realm, receiptId: input.receiptId, statement }));
  return transaction(async client => {
    const ban = await loadBan(client, input.realm, input.receiptId, true);
    if (!ban) throw new GovernanceDenied('appeal is unavailable');
    // Lock an open case before the caller's principal so a decision on that case cannot deadlock.
    const openCase = (await client.query<{ id: string }>(`SELECT c.id FROM access.realm_sanction_appeal a
      JOIN access.governance_case c ON c.id = a.case_id
      WHERE a.receipt_id = $1 AND c.state = 'open' FOR UPDATE OF c`, [input.receiptId])).rows[0] ?? null;
    const caller = await callerPrincipal(client, principal, true);
    if (!caller) throw new GovernanceDenied('appeal is unavailable');
    sanctionedPrincipal(await controlsMember(client, principal, ban.member, true));
    const replay = idempotencyReplay(await priorAppeal(client, caller, input.idempotencyKey), requestDigest);
    if (replay) return { realm: input.realm, receiptId: input.receiptId, ...replay, replayed: true };
    openAppealConflict(openCase !== null);
    const scopeId = `governance:realm:${input.realm}`;
    const gate = await client.query(`SELECT 1 FROM access.scope_gate
      WHERE id = $1 AND open AND dispatch_open FOR SHARE`, [scopeId]);
    if (!gate.rowCount) throw new GovernanceUnavailable('realm governance is unavailable');
    const caseId = randomUUID();
    // The receipt unique index is the guarantee. A violation aborts the statement,
    // so return to this savepoint and read the winning row in the same transaction.
    await client.query('SAVEPOINT realm_sanction_appeal_insert');
    try {
      await client.query(`INSERT INTO access.governance_case (id, kind, authority_kind, authority_scope_id, context,
        target_owner, target_resource, target_component, disclosure)
        VALUES ($1,'realm_sanction_appeal','realm',$2,$3,'membership',$4,'sanction','parties')`,
      [caseId, scopeId, input.realm, input.receiptId]);
      await client.query(`INSERT INTO access.realm_sanction_appeal
        (case_id, receipt_id, realm, principal_id, member_subject, idempotency_key, request_digest, statement)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [caseId, input.receiptId, input.realm, caller, ban.member, input.idempotencyKey, requestDigest, statement]);
    } catch (error) {
      if (postgresCode(error) !== '23505') throw error;
      await client.query('ROLLBACK TO SAVEPOINT realm_sanction_appeal_insert');
      const winner = (await client.query<{ case_id: string; principal_id: string; idempotency_key: string;
        request_digest: string; state: string }>(`SELECT a.case_id, a.principal_id, a.idempotency_key, a.request_digest, c.state
        FROM access.realm_sanction_appeal a JOIN access.governance_case c ON c.id = a.case_id
        WHERE a.receipt_id = $1 OR (a.principal_id = $2 AND a.idempotency_key = $3)
        ORDER BY (a.receipt_id = $1::uuid) DESC LIMIT 1`,
      [input.receiptId, caller, input.idempotencyKey])).rows[0];
      const outcome = uniqueAppealOutcome(winner ? {
        principalId: winner.principal_id, idempotencyKey: winner.idempotency_key, digest: winner.request_digest,
        caseId: winner.case_id, state: winner.state === 'open' ? 'open' : 'decided',
      } : null, caller, input.idempotencyKey, requestDigest);
      return { realm: input.realm, receiptId: input.receiptId, ...outcome, replayed: true };
    }
    return { realm: input.realm, receiptId: input.receiptId, caseId, state: 'open', replayed: false };
  });
}

export async function readRealmSanctionAppeal(principal: VerifiedPrincipal,
  input: { realm: string; receiptId: string }, transaction: AppealTransaction): Promise<AppealRead> {
  if (!realmPattern.test(input.realm) || !uuidPattern.test(input.receiptId))
    throw new GovernanceInvalid('invalid sanction appeal');
  return transaction(async client => {
    const ban = await loadBan(client, input.realm, input.receiptId, false);
    if (!ban) throw new GovernanceDenied('appeal is unavailable');
    if (!await callerPrincipal(client, principal, false)) throw new GovernanceDenied('appeal is unavailable');
    const controls = await controlsMember(client, principal, ban.member, false);
    const moderates = await moderatesRealm(client, principal, `governance:realm:${input.realm}`, false);
    realmModerator(controls || moderates);
    const row = (await client.query<{ case_id: string; statement: string; state: string; outcome: string | null;
      rationale: string | null; disclosure: string | null; acting_subject: string | null }>(
      `SELECT a.case_id, a.statement, c.state, d.outcome, d.rationale, d.disclosure, d.acting_subject
       FROM access.realm_sanction_appeal a JOIN access.governance_case c ON c.id = a.case_id
       LEFT JOIN access.moderation_decision d ON d.id = c.decision_head
       WHERE a.receipt_id = $1 ORDER BY a.opened_at DESC LIMIT 1`, [input.receiptId])).rows[0];
    // Availability uses the stored rationale. A private decision still exists; the appellant just does not receive its text.
    if (row && row.state !== 'open' && (row.outcome !== 'dismiss' && row.outcome !== 'restore' || !row.rationale))
      throw new GovernanceUnavailable('sanction resolution is unavailable');
    const appeal = !row ? { state: 'none' as const }
      : row.state === 'open' ? { state: 'open' as const, caseId: row.case_id, statement: row.statement }
        : { state: 'decided' as const, caseId: row.case_id, statement: row.statement,
          outcome: row.outcome as 'dismiss' | 'restore',
          rationale: visibleAppealRationale(moderates, row.disclosure, row.rationale) };
    return appealView({ realm: input.realm, receiptId: input.receiptId, reason: ban.reason,
      bannedUntil: ban.bannedUntil, happenedAt: ban.happenedAt,
      decisionActingSubject: row?.acting_subject ?? null, appeal });
  });
}

function decisionView(decisionId: string, caseId: string, generation: string, outcome: string, replayed: boolean): DecisionResult {
  return { decisionId, caseId, caseGeneration: generation, outcome, enforcement: [], replayed,
    operation: operationOutcome(decisionId, []) };
}

/**
 * Record a dismiss or restore on a sanction appeal and close it. Neither outcome
 * changes membership_ban; lifting the ban stays a realm-admin action. Content
 * rules, evidence and effects do not apply, so this runs before that profile.
 */
export async function decideRealmSanctionAppeal(_principal: VerifiedPrincipal, input: DecisionInput,
  transaction: AppealTransaction, decider: SanctionDecider): Promise<DecisionResult> {
  if (!uuidPattern.test(input.caseId) || !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedGeneration)
    || !agentPattern.test(input.actingSubject) || !keyPattern.test(input.idempotencyKey)
    || (input.outcome !== 'dismiss' && input.outcome !== 'restore') || input.targets.length !== 0
    || input.reversesDecisionId !== null || input.answersStepId !== null
    || input.rationale === null || input.rationale !== input.rationale.trim()
    || input.rationale.length < 1 || input.rationale.length > 8000
    || !['private', 'parties', 'public_summary'].includes(input.disclosure)) {
    throw new GovernanceInvalid('sanction resolution does not match its profile');
  }
  const requestDigest = sha256(canonical({ ...input, idempotencyKey: undefined }));
  return transaction(async client => {
    const caseRow = (await client.query<{ id: string; kind: string; authority_kind: string; authority_scope_id: string;
      context: string; generation: string; state: string }>(`SELECT id, kind, authority_kind, authority_scope_id, context,
        generation::text, state FROM access.governance_case WHERE id = $1 FOR UPDATE`, [input.caseId])).rows[0];
    if (!caseRow || caseRow.kind !== 'realm_sanction_appeal') throw new GovernanceDenied('case is unavailable');
    const authority = await decider(client, input.actingSubject, caseRow.authority_scope_id);
    const prior = (await client.query<{ id: string; request_digest: string }>(`SELECT id, request_digest
      FROM access.moderation_decision WHERE principal_id = $1 AND kind = 'realm_sanction_resolution' AND idempotency_key = $2`,
    [authority.principalId, input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest) throw new GovernanceConflict('idempotency key reused');
      const current = (await client.query<{ generation: string; outcome: string }>(`SELECT c.generation::text, d.outcome
        FROM access.moderation_decision d JOIN access.governance_case c ON c.id = d.case_id WHERE d.id = $1`, [prior.id])).rows[0];
      if (!current) throw new GovernanceUnavailable('sanction resolution is unavailable');
      return decisionView(prior.id, input.caseId, current.generation, current.outcome, true);
    }
    if (caseRow.state !== 'open' || caseRow.generation !== input.expectedGeneration)
      throw new GovernanceStale('case changed since review');
    const decisionId = randomUUID();
    const sequence = (BigInt(caseRow.generation) + 1n).toString();
    await client.query(`INSERT INTO access.moderation_decision (id, kind, outcome, context, case_id, case_sequence,
        principal_id, acting_subject, authority_kind, authority_scope_id, authority_epoch, authority_proof_digest,
        idempotency_key, request_digest, rationale, disclosure)
      VALUES ($1,'realm_sanction_resolution',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [decisionId, input.outcome, caseRow.context, caseRow.id, sequence, authority.principalId, input.actingSubject,
      caseRow.authority_kind, caseRow.authority_scope_id, authority.authorityEpoch, authority.proofDigest,
      input.idempotencyKey, requestDigest, input.rationale, input.disclosure]);
    await client.query(`UPDATE access.governance_case
      SET decision_head = $2, generation = $3, state = 'closed', closed_at = clock_timestamp() WHERE id = $1`,
    [caseRow.id, decisionId, sequence]);
    return decisionView(decisionId, caseRow.id, sequence, input.outcome, false);
  });
}
