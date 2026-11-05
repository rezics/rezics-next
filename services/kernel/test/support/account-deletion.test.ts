import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { createPool } from '../../src/database/pool.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { createPersonas, type Persona } from './personas.ts';
import { AccountDeletionError, deletePersona, drainEffects, EffectsDrainDeadlineError } from './account-deletion.ts';
import { testKernel, type TestKernel } from './test-kernel.ts';

const pool = createPool(process.env.DATABASE_URL!);
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let personas: Awaited<ReturnType<typeof createPersonas>>;

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'account-deletion-write-rate-secret-32-bytes' }),
  });
  personas = await createPersonas(kernel, { version: 1, pool, auth });
}, 360000);

afterAll(async () => {
  try {
    await auth?.close();
  } finally {
    await pool.end();
  }
});

test('a human deletion uses Auth approval and execution, records version 1 and rejects the old bearer', async () => {
  const deleted = await deletePersona({ version: 1, pool, auth }, personas.alice);
  expect(deleted).toEqual({ accountId: personas.alice.accountId, at: expect.any(String) });
  const status = await readErasureStatus(pool, personas.alice.accountId);
  expect(status).toEqual({
    version: 1,
    at: deleted.at,
    state: 'pending',
    participants: {
      access: { outcome: 'pending', retained: [] },
      auth: { outcome: 'pending', retained: [] },
      library: { outcome: 'pending', retained: [] },
      commerce: { outcome: 'pending', retained: [] },
      content: { outcome: 'pending', retained: [] },
      community: { outcome: 'pending', retained: [] },
      semantic: { outcome: 'pending', retained: [] },
      search: { outcome: 'pending', retained: [] },
      imports: { outcome: 'pending', retained: [] },
      'shared-history': { outcome: 'pending', retained: [] },
      delivery: { outcome: 'pending', retained: [] },
    },
    outstanding: { lateItems: false, effectsFrontier: true },
    completedAt: null,
  });
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${personas.alice.accountId}:suspend`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${personas.alice.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
      },
      body: JSON.stringify({ reason: 'deleted account bearer check' }),
    }),
  );
  expect(response.status).toBe(401);
});

test('effects drain waits for the account partition head and reports its deadline by name', async () => {
  await deletePersona({ version: 1, pool, auth }, personas.bob);
  const positions = [
    { position: '4', checkpoint: '3' },
    { position: '4', checkpoint: '4' },
  ];
  let reads = 0;
  const advancingPool = {
    query: async () => {
      reads += 1;
      return { rows: [positions.shift()!] };
    },
  } as unknown as typeof pool;
  await drainEffects(advancingPool, partitionOf(routeOf(personas.bob.accountId)!));
  expect(reads).toBe(2);
  const stalledPool = {
    query: async () => ({ rows: [{ position: '1', checkpoint: '0' }] }),
  } as unknown as typeof pool;
  await expect(drainEffects(stalledPool, 987, { deadlineMs: 1 })).rejects.toBeInstanceOf(EffectsDrainDeadlineError);
  await expect(drainEffects(stalledPool, 987, { deadlineMs: 1 })).rejects.toMatchObject({
    name: 'EffectsDrainDeadlineError',
    partition: 987,
    deadlineMs: 1,
  });
});

test('repeating deletion is refused and does not add another erasure row', async () => {
  const subject = personas.delegated as Persona;
  await deletePersona({ version: 1, pool, auth }, subject);
  const before = await pool.query('SELECT count(*)::integer AS count FROM access.erasure WHERE account_id=$1', [
    subject.accountId,
  ]);
  await expect(deletePersona({ version: 1, pool, auth }, subject)).rejects.toBeInstanceOf(AccountDeletionError);
  const after = await pool.query('SELECT count(*)::integer AS count FROM access.erasure WHERE account_id=$1', [
    subject.accountId,
  ]);
  expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  expect(after.rows[0]?.count).toBe(1);
});

test('an operated automated account is deleted through Auth by its operator human', async () => {
  const operator = personas.operator as Persona;
  const deleted = await deletePersona({ version: 1, pool, auth }, personas.software, { actingHuman: operator });
  expect(deleted.accountId).toBe(personas.software.accountId);
  expect(await readErasureStatus(pool, personas.software.accountId)).toMatchObject({ version: 1, at: deleted.at });
});
