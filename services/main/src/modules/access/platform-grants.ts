import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import type { GrantReceipt } from './grants.ts';
import { lockAccessKey } from './scope-gates.ts';
import { PLATFORM_COST, PLATFORM_SCOPE, platformPermissionProof } from './platform-permissions.ts';

export class PlatformGrantDenied extends Error {}
export class PlatformGrantStale extends Error {}
export class PlatformGrantConflict extends Error {}
export class PlatformGrantUnavailable extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agent = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const permission =
  /^platform:(grant|use:[A-Za-z][A-Za-z0-9_.-]{0,99}|resource:[a-z][a-z0-9.-]{0,99})$/;
export interface PlatformGrantContext {
  principal: VerifiedPrincipal;
  issuerSubject: string;
  expectedAuthorityEpoch: string;
}
export type PlatformGrantRecipient =
  | { principalId: string; groupId?: never }
  | { groupId: string; principalId?: never };
export interface PlatformGrantView {
  id: string;
  issuerSubject: string;
  permission: string;
  scopeId: string;
  recipient: PlatformGrantRecipient;
  validUntil: string | null;
  active: boolean;
  generation: string;
  receipt: string;
}
export interface PlatformGrantResult {
  authorityEpoch: string;
  grant: PlatformGrantView;
}
type Row = {
  id: string;
  issuer_subject: string;
  permission: string;
  scope_id: string;
  principal_grant_id: string | null;
  group_grant_id: string | null;
  principal_id: string | null;
  group_id: string | null;
  valid_until: Date | null;
  active: boolean;
  generation: string;
  receipt: string;
};

const projection = `SELECT e.id,e.issuer_subject,e.permission,e.scope_id,e.principal_grant_id,e.group_grant_id,
  p.principal_id,g.group_id,COALESCE(p.active,g.active) AS active,
  COALESCE(p.generation,g.generation) AS generation,
  CASE WHEN COALESCE(p.valid_until,g.valid_until) = 'infinity' THEN NULL
    ELSE COALESCE(p.valid_until,g.valid_until) END AS valid_until,e.receipt
  FROM access.platform_grant_episode e LEFT JOIN access.principal_permission_grant p ON p.id = e.principal_grant_id
  LEFT JOIN access.group_permission_grant g ON g.id = e.group_grant_id`;
const view = (row: Row): PlatformGrantView => ({
  id: row.id,
  issuerSubject: row.issuer_subject,
  permission: row.permission,
  scopeId: row.scope_id,
  recipient: row.principal_id ? { principalId: row.principal_id } : { groupId: row.group_id! },
  validUntil: row.valid_until?.toISOString() ?? null,
  active: row.active,
  generation: row.generation,
  receipt: row.receipt,
});

/** Ordinary direct/group Access grants, with immutable issuance episodes and
 * receipts. Every mutation uses the issuer's current control and exact
 * assignment ceiling; holding platform:use never permits assignment.
 * A direct platform:grant confers access.grant.assign.platform on the
 * recipient's live agent for that grant's lifetime. Group grants confer none. */
export class AccessPlatformGrants {
  constructor(private readonly pool: Pool) {}

  private async authorize(
    client: PoolClient,
    principal: VerifiedPrincipal,
    issuerSubject: string,
    validUntil?: Date | null,
    resource?: { permission: string; scope: string },
  ) {
    const identity = (
      await client.query<{ id: string; representation_id: string; generation: string }>(
        `
      SELECT p.id,r.id AS representation_id,r.generation FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active AND s.active AND s.kind = 'agent'
        AND r.subject_id = $3 AND r.action IN ('agent.control','access.grant.assign.platform')
        AND r.active AND r.valid_until > clock_timestamp() ORDER BY r.id LIMIT 1 FOR SHARE OF p,r,s`,
        [principal.issuer, principal.subject, issuerSubject],
      )
    ).rows[0];
    if (!identity || !(await platformPermissionProof(client, identity.id, 'platform:grant'))) {
      throw new PlatformGrantDenied('Platform grant authority is missing');
    }
    let ceiling = (
      await client.query<{ id: string; generation: string }>(
        `SELECT id,generation FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'access.grant.assign.platform'
        AND active AND valid_until > clock_timestamp()
        AND valid_until >= COALESCE($3::timestamptz,'infinity'::timestamptz)
      ORDER BY valid_until DESC,id LIMIT 1 FOR SHARE`,
        [issuerSubject, PLATFORM_SCOPE, validUntil === undefined ? new Date() : validUntil],
      )
    ).rows[0];
    if (!ceiling)
      throw new PlatformGrantDenied('Platform assignment ceiling is missing or shorter');
    if (resource) {
      // Platform assignment never expands authority over a resource. The
      // ordinary resource assignment ceiling must cover the selected scope too.
      ceiling = (
        await client.query<{ id: string; generation: string }>(
          `SELECT id,generation FROM access.permission_grant
        WHERE recipient_subject = $1 AND action = $2 AND active
          AND (scope_id = $3 OR (right(scope_id,2) = ':*' AND starts_with($3,left(scope_id,length(scope_id)-1))))
          AND valid_until > clock_timestamp()
          AND valid_until >= COALESCE($4::timestamptz,'infinity'::timestamptz)
        ORDER BY valid_until DESC,id LIMIT 1 FOR SHARE`,
          [
            issuerSubject,
            `access.grant.assign.${resource.permission.slice('platform:resource:'.length)}`,
            resource.scope,
            validUntil === undefined ? new Date() : validUntil,
          ],
        )
      ).rows[0];
      if (!ceiling)
        throw new PlatformGrantDenied('Resource assignment ceiling is missing or shorter');
    }
    return { ...identity, ceiling };
  }

  /** One primary-key cursor page, <=51 retained episodes across all issuers. */
  async readPage(principal: VerifiedPrincipal, issuerSubject: string, after?: string) {
    if (!agent.test(issuerSubject) || (after && !uuid.test(after)))
      throw new PlatformGrantDenied('Invalid platform grant read');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.authorize(client, principal, issuerSubject);
      const epoch = (
        await client.query<{ authority_epoch: string }>(
          'SELECT authority_epoch FROM access.scope_gate WHERE id = $1',
          [PLATFORM_SCOPE],
        )
      ).rows[0]!.authority_epoch;
      const rows = (
        await client.query<Row>(
          `${projection}
        WHERE ($1::uuid IS NULL OR e.id > $1) ORDER BY e.id LIMIT 51`,
          [after ?? null],
        )
      ).rows;
      await client.query('COMMIT');
      return {
        authorityEpoch: epoch,
        grants: rows.slice(0, 50).map(view),
        nextCursor: rows.length > 50 ? rows[49]!.id : null,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readOne(
    principal: VerifiedPrincipal,
    issuerSubject: string,
    grantId: string,
  ): Promise<PlatformGrantResult> {
    if (!agent.test(issuerSubject) || !uuid.test(grantId))
      throw new PlatformGrantDenied('Invalid platform grant read');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.authorize(client, principal, issuerSubject);
      const row = (await client.query<Row>(`${projection} WHERE e.id = $1`, [grantId])).rows[0];
      if (!row) throw new PlatformGrantDenied('Platform grant is unavailable');
      const epoch = (
        await client.query<{ authority_epoch: string }>(
          'SELECT authority_epoch FROM access.scope_gate WHERE id = $1',
          [PLATFORM_SCOPE],
        )
      ).rows[0]!.authority_epoch;
      await client.query('COMMIT');
      return { authorityEpoch: epoch, grant: view(row) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async mutate(
    context: PlatformGrantContext,
    grantId: string,
    receipt: GrantReceipt,
    run: (
      client: PoolClient,
      issuer: Awaited<ReturnType<AccessPlatformGrants['authorize']>>,
    ) => Promise<void>,
    validUntil?: Date | null,
    resource?: { permission: string; scope: string },
    groupEffect = false,
  ): Promise<PlatformGrantResult> {
    if (
      !agent.test(context.issuerSubject) ||
      !uuid.test(grantId) ||
      !/^(0|[1-9][0-9]*)$/.test(context.expectedAuthorityEpoch) ||
      !/^[A-Za-z0-9:_./-]{1,128}$/.test(receipt.idempotencyKey) ||
      !/^[0-9a-f]{64}$/.test(receipt.requestDigest)
    ) {
      throw new PlatformGrantDenied('Invalid platform grant change');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = (
        await client.query<{ open: boolean }>(
          'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE',
        )
      ).rows[0];
      if (!recovery?.open) throw new PlatformGrantUnavailable('Access recovery is held');
      const gate = (
        await client.query<{ open: boolean; dispatch_open: boolean; authority_epoch: string }>(
          `
        SELECT open,dispatch_open,authority_epoch FROM access.scope_gate WHERE id = $1 FOR UPDATE`,
          [PLATFORM_SCOPE],
        )
      ).rows[0];
      if (!gate?.open || !gate.dispatch_open)
        throw new PlatformGrantUnavailable('Platform grant scope is held');
      // Group issuance inserts a group grant, whose protection guard takes the
      // inventory fence exclusively; take it before the group row and authority locks.
      if (groupEffect) {
        await client.query(
          "SELECT 1 FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE",
        );
        await client.query(
          "SELECT 1 FROM access.scope_gate WHERE id = 'access:group-inventory' FOR UPDATE",
        );
      }
      const issuer = await this.authorize(
        client,
        context.principal,
        context.issuerSubject,
        validUntil,
        resource,
      );
      await lockAccessKey(client, `platform-grant:${issuer.id}:${receipt.idempotencyKey}`);
      const prior = (
        await client.query<{
          request_digest: string;
          result: PlatformGrantResult;
          grant_id: string;
        }>(
          `
        SELECT request_digest,result,grant_id FROM access.platform_grant_change_receipt WHERE principal_id = $1 AND idempotency_key = $2`,
          [issuer.id, receipt.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_digest !== receipt.requestDigest || prior.grant_id !== grantId)
          throw new PlatformGrantConflict('Platform grant key binds another intent');
        await client.query('COMMIT');
        return prior.result;
      }
      if (gate.authority_epoch !== context.expectedAuthorityEpoch)
        throw new PlatformGrantStale('Platform grant generation changed');
      await run(client, issuer);
      const row = (await client.query<Row>(`${projection} WHERE e.id = $1`, [grantId])).rows[0]!;
      const epoch = (
        await client.query<{ authority_epoch: string }>(
          'SELECT authority_epoch FROM access.scope_gate WHERE id = $1',
          [PLATFORM_SCOPE],
        )
      ).rows[0]!.authority_epoch;
      const result = { authorityEpoch: epoch, grant: view(row) };
      await client.query(
        `INSERT INTO access.platform_grant_change_receipt(principal_id,idempotency_key,request_digest,grant_id,result)
        VALUES ($1,$2,$3,$4,$5)`,
        [issuer.id, receipt.idempotencyKey, receipt.requestDigest, grantId, JSON.stringify(result)],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === '23514')
        throw new PlatformGrantDenied(
          'Platform grant continuity or episode guard refused the change',
        );
      if (code === '23503')
        throw new PlatformGrantDenied('Platform grant recipient or authority is unavailable');
      if (code === '23505') throw new PlatformGrantConflict('Platform grant identifier conflicts');
      if (['40001', '40P01', '55P03', '57014'].includes(code))
        throw new PlatformGrantUnavailable('Platform grant change is unavailable');
      throw error;
    } finally {
      client.release();
    }
  }

  /** One indexed controller read and two inserts. No member fan-out. */
  private async conferAssignmentCeiling(
    client: PoolClient,
    issuerPrincipalId: string,
    grantId: string,
    principalId: string,
    validUntil: Date | null,
    issuerSubject: string,
  ) {
    const controller = (
      await client.query<{ subject_id: string }>(
        `SELECT r.subject_id FROM access.representation r
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE r.principal_id = $1 AND r.action = 'agent.control' AND r.active
        AND r.valid_until > clock_timestamp() AND s.kind = 'agent' AND s.active
      ORDER BY r.id LIMIT $2 FOR SHARE OF r,s`,
        [principalId, PLATFORM_COST.assignmentCeilingReads],
      )
    ).rows[0];
    if (!controller)
      throw new PlatformGrantDenied('Platform grant recipient has no live agent controller');
    const ceilingId = randomUUID();
    await client.query(
      `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
      VALUES ($1,$2,$3,$4,'access.grant.assign.platform',COALESCE($5::timestamptz,'infinity'::timestamptz),$6)`,
      [
        ceilingId,
        issuerSubject,
        controller.subject_id,
        PLATFORM_SCOPE,
        validUntil,
        issuerPrincipalId,
      ],
    );
    await client.query(
      'INSERT INTO access.platform_assignment_ceiling(grant_id,ceiling_id) VALUES ($1,$2)',
      [grantId, ceilingId],
    );
  }

  /** <=129 grants on one recipient plus exact controller/ceiling/receipt reads.
   * Finite leases and permanent governance anchors share the same episode.
   * A principal platform:grant writes its assignment ceiling in the same transaction. */
  create(
    context: PlatformGrantContext,
    grantId: string,
    action: string,
    recipient: PlatformGrantRecipient,
    validUntil: Date | null,
    receipt: GrantReceipt,
    scope = PLATFORM_SCOPE,
  ): Promise<PlatformGrantResult> {
    if (
      !permission.test(action) ||
      action.length > 128 ||
      !uuid.test(recipient.principalId ?? recipient.groupId ?? '') ||
      !!recipient.principalId === !!recipient.groupId ||
      (validUntil && !Number.isFinite(validUntil.getTime())) ||
      scope.length > 256 ||
      (action.startsWith('platform:resource:')
        ? !/^[^\s\0]{1,256}$/.test(scope)
        : scope !== PLATFORM_SCOPE)
    ) {
      throw new PlatformGrantDenied('Invalid platform permission, recipient or expiry');
    }
    return this.mutate(
      context,
      grantId,
      receipt,
      async (client, issuer) => {
        // A lost-response retry keeps its immutable receipt after expiry. Only
        // a new issuance must have a live deadline, measured by the owner clock.
        if (
          validUntil &&
          !(
            await client.query<{ live: boolean }>(
              'SELECT $1::timestamptz > clock_timestamp() AS live',
              [validUntil],
            )
          ).rows[0]?.live
        )
          throw new PlatformGrantDenied('Platform grant deadline has expired');
        const group = recipient.groupId
          ? (
              await client.query<{ scope_id: string }>(
                'SELECT scope_id FROM access.recipient_group WHERE id = $1 FOR SHARE',
                [recipient.groupId],
              )
            ).rows[0]
          : undefined;
        if (recipient.groupId && !group)
          throw new PlatformGrantDenied('Platform grant group is unavailable');
        if (
          recipient.groupId &&
          action.startsWith('platform:resource:') &&
          group?.scope_id !== scope
        )
          throw new PlatformGrantDenied('Group resource scope differs');
        const table = recipient.principalId
          ? 'principal_permission_grant'
          : 'group_permission_grant';
        const column = recipient.principalId ? 'principal_id' : 'group_id';
        const target = recipient.principalId ?? recipient.groupId!;
        const live = (
          await client.query(
            `SELECT id FROM access.${table} WHERE ${column} = $1
        AND action LIKE 'platform:%' AND active LIMIT $2`,
            [target, PLATFORM_COST.grants + 1],
          )
        ).rows;
        if (live.length >= PLATFORM_COST.grants)
          throw new PlatformGrantDenied('Platform recipient grant budget exceeded');
        const assignedScope = group?.scope_id ?? scope;
        await client.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [
          assignedScope,
        ]);
        await client.query(
          `INSERT INTO access.${table}(id,issuer_subject,${column},scope_id,action,valid_until)
        VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,'infinity'::timestamptz))`,
          [grantId, context.issuerSubject, target, assignedScope, action, validUntil],
        );
        const audit = `urn:rezics:access-receipt:${createHash('sha256')
          .update(JSON.stringify([issuer.id, receipt.idempotencyKey, receipt.requestDigest]))
          .digest('hex')}`;
        await client.query(
          `INSERT INTO access.platform_grant_episode(id,principal_grant_id,group_grant_id,issuer_subject,
        permission,scope_id,assigned_by_principal,representation_id,representation_generation,ceiling_grant_id,ceiling_generation,receipt)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            grantId,
            recipient.principalId ? grantId : null,
            recipient.groupId ? grantId : null,
            context.issuerSubject,
            action,
            assignedScope,
            issuer.id,
            issuer.representation_id,
            issuer.generation,
            issuer.ceiling.id,
            issuer.ceiling.generation,
            audit,
          ],
        );
        // The ceiling is this grant's lifetime, already refused when it would
        // outlast the issuer. Revocation and expiry clear it with the grant.
        if (action === 'platform:grant' && recipient.principalId)
          await this.conferAssignmentCeiling(
            client,
            issuer.id,
            grantId,
            recipient.principalId,
            validUntil,
            context.issuerSubject,
          );
      },
      validUntil,
      action.startsWith('platform:resource:') ? { permission: action, scope } : undefined,
      !!recipient.groupId,
    );
  }

  /** Any platform:grant holder may revoke any platform permission, including
   * one issued by another holder. A generation CAS retains the old episode. */
  revoke(
    context: PlatformGrantContext,
    grantId: string,
    expectedGeneration: string,
    receipt: GrantReceipt,
  ): Promise<PlatformGrantResult> {
    if (!/^(0|[1-9][0-9]*)$/.test(expectedGeneration))
      throw new PlatformGrantDenied('Invalid platform grant generation');
    return this.mutate(context, grantId, receipt, async (client) => {
      const episode = (await client.query<Row>(`${projection} WHERE e.id = $1`, [grantId])).rows[0];
      if (!episode) throw new PlatformGrantDenied('Platform grant is unavailable');
      if (episode.generation !== expectedGeneration)
        throw new PlatformGrantStale('Platform grant episode changed');
      if (!episode.active) return;
      const table = episode.principal_grant_id
        ? 'principal_permission_grant'
        : 'group_permission_grant';
      await client.query(
        `UPDATE access.${table} SET active = false,generation = generation + 1 WHERE id = $1`,
        [grantId],
      );
    });
  }
}
