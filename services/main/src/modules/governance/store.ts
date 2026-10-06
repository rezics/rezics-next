import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { platformAdministratorProof } from '../access/platform-administrator.ts';
import { decisionOutcomes, enforcementEffects, GLOBAL_CONTEXT, governanceComponents, governanceOwners,
  processSteps } from './schema.ts';
import { KnownEffectFailure, type ModerationEffects } from './effects.ts';
import type { ReviewReportOwner } from './report-review.ts';
import { DisclosureStore, configureDisclosurePool } from '../disclosure/read.ts';
import { operationOutcome, type OperationOutcome, type EffectState } from '../operation/outcome.ts';
import { SafetyQueue } from '../safety-queue/store.ts';
import { mintPartyCredential } from '../public-report/store.ts';
import { validContentLanguage } from '../public-report/contract.ts';

export class GovernanceInvalid extends Error {}
export class GovernanceDenied extends Error {}
export class GovernanceConflict extends Error {}
export class GovernanceStale extends Error {}
export class GovernanceUnavailable extends Error {}

export type GovernanceOwner = typeof governanceOwners[number];
export type GovernanceComponent = typeof governanceComponents[number];
export type EvidenceState = 'available' | 'empty' | 'unavailable' | 'erased' | 'unsupported';
export type DecisionOutcome = typeof decisionOutcomes[number];
export type EnforcementEffect = typeof enforcementEffects[number];

/** Preparation is bounded by 64 targets. Resume uses two Access transactions
 * per unconfirmed effect, each at most 24 statements plus one bounded owner call. */
export const GOVERNANCE_OPERATION_COST = {
  targets: 64,
  accessTransactionsPerEffect: 2,
  accessStatementsPerTransaction: 24,
  copyBatch: 100,
  statementTimeoutMs: 5000,
} as const;

export const GOVERNANCE_LIMITS = { evidence: 16, targets: 64, page: 50 } as const;
/** Independent report/step keysets; no per-row authority or owner calls. */
export const SAFETY_CASE_READ_COST = { page: 50, statements: 24, statementTimeoutMs: 5000 } as const;
/** Access actions a decider's acting Agent must hold on the case authority scope. */
export const DECIDE_ACTION = { content_report: 'governance.moderate', rights_complaint: 'governance.rights.decide' } as const;
export const APPEAL_ACTION = 'governance.appeal';

const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const digestPattern = /^[0-9a-f]{64}$/;
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

export interface EvidenceTarget {
  owner: GovernanceOwner; resource: string; component: GovernanceComponent;
  revision: string | null; locator: string | null;
}
export interface CapturedEvidence extends EvidenceTarget {
  state: EvidenceState; representation: string | null; revisionDigest: string | null;
  provenance: Record<string, string>;
}
/**
 * Owner-specific capture of one exact grain while the reporter is authorized.
 * Throw GovernanceDenied when the reporter may not read it; return a distinct
 * state otherwise. Never substitute the current head for a named revision.
 */
export interface EvidenceCapture {
  capture(principal: VerifiedPrincipal, actingSubject: string, target: EvidenceTarget): Promise<CapturedEvidence>;
}
/** Current owner head for decision staleness; null when the component has none. */
export interface TargetHeads {
  current(target: { owner: GovernanceOwner; resource: string; component: GovernanceComponent;
    revision: string | null; locator: string | null }): Promise<string | null>;
}
/** Current revision and digest of a governance rule; null when unknown or retired. */
export interface RuleBasis {
  current(ruleRef: string, scopeId?: string, client?: PoolClient): Promise<{ revision: string; digest: string } | null>;
}

export interface ReportInput {
  kind: 'content_report' | 'rights_complaint';
  actingSubject: string;
  authority: { kind: 'platform' | 'realm' | 'resource_owner'; scopeId: string };
  context: string;
  target: { owner: GovernanceOwner; resource: string; component: GovernanceComponent };
  disclosure: 'private' | 'parties' | 'public_summary';
  reasonCode: string;
  statement: string | null;
  evidence: EvidenceTarget[];
  idempotencyKey: string;
  complaint?: {
    process: 'dmca_512' | 'ordinary_dispute'; claimantKind: 'rights_holder' | 'authorized_agent' | 'unknown';
    claimantName: string; claimantContact: string | null; claimedWork: string;
    claimedRight: 'copyright' | 'trademark' | 'privacy' | 'other'; noticeDigest: string; noticeReceivedAt: string;
  };
}
export interface ReportResult {
  reportId: string; caseId: string; caseGeneration: string; evidenceDigest: string; replayed: boolean;
  evidence: Array<{ ordinal: number; owner: string; resource: string; component: string; revision: string | null;
    revisionDigest: string | null; state: EvidenceState }>;
}

export interface DecisionTargetInput {
  owner: GovernanceOwner; resource: string; component: GovernanceComponent; locator: string | null;
  scopeKind: 'exact_revision' | 'component'; revision: string | null; expectedHead: string | null;
  effect: EnforcementEffect;
  expiresAt?: string | null;
}
export interface StatementOfReasons {
  facts: string;
  scope: string;
  duration: string;
  automation: boolean;
  appealRoute: '/v1/public-reports/{caseId}/correspondence';
  contentLanguage: string;
}
export interface DecisionInput {
  caseId: string; expectedGeneration: string; actingSubject: string; outcome: DecisionOutcome;
  targets: DecisionTargetInput[]; rule: { ref: string; revision: string; digest: string };
  evidenceDigest: string; reversesDecisionId: string | null; answersStepId: string | null;
  rationale: string | null; disclosure: 'private' | 'parties' | 'public_summary'; idempotencyKey: string;
  reasons?: StatementOfReasons;
}
export interface DecisionResult {
  decisionId: string; caseId: string; caseGeneration: string; outcome: string;
  enforcement: Array<{ owner: string; resource: string; component: string; revision: string | null; effect: string;
    state: 'restricted' | 'released'; fenceEpoch: string }>;
  replayed: boolean;
  operation: OperationOutcome;
}

export interface StepInput {
  caseId: string; decisionId: string; actingSubject: string;
  process: 'platform_appeal' | 'dmca_512' | 'ordinary_dispute'; step: typeof processSteps[number];
  partySubject: string | null; statement: string | null; documentDigest: string | null;
  occurredAt: string; dueAt: string | null; idempotencyKey: string;
}

const restricting = new Set<DecisionOutcome>(['reject', 'restrict', 'interim_restrict', 'final_restrict']);
const releasing = new Set<DecisionOutcome>(['restore', 'reverse']);

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

export function normalizeGovernanceError(error: unknown): Error {
  if (error instanceof GovernanceInvalid || error instanceof GovernanceDenied || error instanceof GovernanceConflict
    || error instanceof GovernanceStale || error instanceof GovernanceUnavailable) return error;
  const code = (error as { code?: string }).code;
  if (code === '23505' || code === '40001' || code === '40P01') return new GovernanceConflict('concurrent governance change');
  if (code === '23514' || code === '23503') return new GovernanceStale('governance basis changed');
  if (code === '55P03' || code === '57014') return new GovernanceUnavailable('governance owner is busy');
  return new GovernanceUnavailable('governance owner is unavailable');
}

function validTarget(target: { owner: string; resource: string; component: string }): boolean {
  return (governanceOwners as readonly string[]).includes(target.owner)
    && (governanceComponents as readonly string[]).includes(target.component)
    && target.resource.length >= 1 && target.resource.length <= 512;
}

/**
 * Access-owned governance cases: reports with exact evidence anchors, one
 * immutable decision chain per case under CAS, explicit decision targets, the
 * effective enforcement fence and its outbox fact, and process steps.
 */
export class GovernanceStore {
  readonly disclosure: DisclosureStore;
  constructor(private readonly pool: Pool, private readonly evidence: EvidenceCapture,
    private readonly heads: TargetHeads, private readonly rules: RuleBasis,
    private readonly effects?: ModerationEffects, private readonly reviews?: ReviewReportOwner,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.disclosure = new DisclosureStore(pool);
    configureDisclosurePool(pool, this.disclosure);
    this.safety = new SafetyQueue(
      pool,
      (client, principal, actor, action, lock = true) =>
        this.decider(client, principal, actor, 'governance:platform', action, lock),
      clock,
    );
  }

  readonly safety: SafetyQueue;

  /** Trusted media owner intake, never a public route. The durable screen job
   * identifies one report across retries; automation is disclosed as evidence. */
  async openScreeningCase(input: import('../media-screen/store.ts').ScreenReview): Promise<string> {
    if (![input.job, input.asset, input.source].every(value => uuidPattern.test(value))
      || !digestPattern.test(input.digest) || input.verdict.clearance !== 'held'
      || !['likely-explicit', 'screen-unavailable'].includes(input.verdict.reason ?? '')) {
      throw new GovernanceInvalid('invalid automated media evidence');
    }
    const resource = `https://rezics.com/id/${input.asset}`;
    const request = sha256(canonical(input));
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`media-screen:${input.job}`]);
      const previous = (await client.query<{ case_id: string; request_digest: string }>(
        'SELECT case_id, request_digest FROM access.governance_report WHERE id = $1', [input.job])).rows[0];
      if (previous) {
        if (previous.request_digest !== request) throw new GovernanceConflict('screen job binds other evidence');
        return previous.case_id;
      }
      const gate = await client.query("SELECT 1 FROM access.scope_gate WHERE id = 'governance:platform' AND open FOR SHARE");
      if (!gate.rowCount) throw new GovernanceUnavailable('platform review intake is held');
      await client.query(`INSERT INTO access.governance_case (id, kind, authority_kind, authority_scope_id,
        context, target_owner, target_resource, target_component, disclosure, urgent)
        VALUES ($1,'content_report','platform','governance:platform',$2,'media',$3,'record','private',$4)
        ON CONFLICT DO NOTHING`, [randomUUID(), GLOBAL_CONTEXT, resource, input.verdict.reason === 'likely-explicit']);
      const caseRow = (await client.query<{ id: string }>(`SELECT id FROM access.governance_case
        WHERE target_owner = 'media' AND target_resource = $1 AND target_component = 'record'
          AND authority_scope_id = 'governance:platform' AND context = $2 AND kind = 'content_report'
          AND state = 'open' FOR UPDATE`, [resource, GLOBAL_CONTEXT])).rows[0];
      if (!caseRow) throw new GovernanceStale('screen case closed concurrently');
      if (input.verdict.reason === 'likely-explicit') {
        await client.query('UPDATE access.governance_case SET urgent = true WHERE id = $1 AND NOT urgent', [caseRow.id]);
      }
      const provenance = { automation: 'local-image-screen', reason: input.verdict.reason, ...input.verdict.evidence };
      const evidenceDigest = sha256(canonical({ representation: input.source, digest: input.digest, provenance }));
      await client.query(`INSERT INTO access.governance_report (id, case_id, idempotency_key, request_digest,
        reason_code, statement, evidence_count, evidence_digest, process, declarations)
        VALUES ($1,$2,$3,$4,'explicit_imagery','Automated local image screening; requires staff review.',
          1,$5,'platform_rules',$6)`, [input.job, caseRow.id, `media-screen:${input.job}`, request,
        evidenceDigest, { automation: true, category: 'explicit_imagery' }]);
      await client.query(`INSERT INTO access.governance_evidence (report_id, ordinal, owner, resource, component,
        locator, revision, representation, revision_digest, state, provenance)
        VALUES ($1,1,'media',$2,'record',$3,$3,$3,$4,'available',$5)`,
      [input.job, resource, input.source, input.digest, provenance]);
      return caseRow.id;
    });
  }

  /** `read` work writes nothing; see controlRead for its asynchronous commit. */
  private async transaction<T>(work: (client: PoolClient) => Promise<T>, read = false): Promise<T> {
    const client = await this.pool.connect().catch(() => {
      throw new GovernanceUnavailable('governance owner is unavailable');
    });
    try {
      await client.query(read ? 'BEGIN; SET LOCAL synchronous_commit = off' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const fence = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (fence.rows[0]?.open !== true) throw new GovernanceUnavailable('Access is held for recovery');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await rollback(client);
      throw normalizeGovernanceError(error);
    } finally { client.release(); }
  }

  /** Active principal that currently represents the acting Agent. */
  private async represented(client: PoolClient, principal: VerifiedPrincipal, actingSubject: string):
    Promise<{ principalId: string; epoch: string }> {
    const row = (await client.query<{ id: string; enforcement_epoch: string }>(`SELECT p.id,
        p.enforcement_epoch::text FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active AND r.subject_id = $3 AND r.active
        AND r.valid_until > clock_timestamp() AND s.active
      LIMIT 1 FOR SHARE OF p, r, s`, [principal.issuer, principal.subject, actingSubject])).rows[0];
    if (!row) throw new GovernanceDenied('acting Agent is not represented by the caller');
    return { principalId: row.id, epoch: row.enforcement_epoch };
  }

  /** Decider authority: an active Access grant for the case kind's action on its scope gate. */
  private async decider(client: PoolClient, principal: VerifiedPrincipal, actingSubject: string, scopeId: string,
    action: string, lock = true): Promise<{ principalId: string; authorityEpoch: string; proofDigest: string }> {
    // Writers lock one authority basis. Queue reads use their repeatable-read
    // snapshot without locks; the administrator fallback shares that choice.
    const basis = (await client.query<{ id: string; enforcement_epoch: string;
      authority_epoch: string; open: boolean; dispatch_open: boolean }>(`SELECT p.id,
        p.enforcement_epoch::text, gate.authority_epoch::text, gate.open, gate.dispatch_open
      FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      JOIN access.scope_gate gate ON gate.id = $4
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active AND r.subject_id = $3 AND r.active
        AND r.valid_until > clock_timestamp() AND s.active
      LIMIT 1${lock ? ' FOR SHARE OF p, r, s, gate' : ''}`, [principal.issuer, principal.subject, actingSubject, scopeId])).rows[0];
    if (!basis?.open || !basis.dispatch_open) throw new GovernanceDenied('governance scope is closed or actor is not represented');
    const actor = { principalId: basis.id, epoch: basis.enforcement_epoch };
    const gate = basis;
    if (scopeId === 'governance:platform'
      && ['governance.moderate', 'governance.rights.decide', 'governance.safety.evidence', 'governance.appeal'].includes(action)) {
      const administrator = await platformAdministratorProof(client, actor.principalId, actingSubject, lock,{ action,scope: scopeId });
      if (administrator) return { principalId: actor.principalId, authorityEpoch: gate.authority_epoch,
        proofDigest: sha256(canonical({ principalId: actor.principalId, actingSubject, scopeId, action,
          authorityEpoch: gate.authority_epoch, administrator })) };
    }
    const grant = (await client.query<{ id: string; generation: string }>(`SELECT g.id, g.generation::text
      FROM access.permission_grant g JOIN access.representation r ON r.principal_id = $4
        AND r.subject_id = $1 AND r.action IN ($3,'agent.control') AND r.active AND r.valid_until > clock_timestamp()
      WHERE g.recipient_subject = $1 AND g.scope_id = $2 AND g.action = $3 AND g.active
        AND g.valid_until > clock_timestamp() AND (g.membership_id IS NULL OR EXISTS (
          SELECT 1 FROM access.membership m WHERE m.id = g.membership_id AND m.state = 'joined'
            AND m.generation = g.membership_generation)) ORDER BY g.valid_until DESC,g.id LIMIT 1${lock ? ' FOR SHARE OF g,r' : ''}`,
    [actingSubject, scopeId, action, actor.principalId])).rows[0];
    if (!grant) throw new GovernanceDenied('governance decision authority is missing');
    return { principalId: actor.principalId, authorityEpoch: gate.authority_epoch,
      proofDigest: sha256(canonical({ principalId: actor.principalId, principalEpoch: actor.epoch, actingSubject,
        scopeId, action, grantId: grant.id, grantGeneration: grant.generation, authorityEpoch: gate.authority_epoch })) };
  }

  async submitReport(principal: VerifiedPrincipal, input: ReportInput): Promise<ReportResult> {
    if (!agentPattern.test(input.actingSubject) || !validTarget(input.target) || !keyPattern.test(input.idempotencyKey)
      || !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.reasonCode)
      || (input.statement !== null && (input.statement.length < 1 || input.statement.length > 4000))
      || input.evidence.length < 1 || input.evidence.length > GOVERNANCE_LIMITS.evidence
      || !input.evidence.every(item => validTarget(item))
      || (input.kind === 'rights_complaint') !== (input.complaint !== undefined)
      || (input.complaint && !digestPattern.test(input.complaint.noticeDigest))) {
      throw new GovernanceInvalid('report does not match its profile');
    }
    const request = sha256(canonical({ ...input, idempotencyKey: undefined }));
    const replay = await this.replayReport(principal, input.idempotencyKey, request);
    if (replay) return replay;
    if (input.authority.kind === 'realm'
      && (!agentPattern.test(input.context)
        || input.authority.scopeId !== `governance:realm:${input.context}`)) {
      throw new GovernanceInvalid('Realm report scope must match its context');
    }
    // Capture happens before the write, while the reporter is authorized; the
    // write rechecks representation so a revoked reporter cannot commit.
    const captured: CapturedEvidence[] = [];
    for (const target of input.evidence) {
      const evidence = await this.evidence.capture(principal, input.actingSubject, target);
      if (target.owner === 'review' && ![GLOBAL_CONTEXT, evidence.provenance.context,
        evidence.provenance.realm].includes(input.context)) {
        throw new GovernanceInvalid('review report context does not match its rating Context');
      }
      captured.push(evidence);
    }
    const evidenceDigest = sha256(canonical(captured.map(item => [item.owner, item.resource, item.component,
      item.locator, item.revision, item.revisionDigest, item.state])));
    return this.transaction(async client => {
      const actor = await this.represented(client, principal, input.actingSubject);
      const prior = await this.receipt(client, actor.principalId, input.idempotencyKey);
      if (prior) {
        if (prior.request_digest !== request) throw new GovernanceConflict('idempotency key reused');
        return this.reportResult(client, prior.id, true);
      }
      const gate = await client.query('SELECT 1 FROM access.scope_gate WHERE id = $1 AND open', [input.authority.scopeId]);
      if (!gate.rows[0]) throw new GovernanceDenied('governance scope is closed');
      await client.query(`INSERT INTO access.governance_case (id, kind, authority_kind, authority_scope_id, context,
          target_owner, target_resource, target_component, disclosure)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [randomUUID(), input.kind, input.authority.kind, input.authority.scopeId, input.context, input.target.owner,
        input.target.resource, input.target.component, input.disclosure]);
      const caseRow = (await client.query<{ id: string }>(`SELECT id FROM access.governance_case
        WHERE target_owner = $1 AND target_resource = $2 AND target_component = $3 AND context = $4
          AND authority_scope_id = $5 AND kind = $6 AND state = 'open' FOR SHARE`,
      [input.target.owner, input.target.resource, input.target.component, input.context, input.authority.scopeId,
        input.kind])).rows[0];
      if (!caseRow) throw new GovernanceStale('case closed concurrently');
      const reportId = randomUUID();
      await client.query(`INSERT INTO access.governance_report (id, case_id, principal_id, acting_subject,
          principal_epoch, idempotency_key, request_digest, reason_code, statement, evidence_count, evidence_digest)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [reportId, caseRow.id, actor.principalId, input.actingSubject, actor.epoch, input.idempotencyKey, request,
        input.reasonCode, input.statement, captured.length, evidenceDigest]);
      for (const [index, item] of captured.entries()) {
        await client.query(`INSERT INTO access.governance_evidence (report_id, ordinal, owner, resource, component,
            locator, revision, representation, revision_digest, state, provenance)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [reportId, index + 1, item.owner, item.resource, item.component, item.locator, item.revision,
          item.representation, item.revisionDigest, item.state, item.provenance]);
      }
      if (input.complaint) {
        const c = input.complaint;
        await client.query(`INSERT INTO access.rights_complaint (report_id, case_id, process, claimant_kind,
            claimant_name, claimant_contact, claimed_work, claimed_right, notice_digest, notice_received_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [reportId, caseRow.id, c.process, c.claimantKind, c.claimantName, c.claimantContact, c.claimedWork,
          c.claimedRight, c.noticeDigest, c.noticeReceivedAt]);
      }
      return this.reportResult(client, reportId, false);
    });
  }

  private async receipt(client: PoolClient, principalId: string, key: string) {
    return (await client.query<{ id: string; request_digest: string }>(`SELECT id, request_digest
      FROM access.governance_report WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
  }

  private async replayReport(principal: VerifiedPrincipal, key: string, request: string): Promise<ReportResult | null> {
    return this.transaction(async client => {
      const row = (await client.query<{ id: string; request_digest: string }>(`SELECT r.id, r.request_digest
        FROM access.governance_report r JOIN access.principal p ON p.id = r.principal_id
        WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active AND r.idempotency_key = $3`,
      [principal.issuer, principal.subject, key])).rows[0];
      if (!row) return null;
      if (row.request_digest !== request) throw new GovernanceConflict('idempotency key reused');
      return this.reportResult(client, row.id, true);
    });
  }

  private async reportResult(client: PoolClient, reportId: string, replayed: boolean,
    specialistRead = false): Promise<ReportResult> {
    const report = (await client.query<{ case_id: string; generation: string; evidence_digest: string; urgent: boolean }>(
      `SELECT r.case_id, c.generation::text, r.evidence_digest, c.urgent FROM access.governance_report r
       JOIN access.governance_case c ON c.id = r.case_id WHERE r.id = $1 FOR SHARE OF c`, [reportId])).rows[0]!;
    const evidence = report.urgent && !specialistRead ? [] : (await client.query<{ ordinal: number; owner: string; resource: string; component: string;
      revision: string | null; revision_digest: string | null; state: EvidenceState }>(`SELECT ordinal, owner,
        resource, component, revision, revision_digest, state FROM access.governance_evidence
      WHERE report_id = $1 ORDER BY ordinal`, [reportId])).rows;
    return { reportId, caseId: report.case_id, caseGeneration: report.generation,
      evidenceDigest: report.evidence_digest, replayed,
      evidence: evidence.map(row => ({ ordinal: row.ordinal, owner: row.owner, resource: row.resource,
        component: row.component, revision: row.revision, revisionDigest: row.revision_digest, state: row.state })) };
  }

  /**
   * The reporter, or a decider for the case scope, reads the report with its
   * exact evidence anchors and the current case state. Anyone else gets 404.
   */
  async readReport(principal: VerifiedPrincipal, reportId: string, actingSubject: string | null):
    Promise<ReportResult & { caseState: string; decisionHead: string | null }> {
    if (!uuidPattern.test(reportId) || (actingSubject !== null && !agentPattern.test(actingSubject))) {
      throw new GovernanceInvalid('invalid report read');
    }
    return this.transaction(async client => {
      const row = (await client.query<{ reporter_issuer: string; reporter_subject: string;
        reporter_active: boolean; scope: string;
        kind: 'content_report' | 'rights_complaint'; state: string; decision_head: string | null; urgent: boolean }>(`SELECT
          p.account_issuer AS reporter_issuer, p.account_subject AS reporter_subject, p.active AS reporter_active,
          c.authority_scope_id AS scope,
          c.kind, c.state, c.decision_head, c.urgent FROM access.governance_report r
        LEFT JOIN access.principal p ON p.id = r.principal_id JOIN access.governance_case c ON c.id = r.case_id
        WHERE r.id = $1 FOR SHARE OF c`, [reportId])).rows[0];
      if (!row) throw new GovernanceDenied('report is unavailable');
      const own = row.reporter_active && row.reporter_issuer === principal.issuer
        && row.reporter_subject === principal.subject;
      if (!own || row.urgent) {
        if (!actingSubject) throw new GovernanceDenied('report is unavailable');
        await this.decider(client, principal, actingSubject, row.scope,
          row.urgent ? 'governance.safety.evidence' : DECIDE_ACTION[row.kind])
          .catch(() => { throw new GovernanceDenied('report is unavailable'); });
      }
      return { ...await this.reportResult(client, reportId, false, row.urgent), caseState: row.state,
        decisionHead: row.decision_head };
    });
  }

  /**
   * Append the next decision to a case under CAS on its generation. Target
   * heads and the rule basis are re-read from their owners first; any change
   * since review is stale and nothing is written. Restricting outcomes advance
   * each target's enforcement fence; reverse and restore release only the
   * reversed decision's own targets.
   */
  async decide(principal: VerifiedPrincipal, input: DecisionInput,
    deferEffects = false,
  ): Promise<DecisionResult> {
    if (!uuidPattern.test(input.caseId) || !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedGeneration)
      || !agentPattern.test(input.actingSubject) || !(decisionOutcomes as readonly string[]).includes(input.outcome)
      || input.outcome === 'reject' || !keyPattern.test(input.idempotencyKey)
      || input.targets.length > GOVERNANCE_LIMITS.targets || !digestPattern.test(input.evidenceDigest)
      || !digestPattern.test(input.rule.digest) || input.rule.ref.length < 1 || input.rule.ref.length > 512
      || input.rule.revision.length < 1 || input.rule.revision.length > 512
      || (input.answersStepId !== null && !uuidPattern.test(input.answersStepId))
      || (input.outcome === 'reverse') !== (input.reversesDecisionId !== null)
      || (input.outcome !== 'dismiss' && input.targets.length === 0)
      || !input.targets.every(target => validTarget(target)
        && (enforcementEffects as readonly string[]).includes(target.effect)
        && (target.scopeKind === 'exact_revision') === (target.revision !== null))) {
      throw new GovernanceInvalid('decision does not match its profile');
    }
    if (
      input.reasons &&
      (![input.reasons.facts, input.reasons.scope, input.reasons.duration].every(
        (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000,
      ) ||
        typeof input.reasons.automation !== 'boolean' ||
        input.reasons.appealRoute !== '/v1/public-reports/{caseId}/correspondence' ||
        !validContentLanguage(input.reasons.contentLanguage))
    )
      throw new GovernanceInvalid('invalid statement of reasons');
    if (
      input.targets.some((target) => target.expiresAt && Number.isNaN(Date.parse(target.expiresAt)))
    ) {
      throw new GovernanceInvalid('invalid restriction expiry');
    }
    const request = sha256(canonical({ ...input, idempotencyKey: undefined }));
    // Do not expose rule or target-head changes to a caller lacking this case's
    // current decision authority. The write transaction checks it again.
    const caseScope = await this.transaction(async client => {
      const row = (await client.query<{ kind: 'content_report' | 'rights_complaint'; scope: string; urgent: boolean }>(
        `SELECT kind, authority_scope_id AS scope, urgent FROM access.governance_case WHERE id = $1`,
      [input.caseId])).rows[0];
      if (!row) throw new GovernanceDenied('case is unavailable');
      await this.decider(client, principal, input.actingSubject, row.scope, DECIDE_ACTION[row.kind]);
      if (row.urgent) await this.decider(client, principal, input.actingSubject, row.scope,
        'governance.safety.evidence');
      return row.scope;
    });
    const existing = await this.replayDecision(principal, input, request);
    if (existing)
      return this.resumeDecision(principal, input.actingSubject, existing.decisionId, true);
    // Owner reads happen before the transaction; the transaction compares them with the reviewed basis.
    const rule = await this.rules.current(input.rule.ref, caseScope);
    if (!rule || rule.revision !== input.rule.revision || rule.digest !== input.rule.digest) {
      const replay = await this.replayDecision(principal, input, request);
      if (replay) return replay;
      throw new GovernanceStale('rule revision changed since review');
    }
    for (const target of input.targets) {
      const head = await this.heads.current(target);
      if (head !== target.expectedHead) {
        const replay = await this.replayDecision(principal, input, request);
        if (replay) return replay;
        throw new GovernanceStale('target changed since review');
      }
    }
    const planned = await this.transaction(async client => {
      const caseRow = (await client.query<{ id: string; kind: 'content_report' | 'rights_complaint';
        authority_kind: string; authority_scope_id: string; context: string; generation: string; state: string;
          urgent: boolean;
        }>(
        `SELECT id, kind, authority_kind, authority_scope_id, context, generation::text, state, urgent
         FROM access.governance_case WHERE id = $1 FOR UPDATE`, [input.caseId])).rows[0];
      if (!caseRow) throw new GovernanceDenied('case is unavailable');
      if (caseRow.urgent)
        await this.decider(
          client,
          principal,
          input.actingSubject,
          caseRow.authority_scope_id,
          'governance.safety.evidence',
        );
      if (caseRow.authority_kind === 'platform') {
        if (!input.reasons)
          throw new GovernanceInvalid('platform decisions require a statement of reasons');
        const claim = (
          await client.query<{ principal_id: string; acting_subject: string }>(
            `SELECT principal_id, acting_subject FROM access.safety_case_claim
             WHERE case_id = $1 AND case_generation = $2 AND expires_at > $3`,
            [caseRow.id, caseRow.generation, this.clock()],
          )
        ).rows[0];
        const actor = await this.represented(client, principal, input.actingSubject);
        if (
          !claim ||
          claim.principal_id !== actor.principalId ||
          claim.acting_subject !== input.actingSubject
        ) {
          throw new GovernanceDenied('claim the case before deciding');
        }
      }
      if (
        (
          await client.query(
            `SELECT 1 FROM access.safety_decision_operation o
        JOIN access.safety_decision_effect e ON e.decision_id = o.decision_id
        WHERE o.decision_id = (SELECT decision_head FROM access.governance_case WHERE id = $1)
        AND NOT o.cancelled AND e.state <> 'confirmed' LIMIT 1`,
            [caseRow.id],
          )
        ).rowCount
      ) {
        throw new GovernanceStale('resume or cancel the pending decision before reconsidering');
      }
      if (releasing.has(input.outcome)) {
        const dmca = (
          await client.query(
            "SELECT 1 FROM access.governance_report r WHERE r.case_id = $1 AND (r.process = 'dmca_512' OR EXISTS (SELECT 1 FROM access.rights_complaint c WHERE c.report_id = r.id AND c.process = 'dmca_512')) LIMIT 1",
            [caseRow.id],
          )
        ).rowCount;
        if (dmca) {
          const window = (
            await client.query<{ earliest: Date | null; action: boolean }>(
              `SELECT
            max(due_at) FILTER (WHERE step = 'restoration_not_before') AS earliest,
            bool_or(step = 'claimant_action') AS action FROM access.governance_process_step
            WHERE case_id = $1 AND process = 'dmca_512'`,
              [caseRow.id],
            )
          ).rows[0]!;
          const now = this.clock();
          if (
            !window.earliest ||
            now < window.earliest ||
            window.action
          ) {
            throw new GovernanceStale(
              'DMCA restoration is before the earliest date or stayed by claimant action',
            );
          }
        }
      }
      const kind = caseRow.kind === 'rights_complaint' ? 'rights_disposition' : 'content_moderation';
      const allowed: readonly DecisionOutcome[] = kind === 'rights_disposition'
        ? ['interim_restrict', 'final_restrict', 'dismiss', 'restore', 'reverse']
        : ['restrict', 'dismiss', 'restore', 'reverse'];
      if (!allowed.includes(input.outcome)) throw new GovernanceInvalid('outcome does not apply to this case kind');
      if (kind === 'rights_disposition' && input.outcome === 'restore') {
        const step = input.answersStepId && (await client.query<{ step: string }>(`SELECT step
          FROM access.governance_process_step WHERE id = $1 AND case_id = $2`,
        [input.answersStepId, caseRow.id])).rows[0];
        if (!step || !['counter_notice', 'appeal', 'restoration_window'].includes(step.step)) {
          throw new GovernanceInvalid('rights restoration must answer a recorded process step');
        }
      }
      const authority = await this.decider(client, principal, input.actingSubject, caseRow.authority_scope_id,
        DECIDE_ACTION[caseRow.kind]);
      // The rule publisher locks the same head for update. Hold this share
      // lock through the decision commit so a concurrent revision cannot slip
      // between review and the Access enforcement fence.
      const heldRule = await this.rules.current(input.rule.ref, caseRow.authority_scope_id, client);
      if (!heldRule || heldRule.revision !== input.rule.revision || heldRule.digest !== input.rule.digest) {
        throw new GovernanceStale('rule revision changed since review');
      }
      const prior = (await client.query<{ id: string; request_digest: string }>(`SELECT id, request_digest
        FROM access.moderation_decision WHERE principal_id = $1 AND kind = $2 AND idempotency_key = $3`,
      [authority.principalId, kind, input.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== request) throw new GovernanceConflict('idempotency key reused');
        return this.decisionResult(client, prior.id, true);
      }
      if (caseRow.state !== 'open' || caseRow.generation !== input.expectedGeneration) {
        throw new GovernanceStale('case changed since review');
      }
      // The reviewed evidence must be exactly the case's retained evidence set.
      const retained = (await client.query<{ digest: string }>(`SELECT evidence_digest AS digest
        FROM access.governance_report WHERE case_id = $1`, [caseRow.id])).rows.map(row => row.digest);
      if (!retained.includes(input.evidenceDigest)) throw new GovernanceStale('evidence basis is not retained');
      if (
        input.reasons?.automation === false &&
        (
          await client.query(
            `SELECT 1 FROM access.governance_evidence e
        JOIN access.governance_report r ON r.id = e.report_id WHERE r.case_id = $1
        AND e.provenance ? 'automation' LIMIT 1`,
            [caseRow.id],
          )
        ).rowCount
      ) {
        throw new GovernanceInvalid('reasons must disclose retained automation involvement');
      }
      const identities = input.targets.map((target) =>
        canonical({ ...target, expectedHead: undefined, expiresAt: undefined }),
      );
      if (new Set(identities).size !== identities.length)
        throw new GovernanceInvalid('decision targets must be distinct');
      const admittedTargets = (await client.query<{ owner: GovernanceOwner; resource: string; component: GovernanceComponent;
        locator: string | null; revision: string | null; state: EvidenceState;
        }>(`SELECT DISTINCT e.owner,
          e.resource, e.component, e.locator, e.revision, e.state FROM access.governance_evidence e
        JOIN access.governance_report r ON r.id = e.report_id WHERE r.case_id = $1`,
      [caseRow.id])).rows;
      for (const target of input.targets) {
        if (!admittedTargets.some(evidence => evidence.owner === target.owner
          && evidence.resource === target.resource && evidence.component === target.component
          && evidence.locator === target.locator
          && (!restricting.has(input.outcome) || evidence.state === 'available')
          && (target.scopeKind === 'component' || evidence.revision === target.revision))) {
          throw new GovernanceDenied('decision target is outside the reported evidence');
        }
      }
      if (input.reversesDecisionId) {
        const reversed = (await client.query<{ outcome: DecisionOutcome }>(`SELECT outcome
          FROM access.moderation_decision WHERE id = $1 AND case_id = $2`, [input.reversesDecisionId, caseRow.id])).rows[0];
        if (!reversed || !restricting.has(reversed.outcome)) throw new GovernanceStale('nothing to reverse');
        const original = (await client.query<{ owner: string; resource: string; component: string;
          locator: string | null; scope_kind: string; revision: string | null; effect: string }>(
          `SELECT owner, resource, component, locator, scope_kind, revision, effect
           FROM access.moderation_decision_target t WHERE decision_id = $1
             AND (NOT EXISTS (SELECT 1 FROM access.safety_decision_operation o WHERE o.decision_id = t.decision_id)
               OR EXISTS (SELECT 1 FROM access.safety_decision_effect e WHERE e.decision_id = t.decision_id
                 AND e.ordinal = t.ordinal AND e.state = 'confirmed'))`, [input.reversesDecisionId])).rows;
        const same = (a: (typeof original)[number], b: DecisionTargetInput) => a.owner === b.owner
          && a.resource === b.resource && a.component === b.component && a.locator === b.locator
          && a.scope_kind === b.scopeKind && a.revision === b.revision && a.effect === b.effect;
        if (original.length !== input.targets.length
          || original.some(target => !input.targets.some(candidate => same(target, candidate)))) {
          throw new GovernanceStale('reversal does not match the original targets');
        }
      }
      // The first owner read is review preflight. Re-read each bounded target
      // after the Access case/rule locks are held so a target that changed
      // between preflight and this transaction cannot receive a stale fence.
      // Target writers remain authoritative for their own state; this check
      // rejects a basis that changed before the decision writes begin.
      for (const target of input.targets) {
        if (await this.heads.current(target) !== target.expectedHead) {
          throw new GovernanceStale('target changed since review');
        }
        if (target.owner === 'review') {
          if (!this.reviews) throw new GovernanceUnavailable('review moderation owner is unavailable');
          await this.reviews.lockCurrent(client, target);
        }
      }
      const reviewVisibility = new Map<string, boolean>();
      for (const target of input.targets) {
        if (target.owner === 'review' && !reviewVisibility.has(target.resource)) {
          reviewVisibility.set(target.resource, await this.reviews!.visible(client, target.resource));
        }
      }
      const ncii = !!(
        await client.query(
          "SELECT 1 FROM access.governance_report WHERE case_id = $1 AND reason_code = 'ncii' LIMIT 1",
          [caseRow.id],
        )
      ).rowCount;
      let appealUpheld = false;
      if (ncii && releasing.has(input.outcome)) {
        appealUpheld = input.outcome === 'reverse' && input.reversesDecisionId !== null
          && input.answersStepId !== null && !!(await client.query(
            "SELECT 1 FROM access.governance_process_step WHERE id = $1 AND case_id = $2 AND step = 'appeal'",
            [input.answersStepId, caseRow.id])).rowCount;
        if (!appealUpheld)
          throw new GovernanceInvalid('NCII restoration must answer an upheld appeal');
      }
      const decisionId = randomUUID();
      const plans: import('./effects.ts').EffectPlan[] = [];
      for (const target of input.targets) {
        if (
          restricting.has(input.outcome) &&
          ['participation', 'capability'].includes(target.effect) &&
          (!target.expiresAt || new Date(target.expiresAt) <= this.clock())
        ) {
          throw new GovernanceInvalid('participation restrictions require a future expiry');
        }
        const plan = (await this.effects?.plan?.(target, input.outcome, {
          caseId: caseRow.id, decisionId, reversesDecisionId: input.reversesDecisionId,
          ncii, appealUpheld,
        })) ?? {};
        if (ncii && plan.media) plan.ncii = true;
        if (['participation', 'capability'].includes(target.effect) && !plan.participant) {
          throw new GovernanceInvalid('reported target has no participation owner');
        }
        plans.push(plan);
      }
      const sequence = (BigInt(caseRow.generation) + 1n).toString();
      await client.query(`INSERT INTO access.moderation_decision (id, kind, outcome, context, case_id, case_sequence,
          reverses_decision_id, principal_id, acting_subject, authority_kind, authority_scope_id, authority_epoch,
          authority_proof_digest, idempotency_key, request_digest, rule_ref, rule_revision, rule_digest,
          evidence_digest, rationale, disclosure, answers_step_id, statement_of_reasons)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [decisionId, kind, input.outcome, caseRow.context, caseRow.id, sequence, input.reversesDecisionId,
        authority.principalId, input.actingSubject, caseRow.authority_kind, caseRow.authority_scope_id,
        authority.authorityEpoch, authority.proofDigest, input.idempotencyKey, request, input.rule.ref,
        input.rule.revision, input.rule.digest, input.evidenceDigest, input.rationale, input.disclosure,
        input.answersStepId,
          input.reasons ? { ...input.reasons, rule: input.rule } : null,
        ],
      );
      await client.query('INSERT INTO access.safety_decision_operation (decision_id) VALUES ($1)', [
        decisionId,
      ]);
      for (const [index, target] of input.targets.entries()) {
        await client.query(`INSERT INTO access.moderation_decision_target (decision_id, ordinal, owner, resource,
            component, locator, scope_kind, revision, expected_head, effect, expires_at, participant_subject)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [decisionId, index + 1, target.owner, target.resource, target.component, target.locator, target.scopeKind,
          target.revision, target.expectedHead, target.effect,
            target.expiresAt ?? null,
            plans[index]?.participant ?? null,
          ]);
        await client.query(
          `INSERT INTO access.safety_decision_effect (decision_id,ordinal,plan)
          VALUES ($1,$2,$3)`,
          [decisionId, index + 1, plans[index]],
        );
      }
      if (input.reasons) {
        if (!plans.length && admittedTargets[0]) {
          const evidence = admittedTargets[0];
          const noticePlan = await this.effects?.plan?.(
            {
              ...evidence,
              scopeKind: evidence.revision ? 'exact_revision' : 'component',
              expectedHead: evidence.revision,
              effect: 'disclosure',
            },
            input.outcome,
          );
          if (noticePlan) plans.push(noticePlan);
        }
        const authors = [
          ...new Set(
            plans.map((plan) => plan.participant).filter((item): item is string => !!item),
          ),
        ];
        const report = (await client.query<{ id: string }>(
            'SELECT id FROM access.governance_report WHERE case_id = $1 ORDER BY received_at,id LIMIT 1',
            [caseRow.id])).rows[0]!;
        const parties = (await client.query<{ id: string }>(
            `SELECT DISTINCT p.id FROM access.principal p
          WHERE p.active AND (p.id IN (SELECT principal_id FROM access.agent_provision WHERE agent_id = ANY($1::text[]))
            OR p.id IN (SELECT principal_id FROM access.representation WHERE subject_id = ANY($1::text[])
              AND active AND valid_until > clock_timestamp()))`,
            [authors],
          )).rows;
        for (const party of parties) {
          const credential = await mintPartyCredential(client, caseRow.id, report.id);
          await client.query(`INSERT INTO access.safety_party_notice
            (id,decision_id,principal_id,case_id,credential,statement_of_reasons) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
              Bun.randomUUIDv7(),
              decisionId,
              party.id,
              caseRow.id,
              credential,
              { ...input.reasons, rule: input.rule },
            ]);
        }
      }
      await client.query(`UPDATE access.governance_case SET decision_head = $2, generation = $3 WHERE id = $1`,
        [caseRow.id, decisionId, sequence]);
      // Empty decisions are complete on acceptance. Other decision facts are
      // published with the last receipt, so consumers cannot infer application
      // from an accepted plan.
      if (!input.targets.length) await client.query(`INSERT INTO access.outbox (id, kind, scope_id, authority_epoch, moderation_decision_id)
        VALUES ($1, 'moderation.decided', $2, $3, $4)`,
      [randomUUID(), caseRow.authority_scope_id, authority.authorityEpoch, decisionId]);
      return this.decisionResult(client, decisionId, false);
    });
    return deferEffects
      ? planned
      : this.resumeDecision(principal, input.actingSubject, planned.decisionId, planned.replayed);
  }

  private async replayDecision(principal: VerifiedPrincipal, input: DecisionInput, request: string):
    Promise<DecisionResult | null> {
    return this.transaction(async client => {
      const row = (await client.query<{ id: string; request_digest: string }>(`SELECT d.id, d.request_digest
        FROM access.moderation_decision d JOIN access.principal p ON p.id = d.principal_id
        WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
          AND d.case_id = $3 AND d.idempotency_key = $4`,
      [principal.issuer, principal.subject, input.caseId, input.idempotencyKey])).rows[0];
      if (!row) return null;
      if (row.request_digest !== request) throw new GovernanceConflict('idempotency key reused');
      return this.decisionResult(client, row.id, true);
    });
  }

  private async decisionResult(client: PoolClient, decisionId: string, replayed: boolean): Promise<DecisionResult> {
    const decision = (await client.query<{ case_id: string; case_sequence: string; outcome: string }>(
      `SELECT case_id, case_sequence::text, outcome FROM access.moderation_decision WHERE id = $1`, [decisionId])).rows[0]!;
    const enforcement = (await client.query<{ owner: string; resource: string; component: string;
      revision: string | null; effect: string; state: 'restricted' | 'released'; fence_epoch: string }>(`SELECT
        e.owner, e.resource, e.component, e.revision, e.effect, e.state, e.fence_epoch::text
      FROM access.moderation_decision_target t JOIN access.moderation_decision d ON d.id = t.decision_id
      JOIN access.governance_enforcement e ON e.owner = t.owner AND e.resource = t.resource
        AND e.component = t.component AND e.revision IS NOT DISTINCT FROM t.revision AND e.effect = t.effect
        AND e.context = d.context AND e.authority_scope_id = d.authority_scope_id
      WHERE t.decision_id = $1 ORDER BY t.ordinal`, [decisionId])).rows;
    return { decisionId, caseId: decision.case_id, caseGeneration: decision.case_sequence, outcome: decision.outcome,
      replayed,
      operation: await this.operationResult(client, decisionId),
      enforcement: enforcement.map((row) => ({ owner: row.owner, resource: row.resource,
        component: row.component, revision: row.revision, effect: row.effect, state: row.state,
        fenceEpoch: row.fence_epoch })) };
  }

  async readSafetyCase(
    principal: VerifiedPrincipal,
    actor: string,
    caseId: string,
    reportCursor?: string,
    stepCursor?: string,
  ) {
    return this.transaction(async client => {
      const row = (
        await client.query<{
          kind: 'content_report' | 'rights_complaint';
          urgent: boolean;
          decision_head: string | null;
          generation: string;
          state: string;
        }>(
          `SELECT kind,urgent,decision_head,
        generation::text,state FROM access.governance_case WHERE id = $1 AND authority_kind = 'platform'
        AND authority_scope_id = 'governance:platform' FOR SHARE`,
          [caseId],
        )
      ).rows[0];
      if (!row) throw new GovernanceDenied('case is unavailable');
      await this.decider(client, principal, actor, 'governance:platform', DECIDE_ACTION[row.kind]);
      if (row.urgent)
        await this.decider(
          client,
          principal,
          actor,
          'governance:platform',
          'governance.safety.evidence',
        );
      const reports = (
        await client.query<{ id: string; evidence_digest: string; reason_code: string }>(
          'SELECT id,evidence_digest,reason_code FROM access.governance_report WHERE case_id = $1 AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT 51',
          [caseId, reportCursor ?? null],
        )
      ).rows;
      const steps = (await client.query<{
        id: string; step: string; process: string; report_id: string | null;
        decision_id: string | null; party: string | null; party_subject: string | null;
        statement: string | null; document_digest: string | null; content_language: string | null;
        declarations: Record<string, unknown> | null; occurred_at: Date; due_at: Date | null;
        recorded_at: Date;
      }>(`SELECT id,step,process,report_id,decision_id,party,party_subject,statement,
        document_digest,content_language,declarations,occurred_at,due_at,recorded_at
        FROM access.governance_process_step WHERE case_id = $1
        AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT $3`,
      [caseId, stepCursor ?? null, SAFETY_CASE_READ_COST.page + 1])).rows;
      let decision = null;
      if (row.decision_head) {
        const recorded = (await client.query<{
          statement_of_reasons: (StatementOfReasons & { rule: DecisionInput['rule'] }) | null;
        }>('SELECT statement_of_reasons FROM access.moderation_decision WHERE id = $1',
        [row.decision_head])).rows[0]!;
        decision = {
          ...await this.decisionResult(client, row.decision_head, false),
          statementOfReasons: recorded.statement_of_reasons,
        };
      }
      const targets = row.decision_head
        ? (
            await client.query<{
              owner: string;
              resource: string;
              component: string;
              locator: string | null;
              scope_kind: string;
              revision: string | null;
              expected_head: string | null;
              effect: string;
              expires_at: Date | null;
            }>(
              `SELECT owner,resource,component,locator,
        scope_kind,revision,expected_head,effect,expires_at FROM access.moderation_decision_target
        WHERE decision_id = $1 ORDER BY ordinal`,
              [row.decision_head],
            )
          ).rows
        : [];
      return {
        caseId,
        kind: row.kind,
        urgent: row.urgent,
        generation: row.generation,
        state: row.state,
        reportsNextCursor: reports.length > 50 ? reports[49]!.id : null,
        reports: reports
          .slice(0, 50)
          .map((report) => ({
            reportId: report.id,
            evidenceDigest: report.evidence_digest,
            category: report.reason_code,
          })),
        decision,
        steps: steps.slice(0, SAFETY_CASE_READ_COST.page).map(step => ({
          id: step.id, kind: step.step, process: step.process, reportId: step.report_id,
          decisionId: step.decision_id, party: step.party, partySubject: step.party_subject,
          statement: step.statement, documentDigest: step.document_digest,
          contentLanguage: step.content_language, declarations: step.declarations,
          occurredAt: step.occurred_at.toISOString(), dueAt: step.due_at?.toISOString() ?? null,
          recordedAt: step.recorded_at.toISOString(),
        })),
        stepsNextCursor: steps.length > SAFETY_CASE_READ_COST.page
          ? steps[SAFETY_CASE_READ_COST.page - 1]!.id : null,
        targets: targets.map((target) => ({
          owner: target.owner,
          resource: target.resource,
          component: target.component,
          locator: target.locator,
          scopeKind: target.scope_kind,
          revision: target.revision,
          expectedHead: target.expected_head,
          effect: target.effect,
          expiresAt: target.expires_at?.toISOString() ?? null,
        })),
      };
    });
  }

  private async operationResult(client: PoolClient, decisionId: string): Promise<OperationOutcome> {
    const op = (
      await client.query<{ cancelled: boolean }>(
        'SELECT cancelled FROM access.safety_decision_operation WHERE decision_id = $1',
        [decisionId],
      )
    ).rows[0];
    const items = (
      await client.query<{
        ordinal: number;
        resource: string;
        state: EffectState;
        receipt: string | null;
        continuation: string | null;
        error: string | null;
      }>(
        `SELECT e.ordinal,t.resource,
        e.state,e.receipt,e.continuation,e.error FROM access.safety_decision_effect e
        JOIN access.moderation_decision_target t USING (decision_id,ordinal)
        WHERE e.decision_id = $1 ORDER BY ordinal`,
        [decisionId],
      )
    ).rows;
    return operationOutcome(
      decisionId,
      items.map((item) => ({ ...item, target: item.resource })),
      op?.cancelled,
    );
  }

  /** Each retry holds the operation lock through dispatch and acknowledgement.
   * A crash between owner commit and Access commit leaves an uncertain effect;
   * its owner receipt is reconciled by the same decision/ordinal identity. */
  async resumeDecision(
    principal: VerifiedPrincipal,
    actor: string,
    decisionId: string,
    replayed = true,
  ): Promise<DecisionResult> {
    for (let ordinal = 1; ordinal <= GOVERNANCE_LIMITS.targets; ordinal++) {
      // Persist the uncertainty before dispatch, so a process interruption never
      // presents a possibly committed owner effect as undispatched acceptance.
      await this.transaction(async client => {
        const decision = (
          await client.query<{ authority_scope_id: string; kind: string; urgent: boolean }>(
            `SELECT d.authority_scope_id,d.kind,c.urgent FROM access.moderation_decision d
             JOIN access.governance_case c ON c.id = d.case_id WHERE d.id = $1`,
            [decisionId],
          )
        ).rows[0];
        if (!decision) throw new GovernanceDenied('decision is unavailable');
        await this.decider(
          client,
          principal,
          actor,
          decision.authority_scope_id,
          decision.kind === 'rights_disposition'
            ? DECIDE_ACTION.rights_complaint
            : DECIDE_ACTION.content_report,
        );
        if (decision.urgent) await this.decider(client, principal, actor,
          decision.authority_scope_id, 'governance.safety.evidence');
        const op = (
          await client.query<{ cancelled: boolean }>(
            'SELECT cancelled FROM access.safety_decision_operation WHERE decision_id = $1 FOR UPDATE',
            [decisionId],
          )
        ).rows[0];
        if (op && !op.cancelled)
          await client.query(
            `UPDATE access.safety_decision_effect
          SET state = 'uncertain' WHERE decision_id = $1 AND ordinal = $2 AND state <> 'confirmed'`,
            [decisionId, ordinal],
          );
      });
      const next = await this.transaction(async client => {
        const decision = (
          await client.query<{
            case_id: string;
            context: string;
            authority_scope_id: string;
            outcome: DecisionOutcome;
            reverses_decision_id: string | null;
            kind: string;
            urgent: boolean;
          }>(`SELECT d.*,c.urgent FROM access.moderation_decision d
              JOIN access.governance_case c ON c.id = d.case_id WHERE d.id = $1`, [decisionId])
        ).rows[0];
        if (!decision) throw new GovernanceDenied('decision is unavailable');
        await this.decider(
          client,
          principal,
          actor,
          decision.authority_scope_id,
          decision.kind === 'rights_disposition'
            ? DECIDE_ACTION.rights_complaint
            : DECIDE_ACTION.content_report,
        );
        if (decision.urgent) await this.decider(client, principal, actor,
          decision.authority_scope_id, 'governance.safety.evidence');
        const op = (
          await client.query<{ cancelled: boolean }>(
            'SELECT cancelled FROM access.safety_decision_operation WHERE decision_id = $1 FOR UPDATE',
            [decisionId],
          )
        ).rows[0];
        if (!op || op.cancelled) return false;
        const row = (
          await client.query<{
            plan: import('./effects.ts').EffectPlan;
            state: EffectState;
            continuation: string | null;
            owner: GovernanceOwner;
            resource: string;
            component: GovernanceComponent;
            locator: string | null;
            scope_kind: 'component' | 'exact_revision';
            revision: string | null;
            expected_head: string | null;
            effect: EnforcementEffect;
            expires_at: Date | null;
            participant_subject: string | null;
          }>(
            `SELECT e.plan,e.state,e.continuation,t.* FROM access.safety_decision_effect e
           JOIN access.moderation_decision_target t USING (decision_id,ordinal)
           WHERE e.decision_id = $1 AND e.ordinal = $2`,
            [decisionId, ordinal],
          )
        ).rows[0];
        if (!row) return false;
        if (row.state === 'confirmed') return true;
        const target: DecisionTargetInput = {
          owner: row.owner,
          resource: row.resource,
          component: row.component,
          locator: row.locator,
          scopeKind: row.scope_kind,
          revision: row.revision,
          expectedHead: row.expected_head,
          effect: row.effect,
          expiresAt: row.expires_at?.toISOString() ?? null,
        };
        await client.query('SAVEPOINT effect_dispatch');
        try {
          if (row.owner === 'review') {
            if (!this.reviews)
              throw new GovernanceUnavailable('review effect owner is unavailable');
            await this.reviews.lockCurrent(client, target);
          }
          const fence = (
            await client.query<{ id: string; state: string; decision_id: string }>(
              `SELECT id,state,decision_id
            FROM access.governance_enforcement WHERE owner = $1 AND resource = $2 AND component = $3
            AND revision IS NOT DISTINCT FROM $4 AND effect = $5 AND context = $6 AND authority_scope_id = $7
            FOR UPDATE`,
              [
                row.owner,
                row.resource,
                row.component,
                row.revision,
                row.effect,
                decision.context,
                decision.authority_scope_id,
              ],
            )
          ).rows[0];
          if (
            releasing.has(decision.outcome) &&
            (fence?.state !== 'restricted' ||
              (decision.reverses_decision_id &&
                fence.decision_id !== decision.reverses_decision_id))
          ) {
            throw new GovernanceStale('release target is absent or superseded');
          }
          if (['participation', 'capability'].includes(row.effect) && !row.participant_subject) {
            throw new GovernanceUnavailable('participation target has no confirmed owner');
          }
          const result =
            this.effects && !['participation', 'capability'].includes(row.effect)
              ? await this.effects.apply(
                  `governance-moderation:${decisionId}`,
                  ordinal,
                  target,
                  { ...row.plan, outcome: decision.outcome },
                  row.continuation,
                )
              : undefined;
          if (
            !this.effects &&
            ['graph', 'content', 'media'].includes(row.owner) &&
            !['participation', 'capability'].includes(row.effect)
          )
            throw new GovernanceUnavailable('effect owner is unavailable');
          if (['graph','content','media'].includes(row.owner)
            && !['participation','capability'].includes(row.effect) && !result?.receipt) {
            throw new KnownEffectFailure('owner-receipt-missing');
          }
          if (result?.continuation) {
            await client.query(
              `UPDATE access.safety_decision_effect SET state = 'pending',continuation = $3,
              receipt = $4,error = 'copy-closure-pending' WHERE decision_id = $1 AND ordinal = $2`,
              [decisionId, ordinal, result.continuation, result.receipt],
            );
            return false;
          }
          const state = restricting.has(decision.outcome) ? 'restricted' : 'released';
          if (restricting.has(decision.outcome) || releasing.has(decision.outcome)) {
            const wasVisible =
              row.owner === 'review' ? await this.reviews!.visible(client, row.resource) : false;
            if (fence)
              await client.query(
                `UPDATE access.governance_enforcement SET decision_id = $2,
              decision_ordinal = $3,state = $4,fence_epoch = fence_epoch + 1,updated_at = clock_timestamp(),
              expires_at = $5,participant_subject = $6 WHERE id = $1`,
                [fence.id, decisionId, ordinal, state, row.expires_at, row.participant_subject],
              );
            else
              await client.query(
                `INSERT INTO access.governance_enforcement
              (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,
               state,fence_epoch,expires_at,participant_subject) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13)`,
                [
                  randomUUID(),
                  decision.authority_scope_id,
                  decision.context,
                  row.owner,
                  row.resource,
                  row.component,
                  row.revision,
                  row.effect,
                  decisionId,
                  ordinal,
                  state,
                  row.expires_at,
                  row.participant_subject,
                ],
              );
            if (row.owner === 'review') {
              await this.reviews!.rankChanged(client, row.resource, wasVisible);
              await this.reviews!.bumpCollection(client, row.resource);
            }
          }
          await client.query(
            `UPDATE access.safety_decision_effect SET state = 'confirmed',receipt = $3,
            continuation = NULL,error = NULL WHERE decision_id = $1 AND ordinal = $2`,
            [
              decisionId,
              ordinal,
              result?.receipt ?? `access:governance-enforcement:${decisionId}:${ordinal}`,
            ],
          );
          await client.query(
            'UPDATE access.governance_case SET review_pending = review_pending WHERE id = $1',
            [decision.case_id],
          );
          await client.query(`INSERT INTO access.outbox
            (id,kind,scope_id,authority_epoch,moderation_decision_id)
            SELECT $1,'moderation.decided',d.authority_scope_id,d.authority_epoch,d.id
            FROM access.moderation_decision d WHERE d.id = $2
              AND NOT EXISTS (SELECT 1 FROM access.safety_decision_effect e
                WHERE e.decision_id = d.id AND e.state <> 'confirmed')
            ON CONFLICT DO NOTHING`, [randomUUID(), decisionId]);
          return true;
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT effect_dispatch');
          // Owner-domain rejection is known; transport/unavailable outcomes may have committed.
          const state =
            error instanceof GovernanceStale ||
            error instanceof GovernanceConflict ||
            error instanceof KnownEffectFailure
              ? 'failed'
              : 'uncertain';
          await client.query(
            `UPDATE access.safety_decision_effect SET state = $3,error = $4
            WHERE decision_id = $1 AND ordinal = $2`,
            [
              decisionId,
              ordinal,
              state,
              error instanceof KnownEffectFailure
                ? error.code
                : state === 'failed'
                  ? 'owner-basis-rejected'
                  : 'owner-confirmation-unavailable',
            ],
          );
          return false;
        }
      });
      if (!next) break;
    }
    return this.transaction((client) => this.decisionResult(client, decisionId, replayed));
  }

  async cancelDecision(
    principal: VerifiedPrincipal,
    actor: string,
    decisionId: string,
  ): Promise<DecisionResult> {
    return this.transaction(async client => {
      const decision = (
        await client.query<{ authority_scope_id: string; kind: string; case_id: string; urgent: boolean }>(
          `SELECT d.authority_scope_id,d.kind,d.case_id,c.urgent FROM access.moderation_decision d
           JOIN access.governance_case c ON c.id = d.case_id WHERE d.id = $1`,
          [decisionId],
        )
      ).rows[0];
      if (!decision) throw new GovernanceDenied('decision is unavailable');
      const authority = await this.decider(
        client,
        principal,
        actor,
        decision.authority_scope_id,
        decision.kind === 'rights_disposition'
          ? DECIDE_ACTION.rights_complaint
          : DECIDE_ACTION.content_report,
      );
      if (decision.urgent) await this.decider(client, principal, actor,
        decision.authority_scope_id, 'governance.safety.evidence');
      if (decision.authority_scope_id === 'governance:platform' && !(await client.query(
        `SELECT 1 FROM access.safety_case_claim WHERE case_id = $1 AND principal_id = $2
         AND acting_subject = $3 AND expires_at > $4`,
        [decision.case_id, authority.principalId, actor, this.clock()])).rowCount) {
        throw new GovernanceDenied('claim the case before cancelling');
      }
      await client.query(
        'SELECT decision_id FROM access.safety_decision_operation WHERE decision_id = $1 FOR UPDATE',
        [decisionId],
      );
      const outcome = await this.operationResult(client, decisionId);
      if (outcome.status === 'completed')
        throw new GovernanceConflict(
          'completed decisions require a new reversal, not cancellation',
        );
      await client.query(
        'UPDATE access.safety_decision_operation SET cancelled = true WHERE decision_id = $1',
        [decisionId],
      );
      await client.query(
        'UPDATE access.governance_case SET review_pending = review_pending WHERE id = $1',
        [decision.case_id],
      );
      return this.decisionResult(client, decisionId, true);
    });
  }

  /**
   * Record an appeal, uploader notice, counter-notice or restoration window.
   * A step never changes enforcement; only a later decision can restore.
   * Deciders record any step; a party that the caller represents records its
   * own appeal or counter-notice.
   */
  async recordStep(principal: VerifiedPrincipal, input: StepInput): Promise<{ stepId: string; dueAt: string | null;
    replayed: boolean }> {
    if (!uuidPattern.test(input.caseId) || !uuidPattern.test(input.decisionId) || !agentPattern.test(input.actingSubject)
      || !(processSteps as readonly string[]).includes(input.step) || !keyPattern.test(input.idempotencyKey)
      || (input.partySubject !== null && !agentPattern.test(input.partySubject))
      || (input.documentDigest !== null && !digestPattern.test(input.documentDigest))
      || Number.isNaN(Date.parse(input.occurredAt)) || (input.dueAt !== null && Number.isNaN(Date.parse(input.dueAt)))) {
      throw new GovernanceInvalid('process step does not match its profile');
    }
    const request = sha256(canonical({ ...input, idempotencyKey: undefined }));
    return this.transaction(async client => {
      const caseRow = (await client.query<{ kind: 'content_report' | 'rights_complaint'; authority_scope_id: string }>(
        `SELECT kind, authority_scope_id FROM access.governance_case WHERE id = $1 FOR SHARE`, [input.caseId])).rows[0];
      if (!caseRow) throw new GovernanceDenied('case is unavailable');
      if (caseRow.kind === 'content_report' && input.process !== 'platform_appeal') {
        throw new GovernanceInvalid('process does not apply to this case');
      }
      if (caseRow.kind === 'rights_complaint') {
        const applies = (await client.query(`SELECT 1 FROM access.rights_complaint
          WHERE case_id = $1 AND process = $2 LIMIT 1`, [input.caseId, input.process])).rows[0];
        if (!applies) throw new GovernanceInvalid('process does not apply to this complaint');
      }
      const ownParty = input.partySubject === input.actingSubject && ['appeal', 'counter_notice'].includes(input.step);
      const actor = ownParty ? { principalId: (await this.decider(client, principal, input.actingSubject,
        caseRow.authority_scope_id, APPEAL_ACTION)).principalId }
        : { principalId: (await this.decider(client, principal, input.actingSubject, caseRow.authority_scope_id,
          DECIDE_ACTION[caseRow.kind])).principalId };
      const prior = (await client.query<{ id: string; request_digest: string; due_at: Date | null }>(`SELECT id,
        request_digest, due_at FROM access.governance_process_step WHERE principal_id = $1 AND idempotency_key = $2`,
      [actor.principalId, input.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== request) throw new GovernanceConflict('idempotency key reused');
        return { stepId: prior.id, dueAt: prior.due_at?.toISOString() ?? null, replayed: true };
      }
      const stepId = randomUUID();
      await client.query(`INSERT INTO access.governance_process_step (id, case_id, decision_id, process, step,
          principal_id, party_subject, idempotency_key, request_digest, statement, document_digest, occurred_at, due_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [stepId, input.caseId, input.decisionId, input.process, input.step, actor.principalId, input.partySubject,
        input.idempotencyKey, request, input.statement, input.documentDigest, input.occurredAt, input.dueAt]);
      return { stepId, dueAt: input.dueAt, replayed: false };
    });
  }

  /** Current effective fences for one target component, across scopes and contexts (bounded by index). */
  async readEnforcement(target: { owner: GovernanceOwner; resource: string; component: GovernanceComponent }):
    Promise<Array<{ context: string; scope: string; revision: string | null; effect: string;
      state: 'restricted' | 'released'; fenceEpoch: string; decisionId: string }>> {
    if (!validTarget(target)) throw new GovernanceInvalid('invalid enforcement read');
    return this.transaction(async client => (await client.query<{ context: string; scope: string;
      revision: string | null; effect: string; state: 'restricted' | 'released'; fence_epoch: string;
      decision_id: string }>(`SELECT context, authority_scope_id AS scope, revision, effect, state,
        fence_epoch::text, decision_id FROM access.governance_enforcement
      WHERE owner = $1 AND resource = $2 AND component = $3 ORDER BY context, authority_scope_id, effect, revision
      LIMIT $4`, [target.owner, target.resource, target.component, GOVERNANCE_LIMITS.page])).rows.map(row => ({
      context: row.context, scope: row.scope, revision: row.revision, effect: row.effect, state: row.state,
      fenceEpoch: row.fence_epoch, decisionId: row.decision_id })));
  }

  /** Current title disclosure fences for one bounded resource-summary batch. */
  async restrictedTitles(heads: readonly { work: string; revision: string }[], context: string):
    Promise<ReadonlySet<string>> {
    if (heads.length > 64 || heads.some(item => !agentPattern.test(item.work)
      || !agentPattern.test(item.revision)) || context.length < 1 || context.length > 512) {
      throw new GovernanceInvalid('title fence batch is out of bounds');
    }
    if (!heads.length) return new Set();
    const contexts = context === GLOBAL_CONTEXT ? [GLOBAL_CONTEXT] : [GLOBAL_CONTEXT, context];
    return this.transaction(async client => new Set((await client.query<{ resource: string }>(
      `SELECT DISTINCT requested.work AS resource
       FROM unnest($1::text[], $2::text[]) AS requested(work, revision)
       JOIN access.governance_enforcement e ON e.resource = requested.work
       WHERE e.owner = 'graph' AND e.component IN ('title', 'name')
         AND e.effect = 'disclosure' AND e.state = 'restricted'
         AND (e.revision IS NULL OR e.revision = requested.revision)
         AND e.context = ANY($3::text[])`,
      [heads.map(item => item.work), heads.map(item => item.revision), contexts])).rows
      .map(row => row.resource)), true);
  }

  /** An exact Content revision remains fenced independently of a later variant head. */
  async restrictedContentRevision(resource: string, revision: string): Promise<boolean> {
    if (!agentPattern.test(resource) || !uuidPattern.test(revision)) {
      throw new GovernanceInvalid('content fence target is invalid');
    }
    return this.transaction(async client => (await client.query(`SELECT 1
      FROM access.governance_enforcement WHERE owner = 'content' AND resource = $1
        AND component = 'body' AND effect = 'disclosure' AND state = 'restricted'
        AND context = $2 AND (revision IS NULL OR revision = $3) LIMIT 1`,
    [resource, GLOBAL_CONTEXT, revision])).rowCount !== 0, true);
  }

  /** Steps whose deadline has passed and whose decision is still the case head: pending human disposition. */
  async dueSteps(now: Date, limit: number = GOVERNANCE_LIMITS.page): Promise<Array<{ stepId: string; caseId: string;
    step: string; dueAt: string }>> {
    return this.transaction(async client => (await client.query<{ id: string; case_id: string; step: string;
      due_at: Date }>(`SELECT s.id, s.case_id, s.step, s.due_at FROM access.governance_process_step s
      JOIN access.governance_case c ON c.id = s.case_id AND c.decision_head = s.decision_id
      WHERE s.due_at <= $1 ORDER BY s.due_at, s.id LIMIT $2`, [now, limit])).rows.map(row => ({
      stepId: row.id, caseId: row.case_id, step: row.step, dueAt: row.due_at.toISOString() })));
  }
}

export { GLOBAL_CONTEXT };
