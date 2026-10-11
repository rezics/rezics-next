import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { join } from 'node:path';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root } from '../../../scripts/fixture/stack.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import {
  createCorpusBackupDriver,
  type CorpusRestoreSmokeInput,
  type ManagedCorpusBackupDriver,
} from '../../../scripts/load/corpus-backup-driver.ts';
import {
  prepareWorkProfileCorpus,
  restoreWorkProfileCorpus,
  workProfileCorpusApi,
  workProfileCorpusId,
  type CorpusDimensions,
  type WorkProfileCorpusRecipe,
} from '../../../scripts/load/work-profile-corpus.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { startMediaStack } from './media-support.ts';

const fixed: CorpusDimensions = {
  unrelatedWorks: 0,
  unrelatedPosts: 0,
  follows: 0,
  memberships: 0,
  historyDepth: 0,
  realmSize: 0,
  conceptVocabulary: 0,
};

function apiFor(stack: Awaited<ReturnType<typeof startMediaStack>>, token: string) {
  return workProfileCorpusApi('http://main.local', token, {
    fetch: ((input, init) => stack.main.handle(new Request(input, init))) as typeof fetch,
  });
}

async function openRestoredStack(input: CorpusRestoreSmokeInput) {
  const env = {
    ...input.apps,
    REZICS_QA_RUN_ID: input.runId,
    REZICS_QA_STACK_MODE: 'scale',
    REZICS_QA_STACK_TIER: 'integration',
    REZICS_STACK_PROFILE: 'qa',
  };
  const previous = new Map(Object.keys(env).map((key) => [key, Bun.env[key]]));
  Object.assign(Bun.env, env);
  try {
    return await startMediaStack(`profile-corpus-restore-${input.target}`, {
      library: true,
      ownerUrls: {
        access: input.apps.ACCESS_DATABASE_URL!,
        content: input.apps.CONTENT_DATABASE_URL!,
        relay: input.apps.ACCOUNT_RELAY_DATABASE_URL!,
      },
    });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}

test('work profile corpus restores two isolated copies after API preparation', async () => {
  const sourceRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!sourceRunId || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL)
    throw new Error('Run through goalctl integration QA');
  const sourceDirectory = join(root, '.temp/stack', `rezics-qa-${sourceRunId}`);
  const compose = readEnv(join(sourceDirectory, 'compose.env'));
  if (compose.REZICS_STACK_STORAGE !== 'persistent')
    throw new Error('Profile corpus stopped copies require the persistent catalogue-disk QA project');

  const source = await startMediaStack('profile-corpus-source', { library: true });
  const sourceRelay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  let sourceStopped = false;
  let relayClosed = false;
  const restores = new Map<string, Awaited<ReturnType<typeof startMediaStack>>>();
  const works: Awaited<ReturnType<typeof seedPublicProfileWork>>[] = [];
  const commandCounts = { initialize: 0, grow: 0, quiesce: 0 };
  let checkpoint: Awaited<ReturnType<typeof prepareWorkProfileCorpus>> | undefined;
  let actor = '';
  let driver: ManagedCorpusBackupDriver | undefined;

  try {
  const member = await source.member('profile-corpus-author', { stable: true, verified: true });
  await initializeRelayCheckpoint(
    sourceRelay,
    Bun.env.MAIN_RELAY_CONSUMER!,
    source.env.lineage.dataEpoch,
  );
  const api = apiFor(source, member.token);
  const recipe: WorkProfileCorpusRecipe = {
    version: 'public-work-profile-v1',
    fixed,
    async initialize(client, key) {
      commandCounts.initialize++;
      const author = await client.command<{ agent: string }>(`${key}:author`, {
        method: 'POST',
        path: '/v1/agents',
        body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Profile corpus author' },
      });
      actor = author.agent;
    },
    async grow(client, dimension, index, key) {
      expect(dimension).toBe('unrelatedWorks');
      commandCounts.grow++;
      works[index] = await seedPublicProfileWork(client, key, {
        actingSubject: actor,
        title: `Profile corpus public Work ${index}`,
        body: `Profile corpus selected text ${index}`,
      });
    },
    async verify(client) {
      for (const [index, created] of works.entries()) {
        const selected = await client.read<{
          contribution: string;
          selectedDraft: string;
          body: string;
        }>(`/v1/main-versions/${created.mainVersion.slice(-36)}/selection?language=en`);
        expect(selected).toMatchObject({
          contribution: created.contribution,
          selectedDraft: created.draftRevision,
          body: `Profile corpus selected text ${index}`,
        });
      }
      const titles: string[] = [];
      let cursor: string | null = null;
      do {
        const query = new URLSearchParams({ limit: '20' });
        if (cursor) query.set('cursor', cursor);
        const page = await client.read<{
          items: { title: { value: string } }[];
          nextCursor: string | null;
        }>(`/v1/works?${query}`);
        titles.push(
          ...page.items
            .map(({ title }) => title.value)
            .filter((title) => title.startsWith('Profile corpus public Work ')),
        );
        cursor = page.nextCursor;
      } while (cursor);
      const expectedTitles = works.map((_, index) => `Profile corpus public Work ${index}`);
      expect(titles.sort()).toEqual(expectedTitles.sort());
      return { ...fixed, unrelatedWorks: titles.length };
    },
  };

  const backupDriver = createCorpusBackupDriver({
    sourceRunId,
    directory: `${root}/.temp/work-profiles/profile-corpus-restore/backups`,
    resumeSource: false,
    async quiesce(signal) {
      signal.throwIfAborted();
      commandCounts.quiesce++;
      if (!relayClosed) {
        await sourceRelay.end();
        relayClosed = true;
      }
      if (!sourceStopped) {
        await source.stop();
        sourceStopped = true;
      }
    },
    async smokeRead(input) {
      const restored = await openRestoredStack(input);
      restores.set(input.target, restored);
      try {
        const restoredMember = await restored.member('profile-corpus-author', {
          stable: true,
          verified: true,
        });
        const restoredApi = apiFor(restored, restoredMember.token);
        if (works.length === 0) {
          const buildId = workProfileCorpusId(recipe, 'unrelatedWorks', 'small');
          const key = `${buildId}:base`;
          await recipe.initialize(restoredApi, key);
          for (let index = 0; index < checkpoint!.dimensions.unrelatedWorks; index++) {
            await recipe.grow(
              restoredApi,
              'unrelatedWorks',
              index,
              `${buildId}:unrelatedWorks:${index}`,
            );
          }
        }
        const actual = await recipe.verify(restoredApi);
        expect(actual).toEqual(checkpoint!.dimensions);
        return async () => {
          restores.delete(input.target);
          await restored.stop();
        };
      } catch (error) {
        restores.delete(input.target);
        await restored.stop();
        throw error;
      }
    },
  });
  driver = backupDriver;

    const corpusDirectory = `${root}/.temp/work-profiles/profile-corpus-restore/manifests`;
    const input = {
      recipe,
      api,
      backups: backupDriver,
      dimension: 'unrelatedWorks' as const,
      scale: 'small' as const,
      directory: corpusDirectory,
    };
    checkpoint = await prepareWorkProfileCorpus(input);
    expect(checkpoint.dimensions.unrelatedWorks).toBe(4);
    if (works.length > 0) expect(await recipe.verify(api)).toEqual(checkpoint.dimensions);

    const beforeReuse = { ...commandCounts };
    expect(await prepareWorkProfileCorpus(input)).toEqual(checkpoint);
    expect(commandCounts).toEqual(beforeReuse);
    expect(commandCounts.initialize).toBeLessThanOrEqual(1);
    expect(commandCounts.grow).toBeLessThanOrEqual(4);
    expect(commandCounts.quiesce).toBeLessThanOrEqual(1);

    const firstTarget = 'profile-corpus-copy-one';
    const firstStarted = performance.now();
    const firstMs = await restoreWorkProfileCorpus(checkpoint, firstTarget, backupDriver, firstStarted);
    console.log(`profile-corpus restore target=${firstTarget} elapsedMs=${Math.round(firstMs)}`);
    expect(firstMs).toBeLessThan(600_000);

    const secondTarget = 'profile-corpus-copy-two';
    const secondStarted = performance.now();
    const secondMs = await restoreWorkProfileCorpus(checkpoint, secondTarget, backupDriver, secondStarted);
    console.log(`profile-corpus restore target=${secondTarget} elapsedMs=${Math.round(secondMs)}`);
    expect(secondMs).toBeLessThan(600_000);

    const first = restores.get(firstTarget)!;
    const second = restores.get(secondTarget)!;
    const writer = await first.member('isolated-profile-writer', { verified: true });
    const writerApi = apiFor(first, writer.token);
    const author = await writerApi.command<{ agent: string }>('isolated-profile-writer:agent', {
      method: 'POST',
      path: '/v1/agents',
      body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Isolated profile writer' },
    });
    const created = await seedPublicProfileWork(writerApi, 'isolated-profile-writer:work', {
      actingSubject: author.agent,
      title: 'Isolated profile copy write',
      body: 'Only the first restored copy contains this work',
    });
    const selectionPath = `/v1/main-versions/${created.mainVersion.slice(-36)}/selection?language=en`;
    expect(await writerApi.read<{ body: string }>(selectionPath)).toMatchObject({
      body: 'Only the first restored copy contains this work',
    });
    await expect(
      apiFor(second, (await second.member('profile-corpus-reader', { verified: true })).token).read(
        selectionPath,
      ),
    ).rejects.toThrow('HTTP 404');
    expect(await recipe.verify(apiFor(second, (await second.member('profile-corpus-author', {
      stable: true,
      verified: true,
    })).token))).toEqual(checkpoint.dimensions);
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const target of ['profile-corpus-copy-one', 'profile-corpus-copy-two']) {
      try {
        await driver?.stop(target);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!relayClosed) {
      try {
        await sourceRelay.end();
        relayClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!sourceStopped) {
      try {
        await source.stop();
        sourceStopped = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Profile corpus test cleanup failed');
  }
}, 420_000);
