import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { testDatabase } from '../scripts/database.ts';
import { betterAuthOptions } from '../src/better-auth.ts';
import { checkGrowth, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

test('checkGrowth measures actual native insertion and revocation with independent expired and unrelated history', async () => {
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    const auth = betterAuth(
      betterAuthOptions(db.pool, 'https://growth.auth.test', 'growth-session-secret-at-least-32-bytes'),
    );
    const ctx = await auth.$context;
    await db.admin.query(`INSERT INTO auth_client VALUES ('growth-web',true,ARRAY['read'])`);
    await db.admin.query(`INSERT INTO "user" (id,name,"emailVerified") VALUES ('selected','',false)`);
    const insert = () =>
      ctx.internalAdapter.createSession('selected', false, {
        clientId: 'growth-web',
        grantedScope: 'read',
        authnEpoch: 1,
        authTime: 123,
        authMethods: 'pwd',
      });
    for (const dimension of ['expired', 'unrelated']) {
      const report = await checkGrowth(db, {
        name: `native sessions against ${dimension} history`,
        repetitions: 2,
        warmups: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        async grow(_, scale, previous) {
          // All owners obey the cap. One common deterministic seed, grown incrementally.
          await db.admin.query(
            `INSERT INTO "user" (id,name,"emailVerified") SELECT $1||i,'',false FROM generate_series($2::int,$3::int) i`,
            [dimension, previous * 32 + 1, scale * 32],
          );
          await db.admin.query(
            `INSERT INTO session (id,token,"userId","clientId","expiresAt","createdAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
            SELECT $1||i||'-'||j,$1||i||'-'||j,$1||i,'growth-web',
            CASE WHEN $1='expired' THEN '2000-01-01'::timestamptz ELSE '2099-01-01'::timestamptz END,
            now(),now(),'read',1,123,'pwd' FROM generate_series($2::int,$3::int) i CROSS JOIN generate_series(1,16) j`,
            [dimension, previous * 32 + 1, scale * 32],
          );
          await db.admin.query('VACUUM ANALYZE session');
          await db.admin.query('ANALYZE "user"');
        },
        async operation() {
          // Always establish at a fixed, full neighborhood; preparation is outside capture via admin.
          await db.admin.query('DELETE FROM session WHERE "userId"=\'selected\'');
          for (let i = 0; i < 64; i++) {
            await db.admin.query(
              `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods") VALUES ($1,$1,'selected','growth-web','2000-01-01',now(),'read',1,123,'pwd')`,
              [`selected-${i}`],
            );
          }
          await insert();
          expect(
            Number((await db.admin.query(`SELECT count(*) FROM session WHERE "userId"='selected'`)).rows[0].count),
          ).toBe(64);
          await ctx.internalAdapter.deleteUserSessions('selected');
          expect((await db.admin.query(`SELECT id FROM session WHERE "userId"='selected'`)).rows).toEqual([]);
        },
      });
      expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
      expect(report.samples.every((s) => s.cost.rows > 64 && s.cost.statements > 0)).toBe(true);
      // The owner scan in INSERT, native delete-hook snapshot and revoke DELETE
      // each visit 64 session rows; nested trigger work must be captured too.
      expect(report.samples.every((s) => (s.cost.relations?.['public.session']?.rows ?? 0) >= 192)).toBe(true);
    }
  } finally {
    await db.close();
    fixture.close();
  }
}, 120000);

test('checkGrowth measures changing legacy history in separate bounded pages and indexed expiry batches', async () => {
  const { trimSessionHistory, pruneExpiredSessions } = await import('../src/session-limits.ts');
  const fixture = testDatabase();
  const db = await openGrowthDatabase(fixture.url);
  try {
    await db.admin.query(`INSERT INTO auth_client VALUES ('maintenance-web',true,ARRAY['read'])`);
    await db.admin.query(
      `INSERT INTO "user" (id,name,"emailVerified",sessions_bounded) VALUES ('legacy-growth','',false,false)`,
    );
    const report = await checkGrowth(db, {
      name: 'legacy session trimming pages',
      repetitions: 2,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(_, scale, previous) {
        const connection = await db.admin.connect();
        try {
          await connection.query('BEGIN');
          // Model pre-upgrade history: the durable barrier remains closed.
          // Ordinary native INSERTs can never seed this legacy state.
          await connection.query('ALTER TABLE session DISABLE TRIGGER session_capacity');
          await connection.query(
            `INSERT INTO session (id,token,"userId","clientId","expiresAt","createdAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
            SELECT 'legacy-growth-'||i,'legacy-growth-'||i,'legacy-growth','maintenance-web','2000-01-01',
            '2000-01-01'::timestamptz+i*interval '1 second',now(),'read',1,123,'pwd'
            FROM generate_series($1::int,$2::int) i`,
            [previous * 256 + 1, scale * 256],
          );
          await connection.query('ALTER TABLE session ENABLE TRIGGER session_capacity');
          await connection.query('COMMIT');
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        } finally {
          connection.release();
        }
        await db.admin.query('VACUUM ANALYZE session');
      },
      async operation() {
        const before = Number(
          (await db.admin.query(`SELECT count(*) FROM session WHERE "userId"='legacy-growth'`)).rows[0].count,
        );
        expect(await trimSessionHistory(db.pool, 'legacy-growth', 32)).toEqual({ deleted: 32, ready: false });
        expect(
          Number((await db.admin.query(`SELECT count(*) FROM session WHERE "userId"='legacy-growth'`)).rows[0].count),
        ).toBe(before - 32);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
    expect(report.samples.every((sample) => sample.cost.rows >= 128)).toBe(true);
    const expiry = await checkGrowth(db, {
      name: 'admitted session expiry page',
      repetitions: 2,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(_, scale, previous) {
        await db.admin.query(
          `INSERT INTO "user" (id,name,"emailVerified") SELECT 'expiry-'||i,'',false FROM generate_series($1::int,$2::int) i`,
          [previous * 16 + 1, scale * 16],
        );
        await db.admin.query(
          `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
          SELECT 'expiry-'||i||'-'||j,'expiry-'||i||'-'||j,'expiry-'||i,'maintenance-web','1990-01-01',now(),'read',1,123,'pwd'
          FROM generate_series($1::int,$2::int) i CROSS JOIN generate_series(1,16) j`,
          [previous * 16 + 1, scale * 16],
        );
        await db.admin.query('VACUUM ANALYZE session');
      },
      async operation() {
        expect(await pruneExpiredSessions(db.pool, 32)).toBe(32);
      },
    });
    expect(
      expiry.samples.every(
        (sample) => sample.cost.statements === 1 && sample.cost.rows >= 96 && sample.cost.rows <= 130,
      ),
    ).toBe(true);
  } finally {
    await db.close();
    fixture.close();
  }
}, 120000);
