import { expect, test } from 'bun:test';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { createCopyCommands } from '../../src/library/copies.ts';
import * as facts from '../../src/library/entry-store.ts';
import * as progress from '../../src/library/progress-store.ts';
import {
  createLibraryProfileMigrationRuntime,
  LIBRARY_PROFILE_MIGRATION_WORKFLOW,
} from '../../src/library/profile-migration-runtime.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { observeRetentionQueries } from './entry-retention-worker-runtime.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

// Historical fixture only: the same old native command boundary used by
// profile-copy-compatibility.test.ts. No new production endpoint or NULL-pin default.
async function historical(f: NativeProfileFixture, subjectId: string) {
  const owner = await f.identity([
    'subject:read', 'library_entry:update', 'library_entry:read',
    'progress_session:read', 'copy:read', 'copy:update', 'copy:delete', 'account:delete',
  ]);
  await f.grantLibraryGate(owner.actor.accountId);
  const accountId = owner.actor.accountId;
  const route = routeOf(accountId)!;
  const sessionId = newId(route);
  const copyIds = [newId(route), newId(route)];
  const runner = createLibraryCommandRunner({ pool: f.pool });
  await runner.ownAccount(owner.actor, {
    action: 'library_entry:update', kind: 'fixture.pre-profile', requestKey: entryKey(), input: { subjectId },
  }, async (tx, command) => {
    const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
    await facts.insertEntry(tx, route, { accountId, subjectId, state: 'planned', requestedSubjectId: null }, context);
    await progress.insertSession(tx, route, {
      id: sessionId, accountId, subjectId, versionSubjectId: null,
      mode: 'completed_units', unit: 'chapter', total: null,
    }, context);
    await progress.addUnits(tx, route, sessionId, ['1', '3', '7'], context);
    await progress.updateSession(tx, route, sessionId, 1, {
      amount: null, locator: null, position: null, completedUnitCount: 3, state: 'active', completedAt: null,
    }, context);
    await progress.appendChange(tx, route, sessionId, 2, { add: ['1', '3', '7'] }, context);
    for (const id of copyIds) await facts.insertCopy(tx, route, {
      id, accountId, subjectId, status: 'owned', location: 'Shelf', source: null,
      acquiredOn: null, disposedOn: null, note: id,
    }, context);
    return { value: null, events: [{
      type: 'com.rezics.library.entry.updated.v1', subject: accountId, data: { subjectId },
    }] };
  });
  return { owner, accountId, route, sessionId, copyIds };
}

async function snapshot(f: NativeProfileFixture, accountId: string) {
  const state = await f.inspect(accountId);
  const sessions = await f.pool.query(
    `SELECT s.session_id, (SELECT jsonb_agg(u ORDER BY unit_id) FROM library.progress_unit u
      WHERE u.route=s.route AND u.session_id=s.session_id) AS units,
      (SELECT jsonb_agg(c ORDER BY change_no) FROM library.progress_change c
      WHERE c.route=s.route AND c.session_id=s.session_id) AS changes
     FROM library.progress_session s WHERE s.route=$1 AND s.account_id=$2`, [routeOf(accountId), accountId]);
  return { ...state, history: sessions.rows };
}
function withoutPins(rows: Array<{ row: Record<string, unknown> }>, copy = false) {
  return rows.map(({ row: { library_profile_pin: _pin, kind, ...row } }) => ({
    ...row, ...(copy ? {} : kind === undefined ? {} : { kind }),
  }));
}

test('Legacy Library profile migration has a real explicit default worker and owner-ready cutover', async () => {
  const f = await createProfileEntryFixture();
  const client = await createWorkClient(process.env.DATABASE_URL!, f.pool);
  const runtime = createLibraryProfileMigrationRuntime({ pool: f.pool, client });
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  try {
    const subjectId = await f.createSubject('game');
    const a = await historical(f, subjectId);
    const b = await historical(f, subjectId);
    const copies = createCopyCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
    const retained = await copies.deleteCopy(b.owner.actor, b.copyIds[0]!, 1, entryKey());
    const before = await snapshot(f, a.accountId);
    // Ordinary reads neither create a job nor require current profile inference.
    expect((await f.commands.readEntry(a.owner.actor, subjectId)).state).toBe('planned');
    expect((await runtime.readProgress({ accountId: a.accountId })).phase).toBe('legacy');
    const start = await runtime.start({ accountId: a.accountId, releaseDigest: f.originalDigest });
    expect(start).toMatchObject({ phase: 'entry', after: null, releaseDigest: f.originalDigest });
    await expect(runtime.start({ accountId: a.accountId, releaseDigest: f.replacementDigest })).rejects.toBeDefined();
    // Changing Global cannot change the already captured immutable destination.
    await f.activate(f.replacementDigest);
    let fault: 'before' | 'after' | null = 'before';
    let advanced = false;
    const consumed = new WeakMap<object, number>();
    const rawPages: number[] = [];
    await observeRetentionQueries(f.pool, ({ connection, sql, result }) => {
      if (/AS incompatible/i.test(sql)) {
        const total = (consumed.get(connection) ?? 0) + result.rows.length;
        consumed.set(connection, total);
        rawPages.push(total);
        expect(total).toBeLessThanOrEqual(100);
      }
      if (/^(COMMIT|ROLLBACK)$/i.test(sql.trim())) consumed.delete(connection);
      if (/SET profile_migration_phase =/i.test(sql)) {
        advanced = true;
        if (fault === 'before') { fault = null; throw new Error('fixture before native commit'); }
      }
      if (advanced && /^COMMIT$/i.test(sql.trim())) {
        advanced = false;
        if (fault === 'after') { fault = null; throw new Error('fixture after native commit'); }
      }
    });
    await expect(runtime.resume({ accountId: a.accountId })).rejects.toThrow('fixture before native commit');
    expect(await runtime.readProgress({ accountId: a.accountId })).toEqual(start);
    expect((await snapshot(f, a.accountId)).entries).toEqual(before.entries);
    // Current writer wins the row revision/pin; the migration must preserve that pin.
    const oldEntry = await f.commands.readEntry(a.owner.actor, subjectId);
    await f.commands.putEntry(a.owner.actor, subjectId, {
      state: 'planned', revision: oldEntry.revision, incarnationId: oldEntry.incarnationId!,
    }, entryKey());
    const fresh = await snapshot(f, a.accountId);
    fault = 'after';
    await expect(runtime.resume({ accountId: a.accountId })).rejects.toThrow('fixture after native commit');
    expect((await runtime.readProgress({ accountId: a.accountId })).phase).toBe('ready');
    expect((await runtime.resume({ accountId: a.accountId })).phase).toBe('ready');
    const after = await snapshot(f, a.accountId);
    expect(after.entries).toEqual(fresh.entries);
    expect(withoutPins(after.sessions)).toEqual(withoutPins(before.sessions));
    expect(withoutPins(after.copies, true)).toEqual(withoutPins(before.copies, true));
    expect(after.history).toEqual(before.history);
    expect(rawPages.some((rows) => rows === 4)).toBe(true);
    expect(after.receipts).toEqual(fresh.receipts);
    for (const { row } of [...after.sessions, ...after.copies]) expect(row.library_profile_pin).toEqual({
      provenance: 'legacy', releaseDigest: f.originalDigest, acceptingType: null, profileId: 'legacy-fixed-v1',
    });
    for (const { row } of after.copies) expect(row.kind).toBe('legacy-unspecified');
    await runtime.start({ accountId: b.accountId, releaseDigest: f.originalDigest });
    const env = workerTestEnv({ DATABASE_URL: process.env.DATABASE_URL!,
      STRIPE_SECRET_KEY: 'sk_test_profile_migration', STRIPE_MANAGED_PAYMENTS: 'false',
      CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
      CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel' });
    worker = await startWorker(readWorkerConfig(env), undefined, env);
    const workflowId = `${LIBRARY_PROFILE_MIGRATION_WORKFLOW}:${b.accountId}:${f.originalDigest}:entry:start`;
    await client.retrieveWorkflow(workflowId).getResult();
    expect((await runtime.readProgress({ accountId: b.accountId })).phase).toBe('ready');
    // The default worker also replays a committed old checkpoint without new receipts.
    const oldWorkflow = `${LIBRARY_PROFILE_MIGRATION_WORKFLOW}:${a.accountId}:${f.originalDigest}:entry:start`;
    await client.retrieveWorkflow(oldWorkflow).getResult();
    expect((await snapshot(f, a.accountId)).receipts).toEqual(after.receipts);
    await worker.stop();
    worker = undefined;
    const restored = await copies.restoreCopy(b.owner.actor, b.copyIds[0]!, {
      deletionId: retained.transactionId, revision: 2,
    }, entryKey());
    expect(restored.value).toMatchObject({ id: b.copyIds[0], kind: 'legacy-unspecified',
      note: b.copyIds[0], revision: 3, createdAt: retained.value.createdAt });
    const restoredPin = await facts.readCopyFact(f.pool, b.route, b.copyIds[0]!);
    expect(restoredPin?.pin).toMatchObject({ provenance: 'legacy', releaseDigest: f.originalDigest });
    await createLifecycleCommands({ pool: f.pool, access: f.access }).tombstone(
      { actor: b.owner.actor, deadline: deadlineFor(30_000) }, { accountId: b.accountId, key: entryKey() },
    );
    const terminal = await snapshot(f, b.accountId);
    await expect(runtime.resume({ accountId: b.accountId })).rejects.toBeDefined();
    await expect(runtime.start({ accountId: b.accountId, releaseDigest: f.originalDigest })).rejects.toBeDefined();
    expect(await snapshot(f, b.accountId)).toEqual(terminal);
    // Existing current owners never need a job before their facts are readable.
    expect((await runtime.readProgress({ accountId: f.owner.actor.accountId })).phase).toBe('ready');
  } finally {
    await worker?.stop();
    await client.close();
    await f.close();
  }
}, 120_000);
