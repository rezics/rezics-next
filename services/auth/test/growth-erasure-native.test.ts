import { expect, test } from 'bun:test';
import { testDatabase } from '../scripts/database.ts';
import { ERASURE_PAGE_SIZE, nativeErasurePage, startNativeErasure } from '../src/erasure-native.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../../kernel/test/support/growth.ts';

for (const axis of ['users', 'clients', 'history'] as const) {
  test(`a fixed native client page includes its proof and checkpoint as unrelated ${axis} grows`, async () => {
    const fixture = testDatabase();
    const db = await openGrowthDatabase(fixture.url);
    let id = '';
    let selected = '';
    async function prepare(current: GrowthDatabase, repetition: number) {
      selected = `selected-${axis}-${repetition}`;
      await current.admin.query('INSERT INTO "user" (id,name,"emailVerified") VALUES ($1,\'\',false)', [selected]);
      await current.admin.query(
        'INSERT INTO auth_client (client_id,"userId",first_party,scopes) VALUES ($1,$1,false,\'{}\')',
        [selected],
      );
      await current.admin.query(
        `INSERT INTO "oauthAccessToken" (id,token,"clientId","userId","expiresAt","createdAt",scopes)
        SELECT $1||i,$1||i,$1,$1,now()+interval '300 seconds',now(),'[]'::jsonb FROM generate_series(1,$2) i`,
        [selected, ERASURE_PAGE_SIZE],
      );
      id = await startNativeErasure(current.admin, selected, 2);
      expect((await nativeErasurePage(current.admin, id)).code).toBe('client');
    }
    const population: Population = {
      name: `native-erasure-${axis}`,
      hotPartition: 0,
      rows: ({ ordinal }) => {
        const key = `unrelated-${axis}-${String(ordinal).padStart(8, '0')}`;
        if (axis === 'users') return { 'public.user': [{ id: key, name: '', emailVerified: false }] };
        if (axis === 'clients') return { 'public.auth_client': [{ client_id: key, first_party: false, scopes: [] }] };
        return {
          'public.auth_effect_receipt': [
            { receipt_id: key, account_id: key, purpose: 'sessions', minimum_authn_epoch: 0 },
          ],
        };
      },
    };
    try {
      const report = await checkGrowth(db, {
        name: `native erasure ${axis}`,
        scales: [256, 1024, 4096],
        repetitions: 1,
        warmups: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: (current, scale, previous) => seed(current, population, { from: previous, to: scale }),
        prepare: (current, _scale, repetition) => prepare(current, repetition),
        warmup: async (current, _scale, repetition) => {
          await prepare(current, repetition);
          await nativeErasurePage(current.pool, id);
        },
        operation: async (current) => {
          expect(await nativeErasurePage(current.pool, id)).toEqual({ id, state: 'more', code: 'client' });
          expect(
            (await current.admin.query('SELECT 1 FROM "oauthAccessToken" WHERE "clientId"=$1', [selected])).rowCount,
          ).toBe(0);
          expect((await current.admin.query('SELECT 1 FROM "user" WHERE id=$1', [selected])).rowCount).toBe(1);
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    } finally {
      await db.close();
      fixture.close();
    }
  }, 180_000);
}
