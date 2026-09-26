import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { decisionOutcomes, enforcementEffects, GLOBAL_CONTEXT, governanceComponents, governanceOwners,
  processSteps } from './schema.ts';

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

export const GOVERNANCE_LIMITS = { evidence: 16, targets: 64, page: 50 } as const;
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
}
export interface DecisionInput {
  caseId: string; expectedGeneration: string; actingSubject: string; outcome: DecisionOutcome;
  targets: DecisionTargetInput[]; rule: { ref: string; revision: string; digest: string };
  evidenceDigest: string; reversesDecisionId: string | null; answersStepId: string | null;
  rationale: string | null; disclosure: 'private' | 'parties' | 'public_summary'; idempotencyKey: string;
}
export interface DecisionResult {
  decisionId: string; caseId: string; caseGeneration: string; outcome: string;
  enforcement: Array<{ owner: string; resource: string; component: string; revision: string | null; effect: string;
    state: 'restricted' | 'released'; fenceEpoch: string }>;
  replayed: boolean;
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
  constructor(private readonly pool: Pool, private readonly evidence: EvidenceCapture,
    private readonly heads: TargetHeads, private readonly rules: RuleBasis) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(() => {
      throw new GovernanceUnavailable('governance owner is unavailable');
    });
    try {
      await client.query('BEGIN');
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
    action: string): Promise<{ principalId: string; authorityEpoch: string; proofDigest: string }> {
    const actor = await this.represented(client, principal, actingSubject);
    const gate = (await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
      `SELECT authority_epoch::text, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE`,
      [scopeId])).rows[0];
    if (!gate?.open || !gate.dispatch_open) throw new GovernanceDenied('governance scope is closed');
    const grant = (await client.query<{ id: string; generation: string }>(`SELECT id, generation::text
      FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > clock_timestamp() ORDER BY valid_until DESC, id LIMIT 1 FOR SHARE`,
    [actingSubject, scopeId, action])).rows[0];
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
    // Capture happens before the write, while the reporter is authorized; the
    // write rechecks representation so a revoked reporter cannot commit.
    const captured: CapturedEvidence[] = [];
    for (const target of input.evidence) {
      captured.push(await this.evidence.capture(principal, input.actingSubject, target));
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

  private async reportResult(client: PoolClient, reportId: string, replayed: boolean): Promise<ReportResult> {
    const report = (await client.query<{ case_id: string; generation: string; evidence_digest: string }>(
      `SELECT r.case_id, c.generation::text, r.evidence_digest FROM access.governance_report r
       JOIN access.governance_case c ON c.id = r.case_id WHERE r.id = $1`, [reportId])).rows[0]!;
    const evidence = (await client.query<{ ordinal: number; owner: string; resource: string; component: string;
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
        kind: 'content_report' | 'rights_complaint'; state: string; decision_head: string | null }>(`SELECT
          p.account_issuer AS reporter_issuer, p.account_subject AS reporter_subject, p.active AS reporter_active,
          c.authority_scope_id AS scope,
          c.kind, c.state, c.decision_head FROM access.governance_report r
        JOIN access.principal p ON p.id = r.principal_id JOIN access.governance_case c ON c.id = r.case_id
        WHERE r.id = $1`, [reportId])).rows[0];
      if (!row) throw new GovernanceDenied('report is unavailable');
      const own = row.reporter_active && row.reporter_issuer === principal.issuer
        && row.reporter_subject === principal.subject;
      if (!own) {
        if (!actingSubject) throw new GovernanceDenied('report is unavailable');
        await this.decider(client, principal, actingSubject, row.scope, DECIDE_ACTION[row.kind])
          .catch(() => { throw new GovernanceDenied('report is unavailable'); });
      }
      return { ...await this.reportResult(client, reportId, false), caseState: row.state,
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
  async decide(principal: VerifiedPrincipal, input: DecisionInput): Promise<DecisionResult> {
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
    const request = sha256(canonical({ ...input, idempotencyKey: undefined }));
    // Do not expose rule or target-head changes to a caller lacking this case's
    // current decision authority. The write transaction checks it again.
    const caseScope = await this.transaction(async client => {
      const row = (await client.query<{ kind: 'content_report' | 'rights_complaint'; scope: string }>(
        `SELECT kind, authority_scope_id AS scope FROM access.governance_case WHERE id = $1`,
      [input.caseId])).rows[0];
      if (!row) throw new GovernanceDenied('case is unavailable');
      await this.decider(client, principal, input.actingSubject, row.scope, DECIDE_ACTION[row.kind]);
      return row.scope;
    });
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
    return this.transaction(async client => {
      const caseRow = (await client.query<{ id: string; kind: 'content_report' | 'rights_complaint';
        authority_kind: string; authority_scope_id: string; context: string; generation: string; state: string }>(
        `SELECT id, kind, authority_kind, authority_scope_id, context, generation::text, state
         FROM access.governance_case WHERE id = $1 FOR UPDATE`, [input.caseId])).rows[0];
      if (!caseRow) throw new GovernanceDenied('case is unavailable');
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
      const admittedTargets = (await client.query<{ owner: string; resource: string; component: string;
        locator: string | null; revision: string | null; state: EvidenceState }>(`SELECT DISTINCT e.owner,
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
           FROM access.moderation_decision_target WHERE decision_id = $1`, [input.reversesDecisionId])).rows;
        const same = (a: typeof original[number], b: DecisionTargetInput) => a.owner === b.owner
          && a.resource === b.resource && a.component === b.component && a.locator === b.locator
          && a.scope_kind === b.scopeKind && a.revision === b.revision && a.effect === b.effect;
        if (original.length !== input.targets.length
          || original.some(target => !input.targets.some(candidate => same(target, candidate)))) {
          throw new GovernanceStale('reversal does not match the original targets');
        }
      }
      const decisionId = randomUUID();
      const sequence = (BigInt(caseRow.generation) + 1n).toString();
      await client.query(`INSERT INTO access.moderation_decision (id, kind, outcome, context, case_id, case_sequence,
          reverses_decision_id, principal_id, acting_subject, authority_kind, authority_scope_id, authority_epoch,
          authority_proof_digest, idempotency_key, request_digest, rule_ref, rule_revision, rule_digest,
          evidence_digest, rationale, disclosure, answers_step_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      [decisionId, kind, input.outcome, caseRow.context, caseRow.id, sequence, input.reversesDecisionId,
        authority.principalId, input.actingSubject, caseRow.authority_kind, caseRow.authority_scope_id,
        authority.authorityEpoch, authority.proofDigest, input.idempotencyKey, request, input.rule.ref,
        input.rule.revision, input.rule.digest, input.evidenceDigest, input.rationale, input.disclosure,
        input.answersStepId]);
      for (const [index, target] of input.targets.entries()) {
        await client.query(`INSERT INTO access.moderation_decision_target (decision_id, ordinal, owner, resource,
            component, locator, scope_kind, revision, expected_head, effect)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [decisionId, index + 1, target.owner, target.resource, target.component, target.locator, target.scopeKind,
          target.revision, target.expectedHead, target.effect]);
        const fence = (await client.query<{ id: string; state: string }>(`SELECT id, state
          FROM access.governance_enforcement WHERE owner = $1 AND resource = $2 AND component = $3
            AND revision IS NOT DISTINCT FROM $4 AND effect = $5 AND context = $6 AND authority_scope_id = $7
          FOR UPDATE`, [target.owner, target.resource, target.component, target.revision, target.effect,
          caseRow.context, caseRow.authority_scope_id])).rows[0];
        if (restricting.has(input.outcome)) {
          if (fence) {
            await client.query(`UPDATE access.governance_enforcement SET decision_id = $2, decision_ordinal = $3,
              state = 'restricted', fence_epoch = fence_epoch + 1, updated_at = clock_timestamp() WHERE id = $1`,
            [fence.id, decisionId, index + 1]);
          } else {
            await client.query(`INSERT INTO access.governance_enforcement (id, authority_scope_id, context, owner,
                resource, component, revision, effect, decision_id, decision_ordinal, state, fence_epoch)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'restricted', 1)`,
            [randomUUID(), caseRow.authority_scope_id, caseRow.context, target.owner, target.resource,
              target.component, target.revision, target.effect, decisionId, index + 1]);
          }
        } else if (releasing.has(input.outcome)) {
          if (fence?.state !== 'restricted') throw new GovernanceStale('release target is not restricted');
          if (input.reversesDecisionId) {
            const current = (await client.query<{ decision_id: string }>(
              'SELECT decision_id FROM access.governance_enforcement WHERE id = $1', [fence.id])).rows[0];
            if (current?.decision_id !== input.reversesDecisionId) {
              throw new GovernanceStale('the original restriction was superseded');
            }
          }
          await client.query(`UPDATE access.governance_enforcement SET decision_id = $2, decision_ordinal = $3,
            state = 'released', fence_epoch = fence_epoch + 1, updated_at = clock_timestamp() WHERE id = $1`,
          [fence.id, decisionId, index + 1]);
        }
      }
      await client.query(`UPDATE access.governance_case SET decision_head = $2, generation = $3 WHERE id = $1`,
        [caseRow.id, decisionId, sequence]);
      // Reuse the Access outbox for the committed decision fact consumed by propagation.
      await client.query(`INSERT INTO access.outbox (id, kind, scope_id, authority_epoch, moderation_decision_id)
        VALUES ($1, 'moderation.decided', $2, $3, $4)`,
      [randomUUID(), caseRow.authority_scope_id, authority.authorityEpoch, decisionId]);
      return this.decisionResult(client, decisionId, false);
    });
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
      replayed, enforcement: enforcement.map(row => ({ owner: row.owner, resource: row.resource,
        component: row.component, revision: row.revision, effect: row.effect, state: row.state,
        fenceEpoch: row.fence_epoch })) };
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
