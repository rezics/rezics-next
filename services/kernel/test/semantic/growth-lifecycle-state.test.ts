import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { mintReadTime, type AuthoritativeTime } from '../../src/command/command.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import * as semantic from '../../src/semantic/index.ts';
import { checkGrowth } from '../support/growth.ts';
import { createGrowthDeletionFixture } from './support/deletion-fixture.ts';

let fixture: Awaited<ReturnType<typeof createGrowthDeletionFixture>>;
beforeAll(async () => {
  fixture = await createGrowthDeletionFixture();
});
afterAll(async () => {
  await fixture.close();
});
const person = () => fixture.person();
const proposal = (subject: string) => fixture.proposal(subject);

test('native lifecycle state and author locator stay bounded across unrelated proposal history', async () => {
  const { db, account, clock } = fixture;
  const subject = await person();
  const selected = await proposal(subject);
  const target = { kind: 'candidate' as const, subject, candidate: selected.candidate };
  const report = await checkGrowth(db, {
    name: 'semantic native state and author locator',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_database, scale, previous) {
      for (let i = previous; i < scale; i++) await proposal(subject);
    },
    async operation() {
      await withReadTransaction(db.pool, async (client) => {
        const nativeT = await mintReadTime(client, clock);
        const reader = Reflect.get(semantic, 'readSemanticLifecycle');
        expect(typeof reader, 'Semantic must expose its native state/owner evidence reader').toBe('function');
        const result = await (
          reader as (
            client: Pick<PoolClient, 'query'>,
            input: { target: typeof target; accountId: string; nativeT: AuthoritativeTime },
          ) => Promise<unknown>
        )(client, { target, accountId: account, nativeT });
        expect(result).toEqual({
          target,
          owner: { kind: 'write_basis', accountId: account },
          state: 'active',
          deletedAt: null,
          purgeAfter: null,
          held: false,
        });
      });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
});
