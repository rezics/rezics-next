import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from 'bun:test';
import { decodeJwt } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import * as catalogue from '../../src/access/gates/catalogue.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { AuthenticationError } from '../../src/request/access.ts';
import { createPersonas } from '../support/personas.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { nativeFixture } from './native-account-bindings-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
const group = 'invalid_bearer_fixture';
const gatedPath = '/v1/invalid-bearer/gated';
const publicPath = '/v1/invalid-bearer/public';
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let personas: Awaited<ReturnType<typeof createPersonas>>;
let handlerCalls = 0;
let domainReads = 0;

function get(path: string, bearer?: string) {
  return kernel.handle(
    new Request(`http://kernel.test${path}`, {
      ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
    }),
  );
}

async function exposure(open: boolean) {
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/platform/exposure/${group}:${open ? 'open' : 'close'}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${personas.staff.bearer}`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'invalid-bearer-native-rate-secret-32-bytes' }),
  });
  for (const [path, exposure, operation] of [
    [gatedPath, `gate:${group}`, 'gated_read'],
    [publicPath, 'public', 'public_read'],
  ] as const) {
    const detail = {
      operationId: `fixture.${operation}`,
      'x-action': 'fixture:read',
      'x-exposure': exposure,
      security: [{ bearerAuth: [] }],
    };
    kernel.get(path, { detail }, async ({ actor }) => {
      if (actor.kind === 'anonymous') throw new AuthenticationError(401, 'Bearer');
      handlerCalls++;
      await pool.query('SELECT 1');
      domainReads++;
      return { value: 'fixture' };
    });
  }
  personas = await createPersonas(kernel, { version: 1, pool, auth });
}, 120_000);

afterAll(async () => {
  setSystemTime();
  await auth?.close();
  await pool.end();
}, 60_000);

for (const kind of ['malformed', 'expired', 'revoked', 'pre-suspension'] as const) {
  test(`${kind} bearer has the same invalid_token response before any gate or domain lookup`, async () => {
    const bearer =
      kind === 'malformed'
        ? 'not-a-valid-bearer'
        : kind === 'revoked'
          ? personas.revoked.bearer
          : kind === 'pre-suspension'
            ? personas.suspended.bearer
            : personas.alice.bearer;
    if (kind === 'expired') {
      // This is the actual Auth-issued token, first proven live, then observed past its signed expiry.
      expect((await get(publicPath, bearer)).status).toBe(200);
    }
    for (const open of [false, true]) {
      await exposure(open);
      const before = { handlerCalls, domainReads };
      const read = catalogue.readExposure;
      const lookup = spyOn(catalogue, 'readExposure').mockImplementation(read);
      try {
        if (kind === 'expired') setSystemTime(new Date(decodeJwt(bearer).exp! * 1000 + 1000));
        const problems: Record<string, unknown>[] = [];
        for (const path of [gatedPath, publicPath]) {
          const response = await get(path, bearer);
          expect(response.status).toBe(401);
          expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
          const problem = (await response.json()) as Record<string, unknown>;
          expect(problem).toMatchObject({ status: 401, code: 'invalid_credentials' });
          const { request_id: _requestId, ...stable } = problem;
          problems.push(stable);
        }
        expect(problems[0]).toEqual(problems[1]);
        expect(lookup).not.toHaveBeenCalled();
        expect(handlerCalls).toBe(before.handlerCalls);
        expect(domainReads).toBe(before.domainReads);
      } finally {
        setSystemTime();
        lookup.mockRestore();
      }
    }
  });
}

test('missing credentials retain authentication_required and a bare Bearer challenge on the open gate', async () => {
  await exposure(true);
  const before = { handlerCalls, domainReads };
  const response = await get(gatedPath);
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer');
  expect(await response.json()).toMatchObject({ status: 401, code: 'authentication_required' });
  expect(handlerCalls).toBe(before.handlerCalls);
  expect(domainReads).toBe(before.domainReads);
});
