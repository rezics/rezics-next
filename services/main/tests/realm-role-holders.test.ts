import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { AccessRealmManagement, REALM_ROLE_HOLDER_PAGE_SQL, REALM_ROLE_HOLDER_PREVIEW_SQL } from '../src/modules/access/realm-management.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { REALM_ROLE_CAP, REALM_ROLE_HOLDER_PREVIEW, RealmAdminDenied, RealmAdminLimit,
  RealmAdminUnavailable } from '../src/modules/realm-admin/contract.ts';

const root = resolve(import.meta.dir, '../../..');
const agent = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
let cluster: PostgresCluster | undefined;
let pool: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, connectionTimeoutMillis: 1000, max: 4 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

function watch(source: Pool) {
  const statements: string[] = [];
  const watched = {
    async connect() {
      const client = await source.connect();
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === 'query') return (...args: unknown[]) => {
            if (typeof args[0] === 'string') statements.push(args[0]);
            return (target.query as (...inner: unknown[]) => unknown)(...args);
          };
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  return { pool: watched as Pool, statements };
}

async function realmWith(actorGrant: readonly string[]) {
  const principalId = randomUUID();
  const principal: VerifiedPrincipal = { issuer: 'https://account.rezics.test', subject: randomUUID() };
  const actor = `https://rezics.com/id/${randomUUID()}`;
  const realm = `https://rezics.com/id/${randomUUID()}`;
  const scope = `governance:realm:${realm}`;
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [randomUUID(), principalId, actor]);
  await pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  for (const action of actorGrant) {
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,'infinity')`, [randomUUID(), actor, scope, action]);
  }
  await pool.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1)', [realm]);
  await pool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'institution')`, [realm]);
  await pool.query(`INSERT INTO access.membership_policy (kind, owner_subject, revision, terms_revision)
    VALUES ('realm',$1,0,'realm-membership-v1')`, [realm]);
  return { principal, principalId, actor, realm, scope };
}

async function principalOn(realm: string, scope: string, actorGrant: readonly string[]) {
  const principalId = randomUUID();
  const principal: VerifiedPrincipal = { issuer: 'https://account.rezics.test', subject: randomUUID() };
  const actor = `https://rezics.com/id/${randomUUID()}`;
  await pool.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
  await pool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`, [randomUUID(), principalId, actor]);
  for (const action of actorGrant) {
    await pool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,$4,'infinity')`, [randomUUID(), actor, scope, action]);
  }
  return { principal, actor };
}

async function people(realm: string, from: number, count: number, options: {
  role?: string; active?: boolean; kind?: 'agent' | 'institution'; banned?: boolean; assignOnly?: boolean;
} = {}) {
  const kind = options.kind ?? 'agent';
  const active = options.active !== false && kind === 'agent';
  if (!options.assignOnly) await pool.query(`INSERT INTO access.authority_subject (id, kind, active)
    SELECT 'https://rezics.com/id/' || lpad(n::text, 8, '0') || '-0000-4000-8000-000000000000', $1, $2
    FROM generate_series($3::int, $3::int + $4::int - 1) n`, [kind, active, from, count]);
  if (!options.assignOnly && kind === 'agent') {
    await pool.query(`INSERT INTO access.membership
      (id, kind, owner_subject, member_subject, state, generation, policy_revision, terms_revision, consent_reference)
      SELECT gen_random_uuid(), 'realm', $1,
        'https://rezics.com/id/' || lpad(n::text, 8, '0') || '-0000-4000-8000-000000000000',
        'joined', 1, 0, 'terms', 'consent'
      FROM generate_series($2::int, $2::int + $3::int - 1) n`, [realm, from, count]);
  }
  if (options.role) {
    await pool.query(`INSERT INTO access.realm_admin_assignment (realm, role_id, member, valid_until)
      SELECT $1, $2, 'https://rezics.com/id/' || lpad(n::text, 8, '0') || '-0000-4000-8000-000000000000',
        clock_timestamp() + interval '1 day'
      FROM generate_series($3::int, $3::int + $4::int - 1) n`, [realm, options.role, from, count]);
  }
  if (options.banned) {
    await pool.query(`INSERT INTO access.membership_ban (kind, owner_subject, member_subject, active, reason_ref)
      SELECT 'realm', $1, 'https://rezics.com/id/' || lpad(n::text, 8, '0') || '-0000-4000-8000-000000000000',
        true, 'banned'
      FROM generate_series($2::int, $2::int + $3::int - 1) n`, [realm, from, count]);
  }
}

async function role(realm: string, name: string) {
  const id = randomUUID();
  await pool.query(`INSERT INTO access.realm_admin_role (realm, id, name, permissions)
    VALUES ($1,$2,$3,ARRAY[]::text[])`, [realm, id, name]);
  return id;
}

function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const nodes = [plan];
  for (const child of (plan.Plans as Record<string, unknown>[] | undefined) ?? []) nodes.push(...planNodes(child));
  return nodes;
}

test('role cards preview holders, the role filter pages, and a hidden member stays out as the roster grows', async () => {
  const adminSource = watch(pool);
  const admin = new AccessRealmManagement(adminSource.pool);
  const manager = await realmWith(['realm.members.manage', 'realm.roles.manage']);
  const wide = await role(manager.realm, 'Wide');
  const small = await role(manager.realm, 'Small');
  await role(manager.realm, 'Empty');
  await people(manager.realm, 1, 25, { role: wide });
  await people(manager.realm, 24, 2, { role: small, assignOnly: true });
  // Sorts first, so a missing filter would put them at the head of Wide.
  await people(manager.realm, 0, 1, { role: wide, active: false });
  await people(manager.realm, 26, 1, { role: wide, banned: true });
  const institution = agent(27);
  await pool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'institution')", [institution]);
  await pool.query(`INSERT INTO access.realm_admin_assignment (realm, role_id, member, valid_until)
    VALUES ($1,$2,$3,clock_timestamp() + interval '1 day')`, [manager.realm, wide, institution]);
  const sealed = await role(manager.realm, 'Sealed');
  await people(manager.realm, 0, 1, { role: sealed, assignOnly: true });
  await people(manager.realm, 26, 1, { role: sealed, assignOnly: true });

  const preview = await admin.roles(manager.principal, manager.realm, manager.actor);
  expect(preview.cap).toBe(REALM_ROLE_CAP);
  const byName = Object.fromEntries(preview.roles.map(item => [item.name, item]));
  expect(byName.Wide).toMatchObject({ moreHolders: true, holders: [agent(1), agent(2), agent(3)] });
  expect(byName.Wide!.holders).toHaveLength(REALM_ROLE_HOLDER_PREVIEW);
  expect(byName.Small).toEqual(expect.objectContaining({ moreHolders: false, holders: [agent(24), agent(25)] }));
  expect(byName.Empty).toEqual(expect.objectContaining({ moreHolders: false, holders: [] }));
  expect(byName.Sealed).toEqual(expect.objectContaining({ moreHolders: false, holders: [] }));
  expect(preview.roles.map(item => item.holders).flat()).not.toContain(agent(0));
  expect(preview.roles.map(item => item.holders).flat()).not.toContain(agent(26));
  expect(preview.roles.map(item => item.holders).flat()).not.toContain(institution);

  const first = await admin.members(manager.principal, manager.realm, { actingSubject: manager.actor, role: wide, limit: 20 });
  const second = await admin.members(manager.principal, manager.realm, { actingSubject: manager.actor, role: wide,
    after: first.nextCursor!, limit: 20 });
  expect(first.items.map(item => item.member)).toEqual(Array.from({ length: 20 }, (_, index) => agent(index + 1)));
  expect(first.nextCursor).toBe(agent(20));
  expect(second.items.map(item => item.member)).toEqual([agent(21), agent(22), agent(23), agent(24), agent(25)]);
  expect(second.nextCursor).toBeNull();
  const holders = [...first.items, ...second.items].map(item => item.member);
  expect(holders).not.toContain(agent(0));
  expect(holders).not.toContain(agent(26));
  expect(holders).not.toContain(institution);

  const roster = await admin.members(manager.principal, manager.realm, { actingSubject: manager.actor, limit: 50 });
  expect(roster.items[0]?.member).toBe(agent(1));
  expect(roster.items.map(item => item.member)).toContain(agent(26));
  expect(roster.items.map(item => item.member)).not.toContain(agent(0));
  expect(roster.items.map(item => item.member)).not.toContain(institution);

  const unknown = await admin.members(manager.principal, manager.realm, { actingSubject: manager.actor, role: randomUUID() });
  expect(unknown.items).toEqual([]);
  expect(unknown.nextCursor).toBeNull();

  const count = async (run: () => Promise<unknown>) => {
    adminSource.statements.length = 0;
    await run();
    return adminSource.statements.length;
  };
  const rolesAt25 = await count(() => admin.roles(manager.principal, manager.realm, manager.actor));
  const pageAt25 = await count(() => admin.members(manager.principal, manager.realm,
    { actingSubject: manager.actor, role: wide, limit: 20 }));
  expect(adminSource.statements.filter(sql => sql.includes('LATERAL'))).toHaveLength(0);
  const previewStatements = await count(() => admin.roles(manager.principal, manager.realm, manager.actor));
  expect(previewStatements).toBe(rolesAt25);
  expect(adminSource.statements.filter(sql => sql.includes('LATERAL'))).toHaveLength(1);
  expect(adminSource.statements.filter(sql => sql.includes('realm_admin_assignment'))).toHaveLength(1);

  const bulk = await role(manager.realm, 'Bulk');
  await people(manager.realm, 100, 225, { role: bulk });
  expect(await count(() => admin.roles(manager.principal, manager.realm, manager.actor))).toBe(rolesAt25);
  expect(await count(() => admin.members(manager.principal, manager.realm,
    { actingSubject: manager.actor, role: wide, limit: 20 }))).toBe(pageAt25);
  expect(adminSource.statements.some(sql => sql === REALM_ROLE_HOLDER_PAGE_SQL)).toBe(true);

  await pool.query('ANALYZE access.realm_admin_assignment');
  const explained = await pool.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${REALM_ROLE_HOLDER_PAGE_SQL}`, [manager.realm, null, null, 21, wide]);
  const nodes = planNodes(explained.rows[0]!['QUERY PLAN'][0]!.Plan);
  const scans = nodes.filter(node => node['Index Name'] === 'realm_admin_assignment_role_holders');
  expect(scans.length, JSON.stringify(nodes.map(node => [node['Node Type'], node['Index Name'], node['Relation Name']]))).toBeGreaterThan(0);
  expect(nodes.some(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'realm_admin_assignment')).toBe(false);
  const holderScan = scans[0]!;
  const examined = Number(holderScan['Actual Rows']) + Number(holderScan['Rows Removed by Filter'] ?? 0);
  expect(examined).toBeLessThanOrEqual(21);
  expect(REALM_ROLE_HOLDER_PREVIEW_SQL).toContain('LATERAL');
}, 60_000);

test('creating a 33rd role is refused, and a Realm already over the cap keeps every role', async () => {
  const admin = new AccessRealmManagement(pool);
  const manager = await realmWith(['realm.roles.manage']);
  await pool.query(`INSERT INTO access.realm_admin_role (realm, id, name, permissions)
    SELECT $1, gen_random_uuid(), 'Role ' || n, ARRAY[]::text[] FROM generate_series(1, $2) n`,
  [manager.realm, REALM_ROLE_CAP]);
  const extra = { actingSubject: manager.actor, expectedGeneration: '0', reason: 'One more role',
    change: { kind: 'role' as const, roleId: randomUUID(), name: 'One too many', permissions: [] } };
  await expect(admin.preview(manager.principal, manager.realm, extra)).rejects.toBeInstanceOf(RealmAdminLimit);
  expect((await admin.roles(manager.principal, manager.realm, manager.actor)).roles).toHaveLength(REALM_ROLE_CAP);

  await pool.query(`INSERT INTO access.realm_admin_role (realm, id, name, permissions)
    VALUES ($1,$2,'Already past',ARRAY[]::text[])`, [manager.realm, randomUUID()]);
  const listed = await admin.roles(manager.principal, manager.realm, manager.actor);
  expect(listed.cap).toBe(REALM_ROLE_CAP);
  expect(listed.roles).toHaveLength(REALM_ROLE_CAP + 1);
  expect(listed.roles.map(item => item.name)).toEqual(expect.arrayContaining(['Role 1', 'Already past']));
  await expect(admin.preview(manager.principal, manager.realm, { ...extra, change: { ...extra.change, roleId: randomUUID(),
    name: 'Still too many' } })).rejects.toBeInstanceOf(RealmAdminLimit);
  expect((await pool.query(`SELECT count(*)::int AS count FROM access.realm_admin_role WHERE realm = $1`,
    [manager.realm])).rows[0]!.count).toBe(REALM_ROLE_CAP + 1);
});

test('an unknown role is an empty page, and holding a role does not grant the read', async () => {
  const admin = new AccessRealmManagement(pool);
  const manager = await realmWith(['realm.members.manage', 'realm.roles.manage']);
  const wide = await role(manager.realm, 'Wide');
  const holder = await realmWith([]);
  await pool.query(`INSERT INTO access.realm_admin_assignment (realm, role_id, member, valid_until)
    VALUES ($1,$2,$3,clock_timestamp() + interval '1 day')`, [manager.realm, wide, holder.actor]);
  await expect(admin.members(holder.principal, manager.realm, { actingSubject: holder.actor, role: wide }))
    .rejects.toBeInstanceOf(RealmAdminDenied);
  await expect(admin.roles(holder.principal, manager.realm, holder.actor)).rejects.toBeInstanceOf(RealmAdminDenied);
  const missing = await admin.members(manager.principal, manager.realm, { actingSubject: manager.actor, role: randomUUID() });
  expect(missing).toMatchObject({ items: [], nextCursor: null });

  await pool.query('UPDATE access.recovery_fence SET open = false WHERE id');
  try {
    await expect(admin.roles(manager.principal, manager.realm, manager.actor)).rejects.toBeInstanceOf(RealmAdminUnavailable);
  } finally {
    await pool.query('UPDATE access.recovery_fence SET open = true WHERE id');
  }
});

test('a roles manager who cannot read members does not learn who holds a role', async () => {
  const admin = new AccessRealmManagement(pool);
  const manager = await realmWith(['realm.roles.manage']);
  const wide = await role(manager.realm, 'Wide');
  const holder = agent(41);
  await pool.query("INSERT INTO access.authority_subject (id, kind, active) VALUES ($1, 'agent', true)", [holder]);
  await pool.query(`INSERT INTO access.realm_admin_assignment (realm, role_id, member, valid_until)
    VALUES ($1,$2,$3,clock_timestamp() + interval '1 day')`, [manager.realm, wide, holder]);
  const hidden = await admin.roles(manager.principal, manager.realm, manager.actor);
  const shown = (role: { id: string; name: string; permissions: readonly string[] }) =>
    ({ id: role.id, name: role.name, permissions: role.permissions });
  expect(hidden.roles).toEqual([expect.objectContaining({
    id: wide, name: 'Wide', permissions: [], holders: null, moreHolders: null })]);
  expect(JSON.stringify(hidden)).not.toContain(holder);
  await expect(admin.members(manager.principal, manager.realm, { actingSubject: manager.actor }))
    .rejects.toBeInstanceOf(RealmAdminDenied);

  const reader = await principalOn(manager.realm, manager.scope, ['realm.roles.manage', 'realm.members.manage']);
  const visible = await admin.roles(reader.principal, manager.realm, reader.actor);
  expect(visible.generation).toBe(hidden.generation);
  expect(visible.cap).toBe(hidden.cap);
  expect(visible.roles.map(shown)).toEqual(hidden.roles.map(shown));
  expect(visible.roles[0]).toMatchObject({ holders: [holder], moreHolders: false });
});
