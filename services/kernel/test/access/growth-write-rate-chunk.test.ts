import { afterAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { newId } from '../../src/route/route.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { bindAccountRateIdentity } from '../../src/access/write-rate-identity.ts';
import { expireWriteRateCounters } from '../../src/access/write-rate-expiry.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { resetGrowthTables } from './growth-reset.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const route = 0x7310;
const secret = 'growth-chunk-private-key-at-least-32-bytes';
const actor = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'growth',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const digest = createHmac('sha256', secret).update(`account:${actor.accountId}`).digest('hex');
const operation = { route, id: newId(route), kind: 'growth.bulk', sourceId: newId(route) };
const limiter = createWriteRateLimiter({
  secret,
  overrides: JSON.stringify({ member: { write: { maximum: 1000000, seconds: 86400 } } }),
});

for (const mode of ['admit', 'retry'] as const) {
  test(`chunk ${mode} stays constant as identities, operations and recorded chunks grow`, async () => {
    await resetGrowthTables(db.admin, ['access.write_rate_counter', 'access.write_rate_chunk']);
    const report = await checkGrowth(db, {
      name: `write-rate-chunk-${mode}`,
      scales: [256, 1024, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(database, scale, previous) {
        const ids = Array.from({ length: scale - previous }, () => newId(route));
        await database.admin.query(
          `INSERT INTO access.write_rate_counter(route,identity_digest,family,count,expires_at)
          SELECT $1,lpad(to_hex(i),64,'0'),'write',1,statement_timestamp()+interval '1 day'
          FROM generate_series($2::integer+1,$3::integer) i`,
          [route, previous, scale],
        );
        await database.admin.query(
          `INSERT INTO access.write_rate_chunk
          SELECT $1,CASE WHEN i%2=0 THEN $2 ELSE lpad(to_hex(i),64,'0') END,id,j,statement_timestamp()+interval '1 day'
          FROM unnest($3::uuid[]) WITH ORDINALITY AS v(id,i) CROSS JOIN generate_series(1,16) j`,
          [route, digest, ids],
        );
      },
      async operation(_database, _scale, repetition) {
        const context = { pool: db.pool, actor, deadline: Date.now() + 5000 };
        bindAccountRateIdentity(
          actor,
          context,
          { route, createdAt: 0, rateTier: 'ordinary', operatorAccountId: null },
          Infinity,
        );
        expect(
          await limiter.spendChunk(context, { operation, index: mode === 'retry' ? 0 : repetition }, 'write', 100),
        ).toEqual({ allowed: true });
      },
    });
    for (const sample of report.samples) expect(sample.cost.statements).toBe(1);
  }, 60000);
}

test('ledger expiry is one bounded statement as expired and live chunk history grows', async () => {
  await resetGrowthTables(db.admin, ['access.write_rate_counter', 'access.write_rate_chunk']);
  const report = await checkGrowth(db, {
    name: 'write-rate-chunk-expiry',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await database.admin.query(
        `INSERT INTO access.write_rate_chunk
        SELECT $1,lpad(to_hex(i),64,'0'),$2,i,CASE WHEN i%2=0 THEN '2020-01-01'::timestamptz ELSE statement_timestamp()+interval '1 day' END
        FROM generate_series($3::integer*100+1,$4::integer*100) i`,
        [route, operation.id, previous, scale],
      );
    },
    async operation() {
      expect(await expireWriteRateCounters(db.pool, route)).toBe(1000);
    },
  });
  for (const sample of report.samples) expect(sample.cost.statements).toBe(1);
}, 60000);
