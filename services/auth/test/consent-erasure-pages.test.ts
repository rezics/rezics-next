import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { eraseConsentPage } from '../src/consent-erasure.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../../kernel/test/support/growth.ts';

test('native consent pages use one account/client lock, survive a final-page rollback and discard live-user stale markers', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  try {
    await pool.query(`INSERT INTO auth_client (client_id,first_party,scopes) SELECT 'page-'||lpad(i::text,3,'0'),false,'{}' FROM generate_series(1,105) i;
      INSERT INTO auth_consent (account_id,client_id,scopes) SELECT 'absent',client_id,'{}' FROM auth_client WHERE client_id LIKE 'page-%';
      INSERT INTO auth_consent_erasure (account_id,due_at) VALUES ('absent',now()-interval '1 second');`);
    for (let i = 0; i < 104; i++) {
      expect(await eraseConsentPage(pool)).toBe('absent');
      expect((await pool.query("SELECT 1 FROM auth_consent_erasure WHERE account_id='absent'")).rowCount).toBe(1);
    }
    expect((await pool.query("SELECT 1 FROM auth_consent WHERE account_id='absent'")).rowCount).toBe(1);
    // Fault only the real final transaction at its marker DELETE, after its
    // consent mutation. Replaying must perform that last page again atomically.
    const connect = pool.connect.bind(pool);
    let crash = true;
    pool.connect = (async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = ((...args: Parameters<typeof query>) => {
        if (crash && args[0] === 'DELETE FROM auth_consent_erasure WHERE account_id=$1') {
          crash = false;
          throw new Error('crash before final marker commit');
        }
        return query(...args);
      }) as typeof client.query;
      return client;
    }) as typeof pool.connect;
    await expect(eraseConsentPage(pool)).rejects.toThrow('crash before final marker commit');
    pool.connect = connect;
    expect((await pool.query("SELECT 1 FROM auth_consent WHERE account_id='absent'")).rowCount).toBe(1);
    expect(await eraseConsentPage(pool)).toBe('absent');
    expect((await pool.query("SELECT 1 FROM auth_consent_erasure WHERE account_id='absent'")).rowCount).toBe(0);
    await pool.query(`INSERT INTO "user" (id,name,"emailVerified") VALUES ('live','',false);
      INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ('live','page-001','{}');
      INSERT INTO auth_consent_erasure (account_id,due_at) VALUES ('live',now()-interval '1 second');`);
    expect(await eraseConsentPage(pool)).toBe('live');
    expect((await pool.query("SELECT 1 FROM auth_consent WHERE account_id='live'")).rowCount).toBe(1);
    expect(await eraseConsentPage(pool)).toBeNull();
  } finally {
    await pool.end();
    fixture.close();
  }
}, 60_000);

for (const axis of ['users', 'clients', 'history'] as const) {
  test(`one fixed consent client page stays bounded as unrelated ${axis} grows`, async () => {
    const fixture = testDatabase();
    const db = await openGrowthDatabase(fixture.url);
    let owner = '';
    async function prepare(current: GrowthDatabase, repetition: number) {
      if (owner) await eraseConsentPage(current.admin);
      owner = `selected-${axis}-${repetition}`;
      await current.admin.query(
        "INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,'selected','{}'),($1,'selected-next','{}')",
        [owner],
      );
      await current.admin.query(
        "INSERT INTO auth_consent_erasure (account_id,due_at) VALUES ($1,now()-interval '1 second')",
        [owner],
      );
    }
    const population: Population = {
      name: `consent-page-${axis}`,
      hotPartition: 0,
      rows: ({ ordinal }) => {
        const id = `unrelated-${axis}-${String(ordinal).padStart(8, '0')}`;
        if (axis === 'users')
          return {
            'public.user': [{ id, name: '', emailVerified: false }],
            'public.auth_consent': [{ account_id: id, client_id: 'selected', scopes: [] }],
          };
        if (axis === 'clients') return { 'public.auth_client': [{ client_id: id, first_party: false, scopes: [] }] };
        return { 'public.auth_consent_erasure': [{ account_id: id, due_at: new Date('2099-01-01T00:00:00Z') }] };
      },
    };
    try {
      await db.admin.query(
        "INSERT INTO auth_client (client_id,first_party,scopes) VALUES ('selected',false,'{}'),('selected-next',false,'{}')",
      );
      const report = await checkGrowth(db, {
        name: `consent page ${axis}`,
        scales: [256, 1024, 4096],
        repetitions: 1,
        warmups: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: (current, scale, previous) => seed(current, population, { from: previous, to: scale }),
        prepare: (current, _scale, repetition) => prepare(current, repetition),
        warmup: async (current, _scale, repetition) => {
          await prepare(current, repetition);
          await eraseConsentPage(current.pool);
          await eraseConsentPage(current.pool);
        },
        operation: async (current) => {
          expect(await eraseConsentPage(current.pool)).toBe(owner);
          expect(
            (await current.admin.query('SELECT client_id FROM auth_consent WHERE account_id=$1', [owner])).rows,
          ).toEqual([{ client_id: 'selected-next' }]);
          // Remove the remainder using the same production page outside capture.
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    } finally {
      await db.close();
      fixture.close();
    }
  }, 180_000);
}
