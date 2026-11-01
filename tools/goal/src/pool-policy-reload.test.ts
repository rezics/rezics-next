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

    for (const reservePerHour of [0, -0.6, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.6', null, true, {}]) {
      expect(() =>
        readPoolPolicies(
          [{ ...sourcePool, policy: { ...sourcePool.policy, reservePerHour } }],
          h.settings.localFile,
        ),
      ).toThrow('invalid reservePerHour');
    }

    expect(reloadWithReserve(0)).toEqual(initial);
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

test('unreadable or invalid settings preserve start-time pools and report the error once', () => {
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
