import type { Pool, PoolClient } from 'pg';
import { AccessPlatformGrants } from './platform-grants.ts';
import { lockAccessKey } from './scope-gates.ts';
import type { VerifiedPrincipal } from './admission.ts';
import { AccessAgentControl } from './agent-control.ts';
import { AccessInvitations } from './invitation.ts';
import { AccessProtectedChanges } from './protected-set.ts';
import { AccessTopology } from './topology.ts';
import { AccessRepresentativePolicies } from './topology-policy.ts';
import { type GrantLifetime, type GrantLineageRow, MAX_GRANT_DEPTH }
  from './grant-lineage-schema.ts';

export class GrantDenied extends Error {}
export class GrantConflict extends Error {}
export class GrantStale extends Error {}
export class GrantUnavailable extends Error {}

const SCOPE = 'work:create:root';
const ACTION = 'work.create';
const ASSIGN = 'access.grant.assign.work.create';
const CONTENT_DRAFT_ASSIGN = 'access.grant.assign.content.draft';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface GrantContext {
  principal: VerifiedPrincipal;
  issuerSubject: string;
  expectedAuthorityEpoch: string;
  selectedAdmissionId?: string;
}
export interface GrantReceipt {
  idempotencyKey: string;
  requestDigest: string;
}
export interface GrantMembershipDependency {
  membershipId: string;
  generation: string;
}
export interface AgentGrant {
  id: string;
  issuerSubject: string;
  recipientSubject: string;
  validUntil: string;
  active: boolean;
  generation: string;
}
export interface AuthorityControl {
  topology: AccessTopology;
  policies: AccessRepresentativePolicies;
  protectedChanges: AccessProtectedChanges;
  agentControl: AccessAgentControl;
  invitations: AccessInvitations;
}
export interface GrantLineageInput {
  lifetime: GrantLifetime;
  redelegationDepth: number;
  upstreamGrantId?: string;
  representativePolicyId?: string;
}
export interface GrantLineageView {
  lifetime: GrantLifetime;
  issuerRepresentationId: string;
  issuerRepresentationGeneration: string;
  ceilingGrantId: string;
  ceilingGrantGeneration: string;
  ceilingAction: string;
  upstreamGrantId: string | null;
  upstreamGeneration: string | null;
  rootGrantId: string;
  depth: number;
  redelegationDepth: number;
  representativePolicyId: string | null;
  invitationId: string | null;
}
interface GrantIssuer {
  principalId: string; mandateId: string; mandateGeneration: string; mandateAction: string;
  ceilingId: string; ceilingGeneration: string;
}
export interface GrantPage {
  authorityEpoch: string;
  grants: AgentGrant[];
  nextCursor: string | null;
}
type GrantRow = {
  id: string; issuer_subject: string; recipient_subject: string;
  valid_until: Date; active: boolean; generation: string;
};

/** First institutional Agent-to-Agent work.create grant profile. The actual
 * authenticated operator is recorded privately; the issuer Agent owns the
 * durable grant. Role revisions and protected grant families have other gates. */
export class AccessGrants {
  readonly platform: AccessPlatformGrants;
  /** Authority-control owners (G-047) sharing this Access pool, so every Main
   * that composes the grant owner also serves their routes. */
  readonly control: AuthorityControl;

  constructor(private readonly pool: Pool) {
    this.platform = new AccessPlatformGrants(pool);
    this.control = { topology: new AccessTopology(pool),
      policies: new AccessRepresentativePolicies(pool),
      protectedChanges: new AccessProtectedChanges(pool),
      agentControl: new AccessAgentControl(pool), invitations: new AccessInvitations(pool) };
  }

  private async gate(client: PoolClient): Promise<string> {
    const recovery = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (recovery.rows[0]?.open !== true) throw new GrantUnavailable('Access recovery is held');
    const gate = await client.query<{ authority_epoch: string; open: boolean;
      dispatch_open: boolean }>(`SELECT authority_epoch, open, dispatch_open
      FROM access.scope_gate WHERE id = $1 FOR SHARE`, [SCOPE]);
    if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
      throw new GrantDenied('grant scope is closed');
    }
    return gate.rows[0].authority_epoch;
  }

  private async authorize(client: PoolClient, principal: VerifiedPrincipal,
    issuerSubject: string, validUntil?: Date, needsCeiling = true): Promise<GrantIssuer> {
    const actor = await client.query<{ id: string; mandate_id: string;
      mandate_generation: string; mandate_action: string }>(`SELECT p.id, r.id AS mandate_id,
      r.generation AS mandate_generation, r.action AS mandate_action
      FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.subject_id = $3 AND r.action IN ($4,'agent.control') AND r.active
        AND r.valid_until > clock_timestamp()
        AND s.kind = 'agent' AND s.active
      LIMIT 1 FOR SHARE OF p, r, s`,
    [principal.issuer, principal.subject, issuerSubject, ASSIGN]);
    if (!actor.rows[0]) throw new GrantDenied('issuer representation is missing');
    const issuer = { principalId: actor.rows[0].id, mandateId: actor.rows[0].mandate_id,
      mandateGeneration: actor.rows[0].mandate_generation, mandateAction: actor.rows[0].mandate_action,
      ceilingId: '', ceilingGeneration: '' };
    if (!needsCeiling) return issuer;
    // Control is limited to this Agent. Assigning catalogue-wide Work rights
    // still requires its separately held assignment ceiling.
    const ceiling = await client.query<{ id: string; generation: string }>(`SELECT id, generation
      FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > clock_timestamp()
        AND ($4::timestamptz IS NULL OR valid_until >= $4)
      ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
    [issuerSubject, SCOPE, ASSIGN, validUntil ?? null]);
    if (!ceiling.rows[0]) throw new GrantDenied('grant assignment ceiling is missing');
    return { ...issuer, ceilingId: ceiling.rows[0].id, ceilingGeneration: ceiling.rows[0].generation };
  }

  private toGrant(row: GrantRow): AgentGrant {
    return { id: row.id, issuerSubject: row.issuer_subject,
      recipientSubject: row.recipient_subject, validUntil: row.valid_until.toISOString(),
      active: row.active, generation: row.generation };
  }

  async readPage(principal: VerifiedPrincipal, issuerSubject: string,
    after?: string): Promise<GrantPage> {
    if (!agentPattern.test(issuerSubject) || after && !idPattern.test(after)) {
      throw new GrantDenied('invalid grant read');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const authorityEpoch = await this.gate(client);
      await this.authorize(client, principal, issuerSubject);
      const rows = await client.query<GrantRow>(`SELECT id, issuer_subject,
        recipient_subject, valid_until, active, generation
        FROM access.permission_grant WHERE issuer_subject = $1
          AND scope_id = $2 AND action = $3 AND ($4::uuid IS NULL OR id > $4)
        ORDER BY id LIMIT 51`, [issuerSubject, SCOPE, ACTION, after ?? null]);
      await client.query('COMMIT');
      return { authorityEpoch, grants: rows.rows.slice(0, 50).map(row => this.toGrant(row)),
        nextCursor: rows.rows.length > 50 ? rows.rows[49]!.id : null };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async readOne(principal: VerifiedPrincipal, issuerSubject: string,
    grantId: string, needsCeiling = true): Promise<{ authorityEpoch: string; grant: AgentGrant }> {
    if (!agentPattern.test(issuerSubject) || !idPattern.test(grantId)) {
      throw new GrantDenied('invalid grant read');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const authorityEpoch = await this.gate(client);
      await this.authorize(client, principal, issuerSubject, undefined, needsCeiling);
      const rows = await client.query<GrantRow>(`SELECT id, issuer_subject,
        recipient_subject, valid_until, active, generation
        FROM access.permission_grant WHERE id = $1 AND issuer_subject = $2
          AND scope_id = $3 AND action = $4`, [grantId, issuerSubject, SCOPE, ACTION]);
      if (!rows.rows[0]) throw new GrantDenied('grant is unavailable to issuer');
      await client.query('COMMIT');
      return { authorityEpoch, grant: this.toGrant(rows.rows[0]) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      if (String(error.code) === '23505') return new GrantConflict('grant identifier conflicts');
      if (String(error.code) === '23514') return new GrantDenied('grant lineage guard rejected the change');
      if (['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        return new GrantUnavailable('grant owner could not complete');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async mutate(context: GrantContext, action: 'create' | 'revoke',
    grantId: string, receipt: GrantReceipt,
    work: (client: PoolClient, principalId: string) => Promise<boolean>,
    needsCeiling = true): Promise<string> {
    if (!agentPattern.test(context.issuerSubject) || !idPattern.test(grantId)
      || !/^(0|[1-9][0-9]*)$/.test(context.expectedAuthorityEpoch)
      || !receipt.idempotencyKey || receipt.idempotencyKey.length > 128
      || receipt.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)) {
      throw new GrantDenied('invalid grant change');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const currentEpoch = await this.gate(client);
      const principal = await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [context.principal.issuer, context.principal.subject]);
      const principalId = principal.rows[0]?.id;
      if (!principalId) throw new GrantDenied('principal is not admitted');
      if (!context.selectedAdmissionId) {
        await this.authorize(client, context.principal, context.issuerSubject,
          undefined, needsCeiling);
      }
      await lockAccessKey(client, `grant-change:${principalId}:${receipt.idempotencyKey}`);
      const prior = await client.query<{ request_digest: string; issuer_subject: string;
        action: string; grant_id: string; result_authority_epoch: string }>(`
        SELECT request_digest, issuer_subject, action, grant_id, result_authority_epoch
        FROM access.grant_change_receipt WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, receipt.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== receipt.requestDigest
          || prior.rows[0].issuer_subject !== context.issuerSubject
          || prior.rows[0].action !== action || prior.rows[0].grant_id !== grantId) {
          throw new GrantConflict('grant key binds another intent');
        }
        await client.query('COMMIT');
        return prior.rows[0].result_authority_epoch;
      }
      if (currentEpoch !== context.expectedAuthorityEpoch) {
        throw new GrantStale('grant scope authority epoch changed');
      }
      if (context.selectedAdmissionId) {
        if (action !== 'revoke') throw new GrantDenied('selected admission is for revocation');
        await this.control.topology.consumeGrantRevokeAdmission(client, principalId,
          context.selectedAdmissionId, context.issuerSubject, grantId, currentEpoch);
      }
      await work(client, principalId);
      const resultEpoch = currentEpoch;
      await client.query(`INSERT INTO access.grant_change_receipt
        (principal_id, idempotency_key, request_digest, issuer_subject,
        action, grant_id, result_authority_epoch, selected_admission_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [principalId, receipt.idempotencyKey, receipt.requestDigest,
        context.issuerSubject, action, grantId, resultEpoch,
        context.selectedAdmissionId ?? null]);
      await client.query('COMMIT');
      return resultEpoch;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async create(context: GrantContext, grantId: string, recipientSubject: string,
    validUntil: Date, receipt: GrantReceipt,
    membershipDependency?: GrantMembershipDependency): Promise<string> {
    return this.createDelegated(context, grantId, recipientSubject, validUntil, receipt,
      { lifetime: 'institutional', redelegationDepth: 0 }, membershipDependency);
  }

  /** Issues one Organization-owned Content draft grant under that institution's
   * exact scoped assignment ceiling and represented authority. This is separate
   * from the Work grant family and cannot assign control actions. */
  async createOrganizationContentDraft(context: GrantContext, grantId: string,
    recipientSubject: string, validUntil: Date, receipt: GrantReceipt): Promise<string> {
    const scope = `content:draft:${context.issuerSubject}`;
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(context.issuerSubject)
      || !agentPattern.test(recipientSubject) || !idPattern.test(grantId)
      || Number.isNaN(validUntil.getTime()) || validUntil.getTime() <= Date.now()
      || validUntil.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000
      || !/^(0|[1-9][0-9]*)$/.test(context.expectedAuthorityEpoch)
      || !receipt.idempotencyKey || receipt.idempotencyKey.length > 128
      || receipt.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)) {
      throw new GrantDenied('invalid Organization Content draft grant');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (recovery.rows[0]?.open !== true) throw new GrantUnavailable('Access recovery is held');
      const gate = await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(`
        SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE`, [scope]);
      if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
        throw new GrantDenied('Content draft grant scope is closed');
      }
      const principal = await client.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [context.principal.issuer, context.principal.subject]);
      const principalId = principal.rows[0]?.id;
      if (!principalId) throw new GrantDenied('principal is not admitted');
      const operator = await client.query<{ principal_id: string; representation_id: string;
        representation_generation: string }>(`SELECT p.id AS principal_id, r.id AS representation_id,
          r.generation AS representation_generation FROM access.principal p
        JOIN access.representation r ON r.principal_id = p.id
        JOIN access.authority_subject s ON s.id = r.subject_id
        JOIN access.org_participation_subject o ON o.subject = s.id AND o.active
        WHERE p.id = $1 AND r.subject_id = $2 AND s.kind = 'institution'
          AND r.action = $3 AND r.active AND r.valid_until >= $4 FOR SHARE OF p, r, s, o`,
      [principalId, context.issuerSubject, CONTENT_DRAFT_ASSIGN, validUntil]);
      if (!operator.rows[0]) throw new GrantDenied('Organization assignment representation is missing');
      const ceiling = await client.query<{ id: string; generation: string }>(`SELECT id, generation
        FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2
          AND action = $3 AND active AND valid_until >= $4
        ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
      [context.issuerSubject, scope, CONTENT_DRAFT_ASSIGN, validUntil]);
      if (!ceiling.rows[0]) throw new GrantDenied('Organization Content assignment ceiling is missing');
      await lockAccessKey(client, `grant-change:${principalId}:${receipt.idempotencyKey}`);
      const prior = await client.query<{ request_digest: string; issuer_subject: string;
        grant_id: string; result_authority_epoch: string }>(`SELECT request_digest, issuer_subject,
        grant_id, result_authority_epoch FROM access.grant_change_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, receipt.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== receipt.requestDigest
          || prior.rows[0].issuer_subject !== context.issuerSubject
          || prior.rows[0].grant_id !== grantId) throw new GrantConflict('grant key binds another intent');
        await client.query('COMMIT');
        return prior.rows[0].result_authority_epoch;
      }
      if (gate.rows[0].authority_epoch !== context.expectedAuthorityEpoch) {
        throw new GrantStale('Content grant authority epoch changed');
      }
      const target = await client.query<{ kind: string }>(`SELECT kind FROM access.authority_subject
        WHERE id = $1 AND active FOR SHARE`, [recipientSubject]);
      if (target.rows[0]?.kind !== 'agent') throw new GrantDenied('recipient Agent is unavailable');
      await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until, assigned_by_principal)
        VALUES ($1,$2,$3,$4,'content.draft',$5,$6)`,
      [grantId, context.issuerSubject, recipientSubject, scope, validUntil, principalId]);
      await client.query(`INSERT INTO access.grant_lineage
        (grant_id, issuer_subject, recipient_subject, scope_id, action, lifetime,
         assigned_by_principal, issuer_representation_id, issuer_representation_generation,
         issuer_representation_action, ceiling_grant_id, ceiling_grant_generation,
         ceiling_scope_id, ceiling_action, root_grant_id, depth, redelegation_depth)
        VALUES ($1,$2,$3,$4,'content.draft','institutional',$5,$6,$7,$8,$9,$10,$4,$11,$1,0,0)`,
      [grantId, context.issuerSubject, recipientSubject, scope, principalId,
        operator.rows[0].representation_id, operator.rows[0].representation_generation,
        CONTENT_DRAFT_ASSIGN, ceiling.rows[0].id, ceiling.rows[0].generation, CONTENT_DRAFT_ASSIGN]);
      await client.query(`INSERT INTO access.grant_change_receipt
        (principal_id, idempotency_key, request_digest, issuer_subject, action, grant_id, result_authority_epoch)
        VALUES ($1,$2,$3,$4,'create',$5,$6)`,
      [principalId, receipt.idempotencyKey, receipt.requestDigest, context.issuerSubject,
        grantId, gate.rows[0]!.authority_epoch]);
      await client.query('COMMIT');
      return gate.rows[0]!.authority_epoch;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  /** Creates one grant with its lineage (IAM13/IAM14). An institutional grant
   * pins the issuer's assignment ceiling and survives its operator; a dependent
   * grant redelegates one live upstream grant the issuer holds and is revoked
   * with it. An institutional grant may pin the recipient's approved
   * representative policy (IAM32). */
  async createDelegated(context: GrantContext, grantId: string, recipientSubject: string,
    validUntil: Date, receipt: GrantReceipt, lineage: GrantLineageInput,
    membershipDependency?: GrantMembershipDependency): Promise<string> {
    const dependent = lineage.lifetime === 'dependent';
    if (!agentPattern.test(recipientSubject) || Number.isNaN(validUntil.getTime())
      || membershipDependency && (!idPattern.test(membershipDependency.membershipId)
        || !/^[1-9][0-9]*$/.test(membershipDependency.generation))
      || !Number.isInteger(lineage.redelegationDepth) || lineage.redelegationDepth < 0
      || lineage.redelegationDepth > MAX_GRANT_DEPTH
      || dependent !== Boolean(lineage.upstreamGrantId)
      || lineage.upstreamGrantId && !idPattern.test(lineage.upstreamGrantId)
      || lineage.representativePolicyId && (dependent
        || !idPattern.test(lineage.representativePolicyId))) {
      throw new GrantDenied('invalid grant recipient, validity or lineage');
    }
    return this.mutate(context, 'create', grantId, receipt, async client => {
      if (validUntil.getTime() <= Date.now()) throw new GrantDenied('grant validity ended');
      const issuer = await this.authorize(client, context.principal, context.issuerSubject,
        validUntil, !dependent);
      let ceiling = { id: issuer.ceilingId, generation: issuer.ceilingGeneration,
        action: ASSIGN, depth: 0, root: grantId };
      if (dependent) {
        const upstream = await client.query<{ generation: string; depth: number; root: string;
          redelegation_depth: number }>(`SELECT g.generation, l.depth, l.root_grant_id AS root,
          l.redelegation_depth FROM access.permission_grant g
          JOIN access.grant_lineage l ON l.grant_id = g.id
          WHERE g.id = $1 AND g.recipient_subject = $2 AND g.scope_id = $3 AND g.action = $4
            AND g.active AND g.valid_until >= $5 FOR SHARE OF g`,
        [lineage.upstreamGrantId, context.issuerSubject, SCOPE, ACTION, validUntil]);
        const row = upstream.rows[0];
        if (!row) throw new GrantDenied('upstream grant is not held for this validity');
        if (row.redelegation_depth < lineage.redelegationDepth + 1) {
          throw new GrantDenied('upstream grant does not allow this redelegation');
        }
        ceiling = { id: lineage.upstreamGrantId!, generation: row.generation, action: ACTION,
          depth: row.depth + 1, root: row.root };
        // The trigger counts at most 256 live descendants. Serialize that count
        // and insertion for this root while independent roots remain writable.
        await lockAccessKey(client, `grant-root:${ceiling.root}`);
      }
      const recipient = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [recipientSubject]);
      if (!recipient.rows[0]) throw new GrantDenied('recipient Agent is unavailable');
      if (membershipDependency) {
        const membership = await client.query(`SELECT id FROM access.membership
          WHERE id = $1 AND member_subject = $2 AND state = 'joined'
            AND generation = $3 FOR SHARE`, [membershipDependency.membershipId,
          recipientSubject, membershipDependency.generation]);
        if (!membership.rows[0]) throw new GrantDenied('membership dependency is stale');
      }
      if (lineage.representativePolicyId) {
        const policy = await client.query(`SELECT 1 FROM access.representative_policy
          WHERE id = $1 AND institution_subject = $2 AND approval_subject = $3 FOR SHARE`,
        [lineage.representativePolicyId, recipientSubject, context.issuerSubject]);
        if (!policy.rows[0]) {
          throw new GrantDenied('the recipient policy does not name this grantor');
        }
      }
      await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until,
          assigned_by_principal, membership_id, membership_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [grantId, context.issuerSubject, recipientSubject, SCOPE, ACTION,
        validUntil, issuer.principalId, membershipDependency?.membershipId ?? null,
        membershipDependency?.generation ?? null]);
      await client.query(`INSERT INTO access.grant_lineage (grant_id, issuer_subject,
        recipient_subject, scope_id, action, lifetime, assigned_by_principal,
        issuer_representation_id, issuer_representation_generation, issuer_representation_action,
        ceiling_grant_id, ceiling_grant_generation, ceiling_scope_id, ceiling_action,
        upstream_grant_id, upstream_generation, root_grant_id, depth, redelegation_depth,
        representative_policy_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$4,$13,$14,$15,$16,$17,$18,$19)`,
      [grantId, context.issuerSubject, recipientSubject, SCOPE, ACTION, lineage.lifetime,
        issuer.principalId, issuer.mandateId, issuer.mandateGeneration, issuer.mandateAction, ceiling.id,
        ceiling.generation, ceiling.action, dependent ? ceiling.id : null,
        dependent ? ceiling.generation : null, ceiling.root, ceiling.depth,
        lineage.redelegationDepth, lineage.representativePolicyId ?? null]);
      return true;
    }, !dependent);
  }

  /** The issuer-authorized view of one grant's recorded lifetime and ceiling. */
  async readLineage(principal: VerifiedPrincipal, issuerSubject: string,
    grantId: string): Promise<{ authorityEpoch: string; grant: AgentGrant;
      lineage: GrantLineageView | null }> {
    const { authorityEpoch, grant } = await this.readOne(principal, issuerSubject, grantId, false);
    const row = await this.pool.query<GrantLineageRow>(`SELECT * FROM access.grant_lineage
      WHERE grant_id = $1`, [grantId]);
    const lineage = row.rows[0];
    return { authorityEpoch, grant, lineage: lineage ? {
      lifetime: lineage.lifetime as GrantLifetime,
      issuerRepresentationId: lineage.issuer_representation_id,
      issuerRepresentationGeneration: lineage.issuer_representation_generation,
      ceilingGrantId: lineage.ceiling_grant_id,
      ceilingGrantGeneration: lineage.ceiling_grant_generation,
      ceilingAction: lineage.ceiling_action,
      upstreamGrantId: lineage.upstream_grant_id, upstreamGeneration: lineage.upstream_generation,
      rootGrantId: lineage.root_grant_id, depth: lineage.depth,
      redelegationDepth: lineage.redelegation_depth,
      representativePolicyId: lineage.representative_policy_id,
      invitationId: lineage.invitation_id } : null };
  }

  /** The caller's immutable receipt is the read side of a consumed path. */
  async readAdmissionConsumption(principal: VerifiedPrincipal,
    admissionId: string): Promise<{ admissionId: string; grantId: string;
      issuerSubject: string; authorityEpoch: string; grantActive: boolean }> {
    if (!idPattern.test(admissionId)) throw new GrantDenied('invalid admission read');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await this.gate(client);
      const row = await client.query<{ grant_id: string; issuer_subject: string;
        result_authority_epoch: string; active: boolean }>(`SELECT r.grant_id,
        r.issuer_subject, r.result_authority_epoch, g.active
        FROM access.grant_change_receipt r
        JOIN access.principal p ON p.id = r.principal_id
        JOIN access.permission_grant g ON g.id = r.grant_id
        WHERE r.selected_admission_id = $1 AND p.account_issuer = $2
          AND p.account_subject = $3 AND p.active`,
      [admissionId, principal.issuer, principal.subject]);
      if (!row.rows[0]) throw new GrantDenied('admission consumption is unavailable');
      await client.query('COMMIT');
      return { admissionId, grantId: row.rows[0].grant_id,
        issuerSubject: row.rows[0].issuer_subject,
        authorityEpoch: row.rows[0].result_authority_epoch,
        grantActive: row.rows[0].active };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async revoke(context: GrantContext, grantId: string,
    expectedObjectGeneration: string, receipt: GrantReceipt): Promise<string> {
    if (!/^(0|[1-9][0-9]*)$/.test(expectedObjectGeneration)) {
      throw new GrantDenied('invalid grant object generation');
    }
    return this.mutate(context, 'revoke', grantId, receipt, async client => {
      const grant = await client.query<{ active: boolean; generation: string }>(`
        SELECT active, generation FROM access.permission_grant
        WHERE id = $1 AND issuer_subject = $2 AND scope_id = $3 AND action = $4
        FOR UPDATE`, [grantId, context.issuerSubject, SCOPE, ACTION]);
      if (!grant.rows[0]) throw new GrantDenied('grant is unavailable to issuer');
      if (grant.rows[0].generation !== expectedObjectGeneration) {
        throw new GrantStale('grant object generation changed');
      }
      if (!grant.rows[0].active) return false;
      await client.query(`UPDATE access.permission_grant
        SET active = false, generation = generation + 1 WHERE id = $1`, [grantId]);
      return true;
    });
  }
}
