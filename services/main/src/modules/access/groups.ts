import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';

export class GroupDenied extends Error {}
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
      SELECT id FROM access.group_permission_grant
      WHERE group_id = p.group_id AND scope_id = $2 AND action = 'work.create'
        AND active AND valid_until > clock_timestamp()
      ORDER BY id LIMIT 1
    ) gr ON true ORDER BY p.member_id, p.depth, gr.id`,
  [members.rows.map(row => row.id), scope, MAX_DEPTH]);
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
      SELECT true AS granted FROM access.group_permission_grant
      WHERE group_id = p.group_id AND scope_id = $2 AND action = 'work.create'
        AND active AND valid_until > clock_timestamp() LIMIT 1
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
      AND gr.valid_until > clock_timestamp() LIMIT 1`,
  [memberId, subject, grantId, GROUP_SCOPE, MAX_DEPTH]);
  return found.rowCount === 1;
}

export interface GroupMutationContext {
  principal: VerifiedPrincipal;
  issuerSubject: string;
  expectedGroupGeneration: string;
}

/** Internal Access-owner mutation boundary. Only the ordinary work.create
 * assignment ceiling is supported. Protected roles and approvals remain closed. */
export class AccessGroups {
  constructor(private readonly pool: Pool) {}

  private async mutate<T>(context: GroupMutationContext, assigning: boolean,
    work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!agentPattern.test(context.issuerSubject)
      || !/^(0|[1-9][0-9]*)$/.test(context.expectedGroupGeneration)) {
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
      if (gate.rows[0].group_generation !== context.expectedGroupGeneration) {
        throw new GroupStale('group generation changed');
      }
      const actor = await client.query<{ id: string }>(`
        SELECT p.id FROM access.principal p
        JOIN access.representation r ON r.principal_id = p.id
        JOIN access.authority_subject s ON s.id = r.subject_id
        WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
          AND r.subject_id = $3 AND r.action = 'access.group.manage'
          AND r.active AND r.valid_until > clock_timestamp()
          AND s.kind = 'agent' AND s.active
          AND EXISTS (SELECT 1 FROM access.permission_grant g
            WHERE g.recipient_subject = $3 AND g.scope_id = $4
              AND g.action = 'access.group.manage' AND g.active
              AND g.valid_until > clock_timestamp())
        LIMIT 1 FOR SHARE OF p, r, s`,
      [context.principal.issuer, context.principal.subject, context.issuerSubject, GROUP_SCOPE]);
      if (!actor.rows[0]) throw new GroupDenied('group management authority is missing');
      const manage = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'access.group.manage'
          AND active AND valid_until > clock_timestamp() LIMIT 1 FOR SHARE`,
      [context.issuerSubject, GROUP_SCOPE]);
      if (!manage.rows[0]) throw new GroupDenied('group management authority changed');
      if (assigning) {
        const ceiling = await client.query(`SELECT id FROM access.permission_grant
          WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'access.group.assign.work.create'
            AND active AND valid_until > clock_timestamp() LIMIT 1 FOR SHARE`,
        [context.issuerSubject, GROUP_SCOPE]);
        if (!ceiling.rows[0]) throw new GroupDenied('work.create assignment ceiling is missing');
      }
      const value = await work(client);
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

  async create(context: GroupMutationContext, id: string, parentId: string | null): Promise<string> {
    if (!idPattern.test(id) || (parentId !== null && !idPattern.test(parentId))) {
      throw new GroupDenied('invalid group identifier');
    }
    return this.mutate(context, false, async client => {
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
    parentId: string | null): Promise<string> {
    if (!idPattern.test(id) || (parentId !== null && !idPattern.test(parentId))) {
      throw new GroupDenied('invalid group identifier');
    }
    return this.mutate(context, false, async client => {
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
    agentSubject: string): Promise<string> {
    if (!idPattern.test(id) || !idPattern.test(groupId) || !agentPattern.test(agentSubject)) {
      throw new GroupDenied('invalid group member');
    }
    return this.mutate(context, true, async client => {
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
    validUntil: Date): Promise<string> {
    if (!idPattern.test(id) || !idPattern.test(groupId) || Number.isNaN(validUntil.getTime())
      || validUntil.getTime() <= Date.now()) throw new GroupDenied('invalid group grant');
    return this.mutate(context, true, async client => {
      await this.requireGroup(client, groupId);
      const ceiling = await client.query<{ valid_until: Date }>(`SELECT valid_until
        FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2
          AND action = 'access.group.assign.work.create' AND active
          AND valid_until >= $3 ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
      [context.issuerSubject, GROUP_SCOPE, validUntil]);
      if (!ceiling.rows[0]) throw new GroupDenied('grant lifetime exceeds assignment ceiling');
      const total = await client.query<{ count: string }>(`SELECT count(*) AS count
        FROM access.group_permission_grant WHERE scope_id = $1 AND active`, [GROUP_SCOPE]);
      if (Number(total.rows[0]?.count) >= MAX_GROUPS) {
        throw new GroupUnavailable('group grants exceed supported profile');
      }
      await client.query(`INSERT INTO access.group_permission_grant
        (id, group_id, issuer_subject, scope_id, action, valid_until)
        VALUES ($1, $2, $3, $4, 'work.create', $5)`,
      [id, groupId, context.issuerSubject, GROUP_SCOPE, validUntil]);
      return this.generation(client);
    });
  }

  async revokeMember(context: GroupMutationContext, memberId: string,
    expectedGeneration: string): Promise<string> {
    if (!idPattern.test(memberId)) throw new GroupDenied('invalid member identifier');
    return this.mutate(context, false, async client => {
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
    expectedGeneration: string): Promise<string> {
    if (!idPattern.test(grantId)) throw new GroupDenied('invalid grant identifier');
    return this.mutate(context, false, async client => {
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
