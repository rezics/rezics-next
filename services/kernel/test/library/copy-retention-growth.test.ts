import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { routeOf } from '../../src/route/route.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import {
  assertGrowth,
  growthByteViolations,
  checkGrowth,
  costOf,
  medianCost,
  type Cost,
  openGrowthDatabase,
  seed,
  settle,
  type Capture,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';
import { statementOccurrences } from '../support/growth-report.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { copyRetentionRuntime } from './support/copy-retention-runtime.ts';

const scopes = ['subject:read', 'copy:create', 'copy:update', 'copy:delete', 'copy:read', 'copy:list'];
let db: GrowthDatabase, f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>, other: typeof owner, remote: typeof owner;
let commands: ReturnType<typeof createCopyCommands>;
let subjectId: string;
let now = Date.now();
const clock = () => new Date(now);
let runtime: Awaited<ReturnType<typeof copyRetentionRuntime>> | undefined;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool, clock, projectLinks: false });
  owner = await f.identity(scopes, 4095);
  other = await f.identity(scopes, 4095);
  remote = await f.identity(scopes, 4094);
  await f.activate(
    await f.publish(
      await compileCatalogue(
        fixture({
          id: 'fixture.copy-retention-growth',
          copies: { kinds: [{ id: 'installation', statuses: [{ id: 'licensed' }] }] },
        }),
      ),
    ),
  );
  subjectId = await f.createSubject('game');
  commands = createCopyCommands({ pool: db.pool, access: f.access, tokens: f.tokens, clock });
}, 120_000);
afterAll(async () => {
  await runtime?.close();
  await f?.close();
  await db?.close();
});
async function actor(person = owner) {
  return authenticateAccount(f.access, { pool: db.pool, deadline: deadlineFor(30_000) }, person.actor);
}
const input = () => ({ subjectId, kind: 'installation', status: 'licensed', note: 'native growth holding' });
async function grow(scale: number, previous: number) {
  await seed(
    db,
    {
      name: 'copy-retention-native-noise',
      hotPartition: 4095,
      async write(_target, { ordinal }) {
        // Every unrelated live/deleted identity and its provenance/receipts/outbox come
        // from the actual owning command, including other-owner and other-partition noise.
        const person = [owner, other, remote][ordinal % 3]!;
        const current = await actor(person);
        const item = await commands.createCopy(current, input(), entryKey());
        if (ordinal % 2 === 0) await commands.deleteCopy(current, item.value.id, item.value.revision, entryKey());
      },
    },
    { from: previous, to: scale },
  );
}

test('lifecycle point work stays constant at 64/512/4096 unrelated native live/deleted identities and histories', async () => {
  let currentActor = await actor();
  let selected = await commands.createCopy(currentActor, input(), entryKey());
  const sibling = await commands.createCopy(currentActor, input(), entryKey());
  await checkGrowth(db, {
    name: 'copy lifecycle native whole command',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(_db, scale, previous) {
      await grow(scale, previous);
    },
    async prepare() {
      currentActor = await actor();
    },
    async warmup() {
      currentActor = await actor();
      await exercise();
    },
    async operation() {
      await exercise();
    },
  });
  async function exercise() {
    const id = selected.value.id,
      before = selected.value.revision,
      key = entryKey();
    const d1 = await commands.deleteCopy(currentActor, id, before, key);
    expect((await commands.deleteCopy(currentActor, id, before, key)).replayed).toBe(true);
    const descriptor = { deletionId: d1.transactionId, revision: before + 1 };
    const undo = await commands.restoreCopy(currentActor, id, descriptor, entryKey());
    await expect(commands.restoreCopy(currentActor, id, descriptor, entryKey())).rejects.toMatchObject({
      code: 'copy_restore_occupied',
    });
    // Two different fresh commands compete for one current episode/revision.
    const results = await Promise.allSettled(
      [entryKey(), entryKey()].map((key) => commands.deleteCopy(currentActor, id, undo.value.revision, key)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('No native deletion won');
    await expect(commands.restoreCopy(currentActor, id, descriptor, entryKey())).rejects.toMatchObject({
      code: 'copy_restore_stale',
    });
    selected = await commands.restoreCopy(
      currentActor,
      id,
      { deletionId: winner.value.transactionId, revision: undo.value.revision + 1 },
      entryKey(),
    );
    expect((await commands.readCopy(currentActor, sibling.value.id)).revision).toBe(1);
  }
}, 240_000);

test('default durable due keysets and exact purge charge native SDK work at 64/512/4096 due and unrelated histories', async () => {
  runtime = await copyRetentionRuntime(now);
  const samples: GrowthSample[] = [];
  let previous = 0;
  const client = await createWorkClient(db.url, db.pool);
  try {
    for (const scale of [64, 512, 4096]) {
      await runtime.call('time', { time: now });
      await grow(scale, previous);
      previous = scale;
      const repetitions: Cost[] = [];
      // Match the shared harness: one native warm-up and five complete measured pages.
      for (let repetition = 0; repetition < 6; repetition++) {
        // Resume after the last already examined native due key. A fixed suffix of
        // eight identities proves one page independently of the growing due prefix.
        const checkpoint =
          (
            await db.admin.query(`SELECT restore_until::text AS "restoreUntil",route,copy_id AS "copyId"
        FROM library.copy WHERE partition_no=4095 AND deletion_id IS NOT NULL
        ORDER BY restore_until DESC,route DESC,copy_id DESC LIMIT 1`)
          ).rows[0] ?? null;
        now += 1000;
        const ids: string[] = [];
        for (let index = 0; index < 8; index++) {
          const current = await actor();
          const item = await commands.createCopy(current, input(), entryKey());
          ids.push(item.value.id);
          await commands.deleteCopy(current, item.value.id, 1, entryKey());
        }
        now += 720 * 60 * 60 * 1000;
        await runtime.call('time', { time: now });
        // Let the actual default relay consume seeded commands before measuring a
        // selected due page. No checkpoint, envelope or SDK result is manufactured.
        const relayDeadline = Date.now() + 30_000;
        for (const partition of [4094, 4095]) {
          for (;;) {
            const { rows } = await db.admin.query(
              `SELECT p.position <= COALESCE(c.position,0) AS caught_up
             FROM core.partition p LEFT JOIN core.consumer_checkpoint c
             ON c.partition_no=p.partition_no AND c.consumer='effects' WHERE p.partition_no=$1`,
              [partition],
            );
            if (rows[0]?.caught_up) break;
            if (Date.now() >= relayDeadline) throw new Error('Default effects relay did not drain native seed');
            await Bun.sleep(20);
          }
        }
        await settle(db, { analyze: true });
        const workflowId = entryKey();
        const native = (await runtime.call('capture', { partition: 4095, workflowId, checkpoint })) as Capture;
        const occurrences = statementOccurrences(native);
        // Actual shared per-occurrence accounting, including background SDK/queue work.
        const all = [...occurrences.statements, ...occurrences.backgroundStatements];
        const pages = all.filter((item) => item.statement.includes('copy-retention-page.sql'));
        expect(pages.length).toBeGreaterThan(0);
        for (const page of pages) {
          expect(page.rows).toBeLessThanOrEqual(8);
          expect(page.plans.length).toBeGreaterThan(0);
        }
        expect(all.filter((item) => /DELETE FROM library\.copy/.test(item.statement))).toHaveLength(8);
        for (const id of ids)
          expect(
            (await db.admin.query('SELECT copy_id FROM library.copy WHERE route=$1 AND copy_id=$2', [routeOf(id), id]))
              .rows,
          ).toEqual([]);
        const steps = (await client.listWorkflowSteps(workflowId))!;
        expect(steps.length).toBeLessThanOrEqual(20);
        for (const step of steps)
          expect(Buffer.byteLength(JSON.stringify(step.output ?? null))).toBeLessThanOrEqual(4096);
        const cost = costOf(native);
        // SDK/background costs remain charged; no cost subtraction or planner hints.
        if (repetition > 0)
          repetitions.push({
            ...cost,
            statements: cost.statements + (cost.backgroundStatements ?? 0),
            rows: cost.rows + (cost.backgroundRows ?? 0),
            blocks: cost.blocks + (cost.backgroundBlocks ?? 0),
            requestBytes: (cost.requestBytes ?? 0) + (cost.backgroundRequestBytes ?? 0),
            responseBytes: (cost.responseBytes ?? 0) + (cost.backgroundResponseBytes ?? 0),
          });
      }
      samples.push({ scale, cost: medianCost(repetitions) });
    }
    assertGrowth(samples, { rows: 'constant', statements: 'constant', blocks: 'logarithmic' });
    expect(growthByteViolations(samples, { requestBytes: 'constant', responseBytes: 'constant' })).toEqual([]);
  } finally {
    await client.close();
    await runtime.close();
    runtime = undefined;
  }
}, 240_000);
