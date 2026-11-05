import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createSessionCommands } from '../../src/library/sessions.ts';
import { purgeOwnedGraphPage } from '../../src/library/erasure-owned-graph.ts';
import { routeOf } from '../../src/route/route.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { checkGrowth } from '../support/growth.ts';
import { testTokens } from '../support/test-kernel.ts';
import { createOwnedErasureFixture } from './support/erasure-worker.ts';

let f: Awaited<ReturnType<typeof createOwnedErasureFixture>>;
const scales = [16, 64, 256] as const;
const sessions = new Map<number, { accountId: string; ids: string[] }>();
let unrelatedTarget: { accountId: string; ids: string[] };
let growUnrelated: (scale: number, previous: number) => Promise<void>;
beforeAll(async () => {
  f = await createOwnedErasureFixture();
  const subjectId = await f.subject();
  const commands = createSessionCommands({ pool: f.db.pool, access: f.kernel.testAccess, tokens: testTokens() });
  const people = [f.people.alice, f.people.bob, f.people.orgOwner];
  for (const [index, scale] of scales.entries()) {
    const as = people[index]!;
    const actor = await f.kernel.testAccess.authenticate(as.bearer, { pool: f.db.pool, deadline: Date.now() + 5000 });
    const ids: string[] = [];
    // One warm-up and five consumable native repetitions; no post-T fabrication.
    for (let repetition = 0; repetition < 6; repetition++) {
      let session = (
        await commands.startSession(actor, { subjectId, mode: 'scalar_amount', unit: 'page' }, crypto.randomUUID())
      ).value;
      ids.push(session.id);
      for (let n = 1; n <= 100 + scale; n++)
        session = (
          await commands.recordProgress(
            actor,
            session.id,
            { revision: session.revision, amount: String(n) },
            crypto.randomUUID(),
          )
        ).value;
    }
    sessions.set(scale, { accountId: as.accountId, ids });
    if (index === 0) {
      const spare: string[] = [];
      for (let repetition = 0; repetition < 18; repetition++) {
        let session = (
          await commands.startSession(actor, { subjectId, mode: 'scalar_amount', unit: 'page' }, crypto.randomUUID())
        ).value;
        spare.push(session.id);
        for (let n = 1; n <= 100; n++)
          session = (
            await commands.recordProgress(
              actor,
              session.id,
              { revision: session.revision, amount: String(n) },
              crypto.randomUUID(),
            )
          ).value;
      }
      unrelatedTarget = { accountId: as.accountId, ids: spare };
    }
    await deletePersona(f.options, as);
  }
  const unrelated = f.people.staff;
  expect(routeOf(unrelated.accountId)! >>> 4).not.toBe(routeOf(unrelatedTarget.accountId)! >>> 4);
  const actor = await f.kernel.testAccess.authenticate(unrelated.bearer, {
    pool: f.db.pool,
    deadline: Date.now() + 5000,
  });
  let session = (
    await commands.startSession(actor, { subjectId, mode: 'scalar_amount', unit: 'page' }, crypto.randomUUID())
  ).value;
  growUnrelated = async (scale, previous) => {
    for (let n = previous + 1; n <= scale; n++)
      session = (
        await commands.recordProgress(
          actor,
          session.id,
          { revision: session.revision, amount: String(n) },
          crypto.randomUUID(),
        )
      ).value;
  };
}, 360000);
afterAll(async () => {
  await f?.close();
});

test('native terminal history page includes the entire command envelope and stays bounded across grown owner history at three legal scales', async () => {
  const report = await checkGrowth(f.db, {
    name: 'Library owned erasure history page',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    attempts: { commands: 1 },
    async grow() {},
    async operation(db, scale, repetition) {
      const source = sessions.get(scale)!;
      const parent = source.ids[repetition % 6]!;
      const result = await purgeOwnedGraphPage(db.pool, {
        accountId: source.accountId,
        kind: 'changes',
        parent,
        after: null,
        segment: 1000000 + repetition,
        ordinal: 0,
      });
      expect(result.removed).toBe(100);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512);
      return result;
    },
  });
  for (const sample of report.samples)
    for (const cost of sample.repetitions) {
      expect(cost.relations['library.progress_change']!.sequentialScans).toBe(0);
      expect(cost.relations['library.progress_session']!.sequentialScans).toBe(0);
    }
}, 300000);

test('native terminal child page ignores growing unrelated owners and partitions, including their receipts, outbox and source heads', async () => {
  const report = await checkGrowth(f.db, {
    name: 'Library owned erasure unrelated history',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    attempts: { commands: 1 },
    grow: (_db, scale, previous) => growUnrelated(scale, previous),
    async operation(db, _scale, repetition) {
      const parent = unrelatedTarget.ids[repetition]!;
      const result = await purgeOwnedGraphPage(db.pool, {
        accountId: unrelatedTarget.accountId,
        kind: 'changes',
        parent,
        after: null,
        segment: 2000000 + repetition,
        ordinal: 0,
      });
      expect(result.removed).toBe(100);
      return result;
    },
  });
  for (const sample of report.samples)
    for (const cost of sample.repetitions) expect(cost.relations['library.progress_change']!.sequentialScans).toBe(0);
}, 300000);
