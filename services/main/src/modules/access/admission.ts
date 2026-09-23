import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

/** Populated only by Account assertion verification, never from a request body. */
export interface VerifiedPrincipal {
  issuer: string;
  subject: string;
}

export interface AdmissionRequest {
  principal: VerifiedPrincipal;
  actingSubject: string;
  scope: string;
  action: string;
  idempotencyKey: string;
  requestDigest: string;
}

export interface RegisteredAdmission {
  id: string;
  principalId: string;
  actingSubject: string;
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
  pending: number;
}

export interface StrongPrincipalDeactivation {
  principalId: string;
  enforcementEpoch: string;
  pending: number;
}

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
interface AdmissionRow {
  id: string;
  principal_id: string;
  acting_subject: string;
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

async function requireRecoveryOpen(client: PoolClient): Promise<void> {
  const result = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (result.rows[0]?.open !== true) throw new AdmissionUnavailable('Access is held for recovery');
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
     WHERE id = true AND open = false AND generation = $1`, [generation]);
  if (result.rowCount !== 1) throw new AdmissionUnavailable('Access recovery fence changed');
}

export class AccessAdmissionRegistry {
  constructor(private readonly pool: Pool) {}

  /** Current Work-specific disclosure decision; no historical grant is reused. */
  async canReadWork(principal: VerifiedPrincipal, actingSubject: string, work: string): Promise<boolean> {
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(actingSubject)) return false;
    return this.canReadScopedResource(principal, actingSubject, `work:read:${work}`, 'work.read');
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
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(request.idempotencyKey)
      || !/^[a-z][a-z0-9.:-]{1,127}$/.test(request.action)
      || !/^[0-9a-f]{64}$/.test(request.requestDigest)) {
      throw new AdmissionDenied('invalid admission request');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await requireRecoveryOpen(client);
      const gateResult = await client.query<GateRow>(
        'SELECT authority_epoch, open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [request.scope]);
      const gate = gateResult.rows[0];
      if (!gate) throw new AdmissionUnavailable('scope gate is unavailable');

      const principalResult = await client.query<{ id: string; active: boolean }>(
        `SELECT id, active FROM access.principal
         WHERE account_issuer = $1 AND account_subject = $2 FOR SHARE`,
        [request.principal.issuer, request.principal.subject]);
      const principal = principalResult.rows[0];
      if (principal?.active !== true) throw new AdmissionDenied('principal is not admitted');
      const principalId = principal.id;

      const existingResult = await client.query<AdmissionRow>(
        `SELECT id, principal_id, acting_subject, scope_id, action, idempotency_key, request_digest,
                authority_epoch, expires_at, state, (expires_at > clock_timestamp()) AS eligible
         FROM access.admission
         WHERE principal_id = $1 AND action = $2 AND idempotency_key = $3`,
        [principalId, request.action, request.idempotencyKey]);
      const existing = existingResult.rows[0];

      const subject = await client.query<{ active: boolean }>(
        'SELECT active FROM access.authority_subject WHERE id = $1 FOR SHARE', [request.actingSubject]);
      if (subject.rows[0]?.active !== true) throw new AdmissionDenied('acting subject is not active');
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

      if (existing) {
        if (existing.request_digest !== request.requestDigest
          || existing.acting_subject !== request.actingSubject
          || existing.scope_id !== request.scope) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        await client.query('COMMIT');
        return {
          id: existing.id, principalId: existing.principal_id,
          actingSubject: existing.acting_subject, scope: existing.scope_id,
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
           (id, principal_id, acting_subject, scope_id, action, idempotency_key,
            request_digest, authority_epoch, expires_at, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp() + interval '30 seconds', 'registered')
         RETURNING expires_at`,
        [id, principalId, request.actingSubject, request.scope,
          request.action, request.idempotencyKey, request.requestDigest, gate.authority_epoch]);
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
        id, principalId, actingSubject: request.actingSubject,
        scope: request.scope, action: request.action, idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        authorityEpoch: gate.authority_epoch,
        expiresAt: inserted.rows[0]!.expires_at.toISOString(), state: 'registered',
        dispatchEligible: true, replayed: false,
      };
    } catch (error) {
      await rollback(client);
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
      const gateResult = await client.query<GateRow>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [scope]);
      if (gateResult.rows[0]?.dispatch_open !== true) throw new AdmissionDenied('dispatch is fenced');
      const result = await client.query<AdmissionRow & { claimed_at: Date | null }>(
        `SELECT id, principal_id, acting_subject, scope_id, action, idempotency_key,
                request_digest, authority_epoch, expires_at, state, claimed_at,
                (expires_at > clock_timestamp()) AS eligible
         FROM access.admission WHERE id = $1 FOR UPDATE`, [admissionId]);
      const row = result.rows[0];
      if (!row || row.scope_id !== scope || !row.eligible || !['registered', 'claimed'].includes(row.state)) {
        throw new AdmissionExpired('admission is not dispatchable');
      }
      const principal = await client.query<{ active: boolean }>(
        'SELECT active FROM access.principal WHERE id = $1 FOR SHARE', [row.principal_id]);
      if (principal.rows[0]?.active !== true) throw new AdmissionDenied('principal dispatch is fenced');
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
        scope, action: row.action, idempotencyKey: row.idempotency_key,
        requestDigest: row.request_digest, authorityEpoch: row.authority_epoch,
        expiresAt: row.expires_at.toISOString(), state: 'claimed', dispatchEligible: true,
        replayed: row.state === 'claimed',
        claimedAt: claimedAt!.toISOString() };
    } catch (error) {
      await rollback(client);
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
      await client.query('COMMIT');
      return { scope, authorityEpoch, pending: Number(pending.rows[0]?.count ?? '0') };
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
      await client.query('COMMIT');
      return { principalId, enforcementEpoch, pending: Number(pending.rows[0]?.count ?? '0') };
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
        : row?.action === 'work.edit' ? 'edit-metadata-work'
          : row?.action === 'contribution.create' ? 'create-text-contribution'
            : row?.action === 'contribution.edit' ? 'edit-text-contribution'
              : row?.action === 'contribution.publish' ? 'publish-text-contribution' : null;
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

  /** Ordinary closure fences new admissions; already registered work remains finite. */
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
