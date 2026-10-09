// sql-relations-allow: access.platform_administrator -- The setup inserts the pre-grant singleton before migration 1290 so the upgrade preserves that holder, then proves migration 1291 removed the table.
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { Elysia } from 'elysia';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { AccessExposure } from '../src/modules/access/exposure.ts';
import { bindPlatformExposure } from '../src/modules/access/exposure-routes.ts';
import { AccessGrants } from '../src/modules/access/grants.ts';
import { AccessGroups, GroupDenied } from '../src/modules/access/groups.ts';
import {
  AccessPlatformAdministrators,
  platformAdministratorProof,
  platformAdministratorProofCurrent,
  platformAdministratorTargetAllowed,
} from '../src/modules/access/platform-administrator.ts';
import {
  PlatformGrantDenied,
  PlatformGrantStale,
  PlatformGrantUnavailable,
} from '../src/modules/access/platform-grants.ts';
import { SavedFilterStore } from '../src/modules/saved-filter/store.ts';
import {
  accessAuthorityRoutes,
  openApiOperations as grantOperations,
} from '../src/routes/access-authority.ts';
import {
  platformAccessRoutes,
  openApiOperations as summaryOperations,
} from '../src/routes/platform-access.ts';
import {
  savedFilterRoutes,
  openApiOperations as savedOperations,
} from '../src/routes/saved-filters.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { PostgresRateLimitStore } from '../src/modules/rate-limit/store.ts';
import {
  PLATFORM_COST,
  PlatformAccessUnavailable,
  readPlatformPermissions,
} from '../src/modules/access/platform-permissions.ts';

const root = resolve(import.meta.dir, '../../..');
let cluster: PostgresCluster | undefined;
let pool: Pool;
let admin: Awaited<ReturnType<typeof person>>;
let reader: Awaited<ReturnType<typeof person>>;
let grants: AccessGrants;
let exposure: AccessExposure;
let app: ReturnType<typeof buildApp>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()) });
const rateStore = (owner: Pool = pool) =>
  new PostgresRateLimitStore(owner, {
    secret: 'platform-proof-fixture-secret-at-least-32',
    serviceClientIds: new Set(),
    trustedProxyPeers: new Set(),
    clientIpHeader: 'x-forwarded-for',
  });

beforeAll(async () => {
  const running = await startPostgresCluster();
  cluster = running;
  pool = new Pool({ ...running.connection, max: 4, connectionTimeoutMillis: 1000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of schemaFiles(root, 'access')) {
      if (file === '1290_platform_grants.sql') {
        // Upgrade an actual pre-grant singleton designation; the migration must
        // preserve this holder without changing its immutable audit record.
        admin = await person(client);
        const designation = digest(admin.id);
        await client.query(
          `INSERT INTO access.platform_administrator(principal_id,role,receipt,request_digest,idempotency_key)
          VALUES ($1,'platform.administrator',$2,$3,'platform-first-administrator-v1')`,
          [admin.id, `urn:rezics:access-receipt:${designation}`, designation],
        );
      }
      await client.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  reader = await person();
  await new AccessPlatformAdministrators(pool).designateFirst(
    admin.principal.issuer,
    admin.principal.subject,
    () => undefined,
  );
  grants = new AccessGrants(pool);
  // This suite proves a grant opens and closes the group. The QA stack's
  // open-groups setting stays off for this process.
  exposure = new AccessExposure(pool, { REZICS_PLATFORM_OPEN_GROUPS: '' });
  app = buildApp();
}, 60_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
});

async function person(owner: Pool | PoolClient = pool) {
  const id = randomUUID(),
    actor = `https://rezics.com/id/${randomUUID()}`,
    control = randomUUID();
  const principal = {
    issuer: 'https://account.platform.test',
    subject: randomUUID(),
    emailVerified: true,
  };
  await owner.query(
    'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [id, principal.issuer, principal.subject],
  );
  await owner.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
  await owner.query(
    `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`,
    [control, id, actor],
  );
  await owner.query(
    `INSERT INTO access.agent_provision(id,principal_id,idempotency_key,request_digest,agent_id,agent_kind,
    display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
    VALUES ($1,$2,$6,$3,$4,'person','Platform reader',0,'active','platform-test',1,$5)`,
    [randomUUID(), id, digest(id), actor, control, randomUUID()],
  );
  return { id, actor, principal };
}

function buildApp() {
  const work = {
    grants,
    platformAccess: exposure,
    savedFilters: new SavedFilterStore(pool),
    account: {
      verify: async (request: Request) =>
        request.headers.get('authorization') === 'Bearer admin'
          ? admin.principal
          : reader.principal,
    },
  } as unknown as MainWorkDependencies;
  return new Elysia()
    .use(accessAuthorityRoutes(work))
    .use(platformAccessRoutes(work))
    .use(savedFilterRoutes(work))
    .use(bindPlatformExposure(work, [grantOperations, summaryOperations, savedOperations]));
}
const epoch = async () =>
  (
    await pool.query<{ authority_epoch: string }>(
      "SELECT authority_epoch FROM access.scope_gate WHERE id = 'platform:access'",
    )
  ).rows[0]!.authority_epoch;
const context = async (holder = admin) => ({
  principal: holder.principal,
  issuerSubject: holder.actor,
  expectedAuthorityEpoch: await epoch(),
});
const call = (path: string, token?: string, body?: unknown, key = randomUUID()) =>
  app.handle(
    new Request(`http://main.test${path}`, {
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
      },
    }),
  );
const saved = () => `/v1/me/saved-filters?actingSubject=${encodeURIComponent(reader.actor)}`;

test('ordinary and anonymous summaries are empty; saved views open, revoke and expire with their grants', async () => {
  const anonymous = await call('/v1/me/platform-access');
  expect(anonymous.status).toBe(200);
  expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
  expect(await anonymous.json()).toEqual({ groups: [], operations: [], generation: 'anonymous' });
  const ordinary = await call('/v1/me/platform-access', 'reader');
  expect(await ordinary.json()).toMatchObject({ groups: [], operations: [] });
  expect((await call(saved(), 'reader')).status).toBe(403);
  const grant = await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:use:saved-views',
    { principalId: reader.id },
    new Date(Date.now() + 60_000),
    receipt(),
  );
  expect((await call(saved(), 'reader')).status).toBe(200);
  const before = await exposure.summary(reader.principal);
  expect(before.groups).toEqual(['saved-views']);
  await grants.platform.revoke(await context(), grant.grant.id, grant.grant.generation, receipt());
  expect((await call(saved(), 'reader')).status).toBe(403);
  expect((await exposure.summary(reader.principal)).generation).not.toBe(before.generation);
  const temporaryContext = await context(),
    temporaryId = randomUUID(),
    temporaryReceipt = receipt();
  const temporaryDeadline = new Date(Date.now() + 200);
  const temporary = await grants.platform.create(
    temporaryContext,
    temporaryId,
    'platform:use:saved-views',
    { principalId: reader.id },
    temporaryDeadline,
    temporaryReceipt,
  );
  expect((await call(saved(), 'reader')).status).toBe(200);
  const skewedClock = spyOn(Date, 'now').mockReturnValue(Date.now() - 600_000);
  try {
    await Bun.sleep(250);
    const expired = await call(saved(), 'reader');
    expect(expired.status).toBe(403);
    expect(await expired.json()).toMatchObject({ code: 'platform_closed' });
  } finally {
    skewedClock.mockRestore();
  }
  expect(
    await grants.platform.create(
      temporaryContext,
      temporaryId,
      'platform:use:saved-views',
      { principalId: reader.id },
      temporaryDeadline,
      temporaryReceipt,
    ),
  ).toEqual(temporary);
  await expect(
    grants.platform.create(
      await context(),
      randomUUID(),
      'platform:use:saved-views',
      { principalId: reader.id },
      temporaryDeadline,
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
  expect(
    (
      await pool.query('SELECT active FROM access.principal_permission_grant WHERE id=$1', [
        temporary.grant.id,
      ])
    ).rows[0].active,
  ).toBe(true);
});

test('platform:grant issues and revokes through the existing HTTP grant operation, with idempotency and stale protection', async () => {
  const grantId = randomUUID(),
    key = randomUUID();
  const body = {
    profile: 'platform-grant-change-v1',
    issuerSubject: admin.actor,
    expectedAuthorityEpoch: await epoch(),
    action: 'create',
    grantId,
    permission: 'platform:use:saved-views',
    recipient: { principalId: reader.id },
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  const issued = await call('/v1/access/grant-changes', 'admin', body, key);
  expect(issued.status).toBe(200);
  const result = (await issued.json()) as { authorityEpoch: string; grant: { generation: string } };
  expect(await (await call('/v1/access/grant-changes', 'admin', body, key)).json()).toEqual({
    profile: body.profile,
    ...result,
  });
  const revoked = await call('/v1/access/grant-changes', 'admin', {
    profile: body.profile,
    issuerSubject: admin.actor,
    expectedAuthorityEpoch: await epoch(),
    action: 'revoke',
    grantId,
    expectedObjectGeneration: result.grant.generation,
  });
  expect(revoked.status).toBe(200);
  const stale = await context();
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:use:events',
    { principalId: reader.id },
    new Date(Date.now() + 60_000),
    receipt(),
  );
  await expect(
    grants.platform.create(
      stale,
      randomUUID(),
      'platform:use:commerce',
      { principalId: reader.id },
      new Date(Date.now() + 60_000),
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantStale);
});

test('the last governance anchor and its principal cannot be removed; parallel removals preserve one holder', async () => {
  const anchor = (
    await pool.query<{ id: string; generation: string }>(
      `SELECT id,generation FROM access.principal_permission_grant
    WHERE principal_id=$1 AND action='platform:grant'`,
      [admin.id],
    )
  ).rows[0]!;
  await expect(
    grants.platform.revoke(await context(), anchor.id, anchor.generation, receipt()),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
  await expect(
    pool.query('UPDATE access.principal SET active=false WHERE id=$1', [admin.id]),
  ).rejects.toMatchObject({ code: '23514' });
  const other = await person();
  const second = await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:grant',
    { principalId: other.id },
    null,
    receipt(),
  );
  // The appointment confers the assignment ceiling, so the second holder can govern.
  const results = await Promise.allSettled([
    grants.platform.revoke(await context(), anchor.id, anchor.generation, receipt()),
    grants.platform.revoke(
      await context(other),
      second.grant.id,
      second.grant.generation,
      receipt(),
    ),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  // Restore the original test administrator through the surviving holder, as a
  // fresh episode; terminal grants never reactivate.
  const live = (
    await pool.query<{
      principal_id: string;
    }>(`SELECT principal_id FROM access.principal_permission_grant
    WHERE action='platform:grant' AND active AND valid_until='infinity'`)
  ).rows[0]!;
  if (live.principal_id !== admin.id) {
    await grants.platform.create(
      await context(other),
      randomUUID(),
      'platform:grant',
      { principalId: admin.id },
      null,
      receipt(),
    );
  }
});

test('a platform:grant confers its assignment ceiling and loses it on revoke, expiry and overreach', async () => {
  const limited = await person();
  const audience = await person();
  const grantId = randomUUID();
  const deadline = new Date(Date.now() + 5_000);
  const granted = await grants.platform.create(
    await context(),
    grantId,
    'platform:grant',
    { principalId: limited.id },
    deadline,
    receipt(),
  );
  const linked = (
    await pool.query<{ ceiling_id: string; active: boolean; matched: boolean }>(
      `SELECT c.ceiling_id, g.active, g.valid_until = p.valid_until AS matched
      FROM access.platform_assignment_ceiling c
      JOIN access.permission_grant g ON g.id = c.ceiling_id
      JOIN access.principal_permission_grant p ON p.id = c.grant_id
      WHERE c.grant_id = $1`,
      [granted.grant.id],
    )
  ).rows;
  expect(PLATFORM_COST.assignmentCeilingReads).toBe(1);
  expect(PLATFORM_COST.assignmentCeilingWrites).toBe(2);
  expect(linked).toHaveLength(1);
  expect(linked[0]!.active).toBe(true);
  expect(linked[0]!.matched).toBe(true);
  await grants.platform.create(
    await context(limited),
    randomUUID(),
    'platform:use:saved-views',
    { principalId: audience.id },
    new Date(Date.now() + 1_000),
    receipt(),
  );
  await expect(
    grants.platform.create(
      await context(limited),
      randomUUID(),
      'platform:use:events',
      { principalId: audience.id },
      new Date(Date.now() + 60_000),
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
  await expect(
    grants.platform.create(
      await context(limited),
      randomUUID(),
      'platform:grant',
      { principalId: audience.id },
      null,
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
  await expect(
    pool.query(
      "UPDATE access.permission_grant SET valid_until = clock_timestamp() + interval '1 day' WHERE id = $1",
      [linked[0]!.ceiling_id],
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    pool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [
      linked[0]!.ceiling_id,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  await grants.platform.revoke(await context(), granted.grant.id, granted.grant.generation, receipt());
  expect(
    (
      await pool.query('SELECT active FROM access.permission_grant WHERE id = $1', [
        linked[0]!.ceiling_id,
      ])
    ).rows[0].active,
  ).toBe(false);
  await expect(
    pool.query('UPDATE access.permission_grant SET active = true WHERE id = $1', [
      linked[0]!.ceiling_id,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    grants.platform.create(
      await context(limited),
      randomUUID(),
      'platform:use:events',
      { principalId: audience.id },
      new Date(Date.now() + 1_000),
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);

  const expiring = await person();
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:grant',
    { principalId: expiring.id },
    new Date(Date.now() + 300),
    receipt(),
  );
  await Bun.sleep(400);
  await expect(
    grants.platform.create(
      await context(expiring),
      randomUUID(),
      'platform:use:saved-views',
      { principalId: audience.id },
      new Date(Date.now() + 1_000),
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);

  const bare = randomUUID();
  await pool.query(
    'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [bare, 'https://account.platform.test', randomUUID()],
  );
  await expect(
    grants.platform.create(
      await context(),
      randomUUID(),
      'platform:grant',
      { principalId: bare },
      null,
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
  expect(
    (await pool.query('SELECT id FROM access.principal_permission_grant WHERE principal_id = $1', [
      bare,
    ])).rows,
  ).toEqual([]);

  const group = randomUUID();
  const groupGrant = randomUUID();
  await pool.query("INSERT INTO access.recipient_group(id,scope_id) VALUES ($1,'work:create:root')", [
    group,
  ]);
  await grants.platform.create(
    await context(),
    groupGrant,
    'platform:grant',
    { groupId: group },
    null,
    receipt(),
  );
  expect(
    (await pool.query('SELECT grant_id FROM access.platform_assignment_ceiling WHERE grant_id = $1', [
      groupGrant,
    ])).rows,
  ).toEqual([]);
  const useGrant = randomUUID();
  await grants.platform.create(
    await context(),
    useGrant,
    'platform:use:events',
    { principalId: audience.id },
    new Date(Date.now() + 60_000),
    receipt(),
  );
  expect(
    (await pool.query('SELECT grant_id FROM access.platform_assignment_ceiling WHERE grant_id = $1', [
      useGrant,
    ])).rows,
  ).toEqual([]);
  await expect(
    grants.platform.create(
      await context(reader),
      randomUUID(),
      'platform:use:commerce',
      { principalId: reader.id },
      new Date(Date.now() + 5000),
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
});

test('administrator authority survives upgrade and removal of the legacy singleton', async () => {
  expect(
    (await pool.query('SELECT to_regclass($1) AS relation', ['access.platform_administrator']))
      .rows[0].relation,
  ).toBeNull();
  expect(await rateStore().classify(admin.principal)).toBe('trusted');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    expect(await platformAdministratorProof(client, admin.id, admin.actor)).not.toBeNull();
    expect(
      await platformAdministratorTargetAllowed(
        client,
        undefined,
        admin.id,
        admin.actor,
        'work.create',
        'work:create:root',
      ),
    ).toBe(true);
    expect(
      await platformAdministratorTargetAllowed(
        client,
        undefined,
        admin.id,
        admin.actor,
        'work.edit',
        `work:edit:${reader.actor}`,
      ),
    ).toBe(false);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
});

test('rate-limit trust follows live platform-admin grants, expiry and principal activation in one query', async () => {
  const recipient = await person();
  const calls: string[] = [];
  const store = rateStore({
    query: async (sql: string, params: unknown[]) => {
      calls.push(sql);
      return pool.query(sql, params);
    },
  } as unknown as Pool);
  expect(await store.classify(recipient.principal)).toBe('new-account');
  const designation = await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:use:platform-admin',
    { principalId: recipient.id },
    new Date(Date.now() + 60_000),
    receipt(),
  );
  expect(await store.classify(recipient.principal)).toBe('trusted');
  await pool.query('UPDATE access.principal SET active=false WHERE id=$1', [recipient.id]);
  expect(await store.classify(recipient.principal)).toBe('new-account');
  await pool.query('UPDATE access.principal SET active=true WHERE id=$1', [recipient.id]);
  await grants.platform.revoke(
    await context(),
    designation.grant.id,
    designation.grant.generation,
    receipt(),
  );
  expect(await store.classify(recipient.principal)).toBe('new-account');
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:use:platform-admin',
    { principalId: recipient.id },
    new Date(Date.now() + 300),
    receipt(),
  );
  expect(await store.classify(recipient.principal)).toBe('trusted');
  await Bun.sleep(350);
  expect(await store.classify(recipient.principal)).toBe('new-account');
  expect(calls).toHaveLength(6);
  expect(
    calls.every(
      (sql) =>
        sql.includes('access.read_platform_permissions') &&
        !sql.includes('FROM access.platform_administrator'),
    ),
  ).toBe(true);
});

test('fresh startup serializes first designation and configuration never resurrects a revoked grant', async () => {
  const database = `platform_bootstrap_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE DATABASE ${database}`);
  const bootstrap = new Pool({ ...pool.options, database, max: 4 });
  try {
    const client = await bootstrap.connect();
    try {
      await client.query('BEGIN');
      for (const file of schemaFiles(root, 'access'))
        await client.query(
          readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'),
        );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const first = await person(bootstrap),
      second = await person(bootstrap);
    const administrators = new AccessPlatformAdministrators(bootstrap);
    const results = await Promise.all(
      [first, second].map((candidate) =>
        administrators.designateFirst(
          candidate.principal.issuer,
          candidate.principal.subject,
          () => undefined,
        ),
      ),
    );
    expect(results.map((result) => result.status).sort()).toEqual(['granted', 'ignored']);
    expect(results[0]).toHaveProperty('receipt');
    expect(results[1]).toHaveProperty(
      'receipt',
      'receipt' in results[0]! ? results[0].receipt : undefined,
    );
    const holder = results[0]!.status === 'granted' ? first : second;
    const other = holder === first ? second : first;
    expect(await rateStore(bootstrap).classify(holder.principal)).toBe('trusted');
    expect(await rateStore(bootstrap).classify(other.principal)).toBe('new-account');
    await bootstrap.query(
      `UPDATE access.principal_permission_grant SET active=false,generation=generation+1
      WHERE principal_id=$1 AND action='platform:use:platform-admin'`,
      [holder.id],
    );
    await administrators.designateFirst(
      other.principal.issuer,
      other.principal.subject,
      () => undefined,
    );
    expect(await rateStore(bootstrap).classify(holder.principal)).toBe('new-account');
    expect(await rateStore(bootstrap).classify(other.principal)).toBe('new-account');
    expect(
      (
        await bootstrap.query(`SELECT count(*)::int AS count FROM access.principal_permission_grant
      WHERE action='platform:grant'`)
      ).rows[0].count,
    ).toBe(1);
  } finally {
    await bootstrap.end();
    await pool.query(`DROP DATABASE ${database}`);
  }
}, 60_000);

test('group platform grants follow the private membership episode and inherited group path', async () => {
  const recipient = await person(),
    parent = randomUUID(),
    child = randomUUID(),
    membership = randomUUID(),
    consent = randomUUID();
  await pool.query(
    `INSERT INTO access.membership_policy(kind,owner_subject,revision,terms_revision)
    VALUES ('org',$1,1,'terms')`,
    [admin.actor],
  );
  await pool.query(
    `INSERT INTO access.private_membership_consent(id,principal_id,principal_epoch,kind,owner_subject,
    policy_revision,terms_revision,next_generation,expires_at) VALUES ($1,$2,0,'org',$3,1,'terms',1,clock_timestamp()+interval '5 minutes')`,
    [consent, recipient.id, admin.actor],
  );
  await pool.query(
    `INSERT INTO access.private_membership(id,kind,owner_subject,principal_id,state,generation,policy_revision,
    terms_revision,consent_reference) VALUES ($1,'org',$2,$3,'joined',1,1,'terms',$4)`,
    [membership, admin.actor, recipient.id, consent],
  );
  await pool.query(
    "INSERT INTO access.recipient_group(id,scope_id) VALUES ($1,'work:create:root')",
    [parent],
  );
  await pool.query(
    "INSERT INTO access.recipient_group(id,scope_id,parent_id) VALUES ($1,'work:create:root',$2)",
    [child, parent],
  );
  await pool.query(
    `INSERT INTO access.private_group_member(id,group_id,principal_id,private_membership_id,
    private_membership_generation,assigned_by_principal) VALUES ($1,$2,$3,$4,1,$5)`,
    [randomUUID(), child, recipient.id, membership, admin.id],
  );
  const inherited = await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:use:saved-views',
    { groupId: parent },
    new Date(Date.now() + 60_000),
    receipt(),
  );
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:use:platform-admin',
    { groupId: parent },
    new Date(Date.now() + 60_000),
    receipt(),
  );
  expect((await exposure.summary(recipient.principal)).groups).toEqual([
    'platform-admin',
    'saved-views',
  ]);
  expect(await rateStore().classify(recipient.principal)).toBe('trusted');
  // SQL must retain the previous proof witness so saved admissions survive the
  // evaluator migration, including the exact membership serialization.
  const members = (
    await pool.query(
      `SELECT m.id,m.group_id,m.generation,m.private_membership_generation
    FROM access.private_group_member m WHERE m.principal_id=$1 ORDER BY m.id`,
      [recipient.id],
    )
  ).rows;
  const path = (
    await pool.query(`SELECT id,generation FROM access.recipient_group WHERE id=ANY($1::uuid[])`, [
      [child, parent],
    ])
  ).rows;
  const generationOf = (id: string) => path.find((group) => group.id === id).generation;
  const episode = (
    await pool.query('SELECT receipt FROM access.platform_grant_episode WHERE group_grant_id=$1', [
      inherited.grant.id,
    ])
  ).rows[0];
  const proof = (await readPlatformPermissions(pool, recipient.id)).find(
    (grant) => grant.id === inherited.grant.id,
  )!;
  expect(proof.witness).toBe(
    `${episode.receipt}:${inherited.grant.generation}:${child}:${generationOf(child)}:${parent}:${generationOf(parent)}:${JSON.stringify(members)}`,
  );
  // The older work.create manager shares these tables but cannot inventory or
  // revoke a platform permission through its narrower authority boundary.
  await pool.query(
    `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'access.group.manage','infinity')`,
    [randomUUID(), admin.id, admin.actor],
  );
  await pool.query(
    `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
    VALUES ($1,$2,$2,'work:create:root','access.group.manage','infinity')`,
    [randomUUID(), admin.actor],
  );
  const groups = new AccessGroups(pool);
  expect((await groups.readState(admin.principal, admin.actor)).grants).toEqual([]);
  const generation = (
    await pool.query<{ group_generation: string }>(
      "SELECT group_generation FROM access.scope_gate WHERE id='access:group-inventory'",
    )
  ).rows[0]!.group_generation;
  await expect(
    groups.revokeGrant(
      {
        principal: admin.principal,
        issuerSubject: admin.actor,
        expectedGroupGeneration: generation,
      },
      inherited.grant.id,
      inherited.grant.generation,
    ),
  ).rejects.toBeInstanceOf(GroupDenied);
  expect((await exposure.summary(recipient.principal)).groups).toEqual([
    'platform-admin',
    'saved-views',
  ]);
  await pool.query(
    `UPDATE access.private_membership SET state='left',generation=generation+1,
    terms_revision=NULL,consent_reference=NULL WHERE id=$1`,
    [membership],
  );
  expect((await exposure.summary(recipient.principal)).groups).toEqual([]);
  expect(await rateStore().classify(recipient.principal)).toBe('new-account');
  // Even a direct matching grant cannot short-circuit a malformed oversized
  // membership proof into a trust upgrade.
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:use:platform-admin',
    { principalId: recipient.id },
    new Date(Date.now() + 60_000),
    receipt(),
  );
  await pool.query(
    `UPDATE access.private_membership SET state='joined',generation=generation+1,
    terms_revision='terms',consent_reference=$2 WHERE id=$1`,
    [membership, consent],
  );
  const current = (
    await pool.query('SELECT generation FROM access.private_membership WHERE id=$1', [membership])
  ).rows[0];
  for (let index = 0; index < PLATFORM_COST.groups + 1; index++) {
    const group = randomUUID();
    await pool.query(
      "INSERT INTO access.recipient_group(id,scope_id) VALUES ($1,'work:create:root')",
      [group],
    );
    await pool.query(
      `INSERT INTO access.private_group_member(id,group_id,principal_id,private_membership_id,
      private_membership_generation,assigned_by_principal) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), group, recipient.id, membership, current.generation, admin.id],
    );
  }
  await expect(readPlatformPermissions(pool, recipient.id)).rejects.toBeInstanceOf(
    PlatformAccessUnavailable,
  );
  await expect(rateStore().classify(recipient.principal)).rejects.toMatchObject({ code: '54000' });
});

test('individual operation grants open only that operation and summary retains at most 64', async () => {
  const recipient = await person();
  const id = 'getV1MeSaved-filters';
  await grants.platform.create(
    await context(),
    randomUUID(),
    `platform:use:${id}`,
    { principalId: recipient.id },
    new Date(Date.now() + 60_000),
    receipt(),
  );
  const summary = await exposure.summary(recipient.principal);
  expect(summary.operations).toEqual([id]);
  expect(summary.groups).toEqual([]);
  await exposure.require(recipient.principal, 'platform:saved-views', id);
  await expect(
    exposure.require(recipient.principal, 'platform:saved-views', 'postV1MeSaved-filters'),
  ).rejects.toMatchObject({ code: 'platform_closed' });
  for (let index = 1; index < 64; index++)
    await grants.platform.create(
      await context(),
      randomUUID(),
      `platform:use:getV1Example${index}`,
      { principalId: recipient.id },
      new Date(Date.now() + 60_000),
      receipt(),
    );
  expect((await exposure.summary(recipient.principal)).operations).toHaveLength(64);
  await expect(
    grants.platform.create(
      await context(),
      randomUUID(),
      'platform:use:getV1TooMany',
      { principalId: recipient.id },
      new Date(Date.now() + 60_000),
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
});

test('platform-admin access supplies no resource authority and resource assignments need their own ceiling', async () => {
  const recipient = await person();
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:use:platform-admin',
    { principalId: recipient.id },
    null,
    receipt(),
  );
  const client = await pool.connect();
  try {
    expect(
      await platformAdministratorProof(client, recipient.id, recipient.actor, true, {
        action: 'work.create',
        scope: 'work:create:root',
      }),
    ).toBeNull();
  } finally {
    client.release();
  }
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:resource:work.create',
    { principalId: recipient.id },
    null,
    receipt(),
    'work:create:root',
  );
  const proofClient = await pool.connect();
  try {
    expect(
      await platformAdministratorProof(proofClient, recipient.id, recipient.actor, true, {
        action: 'work.create',
        scope: 'work:create:root',
      }),
    ).not.toBeNull();
  } finally {
    proofClient.release();
  }
  await expect(
    grants.platform.create(
      await context(),
      randomUUID(),
      'platform:resource:work.edit',
      { principalId: recipient.id },
      null,
      receipt(),
      `work:edit:${reader.actor}`,
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
});

test('a replacement resource grant never revives a saved administrator admission proof', async () => {
  const recipient = await person();
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:use:platform-admin',
    { principalId: recipient.id },
    null,
    receipt(),
  );
  const resource = await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:resource:work.create',
    { principalId: recipient.id },
    null,
    receipt(),
    'work:create:root',
  );
  const client = await pool.connect();
  try {
    const saved = await platformAdministratorProof(client, recipient.id, recipient.actor);
    expect(saved).not.toBeNull();
    expect(
      await platformAdministratorProofCurrent(client, saved!, recipient.id, recipient.actor),
    ).toBe(true);
    await grants.platform.revoke(
      await context(),
      resource.grant.id,
      resource.grant.generation,
      receipt(),
    );
    await grants.platform.create(
      await context(),
      randomUUID(),
      'platform:resource:work.create',
      { principalId: recipient.id },
      null,
      receipt(),
      'work:create:root',
    );
    expect(
      await platformAdministratorTargetAllowed(
        client,
        undefined,
        recipient.id,
        recipient.actor,
        'work.create',
        'work:create:root',
      ),
    ).toBe(true);
    expect(
      await platformAdministratorProofCurrent(client, saved!, recipient.id, recipient.actor),
    ).toBe(false);
  } finally {
    client.release();
  }
});

test('recovery holds and a missing recipient leave neither grants nor receipts partially committed', async () => {
  const missing = randomUUID(),
    audit = receipt();
  await expect(
    grants.platform.create(
      await context(),
      missing,
      'platform:use:commerce',
      { principalId: randomUUID() },
      null,
      audit,
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
  expect(
    (await pool.query('SELECT id FROM access.platform_grant_episode WHERE id=$1', [missing])).rows,
  ).toEqual([]);
  expect(
    (
      await pool.query(
        'SELECT grant_id FROM access.platform_grant_change_receipt WHERE idempotency_key=$1',
        [audit.idempotencyKey],
      )
    ).rows,
  ).toEqual([]);
  await pool.query('UPDATE access.recovery_fence SET open=false WHERE id=true');
  try {
    await expect(
      grants.platform.create(
        await context(),
        randomUUID(),
        'platform:use:commerce',
        { principalId: reader.id },
        null,
        receipt(),
      ),
    ).rejects.toBeInstanceOf(PlatformGrantUnavailable);
  } finally {
    await pool.query('UPDATE access.recovery_fence SET open=true WHERE id=true');
  }
});
