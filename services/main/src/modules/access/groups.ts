import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { groupChangeIntentDigest } from './group-intent.ts';
import { currentMembershipDependency, validMembershipDependency,
  type MembershipDependency } from './memberships.ts';

export class GroupDenied extends Error {}
export class GroupConflict extends Error {}
export class GroupStale extends Error {}
export class GroupUnavailable extends Error {}

export const GROUP_SCOPE = 'work:create:root';
const MAX_DEPTH = 32;
const MAX_GROUPS = 256;
const MAX_MEMBERSHIPS = 1024;
const MAX_MEMBER_GROUPS = 16;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface GroupWorkProof {
  memberId: string;
  grantId: string;
  groupGeneration: string;
}

/** The subject's direct memberships climb only toward ancestors. The query
 * visits at most 16 x 33 rows; any over-limit or cyclic path is unavailable. */
export async function groupWorkCreateProof(client: PoolClient, subject: string,
  scope = GROUP_SCOPE): Promise<GroupWorkProof | null> {
  if (scope !== GROUP_SCOPE) return null;
  const members = await client.query<{ id: string; group_id: string }>(`
    SELECT m.id, m.group_id FROM access.group_member m
    JOIN access.recipient_group g ON g.id = m.group_id
    WHERE m.agent_subject = $1 AND m.active AND g.scope_id = $2
    ORDER BY m.id LIMIT $3 FOR SHARE OF m, g`, [subject, scope, MAX_MEMBER_GROUPS + 1]);
  if (members.rows.length > MAX_MEMBER_GROUPS) {
    throw new GroupUnavailable('group membership evaluation exceeds supported profile');
  }
  if (members.rows.length === 0) return null;
  const gate = await client.query<{ group_generation: string }>(
    'SELECT group_generation FROM access.scope_gate WHERE id = $1 FOR SHARE', [scope]);
  if (!gate.rows[0]) throw new GroupUnavailable('group scope is unavailable');
  const result = await client.query<{
    member_id: string; grant_id: string | null; depth: number;
    parent_id: string | null; cycle: boolean;
  }>(`
    WITH RECURSIVE path(member_id, group_id, parent_id, depth, visited, cycle) AS (
      SELECT m.id, g.id, g.parent_id, 0, ARRAY[g.id], false
      FROM access.group_member m JOIN access.recipient_group g ON g.id = m.group_id
      WHERE m.id = ANY($1::uuid[]) AND m.active AND g.scope_id = $2
      UNION ALL
      SELECT p.member_id, g.id, g.parent_id, p.depth + 1,
        p.visited || g.id, g.id = ANY(p.visited)
      FROM path p JOIN access.recipient_group g ON g.id = p.parent_id
      WHERE p.depth < $3 AND NOT p.cycle AND g.scope_id = $2
    )
    SELECT p.member_id, gr.id AS grant_id, p.depth, p.parent_id, p.cycle
    FROM path p LEFT JOIN LATERAL (
      SELECT gr.id FROM access.group_permission_grant gr
      WHERE gr.group_id = p.group_id AND gr.scope_id = $2 AND gr.action = 'work.create'
        AND active AND valid_until > clock_timestamp()
        AND (gr.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership dep
          WHERE dep.id = gr.membership_id AND dep.member_subject = $4
            AND dep.state = 'joined' AND dep.generation = gr.membership_generation))
      ORDER BY id LIMIT 1
    ) gr ON true ORDER BY p.member_id, p.depth, gr.id`,
  [members.rows.map(row => row.id), scope, MAX_DEPTH, subject]);
  if (result.rows.some(row => row.cycle || (row.depth >= MAX_DEPTH && row.parent_id))) {
    throw new GroupUnavailable('group ancestry exceeds supported profile');
  }
  const proof = result.rows.find(row => row.grant_id);
  return proof?.grant_id ? { memberId: proof.member_id, grantId: proof.grant_id,
    groupGeneration: gate.rows[0].group_generation } : null;
}

/** Discovery reads all candidate memberships in one bounded query and expands
 * their paths together. The caller holds the scope gate in one stable snapshot;
 * selected checks and admissions still use the exact single-subject proof. */
export async function groupWorkCreateSubjects(client: PoolClient,
  subjects: readonly string[]): Promise<Set<string>> {
  if (subjects.length === 0) return new Set();
  const members = await client.query<{ id: string; agent_subject: string }>(`
    SELECT m.id, m.agent_subject FROM access.group_member m
    JOIN access.recipient_group g ON g.id = m.group_id
    WHERE m.agent_subject = ANY($1::text[]) AND m.active AND g.scope_id = $2
    ORDER BY m.agent_subject, m.id LIMIT $3 FOR SHARE OF m, g`,
  [subjects, GROUP_SCOPE, subjects.length * MAX_MEMBER_GROUPS + 1]);
  const counts = new Map<string, number>();
  for (const row of members.rows) {
    const count = (counts.get(row.agent_subject) ?? 0) + 1;
    if (count > MAX_MEMBER_GROUPS) {
      throw new GroupUnavailable('group membership evaluation exceeds supported profile');
    }
    counts.set(row.agent_subject, count);
  }
  if (members.rows.length === 0) return new Set();
  const paths = await client.query<{
    agent_subject: string; invalid: boolean; granted: boolean;
  }>(`
    WITH RECURSIVE path(agent_subject, group_id, parent_id, depth, visited, cycle) AS (
      SELECT m.agent_subject, g.id, g.parent_id, 0, ARRAY[g.id], false
      FROM access.group_member m JOIN access.recipient_group g ON g.id = m.group_id
      WHERE m.id = ANY($1::uuid[]) AND m.active AND g.scope_id = $2
      UNION ALL
      SELECT p.agent_subject, g.id, g.parent_id, p.depth + 1,
        p.visited || g.id, g.id = ANY(p.visited)
      FROM path p JOIN access.recipient_group g ON g.id = p.parent_id
      WHERE p.depth < $3 AND NOT p.cycle AND g.scope_id = $2
    )
    SELECT p.agent_subject,
      bool_or(p.cycle OR (p.depth >= $3 AND p.parent_id IS NOT NULL)) AS invalid,
      bool_or(gr.granted IS TRUE) AS granted
    FROM path p LEFT JOIN LATERAL (
      SELECT true AS granted FROM access.group_permission_grant gr
      WHERE gr.group_id = p.group_id AND gr.scope_id = $2 AND gr.action = 'work.create'
        AND active AND valid_until > clock_timestamp()
        AND (gr.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership dep
          WHERE dep.id = gr.membership_id AND dep.member_subject = p.agent_subject
            AND dep.state = 'joined' AND dep.generation = gr.membership_generation)) LIMIT 1
    ) gr ON true GROUP BY p.agent_subject`,
  [members.rows.map(row => row.id), GROUP_SCOPE, MAX_DEPTH]);
  if (paths.rows.some(row => row.invalid)) {
    throw new GroupUnavailable('group ancestry exceeds supported profile');
  }
  return new Set(paths.rows.filter(row => row.granted).map(row => row.agent_subject));
}

export async function selectedGroupWorkProof(client: PoolClient, subject: string,
  memberId: string, grantId: string): Promise<boolean> {
  await groupWorkCreateProof(client, subject); // enforce the same work budget
  // A second independent path must not replace this saved proof at claim.
  const found = await client.query(`WITH RECURSIVE path(id, parent_id, depth, visited) AS (
    SELECT g.id, g.parent_id, 0, ARRAY[g.id]
    FROM access.group_member m JOIN access.recipient_group g ON g.id = m.group_id
    WHERE m.id = $1 AND m.agent_subject = $2 AND m.active AND g.scope_id = $4
    UNION ALL
    SELECT g.id, g.parent_id, p.depth + 1, p.visited || g.id
    FROM path p JOIN access.recipient_group g ON g.id = p.parent_id
    WHERE p.depth < $5 AND g.scope_id = $4 AND NOT g.id = ANY(p.visited)
  ) SELECT gr.id FROM path p JOIN access.group_permission_grant gr
    ON gr.group_id = p.id WHERE gr.id = $3 AND gr.scope_id = $4
      AND gr.action = 'work.create' AND gr.active
      AND gr.valid_until > clock_timestamp()
      AND (gr.membership_id IS NULL OR EXISTS (SELECT 1 FROM access.membership dep
        WHERE dep.id = gr.membership_id AND dep.member_subject = $2
          AND dep.state = 'joined' AND dep.generation = gr.membership_generation))
      LIMIT 1`,
  [memberId, subject, grantId, GROUP_SCOPE, MAX_DEPTH]);
  return found.rowCount === 1;
}

export interface GroupMutationContext {
  principal: VerifiedPrincipal;
  issuerSubject: string;
  expectedGroupGeneration: string;
}
export interface GroupChangeReceipt {
  idempotencyKey: string;
  requestDigest: string;
}
export interface GroupState {
  groupGeneration: string;
  groups: { id: string; parentId: string | null; generation: string }[];
  members: { id: string; groupId: string; agentSubject: string; generation: string }[];
  grants: { id: string; groupId: string; issuerSubject: string;
    validUntil: string; generation: string; membershipDependency: MembershipDependency | null }[];
}
export interface GroupImpactPreview {
  proposalId: string;
  issuerSubject: string;
  groupId: string;
  parentId: string | null;
  expectedGroupGeneration: string;
  expectedObjectGeneration: string;
  impactDigest: string;
  affectedMemberCount: number;
  gainedGrantIds: string[];
  lostGrantIds: string[];
  expiresAt: string;
  status: 'pending' | 'stale' | 'activated';
  activatedGeneration: string | null;
}
type GroupImpactRow = {
  id: string; requested_by: string; issuer_subject: string; group_id: string;
  parent_id: string | null; expected_scope_generation: string;
  expected_object_generation: string; idempotency_key: string;
  request_digest: string; impact_digest: string;
  affected_member_count: number; gained_grant_ids: string[]; lost_grant_ids: string[];
  expires_at: Date; result_generation: string | null;
};
type GrantLimit = { id: string; valid_until: Date };
type GroupImpact = {
  impactDigest: string; affectedMemberCount: number;
  gainedGrantIds: string[]; lostGrantIds: string[];
  gainedValidUntil: Date | null;
};
type GroupChangeAction = 'create' | 'reparent' | 'add-member' | 'grant'
  | 'revoke-member' | 'revoke-grant';

/** Internal Access-owner mutation boundary. Only the ordinary work.create
 * assignment ceiling is supported. Protected roles and approvals remain closed. */
export class AccessGroups {
  constructor(private readonly pool: Pool) {}

  private async authorize(client: PoolClient, principal: VerifiedPrincipal,
    issuerSubject: string, assigning: boolean,
    action: 'access.group.manage' | 'access.group.approve' = 'access.group.manage'): Promise<string> {
    const actor = await client.query<{ id: string }>(`
      SELECT p.id FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.subject_id = $3 AND r.action = $4
        AND r.active AND r.valid_until > clock_timestamp()
        AND s.kind = 'agent' AND s.active
        AND EXISTS (SELECT 1 FROM access.permission_grant g
          WHERE g.recipient_subject = $3 AND g.scope_id = $5
            AND g.action = $4 AND g.active
            AND g.valid_until > clock_timestamp())
      LIMIT 1 FOR SHARE OF p, r, s`,
    [principal.issuer, principal.subject, issuerSubject, action, GROUP_SCOPE]);
    if (!actor.rows[0]) throw new GroupDenied('group management authority is missing');
    const manage = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3
        AND active AND valid_until > clock_timestamp() LIMIT 1 FOR SHARE`,
    [issuerSubject, GROUP_SCOPE, action]);
    if (!manage.rows[0]) throw new GroupDenied('group management authority changed');
    if (assigning) {
      const ceiling = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'access.group.assign.work.create'
          AND active AND valid_until > clock_timestamp() LIMIT 1 FOR SHARE`,
      [issuerSubject, GROUP_SCOPE]);
      if (!ceiling.rows[0]) throw new GroupDenied('work.create assignment ceiling is missing');
    }
    return actor.rows[0].id;
  }

  async readState(principal: VerifiedPrincipal, issuerSubject: string): Promise<GroupState> {
    if (!agentPattern.test(issuerSubject)) throw new GroupDenied('invalid group issuer');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (recovery.rows[0]?.open !== true) throw new GroupUnavailable('Access recovery is held');
      const gate = await client.query<{ group_generation: string; open: boolean; dispatch_open: boolean }>(
        'SELECT group_generation, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
        [GROUP_SCOPE]);
      if (!gate.rows[0] || !gate.rows[0].open || !gate.rows[0].dispatch_open) {
        throw new GroupDenied('group scope is closed');
      }
      await this.authorize(client, principal, issuerSubject, false);
      const groups = await client.query<{ id: string; parent_id: string | null; generation: string }>(`
        SELECT id, parent_id, generation FROM access.recipient_group
        WHERE scope_id = $1 ORDER BY id LIMIT $2`, [GROUP_SCOPE, MAX_GROUPS + 1]);
      const members = await client.query<{
        id: string; group_id: string; agent_subject: string; generation: string;
      }>(`SELECT m.id, m.group_id, m.agent_subject, m.generation
        FROM access.group_member m JOIN access.recipient_group g ON g.id = m.group_id
        WHERE g.scope_id = $1 AND m.active ORDER BY m.id LIMIT $2`,
      [GROUP_SCOPE, MAX_MEMBERSHIPS + 1]);
      const grants = await client.query<{
        id: string; group_id: string; issuer_subject: string;
        valid_until: Date; generation: string; membership_id: string | null;
        membership_generation: string | null;
      }>(`SELECT id, group_id, issuer_subject, valid_until, generation,
          membership_id, membership_generation
        FROM access.group_permission_grant WHERE scope_id = $1 AND active
          AND valid_until > clock_timestamp() ORDER BY id LIMIT $2`,
      [GROUP_SCOPE, MAX_GROUPS + 1]);
      if (groups.rows.length > MAX_GROUPS || members.rows.length > MAX_MEMBERSHIPS
        || grants.rows.length > MAX_GROUPS) {
        throw new GroupUnavailable('group state exceeds supported profile');
      }
      await client.query('COMMIT');
      return {
        groupGeneration: gate.rows[0].group_generation,
        groups: groups.rows.map(row => ({ id: row.id, parentId: row.parent_id,
          generation: row.generation })),
        members: members.rows.map(row => ({ id: row.id, groupId: row.group_id,
          agentSubject: row.agent_subject, generation: row.generation })),
        grants: grants.rows.map(row => ({ id: row.id, groupId: row.group_id,
          issuerSubject: row.issuer_subject, validUntil: row.valid_until.toISOString(),
          generation: row.generation, membershipDependency: row.membership_id
            ? { membershipId: row.membership_id, generation: row.membership_generation! } : null })),
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new GroupUnavailable('group state could not be read');
      }
      throw error;
    } finally { client.release(); }
  }

  private async mutate(context: GroupMutationContext, assigning: boolean,
    action: GroupChangeAction, receipt: GroupChangeReceipt | undefined,
    work: (client: PoolClient) => Promise<string>): Promise<string> {
    if (!agentPattern.test(context.issuerSubject)
      || !/^(0|[1-9][0-9]*)$/.test(context.expectedGroupGeneration)
      || receipt && (!receipt.idempotencyKey || receipt.idempotencyKey.length > 128
        || !/^[0-9a-f]{64}$/.test(receipt.requestDigest))) {
      throw new GroupDenied('invalid group mutation context');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (recovery.rows[0]?.open !== true) throw new GroupUnavailable('Access recovery is held');
      const gate = await client.query<{ group_generation: string; open: boolean; dispatch_open: boolean }>(
        'SELECT group_generation, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE',
        [GROUP_SCOPE]);
      if (!gate.rows[0] || !gate.rows[0].open || !gate.rows[0].dispatch_open) {
        throw new GroupDenied('group scope is closed');
      }
      const principalId = await this.authorize(client, context.principal,
        context.issuerSubject, assigning);
      if (receipt) {
        const prior = await client.query<{
          request_digest: string; issuer_subject: string; action: string; result_generation: string;
        }>(`SELECT request_digest, issuer_subject, action, result_generation
          FROM access.group_change_receipt WHERE principal_id = $1 AND idempotency_key = $2
          FOR SHARE`, [principalId, receipt.idempotencyKey]);
        if (prior.rows[0]) {
          if (prior.rows[0].request_digest !== receipt.requestDigest
            || prior.rows[0].issuer_subject !== context.issuerSubject
            || prior.rows[0].action !== action) {
            throw new GroupConflict('group change key was used for another intent');
          }
          await client.query('COMMIT');
          return prior.rows[0].result_generation;
        }
      }
      if (gate.rows[0].group_generation !== context.expectedGroupGeneration) {
        throw new GroupStale('group generation changed');
      }
      const value = await work(client);
      if (receipt) {
        await client.query(`INSERT INTO access.group_change_receipt
          (principal_id, idempotency_key, request_digest, issuer_subject, action, result_generation)
          VALUES ($1,$2,$3,$4,$5,$6)`, [principalId, receipt.idempotencyKey,
          receipt.requestDigest, context.issuerSubject, action, value]);
      }
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new GroupUnavailable('group mutation could not complete');
      }
      throw error;
    } finally { client.release(); }
  }

  async create(context: GroupMutationContext, id: string, parentId: string | null,
    receipt?: GroupChangeReceipt): Promise<string> {
    if (!idPattern.test(id) || (parentId !== null && !idPattern.test(parentId))) {
      throw new GroupDenied('invalid group identifier');
    }
    return this.mutate(context, false, 'create', receipt, async client => {
      const count = await client.query<{ count: string }>(
        'SELECT count(*) AS count FROM access.recipient_group WHERE scope_id = $1', [GROUP_SCOPE]);
      if (Number(count.rows[0]?.count) >= MAX_GROUPS) throw new GroupUnavailable('group count exceeds profile');
      if (parentId) await this.assertParent(client, id, parentId, 0);
      await client.query(`INSERT INTO access.recipient_group (id, scope_id, parent_id)
        VALUES ($1, $2, $3)`, [id, GROUP_SCOPE, parentId]);
      return (await this.generation(client));
    });
  }

  async reparent(context: GroupMutationContext, id: string, expectedGeneration: string,
    parentId: string | null, receipt?: GroupChangeReceipt): Promise<string> {
    if (!idPattern.test(id) || (parentId !== null && !idPattern.test(parentId))) {
      throw new GroupDenied('invalid group identifier');
    }
    return this.mutate(context, false, 'reparent', receipt, async client => {
      const current = await client.query<{ generation: string; parent_id: string | null }>(
        'SELECT generation, parent_id FROM access.recipient_group WHERE id = $1 AND scope_id = $2 FOR UPDATE',
        [id, GROUP_SCOPE]);
      if (!current.rows[0]) throw new GroupDenied('group does not exist in scope');
      if (current.rows[0].generation !== expectedGeneration) throw new GroupStale('group generation changed');
      if (current.rows[0].parent_id === parentId) return this.generation(client);
      // This profile has no independent impact approval. Even a currently
      // ungranted populated subtree could acquire a different parent ceiling.
      const populated = await client.query(`WITH RECURSIVE subtree(id) AS (
        SELECT id FROM access.recipient_group WHERE id = $1
        UNION SELECT g.id FROM access.recipient_group g JOIN subtree s ON g.parent_id = s.id
      ) SELECT m.id FROM access.group_member m JOIN subtree s ON s.id = m.group_id
        WHERE m.active LIMIT 1`, [id]);
      if (populated.rows[0]) throw new GroupDenied('populated reparent needs impact approval');
      const height = await client.query<{ height: number }>(`WITH RECURSIVE subtree(id, depth) AS (
        SELECT id, 0 FROM access.recipient_group WHERE id = $1
        UNION ALL SELECT g.id, s.depth + 1 FROM access.recipient_group g
          JOIN subtree s ON g.parent_id = s.id
      ) SELECT max(depth)::integer AS height FROM subtree`, [id]);
      if (parentId) await this.assertParent(client, id, parentId, height.rows[0]?.height ?? 0);
      await client.query(`UPDATE access.recipient_group SET parent_id = $2,
        generation = generation + 1 WHERE id = $1`, [id, parentId]);
      return this.generation(client);
    });
  }

  async addMember(context: GroupMutationContext, id: string, groupId: string,
    agentSubject: string, receipt?: GroupChangeReceipt): Promise<string> {
    if (!idPattern.test(id) || !idPattern.test(groupId) || !agentPattern.test(agentSubject)) {
      throw new GroupDenied('invalid group member');
    }
    return this.mutate(context, true, 'add-member', receipt, async client => {
      await this.requireGroup(client, groupId);
      const subject = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [agentSubject]);
      if (!subject.rows[0]) throw new GroupDenied('member Agent is not admitted');
      const total = await client.query<{ count: string }>(`SELECT count(*) AS count
        FROM access.group_member m JOIN access.recipient_group g ON g.id = m.group_id
        WHERE g.scope_id = $1 AND m.active`, [GROUP_SCOPE]);
      const perAgent = await client.query<{ count: string }>(`SELECT count(*) AS count
        FROM access.group_member WHERE agent_subject = $1 AND active`, [agentSubject]);
      if (Number(total.rows[0]?.count) >= MAX_MEMBERSHIPS
        || Number(perAgent.rows[0]?.count) >= MAX_MEMBER_GROUPS) {
        throw new GroupUnavailable('group membership exceeds supported profile');
      }
      await client.query(`INSERT INTO access.group_member (id, group_id, agent_subject)
        VALUES ($1, $2, $3)`, [id, groupId, agentSubject]);
      return this.generation(client);
    });
  }

  async grant(context: GroupMutationContext, id: string, groupId: string,
    validUntil: Date, receipt?: GroupChangeReceipt,
    membershipDependency?: MembershipDependency): Promise<string> {
    if (!idPattern.test(id) || !idPattern.test(groupId) || Number.isNaN(validUntil.getTime())
      || !validMembershipDependency(membershipDependency)) {
      throw new GroupDenied('invalid group grant');
    }
    return this.mutate(context, true, 'grant', receipt, async client => {
      if (validUntil.getTime() <= Date.now()) throw new GroupDenied('expired group grant');
      await this.requireGroup(client, groupId);
      const ceiling = await client.query<{ valid_until: Date }>(`SELECT valid_until
        FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2
          AND action = 'access.group.assign.work.create' AND active
          AND valid_until >= $3 ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
      [context.issuerSubject, GROUP_SCOPE, validUntil]);
      if (!ceiling.rows[0]) throw new GroupDenied('grant lifetime exceeds assignment ceiling');
      if (membershipDependency && !await currentMembershipDependency(client,
        membershipDependency)) {
        throw new GroupDenied('membership dependency is stale');
      }
      const total = await client.query<{ count: string }>(`SELECT count(*) AS count
        FROM access.group_permission_grant WHERE scope_id = $1 AND active`, [GROUP_SCOPE]);
      if (Number(total.rows[0]?.count) >= MAX_GROUPS) {
        throw new GroupUnavailable('group grants exceed supported profile');
      }
      await client.query(`INSERT INTO access.group_permission_grant
        (id, group_id, issuer_subject, scope_id, action, valid_until,
          membership_id, membership_generation)
        VALUES ($1, $2, $3, $4, 'work.create', $5, $6, $7)`,
      [id, groupId, context.issuerSubject, GROUP_SCOPE, validUntil,
        membershipDependency?.membershipId ?? null, membershipDependency?.generation ?? null]);
      return this.generation(client);
    });
  }

  async revokeMember(context: GroupMutationContext, memberId: string,
    expectedGeneration: string, receipt?: GroupChangeReceipt): Promise<string> {
    if (!idPattern.test(memberId)) throw new GroupDenied('invalid member identifier');
    return this.mutate(context, false, 'revoke-member', receipt, async client => {
      const row = await client.query<{ generation: string; active: boolean }>(`
        SELECT m.generation, m.active FROM access.group_member m
        JOIN access.recipient_group g ON g.id = m.group_id
        WHERE m.id = $1 AND g.scope_id = $2 FOR UPDATE OF m`, [memberId, GROUP_SCOPE]);
      if (!row.rows[0]) throw new GroupDenied('member does not exist in scope');
      if (row.rows[0].generation !== expectedGeneration) throw new GroupStale('member generation changed');
      if (row.rows[0].active) await client.query(`UPDATE access.group_member
        SET active = false, generation = generation + 1 WHERE id = $1`, [memberId]);
      return this.generation(client);
    });
  }

  async revokeGrant(context: GroupMutationContext, grantId: string,
    expectedGeneration: string, receipt?: GroupChangeReceipt): Promise<string> {
    if (!idPattern.test(grantId)) throw new GroupDenied('invalid grant identifier');
    return this.mutate(context, false, 'revoke-grant', receipt, async client => {
      const row = await client.query<{ generation: string; active: boolean }>(`
        SELECT generation, active FROM access.group_permission_grant
        WHERE id = $1 AND scope_id = $2 FOR UPDATE`, [grantId, GROUP_SCOPE]);
      if (!row.rows[0]) throw new GroupDenied('grant does not exist in scope');
      if (row.rows[0].generation !== expectedGeneration) throw new GroupStale('grant generation changed');
      if (row.rows[0].active) await client.query(`UPDATE access.group_permission_grant
        SET active = false, generation = generation + 1 WHERE id = $1`, [grantId]);
      return this.generation(client);
    });
  }

  private async requireCeiling(client: PoolClient, issuerSubject: string,
    action: 'access.group.assign.work.create' | 'access.group.approve.work.create',
    validUntil: Date): Promise<void> {
    const row = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3
        AND active AND valid_until >= $4 AND valid_until > clock_timestamp()
      ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
    [issuerSubject, GROUP_SCOPE, action, validUntil]);
    if (!row.rows[0]) throw new GroupDenied('group impact exceeds current authority ceiling');
  }

  private async ancestorGrants(client: PoolClient, startId: string | null): Promise<GrantLimit[]> {
    if (!startId) return [];
    const path = await client.query<{ id: string; parent_id: string | null; depth: number }>(`
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT id, parent_id, 1 FROM access.recipient_group
        WHERE id = $1 AND scope_id = $2
        UNION ALL
        SELECT g.id, g.parent_id, a.depth + 1 FROM access.recipient_group g
        JOIN ancestors a ON g.id = a.parent_id
        WHERE a.depth < $3 AND g.scope_id = $2
      ) SELECT id, parent_id, depth FROM ancestors`, [startId, GROUP_SCOPE, MAX_DEPTH]);
    if (!path.rows[0]) throw new GroupDenied('impact parent is outside scope');
    if (path.rows.some(row => row.depth >= MAX_DEPTH && row.parent_id)) {
      throw new GroupUnavailable('group impact path exceeds supported profile');
    }
    const grants = await client.query<GrantLimit>(`SELECT id, valid_until
      FROM access.group_permission_grant WHERE group_id = ANY($1::uuid[])
        AND scope_id = $2 AND action = 'work.create' AND active
        AND valid_until > clock_timestamp() ORDER BY id LIMIT $3`,
    [path.rows.map(row => row.id), GROUP_SCOPE, MAX_GROUPS + 1]);
    if (grants.rows.length > MAX_GROUPS) {
      throw new GroupUnavailable('group impact grants exceed supported profile');
    }
    return grants.rows;
  }

  private async impact(client: PoolClient, groupId: string,
    expectedObjectGeneration: string, parentId: string | null): Promise<GroupImpact> {
    const groupCount = await client.query(`SELECT id FROM access.recipient_group
      WHERE scope_id = $1 LIMIT $2`, [GROUP_SCOPE, MAX_GROUPS + 1]);
    if (groupCount.rows.length > MAX_GROUPS) {
      throw new GroupUnavailable('group impact topology exceeds supported profile');
    }
    const current = await client.query<{ parent_id: string | null; generation: string }>(`
      SELECT parent_id, generation FROM access.recipient_group
      WHERE id = $1 AND scope_id = $2 FOR UPDATE`, [groupId, GROUP_SCOPE]);
    if (!current.rows[0]) throw new GroupDenied('impact group is outside scope');
    if (current.rows[0].generation !== expectedObjectGeneration) {
      throw new GroupStale('impact group generation changed');
    }
    if (current.rows[0].parent_id === parentId) throw new GroupDenied('impact change has no effect');
    const subtree = await client.query<{ id: string }>(`WITH RECURSIVE subtree(id) AS (
      SELECT id FROM access.recipient_group WHERE id = $1
      UNION SELECT g.id FROM access.recipient_group g JOIN subtree s ON g.parent_id = s.id
    ) SELECT id FROM subtree LIMIT $2`, [groupId, MAX_GROUPS + 1]);
    if (subtree.rows.length > MAX_GROUPS) {
      throw new GroupUnavailable('group impact subtree exceeds supported profile');
    }
    const members = await client.query<{ id: string; agent_subject: string }>(`
      SELECT id, agent_subject FROM access.group_member
      WHERE group_id = ANY($1::uuid[]) AND active ORDER BY id LIMIT $2`,
    [subtree.rows.map(row => row.id), MAX_MEMBERSHIPS + 1]);
    if (members.rows.length > MAX_MEMBERSHIPS) {
      throw new GroupUnavailable('group impact members exceed supported profile');
    }
    if (members.rows.length === 0) throw new GroupDenied('empty reparent uses group-changes');
    const height = await client.query<{ height: number }>(`WITH RECURSIVE subtree(id, depth) AS (
      SELECT id, 0 FROM access.recipient_group WHERE id = $1
      UNION ALL SELECT g.id, s.depth + 1 FROM access.recipient_group g
      JOIN subtree s ON g.parent_id = s.id WHERE s.depth < $2
    ) SELECT max(depth)::integer AS height FROM subtree`, [groupId, MAX_DEPTH + 1]);
    if ((height.rows[0]?.height ?? 0) > MAX_DEPTH) {
      throw new GroupUnavailable('group impact depth exceeds supported profile');
    }
    if (parentId) await this.assertParent(client, groupId, parentId, height.rows[0]?.height ?? 0);
    const before = await this.ancestorGrants(client, current.rows[0].parent_id);
    const after = await this.ancestorGrants(client, parentId);
    const beforeIds = new Set(before.map(grant => grant.id));
    const afterIds = new Set(after.map(grant => grant.id));
    const gained = after.filter(grant => !beforeIds.has(grant.id));
    const lost = before.filter(grant => !afterIds.has(grant.id));
    const gainedGrantIds = gained.map(grant => grant.id);
    const lostGrantIds = lost.map(grant => grant.id);
    const impactDigest = groupChangeIntentDigest({ groupId, parentId,
      members: members.rows.map(row => [row.id, row.agent_subject]),
      before: before.map(grant => [grant.id, grant.valid_until.toISOString()]),
      after: after.map(grant => [grant.id, grant.valid_until.toISOString()]) });
    return { impactDigest,
      affectedMemberCount: new Set(members.rows.map(row => row.agent_subject)).size,
      gainedGrantIds, lostGrantIds,
      gainedValidUntil: gained.reduce<Date | null>((max, grant) =>
        !max || grant.valid_until > max ? grant.valid_until : max, null) };
  }

  private preview(row: GroupImpactRow, groupGeneration: string): GroupImpactPreview {
    const status = row.result_generation !== null ? 'activated'
      : row.expected_scope_generation !== groupGeneration || row.expires_at.getTime() <= Date.now()
        ? 'stale' : 'pending';
    return { proposalId: row.id, issuerSubject: row.issuer_subject,
      groupId: row.group_id, parentId: row.parent_id,
      expectedGroupGeneration: row.expected_scope_generation,
      expectedObjectGeneration: row.expected_object_generation,
      impactDigest: row.impact_digest, affectedMemberCount: row.affected_member_count,
      gainedGrantIds: row.gained_grant_ids, lostGrantIds: row.lost_grant_ids,
      expiresAt: row.expires_at.toISOString(), status,
      activatedGeneration: row.result_generation };
  }

  private async proposal(client: PoolClient, id: string): Promise<GroupImpactRow | null> {
    const result = await client.query<GroupImpactRow>(`SELECT p.*,
      a.result_generation FROM access.group_impact_proposal p
      LEFT JOIN access.group_impact_activation a ON a.proposal_id = p.id
      WHERE p.id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  async proposeImpact(context: GroupMutationContext, proposalId: string, groupId: string,
    expectedObjectGeneration: string, parentId: string | null,
    requestDigest: string, idempotencyKey: string): Promise<GroupImpactPreview> {
    if (!idPattern.test(proposalId) || !idPattern.test(groupId)
      || parentId !== null && !idPattern.test(parentId)
      || !/^(0|[1-9][0-9]*)$/.test(expectedObjectGeneration)
      || !/^[0-9a-f]{64}$/.test(requestDigest)
      || !idempotencyKey || idempotencyKey.length > 128 || idempotencyKey.includes('\0')) {
      throw new GroupDenied('invalid impact proposal');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (recovery.rows[0]?.open !== true) throw new GroupUnavailable('Access recovery is held');
      const gate = await client.query<{ group_generation: string; open: boolean; dispatch_open: boolean }>(
        'SELECT group_generation, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE',
        [GROUP_SCOPE]);
      if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) throw new GroupDenied('group scope is closed');
      const principalId = await this.authorize(client, context.principal, context.issuerSubject, false);
      const prior = await this.proposal(client, proposalId);
      if (prior) {
        if (prior.requested_by !== principalId || prior.issuer_subject !== context.issuerSubject
          || prior.request_digest !== requestDigest || prior.idempotency_key !== idempotencyKey) {
          throw new GroupConflict('impact proposal identity binds another intent');
        }
        await client.query('COMMIT');
        return this.preview(prior, gate.rows[0].group_generation);
      }
      const usedKey = await client.query<{ id: string }>(`SELECT id
        FROM access.group_impact_proposal WHERE requested_by = $1 AND idempotency_key = $2`,
      [principalId, idempotencyKey]);
      if (usedKey.rows[0]) throw new GroupConflict('impact proposal key binds another intent');
      if (gate.rows[0].group_generation !== context.expectedGroupGeneration) {
        throw new GroupStale('group impact scope generation changed');
      }
      const impact = await this.impact(client, groupId, expectedObjectGeneration, parentId);
      if (impact.gainedValidUntil) {
        await this.requireCeiling(client, context.issuerSubject,
          'access.group.assign.work.create', impact.gainedValidUntil);
      }
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await client.query(`INSERT INTO access.group_impact_proposal
        (id, requested_by, issuer_subject, group_id, parent_id,
        expected_scope_generation, expected_object_generation, idempotency_key, request_digest,
        impact_digest, affected_member_count, gained_grant_ids, lost_grant_ids, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [proposalId, principalId, context.issuerSubject, groupId, parentId,
        context.expectedGroupGeneration, expectedObjectGeneration, idempotencyKey, requestDigest,
        impact.impactDigest, impact.affectedMemberCount,
        impact.gainedGrantIds, impact.lostGrantIds, expiresAt]);
      await client.query('COMMIT');
      return { proposalId, issuerSubject: context.issuerSubject, groupId, parentId,
        expectedGroupGeneration: context.expectedGroupGeneration, expectedObjectGeneration,
        impactDigest: impact.impactDigest, affectedMemberCount: impact.affectedMemberCount,
        gainedGrantIds: impact.gainedGrantIds, lostGrantIds: impact.lostGrantIds,
        expiresAt: expiresAt.toISOString(), status: 'pending', activatedGeneration: null };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new GroupUnavailable('group impact proposal could not complete');
      }
      throw error;
    } finally { client.release(); }
  }

  async readImpactProposal(principal: VerifiedPrincipal, approverSubject: string,
    proposalId: string): Promise<GroupImpactPreview> {
    if (!agentPattern.test(approverSubject) || !idPattern.test(proposalId)) {
      throw new GroupDenied('invalid impact read');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (recovery.rows[0]?.open !== true) throw new GroupUnavailable('Access recovery is held');
      const gate = await client.query<{ group_generation: string; open: boolean; dispatch_open: boolean }>(
        'SELECT group_generation, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR SHARE',
        [GROUP_SCOPE]);
      if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) throw new GroupDenied('group scope is closed');
      await this.authorize(client, principal, approverSubject, false, 'access.group.approve');
      const row = await this.proposal(client, proposalId);
      if (!row) throw new GroupDenied('impact proposal is unavailable');
      await client.query('COMMIT');
      return this.preview(row, gate.rows[0].group_generation);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new GroupUnavailable('group impact read could not complete');
      }
      throw error;
    } finally { client.release(); }
  }

  async approveImpact(principal: VerifiedPrincipal, approverSubject: string,
    proposalId: string, impactDigest: string, idempotencyKey: string): Promise<string> {
    if (!agentPattern.test(approverSubject) || !idPattern.test(proposalId)
      || !/^[0-9a-f]{64}$/.test(impactDigest)
      || !idempotencyKey || idempotencyKey.length > 128 || idempotencyKey.includes('\0')) {
      throw new GroupDenied('invalid impact approval');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const recovery = await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
      if (recovery.rows[0]?.open !== true) throw new GroupUnavailable('Access recovery is held');
      const gate = await client.query<{ group_generation: string; open: boolean; dispatch_open: boolean }>(
        'SELECT group_generation, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE',
        [GROUP_SCOPE]);
      if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) throw new GroupDenied('group scope is closed');
      const approverId = await this.authorize(client, principal, approverSubject,
        false, 'access.group.approve');
      const usedKey = await client.query<{ proposal_id: string }>(`SELECT proposal_id
        FROM access.group_impact_activation WHERE approved_by = $1 AND idempotency_key = $2`,
      [approverId, idempotencyKey]);
      if (usedKey.rows[0] && usedKey.rows[0].proposal_id !== proposalId) {
        throw new GroupConflict('impact approval key binds another proposal');
      }
      const row = await this.proposal(client, proposalId);
      if (!row) throw new GroupDenied('impact proposal is unavailable');
      if (row.result_generation !== null) {
        const activation = await client.query<{
          approved_by: string; approval_issuer: string; idempotency_key: string;
        }>(`SELECT approved_by, approval_issuer, idempotency_key
          FROM access.group_impact_activation WHERE proposal_id = $1`, [proposalId]);
        if (activation.rows[0]?.approved_by !== approverId
          || activation.rows[0]?.approval_issuer !== approverSubject
          || activation.rows[0]?.idempotency_key !== idempotencyKey
          || row.impact_digest !== impactDigest) {
          throw new GroupConflict('impact approval identity binds another intent');
        }
        await client.query('COMMIT');
        return row.result_generation;
      }
      if (row.requested_by === approverId || row.issuer_subject === approverSubject) {
        throw new GroupDenied('impact approval must be independent');
      }
      if (row.impact_digest !== impactDigest || row.expires_at.getTime() <= Date.now()
        || row.expected_scope_generation !== gate.rows[0].group_generation) {
        throw new GroupStale('impact proposal is stale');
      }
      const requester = await client.query<{ account_issuer: string; account_subject: string }>(`
        SELECT account_issuer, account_subject FROM access.principal WHERE id = $1 FOR SHARE`,
      [row.requested_by]);
      if (!requester.rows[0]) throw new GroupDenied('impact requester is unavailable');
      const requesterId = await this.authorize(client, {
        issuer: requester.rows[0].account_issuer, subject: requester.rows[0].account_subject,
      }, row.issuer_subject, false);
      if (requesterId !== row.requested_by) throw new GroupDenied('impact requester changed');
      const impact = await this.impact(client, row.group_id,
        row.expected_object_generation, row.parent_id);
      if (impact.impactDigest !== row.impact_digest
        || impact.affectedMemberCount !== row.affected_member_count) {
        throw new GroupStale('impact preview changed');
      }
      if (impact.gainedValidUntil) {
        await this.requireCeiling(client, row.issuer_subject,
          'access.group.assign.work.create', impact.gainedValidUntil);
        await this.requireCeiling(client, approverSubject,
          'access.group.approve.work.create', impact.gainedValidUntil);
      }
      await client.query(`UPDATE access.recipient_group SET parent_id = $2,
        generation = generation + 1 WHERE id = $1`, [row.group_id, row.parent_id]);
      const resultGeneration = await this.generation(client);
      await client.query(`INSERT INTO access.group_impact_activation
        (proposal_id, approved_by, approval_issuer, idempotency_key,
        impact_digest, result_generation) VALUES ($1,$2,$3,$4,$5,$6)`,
      [proposalId, approverId, approverSubject, idempotencyKey,
        impactDigest, resultGeneration]);
      await client.query('COMMIT');
      return resultGeneration;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      if (error && typeof error === 'object' && 'code' in error
        && ['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        throw new GroupUnavailable('group impact approval could not complete');
      }
      throw error;
    } finally { client.release(); }
  }

  private async requireGroup(client: PoolClient, id: string): Promise<void> {
    const row = await client.query(`SELECT id FROM access.recipient_group
      WHERE id = $1 AND scope_id = $2 FOR SHARE`, [id, GROUP_SCOPE]);
    if (!row.rows[0]) throw new GroupDenied('group does not exist in scope');
  }

  private async assertParent(client: PoolClient, id: string, parentId: string,
    subtreeHeight: number): Promise<void> {
    const rows = await client.query<{ id: string; parent_id: string | null; depth: number }>(`
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT id, parent_id, 1 FROM access.recipient_group WHERE id = $1 AND scope_id = $2
        UNION ALL
        SELECT p.id, p.parent_id, a.depth + 1 FROM access.recipient_group p
        JOIN ancestors a ON p.id = a.parent_id WHERE a.depth <= $3
      ) SELECT * FROM ancestors`, [parentId, GROUP_SCOPE, MAX_DEPTH]);
    if (!rows.rows[0]) throw new GroupDenied('parent is outside scope');
    if (rows.rows.some(row => row.id === id)) throw new GroupDenied('group cycle');
    if (rows.rows.some(row => row.depth >= MAX_DEPTH && row.parent_id)
      || rows.rows.length + subtreeHeight > MAX_DEPTH) {
      throw new GroupUnavailable('group depth exceeds supported profile');
    }
  }

  private async generation(client: PoolClient): Promise<string> {
    const row = await client.query<{ group_generation: string }>(
      'SELECT group_generation FROM access.scope_gate WHERE id = $1', [GROUP_SCOPE]);
    return row.rows[0]!.group_generation;
  }
}
