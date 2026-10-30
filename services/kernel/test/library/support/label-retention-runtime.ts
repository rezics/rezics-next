import { readFileSync } from 'node:fs';
import type { AccountActor } from '../../../src/request/access.ts';
import { authoritativeTimeValue } from '../../../src/command/command.ts';
import { createLibraryCommandRunner } from '../../../src/library/command-support.ts';
import { createPersonalLabelCommands } from '../../../src/library/label-commands.ts';
import { setLabelAssignment } from '../../../src/library/label-assignment-store.ts';
import {
  readStoredLabelAssignment,
  unassignStoredLabelAssignment,
  restoreStoredLabelAssignment,
} from '../../../src/library/label-assignment-lifecycle-store.ts';
import { routeOf } from '../../../src/route/route.ts';
import { entryKey, type NativeProfileFixture } from './profile-entry-fixture.ts';
import { createPool } from '../../../src/database/pool.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { libraryWorkModule, LABEL_RETENTION_SCHEDULE } from '../../../src/library/work-module.ts';
import { observeRetentionQueries } from '../entry-retention-worker-runtime.ts';

/** Delivered assignment DAO inside the actual current owner-authorized Core runner, never a positive SQL insert. */
export async function assignment(
  f: NativeProfileFixture,
  actor: AccountActor,
  labelId: string,
  subjectId: string,
  clock: () => Date,
  operation: 'set' | 'unassign' | 'restore' = 'set',
) {
  const tuple = { route: routeOf(actor.accountId)!, accountId: actor.accountId, labelId, subjectId };
  const runner = createLibraryCommandRunner({ pool: f.pool, clock });
  return runner.ownAccount(
    actor,
    {
      action: 'library_entry:update',
      kind: `library_label.${operation}`,
      requestKey: entryKey(),
      input: { labelId, subjectId },
    },
    async (tx, command) => {
      const context = { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) };
      let value;
      if (operation === 'set') value = await setLabelAssignment(tx, tuple, context);
      else {
        const current = await readStoredLabelAssignment(tx, tuple);
        if (!current?.id) throw new Error('Missing real assignment identity');
        const expected = { ...tuple, assignmentId: current.id, revision: current.revision };
        value = await (operation === 'unassign' ? unassignStoredLabelAssignment : restoreStoredLabelAssignment)(
          tx,
          expected,
          context,
        );
      }
      if (value.kind !== 'applied' && value.kind !== 'existing')
        throw new Error(`Native assignment failed: ${value.kind}`);
      return {
        value,
        events: [{ type: 'com.rezics.library.label.changed.v1', subject: actor.accountId, data: { labelId } }],
      };
    },
  );
}
export async function label(
  f: NativeProfileFixture,
  actor: AccountActor,
  clock: () => Date,
  name = crypto.randomUUID(),
) {
  const commands = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens, clock });
  const made = await commands.createLabel(actor, { name }, entryKey());
  return { commands, id: made.value.label.id, revision: made.value.label.revision };
}

if (import.meta.main) {
  const [mode, executorId, timePath] = process.argv.slice(2);
  if (!executorId || !timePath) throw new Error('Runtime requires executor identity and clock file');
  const pool = createPool(process.env.DATABASE_URL!);
  const client = await createWorkClient(process.env.DATABASE_URL!);
  let parked = false;
  const changed = new WeakSet<object>();
  await observeRetentionQueries(pool, async ({ connection, sql, result }) => {
    if (/DELETE FROM library\.(?:personal_label|label_assignment)/i.test(sql) && result.rows.length)
      changed.add(connection);
    const source = mode === 'park' && /FROM library.personal_label WHERE route=\$1/i.test(sql) && result.rows.length;
    const commit = mode === 'crash' && changed.has(connection) && /^COMMIT$/i.test(sql.trim());
    if (/^(COMMIT|ROLLBACK)$/i.test(sql.trim())) changed.delete(connection);
    if (!parked && (source || commit)) {
      parked = true;
      console.log(source ? 'source-parked' : 'native-committed');
      await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
    }
  });
  const work = await composeWork([libraryWorkModule], {
    pool,
    client,
    databaseUrl: process.env.DATABASE_URL!,
    executorId,
    clock: () => new Date(Number(readFileSync(timePath, 'utf8'))),
    env: {},
  });
  await client.pauseSchedule(LABEL_RETENTION_SCHEDULE);
  await work.launch();
  console.log('worker-ready');
  process.once(
    'SIGTERM',
    () =>
      void (async () => {
        await work.shutdown();
        await client.close();
        await pool.end();
        process.exit(0);
      })(),
  );
}
