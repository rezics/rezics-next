import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool, type PoolClient } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { agentControlTable, agentRecoveryTable, CONTROL_ACTION } from
  '../../../services/main/src/modules/access/agent-control-schema.ts';
import { grantLineageTable } from '../../../services/main/src/modules/access/grant-lineage-schema.ts';
import { ACCEPT_ACTION, agentInvitationAcceptanceTable, agentInvitationRevocationTable,
  agentInvitationTable } from '../../../services/main/src/modules/access/invitation-schema.ts';
import { automationEnrollmentTable, automationInstallationTable,
  protectedChangeActivationTable, protectedChangeApprovalTable,
  protectedChangeProposalTable, protectedEffectTables, protectedSetTable,
  type ProtectedChangeKind } from '../../../services/main/src/modules/access/protected-set-schema.ts';
import { admissionObligationTable, authorityControlReceiptTable, GUARD_LIMIT, GUARD_VIOLATION,
  representationAddedColumns, representationEdgeTable, representationPathProofTable,
  representationPathStepTable, representativePolicyRevisionTable, representativePolicyTable,
  type TableDeclaration, TOPOLOGY_SCOPE } from '../../../services/main/src/modules/access/topology-schema.ts';

const root = resolve(import.meta.dir, '../../..');
const migrationDirectory = join(root, 'services/main/migrations/access');
const migrations = [...new Bun.Glob('*.sql').scanSync({ cwd: migrationDirectory })].sort();
// This owner schema is exactly the reserved 050-059 range; everything else is head.
const owned = migrations.filter(file => /^05[0-9]_/.test(file));
const SCOPE = 'work:create:root';
const declarations: TableDeclaration[] = [representationEdgeTable, representationPathProofTable,
  representationPathStepTable, admissionObligationTable, authorityControlReceiptTable,
  representativePolicyTable, representativePolicyRevisionTable, protectedChangeProposalTable,
  protectedChangeApprovalTable, protectedChangeActivationTable, protectedSetTable,
  automationInstallationTable, automationEnrollmentTable, grantLineageTable, agentControlTable, agentRecoveryTable,
  agentInvitationTable, agentInvitationAcceptanceTable, agentInvitationRevocationTable];

type Queryable = Pool | PoolClient;
const iri = () => `https://rezics.com/id/${randomUUID()}`;

async function migrate(db: Queryable, files: string[]): Promise<void> {
  for (const file of files) await db.query(readFileSync(join(migrationDirectory, file), 'utf8'));
}

async function rejects(work: Promise<unknown>, code: string, reason: string): Promise<void> {
  const error = await work.then(() => undefined, (caught: unknown) => caught) as
    { code?: string; message?: string } | undefined;
  expect([error?.code, error?.message?.includes(reason)]).toEqual([code, true]);
}

async function tx(pool: Pool, work: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep the original error */ }
    throw error;
  } finally { client.release(); }
}

/** Order-independent description of every Access relation, key, index,
 * trigger and function, so two install paths can be compared exactly. */
async function catalog(db: Queryable): Promise<string[]> {
  const rows = await db.query<{ item: string }>(`
    SELECT 'column ' || table_name || '.' || column_name || ' ' || udt_name || ' '
      || is_nullable || ' ' || coalesce(column_default, '') AS item
    FROM information_schema.columns WHERE table_schema = 'access'
    UNION ALL SELECT 'constraint ' || conrelid::regclass::text || '.' || conname || ' '
      || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'access'::regnamespace
    UNION ALL SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'access'
    UNION ALL SELECT 'trigger ' || pg_get_triggerdef(oid) FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'access.%'
    UNION ALL SELECT 'function ' || proname || ' ' || md5(pg_get_functiondef(oid))
      FROM pg_proc WHERE pronamespace = 'access'::regnamespace
    ORDER BY 1`);
  return rows.rows.map(row => row.item);
}

/** Seed helpers write owner rows directly, as a bulk fixture would. */
function owner(db: Pool) {
  const q = (sql: string, values: unknown[] = []) => db.query(sql, values);
  const api = {
    q,
    async subject(): Promise<string> {
      const id = iri();
      await q("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [id]);
      return id;
    },
    async principal(): Promise<string> {
      const id = randomUUID();
      await q('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
        [id, 'https://account.topology.test', id]);
      return id;
    },
    async mandate(principal: string, subject: string, action: string, options: {
      maxPathEdges?: number; until?: string; policy?: [string, number]; change?: string;
      db?: Queryable } = {}): Promise<string> {
      const id = randomUUID();
      await (options.db ?? db).query(`INSERT INTO access.representation (id, principal_id, subject_id,
        action, valid_until, max_path_edges, representative_policy_id, representative_policy_revision,
        protected_change_id)
        VALUES ($1, $2, $3, $4, CASE WHEN $5 = 'infinity' THEN 'infinity'::timestamptz
          ELSE now() + $5::interval END, $6, $7, $8, $9)`,
      [id, principal, subject, action, options.until ?? '20 days', options.maxPathEdges ?? 0,
        options.policy?.[0] ?? null, options.policy?.[1] ?? null, options.change ?? null]);
      return id;
    },
    async grant(issuer: string, recipient: string, action: string, days = 10,
      client: Queryable = db): Promise<string> {
      const id = randomUUID();
      await client.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject,
        scope_id, action, valid_until) VALUES ($1, $2, $3, $4, $5, now() + $6::interval)`,
      [id, issuer, recipient, SCOPE, action, `${days} days`]);
      return id;
    },
    /** Represented subject's operator mandate and ceiling grant for issuing edges. */
    async edgeIssuer(represented: string, action: string) {
      const operator = await api.principal();
      const mandate = await api.mandate(operator, represented, 'access.representation.manage');
      const ceiling = await api.grant(await api.subject(), represented,
        `access.representation.assign.${action}`, 30);
      return { operator, mandate, ceiling };
    },
    async edge(representative: string, represented: string, action = 'work.create',
      maxPathEdges = 8, options: { until?: string; change?: string; client?: Queryable } = {}) {
      const issuer = await api.edgeIssuer(represented, action);
      const id = randomUUID();
      await (options.client ?? db).query(`INSERT INTO access.representation_edge (id,
        representative_subject, represented_subject, action, max_path_edges, valid_until,
        assigned_by_principal, issuer_representation_id, issuer_representation_generation,
        issuer_representation_action, ceiling_grant_id, ceiling_grant_generation,
        ceiling_scope_id, ceiling_action, protected_change_id)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 = 'infinity' THEN 'infinity'::timestamptz
          ELSE now() + $6::interval END, $7, $8, 0, 'access.representation.manage', $9, 0, $10,
          $11, $12)`,
      [id, representative, represented, action, maxPathEdges, options.until ?? '15 days',
        issuer.operator, issuer.mandate, issuer.ceiling, SCOPE,
        `access.representation.assign.${action}`, options.change ?? null]);
      return id;
    },
    async epoch(scope = TOPOLOGY_SCOPE): Promise<string> {
      return (await q('SELECT authority_epoch FROM access.scope_gate WHERE id = $1', [scope]))
        .rows[0].authority_epoch;
    },
    /** Stages, approves and activates one protected change in `client`. */
    async approvedChange(client: Queryable, change: { kind: ProtectedChangeKind;
      targetSubject: string; targetObject: string | null; approvalSubject: string;
      requestedBy: string; approvers: { principal: string; mandate: string }[];
      required?: number; generation?: string; notBefore?: string }): Promise<string> {
      const id = randomUUID();
      const digest = randomBytes(32).toString('hex');
      await client.query(`INSERT INTO access.protected_change_proposal (id, kind, target_subject,
        target_object, expected_object_generation, resulting_ceiling, staged_change, change_digest,
        approval_subject, required_approvals, requested_by, not_before, expires_at)
        VALUES ($1, $2, $3, $4, $5, '{work.create}', '{}', $6, $7, $8, $9,
          coalesce($10::timestamptz, now()), now() + interval '1 day')`,
      [id, change.kind, change.targetSubject, change.targetObject, change.generation ?? '0',
        digest, change.approvalSubject, change.required ?? 1, change.requestedBy,
        change.notBefore ?? null]);
      if (change.kind === 'agent-recovery') return id;
      await api.approve(client, id, change.approvalSubject, digest, change.approvers);
      await api.activate(client, id, change.kind, change.targetSubject, change.targetObject,
        change.requestedBy, change.approvers.length);
      return id;
    },
    async approve(client: Queryable, proposal: string, approvalSubject: string, digest: string,
      approvers: { principal: string; mandate: string }[]): Promise<void> {
      for (const approver of approvers) {
        await client.query(`INSERT INTO access.protected_change_approval (proposal_id,
          approver_principal, approver_subject, approver_representation_id,
          approver_representation_generation, approver_representation_action, change_digest)
          VALUES ($1, $2, $3, $4, 0, 'access.protected-change.approve', $5)`,
        [proposal, approver.principal, approvalSubject, approver.mandate, digest]);
      }
    },
    async activate(client: Queryable, proposal: string, kind: string, targetSubject: string,
      targetObject: string | null, by: string, approvals: number): Promise<void> {
      await client.query(`INSERT INTO access.protected_change_activation (proposal_id, kind,
        target_subject, target_object, activated_by, approval_count, result_object_generation)
        VALUES ($1, $2, $3, $4, $5, $6, 0)`, [proposal, kind, targetSubject, targetObject, by, approvals]);
    },
    async approver(approvalSubject: string) {
      const principal = await api.principal();
      return { principal, mandate: await api.mandate(principal, approvalSubject,
        'access.protected-change.approve') };
    },
  };
  return api;
}

describe('Access topology owner schema (G-047: IAM05 IAM08 IAM12 IAM13 IAM14 IAM27 IAM28 IAM30 IAM31 IAM32 owner rows)', () => {
  let admin: Client;
  let empty: Pool;
  let upgrade: Pool;
  let names: string[] = [];

  beforeAll(async () => {
    const runId = Bun.env.REZICS_QA_RUN_ID;
    if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId) || !Bun.env.ACCESS_DATABASE_URL) {
      throw new Error('Run through the isolated QA integration tier');
    }
    const compose = readEnv(join(root, '.temp', 'stack', `rezics-qa-${runId}`, 'compose.env'));
    admin = new Client({ connectionString: `postgres://postgres:${
      encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
    await admin.connect();
    const suffix = randomBytes(6).toString('hex');
    const owner = new URL(Bun.env.ACCESS_DATABASE_URL).username;
    const pools: Pool[] = [];
    for (const kind of ['empty', 'upgrade']) {
      const name = `qa_${suffix}_topology_${kind}`;
      await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`);
      names.push(name);
      const url = new URL(Bun.env.ACCESS_DATABASE_URL);
      url.pathname = `/${name}`;
      pools.push(new Pool({ connectionString: url.toString(), max: 4 }));
    }
    [empty, upgrade] = pools as [Pool, Pool];
    await migrate(empty, migrations);
    await empty.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [SCOPE]);
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([empty?.end(), upgrade?.end()]);
    for (const name of names.reverse()) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    names = [];
    await admin?.end();
  }, 60_000);

  test('empty install and upgrade from head reach one catalog and keep legacy authority rows', async () => {
    expect(owned).toEqual(['050_representation_topology.sql', '051_protected_change.sql',
      '052_representative_policy.sql', '053_grant_lineage.sql', '054_agent_control.sql',
      '055_agent_invitation.sql', '056_protected_rebind_and_enrollment.sql',
      '057_recovery_independence_on_edge.sql', '058_selected_grant_revocation.sql']);

    // Upgrade: current head, a populated legacy authority fixture, then 050-059.
    await migrate(upgrade, migrations.filter(file => !owned.includes(file)));
    const legacy = owner(upgrade);
    await legacy.q(`INSERT INTO access.scope_gate (id, authority_epoch, group_generation)
      VALUES ($1, 3, 0) ON CONFLICT (id) DO UPDATE
        SET authority_epoch = EXCLUDED.authority_epoch, group_generation = EXCLUDED.group_generation`, [SCOPE]);
    const [issuer, agent] = [await legacy.subject(), await legacy.subject()];
    const operator = await legacy.principal();
    // Head-shaped writer: it names none of the 050-059 columns.
    const legacyMandate = async (principal: string) => {
      const id = randomUUID();
      await legacy.q(`INSERT INTO access.representation (id, principal_id, subject_id, action,
        valid_until) VALUES ($1, $2, $3, 'work.create', now() + interval '5 days')`,
      [id, principal, agent]);
      return id;
    };
    const mandate = await legacyMandate(operator);
    const grant = await legacy.grant(issuer, agent, 'work.create');
    const group = randomUUID();
    await legacy.q('INSERT INTO access.recipient_group (id, scope_id) VALUES ($1, $2)', [group, SCOPE]);
    await legacy.q(`INSERT INTO access.group_member (id, group_id, agent_subject)
      VALUES ($1, $2, $3)`, [randomUUID(), group, agent]);
    await legacy.q(`INSERT INTO access.group_permission_grant (id, group_id, issuer_subject, scope_id,
      action, valid_until) VALUES ($1, $2, $3, $4, 'work.create', now() + interval '5 days')`,
    [randomUUID(), group, issuer, SCOPE]);
    const family = randomUUID();
    await tx(upgrade, async client => {
      await client.query(`INSERT INTO access.role_family (id, owner_subject, scope_id, head_revision)
        VALUES ($1, $2, $3, 1)`, [family, issuer, SCOPE]);
      await client.query(`INSERT INTO access.role_revision (family_id, revision, permissions)
        VALUES ($1, 1, '{work.create}')`, [family]);
    });
    await legacy.q(`INSERT INTO access.role_binding (id, family_id, role_revision, issuer_subject,
      recipient_subject, valid_until, assigned_by_principal)
      VALUES ($1, $2, 1, $3, $4, now() + interval '5 days', $5)`,
    [randomUUID(), family, issuer, agent, operator]);
    await legacy.q(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
      idempotency_key, request_digest, authority_epoch, expires_at, state,
      represented_representation_id, represented_representation_generation, represented_grant_id,
      represented_grant_generation, represented_subject_generation, represented_principal_epoch)
      VALUES ($1, $2, $3, $4, 'work.create', 'legacy', $5, 3, now() + interval '1 hour', 'registered',
        $6, 0, $7, 0, 0, 0)`,
    [randomUUID(), operator, agent, SCOPE, 'a'.repeat(64), mandate, grant]);
    const addedColumns = ['max_path_edges', 'automation_installation_id', 'representative_policy_id',
      'representative_policy_revision', 'protected_change_id'];
    const legacyTables = ['principal', 'authority_subject', 'representation', 'permission_grant',
      'recipient_group', 'group_member', 'group_permission_grant', 'role_family', 'role_revision',
      'role_binding', 'admission'];
    const snapshot = async () => {
      const rows: Record<string, unknown[]> = {};
      for (const table of legacyTables) {
        rows[table] = (await upgrade.query(`SELECT row FROM (SELECT to_jsonb(t) - $1::text[] AS row
          FROM access.${table} t) legacy ORDER BY row::text`, [addedColumns])).rows.map(r => r.row);
      }
      rows.scope_gate = (await upgrade.query(`SELECT to_jsonb(t) AS row FROM access.scope_gate t
        WHERE id <> $1 ORDER BY id`, [TOPOLOGY_SCOPE])).rows.map(r => r.row);
      return rows;
    };
    const before = await snapshot();
    await migrate(upgrade, owned);

    // Same generations and epochs: the migration fires no authority update.
    expect(await snapshot()).toEqual(before);
    expect((await upgrade.query(`SELECT max_path_edges, representative_policy_id,
      automation_installation_id, protected_change_id FROM access.representation WHERE id = $1`,
    [mandate])).rows[0]).toEqual({ max_path_edges: 0, representative_policy_id: null,
      automation_installation_id: null, protected_change_id: null });
    expect(await legacy.epoch()).toBe('0');
    expect(await catalog(upgrade)).toEqual(await catalog(empty));

    // Legacy writers keep working on unprotected rows without lineage.
    await legacy.q(`UPDATE access.permission_grant SET active = false, generation = generation + 1
      WHERE id = $1`, [grant]);
    await legacy.q(`INSERT INTO access.group_member (id, group_id, agent_subject)
      VALUES ($1, $2, $3)`, [randomUUID(), group, await legacy.subject()]);
    await legacyMandate(await legacy.principal());

    // Every typed declaration matches the installed columns exactly.
    for (const declaration of [...declarations, representationAddedColumns]) {
      const columns = await empty.query<{ column_name: string; udt_name: string; is_nullable: string }>(
        `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'access' AND table_name = $1`, [declaration.table]);
      const installed = Object.fromEntries(columns.rows.map(column => [column.column_name,
        [column.udt_name, column.is_nullable === 'YES' ? 'null' : 'not null']]));
      if (declaration === representationAddedColumns) {
        for (const [name, type] of Object.entries(declaration.columns)) expect(installed[name]).toEqual([...type]);
      } else {
        expect(installed).toEqual(Object.fromEntries(Object.entries(declaration.columns)
          .map(([name, type]) => [name, [...type]])));
      }
    }
    for (const table of protectedEffectTables) {
      expect((await empty.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'access'
        AND table_name = $1 AND column_name = 'protected_change_id'`, [table])).rowCount).toBe(1);
    }
  });

  test('IAM27/IAM31: representation edges stay acyclic under concurrent writers and paths stay bounded', async () => {
    const o = owner(empty);
    const [a, b, c] = [await o.subject(), await o.subject(), await o.subject()];
    const start = await o.epoch();
    const ab = await o.edge(a, b);
    await o.edge(b, c, 'work.create', 2);
    expect(BigInt(await o.epoch())).toBe(BigInt(start) + 2n);
    await rejects(o.edge(c, a), GUARD_VIOLATION, 'representation cycle');
    await rejects(o.edge(a, a), GUARD_VIOLATION, 'representation cycle');
    // Mutual administration grants are not edges and do not block representation.
    await o.grant(a, b, 'access.group.manage');
    await o.grant(b, a, 'access.group.manage');

    // Two writers each see an acyclic graph; the gate serializes them.
    const [e, f, h] = [await o.subject(), await o.subject(), await o.subject()];
    await o.edge(e, f);
    const second = await o.edgeIssuer(e, 'work.create');
    const first = await empty.connect();
    const other = await empty.connect();
    try {
      await first.query('BEGIN');
      await o.edge(f, h, 'work.create', 8, { client: first });
      await other.query('BEGIN');
      const racing = other.query(`INSERT INTO access.representation_edge (id, representative_subject,
        represented_subject, action, max_path_edges, valid_until, assigned_by_principal,
        issuer_representation_id, issuer_representation_generation, issuer_representation_action,
        ceiling_grant_id, ceiling_grant_generation, ceiling_scope_id, ceiling_action)
        VALUES ($1, $2, $3, 'work.create', 8, now() + interval '1 day', $4, $5, 0,
          'access.representation.manage', $6, 0, $7, 'access.representation.assign.work.create')`,
      [randomUUID(), h, e, second.operator, second.mandate, second.ceiling, SCOPE])
        .then(() => null, (caught: { code?: string }) => caught.code);
      await Bun.sleep(150);
      await first.query('COMMIT');
      expect(await racing).toBe(GUARD_VIOLATION);
      await other.query('ROLLBACK');
    } finally {
      first.release();
      other.release();
    }

    // Revoke only; the payload and a revoked episode are immutable.
    await o.q('UPDATE access.representation_edge SET active = false WHERE id = $1', [ab]);
    expect((await o.q('SELECT generation FROM access.representation_edge WHERE id = $1', [ab]))
      .rows[0].generation).toBe('1');
    await rejects(o.q('UPDATE access.representation_edge SET active = true WHERE id = $1', [ab]),
      GUARD_VIOLATION, 'representation edge payload is immutable; only revoke is allowed');
    await rejects(o.q('DELETE FROM access.representation_edge WHERE id = $1', [ab]), GUARD_VIOLATION, 'representation edge identity cannot be erased');

    // A selected path P -> X -> Y -> Z is one chain inside every component limit.
    const [x, y, z] = [await o.subject(), await o.subject(), await o.subject()];
    const principal = await o.principal();
    const composing = await o.mandate(principal, x, 'work.create', { maxPathEdges: 2 });
    const single = await o.mandate(principal, x, 'work.create');
    const xy = await o.edge(x, y);
    const yz = await o.edge(y, z, 'work.create', 2);
    const path = (mandate: string, steps: [string, string, string][], acting: string) => tx(empty,
      async client => {
        const id = randomUUID();
        await client.query(`INSERT INTO access.representation_path_proof (id, principal_id,
          principal_epoch, representation_id, representation_generation, origin_subject,
          acting_subject, action, edge_count, topology_epoch, valid_until)
          VALUES ($1, $2, 0, $3, 0, $4, $5, 'work.create', $6, 0, now() + interval '1 day')`,
        [id, principal, mandate, x, acting, steps.length]);
        for (const [index, [edge, from, to]] of steps.entries()) {
          await client.query(`INSERT INTO access.representation_path_step (path_id, position, edge_id,
            edge_generation, representative_subject, represented_subject, action)
            VALUES ($1, $2, $3, 0, $4, $5, 'work.create')`, [id, index + 1, edge, from, to]);
        }
      }).then(() => undefined);
    await path(composing, [[xy, x, y], [yz, y, z]], z);
    await path(single, [], x);
    await rejects(path(single, [[xy, x, y]], y), GUARD_VIOLATION, 'representation path exceeds its mandate');
    await rejects(path(composing, [[yz, y, z]], z), GUARD_VIOLATION, 'representation path is not one bounded chain');
    await rejects(path(composing, [[xy, x, y], [xy, x, y]], y), GUARD_VIOLATION, 'representation path is not one bounded chain');
    const limited = await o.mandate(principal, x, 'work.create', { maxPathEdges: 8 });
    const zw = await o.edge(z, await o.subject(), 'work.create', 8);
    const w = (await o.q('SELECT represented_subject FROM access.representation_edge WHERE id = $1',
      [zw])).rows[0].represented_subject;
    await rejects(path(limited, [[xy, x, y], [yz, y, z], [zw, z, w]], w), GUARD_VIOLATION, 'representation path is not one bounded chain');
  });

  test('IAM28: a compound admission holds one complete proof per obligation and rejects pooling', async () => {
    const o = owner(empty);
    const [a, b, target] = [await o.subject(), await o.subject(), await o.subject()];
    const principal = await o.principal();
    const proofs: Record<string, string> = {};
    for (const action of ['work.create', 'work.publish']) {
      const mandate = await o.mandate(principal, a, action, { maxPathEdges: 1 });
      const edge = await o.edge(a, b, action);
      const id = randomUUID();
      await tx(empty, async client => {
        await client.query(`INSERT INTO access.representation_path_proof (id, principal_id,
          principal_epoch, representation_id, representation_generation, origin_subject,
          acting_subject, action, edge_count, topology_epoch, valid_until)
          VALUES ($1, $2, 0, $3, 0, $4, $5, $6, 1, 0, now() + interval '1 day')`,
        [id, principal, mandate, a, b, action]);
        await client.query(`INSERT INTO access.representation_path_step VALUES
          ($1, 1, $2, 0, $3, $4, $5)`, [id, edge, a, b, action]);
      });
      proofs[action] = id;
    }
    const create = await o.grant(target, b, 'work.create');
    const publish = await o.grant(target, b, 'work.publish');
    const foreign = await o.grant(target, a, 'work.create');
    const admission = randomUUID();
    await o.q(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
      idempotency_key, request_digest, authority_epoch, expires_at, state)
      VALUES ($1, $2, $3, $4, 'work.create-and-publish', 'compound', $5, 0,
        now() + interval '1 hour', 'registered')`, [admission, principal, b, SCOPE, 'b'.repeat(64)]);
    const obligation = (action: string, path: string, grant: string) => o.q(`INSERT INTO
      access.admission_obligation (admission_id, obligation, principal_id, acting_subject, scope_id,
        path_id, source_kind, grant_id, grant_generation)
      VALUES ($1, $2, $3, $4, $5, $6, 'grant', $7, 0)`, [admission, action, principal, b, SCOPE,
      path, grant]);
    // A's grant cannot complete B's path, and a publishing path cannot carry creation.
    await rejects(obligation('work.create', proofs['work.create']!, foreign), '23503', 'admission_obligation_grant_id_acting_subject_scope_id_obli_fkey');
    await rejects(obligation('work.create', proofs['work.publish']!, create), '23503', 'admission_obligation_path_id_principal_id_acting_subject_o_fkey');
    await obligation('work.create', proofs['work.create']!, create);
    await obligation('work.publish', proofs['work.publish']!, publish);
    await rejects(obligation('work.create', proofs['work.create']!, create), '23505', 'admission_obligation_pkey');
  });

  test('IAM13/IAM14: institutional grants survive their operator while dependent grants follow upstream', async () => {
    const o = owner(empty);
    const [root, issuer, holder, delegate] = [await o.subject(), await o.subject(), await o.subject(),
      await o.subject()];
    const operator = await o.principal();
    const operatorMandate = await o.mandate(operator, issuer, 'access.grant.assign.work.create');
    const ceiling = await o.grant(root, issuer, 'access.grant.assign.work.create', 30);
    const upstream = await o.grant(issuer, holder, 'work.create', 10);
    const lineage = (grant: string, values: { issuer: string; recipient: string; principal: string;
      mandate: string; mandateAction: string; ceiling: string; ceilingAction: string;
      upstream?: string; root: string; depth: number; redelegation: number }) => o.q(`INSERT INTO
      access.grant_lineage (grant_id, issuer_subject, recipient_subject, scope_id, action, lifetime,
        assigned_by_principal, issuer_representation_id, issuer_representation_generation,
        issuer_representation_action, ceiling_grant_id, ceiling_grant_generation, ceiling_scope_id,
        ceiling_action, upstream_grant_id, upstream_generation, root_grant_id, depth,
        redelegation_depth)
      VALUES ($1, $2, $3, $4, 'work.create', $5, $6, $7, 0, $8, $9, 0, $4, $10, $11, $12, $13, $14,
        $15)`, [grant, values.issuer, values.recipient, SCOPE,
      values.upstream ? 'dependent' : 'institutional', values.principal, values.mandate,
      values.mandateAction, values.ceiling, values.ceilingAction, values.upstream ?? null,
      values.upstream ? 0 : null, values.root, values.depth, values.redelegation]);
    await lineage(upstream, { issuer, recipient: holder, principal: operator, mandate: operatorMandate,
      mandateAction: 'access.grant.assign.work.create', ceiling, ceilingAction:
        'access.grant.assign.work.create', root: upstream, depth: 0, redelegation: 1 });
    const holderOperator = await o.principal();
    const holderMandate = await o.mandate(holderOperator, holder, 'access.grant.redelegate');
    const dependentLineage = (grant: string, from: string, redelegation: number, depth = 1) =>
      lineage(grant, { issuer: holder, recipient: delegate, principal: holderOperator,
        mandate: holderMandate, mandateAction: 'access.grant.redelegate', ceiling: from,
        ceilingAction: 'work.create', upstream: from, root: upstream, depth, redelegation });
    const dependent = await o.grant(holder, delegate, 'work.create', 5);
    await dependentLineage(dependent, upstream, 0);
    await rejects(dependentLineage(await o.grant(holder, delegate, 'work.create', 20), upstream, 0),
      GUARD_VIOLATION, 'grant ceiling is stale or shorter');
    await rejects(dependentLineage(await o.grant(holder, delegate, 'work.create', 5), upstream, 1),
      GUARD_VIOLATION, 'upstream grant cannot be redelegated here');
    const legacy = await o.grant(issuer, holder, 'work.create', 10);
    await rejects(dependentLineage(await o.grant(holder, delegate, 'work.create', 5), legacy, 0),
      GUARD_VIOLATION, 'upstream grant cannot be redelegated here');

    // The issuing operator departs: the institutional grant stays.
    await o.q('UPDATE access.representation SET active = false WHERE id = $1', [operatorMandate]);
    const state = async (id: string) => (await o.q(`SELECT active, generation
      FROM access.permission_grant WHERE id = $1`, [id])).rows[0];
    expect(await state(upstream)).toEqual({ active: true, generation: '0' });
    await o.q('UPDATE access.permission_grant SET active = false WHERE id = $1', [upstream]);
    expect(await state(dependent)).toEqual({ active: false, generation: '1' });
    await rejects(o.q('UPDATE access.permission_grant SET active = true WHERE id = $1', [upstream]),
      GUARD_VIOLATION, 'grant lineage episode is immutable');
    await rejects(o.q("UPDATE access.grant_lineage SET lifetime = 'institutional'"), GUARD_VIOLATION, 'immutable Access authority control record');
  });

  test('IAM05/IAM30: protected sets and privileged automation need the resulting approved change', async () => {
    const o = owner(empty);
    const [organization, governance, member] = [await o.subject(), await o.subject(), await o.subject()];
    const administrator = await o.principal();
    const protectedGroup = randomUUID();
    const ordinaryGroup = randomUUID();
    await o.q(`INSERT INTO access.recipient_group (id, scope_id) VALUES ($1, $3), ($2, $3)`,
      [protectedGroup, ordinaryGroup, SCOPE]);
    // Protection commits while an addition waits on the same anchor: the
    // addition then sees the protection and needs an approved change.
    const protecting = await empty.connect();
    try {
      await protecting.query('BEGIN');
      await protecting.query(`INSERT INTO access.protected_set (object_kind, object_id, owner_subject,
        approval_subject, required_approvals, group_id, protected_by_principal)
        VALUES ('group', $1, $2, $3, 1, $1, $4)`, [protectedGroup, organization, governance,
        administrator]);
      const adding = o.q(`INSERT INTO access.group_member (id, group_id, agent_subject)
        VALUES ($1, $2, $3)`, [randomUUID(), protectedGroup, await o.subject()])
        .then(() => null, (caught: { code?: string }) => caught.code);
      await Bun.sleep(150);
      await protecting.query('COMMIT');
      expect(await adding).toBe(GUARD_VIOLATION);
    } finally { protecting.release(); }
    await o.q(`INSERT INTO access.group_member (id, group_id, agent_subject) VALUES ($1, $2, $3)`,
      [randomUUID(), ordinaryGroup, member]);
    const addMember = (client: Queryable, change: string | null, agent = organization) =>
      client.query(`INSERT INTO access.group_member (id, group_id, agent_subject, protected_change_id)
        VALUES ($1, $2, $3, $4)`, [randomUUID(), protectedGroup, agent, change]);
    await rejects(addMember(empty, null), GUARD_VIOLATION, 'protected authority change requires its approved activation');
    await rejects(o.q('UPDATE access.recipient_group SET parent_id = $1 WHERE id = $2',
      [protectedGroup, ordinaryGroup]), GUARD_VIOLATION, 'protected authority change requires its approved activation');
    await rejects(o.q(`INSERT INTO access.group_permission_grant (id, group_id, issuer_subject,
      scope_id, action, valid_until) VALUES ($1, $2, $3, $4, 'work.create', now() + interval '1 day')`,
    [randomUUID(), protectedGroup, organization, SCOPE]), GUARD_VIOLATION, 'protected authority change requires its approved activation');

    // The administrator cannot approve their own addition or activate early.
    const selfApprover = { principal: administrator,
      mandate: await o.mandate(administrator, governance, 'access.protected-change.approve') };
    await rejects(tx(empty, async client => { await o.approvedChange(client, { kind: 'group-member',
      targetSubject: organization, targetObject: protectedGroup, approvalSubject: governance,
      requestedBy: administrator, approvers: [selfApprover] }); }), GUARD_VIOLATION, 'protected change approval is self-approved or expired');
    const approver = await o.approver(governance);
    await rejects(tx(empty, async client => { await o.approvedChange(client, { kind: 'group-member',
      targetSubject: organization, targetObject: protectedGroup, approvalSubject: governance,
      requestedBy: administrator, approvers: [approver], required: 2 }); }), GUARD_VIOLATION, 'protected change lacks its approvals or window');
    let change = '';
    await tx(empty, async client => {
      change = await o.approvedChange(client, { kind: 'group-member', targetSubject: organization,
        targetObject: protectedGroup, approvalSubject: governance, requestedBy: administrator,
        approvers: [approver] });
      await addMember(client, change);
    });
    await rejects(addMember(empty, change, member), '23505', 'group_member_protected_change');

    // Privileged automation is classified by the database and needs its change.
    const workload = await o.principal();
    const install = (actions: string[], privileged: boolean, changeId: string | null = null,
      client: Queryable = empty, id = randomUUID()) => client.query(`INSERT INTO
      access.automation_installation (id, owner_subject, workload_principal, actions, privileged,
        protected_change_id, installed_by_principal, valid_until)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '10 days')`,
    [id, organization, workload, actions, privileged, changeId, administrator]).then(() => id);
    await rejects(install(['access.group.manage'], false), GUARD_VIOLATION, 'automation privilege classification is wrong');
    await rejects(install(['access.group.manage'], true), GUARD_VIOLATION, 'protected authority change requires its approved activation');
    const ordinary = await install(['work.create'], false);
    const automated = randomUUID();
    await o.q(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until,
      automation_installation_id) VALUES ($1, $2, $3, 'work.create', now() + interval '1 day', $4)`,
    [automated, workload, organization, ordinary]);
    await rejects(o.q(`INSERT INTO access.representation (id, principal_id, subject_id, action,
      valid_until, automation_installation_id)
      VALUES ($1, $2, $3, 'access.group.manage', now() + interval '1 day', $4)`,
    [randomUUID(), workload, organization, ordinary]), GUARD_VIOLATION, 'mandate exceeds its automation installation');
    // Revoking the installation fences its mandates in the same transaction.
    await o.q('UPDATE access.automation_installation SET active = false WHERE id = $1', [ordinary]);
    expect((await o.q('SELECT active FROM access.representation WHERE id = $1', [automated]))
      .rows[0].active).toBe(false);
    const installation = randomUUID();
    await tx(empty, async client => {
      const approved = await o.approvedChange(client, { kind: 'automation-install',
        targetSubject: organization, targetObject: installation, approvalSubject: governance,
        requestedBy: administrator, approvers: [approver] });
      await install(['access.group.manage'], true, approved, client, installation);
    });
  });

  test('IAM32: representative roster changes stay inside the approved policy and widening needs its grantor', async () => {
    const o = owner(empty);
    const [institution, grantor] = [await o.subject(), await o.subject()];
    const creator = await o.principal();
    const policy = randomUUID();
    await tx(empty, async client => {
      await client.query(`INSERT INTO access.representative_policy (id, institution_subject,
        approval_subject, active_revision, created_by_principal) VALUES ($1, $2, $3, 1, $4)`,
      [policy, institution, grantor, creator]);
      await client.query(`INSERT INTO access.representative_policy_revision (policy_id, revision,
        actions, max_representatives, max_mandate_days, widening, created_by_principal)
        VALUES ($1, 1, '{work.create}', 1, 30, false, $2)`, [policy, creator]);
    });
    const [first, second] = [await o.principal(), await o.principal()];
    const firstMandate = await o.mandate(first, institution, 'work.create', { policy: [policy, 1] });
    await rejects(o.mandate(second, institution, 'work.create', { policy: [policy, 1] }), GUARD_VIOLATION, 'mandate exceeds its representative policy');
    // Qualified roster replacement leaves the pinned institutional grant untouched.
    const ceiling = await o.grant(await o.subject(), grantor, 'access.grant.assign.work.create', 30);
    const grantorOperator = await o.principal();
    const grantorMandate = await o.mandate(grantorOperator, grantor, 'access.grant.assign.work.create');
    const institutional = await o.grant(grantor, institution, 'work.create', 20);
    await o.q(`INSERT INTO access.grant_lineage (grant_id, issuer_subject, recipient_subject, scope_id,
      action, lifetime, assigned_by_principal, issuer_representation_id,
      issuer_representation_generation, issuer_representation_action, ceiling_grant_id,
      ceiling_grant_generation, ceiling_scope_id, ceiling_action, root_grant_id, depth,
      redelegation_depth, representative_policy_id)
      VALUES ($1, $2, $3, $4, 'work.create', 'institutional', $5, $6, 0,
        'access.grant.assign.work.create', $7, 0, $4, 'access.grant.assign.work.create', $1, 0, 0, $8)`,
    [institutional, grantor, institution, SCOPE, grantorOperator, grantorMandate, ceiling, policy]);
    await o.q('UPDATE access.representation SET active = false WHERE id = $1', [firstMandate]);
    await rejects(o.mandate(second, institution, 'work.publish', { policy: [policy, 1] }), GUARD_VIOLATION, 'mandate exceeds its representative policy');
    await rejects(o.mandate(second, institution, 'work.create', { policy: [policy, 1], until: '40 days' }),
      GUARD_VIOLATION, 'mandate exceeds its representative policy');
    await o.mandate(second, institution, 'work.create', { policy: [policy, 1] });
    expect((await o.q('SELECT active, generation FROM access.permission_grant WHERE id = $1',
      [institutional])).rows[0]).toEqual({ active: true, generation: '0' });

    const revise = (revision: number, maxRepresentatives: number, days: number, widening: boolean,
      change: string | null = null, client: Queryable = empty) => client.query(`INSERT INTO
      access.representative_policy_revision (policy_id, revision, base_revision, actions,
        max_representatives, max_mandate_days, widening, protected_change_id, created_by_principal)
      VALUES ($1, $2, $3, '{work.create}', $4, $5, $6, $7, $8)`,
    [policy, revision, revision - 1, maxRepresentatives, days, widening, change, creator]);
    await rejects(revise(2, 2, 30, false), GUARD_VIOLATION, 'representative policy widening is misclassified');
    await rejects(revise(2, 2, 30, true), GUARD_VIOLATION, 'widening needs its approval subject');
    await tx(empty, async client => {
      await revise(2, 1, 7, false, null, client);
      await client.query('UPDATE access.representative_policy SET active_revision = 2 WHERE id = $1', [policy]);
    });
    const [institutionApprover, grantorApprover] = [await o.approver(institution), await o.approver(grantor)];
    await rejects(tx(empty, async client => {
      const change = await o.approvedChange(client, { kind: 'representative-policy',
        targetSubject: institution, targetObject: policy, approvalSubject: institution,
        requestedBy: creator, approvers: [institutionApprover], generation: '1' });
      await revise(3, 2, 7, true, change, client);
    }), GUARD_VIOLATION, 'widening needs its approval subject');
    await tx(empty, async client => {
      const change = await o.approvedChange(client, { kind: 'representative-policy',
        targetSubject: institution, targetObject: policy, approvalSubject: grantor,
        requestedBy: creator, approvers: [grantorApprover], generation: '1' });
      await revise(3, 2, 7, true, change, client);
      await client.query('UPDATE access.representative_policy SET active_revision = 3 WHERE id = $1', [policy]);
    });
    await rejects(o.q('UPDATE access.representative_policy SET active_revision = 1 WHERE id = $1',
      [policy]), GUARD_VIOLATION, 'representative policy identity is immutable');
  });

  test('IAM08: Agent control keeps continuity and recovers only through an independent authority', async () => {
    const o = owner(empty);
    const [agent, recoverySubject] = [await o.subject(), await o.subject()];
    const controller = await o.principal();
    let controllerMandate = '';
    await tx(empty, async client => {
      controllerMandate = await o.mandate(controller, agent, CONTROL_ACTION,
        { until: 'infinity', db: client });
      await client.query(`INSERT INTO access.agent_control (subject_id, recovery_subject,
        recovery_delay) VALUES ($1, $2, interval '0')`, [agent, recoverySubject]);
    });
    await rejects(o.q('UPDATE access.representation SET active = false WHERE id = $1',
      [controllerMandate]), GUARD_VIOLATION, 'agent control continuity');
    await rejects(o.mandate(await o.principal(), agent, CONTROL_ACTION, { until: 'infinity' }),
      GUARD_VIOLATION, 'new controller requires its approved change');
    await rejects(o.q('UPDATE access.agent_control SET min_controllers = 2 WHERE subject_id = $1',
      [agent]), GUARD_VIOLATION, 'agent control policy change requires approval');

    // The only controller's account is lost; a recovery names a replacement.
    await o.q('UPDATE access.principal SET active = false WHERE id = $1', [controller]);
    const replacement = await o.principal();
    const requester = await o.principal();
    const proposal = randomUUID();
    const digest = randomBytes(32).toString('hex');
    const propose = (client: Queryable, id: string, delay = '0') => client.query(`INSERT INTO
      access.protected_change_proposal (id, kind, target_subject, expected_object_generation,
        resulting_ceiling, staged_change, change_digest, approval_subject, required_approvals,
        requested_by, not_before, expires_at, created_at)
      VALUES ($1, 'agent-recovery', $2, 0, '{agent.control}', '{}', $3, $4, 1, $5,
        now() + $6::interval, now() + interval '1 day', now())`,
    [id, agent, digest, recoverySubject, requester, `${delay} seconds`]);
    const recover = (client: Queryable, id: string) => client.query(`INSERT INTO access.agent_recovery
      (proposal_id, subject_id, reason, replacement_principal, revoke_existing,
        expected_control_generation) VALUES ($1, $2, 'last-controller-lost', $3, true, 0)`,
    [id, agent, replacement]);
    await rejects(o.q(`INSERT INTO access.protected_change_proposal (id, kind, target_subject,
      expected_object_generation, resulting_ceiling, staged_change, change_digest, approval_subject,
      required_approvals, requested_by, not_before, expires_at)
      VALUES ($1, 'agent-recovery', $2, 0, '{}', '{}', $3, $2, 1, $4, now(), now() + interval '1 day')`,
    [randomUUID(), agent, digest, requester]), GUARD_VIOLATION, 'protected_change_proposal_check3');
    await tx(empty, async client => {
      await propose(client, proposal);
      await recover(client, proposal);
    });
    // Current controllers and the replacement are not independent approvers.
    const controllerApproval = await o.mandate(controller, recoverySubject, 'access.protected-change.approve');
    const replacementApproval = await o.mandate(replacement, recoverySubject,
      'access.protected-change.approve');
    await rejects(o.approve(empty, proposal, recoverySubject, digest,
      [{ principal: controller, mandate: controllerApproval }]), GUARD_VIOLATION, 'recovery approval is not independent');
    await rejects(o.approve(empty, proposal, recoverySubject, digest,
      [{ principal: replacement, mandate: replacementApproval }]), GUARD_VIOLATION, 'recovery approval is not independent');
    await o.approve(empty, proposal, recoverySubject, digest, [await o.approver(recoverySubject)]);
    await rejects(tx(empty, async client => {
      await o.activate(client, proposal, 'agent-recovery', agent, null, requester, 1);
      await o.mandate(await o.principal(), agent, CONTROL_ACTION,
        { until: 'infinity', change: proposal, db: client });
    }), GUARD_VIOLATION, 'new controller requires its approved change');
    // A revoking recovery must also remove the compromised or lost controller.
    await rejects(tx(empty, async client => {
      await o.activate(client, proposal, 'agent-recovery', agent, null, requester, 1);
      await o.mandate(replacement, agent, CONTROL_ACTION, { until: 'infinity', change: proposal,
        db: client });
    }), GUARD_VIOLATION, 'agent recovery did not replace its controllers');
    await tx(empty, async client => {
      await o.activate(client, proposal, 'agent-recovery', agent, null, requester, 1);
      await o.mandate(replacement, agent, CONTROL_ACTION, { until: 'infinity', change: proposal,
        db: client });
      await client.query('UPDATE access.representation SET active = false WHERE id = $1',
        [controllerMandate]);
    });
    expect((await o.q('SELECT active FROM access.representation WHERE id = $1', [controllerMandate]))
      .rows[0].active).toBe(false);

    // A recovery authority that the Agent itself controls is not independent.
    const [other, controlled] = [await o.subject(), await o.subject()];
    await o.mandate(await o.principal(), other, CONTROL_ACTION, { until: 'infinity' });
    await o.edge(other, controlled, CONTROL_ACTION, 1, { until: 'infinity' });
    await rejects(o.q(`INSERT INTO access.agent_control (subject_id, recovery_subject)
      VALUES ($1, $2)`, [other, controlled]), GUARD_VIOLATION, 'recovery authority is controlled by its Agent');

    // An already configured policy must also stay independent when later
    // controller edges would compose its Agent into the recovery subject.
    const bridge = await o.subject();
    await o.edge(agent, bridge, CONTROL_ACTION, 1, { until: 'infinity' });
    await rejects(o.edge(bridge, recoverySubject, CONTROL_ACTION, 1,
      { until: 'infinity' }), GUARD_VIOLATION,
    'recovery authority is controlled by its Agent');
  });

  test('IAM12: an invitation to an unadmitted author stays pending until its own representative accepts', async () => {
    const o = owner(empty);
    const [root, issuer] = [await o.subject(), await o.subject()];
    const author = iri();
    const operator = await o.principal();
    const operatorMandate = await o.mandate(operator, issuer, 'access.invitation.issue');
    const ceiling = await o.grant(root, issuer, 'access.grant.assign.work.create', 30);
    const invite = async (lifetime: string) => {
      const id = randomUUID();
      await o.q(`INSERT INTO access.agent_invitation (id, issuer_subject, recipient_subject, scope_id,
        action, grant_valid_until, issuer_lifetime, issued_by_principal, issuer_representation_id,
        issuer_representation_generation, issuer_representation_action, ceiling_grant_id,
        ceiling_grant_generation, ceiling_scope_id, ceiling_action, expires_at)
        VALUES ($1, $2, $3, $4, 'work.create', now() + interval '20 days', $5, $6, $7, 0,
          'access.invitation.issue', $8, 0, $4, 'access.grant.assign.work.create',
          now() + interval '7 days')`,
      [id, issuer, author, SCOPE, lifetime, operator, operatorMandate, ceiling]);
      return id;
    };
    const institutional = await invite('institutional');
    const later = await invite('institutional');
    const dependent = await invite('operator-dependent');
    const revoked = await invite('institutional');
    // No Access subject exists for the author, so no mandate can accept.
    await rejects(o.mandate(await o.principal(), author, ACCEPT_ACTION), '23503', 'representation_subject_id_fkey');

    await o.q("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [author]);
    const representative = await o.principal();
    const acceptor = await o.mandate(representative, author, ACCEPT_ACTION);
    const accept = (invitation: string) => tx(empty, async client => {
      const grant = await o.grant(issuer, author, 'work.create', 19, client);
      await client.query(`INSERT INTO access.grant_lineage (grant_id, issuer_subject,
        recipient_subject, scope_id, action, lifetime, assigned_by_principal,
        issuer_representation_id, issuer_representation_generation, issuer_representation_action,
        ceiling_grant_id, ceiling_grant_generation, ceiling_scope_id, ceiling_action, root_grant_id,
        depth, redelegation_depth, invitation_id)
        VALUES ($1, $2, $3, $4, 'work.create', 'institutional', $5, $6, 0, 'access.invitation.issue',
          $7, 0, $4, 'access.grant.assign.work.create', $1, 0, 0, $8)`,
      [grant, issuer, author, SCOPE, operator, operatorMandate, ceiling, invitation]);
      await client.query(`INSERT INTO access.agent_invitation_acceptance (invitation_id,
        issuer_subject, recipient_subject, scope_id, action, accepted_by_principal,
        acceptor_representation_id, acceptor_representation_generation,
        acceptor_representation_action, recipient_generation, grant_id)
        VALUES ($1, $2, $3, $4, 'work.create', $5, $6, 0, $7, 0, $8)`,
      [invitation, issuer, author, SCOPE, representative, acceptor, ACCEPT_ACTION, grant]);
    });
    await o.q(`INSERT INTO access.agent_invitation_revocation (invitation_id, revoked_by_principal)
      VALUES ($1, $2)`, [revoked, operator]);
    await rejects(accept(revoked), GUARD_VIOLATION, 'invitation already has an outcome');
    await accept(institutional);
    await rejects(accept(institutional), GUARD_VIOLATION, 'invitation already has an outcome');
    await rejects(o.q(`INSERT INTO access.agent_invitation_revocation (invitation_id,
      revoked_by_principal) VALUES ($1, $2)`, [institutional, operator]), GUARD_VIOLATION, 'invitation already has an outcome');
    // The operator departs: only the operator-dependent invitation stops activating.
    await o.q('UPDATE access.representation SET active = false WHERE id = $1', [operatorMandate]);
    await rejects(accept(dependent), GUARD_VIOLATION, 'invitation issuing mandate ended');
    await accept(later);
  });

  test('IAM27/IAM31: topology and fan-out guards report bounded unavailability', async () => {
    const o = owner(empty);
    const hub = await o.subject();
    for (let index = 0; index < 16; index++) await o.edge(hub, await o.subject());
    await rejects(o.edge(hub, await o.subject()), GUARD_LIMIT, 'representation edge degree limit');
  });
});
