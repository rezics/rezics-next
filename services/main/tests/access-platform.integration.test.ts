import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
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

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `platform-access-${randomUUID()}`);
const data = join(state, 'pgdata');
let pool: Pool;
let started = false;
let admin: Awaited<ReturnType<typeof person>>;
let reader: Awaited<ReturnType<typeof person>>;
let grants: AccessGrants;
let exposure: AccessExposure;
let app: ReturnType<typeof buildApp>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: digest(randomUUID()) });

beforeAll(async () => {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], {
    cwd: state,
    stdio: 'pipe',
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('No PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
  execFileSync(
    'pg_ctl',
    [
      '-D',
      data,
      '-l',
      join(state, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k /tmp`,
      '-w',
      'start',
    ],
    { cwd: state, stdio: 'pipe' },
  );
  started = true;
  pool = new Pool({
    host: '127.0.0.1',
    port,
    user: process.env.USER,
    database: 'postgres',
    max: 4,
    connectionTimeoutMillis: 1000,
  });
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
  exposure = new AccessExposure(pool);
  app = buildApp();
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (started)
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], {
      cwd: state,
      stdio: 'pipe',
    });
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
  // A second holder has its own assignment ceiling and can govern independently.
  await pool.query(
    `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
    VALUES ($1,$2,$2,'platform:access','access.grant.assign.platform','infinity')`,
    [randomUUID(), other.actor],
  );
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

test('assignment beyond the ceiling and assignment by a mere platform user are refused', async () => {
  const limited = await person();
  await grants.platform.create(
    await context(),
    randomUUID(),
    'platform:grant',
    { principalId: limited.id },
    new Date(Date.now() + 60_000),
    receipt(),
  );
  await pool.query(
    `INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
    VALUES ($1,$2,$2,'platform:access','access.grant.assign.platform',clock_timestamp()+interval '10 seconds')`,
    [randomUUID(), limited.actor],
  );
  await expect(
    grants.platform.create(
      await context(limited),
      randomUUID(),
      'platform:use:events',
      { principalId: reader.id },
      new Date(Date.now() + 60_000),
      receipt(),
    ),
  ).rejects.toBeInstanceOf(PlatformGrantDenied);
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

test('administrator authority uses resource grants while the legacy singleton remains', async () => {
  expect(
    (await pool.query('SELECT count(*)::int AS count FROM access.platform_administrator')).rows[0]
      .count,
  ).toBe(1);
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
  expect((await exposure.summary(recipient.principal)).groups).toEqual(['saved-views']);
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
  expect((await exposure.summary(recipient.principal)).groups).toEqual(['saved-views']);
  await pool.query(
    `UPDATE access.private_membership SET state='left',generation=generation+1,
    terms_revision=NULL,consent_reference=NULL WHERE id=$1`,
    [membership],
  );
  expect((await exposure.summary(recipient.principal)).groups).toEqual([]);
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
