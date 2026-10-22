import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

function inFreshProcess(body: string) {
  // Factory attachment is a process-wide pre-constructor contract. A module
  // query suffix is not isolation: Bun resolves it to the same module owner.
  const program = `import { strict as assert } from 'node:assert';
    import { Client } from 'pg';
    import { boundedPool, observeSqlPool, observeSqlPoolCreation } from ${JSON.stringify(import.meta.resolve('../src/infrastructure/pg-pool.ts'))};
    ${body}`;
  const result = spawnSync(process.execPath, ['--eval', program], { encoding: 'utf8', timeout: 10000 });
  expect({ exit: result.status, signal: result.signal, error: result.error?.message,
    stderr: result.stderr }).toEqual({ exit: 0, signal: null, error: undefined, stderr: '' });
}

test('a preload observes every actual pool before its first checkout without retaining pools in the factory registry', () => {
  inFreshProcess(`
    const pools = [], events = [], sources = [];
    const creation = observeSqlPoolCreation(pool => {
      sources.push(observeSqlPool(pool, event => { events.push(event); }));
      const initial = events.at(-1);
      assert.equal(initial.kind, 'snapshot'); assert.equal(initial.complete, true); assert.equal(initial.totals.starts, 0);
    });
    class FailedExternalConnection extends Client { constructor() { super(); throw new Error('controlled external connection failure'); } }
    try {
      assert.deepEqual(creation.status(), { attached: true, complete: true, failures: 0, poolsSeen: 0 });
      pools.push(boundedPool({ Client: FailedExternalConnection }), boundedPool({ Client: FailedExternalConnection }));
      assert.deepEqual(creation.status(), { attached: true, complete: true, failures: 0, poolsSeen: 2 });
      for (const pool of pools) await assert.rejects(async () => pool.query('SELECT 1'), /controlled external connection failure/);
      assert.equal(events.filter(event => event.kind === 'pending').length, 2);
      assert.equal(events.filter(event => event.kind === 'released').length, 2);
      const totals = events.at(-1).totals;
      assert.equal(totals.starts, 1); assert.equal(totals.released, 1); assert.equal(totals.active, 0); assert.equal(totals.pending, 0);
      assert.equal(sources.every(source => source.status().complete), true);
    } finally {
      await Promise.all(pools.map(pool => pool.end()));
      creation.detach(); for (const source of sources) source.detach();
      await Promise.all(sources.map(source => source.drain()));
    }
  `);
});

test('late, failed, async and excess factory consumers cannot establish complete process SQL coverage', () => {
  inFreshProcess(`
    const first = boundedPool({}), second = [];
    const late = observeSqlPoolCreation(() => {}), failed = observeSqlPoolCreation(() => { throw new Error('sink failure'); });
    const asynchronous = observeSqlPoolCreation(async () => {});
    const remaining = Array.from({ length: 5 }, () => observeSqlPoolCreation(() => {}));
    try {
      assert.equal(late.status().complete, false);
      assert.throws(() => observeSqlPoolCreation(() => {}), /observer limit/);
      second.push(boundedPool({}));
      assert.deepEqual(failed.status(), { attached: true, complete: false, failures: 1, poolsSeen: 1 });
      assert.deepEqual(asynchronous.status(), { attached: true, complete: false, failures: 1, poolsSeen: 1 });
      late.detach(); second.push(boundedPool({}));
      assert.deepEqual(late.status(), { attached: false, complete: false, failures: 0, poolsSeen: 1 });
    } finally { late.detach(); failed.detach(); asynchronous.detach(); for (const source of remaining) source.detach();
      await Promise.all([first, ...second].map(pool => pool.end())); }
  `);
});
