import { createWorkClient } from '../../../src/work/client.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { libraryWorkModule } from '../../../src/library/work-module.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './profile-entry-fixture.ts';

export type PublishedLogRetentionRuntime = Awaited<ReturnType<typeof createPublishedLogRetentionRuntime>>;

/** A real Library worker and native HTTP fixture; cleanup belongs to this fixture instance. */
export async function createPublishedLogRetentionRuntime(clock: () => Date) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
  let fixture: NativeProfileFixture | undefined;
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let worker: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    fixture = await createProfileEntryFixture({ clock });
    client = await createWorkClient(databaseUrl);
    worker = await composeWork([libraryWorkModule], {
      pool: fixture.pool,
      client,
      databaseUrl,
      clock,
      env: {},
    });
    await worker.launch();
    return {
      fixture,
      client,
      worker,
      async close() {
        await worker?.shutdown();
        await client?.close();
        await fixture?.close();
      },
    };
  } catch (error) {
    await worker?.shutdown();
    await client?.close();
    await fixture?.close();
    throw error;
  }
}
