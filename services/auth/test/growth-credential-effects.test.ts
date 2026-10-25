import { expect, test } from 'bun:test';
import { testDatabase } from '../scripts/database.ts';
import { credentialFixture } from './credential-effects.test.ts';
import { checkGrowth, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

for (const series of ['old-effects', 'unrelated-owners'] as const)
  for (const destructive of [false, true])
    test(`credential effect growth stays fixed at 1x/8x/64x: ${series}, ${destructive ? 'remove-key with 64 sessions' : 'add-key'}`, async () => {
      const fixture = testDatabase();
      const db = await openGrowthDatabase(fixture.url);
      try {
        const f = await credentialFixture(db.pool);
        const warmupSubject = 'robot-warmup';
        await f.pool.query("INSERT INTO test_authority VALUES ('robot-warmup',1,true,'pending')");
        await f.service.internal.provisionCredentialless({ authorization: warmupSubject });
        await f.pool.query("UPDATE test_authority SET state='active' WHERE id=$1", [warmupSubject]);
        // Keep every selected relation large at 1x too, so the planner measures
        // indexed reads instead of scanning a growing handful of live rows.
        await db.admin.query(
          `INSERT INTO "user"(id,name,"emailVerified") SELECT 'baseline-'||i,'',false FROM generate_series(1,1024) i`,
        );
        await db.admin.query(
          `INSERT INTO auth_public_key SELECT 'baseline-'||i,'key',$1 FROM generate_series(1,1024) i`,
          [f.publicJwk],
        );
        await db.admin
          .query(`INSERT INTO auth_effect_receipt(receipt_id,account_id,purpose,minimum_authn_epoch,operation_key,effect_reference,effect_digest,stage_version,acting_human_id,client_id,scopes,stage_ciphertext,opening_receipt_id,committed_result,committed_at)
        SELECT 'baseline-'||i,'robot','add-key',1,'baseline-'||i,'baseline-'||i,repeat('0',64),1,'human','web',ARRAY['account:manage'],'\\x00'::bytea,'opening-'||i,jsonb_build_object('receiptId','baseline-'||i,'replayed',false),now() FROM generate_series(1,1024) i`);
        const report = await checkGrowth(db, {
          name: `Auth credential effect ${series}, destructive=${destructive}`,
          repetitions: 1,
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          async grow(_, scale, previous) {
            if (series === 'old-effects')
              await db.admin.query(
                `INSERT INTO auth_effect_receipt(receipt_id,account_id,purpose,minimum_authn_epoch,operation_key,effect_reference,effect_digest,stage_version,acting_human_id,client_id,scopes,stage_ciphertext,opening_receipt_id,committed_result,committed_at) SELECT 'old-'||i,'robot','add-key',1,'old-'||i,'old-'||i,repeat('0',64),1,'human','web',ARRAY['account:manage'],'\\x00'::bytea,'old-opening-'||i,jsonb_build_object('receiptId','old-'||i,'replayed',false),now() FROM generate_series($1::integer,$2::integer) i`,
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
            // Fix the selected credential and bounded session neighborhood at each scale.
            await db.admin.query("DELETE FROM auth_public_key WHERE account_id='robot' AND kid='selected-key'");
            if (destructive) {
              await db.admin.query("INSERT INTO auth_public_key VALUES ('robot','selected-key',$1)", [
                { ...f.publicJwk, kid: 'selected-key' },
              ]);
              await db.admin.query(
                `INSERT INTO session(id,token,"userId","expiresAt","clientId","grantedScope","authnEpoch","authTime","authMethods","updatedAt") SELECT 's-'||$1||'-'||i,'t-'||$1||'-'||i,'robot',now()+interval '1 hour','web','account:manage',(SELECT epoch FROM test_authority WHERE id='robot'),1,'private_key_jwt',now() FROM generate_series(1,64) i`,
                [scale],
              );
              const warmupKid = `warmup-key-${scale}`;
              await db.admin.query('INSERT INTO auth_public_key VALUES ($1,$2,$3)', [
                warmupSubject,
                warmupKid,
                { ...f.publicJwk, kid: warmupKid },
              ]);
              await db.admin.query(
                `INSERT INTO session(id,token,"userId","expiresAt","clientId","grantedScope","authnEpoch","authTime","authMethods","updatedAt") SELECT 'warmup-s-'||$1||'-'||i,'warmup-t-'||$1||'-'||i,$2,now()+interval '1 hour','web','account:manage',(SELECT epoch FROM test_authority WHERE id=$2),1,'private_key_jwt',now() FROM generate_series(1,64) i`,
                [scale, warmupSubject],
              );
            }
            for (const table of ['auth_effect_receipt', 'auth_public_key', '"user"', 'account', 'session'])
              await db.admin.query(`VACUUM (ANALYZE) ${table}`);
          },
          async operation() {
            await apply('selected-key', 'robot');
          },
          async warmup(_, scale) {
            await apply(`warmup-key-${scale}`, warmupSubject);
          },
        });
        async function apply(kid: string, subjectId: string) {
          const op = await f.stage(
            destructive ? { kind: 'key', kid, remove: true } : { kind: 'key', kid, publicJwk: { ...f.publicJwk, kid } },
            subjectId,
          );
          expect((await f.apply({ ...op, subjectId })).replayed).toBe(false);
        }
        console.info(`Auth credential ${series}, destructive=${destructive} cost:`, JSON.stringify(report.samples));
        expect(report.samples.map((s) => s.scale)).toEqual([1, 8, 64]);
        for (const { cost } of report.samples) {
          expect(cost.rows).toBeGreaterThan(0);
          // Captured PostgreSQL plans count the same 64 deleted sessions at
          // multiple native function/trigger nodes, in addition to point reads.
          expect(cost.rows).toBeLessThan(destructive ? 650 : 550);
          expect(cost.statements).toBeLessThan(110);
          for (const relation of ['public.auth_effect_receipt', 'public.auth_public_key', 'public.user'])
            expect(cost.relations?.[relation]?.sequentialScans).toBe(0);
        }
      } finally {
        await db.close();
        fixture.close();
      }
    }, 180000);
