import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { nativeErasurePage } from '../src/erasure-native.ts';
import { failNativeQueries, nativeFixture, scopes } from './support/erasure-native.ts';
import { consumableGrowth } from './support/consumable-growth.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';

type Selected = { obligationId: string; clientId: string; ownerId: string };

// This measures current guarded whole-client disposal. The installed native
// guard purges attempted arbitrary contacts/metadata before the measured drain.
// Actual historical scrub cases cover retained pre-guard bytes separately;
// this does not establish contact-role or shared-copy coverage.
for (const axis of ['clients', 'resource-links', 'encrypted-stages'] as const) {
  test(`native metadata owner drain charges guards, payload deletion and checkpoint at fixed page size as unrelated ${axis} grow`, async () => {
    const f = await nativeFixture();
    const selected: Selected[] = [];
    // Stop at a real native transaction boundary, never install a phase/cursor.
    // Other earlier native children are drained by the actual deletion workflow.
    const restore = failNativeQueries(f.pool, (sql) => sql === 'DELETE FROM auth_client WHERE client_id=$1');
    let db: GrowthDatabase | undefined;
    try {
      // Fresh targets for warmups, measurements and any physical retry. No
      // destructive operation gets reused if capture retries after committing.
      for (let run = 0; run < 10; run++) {
        const owner = await f.person(`metadata-growth-${axis}-${run}`);
        const clientId = randomUUID();
        await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes });
        await f.pool.query('UPDATE auth_client SET "userId"=$2,contacts=$3,metadata=$4 WHERE client_id=$1', [
          clientId,
          owner.accountId,
          JSON.stringify([`unknown-${run}@historical.test`]),
          JSON.stringify({ historical: 'unclassified private payload', foreignParty: 'not-an-authoritative-role' }),
        ]);
        expect((await f.delete(owner)).status).toBe(503);
        const obligation = (
          await f.pool.query('SELECT id,client_id,user_deleted_at FROM auth_erasure WHERE account_id=$1', [
            owner.accountId,
          ])
        ).rows[0]!;
        expect(obligation.client_id).toBe(clientId);
        expect(obligation.user_deleted_at).toBeNull();
        expect(
          (await f.pool.query('SELECT contacts FROM auth_client WHERE client_id=$1', [clientId])).rows[0]!.contacts,
        ).toBeNull();
        selected.push({ obligationId: obligation.id, clientId, ownerId: owner.accountId });
      }
      // No worker can race the selected native pages once their real obligations
      // exist. Closing our executor does not stop any other attempt's process.
      await f.host.workflows.close();
      restore();
      db = await openGrowthDatabase(f.fixture.url);
      let cursor = 0;
      const physical = consumableGrowth({
        name: `metadata-${axis}`,
        async setup() {
          const target = selected[cursor++];
          if (!target) throw new Error('No fresh native metadata target remains for a physical invocation');
          return target;
        },
        async run(current, _scale, _id, target) {
          const result = await nativeErasurePage(current.pool, target.obligationId);
          expect(result).toEqual({ id: target.obligationId, state: 'more', code: 'client' });
          expect(JSON.stringify(result)).not.toContain('historical');
          expect(
            (await current.admin.query('SELECT 1 FROM auth_client WHERE client_id=$1', [target.clientId])).rowCount,
          ).toBe(0);
          // The parent user is a later native phase, so this single page cannot
          // accidentally claim whole-owner completion or run an unbounded drain.
          expect((await current.admin.query('SELECT 1 FROM "user" WHERE id=$1', [target.ownerId])).rowCount).toBe(1);
          const saved = (
            await current.admin.query('SELECT client_id,applicable,user_deleted_at FROM auth_erasure WHERE id=$1', [
              target.obligationId,
            ])
          ).rows[0]!;
          expect(saved).toEqual({ client_id: null, applicable: true, user_deleted_at: null });
          expect(
            (
              await current.admin.query('SELECT 1 FROM auth_erased_client WHERE client_id=$1 AND obligation_id=$2', [
                target.clientId,
                target.obligationId,
              ])
            ).rowCount,
          ).toBe(1);
        },
      });
      const report = await checkGrowth(db, {
        name: `native metadata disposition ${axis}`,
        scales: [256, 1024, 4096],
        repetitions: 1,
        warmups: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { responseBytes: 'constant' },
        attempts: { commands: 1 },
        async grow(current, scale, previous) {
          const prefix = `metadata-unrelated-${axis}-`;
          if (axis === 'clients') {
            await current.admin.query(
              `INSERT INTO auth_client (client_id,first_party,scopes,contacts,metadata)
               SELECT $1||i,false,'{}'::text[],'["unknown@history.test"]'::jsonb,
                 '{"actorAccountId":"not-native-context"}'::jsonb
               FROM generate_series($2::int,$3::int) i`,
              [prefix, previous + 1, scale],
            );
          } else if (axis === 'resource-links') {
            // Unrelated guarded populations only: the selected client and its
            // erasure still originate in real native registration/deletion.
            await current.admin.query(
              `INSERT INTO auth_client (client_id,first_party,scopes)
               SELECT $1||i,false,'{}'::text[] FROM generate_series($2::int,$3::int) i`,
              [prefix, previous + 1, scale],
            );
            await current.admin.query(
              `INSERT INTO "oauthResource" (id,identifier,name,metadata)
               SELECT $1||i,$1||i,'Historical resource','{"private":"unknown"}'::jsonb
               FROM generate_series($2::int,$3::int) i`,
              [prefix, previous + 1, scale],
            );
            await current.admin.query(
              `INSERT INTO "oauthClientResource" (id,"clientId","resourceId",metadata)
               SELECT $1||i,$1||i,$1||i,'{"contact":"unknown@history.test"}'::jsonb
               FROM generate_series($2::int,$3::int) i`,
              [prefix, previous + 1, scale],
            );
          } else {
            await current.admin.query(
              `INSERT INTO auth_registration_stage
                (registration_id,request_key,handle,account_id,request_digest,ciphertext,credential_digest,creation_binding)
               SELECT $1||i,$1||i,$1||i,$1||i,decode(repeat('01',32),'hex'),
                 decode(repeat('02',256),'hex'),decode(repeat('03',32),'hex'),
                 '{"historical":"unclassified encrypted creation"}'::jsonb
               FROM generate_series($2::int,$3::int) i`,
              [prefix, previous + 1, scale],
            );
          }
        },
        ...physical.hooks,
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
      expect(
        physical.invocations.filter(
          (invocation) => invocation.kind === 'measured' && invocation.outcome === 'succeeded',
        ),
      ).toHaveLength(3);
      expect(new Set(physical.invocations.map((invocation) => invocation.id)).size).toBe(physical.invocations.length);
    } finally {
      restore();
      await db?.close();
      await f.close();
    }
  }, 300_000);
}
