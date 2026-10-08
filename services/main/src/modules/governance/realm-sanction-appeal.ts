import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { changeRealmMember } from '../access/realm-management-members.ts';
import { lockAccessKey } from '../access/scope-gates.ts';
import { operationOutcome } from '../operation/outcome.ts';
import { RealmAdminDenied, RealmAdminLimit, RealmAdminStale, RealmAdminUnavailable,
  type MemberCommand } from '../realm-admin/contract.ts';
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
type StoredDecision = { state: 'decided'; caseId: string; statement: string; outcome: 'dismiss' | 'restore';
  rationale: string | null };
type OpenAppeal = { state: 'none' } | { state: 'open'; caseId: string; statement: string };
export interface BanLift { liftedAt: string; liftReceiptId: string | null }
type DismissedAppeal = { state: 'decided'; caseId: string; statement: string; outcome: 'dismiss'; rationale: string | null };
type ReversedAppeal = { state: 'decided'; caseId: string; statement: string; outcome: 'reversed'; rationale: string | null;
  liftedAt: string; liftReceiptId: string | null };
export interface AppealRead {
  realm: string; receiptId: string; action: 'ban'; reason: string; bannedUntil: string | null;
  permanent: boolean; happenedAt: string;
  appeal: OpenAppeal | DismissedAppeal | ReversedAppeal;
}
interface BanReceipt { reason: string; member: string; bannedUntil: string | null; happenedAt: string }
interface AppealSource {
  realm: string; receiptId: string; reason: string; bannedUntil: string | null; happenedAt: string;
  decisionActingSubject: string | null; lift: BanLift | null;
  appeal: OpenAppeal | StoredDecision;
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

/**
 * The stored decision says `restore`. The member reads that as `reversed`:
 * the ban ended, when, and which receipt lifted it. Dismissal has none of those.
 */
export function presentSanctionDecision(appeal: StoredDecision, lift: BanLift | null): DismissedAppeal | ReversedAppeal {
  if (appeal.outcome === 'dismiss') return { state: 'decided', caseId: appeal.caseId, statement: appeal.statement,
    outcome: 'dismiss', rationale: appeal.rationale };
  if (!lift?.liftedAt) throw new GovernanceUnavailable('sanction resolution is unavailable');
  return { state: 'decided', caseId: appeal.caseId, statement: appeal.statement, outcome: 'reversed',
    rationale: appeal.rationale, liftedAt: lift.liftedAt, liftReceiptId: lift.liftReceiptId };
}

export function appealView(source: AppealSource): AppealRead {
  const appeal = source.appeal.state === 'decided'
    ? { ...presentSanctionDecision(source.appeal, source.lift), acting_subject: source.decisionActingSubject }
    : source.appeal;
  return publicResolution({
    realm: source.realm, receiptId: source.receiptId, action: 'ban', reason: source.reason,
    bannedUntil: source.bannedUntil, permanent: source.bannedUntil === null, happenedAt: source.happenedAt, appeal,
  });
}

export interface MemberBanRead {
  realm: string; receiptId: string; action: 'ban'; reason: string; bannedUntil: string | null;
  permanent: boolean; happenedAt: string;
  appeal: OpenAppeal | (DismissedAppeal & { decidedAt: string }) | (ReversedAppeal & { decidedAt: string });
}

/** The member's own ban. A decided appeal carries when it was decided; the decider does not. */
export function memberBanView(source: AppealSource & { decidedAt: string | null }): MemberBanRead {
  const base = {
    realm: source.realm, receiptId: source.receiptId, action: 'ban' as const, reason: source.reason,
    bannedUntil: source.bannedUntil, permanent: source.bannedUntil === null, happenedAt: source.happenedAt,
  };
  if (source.appeal.state !== 'decided') return publicResolution({ ...base, appeal: source.appeal });
  if (!source.decidedAt) throw new GovernanceUnavailable('sanction resolution is unavailable');
  return publicResolution({ ...base, appeal: {
    ...presentSanctionDecision(source.appeal, source.lift), decidedAt: source.decidedAt,
    acting_subject: source.decisionActingSubject,
  } });
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
    // A reversal locks this gate, then the principal. Share it first so the two paths agree.
    const scopeId = `governance:realm:${input.realm}`;
    const gate = await client.query(`SELECT 1 FROM access.scope_gate
      WHERE id = $1 AND open AND dispatch_open FOR SHARE`, [scopeId]);
    if (!gate.rowCount) throw new GovernanceUnavailable('realm governance is unavailable');
    const caller = await callerPrincipal(client, principal, true);
    if (!caller) throw new GovernanceDenied('appeal is unavailable');
    sanctionedPrincipal(await controlsMember(client, principal, ban.member, true));
    const replay = idempotencyReplay(await priorAppeal(client, caller, input.idempotencyKey), requestDigest);
    if (replay) return { realm: input.realm, receiptId: input.receiptId, ...replay, replayed: true };
    openAppealConflict(openCase !== null);
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
      rationale: string | null; disclosure: string | null; acting_subject: string | null;
      lifted_at: Date | null; lift_receipt_id: string | null }>(
      `SELECT a.case_id, a.statement, c.state, d.outcome, d.rationale, d.disclosure, d.acting_subject,
         l.lifted_at, l.receipt_id AS lift_receipt_id
       FROM access.realm_sanction_appeal a JOIN access.governance_case c ON c.id = a.case_id
       LEFT JOIN access.moderation_decision d ON d.id = c.decision_head
       LEFT JOIN access.realm_sanction_lift l ON l.decision_id = d.id
       WHERE a.receipt_id = $1 ORDER BY a.opened_at DESC LIMIT 1`, [input.receiptId])).rows[0];
    // Availability uses the stored rationale. A private decision still exists; the appellant just does not receive its text.
    if (row && row.state !== 'open' && (row.outcome !== 'dismiss' && row.outcome !== 'restore' || !row.rationale
      || row.outcome === 'restore' && !row.lifted_at))
      throw new GovernanceUnavailable('sanction resolution is unavailable');
    const appeal = !row ? { state: 'none' as const }
      : row.state === 'open' ? { state: 'open' as const, caseId: row.case_id, statement: row.statement }
        : { state: 'decided' as const, caseId: row.case_id, statement: row.statement,
          outcome: row.outcome as 'dismiss' | 'restore',
          rationale: visibleAppealRationale(moderates, row.disclosure, row.rationale) };
    return appealView({ realm: input.realm, receiptId: input.receiptId, reason: ban.reason,
      bannedUntil: ban.bannedUntil, happenedAt: ban.happenedAt,
      decisionActingSubject: row?.acting_subject ?? null,
      lift: row?.lifted_at ? { liftedAt: row.lifted_at.toISOString(), liftReceiptId: row.lift_receipt_id } : null,
      appeal });
  });
}

/**
 * The principal who controls `actingSubject` reads that subject's current ban.
 * Not controlling them, no ban, and an expired ban are one absence. The latest
 * ban receipt is the one still in force; a passed `expires_at` is no ban.
 * A reversal of that latest receipt stays readable after the lift, with when
 * it ended and which receipt lifted it. Private rationale stays outcome-only.
 */
export async function readRealmMemberBan(principal: VerifiedPrincipal,
  input: { realm: string; actingSubject: string }, transaction: AppealTransaction): Promise<MemberBanRead> {
  if (!realmPattern.test(input.realm) || !agentPattern.test(input.actingSubject))
    throw new GovernanceInvalid('invalid member ban');
  return transaction(async client => {
    sanctionedPrincipal(await controlsMember(client, principal, input.actingSubject, false));
    const ban = (await client.query<{ id: string; reason: string; created_at: Date; in_force: boolean;
      result: { bannedUntil?: unknown } | null }>(
      `SELECT r.id, r.reason, r.result, r.created_at,
         EXISTS (SELECT 1 FROM access.membership_ban b WHERE b.kind = 'realm' AND b.owner_subject = $1
           AND b.member_subject = $2 AND b.active AND b.reason_ref = r.id::text
           AND (b.expires_at IS NULL OR b.expires_at > clock_timestamp())) AS in_force
       FROM access.realm_admin_receipt r
       WHERE r.realm = $1 AND r.result->>'member' = $2
         AND (r.member_action = 'ban' OR (r.member_action IS NULL AND r.result->>'banned' = 'true'))
       ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, [input.realm, input.actingSubject])).rows[0];
    if (!ban) throw new GovernanceDenied('appeal is unavailable');
    const row = (await client.query<{ case_id: string; statement: string; state: string; outcome: string | null;
      rationale: string | null; disclosure: string | null; acting_subject: string | null; decided_at: Date | null;
      lifted_at: Date | null; lift_receipt_id: string | null }>(
      `SELECT a.case_id, a.statement, c.state, d.outcome, d.rationale, d.disclosure, d.acting_subject, d.decided_at,
         l.lifted_at, l.receipt_id AS lift_receipt_id
       FROM access.realm_sanction_appeal a JOIN access.governance_case c ON c.id = a.case_id
       LEFT JOIN access.moderation_decision d ON d.id = c.decision_head
       LEFT JOIN access.realm_sanction_lift l ON l.decision_id = d.id
       WHERE a.receipt_id = $1 ORDER BY a.opened_at DESC LIMIT 1`, [ban.id])).rows[0];
    const reversed = row?.state !== 'open' && row?.outcome === 'restore' && !!row.lifted_at;
    // An expired or otherwise ended ban is absence, unless this latest receipt was reversed.
    if (!ban.in_force && !reversed) throw new GovernanceDenied('appeal is unavailable');
    if (row && row.state !== 'open' && (row.outcome !== 'dismiss' && row.outcome !== 'restore' || !row.rationale || !row.decided_at
      || row.outcome === 'restore' && !row.lifted_at))
      throw new GovernanceUnavailable('sanction resolution is unavailable');
    const appeal = !row ? { state: 'none' as const }
      : row.state === 'open' ? { state: 'open' as const, caseId: row.case_id, statement: row.statement }
        : { state: 'decided' as const, caseId: row.case_id, statement: row.statement,
          outcome: row.outcome as 'dismiss' | 'restore',
          rationale: visibleAppealRationale(false, row.disclosure, row.rationale) };
    return memberBanView({ realm: input.realm, receiptId: ban.id, reason: ban.reason,
      bannedUntil: typeof ban.result?.bannedUntil === 'string' ? ban.result.bannedUntil : null,
      happenedAt: ban.created_at.toISOString(), decisionActingSubject: row?.acting_subject ?? null,
      decidedAt: row?.decided_at?.toISOString() ?? null,
      lift: row?.lifted_at ? { liftedAt: row.lifted_at.toISOString(), liftReceiptId: row.lift_receipt_id } : null,
      appeal });
  });
}

function decisionView(decisionId: string, caseId: string, generation: string, outcome: string, replayed: boolean): DecisionResult {
  return { decisionId, caseId, caseGeneration: generation, outcome, enforcement: [], replayed,
    operation: operationOutcome(decisionId, []) };
}

function governanceFailure(error: unknown): never {
  if (error instanceof RealmAdminDenied) throw new GovernanceDenied(error.message);
  if (error instanceof RealmAdminStale) throw new GovernanceStale(error.message);
  if (error instanceof RealmAdminUnavailable || error instanceof RealmAdminLimit)
    throw new GovernanceUnavailable(error.message);
  throw error;
}

/** The unban grant. Decision authority alone (`governance.moderate`) is not enough. */
async function requireUnbanAuthority(client: PoolClient, principal: VerifiedPrincipal, realm: string, actor: string): Promise<void> {
  const row = await client.query(`SELECT 1 FROM access.principal p
    JOIN access.representation r ON r.principal_id = p.id AND r.subject_id = $3
      AND r.active AND r.valid_until > clock_timestamp()
      AND r.action IN ('realm.members.manage', 'realm.owner', 'agent.control')
    JOIN access.authority_subject a ON a.id = r.subject_id AND a.kind = 'agent' AND a.active
    JOIN access.permission_grant g ON g.recipient_subject = a.id AND g.scope_id = $4
      AND g.action = 'realm.members.manage' AND g.active AND g.valid_until > clock_timestamp()
      AND (g.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership m
        WHERE m.id = g.membership_id AND m.state = 'joined' AND m.generation = g.membership_generation))
    JOIN access.scope_gate gate ON gate.id = g.scope_id AND gate.open AND gate.dispatch_open
    WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
    LIMIT 1 FOR SHARE OF p, r, a, g, gate`,
  [principal.issuer, principal.subject, actor, `governance:realm:${realm}`]);
  if (!row.rowCount) throw new GovernanceDenied('Realm permission is missing');
}

/** Realm gate, then revision, before the principal. Matches a member-change write. */
async function lockRealmRevision(client: PoolClient, realm: string): Promise<string> {
  const gate = await client.query(`SELECT 1 FROM access.scope_gate WHERE id = $1
    AND open AND dispatch_open FOR UPDATE`, [`governance:realm:${realm}`]);
  if (!gate.rowCount) throw new GovernanceUnavailable('realm governance is unavailable');
  const revision = (await client.query<{ generation: string }>(`SELECT generation::text
    FROM access.realm_admin_revision WHERE realm = $1 FOR UPDATE`, [realm])).rows[0];
  if (!revision) throw new GovernanceUnavailable('realm governance is unavailable');
  return revision.generation;
}

interface AppealLift { receiptId: string | null; liftedAt: string }

/**
 * End the appealed ban with the existing unban transition, or keep the receipt
 * that already ended it. A later, different ban is left alone.
 */
async function liftAppealedBan(client: PoolClient, realm: string, member: string, receiptId: string,
  principalId: string, actingSubject: string, caseId: string, realmGeneration: string): Promise<AppealLift> {
  const root = await client.query(`SELECT 1 FROM access.scope_gate WHERE id = 'work:create:root'
    AND open AND dispatch_open FOR SHARE`);
  if (!root.rowCount) throw new GovernanceUnavailable('realm governance is unavailable');
  await lockAccessKey(client, `membership:realm:${realm}:${member}`);
  const subject = await client.query(`SELECT 1 FROM access.authority_subject
    WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [member]);
  if (!subject.rowCount) throw new GovernanceDenied('case is unavailable');
  const policy = await client.query(`SELECT 1 FROM access.membership_policy
    WHERE kind = 'realm' AND owner_subject = $1 FOR SHARE`, [realm]);
  if (!policy.rowCount) throw new GovernanceUnavailable('realm governance is unavailable');
  const membership = (await client.query<{ generation: string }>(`SELECT generation::text FROM access.membership
    WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2 FOR UPDATE`, [realm, member])).rows[0];
  const ban = (await client.query<{ active: boolean; reason_ref: string | null; expires_at: Date | null;
    in_force: boolean }>(`SELECT active, reason_ref, expires_at,
      active AND (expires_at IS NULL OR expires_at > clock_timestamp()) AS in_force
    FROM access.membership_ban WHERE kind = 'realm' AND owner_subject = $1 AND member_subject = $2
    FOR UPDATE`, [realm, member])).rows[0];
  if (ban?.in_force) {
    if (ban.reason_ref !== receiptId) throw new GovernanceStale('case changed since review');
    const liftReceiptId = randomUUID();
    const command: MemberCommand = { actingSubject, expectedGeneration: realmGeneration,
      expectedMembershipGeneration: membership?.generation ?? '0', reason: 'Sanction appeal reversed',
      action: 'unban', member, consent: null, durationSeconds: null };
    let changed: { member: string; membershipGeneration: string; bannedUntil: string | null; banned: boolean };
    try { changed = await changeRealmMember(client, realm, command, principalId, liftReceiptId); }
    catch (error) { governanceFailure(error); }
    const next = (BigInt(realmGeneration) + 1n).toString();
    const result = { receiptId: liftReceiptId, generation: next, replayed: false, appealCaseId: caseId, ...changed };
    const written = (await client.query<{ created_at: Date }>(`INSERT INTO access.realm_admin_receipt
      (id, realm, principal_id, acting_subject, idempotency_key, request_digest, action, reason, result, member_action)
      VALUES ($1,$2,$3,$4,$5,$6,'realm.members.manage','Sanction appeal reversed',$7,'unban')
      RETURNING created_at`,
    [liftReceiptId, realm, principalId, actingSubject, `appeal-lift:${caseId}`,
      sha256(canonical({ realm, caseId, member, action: 'unban' })), result])).rows[0];
    await client.query(`UPDATE access.realm_admin_revision SET generation = generation + 1 WHERE realm = $1`, [realm]);
    if (!written) throw new GovernanceUnavailable('sanction resolution is unavailable');
    return { receiptId: liftReceiptId, liftedAt: written.created_at.toISOString() };
  }
  const existing = ban?.reason_ref && uuidPattern.test(ban.reason_ref)
    ? (await client.query<{ id: string; created_at: Date; member_action: string | null }>(
      `SELECT id, created_at, member_action FROM access.realm_admin_receipt WHERE id = $1`,
    [ban.reason_ref])).rows[0] : undefined;
  if (existing?.member_action === 'unban') return { receiptId: existing.id, liftedAt: existing.created_at.toISOString() };
  if (ban && !ban.in_force && ban.expires_at) return { receiptId: null, liftedAt: ban.expires_at.toISOString() };
  const prior = (await client.query<{ id: string; created_at: Date }>(`SELECT id, created_at
    FROM access.realm_admin_receipt WHERE realm = $1 AND member_action = 'unban' AND result->>'member' = $2
    ORDER BY created_at DESC, id DESC LIMIT 1`, [realm, member])).rows[0];
  if (prior) return { receiptId: prior.id, liftedAt: prior.created_at.toISOString() };
  const now = (await client.query<{ at: Date }>(`SELECT clock_timestamp() AS at`)).rows[0];
  if (!now) throw new GovernanceUnavailable('sanction resolution is unavailable');
  return { receiptId: null, liftedAt: now.at.toISOString() };
}

/**
 * Record a dismiss or restore on a sanction appeal and close it. restore lifts
 * the ban in this transaction and keeps the unban receipt; dismiss does not.
 * Content rules, evidence and effects do not apply, so this runs before that profile.
 */
export async function decideRealmSanctionAppeal(principal: VerifiedPrincipal, input: DecisionInput,
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
    const reversing = input.outcome === 'restore';
    // Gate and revision before the decider's principal lock, the same order as unban.
    const realmGeneration = reversing ? await lockRealmRevision(client, caseRow.context) : null;
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
    let lift: AppealLift | null = null;
    if (reversing) {
      await requireUnbanAuthority(client, principal, caseRow.context, input.actingSubject);
      const appeal = (await client.query<{ receipt_id: string; realm: string; member_subject: string }>(
        `SELECT receipt_id, realm, member_subject FROM access.realm_sanction_appeal WHERE case_id = $1`,
      [caseRow.id])).rows[0];
      if (!appeal || realmGeneration === null) throw new GovernanceDenied('case is unavailable');
      lift = await liftAppealedBan(client, appeal.realm, appeal.member_subject, appeal.receipt_id,
        authority.principalId, input.actingSubject, caseRow.id, realmGeneration);
    }
    const decisionId = randomUUID();
    const sequence = (BigInt(caseRow.generation) + 1n).toString();
    await client.query(`INSERT INTO access.moderation_decision (id, kind, outcome, context, case_id, case_sequence,
        principal_id, acting_subject, authority_kind, authority_scope_id, authority_epoch, authority_proof_digest,
        idempotency_key, request_digest, rationale, disclosure)
      VALUES ($1,'realm_sanction_resolution',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [decisionId, input.outcome, caseRow.context, caseRow.id, sequence, authority.principalId, input.actingSubject,
      caseRow.authority_kind, caseRow.authority_scope_id, authority.authorityEpoch, authority.proofDigest,
      input.idempotencyKey, requestDigest, input.rationale, input.disclosure]);
    if (lift) await client.query(`INSERT INTO access.realm_sanction_lift (decision_id, receipt_id, lifted_at)
      VALUES ($1,$2,$3)`, [decisionId, lift.receiptId, lift.liftedAt]);
    await client.query(`UPDATE access.governance_case
      SET decision_head = $2, generation = $3, state = 'closed', closed_at = clock_timestamp() WHERE id = $1`,
    [caseRow.id, decisionId, sequence]);
    return decisionView(decisionId, caseRow.id, sequence, input.outcome, false);
  });
}
