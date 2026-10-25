import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import type { AccountActor } from '../../src/request/access.ts';
import {
  createWriteRateLimiter,
  WriteRateUnavailableError,
  type AccountRateClass,
  type WriteRateContext,
  type WriteRateDecision,
  type WriteRateFamily,
  type WriteRateLimiter,
} from '../../src/access/write-rate.ts';

const pool = new Proxy({} as Pool, {
  get() {
    throw new Error('The contract must not access the pool');
  },
});
const context: WriteRateContext = { pool, actor: { kind: 'anonymous' }, deadline: Date.now() + 60_000 };

// Consumer fixture only: structural injection does not prove production enforcement.
async function bulk(limiter: WriteRateLimiter, commands: (() => void)[]): Promise<WriteRateDecision> {
  const decision = await limiter.spend(context, 'write', commands.length);
  if (decision.allowed) for (const command of commands) command();
  return decision;
}

test('write rate contract supports atomic multi-command spend without per-command side effects', async () => {
  expectTypeOf<Parameters<WriteRateLimiter['spend']>['length']>().toEqualTypeOf<2 | 3>();
  expectTypeOf<Parameters<WriteRateLimiter['spend']>[2]>().toEqualTypeOf<number | undefined>();
  expectTypeOf<keyof WriteRateContext>().toEqualTypeOf<'pool' | 'actor' | 'deadline'>();
  const effects: string[] = [];
  const commands = Array.from({ length: 100 }, () => () => effects.push('command'));
  for (const decision of [{ allowed: true }, { allowed: false, retryAfter: 12 }] as const) {
    effects.length = 0;
    const pending = Promise.withResolvers<WriteRateDecision>();
    let spends = 0;
    const limiter: WriteRateLimiter = {
      async spend(receivedContext, family, units) {
        spends++;
        expect(receivedContext).toBe(context);
        expect(family).toBe('write');
        expect(units).toBe(100);
        effects.push('spend');
        return pending.promise;
      },
    };
    const result = bulk(limiter, commands);
    expect(effects).toEqual(['spend']);
    pending.resolve(decision);
    expect(await result).toEqual(decision);
    expect(spends).toBe(1);
    expect(effects).toEqual(['spend', ...Array(decision.allowed ? 100 : 0).fill('command')]);
  }
});

test('missing rate implementation fails closed', async () => {
  const limiter: WriteRateLimiter = createWriteRateLimiter();
  const families = ['write', 'upload', 'report', 'correspondence', 'search', 'provider', 'address'] as const;
  expectTypeOf<WriteRateFamily>().toEqualTypeOf<(typeof families)[number]>();
  for (const family of families) {
    for (const units of [undefined, 1, 100]) {
      await expect(limiter.spend(context, family, units)).rejects.toBeInstanceOf(WriteRateUnavailableError);
    }
  }
  let effects = 0;
  await expect(
    bulk(
      limiter,
      Array.from({ length: 100 }, () => () => effects++),
    ),
  ).rejects.toMatchObject({
    name: 'WriteRateUnavailableError',
  });
  expect(effects).toBe(0);
});

test('caller-selected class and invalid units cannot grant capacity', async () => {
  expectTypeOf<AccountRateClass>().toEqualTypeOf<'anonymous' | 'new-account' | 'member' | 'trusted' | 'service'>();
  const actor: AccountActor = {
    kind: 'account',
    accountId: '00000000-0000-4000-8000-000000000001',
    clientId: 'service',
    scopes: ['service', '*'],
    requestedBy: null,
    authnEpoch: 1,
  };
  const selected = { ...context, actor, accountClass: 'service', body: { rateClass: 'service' } };
  const limiter = createWriteRateLimiter();
  await expect(limiter.spend(selected, 'write', 100)).rejects.toBeInstanceOf(WriteRateUnavailableError);
  // Configuration cannot turn the unavailable implementation into a policy override.
  await expect(createWriteRateLimiter({}).spend(selected, 'write')).rejects.toBeInstanceOf(WriteRateUnavailableError);
  await expect(
    createWriteRateLimiter({ accountClass: 'service' } as never).spend(selected, 'write'),
  ).rejects.toBeInstanceOf(WriteRateUnavailableError);
  for (const units of [0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, null, '1', true]) {
    await expect(limiter.spend(context, 'write', units as number)).rejects.toBeInstanceOf(RangeError);
  }
  for (const family of ['', 'batchWrite', 'service', 'toString', null, 1]) {
    await expect(limiter.spend(context, family as WriteRateFamily)).rejects.toBeInstanceOf(TypeError);
  }
});

test('invalid contexts fail before pool access', async () => {
  const limiter = createWriteRateLimiter();
  for (const invalid of [
    null,
    {},
    { ...context, pool: null },
    { ...context, actor: null },
    { ...context, actor: { kind: 'service' } },
    { ...context, deadline: NaN },
    { ...context, deadline: Infinity },
    { ...context, deadline: 'tomorrow' },
  ]) {
    await expect(limiter.spend(invalid as WriteRateContext, 'write')).rejects.toBeInstanceOf(TypeError);
  }
});
