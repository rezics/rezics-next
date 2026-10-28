import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HttpResponse, SearchDriver } from '../../../../specs/search-driver.ts';
import { createDriverClient, type DriverClient } from './support/driver-client.ts';

// Specification for the real default composition; formatting is not runtime proof.
const question = '00000000-0000-7000-8000-000000000001';
const clients = new Set<DriverClient>();
function fixture() {
  const client = createDriverClient();
  clients.add(client);
  return client;
}
afterEach(async () => {
  const results = await Promise.allSettled([...clients].map((client) => client.close()));
  clients.clear();
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, 'Native rating fixtures failed to drain');
}, 600_000);

async function subject(driver: SearchDriver) {
  const response = await driver.request(
    'editor',
    'POST',
    '/v1/subjects',
    {
      type: 'schema:Book',
      labels: { en: 'Native rating fixture' },
      statements: {},
    },
    { 'Idempotency-Key': `"${randomUUID()}"` },
  );
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return (response.body.subject as { id: string }).id;
}
function ok(response: HttpResponse, units: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.headers).toBeInstanceOf(Headers);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('rezics-session-token')).toBeTruthy();
  expect(response.body).toEqual({ units, revision: expect.any(Number), at: expect.any(String) });
}
async function figure(driver: SearchDriver, id: string, count: number) {
  const deadline = performance.now() + 60_000;
  let response: HttpResponse;
  do {
    response = await driver.request(
      'anonymous',
      'GET',
      `/v1/subjects/${id}/ratings?question=${question}&population=${driver.globalContext}`,
    );
    if (response.status === 200) {
      const value = (response.body.figures as Record<string, unknown>[])[0]!;
      if (value.count === count) return value;
    }
    await Bun.sleep(100);
  } while (performance.now() < deadline);
  throw new Error(`Actual public aggregate did not reach ${count}: ${JSON.stringify(response!)}`);
}

test('native controls count independent real voters, replay, zero, change and true DELETE through default effects', async () => {
  const client = fixture();
  const driver = await client.init();
  const id = await subject(driver);
  const voters = await Promise.all(Array.from({ length: 5 }, (_, i) => client.nativeVoter(`reader_${i}`)));
  expect(new Set(voters.map((value) => value.accountId)).size).toBe(5);
  expect(new Set(voters.map((value) => value.voter)).size).toBe(5);
  expect(await client.nativeVoter('reader_0')).toEqual(voters[0]!);
  for (const voter of voters) expect(Object.keys(voter).sort()).toEqual(['accountId', 'voter']);
  const stats = (await client.inspect()).workerStats!;
  expect(stats.registeredModules).toEqual(stats.defaultModules);
  expect(stats.registrationCounts.rating).toBe(1);
  expect(stats.registrationCounts.semantic).toBe(1);
  expect(stats.startedServices.semantic).toBeGreaterThan(0);
  const key = randomUUID();
  const zero = await client.nativeVote(voters[0]!.voter, id, 0, { idempotencyKey: key });
  ok(zero, 0);
  const replay = await client.nativeVote(voters[0]!.voter, id, 0, { idempotencyKey: key });
  expect(replay.status).toBe(zero.status);
  expect(replay.body).toEqual(zero.body);
  expect(await figure(driver, id, 1)).toMatchObject({ count: 1, remaining: 4 });
  ok(await client.nativeVote(voters[1]!.voter, id, 20), 20);
  const two = await figure(driver, id, 2);
  expect(two).toMatchObject({ count: 2, remaining: 3 });
  expect(two).not.toHaveProperty('mean');
  expect(two).not.toHaveProperty('histogram');
  for (const voter of voters.slice(2)) ok(await client.nativeVote(voter.voter, id, 10), 10);
  const five = await figure(driver, id, 5);
  // The aggregate HTTP contract returns stored units (0..20), not display points (0..10).
  expect(five.mean).toBe(10);
  expect(five).not.toHaveProperty('remaining');
  expect(five.histogram).toEqual(Array.from({ length: 21 }, (_, i) => (i === 0 || i === 20 ? 1 : i === 10 ? 3 : 0)));
  ok(await client.nativeVote(voters[0]!.voter, id, 20), 20);
  // Count does not change on replacement; wait for the mean itself to converge.
  const deadline = performance.now() + 60_000;
  while ((await figure(driver, id, 5)).mean !== 14) {
    if (performance.now() >= deadline) throw new Error('Changed vote did not reach the actual aggregate');
    await Bun.sleep(100);
  }
  const cleared = await client.nativeVote(voters[0]!.voter, id, null);
  expect(cleared.status).toBe(204);
  expect(cleared.headers).toBeInstanceOf(Headers);
  const four = await figure(driver, id, 4);
  expect(four).toMatchObject({ count: 4, remaining: 1 });
  expect(four).not.toHaveProperty('mean');
  expect(four).not.toHaveProperty('histogram');
}, 600_000);

test('private inputs and foreign handles reject before effects; actual route errors retain body and headers', async () => {
  const client = fixture();
  const driver = await client.init();
  const id = await subject(driver);
  for (const name of ['', 'editor', '../owner', 'x'.repeat(49)])
    await expect(client.nativeVoter(name)).rejects.toThrow('Invalid native voter name');
  const voter = await client.nativeVoter('reader');
  const foreign = fixture();
  await foreign.init();
  const other = await foreign.nativeVoter('reader');
  for (const handle of ['', voter.accountId, other.voter, 'invented'])
    await expect(client.nativeVote(handle, id, 10)).rejects.toThrow('Unknown native voter');
  for (const units of [-1, 21, 0.5, NaN, Infinity, undefined, '10'])
    await expect(client.nativeVote(voter.voter, id, units as number)).rejects.toThrow('Invalid native vote');
  await expect(client.nativeVote(voter.voter, '../target', 10)).rejects.toThrow('Invalid native vote');
  for (const options of [{ idempotencyKey: '' }, { idempotencyKey: 'x'.repeat(256) }, { owner: voter.accountId }])
    await expect(client.nativeVote(voter.voter, id, 10, options as { idempotencyKey: string })).rejects.toThrow(
      'Invalid native vote',
    );
  const key = randomUUID();
  ok(await client.nativeVote(voter.voter, id, 10, { idempotencyKey: key }), 10);
  const conflict = await client.nativeVote(voter.voter, id, 11, { idempotencyKey: key });
  expect(conflict.status).toBe(422);
  expect(conflict.headers.get('content-type')).toContain('application/problem+json');
  expect(conflict.body).toMatchObject({ status: 422, code: 'idempotency_conflict', request_id: expect.any(String) });
  const missing = await client.nativeVote(voter.voter, Bun.randomUUIDv7(), 10);
  expect(missing.status).toBe(404);
  expect(missing.headers.get('content-type')).toContain('application/problem+json');
  expect(missing.body).toMatchObject({ status: 404, code: 'not_found', request_id: expect.any(String) });
  expect(await figure(driver, id, 1)).toMatchObject({ count: 1, remaining: 4 });
}, 600_000);

test('close seals new controls and drains admitted provisioning and voting before real process exit', async () => {
  const client = fixture();
  const driver = await client.init();
  const id = await subject(driver);
  const voter = await client.nativeVoter('existing');
  const provisioning = client.nativeVoter('admitted');
  const voting = client.nativeVote(voter.voter, id, 20);
  const closing = client.close();
  expect(client.close()).toBe(closing);
  await expect(client.nativeVoter('late')).rejects.toThrow('closing');
  await expect(client.nativeVote(voter.voter, id, 0)).rejects.toThrow('closing');
  expect((await provisioning).accountId).not.toBe(voter.accountId);
  ok(await voting, 20);
  await closing;
  const ledger = client.ledger();
  expect(ledger.exited).toBe(true);
  expect(ledger.exit).toEqual({ code: 0, signal: null });
  expect(ledger.cleanup!.workerStats!.stopped).toBe(true);
  expect(ledger.cleanup!.phases).toEqual(['worker', 'auth', 'semantic', 'indices', 'proxy']);
}, 600_000);

test('close aggregates the original admitted control failure and still awaits owned process exit', async () => {
  const client = fixture();
  await client.init();
  const invalid = client.nativeVote('unknown', Bun.randomUUIDv7(), 10);
  const closing = client.close();
  const [operation, cleanup] = await Promise.allSettled([invalid, closing]);
  expect(operation.status).toBe('rejected');
  expect(cleanup.status).toBe('rejected');
  if (operation.status !== 'rejected' || cleanup.status !== 'rejected') throw new Error('Expected original failures');
  expect(operation.reason.message).toContain('Unknown native voter');
  expect(cleanup.reason).toBeInstanceOf(AggregateError);
  expect((cleanup.reason as AggregateError).errors).toContain(operation.reason);
  expect(client.ledger().exited).toBe(true);
  expect(client.ledger().exit).toEqual({ code: 1, signal: null });
  clients.delete(client); // The expected rejected close is already observed in full.
}, 600_000);
