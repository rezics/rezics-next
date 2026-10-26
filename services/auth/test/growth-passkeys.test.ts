import { expect, test } from 'bun:test';
import { passkeyDatabase, passkeyFixture, cookies } from './passkeys.test.ts';
import { checkGrowth, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

for (const path of ['signin', 'list'] as const)
  test(`passkey ${path} remains bounded as unrelated credentials and own consumed effects grow at 1x/8x/64x`, async () => {
    const database = passkeyDatabase();
    const db = await openGrowthDatabase(database.url);
    try {
      const f = await passkeyFixture({ pool: db.openPool({ max: 3 }), kernelPool: db.pool, url: db.url });
      const person = await f.person();
      const cookie = await f.login(person);
      const { device, passkey } = await f.register(cookie);
      const report = await checkGrowth(db, {
        name: `Auth passkey ${path}`,
        repetitions: 1,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        async grow(_, scale, previous) {
          await db.admin.query(
            `INSERT INTO "user"(id,name,"emailVerified") SELECT 'other-passkey-'||i,'',false FROM generate_series($1::int,$2::int) i`,
            [previous * 1024 + 1, scale * 1024],
          );
          await db.admin.query(
            `INSERT INTO passkey(id,"userId","credentialID","publicKey",counter,"deviceType","backedUp","createdAt") SELECT 'other-'||i,'other-passkey-'||i,'other-credential-'||i,'public',0,'singleDevice',false,now() FROM generate_series($1::int,$2::int) i`,
            [previous * 1024 + 1, scale * 1024],
          );
          await db.admin.query(
            `INSERT INTO auth_effect_receipt(receipt_id,account_id,purpose,minimum_authn_epoch,operation_key,effect_reference,effect_digest,stage_version,acting_human_id,client_id,scopes,stage_ciphertext,opening_receipt_id,opening_reference,committed_result,committed_at)
            SELECT 'consumed-'||i,$3,'add-passkey',1,'consumed-'||i,'consumed-'||i,repeat('0',64),1,$3,'login',ARRAY['account:manage'],'\\x00'::bytea,'opening-'||i,'reference-'||i,jsonb_build_object('receiptId','consumed-'||i,'replayed',false),now() FROM generate_series($1::int,$2::int) i`,
            [previous * 1024 + 1, scale * 1024, person],
          );
          await db.admin.query('DELETE FROM session WHERE "userId"=$1 AND "authMethods"=\'pop\'', [person]);
        },
        async operation() {
          if (path === 'list') {
            const response = await f.request('/passkeys', undefined, cookie);
            expect(response.status).toBe(200);
            expect((await response.json()).passkeys.map((p: { id: string }) => p.id)).toEqual([passkey.id]);
          } else {
            const options = await f.request('/signin/passkey/options', {});
            expect(options.status).toBe(200);
            const response = await f.request(
              '/signin/passkey',
              { response: device.assertion(await options.json()), client_id: 'login', scope: ['account:manage'] },
              cookies(options),
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ account_id: person, amr: ['pop'] });
          }
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
      for (const { cost } of report.samples) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.rows).toBeLessThan(path === 'signin' ? 200 : 30);
        expect(cost.statements).toBeLessThan(path === 'signin' ? 70 : 15);
        expect(cost.relations?.['public.passkey']?.sequentialScans).toBe(0);
      }
      console.info(`Passkey ${path} growth:`, JSON.stringify(report.samples));
    } finally {
      await db.close();
      database.close();
    }
  }, 180000);
