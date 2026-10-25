import { expect, test } from 'bun:test';
import { testDatabase } from '../scripts/database.ts';
import { createCurrentConsentReader } from '../src/current-consent.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

test('native exact consent cost stays fixed as unrelated and same-person other-client/history rows grow', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    await db.admin.query(`INSERT INTO auth_client VALUES ('selected',false,ARRAY['read']);
      INSERT INTO auth_client_coverage (client_id,ready) VALUES ('selected',true);
      INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ('person','selected',ARRAY['read'])`);
    const read = createCurrentConsentReader({ database: db.pool }).readCurrentConsent;
    const raw: unknown[] = [];
    const report = await checkGrowth(db, {
      name: 'Auth current consent exact tuple',
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_, scale, previous) {
        const range = [previous * 500 + 1, scale * 500];
        await db.admin.query(
          `INSERT INTO auth_client SELECT 'other-'||i,false,ARRAY['read'] FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_client_coverage (client_id,ready) SELECT 'other-'||i,true FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_consent (account_id,client_id,scopes)
          SELECT 'owner-'||i,'other-'||i,ARRAY['read'] FROM generate_series($1::int,$2::int) i
          UNION ALL SELECT 'person','other-'||i,ARRAY['write'] FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_client_reduction_progress (operation_id,client_id,scopes,first_party,completed)
          SELECT 'history-'||i,'other-'||i,ARRAY['read'],false,true FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query(
          `INSERT INTO auth_client_reduction SELECT 'other-'||i,'history-'||i,ARRAY['read'],false FROM generate_series($1::int,$2::int) i`,
          range,
        );
        await db.admin.query('VACUUM (ANALYZE)');
        const sample = await capture(db, () => read({ actorAccountId: 'person', clientId: 'selected' }));
        raw.push({ scale, ...sample });
        expect(sample.capture.plans.length).toBeGreaterThan(0);
        expect(costOf(sample.capture).statements).toBe(1);
        expect(sample.capture.statements.some((sql) => /\b(?:SET|EXPLAIN)\b/i.test(sql))).toBe(false);
      },
      async operation() {
        expect(await read({ actorAccountId: 'person', clientId: 'selected' })).toEqual({
          actorAccountId: 'person',
          clientId: 'selected',
          scopes: ['read'],
        });
      },
    });
    for (const { cost } of report.samples) {
      expect(cost.statements).toBe(1);
      expect(cost.rows).toBeLessThanOrEqual(4);
      expect(cost.relations?.['public.auth_consent']?.rows).toBe(1);
      expect(cost.relations?.['public.auth_client_reduction_progress']).toBeUndefined();
    }
    // Retain full native SQL/auto_explain provenance, not synthetic EXPLAIN or timing.
    await Bun.write('.temp/current-consent-growth.json', JSON.stringify({ report, raw }, null, 2));
    console.info('Native current consent:', JSON.stringify(report));
  } finally {
    await db.close();
    fixture.close();
  }
}, 120000);
