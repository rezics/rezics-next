import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { directWorkCreateProof } from './direct-principal.ts';
import { groupWorkCreateProof, GroupUnavailable } from './groups.ts';
import { representedWorkProof, selectedRepresentedWorkProof } from './represented-work-proof.ts';
import { roleWorkCreateProof } from './role-proof.ts';

/** Populated only by Account assertion verification, never from a request body. */
export interface VerifiedPrincipal {
  issuer: string;
  subject: string;
}

export interface AdmissionRequest {
  principal: VerifiedPrincipal;
  actingSubject: string;
  /** Omitted by existing commands; direct authority is currently work.create only. */
  authorityPath?: 'represented-agent' | 'direct-principal';
  scope: string;
  action: string;
  idempotencyKey: string;
  requestDigest: string;
}

export interface RegisteredAdmission {
  id: string;
  principalId: string;
  actingSubject: string;
  authorityPath?: 'represented-agent' | 'direct-principal';
  scope: string;
  action: string;
  idempotencyKey: string;
  requestDigest: string;
  authorityEpoch: string;
  expiresAt: string;
  state: 'registered' | 'claimed' | 'sealed';
  dispatchEligible: boolean;
  replayed: boolean;
}

export interface ClaimedAdmission extends RegisteredAdmission {
  claimedAt: string;
}

export interface StrongScopeClosure {
  scope: string;
  authorityEpoch: string;
  /** Commands and private search deliveries still requiring terminal resolution. */
  pending: number;
  pendingReads: number;
}

export interface StrongPrincipalDeactivation {
  principalId: string;
  enforcementEpoch: string;
  pending: number;
  pendingReads: number;
}

/** A single Contribution's private phrase admission; it is not an Access grant. */
export interface ContributionSearchReadLease {
  id: string;
  principalId: string;
  actingSubject: string;
  contribution: string;
  scope: string;
  authorityEpoch: string;
  principalEpoch: string;
  recoveryGeneration: string;
  expiresAt: string;
  state: 'admitted' | 'delivering';
}

export interface UnresolvedContributionSearchDelivery {
  id: string;
  principalId: string;
  scope: string;
  contribution: string;
  deliveryStartedAt: string;
  sendStartedAt: string | null;
  expiresAt: string;
}

/** Admission expires after ten seconds; the adapter must also stop delivery. */
export const CONTRIBUTION_SEARCH_READ_LEASE_MS = 10_000;
export const MAX_PRINCIPAL_SEARCH_READS = 16;
export const MAX_SCOPE_SEARCH_READS = 64;

export interface GraphTerminalProof {
  outcome: 'succeeded' | 'cancelled';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
}

export class AdmissionDenied extends Error {}
export class AdmissionUnavailable extends Error {}
export class AdmissionConflict extends Error {}
export class AdmissionExpired extends Error {}

interface GateRow { authority_epoch: string; open: boolean; dispatch_open: boolean }
interface SearchReadRow {
  id: string; principal_id: string; acting_subject: string; contribution: string;
  scope_id: string; representation_id: string; grant_id: string;
  authority_epoch: string; principal_epoch: string; subject_generation: string;
  recovery_generation: string;
  representation_generation: string; grant_generation: string;
  expires_at: Date; state: string;
  send_started_at: Date | null; receipt_digest: string | null;
}
const nativeContribution = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

function contributionSearchLease(row: SearchReadRow): ContributionSearchReadLease {
  return { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
    contribution: row.contribution, scope: row.scope_id,
    authorityEpoch: row.authority_epoch, principalEpoch: row.principal_epoch,
    recoveryGeneration: row.recovery_generation,
    expiresAt: row.expires_at.toISOString(),
    state: row.state as ContributionSearchReadLease['state'] };
}

/** Expired admissions cannot begin delivery. Delivering reads require an explicit
 * finish even after expiry: time alone cannot prove that bytes stopped flowing. */
async function pendingSearchReads(client: PoolClient, column: 'scope_id' | 'principal_id',
  value: string, close = false): Promise<number> {
  await client.query(`UPDATE access.search_read_lease SET state = 'expired',
      finished_at = clock_timestamp()
    WHERE ${column} = $1 AND state = 'admitted' AND expires_at <= clock_timestamp()`, [value]);
  if (close) {
    // The gate/principal lock makes a later delivery start impossible. Work that
    // has not started delivery can be aborted without waiting for its query.
    await client.query(`UPDATE access.search_read_lease SET state = 'aborted',
        finished_at = clock_timestamp()
      WHERE ${column} = $1 AND state = 'admitted'`, [value]);
  }
  const result = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM access.search_read_lease
     WHERE ${column} = $1 AND state IN ('admitted', 'delivering')`, [value]);
  return Number(result.rows[0]?.count ?? '0');
}
interface AdmissionRow {
  id: string;
  principal_id: string;
  acting_subject: string;
  authority_path: 'represented-agent' | 'direct-principal';
  direct_grant_id?: string | null;
  attribution_id?: string | null;
  direct_grant_generation?: string | null;
  attribution_generation?: string | null;
  direct_subject_generation?: string | null;
  direct_principal_epoch?: string | null;
  group_member_id: string | null;
  group_grant_id: string | null;
  group_generation: string | null;
  represented_representation_id: string | null;
  represented_representation_generation: string | null;
  represented_grant_id: string | null;
  represented_grant_generation: string | null;
  represented_subject_generation: string | null;
  represented_principal_epoch: string | null;
  role_binding_id: string | null;
  role_binding_generation: string | null;
  role_family_id: string | null;
  role_revision: string | null;
  scope_id: string;
  action: string;
  idempotency_key: string;
  request_digest: string;
  authority_epoch: string;
  expires_at: Date;
  state: string;
  eligible: boolean;
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

async function requireRecoveryOpen(client: PoolClient): Promise<string> {
  const result = await client.query<{ open: boolean; generation: string }>(
    'SELECT open, generation FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (result.rows[0]?.open !== true) throw new AdmissionUnavailable('Access is held for recovery');
  return result.rows[0]!.generation;
}

/** Operator-only fence. The update waits for in-flight ordinary Access transactions. */
export async function engageAccessRecoveryFence(pool: Pool): Promise<string> {
  const result = await pool.query<{ generation: string }>(
    `UPDATE access.recovery_fence SET open = false,
       generation = generation + CASE WHEN open THEN 1 ELSE 0 END
     WHERE id = true RETURNING generation`);
  if (result.rowCount !== 1) throw new AdmissionUnavailable('Access recovery fence is unavailable');
  return result.rows[0]!.generation;
}

/** Release follows successful graph/authority reconciliation. */
export async function releaseAccessRecoveryFence(pool: Pool, generation: string): Promise<void> {
  if (!/^[0-9]+$/.test(generation)) throw new AdmissionUnavailable('invalid Access recovery generation');
  const result = await pool.query(
    `UPDATE access.recovery_fence SET open = true, generation = generation + 1
     WHERE id = true AND open = false AND generation = $1
       AND NOT EXISTS (SELECT 1 FROM access.search_read_lease WHERE state = 'delivering')`, [generation]);
  if (result.rowCount !== 1) throw new AdmissionUnavailable('Access recovery fence changed');
}

export class AccessAdmissionRegistry {
  constructor(private readonly pool: Pool) {}

  /** Read the independent Access ledger for a Content revision's immutable author proof. */
  async verifyContentDraftProof(proof: {
    admissionId: string; author: string; scope: string; requestDigest: string;
    authorityEpoch: string; contentEpoch: string; contentSequence: string;
  }): Promise<boolean> {
    const result = await this.pool.query<{
      acting_subject: string; scope_id: string; request_digest: string;
      authority_epoch: string; state: string; graph_outcome: string;
      graph_receipt: string; graph_data_epoch: string; graph_sequence: string;
    }>(`SELECT acting_subject, scope_id, request_digest, authority_epoch,
        state, graph_outcome, graph_receipt, graph_data_epoch, graph_sequence
      FROM access.admission
      WHERE id = $1 AND action = 'content.draft'`, [proof.admissionId]);
    const row = result.rows[0];
    const expectedReceipt = `urn:rezics:receipt:${createHash('sha256')
      .update(`${proof.admissionId}\0content-draft-save`).digest('hex')}`;
    return result.rowCount === 1 && row?.state === 'sealed'
      && row.graph_outcome === 'succeeded' && row.graph_receipt === expectedReceipt
      && row.acting_subject === proof.author && row.scope_id === proof.scope
      && row.request_digest === proof.requestDigest
      && row.authority_epoch === proof.authorityEpoch
      && row.graph_data_epoch === proof.contentEpoch
      && row.graph_sequence === proof.contentSequence;
  }

  /** Current Work-specific disclosure decision; no historical grant is reused. */
  async canReadWork(principal: VerifiedPrincipal, actingSubject: string, work: string): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject, `work:read:${work}`, 'work.read');
  }

  /** Official links also need a source-revision admission; this is target edit authority. */
  async canLinkTranslation(principal: VerifiedPrincipal, actingSubject: string,
    work: string): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject,
      `translation:link:${work}`, 'translation.link');
  }

  /** Drafts require their own current grant, independent of Work or publication reads. */
  async canReadContributionDraft(
    principal: VerifiedPrincipal, actingSubject: string, contribution: string,
  ): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(contribution)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject,
      `contribution:read:${contribution}`, 'contribution.read');
  }

  /** Register one private Contribution search before crossing into Content/Jena.
   * The owning gate and principal serialize this admission with strong closure. */
  async admitContributionSearchRead(principal: VerifiedPrincipal,
    actingSubject: string, contribution: string): Promise<ContributionSearchReadLease> {
    if (!nativeContribution.test(contribution) || !nativeContribution.test(actingSubject)
      || !principal.issuer || !principal.subject) {
      throw new AdmissionDenied('invalid private search subject');
    }
    const scope = `contribution:read:${contribution}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recoveryGeneration = await requireRecoveryOpen(client);
      const gate = (await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE',
        [scope])).rows[0];
      if (!gate || !gate.open || !gate.dispatch_open) throw new AdmissionDenied('private search scope is closed');
      const identity = (await client.query<{ id: string; enforcement_epoch: string }>(
        `SELECT id, enforcement_epoch FROM access.principal
         WHERE account_issuer = $1 AND account_subject = $2 AND active FOR UPDATE`,
        [principal.issuer, principal.subject])).rows[0];
      if (!identity) throw new AdmissionDenied('private search principal is unavailable');
      const subject = (await client.query<{ generation: string }>(
        'SELECT generation FROM access.authority_subject WHERE id = $1 AND active FOR SHARE',
        [actingSubject])).rows[0];
      const representation = (await client.query<{
        id: string; generation: string; valid_until: Date;
      }>(`SELECT id, generation, valid_until FROM access.representation
          WHERE principal_id = $1 AND subject_id = $2 AND action = 'contribution.read'
            AND active AND valid_until > clock_timestamp() + interval '1 second'
          ORDER BY id LIMIT 1 FOR SHARE`, [identity.id, actingSubject])).rows[0];
      const grant = (await client.query<{
        id: string; generation: string; valid_until: Date;
      }>(`SELECT id, generation, valid_until FROM access.permission_grant
          WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'contribution.read'
            AND active AND valid_until > clock_timestamp() + interval '1 second'
          ORDER BY id LIMIT 1 FOR SHARE`, [actingSubject, scope])).rows[0];
      if (!subject || !representation || !grant) throw new AdmissionDenied('private search is not admitted');
      if (await pendingSearchReads(client, 'principal_id', identity.id) >= MAX_PRINCIPAL_SEARCH_READS
        || await pendingSearchReads(client, 'scope_id', scope) >= MAX_SCOPE_SEARCH_READS) {
        throw new AdmissionUnavailable('private search admission capacity is exhausted');
      }
      const inserted = await client.query<SearchReadRow>(
        `WITH deadline AS (
           SELECT LEAST(clock_timestamp() + ($14 * interval '1 millisecond'), $15, $16)
             AS expires_at
         )
         INSERT INTO access.search_read_lease
          (id, principal_id, acting_subject, contribution, scope_id, representation_id,
           grant_id, authority_epoch, principal_epoch, recovery_generation,
           subject_generation, representation_generation, grant_generation, expires_at, state)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           deadline.expires_at, 'admitted'
         FROM deadline WHERE deadline.expires_at > clock_timestamp() + interval '1 second'
         RETURNING *`,
        [Bun.randomUUIDv7(), identity.id, actingSubject, contribution, scope,
          representation.id, grant.id, gate.authority_epoch, identity.enforcement_epoch,
          recoveryGeneration, subject.generation, representation.generation, grant.generation,
          CONTRIBUTION_SEARCH_READ_LEASE_MS, representation.valid_until, grant.valid_until]);
      if (!inserted.rows[0]) throw new AdmissionExpired('private search authority expires too soon');
      await client.query('COMMIT');
      return contributionSearchLease(inserted.rows[0]!);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  /** Final authority check. A transport must arm before its first sensitive
   * send, then finish with a matched receipt. A checked lease is not reusable. */
  async beginContributionSearchDelivery(leaseId: string, principal: VerifiedPrincipal,
    actingSubject: string, contribution: string): Promise<ContributionSearchReadLease> {
    if (!/^[0-9a-f-]{36}$/.test(leaseId) || !nativeContribution.test(actingSubject)
      || !nativeContribution.test(contribution) || !principal.issuer || !principal.subject) {
      throw new AdmissionDenied('invalid private search delivery');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recoveryGeneration = await requireRecoveryOpen(client);
      const locator = (await client.query<Pick<SearchReadRow, 'scope_id' | 'principal_id'>>(
        'SELECT scope_id, principal_id FROM access.search_read_lease WHERE id = $1', [leaseId])).rows[0];
      if (!locator) throw new AdmissionDenied('private search lease is unavailable');
      const gate = (await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
        [locator.scope_id])).rows[0];
      const identity = (await client.query<{
        id: string; enforcement_epoch: string; active: boolean;
      }>(`SELECT id, enforcement_epoch, active FROM access.principal
          WHERE id = $1 AND account_issuer = $2 AND account_subject = $3 FOR SHARE`,
        [locator.principal_id, principal.issuer, principal.subject])).rows[0];
      const lease = (await client.query<SearchReadRow>(
        'SELECT * FROM access.search_read_lease WHERE id = $1 FOR UPDATE', [leaseId])).rows[0];
      if (!gate || !gate.open || !gate.dispatch_open || !identity?.active || !lease
        || lease.state !== 'admitted' || lease.scope_id !== locator.scope_id
        || lease.principal_id !== identity.id || lease.contribution !== contribution
        || lease.acting_subject !== actingSubject
        || lease.authority_epoch !== gate.authority_epoch
        || lease.principal_epoch !== identity.enforcement_epoch
        || lease.recovery_generation !== recoveryGeneration) {
        throw new AdmissionDenied('private search delivery is fenced');
      }
      if (lease.expires_at.getTime() <= Date.now()) throw new AdmissionExpired('private search lease expired');
      const dependencies = await client.query<{ id: string }>(
        `SELECT s.id FROM access.authority_subject s
          JOIN access.representation r ON r.id = $2
          JOIN access.permission_grant g ON g.id = $3
          WHERE s.id = $1 AND s.active AND s.generation = $4
            AND r.principal_id = $5 AND r.subject_id = s.id
            AND r.action = 'contribution.read' AND r.active AND r.generation = $6
            AND r.valid_until > clock_timestamp()
            AND g.recipient_subject = s.id AND g.scope_id = $7
            AND g.action = 'contribution.read' AND g.active AND g.generation = $8
            AND g.valid_until > clock_timestamp()
          FOR SHARE OF s, r, g`, [actingSubject, lease.representation_id, lease.grant_id,
          lease.subject_generation, identity.id, lease.representation_generation,
          lease.scope_id, lease.grant_generation]);
      if (dependencies.rowCount !== 1) throw new AdmissionDenied('private search proof changed');
      const started = await client.query<SearchReadRow>(
        `UPDATE access.search_read_lease SET state = 'delivering',
           delivery_started_at = clock_timestamp()
         WHERE id = $1 AND state = 'admitted' AND expires_at > clock_timestamp()
         RETURNING *`, [leaseId]);
      if (!started.rows[0]) throw new AdmissionExpired('private search lease expired');
      await client.query('COMMIT');
      return contributionSearchLease(started.rows[0]);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  /** Commit the no-return point before invoking a transport send. A crash after
   * this commit is conservatively unresolved, even if no byte actually left. */
  async armContributionSearchSend(leaseId: string, receiptToken: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(leaseId) || !/^[0-9a-f]{64}$/.test(receiptToken)) {
      throw new AdmissionDenied('invalid private search receipt challenge');
    }
    const digest = createHash('sha256').update(receiptToken).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recoveryGeneration = await requireRecoveryOpen(client);
      const locator = (await client.query<Pick<SearchReadRow, 'scope_id' | 'principal_id'>>(
        'SELECT scope_id, principal_id FROM access.search_read_lease WHERE id = $1', [leaseId])).rows[0];
      if (!locator) throw new AdmissionDenied('private search lease is unavailable');
      const gate = (await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
        [locator.scope_id])).rows[0];
      const identity = (await client.query<{
        id: string; enforcement_epoch: string; active: boolean;
      }>('SELECT id, enforcement_epoch, active FROM access.principal WHERE id = $1 FOR SHARE',
        [locator.principal_id])).rows[0];
      const lease = (await client.query<SearchReadRow>(
        'SELECT * FROM access.search_read_lease WHERE id = $1 FOR UPDATE', [leaseId])).rows[0];
      if (!gate?.open || !gate.dispatch_open || !identity?.active || !lease
        || lease.state !== 'delivering' || lease.send_started_at !== null
        || lease.scope_id !== locator.scope_id || lease.principal_id !== identity.id
        || lease.authority_epoch !== gate.authority_epoch
        || lease.principal_epoch !== identity.enforcement_epoch
        || lease.recovery_generation !== recoveryGeneration) {
        throw new AdmissionDenied('private search send is fenced');
      }
      if (lease.expires_at.getTime() <= Date.now()) {
        throw new AdmissionExpired('private search lease expired before send');
      }
      const dependencies = await client.query<{ id: string }>(
        `SELECT s.id FROM access.authority_subject s
          JOIN access.representation r ON r.id = $2
          JOIN access.permission_grant g ON g.id = $3
          WHERE s.id = $1 AND s.active AND s.generation = $4
            AND r.principal_id = $5 AND r.subject_id = s.id
            AND r.action = 'contribution.read' AND r.active AND r.generation = $6
            AND r.valid_until > clock_timestamp()
            AND g.recipient_subject = s.id AND g.scope_id = $7
            AND g.action = 'contribution.read' AND g.active AND g.generation = $8
            AND g.valid_until > clock_timestamp()
          FOR SHARE OF s, r, g`, [lease.acting_subject, lease.representation_id,
          lease.grant_id, lease.subject_generation, identity.id,
          lease.representation_generation, lease.scope_id, lease.grant_generation]);
      if (dependencies.rowCount !== 1) throw new AdmissionDenied('private search send proof changed');
      const result = await client.query(
        `UPDATE access.search_read_lease
         SET send_started_at = clock_timestamp(), receipt_digest = $2
         WHERE id = $1 AND state = 'delivering' AND send_started_at IS NULL
           AND recovery_generation = $3 AND expires_at > clock_timestamp()`,
        [leaseId, digest, recoveryGeneration]);
      if (result.rowCount !== 1) throw new AdmissionConflict('private search send cannot be armed');
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  /** A matched peer receipt proves the full single-frame result was received.
   * Abort is permitted only when no sensitive send could have been attempted. */
  async finishContributionSearchRead(leaseId: string, outcome: 'delivered' | 'aborted',
    receiptToken?: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(leaseId) || !['delivered', 'aborted'].includes(outcome)
      || (outcome === 'delivered' && !/^[0-9a-f]{64}$/.test(receiptToken ?? ''))
      || (outcome === 'aborted' && receiptToken !== undefined)) {
      throw new AdmissionDenied('invalid private search finish');
    }
    const digest = receiptToken && createHash('sha256').update(receiptToken).digest('hex');
    const result = await this.pool.query<{ state: string }>(
      `UPDATE access.search_read_lease SET state = $2, finished_at = clock_timestamp()
       WHERE id = $1 AND state IN ('admitted', 'delivering')
         AND (($2 = 'aborted' AND send_started_at IS NULL)
           OR ($2 = 'delivered' AND state = 'delivering'
             AND send_started_at IS NOT NULL AND receipt_digest = $3))
       RETURNING state`, [leaseId, outcome, digest ?? null]);
    if (result.rowCount === 1) return;
    const prior = await this.pool.query<{ state: string; receipt_digest: string | null }>(
      'SELECT state, receipt_digest FROM access.search_read_lease WHERE id = $1', [leaseId]);
    if (prior.rows[0]?.state !== outcome
      || (outcome === 'delivered' && prior.rows[0].receipt_digest !== digest)) {
      throw new AdmissionConflict('private search finish conflicts with lease');
    }
  }

  /** Recovery/operations view. A post-send disconnect or crash stays here until
   * the exact receipt is reconciled; expiry never converts it into an abort. */
  async unresolvedContributionSearchDeliveries(limit = 100): Promise<UnresolvedContributionSearchDelivery[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new AdmissionDenied('invalid unresolved delivery limit');
    }
    const result = await this.pool.query<{
      id: string; principal_id: string; scope_id: string; contribution: string;
      delivery_started_at: Date; send_started_at: Date | null; expires_at: Date;
    }>(`SELECT id, principal_id, scope_id, contribution, delivery_started_at,
          send_started_at, expires_at
        FROM access.search_read_lease WHERE state = 'delivering'
        ORDER BY delivery_started_at, id LIMIT $1`, [limit]);
    return result.rows.map(row => ({ id: row.id, principalId: row.principal_id,
      scope: row.scope_id, contribution: row.contribution,
      deliveryStartedAt: row.delivery_started_at.toISOString(),
      sendStartedAt: row.send_started_at?.toISOString() ?? null,
      expiresAt: row.expires_at.toISOString() }));
  }

  async canReadStandingRating(
    principal: VerifiedPrincipal, actingSubject: string, context: string,
  ): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(context)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject,
      `rating:read:${context}`, 'rating.observation.read');
  }

  /** Returns only a currently active Access counting identity for an introspected Account subject. */
  async activePrincipalId(principal: VerifiedPrincipal): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await requireRecoveryOpen(client);
      const result = await client.query<{ id: string }>(
        `SELECT id FROM access.principal WHERE account_issuer = $1
         AND account_subject = $2 AND active FOR SHARE`,
        [principal.issuer, principal.subject]);
      await client.query('COMMIT');
      return result.rows.length === 1 ? result.rows[0]!.id : null;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally { client.release(); }
  }

  private async canReadScopedResource(
    principal: VerifiedPrincipal, actingSubject: string, scope: string, action: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const gate = await client.query<{ open: boolean }>(
        'SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
      if (gate.rows[0]?.open !== true) {
        await client.query('COMMIT');
        return false;
      }
      const identity = await client.query<{ id: string }>(
        `SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2
          AND active FOR SHARE`, [principal.issuer, principal.subject]);
      const principalId = identity.rows[0]?.id;
      if (!principalId) {
        await client.query('COMMIT');
        return false;
      }
      const subject = await client.query(
        'SELECT id FROM access.authority_subject WHERE id = $1 AND active FOR SHARE', [actingSubject]);
      const represented = await client.query(
        `SELECT id FROM access.representation WHERE principal_id = $1 AND subject_id = $2
          AND action = $3 AND active AND valid_until > clock_timestamp()
          ORDER BY id LIMIT 1 FOR SHARE`, [principalId, actingSubject, action]);
      const granted = await client.query(
        `SELECT id FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2
          AND action = $3 AND active AND valid_until > clock_timestamp()
          ORDER BY id LIMIT 1 FOR SHARE`, [actingSubject, scope, action]);
      await client.query('COMMIT');
      return subject.rowCount === 1 && represented.rowCount === 1 && granted.rowCount === 1;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async register(request: AdmissionRequest): Promise<RegisteredAdmission> {
    const authorityPath = request.authorityPath ?? 'represented-agent';
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(request.idempotencyKey)
      || !/^[a-z][a-z0-9.:-]{1,127}$/.test(request.action)
      || !/^[0-9a-f]{64}$/.test(request.requestDigest)
      || !['represented-agent', 'direct-principal'].includes(authorityPath)
      || (authorityPath === 'direct-principal'
        && (request.action !== 'work.create' || request.scope !== 'work:create:root'))) {
      throw new AdmissionDenied('invalid admission request');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const gateResult = await client.query<GateRow & { group_generation: string }>(
        `SELECT authority_epoch, group_generation, open, dispatch_open
         FROM access.scope_gate WHERE id = $1 FOR UPDATE`, [request.scope]);
      const gate = gateResult.rows[0];
      if (!gate) throw new AdmissionUnavailable('scope gate is unavailable');

      const principalResult = await client.query<{
        id: string; active: boolean; enforcement_epoch: string;
      }>(
        `SELECT id, active, enforcement_epoch FROM access.principal
         WHERE account_issuer = $1 AND account_subject = $2 FOR SHARE`,
        [request.principal.issuer, request.principal.subject]);
      const principal = principalResult.rows[0];
      if (principal?.active !== true) throw new AdmissionDenied('principal is not admitted');
      const principalId = principal.id;

      const existingResult = await client.query<AdmissionRow>(
        `SELECT id, principal_id, acting_subject, authority_path, scope_id, action, idempotency_key, request_digest,
                authority_epoch, expires_at, state, group_member_id, group_grant_id, group_generation,
                represented_representation_id, represented_representation_generation,
                represented_grant_id, represented_grant_generation,
                represented_subject_generation, represented_principal_epoch,
                role_binding_id, role_binding_generation, role_family_id, role_revision,
                (expires_at > clock_timestamp()) AS eligible
         FROM access.admission
         WHERE principal_id = $1 AND action = $2 AND idempotency_key = $3`,
        [principalId, request.action, request.idempotencyKey]);
      const existing = existingResult.rows[0];

      // A retry may recover the immutable receipt after authority changes. Its
      // saved proof, rather than a newly selected alternative, decides dispatch.
      if (existing && authorityPath === 'represented-agent'
        && request.action === 'work.create' && request.scope === 'work:create:root') {
        if (existing.request_digest !== request.requestDigest
          || existing.acting_subject !== request.actingSubject
          || existing.authority_path !== authorityPath
          || existing.scope_id !== request.scope) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        const dispatchEligible = ['registered', 'claimed'].includes(existing.state) && existing.eligible
          && gate.open && gate.dispatch_open
          && existing.authority_epoch === gate.authority_epoch
          && await selectedRepresentedWorkProof(client, existing,
            principal.enforcement_epoch, gate.group_generation);
        await client.query('COMMIT');
        return {
          id: existing.id, principalId: existing.principal_id,
          actingSubject: existing.acting_subject, scope: existing.scope_id,
          authorityPath: existing.authority_path,
          action: existing.action, idempotencyKey: existing.idempotency_key,
          requestDigest: existing.request_digest,
          authorityEpoch: existing.authority_epoch,
          expiresAt: existing.expires_at.toISOString(), state: existing.state as RegisteredAdmission['state'],
          dispatchEligible, replayed: true,
        };
      }

      const subject = await client.query<{ active: boolean; kind: string }>(
        'SELECT active, kind FROM access.authority_subject WHERE id = $1 FOR SHARE', [request.actingSubject]);
      if (subject.rows[0]?.active !== true) throw new AdmissionDenied('acting subject is not active');
      let directGrantId: string | null = null;
      let attributionId: string | null = null;
      let directGrantGeneration: string | null = null;
      let attributionGeneration: string | null = null;
      let directSubjectGeneration: string | null = null;
      let directPrincipalEpoch: string | null = null;
      let groupMemberId: string | null = null;
      let groupGrantId: string | null = null;
      let groupGeneration: string | null = null;
      let representedRepresentationId: string | null = null;
      let representedRepresentationGeneration: string | null = null;
      let representedGrantId: string | null = null;
      let representedGrantGeneration: string | null = null;
      let representedSubjectGeneration: string | null = null;
      let representedPrincipalEpoch: string | null = null;
      let roleBindingId: string | null = null;
      let roleBindingGeneration: string | null = null;
      let roleFamilyId: string | null = null;
      let roleRevision: string | null = null;
      if (authorityPath === 'direct-principal') {
        if (subject.rows[0]?.kind !== 'agent') throw new AdmissionDenied('public attribution is not an Agent');
        const proof = await directWorkCreateProof(client, principalId, request.actingSubject);
        if (!proof) {
          throw new AdmissionDenied('direct principal or public attribution is not admitted');
        }
        directGrantId = proof.grantId;
        attributionId = proof.attributionId;
        directGrantGeneration = proof.grantGeneration;
        attributionGeneration = proof.attributionGeneration;
        directSubjectGeneration = proof.subjectGeneration;
        directPrincipalEpoch = principal.enforcement_epoch;
      } else {
        if (request.action === 'work.create' && request.scope === 'work:create:root') {
          if (subject.rows[0]?.kind !== 'agent') throw new AdmissionDenied('acting subject is not an Agent');
          const proof = await representedWorkProof(client, principalId, request.actingSubject);
          if (!proof) throw new AdmissionDenied('representation is not admitted');
          representedRepresentationId = proof.representationId;
          representedRepresentationGeneration = proof.representationGeneration;
          representedSubjectGeneration = proof.subjectGeneration;
          representedPrincipalEpoch = principal.enforcement_epoch;
          representedGrantId = proof.grantId;
          representedGrantGeneration = proof.grantGeneration;
          if (!proof.grantId) {
            const group = await groupWorkCreateProof(client, request.actingSubject);
            groupMemberId = group?.memberId ?? null;
            groupGrantId = group?.grantId ?? null;
            groupGeneration = group?.groupGeneration ?? null;
            if (!group) {
              const role = await roleWorkCreateProof(client, request.actingSubject);
              roleBindingId = role?.bindingId ?? null;
              roleBindingGeneration = role?.bindingGeneration ?? null;
              roleFamilyId = role?.familyId ?? null;
              roleRevision = role?.roleRevision ?? null;
            }
          }
          if (!representedGrantId && !groupGrantId && !roleBindingId) {
            throw new AdmissionDenied('permission is not granted');
          }
        } else {
          const represented = await client.query(
            `SELECT id FROM access.representation
             WHERE principal_id = $1 AND subject_id = $2 AND action = $3
               AND active AND valid_until > clock_timestamp()
             ORDER BY id LIMIT 1 FOR SHARE`,
            [principalId, request.actingSubject, request.action]);
          if (represented.rowCount !== 1) throw new AdmissionDenied('representation is not admitted');
          const granted = await client.query(
            `SELECT id FROM access.permission_grant
             WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3
               AND active AND valid_until > clock_timestamp()
             ORDER BY id LIMIT 1 FOR SHARE`,
            [request.actingSubject, request.scope, request.action]);
          if (granted.rowCount !== 1) throw new AdmissionDenied('permission is not granted');
        }
      }

      if (existing) {
        if (existing.request_digest !== request.requestDigest
          || existing.acting_subject !== request.actingSubject
          || existing.authority_path !== authorityPath
          || existing.scope_id !== request.scope) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        await client.query('COMMIT');
        return {
          id: existing.id, principalId: existing.principal_id,
          actingSubject: existing.acting_subject, scope: existing.scope_id,
          authorityPath: existing.authority_path,
          action: existing.action, idempotencyKey: existing.idempotency_key,
          requestDigest: existing.request_digest,
          authorityEpoch: existing.authority_epoch,
          expiresAt: existing.expires_at.toISOString(),
          state: existing.state as RegisteredAdmission['state'],
          dispatchEligible: existing.state !== 'sealed' && existing.eligible,
          replayed: true,
        };
      }
      if (!gate.open) throw new AdmissionDenied('scope is closed');

      const id = Bun.randomUUIDv7();
      const inserted = await client.query<{ expires_at: Date }>(
        `INSERT INTO access.admission
           (id, principal_id, acting_subject, authority_path, direct_grant_id, attribution_id,
            direct_grant_generation, attribution_generation, direct_subject_generation,
            direct_principal_epoch, group_member_id, group_grant_id, group_generation,
            represented_representation_id, represented_representation_generation,
            represented_grant_id, represented_grant_generation,
            represented_subject_generation, represented_principal_epoch,
            role_binding_id, role_binding_generation, role_family_id, role_revision,
            scope_id, action, idempotency_key, request_digest, authority_epoch, expires_at, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
           $25, $26, $27, $28,
           clock_timestamp() + interval '30 seconds', 'registered')
         RETURNING expires_at`,
        [id, principalId, request.actingSubject, authorityPath, directGrantId, attributionId,
          directGrantGeneration, attributionGeneration, directSubjectGeneration,
          directPrincipalEpoch, groupMemberId, groupGrantId, groupGeneration,
          representedRepresentationId, representedRepresentationGeneration,
          representedGrantId, representedGrantGeneration,
          representedSubjectGeneration, representedPrincipalEpoch,
          roleBindingId, roleBindingGeneration, roleFamilyId, roleRevision,
          request.scope, request.action, request.idempotencyKey,
          request.requestDigest, gate.authority_epoch]);
      await client.query(
        `INSERT INTO access.admission_receipt
           (admission_id, principal_id, action, idempotency_key, request_digest, outcome)
         VALUES ($1, $2, $3, $4, $5, 'registered')`,
        [id, principalId, request.action, request.idempotencyKey, request.requestDigest]);
      await client.query(
        `INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
         VALUES ($1, 'admission.registered', $2, $3, $4)`,
        [Bun.randomUUIDv7(), id, request.scope, gate.authority_epoch]);
      await client.query('COMMIT');
      return {
        id, principalId, actingSubject: request.actingSubject, authorityPath,
        scope: request.scope, action: request.action, idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        authorityEpoch: gate.authority_epoch,
        expiresAt: inserted.rows[0]!.expires_at.toISOString(), state: 'registered',
        dispatchEligible: true, replayed: false,
      };
    } catch (error) {
      await rollback(client);
      if (error instanceof GroupUnavailable) throw new AdmissionUnavailable(error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Gate-first claim linearizes dispatch against a strong scope closure. */
  async claim(admissionId: string, requestDigest: string): Promise<ClaimedAdmission> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const locator = await client.query<{ scope_id: string }>(
        'SELECT scope_id FROM access.admission WHERE id = $1', [admissionId]);
      if (locator.rowCount !== 1) throw new AdmissionDenied('unknown admission');
      const scope = locator.rows[0]!.scope_id;
      const gateResult = await client.query<GateRow & { group_generation: string }>(
        'SELECT authority_epoch, group_generation, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [scope]);
      if (gateResult.rows[0]?.dispatch_open !== true) throw new AdmissionDenied('dispatch is fenced');
      const result = await client.query<AdmissionRow & { claimed_at: Date | null }>(
        `SELECT id, principal_id, acting_subject, authority_path, direct_grant_id,
                attribution_id, direct_grant_generation, attribution_generation,
                direct_subject_generation, direct_principal_epoch,
                group_member_id, group_grant_id, group_generation,
                represented_representation_id, represented_representation_generation,
                represented_grant_id, represented_grant_generation,
                represented_subject_generation, represented_principal_epoch,
                role_binding_id, role_binding_generation, role_family_id, role_revision,
                scope_id, action, idempotency_key,
                request_digest, authority_epoch, expires_at, state, claimed_at,
                (expires_at > clock_timestamp()) AS eligible
         FROM access.admission WHERE id = $1 FOR UPDATE`, [admissionId]);
      const row = result.rows[0];
      if (!row || row.scope_id !== scope || !row.eligible || !['registered', 'claimed'].includes(row.state)) {
        throw new AdmissionExpired('admission is not dispatchable');
      }
      if (row.authority_epoch !== gateResult.rows[0]?.authority_epoch) {
        throw new AdmissionDenied('admission scope epoch is stale');
      }
      const principal = await client.query<{ active: boolean; enforcement_epoch: string }>(
        'SELECT active, enforcement_epoch FROM access.principal WHERE id = $1 FOR SHARE',
        [row.principal_id]);
      if (principal.rows[0]?.active !== true) throw new AdmissionDenied('principal dispatch is fenced');
      if (row.authority_path === 'direct-principal') {
        if (principal.rows[0]?.enforcement_epoch !== row.direct_principal_epoch) {
          throw new AdmissionDenied('direct principal epoch is stale');
        }
        const proof = await client.query(`
          SELECT g.id FROM access.principal_permission_grant g
          JOIN access.principal_agent_attribution a ON a.id = $2
          JOIN access.authority_subject s ON s.id = a.agent_subject
          WHERE g.id = $1 AND g.principal_id = $3 AND g.scope_id = $4
            AND g.action = 'work.create' AND g.active AND g.valid_until > clock_timestamp()
            AND g.generation = $6
            AND (g.private_membership_id IS NULL OR EXISTS (
              SELECT 1 FROM access.private_membership m
              WHERE m.id = g.private_membership_id AND m.principal_id = $3
                AND m.state = 'joined' AND m.generation = g.private_membership_generation))
            AND a.principal_id = $3 AND a.agent_subject = $5
            AND a.action = 'work.create' AND a.active AND a.valid_until > clock_timestamp()
            AND a.generation = $7
            AND s.kind = 'agent' AND s.active
            AND s.generation = $8
          FOR SHARE OF g, a, s`,
        [row.direct_grant_id, row.attribution_id, row.principal_id,
          row.scope_id, row.acting_subject, row.direct_grant_generation,
          row.attribution_generation, row.direct_subject_generation]);
        if (proof.rowCount !== 1) throw new AdmissionDenied('direct authority was revoked');
      }
      if (row.authority_path === 'represented-agent'
        && row.action === 'work.create' && row.scope_id === 'work:create:root'
        && !await selectedRepresentedWorkProof(client, row,
          principal.rows[0]!.enforcement_epoch, gateResult.rows[0]!.group_generation)) {
        throw new AdmissionDenied('represented authority changed before claim');
      }
      if (row.request_digest !== requestDigest) throw new AdmissionConflict('claim digest differs');
      let claimedAt = row.claimed_at;
      if (row.state === 'registered') {
        const updated = await client.query<{ claimed_at: Date }>(
          "UPDATE access.admission SET state = 'claimed', claimed_at = clock_timestamp() WHERE id = $1 RETURNING claimed_at",
          [admissionId]);
        claimedAt = updated.rows[0]!.claimed_at;
        await client.query(
          `INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
           VALUES ($1, 'admission.claimed', $2, $3, $4)`,
          [Bun.randomUUIDv7(), admissionId, scope, row.authority_epoch]);
      }
      await client.query('COMMIT');
      return { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
        authorityPath: row.authority_path,
        scope, action: row.action, idempotencyKey: row.idempotency_key,
        requestDigest: row.request_digest, authorityEpoch: row.authority_epoch,
        expiresAt: row.expires_at.toISOString(), state: 'claimed', dispatchEligible: true,
        replayed: row.state === 'claimed',
        claimedAt: claimedAt!.toISOString() };
    } catch (error) {
      await rollback(client);
      if (error instanceof GroupUnavailable) throw new AdmissionUnavailable(error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Commits the strong fence; graph outcomes must still be sealed before completion. */
  async strongCloseScope(scope: string, expectedEpoch: string): Promise<StrongScopeClosure> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const result = await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [scope]);
      const gate = result.rows[0];
      if (!gate) throw new AdmissionUnavailable('scope gate is unavailable');
      let authorityEpoch = gate.authority_epoch;
      if (gate.dispatch_open) {
        if (gate.authority_epoch !== expectedEpoch) throw new AdmissionConflict('scope epoch changed');
        const changed = await client.query<{ authority_epoch: string }>(
          `UPDATE access.scope_gate SET open = false, dispatch_open = false,
                  authority_epoch = authority_epoch + 1 WHERE id = $1
           RETURNING authority_epoch`, [scope]);
        authorityEpoch = changed.rows[0]!.authority_epoch;
        await client.query(
          `INSERT INTO access.outbox (id, kind, scope_id, authority_epoch)
           VALUES ($1, 'scope.strong_closed', $2, $3)`,
          [Bun.randomUUIDv7(), scope, authorityEpoch]);
      }
      const pending = await client.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM access.admission WHERE scope_id = $1 AND state <> 'sealed'", [scope]);
      const pendingReads = await pendingSearchReads(client, 'scope_id', scope, true);
      await client.query('COMMIT');
      return { scope, authorityEpoch,
        pending: Number(pending.rows[0]?.count ?? '0') + pendingReads, pendingReads };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Commit the private principal fence; caller drains/seals pending graph outcomes. */
  async strongDeactivatePrincipal(
    principalId: string, expectedEpoch: string,
  ): Promise<StrongPrincipalDeactivation> {
    return this.deactivatePrincipal(principalId, expectedEpoch, false);
  }

  private async deactivatePrincipal(
    principalId: string, expectedEpoch: string, accountDeletion: boolean,
  ): Promise<StrongPrincipalDeactivation> {
    if (!/^[0-9a-f-]{36}$/.test(principalId) || !/^[0-9]+$/.test(expectedEpoch)) {
      throw new AdmissionDenied('invalid principal fence request');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const result = await client.query<{ active: boolean; enforcement_epoch: string }>(
        'SELECT active, enforcement_epoch FROM access.principal WHERE id = $1 FOR UPDATE',
        [principalId]);
      const principal = result.rows[0];
      if (!principal) throw new AdmissionUnavailable('principal is unavailable');
      let enforcementEpoch = principal.enforcement_epoch;
      if (principal.active) {
        if (enforcementEpoch !== expectedEpoch) throw new AdmissionConflict('principal epoch changed');
        const changed = await client.query<{ enforcement_epoch: string }>(
          `UPDATE access.principal SET active = false,
             enforcement_epoch = enforcement_epoch + 1 WHERE id = $1
           RETURNING enforcement_epoch`, [principalId]);
        enforcementEpoch = changed.rows[0]!.enforcement_epoch;
        await client.query(
          `INSERT INTO access.outbox (id, kind, principal_id, authority_epoch)
           VALUES ($1, 'principal.deactivated', $2, $3)`,
          [Bun.randomUUIDv7(), principalId, enforcementEpoch]);
      }
      if (accountDeletion) {
        await client.query(
          `INSERT INTO access.outbox (id, kind, principal_id, authority_epoch)
           VALUES ($1, 'account.deletion_fenced', $2, $3)
           ON CONFLICT (principal_id) WHERE kind = 'account.deletion_fenced' DO NOTHING`,
          [Bun.randomUUIDv7(), principalId, enforcementEpoch]);
        const marker = await client.query<{ authority_epoch: string }>(
          `SELECT authority_epoch FROM access.outbox
           WHERE kind = 'account.deletion_fenced' AND principal_id = $1`, [principalId]);
        if (marker.rows[0]?.authority_epoch !== enforcementEpoch) {
          throw new AdmissionConflict('Account deletion fence epoch changed');
        }
      }
      const pending = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM access.admission WHERE principal_id = $1 AND state <> 'sealed'",
        [principalId]);
      const pendingReads = await pendingSearchReads(client, 'principal_id', principalId, true);
      await client.query('COMMIT');
      return { principalId, enforcementEpoch,
        pending: Number(pending.rows[0]?.count ?? '0') + pendingReads, pendingReads };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Account deletion hook: fence an existing private binding before deleting credentials. */
  async strongDeactivateAccountSubject(
    issuer: string, subject: string,
  ): Promise<StrongPrincipalDeactivation | null> {
    if (!issuer || !subject) throw new AdmissionDenied('invalid Account binding');
    const client = await this.pool.connect();
    let principal: { id: string; enforcement_epoch: string } | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const result = await client.query<{ id: string; enforcement_epoch: string }>(
        `SELECT id, enforcement_epoch FROM access.principal
         WHERE account_issuer = $1 AND account_subject = $2`, [issuer, subject]);
      principal = result.rows[0];
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
    if (!principal) return null;
    return this.deactivatePrincipal(principal.id, principal.enforcement_epoch, true);
  }

  async listUnsealedPrincipal(principalId: string, limit = 100): Promise<RegisteredAdmission[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AdmissionDenied('invalid seal batch limit');
    const result = await this.pool.query<AdmissionRow>(
      `SELECT id, principal_id, acting_subject, scope_id, action, idempotency_key,
              request_digest, authority_epoch, expires_at, state,
              (expires_at > clock_timestamp()) AS eligible
       FROM access.admission WHERE principal_id = $1 AND state <> 'sealed'
       ORDER BY id LIMIT $2`, [principalId, limit]);
    return result.rows.map(row => ({ id: row.id, principalId: row.principal_id,
      actingSubject: row.acting_subject, scope: row.scope_id, action: row.action,
      idempotencyKey: row.idempotency_key, requestDigest: row.request_digest,
      authorityEpoch: row.authority_epoch,
      expiresAt: row.expires_at.toISOString(), state: row.state as RegisteredAdmission['state'],
      dispatchEligible: false, replayed: true }));
  }

  async listUnsealed(scope: string, limit = 100): Promise<RegisteredAdmission[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AdmissionDenied('invalid seal batch limit');
    const result = await this.pool.query<AdmissionRow>(
      `SELECT id, principal_id, acting_subject, scope_id, action, idempotency_key,
              request_digest, authority_epoch, expires_at, state,
              (expires_at > clock_timestamp()) AS eligible
       FROM access.admission WHERE scope_id = $1 AND state <> 'sealed'
       ORDER BY id LIMIT $2`, [scope, limit]);
    return result.rows.map(row => ({ id: row.id, principalId: row.principal_id,
      actingSubject: row.acting_subject, scope: row.scope_id, action: row.action,
      idempotencyKey: row.idempotency_key, requestDigest: row.request_digest,
      authorityEpoch: row.authority_epoch, expiresAt: row.expires_at.toISOString(),
      state: row.state as RegisteredAdmission['state'], dispatchEligible: row.eligible,
      replayed: true }));
  }

  /** The caller supplies a just-read terminal Jena receipt, not a timeout inference. */
  async recordGraphOutcome(admissionId: string, proof: GraphTerminalProof): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const locator = await client.query<{ scope_id: string }>(
        'SELECT scope_id FROM access.admission WHERE id = $1', [admissionId]);
      if (locator.rowCount !== 1) throw new AdmissionDenied('unknown admission');
      const scope = locator.rows[0]!.scope_id;
      const gate = await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [scope]);
      if (gate.rowCount !== 1) throw new AdmissionUnavailable('scope gate is unavailable');
      const result = await client.query<AdmissionRow & {
        graph_receipt: string | null; graph_outcome: string | null;
        graph_data_epoch: string | null; graph_sequence: string | null;
      }>(
        `SELECT id, principal_id, acting_subject, scope_id, action, idempotency_key,
                request_digest, authority_epoch, expires_at, state, graph_receipt,
                graph_outcome, graph_data_epoch, graph_sequence,
                (expires_at > clock_timestamp()) AS eligible
         FROM access.admission WHERE id = $1 FOR UPDATE`, [admissionId]);
      const row = result.rows[0];
      const receiptFamily = row?.action === 'work.create' ? 'create-metadata-work'
        : row?.action === 'address.claim' ? 'work-address-claim'
        : row?.action === 'address.rename' ? 'work-address-rename'
        : row?.action === 'address.dispose' ? 'work-address-disposition'
        : row?.action === 'content.draft' ? 'content-draft-save'
        : row?.action === 'content.comment' ? 'content-comment-create'
        : row?.action === 'content.publish' ? 'publish-content-revision'
        : row?.action === 'content.search-eligibility' ? 'content-search-eligibility'
        : row?.action === 'work.edit' ? 'edit-metadata-work'
          : row?.action === 'translation.link' || row?.action === 'translation.authorize'
            ? 'translation-link-v1'
          : row?.action === 'work.derive' ? 'work-derivation-v1'
          : row?.action === 'release.seal' ? 'fixed-native-text-release-v1'
          : row?.action === 'contribution.create' ? 'create-text-contribution'
            : row?.action === 'contribution.edit' ? 'edit-text-contribution'
              : row?.action === 'contribution.publish' ? 'publish-text-contribution'
                : row?.action === 'publication.select' ? 'select-main-default'
                  : row?.action === 'space.create' ? 'create-space-realm'
                    : row?.action === 'publication.adopt' ? 'select-realm-local'
                      : row?.action === 'publication.reject' ? 'reject-realm-local'
                        : row?.action === 'classification.context.configure'
                          ? 'classification-context-create'
                          : row?.action === 'classification.proposition.define'
                            ? 'classification-proposition-create'
                            : row?.action === 'classification.decision.set'
                              ? 'classification-direct-decision'
                              : row?.action === 'rating.context.create'
                                ? 'rating-context-create'
                                : row?.action === 'rating.observation.set'
                                  ? 'standing-rating-observation' : null;
      const expectedReceipt = receiptFamily && `urn:rezics:receipt:${createHash('sha256')
        .update(`${admissionId}\0${receiptFamily}`).digest('hex')}`;
      if (!row || row.scope_id !== scope || proof.admissionId !== admissionId
        || proof.scope !== scope || proof.requestDigest !== row.request_digest
        || proof.authorityEpoch !== row.authority_epoch
        || !receiptFamily || proof.receipt !== expectedReceipt
        || !/^[0-9]+$/.test(proof.sequence) || !proof.dataEpoch) {
        throw new AdmissionConflict('graph outcome does not match admission');
      }
      if (row.state === 'sealed') {
        if (row.graph_receipt !== proof.receipt || row.graph_outcome !== proof.outcome
          || row.graph_data_epoch !== proof.dataEpoch || row.graph_sequence !== proof.sequence) {
          throw new AdmissionConflict('admission has a different terminal graph outcome');
        }
        await client.query('COMMIT');
        return;
      }
      if (proof.outcome === 'succeeded' && row.state !== 'claimed') {
        throw new AdmissionConflict('unclaimed admission cannot succeed');
      }
      await client.query(
        `UPDATE access.admission SET state = 'sealed', graph_receipt = $2,
             graph_outcome = $3, graph_data_epoch = $4, graph_sequence = $5,
             sealed_at = clock_timestamp() WHERE id = $1`,
        [admissionId, proof.receipt, proof.outcome, proof.dataEpoch, proof.sequence]);
      await client.query(
        `INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
         VALUES ($1, 'admission.sealed', $2, $3, $4)`,
        [Bun.randomUUIDv7(), admissionId, scope, row.authority_epoch]);
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Ordinary closure fences new claims; already claimed work remains finite. */
  async closeScope(scope: string, expectedEpoch: string): Promise<{ authorityEpoch: string; pending: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const changed = await client.query<{ authority_epoch: string }>(
        `UPDATE access.scope_gate
         SET open = false, authority_epoch = authority_epoch + 1
         WHERE id = $1 AND authority_epoch = $2 AND open
         RETURNING authority_epoch`, [scope, expectedEpoch]);
      if (changed.rowCount !== 1) throw new AdmissionConflict('scope gate changed or was already closed');
      const epoch = changed.rows[0]!.authority_epoch;
      await client.query(
        `INSERT INTO access.outbox (id, kind, scope_id, authority_epoch)
         VALUES ($1, 'scope.closed', $2, $3)`, [Bun.randomUUIDv7(), scope, epoch]);
      const pending = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM access.admission
         WHERE scope_id = $1 AND state = 'registered' AND expires_at > clock_timestamp()`, [scope]);
      await client.query('COMMIT');
      return { authorityEpoch: epoch, pending: Number(pending.rows[0]?.count ?? '0') };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
