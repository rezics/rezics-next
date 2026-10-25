import { expect, test } from 'bun:test';
import { testDatabase } from '../scripts/database.ts';
import { credentialFixture } from './credential-effects.test.ts';
import { checkGrowth, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

for (const series of ['old-effects', 'unrelated-owners'] as const)
  test(`credential effect growth stays fixed at 1x/8x/64x: ${series}`, async () => {
    const fixture = testDatabase();
    const db = await openGrowthDatabase(fixture.url);
    try {
      const f = await credentialFixture(db.pool);
      let op: Awaited<ReturnType<typeof f.stage>>;
      const report = await checkGrowth(db, {
        name: `Auth credential effect ${series}`,
        repetitions: 1,
        warmups: 0,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(_, scale, previous) {
          if (series === 'old-effects')
            await db.admin.query(
              `INSERT INTO auth_effect_receipt(receipt_id,account_id,purpose,minimum_authn_epoch) SELECT 'old-'||i,'robot','add-key',1 FROM generate_series($1::integer,$2::integer) i`,
              [previous * 1024 + 1, scale * 1024],
            );
          else {
            await db.admin.query(
              `INSERT INTO "user"(id,name,"emailVerified") SELECT 'owner-'||i,'',false FROM generate_series($1::integer,$2::integer) i`,
              [previous * 1024 + 1, scale * 1024],
            );
            await db.admin.query(
              `INSERT INTO auth_public_key SELECT 'owner-'||i,'key',$3 FROM generate_series($1::integer,$2::integer) i`,
              [previous * 1024 + 1, scale * 1024, f.publicJwk],
            );
          }
          for (const table of ['auth_effect_receipt', 'auth_public_key', '"user"', 'account'])
            await db.admin.query(`VACUUM (ANALYZE) ${table}`);
          op = await f.stage({
            kind: 'key',
            kid: `scale-${scale}`,
            publicJwk: { ...f.publicJwk, kid: `scale-${scale}` },
          });
        },
        async operation() {
          expect((await f.apply(op)).replayed).toBe(false);
        },
      });
      expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.rows).toBeLessThan(550);
        expect(cost.statements).toBeLessThan(110);
      }
    } finally {
      await db.close();
      fixture.close();
    }
  }, 180000);
