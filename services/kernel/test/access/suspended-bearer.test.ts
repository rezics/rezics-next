import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import { routeOf } from '../../src/route/route.ts';
import { nativeFixture } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let bearer: string;
let app: ReturnType<typeof createApp>;
let handlerCalls = 0;

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const person = await auth.person(`defensive_${crypto.randomUUID().replaceAll('-', '')}`);
  bearer = person.bearer;
  // Deliberately construct the defensive state: real verified bearer, suspended but unfenced.
  // Native suspension advances the epoch, so it cannot reach this branch (covered separately).
  await pool.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(person.accountId),
    person.accountId,
  ]);
  app = createApp({ pool, access: auth.access });
  for (const [path, action, exposure] of [
    ['/zone', 'zone:read', 'public'],
    ['/account', 'account:manage', 'public'],
    ['/gated', 'account:manage', 'gate:defensive_suspension'],
  ] as const) {
    const detail = {
      operationId: `fixture.${path.slice(1)}`,
      'x-action': action,
      'x-exposure': exposure,
      security: [{ bearerAuth: [] }],
    };
    app.get(path, { detail }, () => {
      handlerCalls++;
      return { value: 'unreachable' };
    });
  }
}, 120_000);

afterAll(async () => {
  await auth?.close();
  await pool.end();
}, 60_000);

test('only the Zone verified-suspended branch retains its defensive 403 mapping', async () => {
  for (const path of ['/zone', '/account', '/gated']) {
    const response = await app.handle(
      new Request(`http://kernel.test${path}`, { headers: { authorization: `Bearer ${bearer}` } }),
    );
    const zone = path === '/zone';
    expect(response.status).toBe(zone ? 403 : 401);
    expect(await response.json()).toMatchObject({
      status: zone ? 403 : 401,
      code: zone ? 'forbidden' : 'invalid_credentials',
    });
    expect(response.headers.get('www-authenticate')).toBe(zone ? null : 'Bearer error="invalid_token"');
  }
  expect(handlerCalls).toBe(0);
});
