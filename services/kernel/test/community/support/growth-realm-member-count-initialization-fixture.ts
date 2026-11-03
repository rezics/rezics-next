import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomUUID } from 'node:crypto';
import type { CommunityDriver, CommunityGrowth, Fixture } from '../../../../../specs/community-driver.ts';
import { composeWork } from '../../../src/work/registry.ts';
import { createWorkClient, type WorkClient } from '../../../src/work/client.ts';
import { communityWorkModule } from '../../../src/community/work.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import type { GrowthDatabase } from '../../support/growth.ts';
import { workerTestEnv } from '../../support/worker-env.ts';
import {
  closeCommunityDrivers,
  createCommunityDriver,
  worker,
} from '../community-driver.ts';

const SEGMENT_WORKFLOW = 'community.member-count.acceptance-segment';

export type RealmMemberCountInitializationFixture = {
  readonly driver: CommunityDriver;
  readonly accounts: Fixture;
  readonly growth: CommunityGrowth;
  readonly database: GrowthDatabase;
  readonly realmId: string;
  readonly route: number;
  readonly partition: number;
  readonly runSegment: (partition?: number) => Promise<boolean>;
  readonly stopComposer: () => Promise<void>;
  readonly close: () => Promise<void>;
};

/**
 * Binds the shared native Access/HTTP world and growth observer to the production
 * community work module. The test workflow only exposes the real registered step
 * so one selected segment can be measured without measuring its whole batch.
 */
export async function createRealmMemberCountInitializationFixture(): Promise<RealmMemberCountInitializationFixture> {
  let driver: CommunityDriver | undefined;
  let accounts: Fixture | undefined;
  let growth: CommunityGrowth | undefined;
  let database: GrowthDatabase | undefined;
  let client: WorkClient | undefined;
  let runtime: Awaited<ReturnType<typeof composeWork>> | undefined;
  let closing: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let registeredSegment: ((partition: number) => Promise<boolean>) | undefined;

  const stopComposer = () =>
    (stopPromise ??= (async () => {
      if (runtime) {
        await runtime.shutdown();
        runtime = undefined;
      }
      if (client) {
        await client.close();
        client = undefined;
      }
    })());

  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      for (const release of [
        stopComposer,
        async () => driver?.close(),
        closeCommunityDrivers,
      ]) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Realm member-count fixture cleanup failed');
    })());

  try {
    driver = await createCommunityDriver();
    accounts = await driver.provision();
    growth = await driver.growthFixture();
    database = growth.database;

    // The shared child worker handles setup commands. The measured runner uses the
    // same registered production module in-process with the observer's pool.
    await worker.stop();
    client = await createWorkClient(database.url, database.pool);

    const originalRegisterStep = DBOS.registerStep;
    const interceptedRegisterStep = (...args: Parameters<typeof DBOS.registerStep>) => {
      const step = originalRegisterStep.apply(DBOS, args);
      const options = args[1] as { name?: string } | undefined;
      if (options?.name === 'community.member-count.segment')
        registeredSegment = step as (partition: number) => Promise<boolean>;
      return step;
    };
    const dbos = DBOS as unknown as { registerStep: typeof DBOS.registerStep };
    dbos.registerStep = interceptedRegisterStep;
    try {
      runtime = await composeWork([communityWorkModule], {
        databaseUrl: database.url,
        executorId: `member-count-growth-${randomUUID()}`,
        pool: database.pool,
        client,
        env: workerTestEnv({ ...process.env, DATABASE_URL: database.url }),
      });
    } finally {
      dbos.registerStep = originalRegisterStep;
    }
    if (!registeredSegment) throw new Error('Production member-count segment was not registered');

    DBOS.registerWorkflow(
      async (partition: number) => registeredSegment!(partition),
      { name: SEGMENT_WORKFLOW },
    );
    await runtime.launch();

    const realmId = growth.realmId;
    const route = routeOf(realmId);
    if (route === null) throw new TypeError('Growth Realm has no route');

    const runSegment = async (partition = partitionOf(route)): Promise<boolean> => {
      if (!client) throw new Error('Member-count work client is closed');
      const handle = await client.enqueue<(partition: number) => Promise<boolean>>(
        {
          queueName: 'workflows',
          workflowName: SEGMENT_WORKFLOW,
          workflowID: randomUUID(),
        },
        partition,
      );
      return (await handle.getResult({ pollingIntervalMs: 10 })) ?? false;
    };

    return {
      driver,
      accounts,
      growth,
      database,
      realmId,
      route,
      partition: partitionOf(route),
      runSegment,
      stopComposer,
      close,
    };
  } catch (error) {
    await close().catch((cleanup) => {
      throw new AggregateError([error, cleanup], 'Realm member-count fixture setup and cleanup failed');
    });
    throw error;
  }
}
