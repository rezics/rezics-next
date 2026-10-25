import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let bearer: string;
const actorId = newId(0x1234);
const recipientId = newId(0x2345);
const issuer = 'https://grant-growth.auth.test';
const audience = 'https://grant-growth.api.test';
const transaction = Bun.randomUUIDv7();
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const pair = await generateKeyPair('ES256');
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'grant-growth', alg: 'ES256' }] };
  // Component issuer for cost measurement only. Functional product proof uses
  // ordinary native registration and Auth issuance in grant-routes.test.ts.
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(81),
    access: (config) => {
      return createAccess({
        ...config,
        auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json(jwks) },
      });
    },
    writeRate: createWriteRateLimiter({
      secret: 'grant-growth-private-write-rate-secret-32bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
    }),
  });
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES (4660,$1,'actor','active',$3),(9029,$2,'actor','active',$3)`,
    [actorId, recipientId, transaction],
  );
  await bootstrapGovernance(db.pool, actorId);
  // The token requests only actual mounted actions; its signature confers no grant.
  const { actionCatalogue } = await import('../../src/http/request.ts');
  const at = Math.floor(Date.now() / 1000);
  bearer = await new SignJWT({
    iss: issuer,
    aud: audience,
    sub: actorId,
    client_id: 'growth',
    scope: [...actionCatalogue(app).keys()].join(' '),
    authn_epoch: 1,
    iat: at,
    exp: at + 300,
    auth_time: at,
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'grant-growth' })
    .sign(pair.privateKey);
});
afterAll(async () => {
  await db?.close();
});

async function call(path: string, body: unknown, key = Bun.randomUUIDv7()) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(path.endsWith('Grants') || path === '/v1/grants' ? 201 : 200);
  const value = await response.json();
  expect(Object.keys(value)).toEqual(['grant']);
  return value;
}

test('actual HTTP grant routes keep full native SQL cost bounded at 1/8/64 x 500 grants and histories', async () => {
  const direct = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: recipientId },
    actions: ['context:create', 'subject:create'],
    valid: '(,)',
  };
  const exercise = async () => {
    const key = Bun.randomUUIDv7();
    const first = await call('/v1/grants', direct, key);
    expect(await call('/v1/grants', direct, key)).toEqual(first);
    const valid = '[2030-01-01,2031-01-01)';
    await call('/v1/grants:change', { ...direct, valid, previous: { actions: direct.actions, valid: direct.valid } });
    await call('/v1/grants:revoke', { ...direct, valid });
    const role = { resource: PLATFORM_RESOURCE, subject: direct.subject, role: 'platform.governance', valid: '(,)' };
    await call('/v1/roleGrants', role);
    await call('/v1/roleGrants:change', { ...role, valid, previous: { role: role.role, valid: role.valid } });
    await call('/v1/roleGrants:revoke', { ...role, valid });
  };
  const report = await checkGrowth(db, {
    name: 'mounted native grant routes',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const ids = Array.from({ length: (scale - previous) * 500 }, () => newId(0));
      // Unrelated recipients/resources and expired history for the exact actor,
      // protected resource and action. These rows establish no measured authority.
      await database.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
        SELECT 0,$1::uuid,id,'context:create','(,)'::tstzrange,$3::uuid FROM unnest($2::uuid[]) id
        UNION ALL SELECT 0,id,$4::uuid,'context:create','(,)'::tstzrange,$3::uuid FROM unnest($2::uuid[]) id
        UNION ALL SELECT 0,$1::uuid,$4::uuid,'context:create',tstzrange('1990-01-01'::timestamptz + (n+$5)*interval '1 second', '1990-01-01'::timestamptz + (n+$5+1)*interval '1 second','[)'),$3::uuid
        FROM unnest($2::uuid[]) WITH ORDINALITY a(id,n)`,
        [PLATFORM_RESOURCE.id, ids, transaction, actorId, previous * 500],
      );
      await database.admin.query(
        `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
        SELECT 0,$1::uuid,id,'platform.governance','(,)'::tstzrange,$3::uuid FROM unnest($2::uuid[]) id
        UNION ALL SELECT 0,$1::uuid,$4::uuid,'content.board.owner',tstzrange('1990-01-01'::timestamptz + (n+$5)*interval '1 second', '1990-01-01'::timestamptz + (n+$5+1)*interval '1 second','[)'),$3::uuid
        FROM unnest($2::uuid[]) WITH ORDINALITY a(id,n)`,
        [PLATFORM_RESOURCE.id, ids, transaction, actorId, previous * 500],
      );
      await database.admin.query(
        `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
        SELECT 0,'account',$1,'access.grant.create','0:'||id::text,$3,1,1,$4,'{}' FROM unnest($2::uuid[]) id`,
        [actorId, ids, Buffer.alloc(32), transaction],
      );
      for (const table of ['access.resource_grant', 'access.resource_role_grant', 'core.receipt'])
        await database.admin.query(`VACUUM (ANALYZE) ${table}`);
    },
    operation: exercise,
  });
  const observed = await capture(db, exercise);
  for (const fragment of [
    'INSERT INTO access.write_rate_counter',
    'INSERT INTO access.resource_grant',
    'access.resource_role_grant',
    'core.receipt',
    'core.outbox',
  ])
    expect(observed.capture.statements.some((sql) => sql.includes(fragment))).toBe(true);
  expect(observed.capture.plans.length).toBeGreaterThan(0);
  for (const { cost } of report.samples) {
    expect(cost.statements).toBeGreaterThan(7);
    expect(cost.rows).toBeGreaterThan(0);
    expect(cost.blocks).toBeGreaterThan(0);
  }
  console.info(report.name, report.samples);
}, 60000);
