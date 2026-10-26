import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { accountToken, admittedAccess } from '../support/admitted-access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { productionActions } from '../support/production-actions.ts';

let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
let bearer: string;
const accountId = newId(0x4312);

beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(accountId), accountId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$2,'media:create','(,)',$2)`,
    [routeOf(accountId), accountId],
  );
  const access = admittedAccess({ actions: productionActions() });
  kernel = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32),
    access,
    writeRate: createWriteRateLimiter({ secret: 'avatar-media-test-only-secret-at-least-32-bytes', overrides: '{}' }),
  });
  bearer = await accountToken({
    accountId,
    clientId: 'rezics-website',
    scopes: ['media:create', 'media:read_reservation'],
  });
});

afterAll(() => db?.close());

test('an account reserves an avatar through the media route and receives its reservation', async () => {
  const response = await kernel.handle(
    new Request('https://kernel.test/v1/media', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({ containerId: accountId, purpose: 'avatar', mediaType: 'image/png', byteCount: 256 }),
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { media: { id: string; containerId: string; uploaderId: string } };
  expect(body.media).toMatchObject({ containerId: accountId, uploaderId: accountId });
  expect(routeOf(body.media.id)).toBe(routeOf(accountId));
  expect(response.headers.get('location')).toBe(`/v1/media/${body.media.id}`);
});
