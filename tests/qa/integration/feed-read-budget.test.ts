import { expect, test } from 'bun:test';
import { budgetFor, HOME_READS, measureRead, meterStatements, seedHome, SIGNED_HOME_READS,
  startHomeStack } from './feed-read-support.ts';

test('G383: Home reads stay within their graph and statement budgets; lock-only reads write no row', async () => {
  const meter = meterStatements();
  const home = await startHomeStack('home-budget');
  try {
    const seeded = await seedHome(home);
    const token = home.reader.token;
    const reads = [
      ...Object.entries(HOME_READS).map(([name, path]) => ({ name: `anonymous ${name}`, path, token: undefined,
        budget: budgetFor(name, false) })),
      ...Object.entries(SIGNED_HOME_READS).map(([name, path]) => ({ name: `signed ${name}`, path: seeded.signed(path),
        token, budget: budgetFor(name, true) })),
    ];
    const measured = [];
    for (const read of reads) {
      const cold = await measureRead(home, meter, read.path, read.token);
      const warm = await measureRead(home, meter, read.path, read.token);
      measured.push({ ...read, cold, warm });
    }
    console.log(`home read budget measured: ${JSON.stringify(measured.map(({ name, cold, warm }) => ({ name,
      coldMs: Math.round(cold.ms), warmMs: Math.round(warm.ms), graphQueries: warm.graphQueries,
      statements: warm.statements, items: warm.items })))}`);
    for (const { name, warm, budget } of measured) {
      expect({ read: name, graphQueries: warm.graphQueries <= budget.graphQueries,
        statements: warm.statements <= budget.statements })
        .toEqual({ read: name, graphQueries: true, statements: true });
    }
    // The contract is not vacuous: the page carries hydrated cards of each kind.
    const best = measured.find(read => read.name === 'anonymous bestAll')!;
    expect(best.warm.items).toBeGreaterThanOrEqual(5);
    expect(measured.find(read => read.name === 'signed newFollowing')!.warm.items).toBeGreaterThan(0);
    expect(measured.find(read => read.name === 'signed continue')!.warm.items).toBe(1);
    expect(meter.asyncCommits()).toBeGreaterThan(20);
    expect(meter.violations).toEqual([]);

    // Asynchronous commit leaves the recovery fence exactly as it was: a held
    // fence still fails every Home read closed, and reopening restores them.
    await home.stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    try {
      for (const read of reads) {
        expect({ read: read.name, status: (await home.call('GET', read.path, undefined, read.token)).status })
          .toEqual({ read: read.name, status: 503 });
      }
    } finally {
      await home.stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    }
    for (const read of reads) expect((await home.call('GET', read.path, undefined, read.token)).status).toBe(200);
    expect(meter.violations).toEqual([]);
  } finally {
    meter.restore();
    await home.stop();
  }
}, 240_000);
