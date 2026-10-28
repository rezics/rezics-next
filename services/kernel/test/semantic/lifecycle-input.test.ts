import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { readSemanticLifecycle } from '../../src/semantic/index.ts';

const accountId = '019a1b2c-3d4e-7f00-8a00-ed170e000001';
const subject = '019a1b2c-3d4e-7f00-8a00-ed170e000002';
const candidate = '019a1b2c-3d4e-7f00-8a00-ed170e000003';
const target = { kind: 'candidate', subject, candidate };

async function rejected(input: unknown, message: string) {
  let reads = 0;
  const client: Pick<PoolClient, 'query'> = {
    query() {
      reads++;
      throw new Error('Unexpected IO');
    },
  };
  await expect(Reflect.apply(readSemanticLifecycle, undefined, [client, input])).rejects.toThrow(
    new TypeError(message),
  );
  expect(reads).toBe(0);
}

test('lifecycle rejects malformed and open structural inputs before IO', async () => {
  const validShape = { target, accountId, nativeT: {} };
  for (const input of [
    null,
    undefined,
    [],
    {},
    { ...validShape, extra: true },
    { ...validShape, accountId: null },
    { ...validShape, accountId: accountId.toUpperCase() },
    { ...validShape, target: null },
    { ...validShape, target: [] },
    { ...validShape, target: { kind: 'subject', subject } },
    { ...validShape, target: { kind: 'candidate', subject } },
    { ...validShape, target: { ...target, candidate: 'not-an-id' } },
    { ...validShape, target: { ...target, subject: 1 } },
    { ...validShape, target: { ...target, context: subject } },
    { ...validShape, target: { kind: 'context' } },
    { ...validShape, target: { kind: 'context', context: 'not-an-id' } },
    { ...validShape, target: { kind: 'context', context: subject, subject } },
    { ...validShape, target: Object.create(target) },
    { ...validShape, [Symbol('extra')]: true },
  ])
    await rejected(input, 'Invalid semantic lifecycle read input');
});

test('lifecycle rejects unminted time capabilities before any identity lookup', async () => {
  for (const nativeT of [undefined, null, {}, Object.freeze({}), new Date(), '2026-10-28T00:00:00.000001Z', 0]) {
    for (const locator of [
      target,
      { kind: 'context', context: subject },
      // A route mismatch must still validate T before returning null.
      { ...target, candidate: '019a1b2c-3d4e-7f00-8a00-00010e000003' },
    ])
      await rejected({ target: locator, accountId, nativeT }, 'Authoritative time is not from a live command attempt');
  }
});
