import { MAX_CONSENTED_SCOPES } from '@rezics/auth-contract';
import { resetGrowthTables } from './growth-reset.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { nativeModule } from './durable-initiator.test.ts';
import { checkGrowth, capture } from '../support/growth.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

let h: Awaited<ReturnType<typeof nativeModule>>;
beforeAll(async () => {
  h = await nativeModule();
}, 60000);
afterAll(async () => h?.close());

for (const person of ['other people', 'same person history'] as const) {
  for (const relation of ['operations', 'consents', 'delegations'] as const) {
    for (const mode of ['retry and replay', 'revoked replay'] as const) {
      test(`native durable initiator ${mode}: ${person} ${relation}, fixed selected tuple/output/K`, async () => {
        // Each series grows precisely one neighbourhood. None of these decoys
        // can authorize the selected operation or replace its native provenance.
        await resetGrowthTables(h.db.admin, [
          'durable_test.operation',
          'durable_test.source',
          'core.receipt',
          'access.principal_assignment',
        ]);
        await h.db.admin.query("DELETE FROM auth_client_coverage WHERE client_id LIKE 'durable-decoy-%'");
        await h.db.admin.query("DELETE FROM auth_client WHERE client_id LIKE 'durable-decoy-%'");
        await h.db.admin.query('DELETE FROM "user" WHERE id LIKE \'durable-decoy-%\'');
        const f = await h.fixture(true);
        const group = newId(0x3456);
        await h.db.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete) VALUES ($1,$2,'organization','active',$2,true)`,
          [routeOf(group), group],
        );
        await h.db.admin.query(
          `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id) VALUES ($1,$2,'organization',$3,$3,$3)`,
          [routeOf(f.id), f.id, group],
        );
        await h.db.admin.query(
          `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id) VALUES ($1,$2,$3,'member','(,)',$2)`,
          [routeOf(group), group, f.id],
        );
        await h.db.admin.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id) VALUES ($1,$2,$3,'member','subject:write','(,)',$3)`,
          [f.target.route, f.target.id, group],
        );
        const replayKey = Bun.randomUUIDv7();
        expect((await h.step(f, { key: replayKey })).effects).toBe(1);
        // Keep immutable creation and command receipt lookups representative
        // before the first scale, regardless of which neighbourhood grows.
        const exerciseTargets = Array.from({ length: 13 }, () => newId(f.target.route));
        if (mode === 'revoked replay') {
          // Native Auth owns and publishes the pending restriction before its
          // unavailable Access acknowledgement. Access floor remains unchanged.
          expect((await h.request('/consent', { client_id: f.clientId, scope: [] }, f.cookie)).status).toBe(503);
        }
        async function operation(runFixture = f) {
          if (mode === 'revoked replay') {
            await expect(h.step(runFixture, { key: replayKey })).rejects.toThrow();
            return;
          }
          const key = Bun.randomUUIDv7();
          const retried = await h.step(runFixture, { key, retry: true });
          expect(retried.attempts).toBe(2);
          expect(retried.effects).toBe(1);
          const replay = await h.step(runFixture, { key });
          expect(replay.outcome.replayed).toBe(true);
          expect(replay.effects).toBe(0);
        }
        const report = await checkGrowth(h.db, {
          name: `${mode}: ${person} ${relation}`,
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          ...(mode === 'retry and replay' && relation !== 'operations' ? { rule: 'series' as const } : {}),
          repetitions: 3,
          warmups: 1,
          async grow(db, scale, previous) {
            if (scale === 1) {
              const ids = Array.from({ length: 512 }, () => newId(f.operation.route));
              await db.admin.query(
                `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
                 SELECT $1,'account',$2,'durable-test.history',id::text,decode(repeat('0',64),'hex'),1,1,id,'{}' FROM unnest($3::uuid[]) id`,
                [partitionOf(f.operation.route), f.id, ids],
              );
              const targetIds = exerciseTargets.slice(0, 12);
              await db.admin.query(
                `INSERT INTO durable_test.authority(route,id,active) SELECT $1,id,true FROM unnest($2::uuid[]) id`,
                [f.target.route, targetIds],
              );
              await db.admin.query(
                `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
                 SELECT $1,id,$2,'member','subject:write','(,)',$3 FROM unnest($4::uuid[]) id`,
                [f.target.route, group, f.id, targetIds],
              );
            }
            const count = (scale - previous) * 500;
            const ids = Array.from({ length: count }, () =>
              newId(relation === 'operations' ? f.operation.route : 0x2345),
            );
            const same = person === 'same person history';
            if (relation === 'operations') {
              await db.admin.query(
                `INSERT INTO durable_test.operation SELECT $1,id,jsonb_build_object('initiatorAccountId',CASE WHEN $4 THEN $3::uuid ELSE id END) FROM unnest($2::uuid[]) id`,
                [f.operation.route, ids, f.id, same],
              );
              await db.admin.query(
                `INSERT INTO durable_test.source SELECT $1,id,id,repeat('0',64),id FROM unnest($2::uuid[]) id`,
                [f.operation.route, ids],
              );
              await db.admin.query(
                `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response) SELECT $1,'account',CASE WHEN $4 THEN $3::uuid ELSE id END,'durable-test.create',id::text,decode(repeat('0',64),'hex'),1,1,id,'{}' FROM unnest($2::uuid[]) id`,
                [partitionOf(f.operation.route), ids, f.id, same],
              );
            } else if (relation === 'consents') {
              const clients = ids.map((id) => `durable-decoy-${id}`);
              await db.admin.query(
                "INSERT INTO auth_client SELECT id,false,ARRAY['subject:write'] FROM unnest($1::text[]) id",
                [clients],
              );
              await db.admin.query(
                'INSERT INTO auth_client_coverage(client_id,ready) SELECT id,true FROM unnest($1::text[]) id',
                [clients],
              );
              if (!same)
                await db.admin.query(
                  `INSERT INTO "user"(id,name,email,"emailVerified") SELECT id,'',id||'@decoy.test',false FROM unnest($1::text[]) id`,
                  [clients],
                );
              await db.admin.query(
                "INSERT INTO auth_consent(account_id,client_id,scopes) SELECT CASE WHEN $3 THEN $2 ELSE id END,id,ARRAY['subject:write'] FROM unnest($1::text[]) id",
                [clients, f.id, same],
              );
            } else {
              await db.admin.query(
                `INSERT INTO access.principal_assignment(route,principal_id,creator_principal_id,request_id,assigned_actor_id,valid,transaction_id)
                SELECT $1,CASE WHEN $5 THEN $3::uuid ELSE id END,CASE WHEN $5 THEN $3::uuid ELSE id END,id,CASE WHEN $5 THEN $4::uuid ELSE id END,
                tstzrange('2000-01-01'::timestamptz + (n+$6)*interval '2 seconds','2000-01-01'::timestamptz + ((n+$6)*2+1)*interval '1 second','[)'),id
                FROM unnest($2::uuid[]) WITH ORDINALITY x(id,n)`,
                [routeOf(f.principal!.id), ids, f.principal!.id, f.id, same, previous * 500],
              );
            }
            for (const table of [
              'durable_test.operation',
              'durable_test.source',
              'core.receipt',
              'access.principal_assignment',
              'auth_client',
              'auth_client_coverage',
              'auth_consent',
              'access.account',
              'access.resource_grant',
              'access.organization_member',
              'access.membership_inverse',
            ])
              await db.admin.query(`VACUUM (ANALYZE) ${table}`);
          },
          operation: async (_db, _scale, repetition) =>
            operation({
              ...f,
              target: { ...f.target, id: exerciseTargets[repetition]! },
            }),
        });
        expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
        const observed = await capture(h.db, () =>
          operation({ ...f, target: { ...f.target, id: exerciseTargets[12]! } }),
        );
        const statements = observed.capture.statements;
        for (const pattern of [
          /FROM durable_test.operation/,
          /FROM durable_test.source/,
          /FROM core\.receipt/,
          /FROM auth_consent/,
        ])
          expect(statements.some((sql) => pattern.test(sql))).toBe(true);
        if (mode === 'retry and replay') {
          expect(statements.some((sql) => /FROM access.account/.test(sql))).toBe(true);
          expect(statements.some((sql) => /FROM access.principal_assignment/.test(sql))).toBe(true);
          expect(statements.some((sql) => /FROM access.organization_member/.test(sql))).toBe(true);
          expect(statements.some((sql) => /WITH input AS NOT MATERIALIZED/.test(sql))).toBe(true);
        } else {
          expect(statements.filter((sql) => /FROM core\.receipt/.test(sql))).toHaveLength(2);
          expect(statements.some((sql) => /^BEGIN ISOLATION LEVEL SERIALIZABLE/.test(sql))).toBe(false);
          expect(
            (
              await h.db.admin.query('SELECT value FROM durable_test.effect WHERE route=$1 AND id=$2', [
                f.target.route,
                f.target.id,
              ])
            ).rows[0].value,
          ).toBe(1);
        }
      }, 60000);
    }
  }
}

test('restoration keeps constant statements and rows at 8, 64 and 512 consented scopes', async () => {
  const fixtures = new Map<number, Awaited<ReturnType<typeof h.fixture>>>();
  const complete = new Error('Restoration measured before target writes');
  const report = await checkGrowth(h.db, {
    name: 'durable initiator restoration by consented scope count',
    scales: [8, 64, MAX_CONSENTED_SCOPES],
    bounds: { statements: 'constant', rows: 'constant', blocks: 'linear' },
    async grow(_db, scale) {
      const scopes = [
        'subject:write',
        'account:delegate',
        ...Array.from({ length: scale - 2 }, (_, i) => `scope:${i}`),
      ];
      fixtures.set(scale, await h.fixture(false, scopes));
    },
    async operation(_db, scale) {
      const fixture = fixtures.get(scale)!;
      await expect(
        h.step(fixture, {
          onActor: async (actor) => {
            expect(actor.scopes).toHaveLength(scale);
            throw complete;
          },
        }),
      ).rejects.toBe(complete);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([8, 64, MAX_CONSENTED_SCOPES]);
});
