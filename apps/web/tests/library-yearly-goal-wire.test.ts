import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createYearlyGoalVisit, type YearlyGoalSender } from '../src/library/yearly-goal-current';
import { readYearlyGoal, writeYearlyGoal } from '../src/library/yearly-goal-native';
import type { YearlyGoalCommand } from '../src/library/yearly-goal-page';
import type { YearlyGoalDispatch } from '../src/library/yearly-goal-server';
import { nativeYearlyGoalSnapshot } from './yearly-goal.native-fixture';

const authorization = 'Bearer original-owner';
const command: YearlyGoalCommand = Object.freeze({
  year: 2026,
  metric: 'completed_consumption_occurrences',
  target: 24,
  expectedRevision: '9007199254740993',
  idempotencyKey: 'original-request',
});
function native(respond: (request: Request) => Response | Promise<Response>) {
  return createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => respond(new Request(input, init))) as typeof fetch,
  });
}
const signal = () => new AbortController().signal;

// Contract-shaped native responses exercise the installed generated receiver, rather than a local route declaration.
test('GET binds exact year, original owner bearer, no-store and abort; summary failure leaves target readable', async () => {
  const abort = new AbortController();
  const snapshot = nativeYearlyGoalSnapshot(2026, { state: 'set', target: 24, revision: '3' });
  const client = native((request) => {
    expect(request.method).toBe('GET');
    expect(new URL(request.url).pathname).toBe('/v1/libraryYearlyCompletionGoal');
    expect(new URL(request.url).search).toBe('?year=2026');
    expect(request.headers.get('authorization')).toBe(authorization);
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
    abort.abort();
    expect(request.signal.aborted).toBe(true);
    return Response.json(snapshot);
  });
  expect(await readYearlyGoal(client, authorization, 2026, abort.signal)).toEqual({ state: 'retired' });
  expect(
    await readYearlyGoal(
      native(() => Response.json(snapshot)),
      authorization,
      2026,
      signal(),
    ),
  ).toEqual({ state: 'ready', value: snapshot });
  const unavailable = nativeYearlyGoalSnapshot(2026, snapshot.target, 'unavailable');
  expect(
    await readYearlyGoal(
      native(() => Response.json(unavailable)),
      authorization,
      2026,
      signal(),
    ),
  ).toEqual({
    state: 'ready',
    value: unavailable,
  });
  for (const value of [
    { ...snapshot, year: 2027 },
    { ...snapshot, metric: 'distinct_books' },
    {
      ...snapshot,
      progress: {
        state: 'available',
        summary: { ...(snapshot.progress.state === 'available' ? snapshot.progress.summary : {}), year: 2027 },
      },
    },
  ])
    expect(
      await readYearlyGoal(
        native(() => Response.json(value)),
        authorization,
        2026,
        signal(),
      ),
    ).toEqual({ state: 'unavailable' });
});

test('PUT set, clear and replay preserve native body, revision, idempotency header and credential', async () => {
  for (const target of [24, null]) {
    const original = { ...command, target };
    const bodies: string[] = [];
    const client = native(async (request) => {
      expect(request.method).toBe('PUT');
      expect(new URL(request.url).pathname).toBe('/v1/libraryYearlyCompletionGoal');
      expect(request.headers.get('authorization')).toBe(authorization);
      expect(request.headers.get('idempotency-key')).toBe(command.idempotencyKey);
      expect(request.cache).toBe('no-store');
      expect(request.redirect).toBe('manual');
      bodies.push(await request.text());
      expect(JSON.parse(bodies.at(-1)!)).toEqual({
        year: 2026,
        metric: command.metric,
        target,
        expectedRevision: command.expectedRevision,
      });
      return Response.json({ year: 2026, metric: command.metric, target, revision: '9007199254740994' });
    });
    expect(await writeYearlyGoal(client, authorization, original, signal())).toEqual({ state: 'applied' });
    expect(await writeYearlyGoal(client, authorization, original, signal())).toEqual({ state: 'applied' });
    expect(bodies[0]).toBe(bodies[1]);
  }
});

test('native refusal, stale review, erased receipt, key conflict and uncertainty keep their meanings', async () => {
  for (const [status, code, state] of [
    [401, 'invalid_credentials', 'retired'],
    [403, 'forbidden', 'denied'],
    [409, 'conflict', 'stale'],
    [422, 'idempotency_conflict', 'key-conflict'],
    [400, 'invalid_request', 'invalid'],
    [410, 'command_result_erased', 'erased'],
    [503, 'dependency_unavailable', 'unavailable'],
  ] as const) {
    const client = native(() =>
      Response.json({ code, effect_status: status === 410 ? 'applied' : 'not_applied' }, { status }),
    );
    expect(await writeYearlyGoal(client, authorization, command, signal())).toEqual({ state });
  }
  for (const response of [
    Response.json({ year: 2027, metric: command.metric, target: 24, revision: '4' }),
    Response.json({ year: 2026, metric: command.metric, target: null, revision: '4' }),
    Response.json({ code: 'internal_error' }, { status: 500 }),
  ])
    expect(
      await writeYearlyGoal(
        native(() => response),
        authorization,
        command,
        signal(),
      ),
    ).toEqual({ state: 'uncertain' });
  const rejected = native(() => {
    throw new TypeError('Connection lost');
  });
  expect(await readYearlyGoal(rejected, authorization, 2026, signal())).toEqual({ state: 'unavailable' });
  expect(await writeYearlyGoal(rejected, authorization, command, signal())).toEqual({ state: 'uncertain' });
});

test('uncertain retry retains immutable original command, dispatch credential and sender; retirement aborts the visit', async () => {
  const calls: YearlyGoalDispatch[] = [];
  let captures = 0;
  let current = true;
  const sender: YearlyGoalSender = {
    prepare: async () => {
      captures += 1;
      return { state: 'ready', credential: 'sealed-original-bearer' };
    },
    write: async (call) => {
      calls.push(call);
      return { state: calls.length === 1 ? 'uncertain' : 'applied' };
    },
  };
  const visit = createYearlyGoalVisit({
    year: 2026,
    viewer: 'owner',
    csrfToken: 'csrf-original',
    current: () => current,
    sender,
    read: async () => ({ state: 'ready', value: nativeYearlyGoalSnapshot(2026) }),
  });
  expect(await visit.api.write(command)).toEqual({ state: 'uncertain' });
  sender.write = async () => {
    throw new Error('replacement sender used');
  };
  expect(await visit.api.read(2026)).toMatchObject({ state: 'ready' });
  expect(await visit.api.write(command)).toEqual({ state: 'applied' });
  expect(captures).toBe(1);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[1]).toMatchObject({
    expectedReader: 'owner',
    expectedCredential: 'csrf-original',
    credential: 'sealed-original-bearer',
  });
  expect(Object.isFrozen(calls[0]!.command)).toBe(true);
  current = false;
  expect(await visit.api.write(command)).toEqual({ state: 'retired' });
  current = true;
  expect(await visit.api.read(2026)).toEqual({ state: 'retired' });
  expect(calls).toHaveLength(2);

  let requestSignal: AbortSignal | undefined;
  let complete!: () => void;
  const pending = createYearlyGoalVisit({
    year: 2026,
    viewer: 'owner',
    csrfToken: null,
    current: () => true,
    sender,
    read: (_input, received) => {
      requestSignal = received;
      return new Promise((resolve) => {
        complete = () => resolve({ state: 'ready', value: nativeYearlyGoalSnapshot(2026) });
      });
    },
  });
  const reading = pending.api.read(2026);
  pending.retire();
  expect(requestSignal?.aborted).toBe(true);
  complete();
  expect(await reading).toEqual({ state: 'retired' });
});
