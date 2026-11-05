import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { custodyFixture, scope, type CustodyFixture } from './command-custody-fixture.ts';
import { encodeLocator, decodeLocator } from '../../src/history/locator.ts';
import { partitionOf, routeOf, newId } from '../../src/route/route.ts';
import { advancePreferenceHistory } from '../../src/history/receipt.ts';
import { CommandResultErasedError } from '../../src/command/command.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
import { composeWork } from '../../src/work/registry.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { projectBatch } from '../../src/events/log.ts';

let f: CustodyFixture;
let actor: Awaited<ReturnType<CustodyFixture['auth']['person']>>;
let subject: Awaited<ReturnType<CustodyFixture['auth']['person']>>;
let unrelated: string;
let work: Awaited<ReturnType<typeof composeWork>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let jobId = '';
let partition: number;
const keys = new Map<string, string>();
beforeAll(async () => {
  f = await custodyFixture();
  actor = await f.auth.person('custody-growth-actor');
  subject = await f.auth.person('custody-growth-subject');
  partition = partitionOf(routeOf(subject.accountId)!);
  unrelated = newId(routeOf(subject.accountId)!);
  client = await createWorkClient(f.db.url);
  work = await composeWork([KERNEL_WORK_MODULES.find(({ name }) => name === 'preference_history')!], {
    pool: f.db.pool,
    client,
    databaseUrl: f.db.url,
  });
  // Register the default admission but do not dispatch: measured units drive its actual step.
  for (let i = 0; i < 128; i++) {
    const key = `growth-minimize-${i}`;
    await f.command(actor, key, scope(subject), undefined, partition);
    keys.set((await f.stored(actor, key, partition)).idempotency_key, key);
  }
  await f.preferences.setPreferences(await f.context(subject), {
    accountId: subject.accountId,
    key: 'growth-private-preference',
    expectedVersion: 0,
    shelf: { layouts: { 'urn:custody:growth-private': 'table' } },
  });
  await deletePersona({ pool: f.db.pool, auth: f.auth }, subject);
  await projectBatch(f.db.pool, {
    partition,
    consumer: 'custody_growth',
    envelopes: 64,
    async apply(envelopes) {
      const db = await f.db.pool.connect();
      try {
        await db.query('BEGIN');
        await work.effects.admit!(db, envelopes);
        await db.query('COMMIT');
        for (const envelope of envelopes)
          for (const event of envelope.events)
            if (
              event.type === 'com.rezics.access.account-tombstoned.v1' &&
              (event.data as { accountId: string }).accountId === subject.accountId
            )
              jobId = event.id;
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
    },
  });
  expect(jobId).not.toBe('');
}, 180_000);
afterAll(async () => {
  try {
    await work?.shutdown();
  } finally {
    try {
      await client?.close();
    } finally {
      await f?.close();
    }
  }
});
async function grow(_db: unknown, scale: number, previous: number) {
  // Only unrelated data is seeded. Both selected physical partitions grow; no empty-index shortcut.
  for (const selected of new Set([partition, partitionOf(routeOf(actor.accountId)!)])) {
    for (let i = previous; i < scale; i++) {
      const locator = encodeLocator({
        artifactType: 'command-receipt/v1',
        partitionNo: selected,
        principalKind: 'account',
        principalId: unrelated,
        commandKindId: 1,
        keyVersion: 0,
        keyToken: i.toString(16).padStart(64, '0'),
      });
      await f.db.admin.query(
        `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,
        idempotency_key,request_digest,epoch,position,transaction_id,response)
        VALUES($1,'account',$2,'unrelated.growth',$3,$4,1,0,$5,'{"unrelated":true}')`,
        [selected, unrelated, `unrelated-${i}`, Buffer.alloc(32), newId(routeOf(subject.accountId)!)],
      );
      await f.db.admin.query(
        `INSERT INTO core.history_locator(partition_no,account_route,account_id,artifact_type,locator,roles,minimizer_version)
        VALUES($1,$2,$3,'command-receipt/v1',$4,32,1)`,
        [selected, routeOf(unrelated), unrelated, Buffer.from(locator)],
      );
      await f.db.admin.query('INSERT INTO core.history_seal(partition_no,account_route,account_id) VALUES($1,$2,$3)', [
        selected,
        routeOf(unrelated),
        newId(routeOf(unrelated)!),
      ]);
    }
  }
}

test('custody success, denial, empty, rollback, replay, exact minimization and restart at 64/512/4096 unrelated local rows', async () => {
  let version = 0;
  let sequence = 0;
  let raw = '';
  const replayInput = {
    accountId: actor.accountId,
    key: 'growth-stable-replay',
    expectedVersion: 0,
    spoilerLevel: 1 as const,
  };
  await f.preferences.setPreferences(await f.context(actor), replayInput);
  version = 1;
  const prepare = async () => {
    const result = await f.db.admin.query(
      `SELECT locator FROM core.history_locator
      WHERE partition_no=$1 AND account_route=$2 AND account_id=$3 AND artifact_type='command-receipt/v1'
        AND state='pending' ORDER BY locator LIMIT 1`,
      [partition, routeOf(subject.accountId), subject.accountId],
    );
    expect(result.rows).toHaveLength(1);
    const locator = decodeLocator('command-receipt/v1', result.rows[0].locator);
    if (locator.artifactType !== 'command-receipt/v1') throw new Error('Unexpected artifact');
    const token = `rk1.${locator.keyVersion}.${Buffer.from(locator.keyToken, 'hex').toString('base64url')}`;
    raw = keys.get(token) ?? '';
    if (!raw) {
      expect(await advancePreferenceHistory(f.db.pool, jobId)).toBe('more');
      await prepare();
    }
  };
  const report = await checkGrowth(f.db, {
    name: 'native command custody and preference receipt lifecycle',
    scales: [64, 512, 4096],
    // Includes native authorization, source/fence, guard materialization/lock, bounded scope validation,
    // locator insertion, job/progress checkpoint, inverse proof and replay. Shared catalog classification.
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    indexProbes: 32,
    counted: {
      read(value) {
        return { scopeReferenceReads: (value as { scopeReferenceReads: number }).scopeReferenceReads };
      },
      bounds: { scopeReferenceReads: 'constant' },
      limits: { scopeReferenceReads: 32 },
    },
    grow,
    prepare,
    async operation() {
      let scopeReferenceReads = 0;
      const observedScope = () =>
        scope(actor, () => {
          scopeReferenceReads++;
        });
      const key = `growth-${sequence++}`;
      const response = await f.preferences.setPreferences(await f.context(actor), {
        accountId: actor.accountId,
        key,
        expectedVersion: version,
        spoilerLevel: version % 2 ? 2 : 1,
      });
      version = response.value.version;
      expect(response.replayed).toBe(false);
      await expect(
        f.preferences.setPreferences(await f.context(actor), {
          accountId: subject.accountId,
          key,
          expectedVersion: 0,
        }),
      ).rejects.toThrow();
      expect((await f.command(actor, key + '-empty', observedScope(), undefined, partition)).replayed).toBe(false);
      await expect(
        f.command(
          actor,
          key + '-rollback',
          observedScope(),
          async () => {
            throw new Error('growth-rollback');
          },
          partition,
        ),
      ).rejects.toThrow('growth-rollback');
      expect((await f.preferences.setPreferences(await f.context(actor), replayInput)).replayed).toBe(true);
      expect(await advancePreferenceHistory(f.db.pool, jobId)).toBe('more');
      // The production step opens a new connection and reloads its native cursor for every unit.
      await expect(f.command(actor, raw, scope(subject), undefined, partition)).rejects.toBeInstanceOf(
        CommandResultErasedError,
      );
      return { scopeReferenceReads };
    },
    async warmup(_db, scale, repetition) {
      await prepare();
      // Warm the same operation through the harness, with independent source artifacts.
      const key = `warm-${scale}-${repetition}`;
      const response = await f.preferences.setPreferences(await f.context(actor), {
        accountId: actor.accountId,
        key,
        expectedVersion: version,
        spoilerLevel: version % 2 ? 2 : 1,
      });
      version = response.value.version;
      await f.command(actor, key + '-empty', scope(actor), undefined, partition);
      await expect(
        f.command(
          actor,
          key + '-rollback',
          scope(actor),
          async () => {
            throw new Error('growth-rollback');
          },
          partition,
        ),
      ).rejects.toThrow();
      await f.preferences.setPreferences(await f.context(actor), replayInput);
      await advancePreferenceHistory(f.db.pool, jobId);
      await expect(f.command(actor, raw, scope(subject), undefined, partition)).rejects.toBeInstanceOf(
        CommandResultErasedError,
      );
    },
  });
  assertGrowthAccessPaths('command custody and receipt minimization', report.samples, [
    'core.receipt',
    'core.history_locator',
    'core.history_seal',
  ]);
  const selectedWork = report.samples.map(({ occurrenceRepetitions }) =>
    occurrenceRepetitions.map(({ statements }) => ({
      guards: statements.filter(({ statement }) => /(?:INTO|FROM) core\.history_seal/.test(statement)).length,
      locatorInserts: statements.filter(({ statement }) => /INSERT INTO core\.history_locator/.test(statement)).length,
      receiptWrites: statements.filter(({ statement }) => /(?:INSERT INTO|UPDATE) core\.receipt/.test(statement))
        .length,
      checkpoints: statements.filter(({ statement }) => /(?:INTO|UPDATE) core\.history_progress/.test(statement))
        .length,
    })),
  );
  const first = selectedWork[0]![0]!;
  expect(first.guards).toBeGreaterThan(0);
  expect(first.locatorInserts).toBeGreaterThan(0);
  expect(first.receiptWrites).toBeGreaterThan(0);
  expect(first.checkpoints).toBeGreaterThan(0);
  for (const repetitions of selectedWork) for (const counts of repetitions) expect(counts).toEqual(first);
}, 300_000);
