import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { profileRequest, startWorkProfileSink, type WorkProfile } from '../support/work-profile.ts';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry }
  from '../../../packages/observability/src/runtime.ts';

test('explicit preparation retains one API-built store at three population cuts', async () => {
  // Instrument PostgreSQL before any application/driver import, as in the
  // existing request-profile workers. These are the existing meters.
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { root } = await import('../../../scripts/fixture/stack.ts');
  const { readEnv } = await import('../../../scripts/dev/config.ts');
  const { startMediaStack } = await import('../integration/media-support.ts');
  const { seedPublicProfileWork } = await import('../../../scripts/load/work-profile-work.ts');
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const { initializeRelayCheckpoint } = await import('../../../services/main/src/modules/outbox/relay.ts');
  const { grantFixtureAuthority } = await import('../../../services/main/src/modules/access/fixture-authority.ts');
  const { prepareWorkProfileCorpus, workProfileDimensions, WORK_PROFILE_SCALES }
    = await import('../../../scripts/load/work-profile-corpus.ts');
  const { seedDirectory, retainedSeedPath, seedAuthorName, seedApi, seedCensus,
    saveRetainedSeed, readRetainedSeed } = await import('../support/seed-checkpoints.ts');
  const { initializeSeedCheckpointPopulation, growSeedCheckpointPopulation }
    = await import('../support/seed-checkpoint-population.ts');
  type CorpusApi = import('../../../scripts/load/work-profile-corpus.ts').CorpusApi;
  type Recipe = import('../../../scripts/load/work-profile-corpus.ts').WorkProfileCorpusRecipe;
  type SeedWork = import('../support/seed-checkpoints.ts').SeedWork;
  type RetainedSeed = import('../support/seed-checkpoints.ts').RetainedSeed;
  type Population = import('../support/seed-checkpoint-population.ts').SeedCheckpointPopulation;
  type Targets = import('../support/seed-checkpoint-population.ts').SeedCheckpointPopulationTargets;
  const sourceRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!sourceRunId) throw new Error('Run the explicit seed BUILD through goalctl');
  let source: Awaited<ReturnType<typeof startMediaStack>> | undefined;
  let sourceStopped = false;
  try {
    if (existsSync(retainedSeedPath)) {
      try {
        const saved = readRetainedSeed();
        const { compatibleLoadStorage, loadCompatibility } = await import('../../../scripts/load/compatibility.ts');
        if (saved.cuts.every(cut => compatibleLoadStorage(cut.manifest.compatibility, loadCompatibility(root)))) {
          console.log('Reusing completed retained seed checkpoints', retainedSeedPath);
          return;
        }
      } catch { /* An incomplete earlier preparation is not a completed backup. */ }
    }
    const compose = readEnv(join(root, '.temp/stack', `rezics-qa-${sourceRunId}`, 'compose.env'));
    expect(compose.REZICS_STACK_STORAGE).toBe('persistent');
    const qaStarted = Number(Bun.env.REZICS_QA_PREPARATION_STARTED_AT);
    if (!Number.isSafeInteger(qaStarted)) throw new Error('QA must report initial preparation start');
    const startedAt = performance.now() - (Date.now() - qaStarted);
    let stageStartedAt = startedAt, stageStartupMs = performance.now() - startedAt;
    const openStarted = performance.now();
    source = await startMediaStack('seed-checkpoint-source', { library: true });
    stageStartupMs += performance.now() - openStarted;
    await initializeRelayCheckpoint(source.relayPool, Bun.env.MAIN_RELAY_CONSUMER!, source.env.lineage.dataEpoch);
    let member = await source.member(seedAuthorName, { stable: true, verified: true });
    let currentApi = seedApi(source, member.token);
    let actor = '', population: Population | undefined;
    const works: SeedWork[] = [];
    const measured: Array<{ operation: string; profile: WorkProfile }> = [];
    let scale: (typeof WORK_PROFILE_SCALES)[number] = 'small';
    const api: CorpusApi = {
      async command<T>(key, command, signal) {
        if (scale === 'large') return await currentApi.command<T>(key, command, signal);
        const result = await profileRequest(sink, headers => currentApi.command<T>(key,
          { ...command, headers: new Headers([...new Headers(command.headers), ...headers]) }, signal),
        { service: 'main', flush: flushTelemetryTraces });
        // Keep the first sixteen Works' command population, including the
        // fixed scenario setup and all co-grown populations in that cut.
        measured.push({ operation: `${command.method} ${command.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`,
          profile: result.profile });
        return result.result;
      },
      read: (path, signal) => currentApi.read(path, signal),
    };
    const fixed = { unrelatedWorks: 0, unrelatedPosts: 0, follows: 0, memberships: 0,
      historyDepth: 0, realmSize: 0, conceptVocabulary: 0 };
    const populations = ['recipeOccurrences', 'readerShelfEntries', 'mountedCollectionResources', 'zoneNavigationEntries'] as const;
    let stageBuildMs = 0;
    const recipe: Recipe = {
      version: 'public-population-checkpoints-v2', fixed, populations,
      async initialize(client, key) {
        if (actor) return;
        actor = (await client.command<{ agent: string }>(`${key}:author`, { method: 'POST',
          path: '/v1/agents', body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Checkpoint corpus author' } })).agent;
        population = await initializeSeedCheckpointPopulation(client, { actor,
          grant: (scope, action) => grantFixtureAuthority(source!.accessPool, { scope, requireDispatch: true,
            representations: [{ principalId: member.principalId, actor, action, lifetime: '7 days' }],
            grant: { actor, action, lifetime: '7 days' } }) });
      },
      async grow(client, dimension, index, key) {
        if (dimension === 'unrelatedWorks') {
          if (!works[index]) works[index] = await seedPublicProfileWork(client, key, { actingSubject: actor,
            title: `Checkpoint public Work ${index}`, body: `Checkpoint selected text ${index}` });
        } else if (index === 0) {
          const targets: Targets = { recipeOccurrences: population!.recipe.occurrences.length,
            readerShelfEntries: population!.shelfWorks.length, mountedCollectionResources: population!.collection.members.length,
            zoneNavigationEntries: population!.zone.mounts.length };
          targets[dimension as keyof Targets] = workProfileDimensions(dimension, scale, fixed)[dimension]!;
          await growSeedCheckpointPopulation(client, population!, works, targets);
        }
      },
      async verify(client) {
        const counts = await seedCensus(client, { works, population: population! });
        stageBuildMs = performance.now() - stageStartedAt - stageStartupMs;
        return counts;
      },
    };
    const retained: RetainedSeed = { format: 'seed-checkpoints-v2', sourceRunId, actor, cuts: [] };
    for (scale of WORK_PROFILE_SCALES) {
      if (scale !== 'small') { stageStartedAt = performance.now(); stageStartupMs = 0; }
      const driver = createCorpusBackupDriver({ sourceRunId, directory: join(seedDirectory, sourceRunId, 'backups'),
        resumeSource: scale !== 'large', onSourceStartup: ms => { stageStartupMs += ms; },
        async quiesce(signal) {
          signal.throwIfAborted();
          await source!.stop(); sourceStopped = true;
          return async () => {
            const resumeStarted = performance.now();
            Object.assign(Bun.env, readEnv(join(root, '.temp/stack', `rezics-qa-${sourceRunId}`, 'apps.env')));
            for (;;) {
              signal.throwIfAborted();
              try { await source!.objects('media/').initialize(); break; }
              catch (error) {
                if (!(error instanceof Error) || error.message !== 'cannot reach immutable object bucket') throw error;
                await Bun.sleep(100);
              }
            }
            source = await startMediaStack('seed-checkpoint-source', { library: true }); sourceStopped = false;
            member = await source.member(seedAuthorName, { stable: true, verified: true });
            currentApi = seedApi(source, member.token);
            stageStartupMs += performance.now() - resumeStarted;
          };
        },
        smokeRead: async () => { throw new Error('BUILD never restores'); },
      });
      const manifest = await prepareWorkProfileCorpus({ recipe, api, backups: driver, dimension: 'unrelatedWorks',
        scale, directory: join(seedDirectory, sourceRunId, 'manifests'), startedAt: stageStartedAt });
      const totalMs = performance.now() - stageStartedAt;
      expect(totalMs).toBeLessThan(600_000);
      const timing = { startupMs: stageStartupMs, buildMs: stageBuildMs,
        backupMs: totalMs - stageStartupMs - stageBuildMs, totalMs };
      retained.actor = actor;
      retained.cuts.push({ manifest, works: structuredClone(works), population: structuredClone(population!), timing });
      saveRetainedSeed(retained);
      console.log('retained seed stage seconds', scale, JSON.stringify(Object.fromEntries(
        Object.entries(timing).map(([key, value]) => [key.replace(/Ms$/, 'Seconds'), value / 1000]))));
      if (scale === 'medium') {
        writeFileSync(join(seedDirectory, 'command-cost-16.json'), JSON.stringify(measured, null, 2) + '\n');
        const groups = Map.groupBy(measured, item => item.operation);
        const median = (values: number[]) => {
          const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
          return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
        };
        const rows = [...groups].map(([operation, values]) => {
          if (values.some(item => item.profile.postgresStatements === null || item.profile.fusekiRequests === null
            || item.profile.unclassifiedFetches || item.profile.unobserved.some(gap => gap.endsWith('SQL descendants'))))
            throw new Error(`Incomplete existing request meters for ${operation}`);
          return { operation, count: values.length, ms: median(values.map(item => item.profile.totalLatencyMs)),
            sql: median(values.map(item => item.profile.postgresStatements!)),
            fuseki: median(values.map(item => item.profile.fusekiRequests!)) };
        }).sort((a, b) => b.ms - a.ms);
        const slowest = rows[0]!;
        mkdirSync(join(root, 'docs/goals/kernel/reports'), { recursive: true });
        writeFileSync(join(root, 'docs/goals/kernel/reports/seed-build-command-cost.md'),
          '| API operation class | Count | Median time (ms) | SQL statements / command (median) | Fuseki calls / command (median) |\n'
          + '| --- | ---: | ---: | ---: | ---: |\n'
          + rows.map(row => `| ${row.operation} | ${row.count} | ${row.ms.toFixed(1)} | ${row.sql} | ${row.fuseki} |`).join('\n')
          + `\n\nThe slowest class is ${slowest.operation}: median ${slowest.ms.toFixed(1)} ms, ${slowest.sql} SQL statements and ${slowest.fuseki} Fuseki calls per command. Measured while building the retained 16-Work cut (${sourceRunId}), using the existing request/work-profile instrumentation; counts include the fixed scenario setup and the 400-occurrence Recipe, 16-entry shelf, 16 mounts and 16 Collection resources.\n`);
      }
    }
    expect(works).toHaveLength(64);
    console.log('largest retained seed build seconds', retained.cuts[2]!.timing.totalMs / 1000,
      'total build workflow seconds', (performance.now() - startedAt) / 1000);
  } finally {
    if (source && !sourceStopped) await source.stop();
    await shutdownTelemetry();
    await sink.stop();
  }
}, 1_920_000);
