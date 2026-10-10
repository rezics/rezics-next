import { expect, test } from 'bun:test';
import {
  assertHiddenIdEquality,
  type HiddenIdCounters,
} from '../../../tests/qa/support/hidden-id-equality.ts';

const zero = (): HiddenIdCounters => ({
  graphCalls: 0,
  sqlStatements: 0,
  bytes: 0,
  mediaGenerations: 0,
  rateLimitCharges: 0,
});

function scripted(steps: HiddenIdCounters[]) {
  let index = 0;
  return () => steps[index++] ?? steps.at(-1)!;
}

function call(bodies: Record<string, { status: number; body: string }>) {
  return (id: string) => {
    const found = bodies[id]!;
    return Promise.resolve(new Response(found.body, { status: found.status }));
  };
}

const operation = 'GET /v1/resources/{resource}';

test('equal hidden and absent answers pass, including a request id', async () => {
  const counters = scripted([
    zero(),
    { ...zero(), graphCalls: 2, sqlStatements: 3, bytes: 40, rateLimitCharges: 1 },
    { ...zero(), graphCalls: 2, sqlStatements: 3, bytes: 40, rateLimitCharges: 1 },
    { ...zero(), graphCalls: 4, sqlStatements: 6, bytes: 80, rateLimitCharges: 2 },
  ]);
  await assertHiddenIdEquality({
    operation,
    hiddenId: 'hidden',
    absentId: 'absent',
    readCounters: counters,
    call: call({
      hidden: { status: 404, body: JSON.stringify({ status: 404, requestId: 'a', code: 'missing' }) },
      absent: { status: 404, body: JSON.stringify({ status: 404, requestId: 'b', code: 'missing' }) },
    }),
  });
});

test('a status leak fails', async () => {
  const counters = scripted([zero(), zero(), zero(), zero()]);
  await expect(assertHiddenIdEquality({
    operation,
    hiddenId: 'hidden',
    absentId: 'absent',
    readCounters: counters,
    call: call({
      hidden: { status: 403, body: '{}' },
      absent: { status: 404, body: '{}' },
    }),
  })).rejects.toThrow('status');
});

test('echoing the submitted id is not a body leak', async () => {
  const counters = scripted([zero(), zero(), zero(), zero()]);
  await assertHiddenIdEquality({
    operation,
    hiddenId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
    absentId: '0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee',
    readCounters: counters,
    call: (id) => Promise.resolve(new Response(JSON.stringify({
      reference: `https://rezics.com/id/${id}`, status: 'unavailable', requestId: id,
    }), { status: 404 })),
  });
});

test('a body leak fails', async () => {
  const counters = scripted([zero(), zero(), zero(), zero()]);
  await expect(assertHiddenIdEquality({
    operation,
    hiddenId: 'hidden',
    absentId: 'absent',
    readCounters: counters,
    call: call({
      hidden: { status: 404, body: JSON.stringify({ title: 'Private Work' }) },
      absent: { status: 404, body: JSON.stringify({ title: 'Resource is unavailable' }) },
    }),
  })).rejects.toThrow('body');
});

test('a cost leak fails', async () => {
  const counters = scripted([
    zero(),
    { ...zero(), graphCalls: 4, sqlStatements: 2, bytes: 10 },
    { ...zero(), graphCalls: 4, sqlStatements: 2, bytes: 10 },
    { ...zero(), graphCalls: 5, sqlStatements: 2, bytes: 10 },
  ]);
  await expect(assertHiddenIdEquality({
    operation,
    hiddenId: 'hidden',
    absentId: 'absent',
    readCounters: counters,
    call: call({
      hidden: { status: 404, body: '{}' },
      absent: { status: 404, body: '{}' },
    }),
  })).rejects.toThrow('cost');
});

test('a side-effect leak fails', async () => {
  const counters = scripted([
    zero(),
    { ...zero(), mediaGenerations: 1, rateLimitCharges: 1 },
    { ...zero(), mediaGenerations: 1, rateLimitCharges: 1 },
    { ...zero(), mediaGenerations: 1, rateLimitCharges: 2 },
  ]);
  await expect(assertHiddenIdEquality({
    operation,
    hiddenId: 'hidden',
    absentId: 'absent',
    readCounters: counters,
    call: call({
      hidden: { status: 404, body: '{}' },
      absent: { status: 404, body: '{}' },
    }),
  })).rejects.toThrow('sideEffects');
});
