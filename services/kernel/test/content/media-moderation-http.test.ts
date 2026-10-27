import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthService, createProvisioningEvidenceVerifier } from '@rezics/auth';
import { createKernelClient } from '@rezics/client';
import { exportJWK, generateKeyPair } from 'jose';
import type { Pool } from 'pg';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import { readPartition } from '../../src/partition/partition.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const action = 'moderation:takedown';
const eventType = 'com.rezics.content.media.taken-down.v1';
const route = 0x6789;
const partition = partitionOf(route);
const routeKey = new Uint8Array(32).fill(7);
const transactionId = newId(route);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const issuer = 'https://auth.example.test';
const password = 'correct horse battery staple';
const scopes = [action, 'media:read'];
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let auth: Awaited<ReturnType<typeof createAuthService>>;
let authPool: Pool;
let authDatabase: string;
let moderatorId: string;
let uploaderId: string;
let bearer: string;
let uploaderBearer: string;
let noScopeBearer: string;
let app: ReturnType<typeof createKernel>;
let observer: ReturnType<typeof observeSql>;
const contractPool = createPool('postgres://kernel.invalid/media-moderation-contract');
afterAll(() => contractPool.end());
async function issue(id: string, scope = scopes) {
  const response = await auth.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${id}@example.test`, password, client_id: 'media-moderation-test', scope }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issued = await auth.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, cookie, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  expect(issued.status).toBe(200);
  return ((await issued.json()) as { access_token: string }).access_token;
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  authDatabase = `media_http_auth_${process.pid}`;
  const authUrl = new URL(db.url);
  authUrl.pathname = `/${authDatabase}`;
  await db.admin.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = createPool(authUrl.toString());
  const evidence = createProvisioningEvidenceVerifier({ database: authPool });
  const lifecycle = createLifecycleInternals({
    pool: db.pool,
    routeKey,
    provisioningEvidence: evidence.resolve,
    recoveryEvidence: async () => null,
  });
  const proofs = createRegistrationProofBindings({ pool: db.pool, referenceKeys: tokens });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'media-http-test',
    alg: 'ES256',
  };
  const bindings = createAuthBindings({ pool: db.pool, ...proofs });
  auth = await createAuthService({
    database: authPool,
    issuer,
    audience: 'https://api.rezics.test',
    secret: 'media-http-auth-private-test-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: {
      ...bindings,
      async authorizeProvisioning(reference) {
        const approval = await bindings.authorizeProvisioning(reference);
        const receipt = await proofs.verifyProvisioningReceipt(reference);
        const account = await readAccount(db.pool, routeOf(approval.accountId)!, approval.accountId);
        if (!receipt || !account) throw new Error('Missing committed registration');
        return {
          ...approval,
          receipt: {
            registrationId: receipt.registrationId,
            reservationId: receipt.registrationId,
            expiresAt: receipt.expiresAt,
            authnEpoch: Number(account.minimumAuthnEpoch),
          },
        };
      },
    },
  });
  await auth.internal.registerClient({ clientId: 'media-moderation-test', firstParty: true, scopes });
  async function human(handle: string) {
    const key = `media-http-${handle}`;
    const accountId = lifecycle.registrationTarget(key);
    const reservation = await lifecycle.reserveHandle({ accountId, handle, key });
    const input = { accountId, handle, key, reservationId: reservation.value.reservationId };
    const outcome = await lifecycle.createPending(input);
    const authorization = await proofs.createProvisioningReference({ input, outcome });
    if (!authorization) throw new Error('Missing native provisioning reference');
    const result = await auth.internal.provisionPassword({
      authorization,
      email: `${accountId}@example.test`,
      password,
    });
    await lifecycle.claimHandle({ ...input, key: `${key}-claim`, evidence: result.provisioningEvidence });
    await lifecycle.activate({ accountId, key: `${key}-activate`, evidence: result.provisioningEvidence });
    return accountId;
  }
  moderatorId = await human('media_moderator');
  uploaderId = await human('media_uploader');
  bearer = await issue(moderatorId, [action]);
  uploaderBearer = await issue(uploaderId, scopes);
  noScopeBearer = await issue(moderatorId, ['media:read']);
  const access = createAccess({
    actions: actionCatalogue(createKernel({ pool: db.pool, routeKey })),
    auth: {
      issuer,
      audience: 'https://api.rezics.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: (url, init) => auth.handler(new Request(url, init)),
    },
  });
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access,
    ratePeer: () => '127.0.0.1',
    writeRate: createWriteRateLimiter({
      secret: 'media-http-rate-private-secret-at-least-32-bytes',
      overrides: '{"new-account":{"write":{"maximum":1000,"seconds":60}}}',
    }),
  });
  observer = observeSql(db.pool);
}, 90000);
afterAll(async () => {
  await observer?.close();
  await authPool?.end();
  if (authDatabase) await dropTestDatabase(db.admin, authDatabase);
  await db?.close();
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
async function grant(db: Pool, mediaId: string, subject = moderatorId, selectedRoute = routeOf(mediaId)!) {
  await db.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$5)`,
    [selectedRoute, mediaId, subject, action, transactionId],
  );
}
async function facts(db: Pool, mediaId: string) {
  return (await db.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', [routeOf(mediaId), mediaId]))
    .rows[0];
}
const input = { reason: 'private rights complaint evidence' };
async function call(
  mediaId: string,
  body: unknown = input,
  key = Bun.randomUUIDv7(),
  options: {
    bearer?: string;
    anonymous?: boolean;
    idempotency?: string | null;
    path?: string;
  } = {},
) {
  const response = await app.handle(
    new Request(`http://kernel.test${options.path ?? `/v1/media/${mediaId}:takeDown`}`, {
      method: 'POST',
      headers: {
        ...(options.anonymous ? {} : { authorization: `Bearer ${options.bearer ?? bearer}` }),
        'content-type': 'application/json',
        ...(options.idempotency === null ? {} : { 'idempotency-key': options.idempotency ?? JSON.stringify(key) }),
      },
      body: JSON.stringify(body),
    }),
  );
  return { response, body: await response.json() };
}
async function target() {
  const id = await insertMedia(db.admin);
  await grant(db.admin, id);
  return id;
}
function denied(result: Awaited<ReturnType<typeof call>>, status: number) {
  expect(result.response.status).toBe(status);
  expect(result.response.headers.get('content-type')).toBe('application/problem+json');
  expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
  expect(result.body).not.toHaveProperty('securityRevision');
  expect(result.body).not.toHaveProperty('mediaId');
  expect(result.body.effect_status).toBe('not_applied');
}
async function effects() {
  return Promise.all(
    [
      'SELECT to_jsonb(row) AS value FROM content.media row ORDER BY media_id',
      "SELECT to_jsonb(row) AS value FROM core.receipt row WHERE command_kind='content.media.takedown' ORDER BY idempotency_key",
      `SELECT to_jsonb(row) AS value FROM core.outbox row WHERE type='${eventType}' ORDER BY position`,
    ].map(async (sql) => (await db.admin.query(sql)).rows),
  );
}

test('mounted once with current generated OpenAPI, action and shared rate declaration', async () => {
  const kernel = createKernel({ pool: contractPool, routeKey });
  expect(kernel.routes.filter((r) => r.method === 'POST' && r.path === '/v1/media/:id/$takeDown')).toHaveLength(1);
  const document = openApiDocument(kernel);
  const operation = document.paths['/v1/media/{id}:takeDown']?.post;
  expect(operation?.['x-action']).toBe(action);
  expect(operation?.['x-rate-limit']).toEqual({ family: 'write', units: 1 });
  expect(operation?.security).toEqual([{ bearerAuth: [] }]);
  expect(actionCatalogue(kernel).get(action)?.anonymous).toBe(false);
  const committed = await Bun.file(new URL('../../../../contracts/openapi.json', import.meta.url)).json();
  expect(committed.paths['/v1/media/{id}:takeDown']).toEqual(document.paths['/v1/media/{id}:takeDown']);
});

test('literal POST reaches native moderator command and actual shared write rate exactly once; retains appeal bytes', async () => {
  const id = await target();
  const other = await target();
  const before = await facts(db.admin, id);
  const otherBefore = await facts(db.admin, other);
  const anchor = await readPartition(db.admin, partition);
  const key = Bun.randomUUIDv7();
  const start = observer.records.length;
  const result = await call(id, input, key);
  expect(result.response.status).toBe(200);
  expect(result.body).toEqual({ securityRevision: '9007199254740994' });
  expect(await facts(db.admin, id)).toEqual({
    ...before,
    taken_down: true,
    security_revision: result.body.securityRevision,
  });
  expect(await facts(db.admin, other)).toEqual(otherBefore);
  const trace = observer.records.slice(start);
  const charges = trace.filter((r) => /INSERT INTO access.write_rate_counter/.test(r.statement));
  expect(charges).toHaveLength(1);
  expect(charges[0]!.parameters).toContain('write');
  // The real rate SQL receives admitted units, not a handler-side counter.
  expect(charges[0]!.parameters[3]).toBe(1);
  expect(trace.filter((r) => /UPDATE content.media/.test(r.statement))).toHaveLength(1);
  expect(trace.filter((r) => /^BEGIN ISOLATION LEVEL SERIALIZABLE/.test(r.statement))).toHaveLength(1);
  const receipt = (
    await db.admin.query('SELECT * FROM core.receipt WHERE partition_no=$1 AND idempotency_key=$2', [partition, key])
  ).rows;
  expect(receipt).toHaveLength(1);
  expect(receipt[0].response).toEqual({ mediaId: id, securityRevision: result.body.securityRevision });
  const events = (
    await db.admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      partition,
      anchor!.position + 1n,
    ])
  ).rows;
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe(eventType);
  expect(events[0].data).toEqual(receipt[0].response);
  expect(JSON.stringify(events)).not.toContain(input.reason);
  expect(await readPartition(db.admin, partition)).toMatchObject({ position: anchor!.position + 1n });
  expect(decodeSession(tokens, `account:${moderatorId}`, result.response.headers.get(SESSION_HEADER)!)).toEqual([
    { partition, epoch: anchor!.epoch, position: anchor!.position + 1n },
  ]);
  const variants = (
    await db.admin.query('SELECT * FROM content.media_variant WHERE route=$1 AND media_id=$2', [route, id])
  ).rows;
  expect(variants).toHaveLength(1);
  expect(variants[0].key).toBe(`m/${id}/webp-320`);
  expect(
    trace.some((r) => /content.source_fences|content.media_reference|content.post|content.thread/.test(r.statement)),
  ).toBe(false);
  const stable = await effects();
  expect((await call(id, input, key)).body).toEqual(result.body);
  expect(await effects()).toEqual(stable);
  denied(await call(id, { reason: 'different' }, key), 422);
  denied(await call(id), 403);
});

test('current uploader, anonymous, suspended, scope and revoked replay denials read no receipt and disclose nothing', async () => {
  const id = await target();
  const key = Bun.randomUUIDv7();
  expect((await call(id, input, key)).response.status).toBe(200);
  const stable = await effects();
  async function reject(options: Parameters<typeof call>[3], status: number) {
    const start = observer.records.length;
    denied(await call(id, input, key, options), status);
    expect(observer.records.slice(start).some((r) => /core.receipt|UPDATE content.media/.test(r.statement))).toBe(
      false,
    );
    expect(await effects()).toEqual(stable);
  }
  await reject({ bearer: uploaderBearer }, 403);
  await reject({ anonymous: true }, 401);
  await reject({ bearer: noScopeBearer }, 403);
  await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(moderatorId),
    moderatorId,
  ]);
  try {
    await reject({}, 401);
  } finally {
    await db.admin.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
      routeOf(moderatorId),
      moderatorId,
    ]);
  }
  await db.admin.query(
    'DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4',
    [route, id, moderatorId, action],
  );
  await reject({}, 403);
  const available = await insertMedia(db.admin);
  const before = await facts(db.admin, available);
  denied(await call(available, input, undefined, { bearer: uploaderBearer }), 403);
  expect(await facts(db.admin, available)).toEqual(before);
  denied(await call(newId(route)), 403);
  const erased = await target();
  await db.admin.query(
    'UPDATE content.media SET erased=true, security_revision=security_revision+1 WHERE route=$1 AND media_id=$2',
    [route, erased],
  );
  denied(await call(erased), 403);
});

test('strict bounded body, required idempotency key and inaccessible internal custom routes have no effects', async () => {
  const id = await target();
  const stable = await effects();
  for (const body of [
    {},
    null,
    [],
    { reason: 1 },
    { reason: '' },
    { reason: '\ud800' },
    { reason: 'x'.repeat(1025) },
    { ...input, actor: moderatorId },
    { ...input, mediaId: id },
    { ...input, securityRevision: '1' },
  ])
    denied(await call(id, body), 400);
  for (const idempotency of [null, 'unquoted', '""']) denied(await call(id, input, undefined, { idempotency }), 400);
  denied(await call(id, { reason: 'x'.repeat(20000) }), 413);
  for (const suffix of ['/$takeDown', '/%24takeDown'])
    denied(await call(id, input, undefined, { path: `/v1/media/${id}${suffix}` }), 404);
  expect(await effects()).toEqual(stable);
});

test('generated Eden custom method sends the literal colon and returns the fresh native revision', async () => {
  const id = await target();
  const client = createKernelClient('http://kernel.test', {
    headers: { authorization: `Bearer ${bearer}` },
    fetch: (async (request, init) => {
      const native = new Request(request, init);
      expect(native.method).toBe('POST');
      expect(new URL(native.url).pathname).toBe(`/v1/media/${id}:takeDown`);
      return app.handle(native);
    }) as typeof fetch,
  });
  const result = await Reflect.get(Reflect.get(client, 'media')({ id }), '$takeDown').post(input, {
    headers: { 'idempotency-key': JSON.stringify(Bun.randomUUIDv7()) },
  });
  expect(result.status).toBe(200);
  expect(result.data).toEqual({ securityRevision: '9007199254740994' });
});
test('shared checkGrowth measures actual API at three scales with constant rows/statements and no content sequential scans', async () => {
  {
    const targets = [await target()];
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
        expect(
          Number((await db.admin.query('SELECT count(*) AS n FROM content.media')).rows[0].n),
        ).toBeGreaterThanOrEqual(500);
      },
      operation: async (_db, _scale, repetition) => {
        const result = await call(targets[repetition]!);
        expect(result.response.status).toBe(200);
        expect(result.body).toEqual({ securityRevision: '9007199254740994' });
      },
    });
    expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
    expect(new Set(report.samples.map((s) => s.cost.statements)).size).toBe(1);
    expect(new Set(report.samples.map((s) => s.cost.rows)).size).toBe(1);
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
    console.info('media moderation HTTP growth evidence', JSON.stringify(report));
  }
}, 90_000);
