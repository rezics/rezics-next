import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SEED_AXES, seedCheckpointPlan } from '../support/seed-checkpoint-plan.ts';
import { WORK_PROFILE_SEED_BUILD_WALL_MS } from '../../../scripts/qa/preparation-selection.ts';
import { readRetainedPostgresCollations, type RetainedCollation } from '../../../scripts/fixture/runtime-facts.ts';
import { seedSpecification } from '../support/seed-specification.ts';
import { preflightSeedCheckpoints } from '../../../scripts/qa/seed-preflight.ts';
import { profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry }
  from '../../../packages/observability/src/runtime.ts';

test('explicit preparation retains one API-built store across six independent population series', async () => {
  console.log('seed BUILD host load start', loadavg());
  // Instrument PostgreSQL before any application/driver import, as in the
  // existing request-profile workers. These are the existing meters.
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { root, dockerEnvironment } = await import('../../../scripts/fixture/stack.ts');
  const { runQaStartupChildAsync } = await import('../../../scripts/qa/stack-startup.ts');
  const { readEnv } = await import('../../../scripts/dev/config.ts');
  const { startMediaStack } = await import('../integration/media-support.ts');
  const { Pool } = await import('pg');
  const { seedPublicProfileWork } = await import('../../../scripts/load/work-profile-work.ts');
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const { initializeRelayCheckpoint } = await import('../../../services/main/src/modules/outbox/relay.ts');
  const { grantFixtureAuthority } = await import('../../../services/main/src/modules/access/fixture-authority.ts');
  const { prepareWorkProfileCorpus, workProfileDimensions, WORK_PROFILE_SCALES }
    = await import('../../../scripts/load/work-profile-corpus.ts');
  const { seedDirectory, retainedSeedPath, seedAuthorName, seedApi, seedCensus, acquireSeedBuildLock,
    buildSeedCommandCostReport, buildSeedCommandCostComparison, saveRetainedSeed, readRetainedSeed } = await import('../support/seed-checkpoints.ts');
  const { initializeSeedCheckpointPopulation, growSeedCheckpointPopulation }
    = await import('../support/seed-checkpoint-population.ts');
  const { seedCheckpointPost } = await import('../support/seed-checkpoint-post.ts');
  type CorpusApi = import('../../../scripts/load/work-profile-corpus.ts').CorpusApi;
  type CorpusCommand = import('../../../scripts/load/work-profile-corpus.ts').CorpusCommand;
  type Recipe = import('../../../scripts/load/work-profile-corpus.ts').WorkProfileCorpusRecipe;
  type SeedWork = import('../support/seed-checkpoints.ts').SeedWork;
  type SeedPost = import('../support/seed-checkpoints.ts').SeedPost;
  type RetainedSeed = import('../support/seed-checkpoints.ts').RetainedSeed;
  type SeedCommandMeasurement = import('../support/seed-checkpoints.ts').SeedCommandMeasurement;
  type SeedCommandCostStage = import('../support/seed-checkpoints.ts').SeedCommandCostStage;
  type SeedCommandCostRow = import('../support/seed-checkpoints.ts').SeedCommandCostRow;
  type Population = import('../support/seed-checkpoint-population.ts').SeedCheckpointPopulation;
  type Targets = import('../support/seed-checkpoint-population.ts').SeedCheckpointPopulationTargets;
  const sourceRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!sourceRunId) throw new Error('Run the explicit seed BUILD through goalctl');
  const costJsonFiles = ['command-cost-4.json', 'command-cost-16.json', 'command-cost-64.json'];
  const costMarkdownFiles = ['command-cost-4.md', 'command-cost-16.md', 'command-cost-64.md', 'command-cost-compare.md'];
  const commandCostReportPaths = costMarkdownFiles.map(name => join(seedDirectory, name));
  let source: Awaited<ReturnType<typeof startMediaStack>> | undefined;
  let sourceStopped = false;
  let releaseSeedBuildLock: (() => void) | undefined;
  try {
    releaseSeedBuildLock = acquireSeedBuildLock(sourceRunId);
    if (existsSync(retainedSeedPath)) {
      try {
        const saved = readRetainedSeed();
        const { compatibleLoadStorage, loadCompatibility } = await import('../../../scripts/load/compatibility.ts');
        const costEvidenceComplete = [...costJsonFiles, ...costMarkdownFiles]
          .every(name => existsSync(join(seedDirectory, name)))
          && costMarkdownFiles.every(name => readFileSync(join(seedDirectory, name), 'utf8')
            .includes(`Build run ID: ${saved.sourceRunId}`));
        if (Object.values(saved.axes).flat().every(cut => compatibleLoadStorage(cut.manifest.compatibility, loadCompatibility(root)))
          && costEvidenceComplete && saved.custody) {
          preflightSeedCheckpoints(root);
          console.log('Reusing completed retained seed checkpoints', retainedSeedPath);
          console.log('seed command-cost report paths', JSON.stringify(commandCostReportPaths));
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
    const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
    try { await initializeRelayCheckpoint(relay, Bun.env.MAIN_RELAY_CONSUMER!, source.env.lineage.dataEpoch); }
    finally { await relay.end(); }
    let member = await source.member(seedAuthorName, { stable: true, verified: true });
    let currentApi = seedApi(source, member.token);
    let actor = '', population: Population | undefined;
    const works: SeedWork[] = [];
    const posts: SeedPost[] = [];
    let measured: SeedCommandMeasurement[] = [];
    let scale: (typeof WORK_PROFILE_SCALES)[number] = 'small';
    const api: CorpusApi = {
      async command<T>(key: string, command: CorpusCommand, signal?: AbortSignal) {
        const result = await profileRequest(sink, headers => currentApi.command<T>(key,
          { ...command, headers: new Headers([...new Headers(command.headers), ...headers]) }, signal),
        { service: 'main', flush: flushTelemetryTraces });
        measured.push({ operation: `${command.method} ${command.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`,
          profile: result.profile });
        return result.result;
      },
      read: (path, signal) => currentApi.read(path, signal),
    };
    const stageCostRows: Record<SeedCommandCostStage, SeedCommandCostRow[]> = { '4': [], '16': [], '64': [] };
    let stageBuildMs = 0;
    let stage = seedCheckpointPlan()[0]!;
    const recipe: Recipe = {
      ...seedSpecification, fixed: stage.fixed,
      async initialize(client, key) {
        if (actor) return;
        actor = (await client.command<{ agent: string }>(`${key}:author`, { method: 'POST',
          path: '/v1/agents', body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Checkpoint corpus author' } })).agent;
        population = await initializeSeedCheckpointPopulation(client, { actor,
          grant: (scope, action) => grantFixtureAuthority(source!.accessPool, { scope, requireDispatch: true,
            representations: [{ principalId: member.principalId, actor, action, lifetime: '7 days' }],
            grant: { actor, action, lifetime: '7 days' } }) });
        for (let index = 0; index < 4; index++) posts.push(await seedCheckpointPost(client, actor, index));
        await growSeedCheckpointPopulation(client, population, { recipeOccurrences: 100,
          readerShelfEntries: 4, mountedCollectionResources: 4, zoneNavigationEntries: 4 });
      },
      async grow(client, dimension, index, key) {
        if (dimension === 'unrelatedWorks') {
          if (!works[index]) works[index] = await seedPublicProfileWork(client, key, { actingSubject: actor,
            title: `Checkpoint public Work ${index}`, body: `Checkpoint selected text ${index}` });
        } else if (dimension === 'unrelatedPosts') {
          if (!posts[index]) posts[index] = await seedCheckpointPost(client, actor, index);
        } else if (index === 0) {
          const targets: Targets = { recipeOccurrences: population!.recipe.occurrences.length,
            readerShelfEntries: population!.shelfWorks.length, mountedCollectionResources: population!.collection.members.length,
            zoneNavigationEntries: population!.zone.mounts.length };
          targets[dimension as keyof Targets] = workProfileDimensions(dimension, scale, stage.fixed)[dimension]!;
          await growSeedCheckpointPopulation(client, population!, targets);
        }
      },
      async verify(client) {
        const counts = await seedCensus(client, { works, posts, population: population! });
        stageBuildMs = performance.now() - stageStartedAt - stageStartupMs;
        return counts;
      },
    };
    const retained: RetainedSeed = { format: 'seed-checkpoints-v3', sourceRunId, actor, cuts: [],
      axes: { unrelatedWorks: [], unrelatedPosts: [], zoneNavigationEntries: [],
        mountedCollectionResources: [], readerShelfEntries: [], recipeOccurrences: [] } };
    const plan = seedCheckpointPlan();
    let resumeWriter: ((signal: AbortSignal) => Promise<void>) | undefined;
    for (const [ordinal, planned] of plan.entries()) {
      stage = planned;
      scale = stage.scale;
      recipe.fixed = stage.fixed;
      let collations: RetainedCollation[] | undefined;
      measured = [];
      let admissionWaitMs = 0;
      if (ordinal > 0) {
        const startupStarted = performance.now();
        if (sourceStopped) {
          const startup = await runQaStartupChildAsync(root, ['stack:up', '--profile', 'qa',
            '--run-id', sourceRunId, '--persistent'], 180_000, dockerEnvironment());
          if (!startup.ok) throw new Error(`Retained seed source startup failed: ${startup.output.slice(-2000)}`);
          admissionWaitMs = startup.admissionWaitMs;
          await resumeWriter!(AbortSignal.timeout(Math.max(1, 600_000 - startup.activeElapsedMs)));
        }
        stageStartedAt = startupStarted + admissionWaitMs;
        stageStartupMs = performance.now() - stageStartedAt;
      }
      const driver = createCorpusBackupDriver({ sourceRunId, directory: join(seedDirectory, sourceRunId, 'backups'),
        // The completed cut ends stopped. Restart for the next stage through
        // ordinary admission before starting its active preparation deadline.
        resumeSource: false,
        async quiesce(signal) {
          signal.throwIfAborted();
          const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, connectionTimeoutMillis: 2_000 });
          try { collations = await readRetainedPostgresCollations(sql => pool.query(sql)); }
          finally { await pool.end(); }
          await source!.stop(); sourceStopped = true;
          resumeWriter = async resumeSignal => {
            Object.assign(Bun.env, readEnv(join(root, '.temp/stack', `rezics-qa-${sourceRunId}`, 'apps.env')));
            for (;;) {
              resumeSignal.throwIfAborted();
              try { await source!.objects('media/').initialize(); break; }
              catch (error) {
                if (!(error instanceof Error) || error.message !== 'cannot reach immutable object bucket') throw error;
                await Bun.sleep(100);
              }
            }
            source = await startMediaStack('seed-checkpoint-source', { library: true }); sourceStopped = false;
            member = await source.member(seedAuthorName, { stable: true, verified: true });
            currentApi = seedApi(source, member.token);
          };
          return () => resumeWriter!(signal);
        },
        smokeRead: async () => { throw new Error('BUILD never restores'); },
      });
      // The small cut of each next series is the previous stopped large cut.
      // Reuse its immutable backup instead of stopping/copying identical owners.
      const previous = ordinal > 0 && scale === 'small'
        ? retained.axes[plan[ordinal - 1]!.axis].at(-1) : undefined;
      const backups = previous ? { ...driver, backup: async () => previous.manifest.backup } : driver;
      const manifest = await prepareWorkProfileCorpus({ recipe, api, backups, dimension: stage.axis,
        scale, directory: join(seedDirectory, sourceRunId, 'manifests'), startedAt: stageStartedAt });
      const totalMs = performance.now() - stageStartedAt;
      expect(totalMs).toBeLessThan(600_000);
      const timing = { startupMs: stageStartupMs, buildMs: stageBuildMs, admissionWaitMs,
        backupMs: totalMs - stageStartupMs - stageBuildMs, totalMs };
      retained.actor = actor;
      retained.axes[stage.axis].push({ manifest, works: structuredClone(works), posts: structuredClone(posts),
        population: structuredClone(population!), timing, collations });
      console.log('retained seed stage seconds', stage.axis, scale, JSON.stringify(Object.fromEntries(
        Object.entries(timing).map(([key, value]) => [key.replace(/Ms$/, 'Seconds'), value / 1000]))));
      const stageKey = ({ small: '4', medium: '16', large: '64' } as const)[scale];
      const reportKey = stage.axis === 'unrelatedWorks' ? stageKey : `${stage.axis}-${stageKey}`;
      const jsonPath = join(seedDirectory, `command-cost-${reportKey}.json`);
      const markdownPath = join(seedDirectory, `command-cost-${reportKey}.md`);
      writeFileSync(jsonPath, JSON.stringify(measured, null, 2) + '\n');
      const report = buildSeedCommandCostReport(measured);
      if (stage.axis === 'unrelatedWorks') stageCostRows[stageKey] = report.rows;
      const interval = ordinal === 0 ? 'Includes initial scenario setup.'
        : scale === 'small' ? 'Reuses the previous stopped cut; no population commands.'
          : `Commands issued while growing ${stage.axis} to ${manifest.dimensions[stage.axis]}.`;
      writeFileSync(markdownPath, `# ${stage.axis} ${scale} cut command costs\n\n${report.markdown}\n${interval}\nBuild run ID: ${sourceRunId}\n`);
      if (scale === 'large' && stage.axis === 'unrelatedWorks') {
        const comparison = buildSeedCommandCostComparison(stageCostRows);
        const comparisonPath = join(seedDirectory, 'command-cost-compare.md');
        writeFileSync(comparisonPath, `# Retained Work-profile command cost comparison\n\n${comparison.markdown}\nBuild run ID: ${sourceRunId}\n`);
      }
    }
    retained.cuts = retained.axes.unrelatedWorks;
    expect(works).toHaveLength(64);
    expect(posts).toHaveLength(64);
    expect(SEED_AXES.every(axis => retained.axes[axis].length === WORK_PROFILE_SCALES.length)).toBe(true);
    saveRetainedSeed(retained);
    console.log('largest retained seed build seconds', Math.max(...Object.values(retained.axes).flat()
      .map(cut => cut.timing.totalMs)) / 1000,
      'total build workflow seconds', (performance.now() - startedAt) / 1000);
    console.log('seed command-cost report paths', JSON.stringify(commandCostReportPaths));
  } finally {
    try {
      if (source && !sourceStopped) await source.stop();
      await shutdownTelemetry();
      await sink.stop();
    } finally {
      releaseSeedBuildLock?.();
      console.log('seed BUILD host load end', loadavg());
    }
  }
}, WORK_PROFILE_SEED_BUILD_WALL_MS);
