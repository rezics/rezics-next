import { afterAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createWriteRateStage } from '../../src/access/write-rate-stage.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import { checkGrowth, measure, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const secret = 'growth-private-key-of-at-least-32-bytes';
const digest = createHmac('sha256', secret).update('anonymous:192.0.2.1').digest('hex');
const route = Number.parseInt(digest.slice(0, 4), 16);
const limiter = createWriteRateLimiter({
  secret,
  overrides: JSON.stringify({ anonymous: { write: { maximum: 1000000, seconds: 86400 } } }),
});
const stage = createWriteRateStage(limiter);
const population: Population = {
  name: 'write-rate-counters',
  hotPartition: route >>> 4,
  rows: ({ ordinal, route: placed, hot }) => ({
    'access.write_rate_counter': ['write', 'unrelated'].map((family) => ({
      route: hot ? route : placed,
      identity_digest: createHmac('sha256', secret).update(`seed:${ordinal}`).digest('hex'),
      family,
      count: 1,
      expires_at: new Date(Date.now() + 86400000),
    })),
  }),
};
async function admit(units: 1 | 100) {
  const request = new Request('http://localhost/batch', { method: 'POST' });
  const actor = { kind: 'anonymous' as const };
  const declaration = defineRateLimit({ family: 'write', units: units === 1 ? 1 : 'commands' });
  await stage({
    request,
    route: '/batch',
    routes: [{ method: 'POST', path: '/batch', hooks: { detail: { 'x-rate-limit': declaration } } }],
    body: { commands: Array.from({ length: units }, () => ({})) },
    context: { pool: db.pool, actor, deadline: Date.now() + 5000 },
    peer: '192.0.2.1',
  });
}

test('actual ordinary and batch100 admission use one point statement as unrelated and hot-scope counters grow', async () => {
  for (const units of [1, 100] as const) {
    await db.admin.query('TRUNCATE access.write_rate_counter');
    const report = await checkGrowth(db, {
      name: `write-rate-${units}`,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        await seed(database, population, { from: previous * 128, to: scale * 128 });
        await database.admin.query('ANALYZE access.write_rate_counter');
      },
      async operation() {
        await admit(units);
      },
    });
    for (const sample of report.samples) {
      expect(sample.cost.statements).toBe(1);
      expect(sample.cost.rows).toBeLessThanOrEqual(1);
      expect(sample.cost.relations?.['access.write_rate_counter']?.rows).toBe(1);
    }
    const result = await measure(db, () => admit(units));
    expect(result.cost.statements).toBe(1);
    expect(result.cost.rows).toBeLessThanOrEqual(1);
    expect(result.cost.relations['access.write_rate_counter']?.rows).toBe(1);
    const stored = (
      await db.admin.query(
        'SELECT count FROM access.write_rate_counter WHERE route=$1 AND identity_digest=$2 AND family=$3',
        [route, digest, 'write'],
      )
    ).rows;
    expect(stored).toEqual([{ count: 19 * units }]);
    console.info(
      report.name,
      report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        statements: cost.statements,
        blocks: cost.blocks,
      })),
    );
  }
}, 60000);
