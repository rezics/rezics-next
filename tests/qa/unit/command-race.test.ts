import { expect, test } from 'bun:test';
import { assertCommandRace } from '../support/command-race.ts';

const response = (status: number, body: unknown = {}) => Response.json(body, { status });
const pending = (overrides: object = {}) =>
  response(202, {
    operationId: 'operation',
    status: 'reconciling',
    phase: 'work-edit',
    result: null,
    retry: { allowed: true, afterMs: 7 },
    ...overrides,
  });

test('command race accepts direct conflicts and preserves response bodies', async () => {
  const responses = [response(201, { revision: 'winner' }), response(409, { code: 'stale_head' })];
  const settled = await assertCommandRace(responses, 201, async () => {
    throw new Error('unexpected retry');
  });
  expect(settled).toEqual(responses);
  expect(await settled[0]!.json()).toEqual({ revision: 'winner' });
  expect(await settled[1]!.json()).toEqual({ code: 'stale_head' });
});

test('command race waits after each pending answer and resends only the loser', async () => {
  const steps: string[] = [];
  const retries = [pending({ retry: { allowed: true, afterMs: 11 } }), response(409)];
  const settled = await assertCommandRace(
    [pending(), response(200)],
    200,
    async (index) => {
      steps.push(`send:${index}`);
      return retries.shift()!;
    },
    {
      sleep: async (delay) => {
        steps.push(`wait:${delay}`);
      },
      phase: 'work-edit',
    },
  );
  expect(steps).toEqual(['wait:7', 'send:0', 'wait:11', 'send:0']);
  expect(settled.map((item) => item.status)).toEqual([409, 200]);
});

test('command race supports parsed responses and several losing contenders', async () => {
  const settled = await assertCommandRace(
    [
      { status: 200, body: {} },
      { status: 202, body: await pending().json() },
      { status: 409, body: {} },
    ],
    200,
    async (index) => ({ status: 409, body: { index } }),
    { sleep: async () => {} },
  );
  expect(settled.map((item) => item.status)).toEqual([200, 409, 409]);
});

test('command race rejects absent, duplicate and unexpected successes with evidence', async () => {
  for (const statuses of [[409, 409], [200, 200], [200, 201], [200, 503], [200]]) {
    await expect(
      assertCommandRace(
        statuses.map((status) => response(status, { marker: 'evidence' })),
        200,
        async () => response(409),
      ),
    ).rejects.toThrow('responses=');
  }
  await expect(
    assertCommandRace([response(200), pending()], 200, async () => response(200), {
      sleep: async () => {},
    }),
  ).rejects.toThrow('settled to 200');
});

test('command race validates reconciling metadata and stable operation identity', async () => {
  for (const invalid of [
    { status: 'pending' },
    { operationId: '' },
    { phase: '' },
    { result: {} },
    { retry: { allowed: false, afterMs: 0 } },
    { retry: { allowed: true, afterMs: -1 } },
    { retry: { allowed: true, afterMs: '7' } },
    { retry: { allowed: true, afterMs: null } },
  ]) {
    await expect(
      assertCommandRace([response(200), pending(invalid)], 200, async () => response(409)),
    ).rejects.toThrow('invalid reconciling answer');
  }
  await expect(
    assertCommandRace(
      [response(200), pending()],
      200,
      async () => pending({ operationId: 'another' }),
      { sleep: async () => {} },
    ),
  ).rejects.toThrow('changed operation identity');
  await expect(
    assertCommandRace([response(200), pending()], 200, async () => response(409), {
      phase: 'another',
    }),
  ).rejects.toThrow('invalid reconciling answer');
});

test('command race bounds attempts, server delays and hanging resends', async () => {
  let attempts = 0;
  await expect(
    assertCommandRace(
      [response(200), pending()],
      200,
      async () => {
        attempts++;
        return pending();
      },
      { maxAttempts: 2, sleep: async () => {} },
    ),
  ).rejects.toThrow('within 2 retries');
  expect(attempts).toBe(2);
  await expect(
    assertCommandRace([response(200), pending()], 200, async () => response(409), { timeoutMs: 1 }),
  ).rejects.toThrow('did not settle');
  await expect(
    assertCommandRace(
      [response(200), pending({ retry: { allowed: true, afterMs: 0 } })],
      200,
      () => new Promise<Response>(() => {}),
      { timeoutMs: 20 },
    ),
  ).rejects.toThrow('resend timed out');
});
