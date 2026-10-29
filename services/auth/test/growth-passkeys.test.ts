import { expect, test } from 'bun:test';
import { authenticator, passkeyDatabase, passkeyFixture, cookies } from './passkeys.test.ts';
import { capture, checkGrowth, GrowthBoundError, openGrowthDatabase } from '../../kernel/test/support/growth.ts';

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

for (const path of ['registration options', 'verified registration', 'registration replay', 'removal'] as const)
  test(`passkey ${path} remains bounded as unrelated credentials and own receipts and challenges grow at 1x/8x/64x`, async () => {
    const database = passkeyDatabase();
    const db = await openGrowthDatabase(database.url);
    try {
      const f = await passkeyFixture({ pool: db.openPool({ max: 3 }), kernelPool: db.pool, url: db.url });
      const person = await f.person();
      let cookie = '';
      let previousFloor = 1;
      type Ceremony = {
        cookie: string;
        body: { response: ReturnType<ReturnType<typeof authenticator>['registration']>; name: string };
        challengeId: string;
        operationKey: string;
        passkey?: { id: string; name: string; created_at: string };
      };
      let ceremonies: Ceremony[] = [];

      async function sessions() {
        // Removal invalidates every source session, so acquire fresh native proof
        // outside capture for the next prebuilt passkey. Keep exactly 64 sessions.
        await db.admin.query('DELETE FROM session WHERE "userId"=$1', [person]);
        cookie = await f.login(person);
        await db.admin.query(
          `INSERT INTO session(id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
          SELECT 'cap-'||i,'cap-token-'||i,s."userId",s."clientId",s."expiresAt",now(),s."grantedScope",s."authnEpoch",s."authTime",s."authMethods"
          FROM session s CROSS JOIN generate_series(1,63) i WHERE s."userId"=$1`,
          [person],
        );
        expect((await db.admin.query('SELECT id FROM session WHERE "userId"=$1', [person])).rows).toHaveLength(64);
        previousFloor = Number(
          (await db.admin.query('SELECT minimum_authn_epoch FROM access.account WHERE account_id=$1', [person])).rows[0]
            .minimum_authn_epoch,
        );
      }

      async function operation() {
        if (path === 'registration options') {
          const response = await f.request('/passkeys/register/options', {}, cookie);
          expect(response.status).toBe(200);
          const options = await response.json();
          expect(options.excludeCredentials).toHaveLength(32);
          expect(options.authenticatorSelection.userVerification).toBe('required');
          expect(
            (
              await db.admin.query(`SELECT id FROM verification WHERE value::jsonb->>'expectedChallenge'=$1`, [
                options.challenge,
              ])
            ).rows,
          ).toHaveLength(1);
          return;
        }
        const ceremony = ceremonies.shift()!;
        if (path === 'removal') {
          const response = await f.request('/passkeys/remove', { id: ceremony.passkey!.id }, cookie);
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ success: true });
          expect(
            (await db.admin.query('SELECT id FROM passkey WHERE id=$1', [ceremony.passkey!.id])).rows,
          ).toHaveLength(0);
          expect((await db.admin.query('SELECT id FROM session WHERE "userId"=$1', [person])).rows).toHaveLength(0);
          const floor = await db.admin.query(
            `SELECT previous_floor,minimum_authn_epoch FROM access.credential_floor_receipt
            WHERE account_id=$1 AND purpose='remove-passkey' AND previous_floor=$2`,
            [person, previousFloor],
          );
          expect(floor.rows).toHaveLength(1);
          expect(Number(floor.rows[0].minimum_authn_epoch)).toBe(previousFloor + 1);
          expect(
            Number(
              (await db.admin.query('SELECT minimum_authn_epoch FROM access.account WHERE account_id=$1', [person]))
                .rows[0].minimum_authn_epoch,
            ),
          ).toBe(previousFloor + 1);
        } else {
          const response = await f.request('/passkeys/register', ceremony.body, ceremony.cookie);
          expect(response.status).toBe(201);
          const result = await response.json();
          if (path === 'registration replay') expect(result).toEqual(ceremony.passkey);
          expect(
            (
              await db.admin.query('SELECT id FROM passkey WHERE "userId"=$1 AND "credentialID"=$2', [
                person,
                ceremony.body.response.id,
              ])
            ).rows,
          ).toEqual([{ id: result.id }]);
          // The verified handler consumes the native challenge; replay succeeds
          // from its exact committed effect without another challenge or install.
          expect(
            (await db.admin.query('SELECT id FROM verification WHERE id=$1', [ceremony.challengeId])).rows,
          ).toHaveLength(0);
          const effects = await db.admin.query(
            `SELECT committed_at,opening_receipt_id,opening_reference FROM auth_effect_receipt WHERE account_id=$1 AND operation_key=$2`,
            [person, ceremony.operationKey],
          );
          expect(effects.rows).toHaveLength(1);
          expect(effects.rows[0]).toMatchObject({
            committed_at: expect.any(Date),
            opening_receipt_id: expect.any(String),
            opening_reference: expect.any(String),
          });
        }
        expect(
          (await db.admin.query('SELECT id FROM passkey WHERE "userId"=$1', [person])).rows.length,
        ).toBeLessThanOrEqual(32);
      }

      try {
        const report = await checkGrowth(db, {
          name: `Auth passkey ${path}`,
          repetitions: 1,
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          async grow(_, scale, previous) {
            const range = [previous * 1024 + 1, scale * 1024];
            await db.admin.query(
              `INSERT INTO "user"(id,name,"emailVerified") SELECT 'growth-person-'||i,'',false FROM generate_series($1::int,$2::int) i`,
              range,
            );
            await db.admin.query(
              `INSERT INTO passkey(id,"userId","credentialID","publicKey",counter,"deviceType","backedUp","createdAt")
              SELECT 'growth-passkey-'||i,'growth-person-'||i,'growth-credential-'||i,'public',0,'singleDevice',false,now() FROM generate_series($1::int,$2::int) i`,
              range,
            );
            await db.admin.query(
              `INSERT INTO auth_effect_receipt(receipt_id,account_id,purpose,minimum_authn_epoch,operation_key,effect_reference,effect_digest,stage_version,acting_human_id,client_id,scopes,stage_ciphertext,opening_receipt_id,opening_reference,committed_result,committed_at)
              SELECT 'history-'||i,$3,'add-passkey',1,'history-'||i,'history-'||i,repeat('0',64),1,$3,'login',ARRAY['account:manage'],'\\x00'::bytea,'opening-'||i,'reference-'||i,jsonb_build_object('receiptId','history-'||i,'replayed',false),now() FROM generate_series($1::int,$2::int) i`,
              [...range, person],
            );
            // Expired own ceremonies retain the native value shape and unique
            // identifiers; ordinary consumption deletes its challenge identity.
            await db.admin.query(
              `INSERT INTO verification(id,identifier,value,"expiresAt")
              SELECT 'challenge-history-'||i,'challenge-history-'||i,jsonb_build_object('type','registration','expectedChallenge','old-'||i,'userData',jsonb_build_object('id',$3::text))::text,now()-interval '1 day'
              FROM generate_series($1::int,$2::int) i`,
              [...range, person],
            );
            await db.admin.query('DELETE FROM passkey WHERE "userId"=$1', [person]);
            await db.admin.query(
              `INSERT INTO passkey(id,"userId","credentialID","publicKey",counter,"deviceType","backedUp","createdAt")
              SELECT 'owner-passkey-'||i,$1,'owner-credential-'||i,'public',0,'singleDevice',false,now() FROM generate_series(1,$2::int) i`,
              [person, path === 'registration options' ? 32 : 29],
            );
            await sessions();
            ceremonies = [];
            if (path !== 'registration options') {
              // One warmup, one measured run and a diagnostic spare. All native
              // challenges and fresh passkeys are prepared before capture.
              for (let i = 0; i < 3; i++) {
                const options = await f.request('/passkeys/register/options', {}, cookie);
                expect(options.status).toBe(200);
                const creation = await options.json();
                const challenge = await db.admin.query(
                  `SELECT id FROM verification WHERE value::jsonb->>'expectedChallenge'=$1`,
                  [creation.challenge],
                );
                expect(challenge.rows).toHaveLength(1);
                const ceremony: Ceremony = {
                  cookie: `${cookie}; ${cookies(options)}`,
                  body: { response: authenticator().registration(creation), name: 'Growth device' },
                  challengeId: challenge.rows[0].id,
                  operationKey: `passkey-register:${creation.challenge}`,
                };
                if (path !== 'verified registration') {
                  const response = await f.request('/passkeys/register', ceremony.body, ceremony.cookie);
                  expect(response.status).toBe(201);
                  ceremony.passkey = await response.json();
                }
                ceremonies.push(ceremony);
              }
            }
          },
          async prepare() {
            if (path === 'removal') await sessions();
          },
          operation,
        });
        expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
        for (const { cost } of report.samples) {
          expect(cost.rows).toBeGreaterThan(0);
          expect(cost.statements).toBeGreaterThan(0);
        }
        console.info(`Passkey ${path} growth:`, JSON.stringify(report.samples));
      } catch (error) {
        if (error instanceof GrowthBoundError) {
          if (path === 'removal') await sessions();
          const diagnostic = await capture(db, operation);
          console.info(
            `Passkey ${path} growth defect:`,
            JSON.stringify({ samples: error.samples, capture: diagnostic.capture }),
          );
        }
        throw error;
      }
    } finally {
      await db.close();
      database.close();
    }
  }, 180000);
