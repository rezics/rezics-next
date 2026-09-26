import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { currentMembershipDependency, validMembershipDependency,
  type MembershipDependency } from './memberships.ts';

export class RoleDenied extends Error {}
export class RoleConflict extends Error {}
export class RoleStale extends Error {}
export class RoleUnavailable extends Error {}

const SCOPE = 'work:create:root';
const ASSIGN = 'access.grant.assign.work.create';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const epochPattern = /^(0|[1-9][0-9]*)$/;

export interface RoleContext {
  principal: VerifiedPrincipal;
  issuerSubject: string;
  expectedAuthorityEpoch: string;
  idempotencyKey: string;
  requestDigest: string;
}
export interface RoleFamily {
  id: string;
  ownerSubject: string;
  headRevision: string;
  revisions: { revision: string; permissions: string[] }[];
}
export interface RoleBinding {
  id: string;
  familyId: string;
  roleRevision: string;
  issuerSubject: string;
  recipientSubject: string;
  validUntil: string;
  active: boolean;
  generation: string;
  membershipDependency: MembershipDependency | null;
}
export interface RoleBindingPage {
  authorityEpoch: string;
  bindings: RoleBinding[];
  nextCursor: string | null;
}
type BindingRow = { id: string; family_id: string; role_revision: string;
  issuer_subject: string; recipient_subject: string; valid_until: Date;
  active: boolean; generation: string; membership_id: string | null;
  membership_generation: string | null };

/** Role revision and binding owner for the first exact work.create family. */
export class AccessRoles {
  constructor(private readonly pool: Pool) {}

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      if (String(error.code) === '23505') return new RoleConflict('role identity is already bound');
      if (['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        return new RoleUnavailable('role owner could not complete');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async begin(client: PoolClient): Promise<void> {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
  }

  private async gate(client: PoolClient, write: boolean): Promise<string> {
    const recovery = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (recovery.rows[0]?.open !== true) throw new RoleUnavailable('Access recovery is held');
    const gate = await client.query<{ authority_epoch: string; open: boolean;
      dispatch_open: boolean }>(`SELECT authority_epoch, open, dispatch_open
      FROM access.scope_gate WHERE id = $1 ${write ? 'FOR UPDATE' : 'FOR SHARE'}`, [SCOPE]);
    if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
      throw new RoleDenied('role scope is closed');
    }
    return gate.rows[0].authority_epoch;
  }

  private async authorize(client: PoolClient, principal: VerifiedPrincipal,
    issuerSubject: string, action: 'access.role.manage' | 'access.role.bind',
    assignUntil?: Date): Promise<string> {
    const actor = await client.query<{ id: string }>(`SELECT p.id FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.subject_id = $3 AND r.action = $4 AND r.active
        AND r.valid_until > clock_timestamp() AND s.kind = 'agent' AND s.active
      LIMIT 1 FOR SHARE OF p, r, s`,
    [principal.issuer, principal.subject, issuerSubject, action]);
    if (!actor.rows[0]) throw new RoleDenied('role administrator mandate is missing');
    const grant = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > clock_timestamp() LIMIT 1 FOR SHARE`, [issuerSubject, SCOPE, action]);
    if (!grant.rows[0]) throw new RoleDenied('role administrator grant is missing');
    if (assignUntil) {
      const ceiling = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
          AND valid_until >= $4 AND valid_until > clock_timestamp()
        ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
      [issuerSubject, SCOPE, ASSIGN, assignUntil]);
      if (!ceiling.rows[0]) throw new RoleDenied('role permission exceeds assignment ceiling');
    }
    return actor.rows[0].id;
  }

  private validPermissions(permissions: string[]): boolean {
    return permissions.length === 0
      || permissions.length === 1 && permissions[0] === 'work.create';
  }

  async readFamily(principal: VerifiedPrincipal, issuerSubject: string,
    familyId: string): Promise<RoleFamily> {
    if (!agentPattern.test(issuerSubject) || !idPattern.test(familyId)) {
      throw new RoleDenied('invalid role read');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      await this.gate(client, false);
      await this.authorize(client, principal, issuerSubject, 'access.role.manage');
      const family = await client.query<{ head_revision: string }>(`
        SELECT head_revision FROM access.role_family
        WHERE id = $1 AND owner_subject = $2 AND scope_id = $3`,
      [familyId, issuerSubject, SCOPE]);
      if (!family.rows[0]) throw new RoleDenied('role is unavailable to issuer');
      const revisions = await client.query<{ revision: string; permissions: string[] }>(`
        SELECT revision, permissions FROM access.role_revision
        WHERE family_id = $1 ORDER BY revision LIMIT 33`, [familyId]);
      if (revisions.rows.length > 32) throw new RoleUnavailable('role revision cap exceeded');
      await client.query('COMMIT');
      return { id: familyId, ownerSubject: issuerSubject,
        headRevision: family.rows[0].head_revision, revisions: revisions.rows };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  private async revise(context: RoleContext, familyId: string,
    expectedHead: string | null, permissions: string[]): Promise<string> {
    if (!agentPattern.test(context.issuerSubject) || !idPattern.test(familyId)
      || expectedHead !== null && !epochPattern.test(expectedHead)
      || !this.validPermissions(permissions) || !epochPattern.test(context.expectedAuthorityEpoch)
      || !context.idempotencyKey || context.idempotencyKey.length > 128
      || context.idempotencyKey.includes('\0')
      || !/^[0-9a-f]{64}$/.test(context.requestDigest)) {
      throw new RoleDenied('invalid role revision');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const authorityEpoch = await this.gate(client, true);
      const principalId = await this.authorize(client, context.principal,
        context.issuerSubject, 'access.role.manage',
        permissions.includes('work.create') ? new Date() : undefined);
      const prior = await client.query<{ request_digest: string; issuer_subject: string;
        family_id: string; revision: string }>(`SELECT request_digest, issuer_subject,
          family_id, revision FROM access.role_revision_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, context.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== context.requestDigest
          || prior.rows[0].issuer_subject !== context.issuerSubject
          || prior.rows[0].family_id !== familyId) {
          throw new RoleConflict('role revision key binds another intent');
        }
        await client.query('COMMIT');
        return prior.rows[0].revision;
      }
      if (authorityEpoch !== context.expectedAuthorityEpoch) {
        throw new RoleStale('role scope authority epoch changed');
      }
      let revision = '1';
      if (expectedHead === null) {
        await client.query(`INSERT INTO access.role_family
          (id, owner_subject, scope_id, head_revision) VALUES ($1,$2,$3,1)`,
        [familyId, context.issuerSubject, SCOPE]);
      } else {
        const family = await client.query<{ head_revision: string }>(`
          SELECT head_revision FROM access.role_family
          WHERE id = $1 AND owner_subject = $2 AND scope_id = $3 FOR UPDATE`,
        [familyId, context.issuerSubject, SCOPE]);
        if (!family.rows[0]) throw new RoleDenied('role is unavailable to issuer');
        if (family.rows[0].head_revision !== expectedHead) {
          throw new RoleStale('role head revision changed');
        }
        if (Number(expectedHead) >= 32) throw new RoleUnavailable('role revision cap reached');
        revision = String(Number(expectedHead) + 1);
      }
      await client.query(`INSERT INTO access.role_revision
        (family_id, revision, permissions) VALUES ($1,$2,$3::text[])`,
      [familyId, revision, permissions]);
      if (expectedHead !== null) {
        await client.query(`UPDATE access.role_family SET head_revision = $2 WHERE id = $1`,
        [familyId, revision]);
      }
      await client.query(`INSERT INTO access.role_revision_receipt
        (principal_id, idempotency_key, request_digest, issuer_subject,
          family_id, revision) VALUES ($1,$2,$3,$4,$5,$6)`,
      [principalId, context.idempotencyKey, context.requestDigest,
        context.issuerSubject, familyId, revision]);
      await client.query('COMMIT');
      return revision;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  createFamily(context: RoleContext, familyId: string,
    permissions: string[]): Promise<string> {
    return this.revise(context, familyId, null, permissions);
  }

  addRevision(context: RoleContext, familyId: string,
    expectedHead: string, permissions: string[]): Promise<string> {
    return this.revise(context, familyId, expectedHead, permissions);
  }

  private toBinding(row: BindingRow): RoleBinding {
    return { id: row.id, familyId: row.family_id, roleRevision: row.role_revision,
      issuerSubject: row.issuer_subject, recipientSubject: row.recipient_subject,
      validUntil: row.valid_until.toISOString(), active: row.active,
      generation: row.generation, membershipDependency: row.membership_id
        ? { membershipId: row.membership_id, generation: row.membership_generation! } : null };
  }

  async readBinding(principal: VerifiedPrincipal, issuerSubject: string,
    bindingId: string): Promise<{ authorityEpoch: string; binding: RoleBinding }> {
    if (!agentPattern.test(issuerSubject) || !idPattern.test(bindingId)) {
      throw new RoleDenied('invalid role binding read');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const authorityEpoch = await this.gate(client, false);
      await this.authorize(client, principal, issuerSubject, 'access.role.bind');
      const row = await client.query<BindingRow>(`SELECT id, family_id, role_revision,
        issuer_subject, recipient_subject, valid_until, active, generation,
        membership_id, membership_generation
        FROM access.role_binding WHERE id = $1 AND issuer_subject = $2`,
      [bindingId, issuerSubject]);
      if (!row.rows[0]) throw new RoleDenied('binding is unavailable to issuer');
      await client.query('COMMIT');
      return { authorityEpoch, binding: this.toBinding(row.rows[0]) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async readBindingPage(principal: VerifiedPrincipal, issuerSubject: string,
    after?: string): Promise<RoleBindingPage> {
    if (!agentPattern.test(issuerSubject) || after && !idPattern.test(after)) {
      throw new RoleDenied('invalid role binding page');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const authorityEpoch = await this.gate(client, false);
      await this.authorize(client, principal, issuerSubject, 'access.role.bind');
      const rows = await client.query<BindingRow>(`SELECT id, family_id, role_revision,
        issuer_subject, recipient_subject, valid_until, active, generation,
        membership_id, membership_generation
        FROM access.role_binding WHERE issuer_subject = $1
          AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT 51`,
      [issuerSubject, after ?? null]);
      await client.query('COMMIT');
      return { authorityEpoch, bindings: rows.rows.slice(0, 50).map(row => this.toBinding(row)),
        nextCursor: rows.rows.length > 50 ? rows.rows[49]!.id : null };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  private async mutateBinding(context: RoleContext, action: 'bind' | 'revoke',
    bindingId: string, work: (client: PoolClient, principalId: string) => Promise<void>):
    Promise<string> {
    if (!agentPattern.test(context.issuerSubject) || !idPattern.test(bindingId)
      || !epochPattern.test(context.expectedAuthorityEpoch)
      || !context.idempotencyKey || context.idempotencyKey.length > 128
      || context.idempotencyKey.includes('\0')
      || !/^[0-9a-f]{64}$/.test(context.requestDigest)) {
      throw new RoleDenied('invalid role binding change');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const authorityEpoch = await this.gate(client, true);
      const principalId = await this.authorize(client, context.principal,
        context.issuerSubject, 'access.role.bind');
      const prior = await client.query<{ request_digest: string; issuer_subject: string;
        action: string; binding_id: string; result_authority_epoch: string }>(`
        SELECT request_digest, issuer_subject, action, binding_id,
          result_authority_epoch FROM access.role_binding_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, context.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== context.requestDigest
          || prior.rows[0].issuer_subject !== context.issuerSubject
          || prior.rows[0].action !== action || prior.rows[0].binding_id !== bindingId) {
          throw new RoleConflict('binding key binds another intent');
        }
        await client.query('COMMIT');
        return prior.rows[0].result_authority_epoch;
      }
      if (authorityEpoch !== context.expectedAuthorityEpoch) {
        throw new RoleStale('role binding authority epoch changed');
      }
      await work(client, principalId);
      const bumped = await client.query<{ authority_epoch: string }>(`
        UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
        WHERE id = $1 RETURNING authority_epoch`, [SCOPE]);
      const resultEpoch = bumped.rows[0]!.authority_epoch;
      await client.query(`INSERT INTO access.role_binding_receipt
        (principal_id, idempotency_key, request_digest, issuer_subject,
          action, binding_id, result_authority_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [principalId, context.idempotencyKey, context.requestDigest,
        context.issuerSubject, action, bindingId, resultEpoch]);
      await client.query('COMMIT');
      return resultEpoch;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async bind(context: RoleContext, bindingId: string, familyId: string,
    roleRevision: string, recipientSubject: string, validUntil: Date,
    membershipDependency?: MembershipDependency): Promise<string> {
    if (!idPattern.test(familyId) || !epochPattern.test(roleRevision)
      || !agentPattern.test(recipientSubject) || Number.isNaN(validUntil.getTime())
      || !validMembershipDependency(membershipDependency)) {
      throw new RoleDenied('invalid role binding');
    }
    return this.mutateBinding(context, 'bind', bindingId, async (client, principalId) => {
      if (validUntil.getTime() <= Date.now()) throw new RoleDenied('binding validity ended');
      const revision = await client.query<{ permissions: string[] }>(`
        SELECT rr.permissions FROM access.role_revision rr
        JOIN access.role_family f ON f.id = rr.family_id
        WHERE rr.family_id = $1 AND rr.revision = $2
          AND f.owner_subject = $3 AND f.scope_id = $4`,
      [familyId, roleRevision, context.issuerSubject, SCOPE]);
      if (!revision.rows[0]) throw new RoleDenied('role revision is unavailable to issuer');
      if (revision.rows[0].permissions.includes('work.create')) {
        await this.authorize(client, context.principal, context.issuerSubject,
          'access.role.bind', validUntil);
      }
      const recipient = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [recipientSubject]);
      if (!recipient.rows[0]) throw new RoleDenied('binding recipient Agent is unavailable');
      if (membershipDependency && !await currentMembershipDependency(client,
        membershipDependency, recipientSubject)) {
        throw new RoleDenied('membership dependency is stale');
      }
      const existing = await client.query(`SELECT id FROM access.role_binding
        WHERE recipient_subject = $1 AND active
          AND valid_until > clock_timestamp() LIMIT 16`, [recipientSubject]);
      if (existing.rows.length >= 16) {
        throw new RoleUnavailable('Agent role binding limit reached');
      }
      await client.query(`INSERT INTO access.role_binding
        (id, family_id, role_revision, issuer_subject, recipient_subject,
          valid_until, assigned_by_principal, membership_id, membership_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [bindingId, familyId, roleRevision, context.issuerSubject,
        recipientSubject, validUntil, principalId,
        membershipDependency?.membershipId ?? null, membershipDependency?.generation ?? null]);
    });
  }

  async revokeBinding(context: RoleContext, bindingId: string,
    expectedObjectGeneration: string): Promise<string> {
    if (!epochPattern.test(expectedObjectGeneration)) {
      throw new RoleDenied('invalid binding generation');
    }
    return this.mutateBinding(context, 'revoke', bindingId, async client => {
      const row = await client.query<{ active: boolean; generation: string }>(`
        SELECT active, generation FROM access.role_binding
        WHERE id = $1 AND issuer_subject = $2 FOR UPDATE`,
      [bindingId, context.issuerSubject]);
      if (!row.rows[0]) throw new RoleDenied('binding is unavailable to issuer');
      if (row.rows[0].generation !== expectedObjectGeneration) {
        throw new RoleStale('binding generation changed');
      }
      if (!row.rows[0].active) throw new RoleDenied('binding is already inactive');
      await client.query(`UPDATE access.role_binding
        SET active = false, generation = generation + 1 WHERE id = $1`, [bindingId]);
    });
  }
}
