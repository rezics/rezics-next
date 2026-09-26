import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';

export class PrivateRecipientDenied extends Error {}
export class PrivateRecipientConflict extends Error {}
export class PrivateRecipientStale extends Error {}
export class PrivateRecipientUnavailable extends Error {}

const SCOPE = 'work:create:root';
const agent = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const epoch = /^(0|[1-9][0-9]*)$/;
type Common = { principal: VerifiedPrincipal; issuerSubject: string;
  expectedAuthorityEpoch: string; idempotencyKey: string; requestDigest: string };
export type PrivateRecipientChange = Common & (
  { action: 'add-group-member'; memberId: string; groupId: string;
    membershipId: string; membershipGeneration: string; expectedGroupGeneration: string }
  | { action: 'revoke-group-member'; memberId: string; expectedObjectGeneration: string;
    expectedGroupGeneration: string }
  | { action: 'bind-role'; bindingId: string; familyId: string; roleRevision: string;
    membershipId: string; membershipGeneration: string; validUntil: Date }
  | { action: 'revoke-role'; bindingId: string; expectedObjectGeneration: string }
);
export interface PrivateRecipientResult {
  action: PrivateRecipientChange['action'];
  objectId: string;
  authorityEpoch: string;
  groupGeneration: string;
  replayed: boolean;
}

/** Manager-facing owner. Membership IDs are opaque episode references; Account
 * identities and private group/role rosters never leave Access. */
export class AccessPrivateRecipients {
  constructor(private readonly pool: Pool) {}

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);
      if (code === '23505') return new PrivateRecipientConflict('private recipient identity conflicts');
      if (code === '23503' || code === '23514') {
        return new PrivateRecipientDenied('private recipient dependency is unavailable');
      }
      if (['40001', '40P01', '55P03', '57014'].includes(code)) {
        return new PrivateRecipientUnavailable('private recipient owner timed out');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private valid(input: PrivateRecipientChange): boolean {
    if (!agent.test(input.issuerSubject) || !epoch.test(input.expectedAuthorityEpoch)
      || !input.idempotencyKey || input.idempotencyKey.length > 128
      || input.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(input.requestDigest)) return false;
    switch (input.action) {
      case 'add-group-member': return uuid.test(input.memberId) && uuid.test(input.groupId)
        && uuid.test(input.membershipId) && epoch.test(input.membershipGeneration)
        && epoch.test(input.expectedGroupGeneration);
      case 'revoke-group-member': return uuid.test(input.memberId)
        && epoch.test(input.expectedObjectGeneration) && epoch.test(input.expectedGroupGeneration);
      case 'bind-role': return uuid.test(input.bindingId) && uuid.test(input.familyId)
        && uuid.test(input.membershipId) && epoch.test(input.membershipGeneration)
        && epoch.test(input.roleRevision) && !Number.isNaN(input.validUntil.getTime());
      case 'revoke-role': return uuid.test(input.bindingId)
        && epoch.test(input.expectedObjectGeneration);
    }
  }

  private async authorize(client: PoolClient, input: PrivateRecipientChange): Promise<string> {
    const action = input.action === 'add-group-member' || input.action === 'revoke-group-member'
      ? 'access.group.manage' : 'access.role.bind';
    const manager = await client.query<{ id: string }>(`SELECT p.id FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.subject_id = $3 AND r.action = $4 AND r.active
        AND r.valid_until > clock_timestamp() AND s.kind = 'agent' AND s.active
        AND EXISTS (SELECT 1 FROM access.permission_grant g
          WHERE g.recipient_subject = $3 AND g.scope_id = $5 AND g.action = $4
            AND g.active AND g.valid_until > clock_timestamp())
      ORDER BY p.id LIMIT 1 FOR SHARE OF p, r, s`,
    [input.principal.issuer, input.principal.subject, input.issuerSubject, action, SCOPE]);
    if (!manager.rows[0]) throw new PrivateRecipientDenied('private recipient manager is unavailable');
    return manager.rows[0].id;
  }

  private async recipient(client: PoolClient, input: Extract<PrivateRecipientChange,
    { action: 'add-group-member' | 'bind-role' }>): Promise<string> {
    const row = await client.query<{ principal_id: string }>(`SELECT m.principal_id
      FROM access.private_membership m JOIN access.principal p ON p.id = m.principal_id
      WHERE m.id = $1 AND m.generation = $2 AND m.owner_subject = $3
        AND m.state = 'joined' AND p.active FOR SHARE OF m, p`,
    [input.membershipId, input.membershipGeneration, input.issuerSubject]);
    if (!row.rows[0]) throw new PrivateRecipientDenied('private recipient episode is unavailable');
    return row.rows[0].principal_id;
  }

  async change(input: PrivateRecipientChange): Promise<PrivateRecipientResult> {
    if (!this.valid(input)) throw new PrivateRecipientDenied('invalid private recipient change');
    const objectId = input.action === 'add-group-member' || input.action === 'revoke-group-member'
      ? input.memberId : input.bindingId;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (!recovery.rows[0]?.open) throw new PrivateRecipientUnavailable('Access recovery held');
      const gate = await client.query<{ authority_epoch: string; group_generation: string;
        open: boolean; dispatch_open: boolean }>(`SELECT authority_epoch, group_generation,
        open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE`, [SCOPE]);
      if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
        throw new PrivateRecipientDenied('private recipient scope is closed');
      }
      const managerId = await this.authorize(client, input);
      const prior = await client.query<{ request_digest: string; action: string;
        object_id: string; result_authority_epoch: string; result_group_generation: string }>(`
        SELECT request_digest, action, object_id, result_authority_epoch,
          result_group_generation FROM access.private_recipient_change_receipt
        WHERE principal_id = $1 AND idempotency_key = $2 FOR SHARE`,
      [managerId, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== input.requestDigest
          || prior.rows[0].action !== input.action || prior.rows[0].object_id !== objectId) {
          throw new PrivateRecipientConflict('private recipient key binds another intent');
        }
        await client.query('COMMIT');
        return { action: input.action, objectId, authorityEpoch: prior.rows[0].result_authority_epoch,
          groupGeneration: prior.rows[0].result_group_generation, replayed: true };
      }
      if (gate.rows[0].authority_epoch !== input.expectedAuthorityEpoch) {
        throw new PrivateRecipientStale('private recipient authority epoch changed');
      }
      if ((input.action === 'add-group-member' || input.action === 'revoke-group-member')
        && gate.rows[0].group_generation !== input.expectedGroupGeneration) {
        throw new PrivateRecipientStale('private recipient group generation changed');
      }
      switch (input.action) {
        case 'add-group-member': {
          const principalId = await this.recipient(client, input);
          const group = await client.query(`SELECT id FROM access.recipient_group
            WHERE id = $1 AND scope_id = $2 FOR SHARE`, [input.groupId, SCOPE]);
          if (!group.rows[0]) throw new PrivateRecipientDenied('private recipient group unavailable');
          const ceiling = await client.query(`SELECT id FROM access.permission_grant
            WHERE recipient_subject = $1 AND scope_id = $2
              AND action = 'access.group.assign.work.create' AND active
              AND valid_until > clock_timestamp() LIMIT 1 FOR SHARE`,
          [input.issuerSubject, SCOPE]);
          if (!ceiling.rows[0]) throw new PrivateRecipientDenied('group assignment ceiling missing');
          const count = await client.query(`SELECT id FROM access.private_group_member
            WHERE principal_id = $1 AND active LIMIT 17`, [principalId]);
          if (count.rows.length >= 16) throw new PrivateRecipientUnavailable('private group member limit reached');
          const scopeCount = await client.query(`SELECT m.id FROM access.private_group_member m
            JOIN access.recipient_group g ON g.id = m.group_id
            WHERE g.scope_id = $1 AND m.active LIMIT 1025`, [SCOPE]);
          if (scopeCount.rows.length >= 1024) {
            throw new PrivateRecipientUnavailable('private group scope limit reached');
          }
          await client.query(`INSERT INTO access.private_group_member
            (id, group_id, principal_id, private_membership_id,
              private_membership_generation, assigned_by_principal)
            VALUES ($1,$2,$3,$4,$5,$6)`,
          [objectId, input.groupId, principalId, input.membershipId,
            input.membershipGeneration, managerId]);
          break;
        }
        case 'revoke-group-member': {
          const row = await client.query<{ generation: string; active: boolean }>(`
            SELECT m.generation, m.active FROM access.private_group_member m
            JOIN access.private_membership dep ON dep.id = m.private_membership_id
            WHERE m.id = $1 AND dep.owner_subject = $2 FOR UPDATE OF m`,
          [objectId, input.issuerSubject]);
          if (!row.rows[0]) throw new PrivateRecipientDenied('private group member unavailable');
          if (row.rows[0].generation !== input.expectedObjectGeneration) {
            throw new PrivateRecipientStale('private group member generation changed');
          }
          if (!row.rows[0].active) throw new PrivateRecipientDenied('private group member is inactive');
          await client.query(`UPDATE access.private_group_member
            SET active = false, generation = generation + 1 WHERE id = $1`, [objectId]);
          break;
        }
        case 'bind-role': {
          if (input.validUntil.getTime() <= Date.now()) {
            throw new PrivateRecipientDenied('private role validity ended');
          }
          const principalId = await this.recipient(client, input);
          const revision = await client.query<{ permissions: string[] }>(`
            SELECT r.permissions FROM access.role_revision r
            JOIN access.role_family f ON f.id = r.family_id
            WHERE r.family_id = $1 AND r.revision = $2 AND f.owner_subject = $3
              AND f.scope_id = $4 FOR SHARE OF r, f`,
          [input.familyId, input.roleRevision, input.issuerSubject, SCOPE]);
          if (!revision.rows[0] || !revision.rows[0].permissions.includes('work.create')) {
            throw new PrivateRecipientDenied('private role revision has no supported permission');
          }
          const ceiling = await client.query(`SELECT id FROM access.permission_grant
            WHERE recipient_subject = $1 AND scope_id = $2
              AND action = 'access.grant.assign.work.create' AND active
              AND valid_until >= $3 AND valid_until > clock_timestamp()
            ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
          [input.issuerSubject, SCOPE, input.validUntil]);
          if (!ceiling.rows[0]) throw new PrivateRecipientDenied('role assignment ceiling missing');
          const count = await client.query(`SELECT id FROM access.private_role_binding
            WHERE principal_id = $1 AND active LIMIT 17`,
          [principalId]);
          if (count.rows.length >= 16) throw new PrivateRecipientUnavailable('private role limit reached');
          await client.query(`INSERT INTO access.private_role_binding
            (id, family_id, role_revision, issuer_subject, principal_id,
              private_membership_id, private_membership_generation, valid_until,
              assigned_by_principal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [objectId, input.familyId, input.roleRevision, input.issuerSubject,
            principalId, input.membershipId, input.membershipGeneration,
            input.validUntil, managerId]);
          break;
        }
        case 'revoke-role': {
          const row = await client.query<{ generation: string; active: boolean }>(`
            SELECT generation, active FROM access.private_role_binding
            WHERE id = $1 AND issuer_subject = $2 FOR UPDATE`,
          [objectId, input.issuerSubject]);
          if (!row.rows[0]) throw new PrivateRecipientDenied('private role binding unavailable');
          if (row.rows[0].generation !== input.expectedObjectGeneration) {
            throw new PrivateRecipientStale('private role binding generation changed');
          }
          if (!row.rows[0].active) throw new PrivateRecipientDenied('private role binding is inactive');
          await client.query(`UPDATE access.private_role_binding
            SET active = false, generation = generation + 1 WHERE id = $1`, [objectId]);
          break;
        }
      }
      const bumped = await client.query<{ authority_epoch: string; group_generation: string }>(`
        UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
        WHERE id = $1 RETURNING authority_epoch, group_generation`, [SCOPE]);
      const result = bumped.rows[0]!;
      await client.query(`INSERT INTO access.private_recipient_change_receipt
        (principal_id, idempotency_key, request_digest, action, object_id,
          result_authority_epoch, result_group_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [managerId, input.idempotencyKey, input.requestDigest, input.action,
        objectId, result.authority_epoch, result.group_generation]);
      await client.query('COMMIT');
      return { action: input.action, objectId, authorityEpoch: result.authority_epoch,
        groupGeneration: result.group_generation, replayed: false };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* retain original failure */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }
}
