import { expect, test } from 'bun:test';
import {
  createLibraryProfileMigrationRuntime,
  LIBRARY_PROFILE_MIGRATION_WORKFLOW,
  type LibraryProfileMigrationBoundary,
} from '../../src/library/profile-migration-runtime.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { createProfileEntryFixture, entryKey } from './support/profile-entry-fixture.ts';
import { createProfileMigrationObservation, ProfileMigrationCrash } from './support/profile-migration-observation.ts';

const boundaries: LibraryProfileMigrationBoundary[] = [
  'after-page-read-before-cas',
  'before-page-commit',
  'after-page-commit-before-ack',
  'before-owner-ready',
];

// Current commands supply the facts here. Historic DATA/receipts stay with the
// historical fixture owner; these cases isolate actual interruption boundaries.
for (const boundary of boundaries) {
  test(`native profile migration pauses once at ${boundary} without stopping unrelated writes`, async () => {
    const f = await createProfileEntryFixture();
    const client = await createWorkClient(process.env.DATABASE_URL!, f.pool);
    const observation = createProfileMigrationObservation();
    const runtime = createLibraryProfileMigrationRuntime({ pool: f.pool, client, observe: observation.observe });
    const accountId = f.other.actor.accountId;
    let running: Promise<unknown> | undefined;
    const pause = observation.pause(boundary);
    try {
      await f.grantLibraryGate(accountId);
      const subjectId = await f.createSubject('game');
      const initial = await runtime.start({ accountId, releaseDigest: f.originalDigest });
      const created = (await f.commands.putEntry(f.other.actor, subjectId, { state: 'planned' }, entryKey())).value
        .entry;
      running = runtime.resume({ accountId });
      await pause.reached;
      const persisted = await runtime.readProgress({ accountId });
      expect(persisted.phase).toBe(boundary === 'after-page-commit-before-ack' ? 'ready' : 'entry');
      // The named read boundary precedes all row/checkpoint CAS writes. A writer
      // on the SAME owner must finish, and its new revision/pin must survive retry.
      if (boundary === 'after-page-read-before-cas')
        await f.commands.putEntry(
          f.other.actor,
          subjectId,
          {
            state: 'playing',
            revision: created.revision,
            incarnationId: created.incarnationId!,
          },
          entryKey(),
        );
      await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey());
      const before = await f.inspect(accountId);
      await pause.resume();
      await running;
      expect((await runtime.readProgress({ accountId })).phase).toBe('ready');
      const after = await f.inspect(accountId);
      expect(after.entries).toEqual(before.entries);
      expect(after.receipts).toEqual(before.receipts);
      const committed = observation.attempts.filter(({ page }) => page.committed);
      expect(committed).toHaveLength(1);
      expect(committed[0]!.page.checkpointBefore).toEqual(initial);
      expect(committed[0]!.page.sources.map(({ phase }) => phase)).toEqual(['entry', 'session', 'copy']);
      expect(committed[0]!.page.sources[0]!.rows[0]!.id).toBe(subjectId);
      expect(committed[0]!.page.sources.flatMap(({ changedIds }) => changedIds)).toEqual([]);
    } finally {
      await pause.resume();
      await running?.catch(() => undefined);
      await client.close();
      await f.close();
    }
  }, 120_000);

  test(`native profile migration crash at ${boundary} recovers the persisted intent without a duplicate page`, async () => {
    const f = await createProfileEntryFixture();
    const client = await createWorkClient(process.env.DATABASE_URL!, f.pool);
    const observation = createProfileMigrationObservation();
    const runtime = createLibraryProfileMigrationRuntime({ pool: f.pool, client, observe: observation.observe });
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    const accountId = f.other.actor.accountId;
    try {
      await f.grantLibraryGate(accountId);
      const initial = await runtime.start({ accountId, releaseDigest: f.originalDigest });
      const subjectId = await f.createSubject('game');
      await f.commands.putEntry(f.other.actor, subjectId, { state: 'planned' }, entryKey());
      observation.crash(boundary);
      await expect(runtime.resume({ accountId })).rejects.toBeInstanceOf(ProfileMigrationCrash);
      expect(observation.attempts).toHaveLength(1);
      const committed = boundary === 'after-page-commit-before-ack';
      expect(observation.attempts[0]!.page.committed).toBe(committed);
      expect(await runtime.readProgress({ accountId })).toEqual(
        committed
          ? {
              ...initial,
              phase: 'ready',
              after: null,
            }
          : initial,
      );
      const before = await f.inspect(accountId);
      const env = workerTestEnv({
        DATABASE_URL: process.env.DATABASE_URL!,
        STRIPE_SECRET_KEY: 'sk_test_profile_boundaries',
        STRIPE_MANAGED_PAYMENTS: 'false',
        CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
        CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
      });
      worker = await startWorker(readWorkerConfig(env), undefined, env);
      await client
        .retrieveWorkflow(`${LIBRARY_PROFILE_MIGRATION_WORKFLOW}:${accountId}:${f.originalDigest}:entry:start`)
        .getResult();
      expect((await runtime.readProgress({ accountId })).phase).toBe('ready');
      const recovered = await f.inspect(accountId);
      expect(recovered.entries).toEqual(before.entries);
      expect(recovered.receipts).toEqual(before.receipts);
      // Replaying the completed checkpoint reaches no page/CAS/commit seam.
      await runtime.resume({ accountId });
      expect(observation.attempts).toHaveLength(1);
    } finally {
      await worker?.stop();
      await client.close();
      await f.close();
    }
  }, 120_000);
}
