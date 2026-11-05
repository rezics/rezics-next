import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { nativeErasurePage } from '../src/erasure-native.ts';
import { failNativeQueries, nativeFixture, scopes } from './support/erasure-native.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../../kernel/test/support/growth.ts';

for (const axis of ['stages', 'effects', 'histories'] as const) {
  test(`a real held credential consumer page counts its terminal proof, producer fence, cleanup and checkpoint as unrelated native ${axis} grows`, async () => {
    const f = await nativeFixture();
    const selected: { id: string; receiptId: string; operationKey: string; effectRef: string; digest: string }[] = [];
    let template: Record<string, unknown> = {};
    const restore = failNativeQueries(f.pool, (sql) => sql.includes('INSERT INTO auth_native_credential_terminal'));
    try {
      // All measured pages come from real stages, sessions, native approvals and
      // account tombstones. The injected interruption rolls back the first proof
      // transaction; neither a test cursor nor a terminal marker selects the page.
      for (let run = 0; run < 6; run++) {
        const owner = await f.person(`growth-consumer-owner-${axis}-${run}`);
        const subject = await f.person(`growth-consumer-subject-${axis}-${run}`);
        const clientId = randomUUID();
        await f.host.service.internal.registerClient({ clientId, firstParty: true, scopes });
        await f.pool.query('UPDATE auth_client SET "userId"=$2 WHERE client_id=$1', [clientId, owner.accountId]);
        const session = await f.login(subject, clientId);
        const staged = await f.host.service.internal.stageCredentialEffect({
          key: randomUUID(),
          subjectAccountId: subject.accountId,
          headers: new Headers({ cookie: session.cookie }),
          credential: { kind: 'password', password: 'uncommitted growth native password' },
        });
        const receipt = (
          await f.pool.query('SELECT * FROM auth_effect_receipt WHERE effect_reference=$1', [staged.effectRef])
        ).rows[0]!;
        template = receipt;
        expect((await f.delete(owner)).status).toBe(503);
        const obligation = (await f.pool.query('SELECT id FROM auth_erasure WHERE account_id=$1', [owner.accountId]))
          .rows[0]!;
        selected.push({
          id: obligation.id,
          receiptId: receipt.receipt_id,
          operationKey: receipt.operation_key,
          effectRef: staged.effectRef,
          digest: receipt.effect_digest,
        });
      }
      await f.host.workflows.close();
    } catch (error) {
      restore();
      await f.close();
      throw error;
    }
    restore();
    const db = await openGrowthDatabase(f.fixture.url);
    const population: Population = {
      name: `native-consumer-${axis}`,
      hotPartition: 0,
      rows: ({ ordinal }) => {
        const key = `unrelated-native-${axis}-${String(ordinal).padStart(8, '0')}`;
        if (axis === 'stages')
          return {
            'public.auth_registration_stage': [
              {
                registration_id: key,
                request_key: key,
                handle: key,
                account_id: key,
                request_digest: Buffer.alloc(32, 1),
                ciphertext: Buffer.alloc(256, 2),
                credential_digest: Buffer.alloc(32, 3),
              },
            ],
          };
        if (axis === 'effects')
          return {
            'public.auth_effect_receipt': [
              { ...template, receipt_id: key, operation_key: key, effect_reference: key, client_id: 'erasure-web' },
            ],
          };
        return {
          'public.auth_workflow_request': [
            {
              workflow_id: key,
              digest: Buffer.alloc(32, 1),
              request: { key, nativeFixture: 'unrelated history payload' },
              erasure_human_id: template.acting_human_id,
              erasure_client_id: 'erasure-web',
            },
          ],
        };
      },
    };
    const operation = async (repetition: number) => {
      const row = selected[repetition]!;
      expect(await nativeErasurePage(db.pool, row.id)).toEqual({ id: row.id, state: 'more', code: 'client' });
      const proof = (
        await db.admin.query(
          'SELECT operation_key,effect_reference,effect_digest,outcome FROM auth_native_credential_terminal WHERE receipt_id=$1',
          [row.receiptId],
        )
      ).rows[0];
      expect(proof).toEqual({
        operation_key: row.operationKey,
        effect_reference: row.effectRef,
        effect_digest: row.digest,
        outcome: 'fenced-refusal',
      });
      expect(
        (await db.admin.query('SELECT 1 FROM auth_effect_receipt WHERE receipt_id=$1', [row.receiptId])).rowCount,
      ).toBe(0);
    };
    try {
      const report = await checkGrowth(db, {
        name: `native held consumer ${axis}`,
        scales: [256, 1024, 4096],
        repetitions: 1,
        warmups: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        byteBounds: { responseBytes: 'constant' },
        attempts: { commands: 1 },
        grow: (current, scale, previous) => seed(current, population, { from: previous, to: scale }),
        warmup: (_current, _scale, repetition) => operation(repetition),
        operation: (_current, _scale, repetition) => operation(repetition),
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
    } finally {
      await db.close();
      await f.close();
    }
  }, 300_000);
}
