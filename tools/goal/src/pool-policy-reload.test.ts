import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { PoolPolicyReloader, choosePoolWithFallback } from './pools.ts';
import { harness, reading } from './test-support.ts';

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
