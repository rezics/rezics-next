import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { PoolPolicyReloader, choosePoolWithFallback, readPoolPolicies } from './pools.ts';
import { harness, reading } from './test-support.ts';

test('reservePerHour accepts every finite positive fractional hourly value while zero negative nonfinite and nonnumber values refuse', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    const sourcePool = local.pools[0];
    const independentPolicy = { ...sourcePool.policy };
    delete independentPolicy.reservePerHour;
    const events: string[] = [];
    const initial = h.settings.pools;
    const reloader = new PoolPolicyReloader(h.settings.localFile, initial, (message) => events.push(message));
    let nextMtime = Date.now() + 2000;

    const reloadWithReserve = (reservePerHour: unknown) => {
      sourcePool.policy.reservePerHour = reservePerHour;
      writeFileSync(h.settings.localFile, JSON.stringify(local));
      utimesSync(h.settings.localFile, new Date(nextMtime), new Date(nextMtime));
      nextMtime += 2000;
      return reloader.read()[0]!;
    };

    for (const reservePerHour of [0.6, 100 / 168]) {
      const pool = reloadWithReserve(reservePerHour);
      expect(pool.policy.reservePerHour).toBe(reservePerHour);
      expect(pool.policy).toEqual({ ...independentPolicy, reservePerHour });
    }

    for (const reservePerHour of [
      0,
      -0.6,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '0.6',
      null,
      true,
      {},
    ]) {
      expect(() =>
        readPoolPolicies([{ ...sourcePool, policy: { ...sourcePool.policy, reservePerHour } }], h.settings.localFile),
      ).toThrow('invalid reservePerHour');
    }

    // An invalid edit keeps the last valid version's pools, not the start-time ones.
    expect(reloadWithReserve(0).policy.reservePerHour).toBe(100 / 168);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('invalid reservePerHour');
  } finally {
    h.dispose();
  }
});

test('a long-running control-plane process chooses with the current local pool policies', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    const reloader = new PoolPolicyReloader(h.settings.localFile, h.settings.pools, () => {});
    const initial = reloader.read();
    expect(initial[0]!.policy.reservePercent).toBe(0);
    local.pools[0].policy.reservePercent = 12;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    utimesSync(h.settings.localFile, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    const changed = reloader.read();
    const pool = changed[0]!;
    expect(pool.policy.reservePercent).toBe(12);
    const selection = () =>
      choosePoolWithFallback(
        { cli: 'codex', model: 'sol', effort: 'medium', poolClass: 'codex' },
        [],
        changed,
        [reading(pool, 88)],
        { now: Date.now() },
      );
    expect(selection).toThrow('no allowed pool available');
    local.pools[0].policy.reservePercent = 0;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    utimesSync(h.settings.localFile, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
    const latest = reloader.read();
    expect(
      choosePoolWithFallback(
        { cli: 'codex', model: 'sol', effort: 'medium', poolClass: 'codex' },
        [],
        latest,
        [reading(latest[0]!, 88)],
        { now: Date.now() },
      ).pool.name,
    ).toBe(pool.name);
  } finally {
    h.dispose();
  }
});

test('unreadable or invalid settings preserve the last valid pools and report the error once', () => {
  const h = harness();
  try {
    const events: string[] = [];
    const start = h.settings.pools;
    const reloader = new PoolPolicyReloader(h.settings.localFile, start, (message) => events.push(message));
    reloader.read();
    writeFileSync(h.settings.localFile, '{ invalid json');
    utimesSync(h.settings.localFile, new Date(Date.now() + 3000), new Date(Date.now() + 3000));
    expect(reloader.read()).toEqual(start);
    expect(reloader.read()).toEqual(start);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('Unable to reload pool policies');
  } finally {
    h.dispose();
  }
});

test('same-mtime pool edits reject invalid roots and adopt corrected and empty pools', () => {
  const h = harness();
  try {
    const path = h.settings.localFile;
    const stamp = new Date(1_700_000_000_000);
    const events: string[] = [];
    const local = JSON.parse(readFileSync(path, 'utf8'));
    utimesSync(path, stamp, stamp);
    const reloader = new PoolPolicyReloader(path, h.settings.pools, (message) => events.push(message));
    const replace = (value: object | null) => {
      writeFileSync(path, JSON.stringify(value));
      utimesSync(path, stamp, stamp);
      return reloader.read();
    };
    local.pools[0].policy.reservePercent = 1;
    const valid = replace(local);
    expect(valid[0]!.policy.reservePercent).toBe(1);
    expect(replace(null)).toEqual(valid);
    expect(reloader.read()).toEqual(valid);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('local settings must be an object');
    local.pools[0].policy.reservePercent = 2;
    expect(replace(local)[0]!.policy.reservePercent).toBe(2);
    expect(events).toHaveLength(1);
    local.pools = [];
    expect(replace(local)).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('fractional hourly reserves preserve numeric boundaries without relaxing other policy fields', () => {
  const localFile = `${import.meta.dir}/local.json`;
  const pool = {
    name: 'fractional',
    cli: 'codex',
    classes: ['codex'],
    configDirectory: '.',
    command: 'codex',
    allowanceKey: 'fractional',
    policy: { weight: 1, reservePercent: 12, allowUnknown: false, maxAgeMs: 60000, maxBurnPerHour: 0.3 },
  };
  for (const reservePerHour of [Number.MIN_VALUE, Number.EPSILON, 1 - Number.EPSILON, 1, Number.MAX_VALUE]) {
    const policy = { ...pool.policy, reservePerHour };
    expect(readPoolPolicies([{ ...pool, policy }], localFile)[0]!.policy).toEqual(policy);
  }
  for (const reservePerHour of [-0, false, [], 0n]) {
    expect(() => readPoolPolicies([{ ...pool, policy: { ...pool.policy, reservePerHour } }], localFile)).toThrow(
      /^invalid reservePerHour$/,
    );
  }
  const invalidFields = [
    ['weight', 0.6, 'invalid weight'],
    ['maxAgeMs', 0.6, 'invalid maxAgeMs'],
    ['reservePercent', -0.1, 'invalid reservePercent'],
    ['reservePercent', 100, 'reservePercent must be less than 100'],
    ['allowUnknown', 'false', 'allowUnknown must be explicit'],
    ['maxBurnPerHour', 0, 'invalid maxBurnPerHour'],
    ['maxBurnPerHour', Number.NaN, 'invalid maxBurnPerHour'],
    ['extra', 1, 'unknown pool policy field: extra'],
  ] as const;
  for (const [field, value, error] of invalidFields) {
    expect(() =>
      readPoolPolicies([{ ...pool, policy: { ...pool.policy, reservePerHour: 0.6, [field]: value } }], localFile),
    ).toThrow(error);
  }
});
