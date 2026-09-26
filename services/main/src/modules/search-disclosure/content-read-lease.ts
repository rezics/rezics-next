import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AdmissionConflict, AdmissionDenied, AdmissionExpired, AdmissionUnavailable,
  type VerifiedPrincipal } from '../access/admission.ts';

const resourceId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const variantId = /^urn:rezics:variant:[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f-]{36}$/;
const challenge = /^[0-9a-f]{64}$/;
export const CONTENT_SEARCH_ACCESS_COST = { admitSqlStatements: 15, deliverySqlStatements: 14,
  armSqlStatements: 14, finishSqlStatements: 2,
  pendingPerPrincipal: 16, pendingPerScope: 64 } as const;

interface LeaseRow {
  id: string; principal_id: string; acting_subject: string; scope_id: string;
  content_variant: string; content_resource: string; state: string;
  authority_epoch: string; principal_epoch: string; recovery_generation: string;
  subject_generation: string; representation_id: string; representation_generation: string;
  grant_id: string; grant_generation: string; expires_at: Date;
  send_started_at: Date | null; receipt_digest: string | null;
}
export interface ContentSearchReadLease {
  id: string; principalId: string; actingSubject: string; resource: string; variant: string;
  scope: string; expiresAt: string; state: 'admitted' | 'delivering';
}

function lease(row: LeaseRow): ContentSearchReadLease {
  return { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
    resource: row.content_resource, variant: row.content_variant, scope: row.scope_id,
    expiresAt: row.expires_at.toISOString(), state: row.state as ContentSearchReadLease['state'] };
}
async function rollback(client: PoolClient) {
  try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
}
async function recovery(client: PoolClient): Promise<string> {
  const row = (await client.query<{ open: boolean; generation: string }>(
    'SELECT open, generation FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
  if (!row?.open) throw new AdmissionUnavailable('Access recovery hold is active');
  return row.generation;
}

/** The same Access ledger as Contribution makes strong closure and recovery see
 * Content deliveries, while a separate target and work.read proof bind the variant. */
export class ContentSearchReadAccess {
  constructor(private readonly pool: Pool) {}

  async admit(principal: VerifiedPrincipal, actingSubject: string,
    resource: string, variant: string): Promise<ContentSearchReadLease> {
    if (!resourceId.test(resource) || !variantId.test(variant) || !resourceId.test(actingSubject)
      || !principal.issuer || !principal.subject) throw new AdmissionDenied('invalid Content search target');
    const scope = `work:read:${resource}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const generation = await recovery(client);
      const gate = (await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE',
        [scope])).rows[0];
      const identity = (await client.query<{ id: string; enforcement_epoch: string }>(
        `SELECT id, enforcement_epoch FROM access.principal WHERE account_issuer = $1
          AND account_subject = $2 AND active FOR UPDATE`, [principal.issuer, principal.subject])).rows[0];
      const subject = (await client.query<{ generation: string }>(
        'SELECT generation FROM access.authority_subject WHERE id = $1 AND active FOR SHARE',
        [actingSubject])).rows[0];
      const representation = (await client.query<{ id: string; generation: string; valid_until: Date }>(
        `SELECT id, generation, valid_until FROM access.representation
         WHERE principal_id = $1 AND subject_id = $2 AND action = 'work.read'
           AND active AND valid_until > clock_timestamp() + interval '1 second'
         ORDER BY id LIMIT 1 FOR SHARE`, [identity?.id, actingSubject])).rows[0];
      const grant = (await client.query<{ id: string; generation: string; valid_until: Date }>(
        `SELECT id, generation, valid_until FROM access.permission_grant
         WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.read'
           AND active AND valid_until > clock_timestamp() + interval '1 second'
         ORDER BY id LIMIT 1 FOR SHARE`, [actingSubject, scope])).rows[0];
      if (!gate?.open || !gate.dispatch_open || !identity || !subject || !representation || !grant) {
        throw new AdmissionDenied('Content search is not admitted');
      }
      for (const [column, value, max] of [['principal_id', identity.id, 16], ['scope_id', scope, 64]] as const) {
        await client.query(`UPDATE access.search_read_lease SET state = 'expired',
          finished_at = clock_timestamp() WHERE ${column} = $1 AND state = 'admitted'
          AND expires_at <= clock_timestamp()`, [value]);
        const pending = (await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM access.search_read_lease
           WHERE ${column} = $1 AND state IN ('admitted', 'delivering')`, [value])).rows[0];
        if (Number(pending?.count ?? 0) >= max) throw new AdmissionUnavailable('Content search capacity exceeded');
      }
      const inserted = await client.query<LeaseRow>(`WITH deadline AS (
        SELECT LEAST(clock_timestamp() + interval '10 seconds', $15::timestamptz, $16::timestamptz) AS expires_at
      ) INSERT INTO access.search_read_lease
        (id, principal_id, acting_subject, contribution, target_kind, content_variant, content_resource,
         scope_id, representation_id, grant_id, authority_epoch, principal_epoch,
         recovery_generation, subject_generation, representation_generation,
         grant_generation, expires_at, state)
      SELECT $1, $2, $3, NULL, 'content-variant', $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, deadline.expires_at, 'admitted'
      FROM deadline WHERE deadline.expires_at > clock_timestamp() + interval '1 second'
      RETURNING *`, [Bun.randomUUIDv7(), identity.id, actingSubject, variant, resource, scope,
        representation.id, grant.id, gate.authority_epoch, identity.enforcement_epoch,
        generation, subject.generation, representation.generation, grant.generation,
        representation.valid_until, grant.valid_until]);
      if (!inserted.rows[0]) throw new AdmissionExpired('Content search authority expires too soon');
      await client.query('COMMIT');
      return lease(inserted.rows[0]);
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  private async verify(client: PoolClient, row: LeaseRow, principal: VerifiedPrincipal,
    actingSubject: string, resource: string, variant: string, requiredState: 'admitted' | 'delivering') {
    const generation = await recovery(client);
    const gate = (await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
      'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
      [row.scope_id])).rows[0];
    const identity = (await client.query<{ id: string; enforcement_epoch: string; active: boolean }>(
      `SELECT id, enforcement_epoch, active FROM access.principal WHERE id = $1
       AND account_issuer = $2 AND account_subject = $3 FOR SHARE`,
      [row.principal_id, principal.issuer, principal.subject])).rows[0];
    if (!gate?.open || !gate.dispatch_open || !identity?.active || row.state !== requiredState
      || row.content_resource !== resource || row.content_variant !== variant
      || row.scope_id !== `work:read:${resource}` || row.acting_subject !== actingSubject
      || row.authority_epoch !== gate.authority_epoch || row.principal_epoch !== identity.enforcement_epoch
      || row.recovery_generation !== generation) throw new AdmissionDenied('Content search delivery is fenced');
    if (row.expires_at.getTime() <= Date.now()) throw new AdmissionExpired('Content search lease expired');
    const proof = await client.query(`SELECT s.id FROM access.authority_subject s
      JOIN access.representation r ON r.id = $2
      JOIN access.permission_grant g ON g.id = $3
      WHERE s.id = $1 AND s.active AND s.generation = $4
        AND r.principal_id = $5 AND r.subject_id = s.id AND r.action = 'work.read'
        AND r.active AND r.generation = $6 AND r.valid_until > clock_timestamp()
        AND g.recipient_subject = s.id AND g.scope_id = $7 AND g.action = 'work.read'
        AND g.active AND g.generation = $8 AND g.valid_until > clock_timestamp()
      FOR SHARE OF s, r, g`, [actingSubject, row.representation_id, row.grant_id,
      row.subject_generation, identity.id, row.representation_generation,
      row.scope_id, row.grant_generation]);
    if (proof.rowCount !== 1) throw new AdmissionDenied('Content search authority changed');
  }

  /** Scope and principal locks precede the lease lock, matching strong closure. */
  private async lockLocator(client: PoolClient, id: string) {
    await recovery(client);
    const locator = (await client.query<{ scope_id: string; principal_id: string }>(
      `SELECT scope_id, principal_id FROM access.search_read_lease
       WHERE id = $1 AND target_kind = 'content-variant'`, [id])).rows[0];
    if (!locator) throw new AdmissionDenied('Content search lease is unavailable');
    await client.query('SELECT id FROM access.scope_gate WHERE id = $1 FOR SHARE', [locator.scope_id]);
    await client.query('SELECT id FROM access.principal WHERE id = $1 FOR SHARE', [locator.principal_id]);
    return locator;
  }

  async begin(id: string, principal: VerifiedPrincipal, actingSubject: string,
    resource: string, variant: string): Promise<ContentSearchReadLease> {
    if (!uuid.test(id) || !resourceId.test(actingSubject) || !resourceId.test(resource)
      || !variantId.test(variant)) throw new AdmissionDenied('invalid Content search delivery');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await this.lockLocator(client, id);
      const row = (await client.query<LeaseRow>(
        `SELECT * FROM access.search_read_lease WHERE id = $1 AND target_kind = 'content-variant'
         FOR UPDATE`, [id])).rows[0];
      if (!row) throw new AdmissionDenied('Content search lease is unavailable');
      await this.verify(client, row, principal, actingSubject, resource, variant, 'admitted');
      const started = (await client.query<LeaseRow>(`UPDATE access.search_read_lease
        SET state = 'delivering', delivery_started_at = clock_timestamp()
        WHERE id = $1 AND state = 'admitted' AND expires_at > clock_timestamp() RETURNING *`, [id])).rows[0];
      if (!started) throw new AdmissionExpired('Content search lease expired');
      await client.query('COMMIT');
      return lease(started);
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  async arm(id: string, token: string, principal: VerifiedPrincipal,
    actingSubject: string, resource: string, variant: string): Promise<void> {
    if (!uuid.test(id) || !challenge.test(token)) throw new AdmissionDenied('invalid Content search challenge');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await this.lockLocator(client, id);
      const row = (await client.query<LeaseRow>(
        `SELECT * FROM access.search_read_lease WHERE id = $1 AND target_kind = 'content-variant'
         FOR UPDATE`, [id])).rows[0];
      if (!row || row.send_started_at) throw new AdmissionDenied('Content search send is unavailable');
      await this.verify(client, row, principal, actingSubject, resource, variant, 'delivering');
      const digest = createHash('sha256').update(token).digest('hex');
      const armed = await client.query(`UPDATE access.search_read_lease SET
        send_started_at = clock_timestamp(), receipt_digest = $2
        WHERE id = $1 AND state = 'delivering' AND send_started_at IS NULL
          AND expires_at > clock_timestamp()`, [id, digest]);
      if (armed.rowCount !== 1) throw new AdmissionConflict('Content search send cannot be armed');
      await client.query('COMMIT');
    } catch (error) { await rollback(client); throw error; }
    finally { client.release(); }
  }

  async finish(id: string, outcome: 'delivered' | 'aborted', token?: string): Promise<void> {
    if (!uuid.test(id) || (outcome === 'delivered' && !challenge.test(token ?? ''))
      || (outcome === 'aborted' && token !== undefined)) throw new AdmissionDenied('invalid Content search finish');
    const digest = token && createHash('sha256').update(token).digest('hex');
    const finished = await this.pool.query(`UPDATE access.search_read_lease
      SET state = $2, finished_at = clock_timestamp()
      WHERE id = $1 AND target_kind = 'content-variant' AND state IN ('admitted', 'delivering')
        AND (($2 = 'aborted' AND send_started_at IS NULL)
          OR ($2 = 'delivered' AND state = 'delivering'
            AND send_started_at IS NOT NULL AND receipt_digest = $3))`, [id, outcome, digest ?? null]);
    if (finished.rowCount === 1) return;
    const prior = (await this.pool.query<{ state: string; receipt_digest: string | null }>(
      `SELECT state, receipt_digest FROM access.search_read_lease
       WHERE id = $1 AND target_kind = 'content-variant'`, [id])).rows[0];
    if (prior?.state !== outcome || (outcome === 'delivered' && prior.receipt_digest !== digest)) {
      throw new AdmissionConflict('Content search finish conflicts with lease');
    }
  }
}
