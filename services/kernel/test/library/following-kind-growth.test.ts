import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import {
  assertGrowth,
  measure,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(93);
const scopes = ['follow:create', 'follow:list', 'subject:read'];
const fixtureId = (prefix: string, route: number, ordinal: number) =>
  `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
let database: GrowthDatabase | undefined;
let request: (method: string, path: string) => Promise<Response> = async () => {
  throw new Error('Following growth request is not initialized');
};
let accountId = '';
let route = 0;

afterAll(async () => {
  if (database) {
    await database.admin.query('DELETE FROM library.follow WHERE route = $1 AND account_id = $2', [route, accountId]);
    await database.close();
  }
});

test('FULL kind pages keep a fixed whole-request cost as matching and nonmatching follows grow', async () => {
  database = await openGrowthDatabase();
  database.pool.options.max = 1;
  await bootstrapRelease(database.pool, bundledRelease);
  accountId = newId(0x2200);
  route = routeOf(accountId)!;
  const actor: AccountActor = {
    kind: 'account',
    accountId,
    clientId: 'following-kind-growth',
    scopes,
    requestedBy: null,
    authnEpoch: 1,
  };
  await database.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
       VALUES ($1, $2, 'actor', 'active', $2)`,
    [route, accountId],
  );
  await database.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       VALUES ('personal_library', tstzrange('2020-01-01T00:00:00Z', NULL, '[)'), $1)`,
    [randomUUID()],
  );

  const signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'following-kind-growth', alg: 'ES256' };
  const app = createKernel({
    pool: database.pool,
    writeRate: createWriteRateLimiter({ secret: 'following-kind-growth-write-secret-32b' }),
    ratePeer: () => '127.0.0.1',
    routeKey,
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) },
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.example.test',
          audience: 'https://api.rezics.test',
          jwksUrl: 'https://auth.example.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
  });
  const token = await new SignJWT({
    client_id: actor.clientId,
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'following-kind-growth', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(accountId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  request = (method, path) =>
    app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': 'following-kind-growth',
          'idempotency-key': JSON.stringify(randomUUID()),
        },
      }),
    );

  const subjectKey = randomUUID();
  const subject = await createSubject(database.pool, {
    actor,
    target: subjectTarget(routeKey, accountId, subjectKey),
    idempotencyKey: subjectKey,
    digest: createHash('sha256').update(subjectKey).digest(),
    item: { type: 'schema:Book', labels: { en: subjectKey } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  expect((await request('PUT', `/v1/follows/${subject.subject.id}`)).status).toBe(200);
  await database.admin.query(
    `INSERT INTO library.follow
         (route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id)
       SELECT $1, $2,
              ($3::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
              'subject', 'following', 'explicit', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00Z',
              ($3::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid
       FROM generate_series(1, 21) AS n`,
    [route, accountId, '40000000'],
  );

  const runSeries = async (kind: 'subject' | 'collection', prefix: string) => {
    let previous = 0;
    const samples: GrowthSample[] = [];
    for (const scale of [64, 512, 4096]) {
      await database!.admin.query(
        `INSERT INTO library.follow
             (route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id)
           SELECT $1, $2,
                  ($5::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
                  $4, 'following', 'explicit', '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z',
                  ($5::text || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid
           FROM generate_series($3::int + 1, $6::int) AS n`,
        [route, accountId, previous, kind, prefix, scale],
      );
      await database!.admin.query('ANALYZE library.follow');
      const measured = await measure(database!, async () => {
        const response = await request('GET', '/v1/follows?targetType=subject&limit=20&view=FULL');
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.follows.map((follow: { targetId: string }) => follow.targetId)).toEqual(
          Array.from({ length: 20 }, (_, index) => fixtureId('40000000', route, index + 1)),
        );
        expect(body.next).toEqual(expect.any(String));
        return body;
      });
      samples.push({ scale, cost: measured.cost });
      previous = scale;
    }
    assertGrowth(samples, { rows: 'constant', blocks: 'logarithmic', statements: 'constant' });
    await database!.admin.query(
      'DELETE FROM library.follow WHERE route = $1 AND account_id = $2 AND target_id::text LIKE $3',
      [route, accountId, `${prefix}-%`],
    );
  };

  await runSeries('subject', '50000000');
  await runSeries('collection', '60000000');
}, 300_000);
