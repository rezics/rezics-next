import { AuthenticationError } from '../../src/request/access.ts';
import { suspendAccount, reinstateAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { authoritativeTimeValue, IdempotencyConflictError } from '../../src/command/command.ts';
import { CONTENT_EVENTS } from '../../src/content/events.ts';
import { MEDIA_EVENTS } from '../../src/content/media-events.ts';
import { MEDIA_MODERATION_EVENTS } from '../../src/content/media-moderation-events.ts';
import { takedownMedia } from '../../src/content/media-moderation.ts';
import { createErasureJob } from '../../src/content/erasure-job.ts';
import { takedownSourceFence } from '../../src/content/source-fence-command.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { readFences } from '../../src/content/source-fences.ts';
import { createPool } from '../../src/database/pool.ts';
import { readPartition } from '../../src/partition/partition.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
const admin = createPool(url);
const observer = observeSql(pool);
const routeKey = new Uint8Array(32).fill(7);
const route = 0x6789;
const partition = partitionOf(route);
const action = 'moderation:takedown';
const sourceAction = 'source_fence:takedown';
const eventType = 'com.rezics.content.media.taken-down.v1';
const root = { route: 0, id: '00000000-0000-8000-8000-000000000000' };
const moderatorId = newId(0x1234);
const uploaderId = newId(0x2345);
const suspendedId = newId(0x3456);
const accountIds = [moderatorId, uploaderId, suspendedId];
const transactionId = newId(route);
const issuer = 'https://auth.media.test';
const audience = 'https://api.media.test';
const authDatabase = `media_auth_${process.pid}`;
const authUrl = new URL(url);
authUrl.pathname = `/${authDatabase}`;
let authPool: Pool;
let auth: AuthService;
const tokens = new Map<string, string>();
const context = (idempotencyKey = Bun.randomUUIDv7()) => ({
  idempotencyKey,
  requestId: Bun.randomUUIDv7(),
  deadline: Date.now() + 30_000,
});
const input = (mediaId: string) => ({ mediaId, reason: 'private rights complaint evidence' });

async function accounts(db: Pool) {
  for (const id of accountIds)
    await db.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,'actor','active',$3) ON CONFLICT DO NOTHING`,
      [routeOf(id), id, transactionId],
    );
}
beforeAll(async () => {
  await accounts(admin);
  await admin.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = createPool(authUrl.toString());
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'media-test-key',
    alg: 'ES256',
  };
  const approvals = new Set(accountIds);
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'test-media-auth-secret-with-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const row = await readAccount(admin, routeOf(id)!, id);
        return (
          row && {
            accountId: id,
            kind: row.kind,
            state: row.state,
            authnEpoch: Number(row.minimumAuthnEpoch),
            automated: false,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('Missing fixture provisioning approval');
        return { accountId: reference };
      },
    }),
  });
  await auth.internal.registerClient({
    clientId: 'web',
    firstParty: true,
    scopes: [action, sourceAction, 'subject:read'],
  });
  const request = (path: string, body: unknown, cookie = '') =>
    auth.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );
  for (const id of accountIds) {
    await admin.query("UPDATE access.account SET state='pending' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
    await auth.internal.provisionPassword({
      authorization: id,
      email: `${id}@example.test`,
      password: 'test-password-media',
    });
    await admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
    for (const scoped of [true, false]) {
      const login = await request('/signin', {
        email: `${id}@example.test`,
        password: 'test-password-media',
        client_id: 'web',
        scope: scoped ? [action, sourceAction] : ['subject:read'],
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((v) => v.split(';')[0])
        .join('; ');
      const response = await request('/token', {}, cookie);
      expect(response.status).toBe(200);
      tokens.set(`${id}:${scoped}`, ((await response.json()) as { access_token: string }).access_token);
    }
  }
}, 60_000);
afterAll(async () => {
  await observer.close();
  await pool.end();
  await authPool?.end();
  await dropTestDatabase(admin, authDatabase);
  await admin.end();
});

function mediaRow(mediaId = newId(route)) {
  return {
    route: routeOf(mediaId)!,
    media_id: mediaId,
    container_id: newId(routeOf(mediaId)!),
    uploader_id: uploaderId,
    reservation_request_id: mediaId,
    purpose: 'cover',
    media_type: 'image/jpeg',
    byte_count: 3,
    actual_byte_count: 3,
    sha256: 'a'.repeat(64),
    state: 'available',
    key: `m/${mediaId}/original`,
    claimed_at: '2020-01-01T00:00:00Z',
    transaction_id: transactionId,
    source_url: 'https://catalogue.test/image.jpg',
    credit: {
      rightsHolder: 'Retained holder',
      via: { name: 'Catalogue', url: 'https://catalogue.test' },
      license: 'CC-BY-4.0',
      obligations: ['attribution'],
    },
    provenance: {
      source: 'catalogue',
      external_id: mediaId,
      record_revision: '1',
      digest: 'b'.repeat(64),
      converter_revision: '1',
      field_group: 'cover',
      references: ['https://catalogue.test/record'],
    },
    security_revision: '9007199254740993',
  };
}
async function insertMedia(db: Pool, mediaId = newId(route)) {
  const row = mediaRow(mediaId);
  const keys = Object.keys(row);
  await db.query(
    `INSERT INTO content.media (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
  await db.query(
    `INSERT INTO content.media_variant
    (route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
    VALUES ($1,$2,'webp',320,100,'image/webp',3,$3,$4,$5)`,
    [row.route, mediaId, 'c'.repeat(64), `m/${mediaId}/webp-320`, transactionId],
  );
  return mediaId;
}
async function grant(
  db: Pool,
  mediaId: string,
  subject = moderatorId,
  verb = action,
  selectedRoute = routeOf(mediaId)!,
) {
  await db.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$5)`,
    [selectedRoute, mediaId, subject, verb, transactionId],
  );
}
async function fixture(database = { pool, admin }) {
  await accounts(database.admin);
  const mediaId = await insertMedia(database.admin);
  await grant(database.admin, mediaId);
  const access = createAccess({
    actions: new Map([
      [action, { anonymous: false }],
      [sourceAction, { anonymous: false }],
    ]),
    resourceRoles: { roles: { 'content.moderator': [action] }, types: {} },
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: (url, init) => auth.handler(new Request(url, init)),
    },
  });
  const authenticate = (id = moderatorId, scoped = true) =>
    access.authenticate(tokens.get(`${id}:${scoped}`)!, { pool: database.pool, deadline: Date.now() + 180_000 });
  const actor = await authenticate();
  const deps = { pool: database.pool, access, routeKey };
  const execute = (body = input(mediaId), request = context(), identity: Actor = actor) =>
    takedownMedia(deps, identity, body, request);
  return { ...database, mediaId, actor, access, deps, execute, authenticate };
}
async function facts(db: Pool, mediaId: string) {
  return (await db.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', [routeOf(mediaId), mediaId]))
    .rows[0];
}
async function receiptCount(mediaId: string, key: string) {
  return (
    await admin.query(
      `SELECT * FROM core.receipt WHERE partition_no=$1 AND actor_account_id=$2 AND idempotency_key=$3`,
      [partitionOf(routeOf(mediaId)!), moderatorId, key],
    )
  ).rows;
}

test('native authorized media takedown changes only target taken_down and security revision; revoked replay denies before receipt', async () => {
  const f = await fixture();
  const other = await insertMedia(admin);
  const before = await facts(admin, f.mediaId);
  const otherBefore = await facts(admin, other);
  const beforePartition = await readPartition(admin, partition);
  const rootBefore = await readPartition(admin, 0);
  const checks: unknown[] = [];
  const at = new Date();
  const access: Access = {
    ...f.access,
    async authorize(client, actor, verb, resource, evidence, time) {
      const allowed = await f.access.authorize(client, actor, verb, resource, evidence, time);
      checks.push({ verb, resource, allowed, at: new Date(authoritativeTimeValue(time!)).toISOString() });
      return allowed;
    },
  };
  const request = context();
  const start = observer.records.length;
  const first = await takedownMedia({ ...f.deps, access, clock: () => at }, f.actor, input(f.mediaId), request);
  expect(checks).toEqual([{ verb: action, resource: { route, id: f.mediaId }, allowed: true, at: at.toISOString() }]);
  expect(first.partition).toBe(partition);
  expect(first.position).toBe(beforePartition!.position + 1n);
  expect(first.value).toEqual({ mediaId: f.mediaId, securityRevision: '9007199254740994' });
  expect(await facts(admin, f.mediaId)).toEqual({
    ...before,
    taken_down: true,
    security_revision: first.value.securityRevision,
  });
  expect(await facts(admin, other)).toEqual(otherBefore);
  expect(await readPartition(admin, 0)).toEqual(rootBefore);
  const trace = observer.records.slice(start);
  expect(trace.filter((r) => /^BEGIN ISOLATION LEVEL SERIALIZABLE/.test(r.statement))).toHaveLength(1);
  expect(await f.execute(input(f.mediaId), context(request.idempotencyKey))).toEqual({ ...first, replayed: true });
  await expect(
    f.execute({ ...input(f.mediaId), reason: 'different' }, context(request.idempotencyKey)),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  const stable = await readPartition(admin, partition);
  await expect(f.execute()).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await readPartition(admin, partition)).toEqual(stable);
  const receipt = await receiptCount(f.mediaId, request.idempotencyKey);
  expect(receipt).toHaveLength(1);
  expect(receipt[0].response).toEqual(first.value);
  const outbox = (
    await admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2', [partition, first.position])
  ).rows;
  expect(outbox).toHaveLength(1);
  expect(JSON.stringify(outbox)).not.toContain(input(f.mediaId).reason);
  await admin.query(
    'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4',
    [route, f.mediaId, moderatorId, action],
  );
  const deniedStart = observer.records.length;
  await expect(f.execute(input(f.mediaId), context(request.idempotencyKey))).rejects.toBeInstanceOf(GrantDeniedError);
  expect(
    observer.records
      .slice(deniedStart)
      .some((r) => /core.receipt|^BEGIN ISOLATION LEVEL SERIALIZABLE/.test(r.statement)),
  ).toBe(false);
  expect(await readPartition(admin, partition)).toEqual(stable);
});

test('anonymous uploader author and suspended denials preserve state; bytes and appeal metadata retained', async () => {
  const f = await fixture();
  const author = await f.authenticate(uploaderId);
  const suspended = await f.authenticate(suspendedId);
  const unscoped = await f.authenticate(moderatorId, false);
  expect(unscoped.scopes).toEqual(['subject:read']);
  await grant(admin, f.mediaId, suspendedId);
  await suspendAccount(admin, suspendedId);
  const before = await facts(admin, f.mediaId);
  const anchor = await readPartition(admin, partition);
  try {
    for (const actor of [{ kind: 'anonymous' } as const, author, suspended, unscoped]) {
      const start = observer.records.length;
      await expect(f.execute(input(f.mediaId), context(), actor)).rejects.toBeInstanceOf(
        actor === suspended ? AuthenticationError : GrantDeniedError,
      );
      expect(observer.records.slice(start).some((r) => /core.receipt/.test(r.statement))).toBe(false);
      expect(await facts(admin, f.mediaId)).toEqual(before);
      expect(await readPartition(admin, partition)).toEqual(anchor);
    }
  } finally {
    await reinstateAccount(admin, suspendedId);
  }
  const wrong = await insertMedia(admin);
  await expect(f.execute(input(wrong))).rejects.toBeInstanceOf(GrantDeniedError);
  for (const id of ['invalid', newId(route ^ 16), f.mediaId.slice(0, 24) + '6788' + f.mediaId.slice(28)])
    await expect(f.execute(input(id))).rejects.toBeInstanceOf(GrantDeniedError);
  const erased = await insertMedia(admin);
  await grant(admin, erased);
  await admin.query(
    'UPDATE content.media SET erased=true, security_revision=security_revision+1 WHERE route=$1 AND media_id=$2',
    [route, erased],
  );
  await expect(f.execute(input(erased))).rejects.toBeInstanceOf(GrantDeniedError);
  const variants = (
    await admin.query('SELECT * FROM content.media_variant WHERE route=$1 AND media_id=$2', [route, f.mediaId])
  ).rows;
  const objects = new Map([
    [`m/${f.mediaId}/original`, new Uint8Array([1, 2, 3])],
    [`m/${f.mediaId}/webp-320`, new Uint8Array([4, 5, 6])],
  ]);
  const storage = {
    get: async (key: string) => objects.get(key) ?? null,
    put: async () => {
      throw new Error('Unexpected put');
    },
    deletePrefix: async () => {
      throw new Error('Takedown must retain bytes');
    },
  };
  await f.execute();
  expect(await createErasureJob(pool, storage).purgeObject(f.mediaId)).toEqual({
    mediaId: f.mediaId,
    outcome: 'fenced',
  });
  expect([...objects.values()]).toEqual([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]);
  expect(
    (await admin.query('SELECT * FROM content.media_variant WHERE route=$1 AND media_id=$2', [route, f.mediaId])).rows,
  ).toEqual(variants);
  expect(await facts(admin, f.mediaId)).toEqual({ ...before, taken_down: true, security_revision: '9007199254740994' });
});

test('point command rolls back media revision, partition, outbox and receipt on failure', async () => {
  const f = await fixture();
  const before = await facts(admin, f.mediaId);
  const anchor = await readPartition(admin, partition);
  const statement = observer.records.find((r) => /INSERT INTO core.outbox/.test(r.statement))!.statement;
  observer.armFault({ match: { statement }, boundary: 'before', error: new Error('outbox unavailable') });
  const request = context();
  await expect(f.execute(input(f.mediaId), request)).rejects.toThrow('outbox unavailable');
  expect(await facts(admin, f.mediaId)).toEqual(before);
  expect(await readPartition(admin, partition)).toEqual(anchor);
  expect(await receiptCount(f.mediaId, request.idempotencyKey)).toEqual([]);
});

test('rightsTakedown invokes both real APIs independently; the closed media event retains the native catalogue', async () => {
  const f = await fixture();
  await grant(admin, root.id, moderatorId, sourceAction, 0);
  const body = {
    source: 'catalogue',
    external_id: f.mediaId,
    field_group: 'cover' as const,
    reason: 'private complaint',
  };
  const media = await f.execute();
  const fenceRoute = tupleRoute(routeKey, body.source, body.external_id);
  const fence = await takedownSourceFence(f.deps, f.actor, body, context());
  expect(fence.partition).toBe(partitionOf(fenceRoute));
  expect(fence.transactionId).not.toBe(media.transactionId);
  expect(
    await readFences(admin, [
      { route: fenceRoute, source: body.source, external_id: body.external_id, field_group: 'cover' },
    ]),
  ).toEqual([
    {
      route: fenceRoute,
      source: body.source,
      external_id: body.external_id,
      field_group: 'cover',
      takenDown: true,
      securityRevision: fence.value.securityRevision,
    },
  ]);
  expect(CONTENT_EVENTS[eventType]).toBe(MEDIA_MODERATION_EVENTS[eventType]);
  for (const [name, schema] of Object.entries(MEDIA_EVENTS)) expect(Reflect.get(CONTENT_EVENTS, name)).toBe(schema);
  expect(Value.Check(CONTENT_EVENTS[eventType], media.value)).toBe(true);
  for (const patch of [
    { reason: 'text' },
    { credit: 'text' },
    { securityRevision: 1 },
    { securityRevision: '01' },
    { securityRevision: '0' },
  ])
    expect(Value.Check(CONTENT_EVENTS[eventType], { ...media.value, ...patch })).toBe(false);
  const rows = (
    await admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      media.partition,
      media.position,
    ])
  ).rows;
  expect(JSON.stringify(rows)).toContain(eventType);
  expect(JSON.stringify(rows)).not.toContain('Retained holder');
});

test('checkGrowth with actual formula across three informative scales and no content sequential scan', async () => {
  const db = await openGrowthDatabase(url);
  db.pool.options.max = 1;
  try {
    const f = await fixture(db);
    const targets = [f.mediaId];
    for (let i = 1; i < 18; i++) {
      const id = await insertMedia(db.admin);
      await grant(db.admin, id);
      targets.push(id);
    }
    const population: Population = {
      name: 'media-moderation',
      hotPartition: partition,
      hotShare: 0.5,
      // Two rows per ordinal put every read relation above 500 rows at the
      // first scale, without growing this actor's bounded membership evidence.
      // Coverage is stored on access.account; core.partition already has 4096
      // seeded anchors in the migrated database.
      rows: ({ route: selected, partition: selectedPartition }) => {
        const media = [mediaRow(newId(selected)), mediaRow(newId(selected))];
        const subjects = media.map((row) => ({
          route: selected,
          account_id: row.media_id,
          kind: 'actor',
          state: 'active',
          transaction_id: transactionId,
        }));
        const grants = media.map((row) => ({
          route: selected,
          resource_id: row.media_id,
          subject_id: row.media_id,
          valid: '(,)',
          transaction_id: transactionId,
        }));
        return {
          'content.media': media,
          'access.account': subjects,
          'access.resource_grant': grants.map((row) => ({ ...row, action })),
          'access.resource_role_grant': grants.map((row) => ({
            ...row,
            grant_role: 'content.moderator',
          })),
          'access.resource_denial': grants.map((row) => ({
            ...row,
            action,
            reason: 'resource',
          })),
          'access.membership_inverse': subjects.map((row) => ({
            route: selected,
            account_id: row.account_id,
            kind: 'organization',
            group_id: row.account_id,
            reservation_id: row.account_id,
            transaction_id: transactionId,
          })),
          'core.receipt': subjects.map((row) => ({
            partition_no: selectedPartition,
            principal_kind: 'account',
            principal_id: moderatorId,
            command_kind: 'content.media.takedown',
            idempotency_key: row.account_id,
            request_digest: Buffer.alloc(32),
            epoch: 1,
            position: 1,
            transaction_id: transactionId,
            response: {},
          })),
        };
      },
    };
    const report = await checkGrowth(db, {
      name: 'native exact media moderation',
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (_db, scale, previous) => {
        await seed(db, population, { from: previous, to: scale });
      },
      operation: async (_db, _scale, repetition) => {
        const result = await f.execute(input(targets[repetition]!));
        expect(result.partition).toBe(partition);
        expect(result.replayed).toBe(false);
      },
    });
    expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
    expect(new Set(report.samples.map((s) => s.cost.statements)).size).toBe(1);
    for (const { cost } of report.samples) {
      expect(cost.rows).toBeGreaterThan(0);
      expect(cost.blocks).toBeGreaterThan(0);
      expect(cost.relations).toBeDefined();
      if (!cost.relations) throw new Error('Missing measured relation costs');
      expect(cost.relations['content.media']).toBeDefined();
      expect(cost.relations['access.resource_grant']).toBeDefined();
      for (const [name, relation] of Object.entries(cost.relations))
        if (name.startsWith('content.')) expect(relation.sequentialScans).toBe(0);
    }
    console.info('media moderation growth evidence', JSON.stringify(report));
  } finally {
    await db.close();
  }
}, 90_000);
