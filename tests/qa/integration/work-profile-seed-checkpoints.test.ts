import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { writeFileSync } from 'node:fs';
import { root, VOLUME_KINDS, stream, dockerEnvironment } from '../../../scripts/fixture/stack.ts';
import type { CorpusRestoreSmokeInput }
  from '../../../scripts/load/corpus-backup-driver.ts';
import { restoreWorkProfileCorpus, workProfileDimensions, WORK_PROFILE_DIMENSIONS, WORK_PROFILE_SCALES,
  type CorpusApi, type CorpusDimensions } from '../../../scripts/load/work-profile-corpus.ts';
import type { MediaStack } from './media-support.ts';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '../../../packages/observability/src/runtime.ts';
import { assertWorkMeterObserved, profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import { readRetainedSeed, seedAuthorName, seedApi, seedCensus, seedSelection,
  seedDirectory, type RetainedSeedCut } from '../support/seed-checkpoints.ts';
import { seedVerificationCuts } from '../support/seed-checkpoints.ts';
import { seedVerificationPlan, SEED_RESTORE_PREPARATION_MS } from '../../../scripts/qa/seed-verification.ts';

async function openCopy(input: CorpusRestoreSmokeInput) {
  const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId,
    REZICS_QA_STACK_MODE: 'scale', REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
  const previous = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
  Object.assign(Bun.env, env);
  try {
    const { startMediaStack } = await import('./media-support.ts');
    return await startMediaStack(`seed-checkpoint-${input.target}`, { library: true,
      ownerUrls: { access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
        relay: input.apps.ACCOUNT_RELAY_DATABASE_URL! } });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
    }
  }
}

test('retained checkpoints restore exact populations and identities into isolated stores within 600 seconds', async () => {
  const sink = startWorkProfileSink({ settleMs: 25 });
  try {
  // Register instrumentation before importing either the backup driver or application storage clients.
  startTelemetry('main', { ...process.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const retained = readRetainedSeed();
  const cuts = seedVerificationCuts(retained, Bun.env.REZICS_SEED_VERIFY_CUT);
  expect(cuts[0]).toBe(cuts[1]);
  console.log('seed cut verification host load start', Bun.env.REZICS_SEED_VERIFY_CUT ?? 'all', loadavg());
  const fixed = { unrelatedWorks: 0, unrelatedPosts: 0, follows: 0, memberships: 0,
    historyDepth: 0, realmSize: 0, conceptVocabulary: 0 };
  for (const dimension of WORK_PROFILE_DIMENSIONS)
    expect(WORK_PROFILE_SCALES.map(scale => workProfileDimensions(dimension, scale, fixed)[dimension]))
      .toEqual(dimension === 'historyDepth' ? [2, 8, 32]
        : dimension === 'recipeOccurrences' ? [100, 400, 1600] : [4, 16, 64]);
  const qaRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Run through goalctl integration QA');
  // The harness's empty startup store is unused. Each modest restored copy
  // runs alone under its declared restore allocation.
  await stream('task', ['stack:down', '--', '--profile', 'qa', '--run-id', qaRunId, '--persistent'], dockerEnvironment());
  let verifying: RetainedSeedCut;
  let copy: { stack: MediaStack; api: CorpusApi; input: CorpusRestoreSmokeInput } | undefined;
  const stores: CorpusRestoreSmokeInput[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  let isolatedWrite = false;
  const targets: string[] = [];
  const driver = createCorpusBackupDriver({ sourceRunId: retained.sourceRunId,
    directory: seedDirectory, resumeSource: false, restoreResourceClass: 'seed-cut-restore',
    quiesce: async () => { throw new Error('Routine TEST never builds a checkpoint'); },
    async smokeRead(input) {
      const postgresLog = await stream('docker', ['logs', `rezics-qa-${input.runId}-postgres-1`], dockerEnvironment());
      writeFileSync(join(root, '.temp', `seed-checkpoint-postgres-${input.runId}.log`), postgresLog);
      expect(postgresLog).toContain('database system is ready to accept connections');
      expect(postgresLog).not.toContain('database system shutdown was interrupted');
      const stack = await openCopy(input);
      try {
        const { token } = await stack.member(seedAuthorName, { stable: true, verified: true });
        const client = seedApi(stack, token);
        const actual: CorpusDimensions = await seedCensus(client, verifying);
        expect(actual).toEqual(verifying.manifest.dimensions);
        const { profile } = await profileRequest(sink, async headers => {
          headers.set('authorization', `Bearer ${token}`);
          const response = await stack.main.handle(new Request(`http://main.local/v1/works/${verifying.population.shelfWorks[0]!.slice(-36)}/reader-state?actingSubject=${encodeURIComponent(retained.actor)}`, { headers }));
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ status: { status: 'reading', version: 1 } });
        }, { service: 'main', flush: flushTelemetryTraces });
        assertWorkMeterObserved(profile);
        expect((profile.postgresStatements ?? 0) + (profile.fusekiRequests ?? 0)).toBeGreaterThan(0);
        expect(profile.otherFetches).toBe(0);
        const attribution = { scale: verifying.manifest.scale, postgresStatements: profile.postgresStatements,
          fusekiRequests: profile.fusekiRequests, otherFetches: profile.otherFetches, unclassifiedFetches: profile.unclassifiedFetches };
        console.log('restored read attribution', JSON.stringify(attribution));
        evidence.push({ restoredRead: attribution });
        for (const created of retained.cuts[2]!.works.slice(verifying.works.length))
          await expect(client.read(seedSelection(created.mainVersion))).rejects.toThrow('HTTP 404');
        if (isolatedWrite)
          expect(await client.read(`/v1/works/${verifying.population.shelfWorks[0]!.slice(-36)}/reader-state?actingSubject=${encodeURIComponent(retained.actor)}`))
            .toMatchObject({ status: { status: 'reading', version: 1 } });
        copy = { stack, api: client, input };
        stores.push(input);
        return async () => { copy = undefined; await stack.stop(); };
      } catch (error) { await stack.stop(); throw error; }
    },
  });
  try {
    // Restore the first selected cut twice: the write must not mutate its
    // backup or appear in a second writable copy of that same cut.
    for (const [index, cut] of cuts.entries()) {
      verifying = cut;
      const target = `seed-${index}-${cut.manifest.scale}-${qaRunId}`;
      targets.push(target);
      const elapsedMs = await restoreWorkProfileCorpus(cut.manifest, target, driver);
      const timing = driver.preparation(target)!;
      expect(elapsedMs).toBeLessThan(SEED_RESTORE_PREPARATION_MS);
      expect(timing.totalMs).toBeLessThan(SEED_RESTORE_PREPARATION_MS);
      for (const value of [timing.restoreMs, timing.startupMs, timing.readinessMs]) expect(value).toBeGreaterThan(0);
      expect(timing.restoreMs + timing.startupMs + timing.readinessMs).toBeCloseTo(timing.totalMs, 3);
      expect(timing.volumeCopyMs).toBeDefined();
      evidence.push({ scale: cut.manifest.scale, dimensions: cut.manifest.dimensions,
        restoreMs: timing.restoreMs, postgresRestoreMs: timing.volumeCopyMs!.postgres_data,
        fusekiCopyMs: timing.volumeCopyMs!.fuseki_data, rustfsCopyMs: timing.volumeCopyMs!.rustfs_data,
        objectCopyMs: timing.objectCopyMs, startupMs: timing.startupMs,
        readinessMs: timing.readinessMs, totalMs: timing.totalMs });
      if (index === 0) {
        const state = await copy!.api.command(`checkpoint-isolated-${qaRunId}`, {
          method: 'PUT', path: `/v1/works/${cut.population.shelfWorks[0]!.slice(-36)}/reader-status`,
          body: { actingSubject: retained.actor, expectedVersion: 1, status: 'want-to-read', startedOn: null, finishedOn: null } });
        expect(state).toMatchObject({ status: 'want-to-read', version: 2 });
        expect(await copy!.api.read(`/v1/works/${cut.population.shelfWorks[0]!.slice(-36)}/reader-state?actingSubject=${encodeURIComponent(retained.actor)}`))
          .toMatchObject({ status: { status: 'want-to-read', version: 2 } });
        isolatedWrite = true;
      }
      await driver.stop(target);
    }
    const [first, second] = stores;
    expect(first!.runId).not.toBe(second!.runId);
    for (const kind of VOLUME_KINDS)
      expect(`rezics-qa-${first!.runId}_${kind}`).not.toBe(`rezics-qa-${second!.runId}_${kind}`);
    for (const key of ['ACCESS_DATABASE_URL', 'CONTENT_DATABASE_URL', 'ACCOUNT_RELAY_DATABASE_URL',
      'FUSEKI_URL', 'MAIN_S3_ENDPOINT', 'MAIN_OBJECT_DIRECTORY'])
      expect(first!.apps[key]).not.toBe(second!.apps[key]);
  } finally {
    writeFileSync(join(root, '.temp', `work-profile-seed-restores-${qaRunId}.json`), JSON.stringify(evidence, null, 2) + '\n');
    console.log('seed checkpoint restore seconds', JSON.stringify(evidence.map(item =>
      Object.fromEntries(Object.entries(item).map(([key, value]) => [key.endsWith('Ms') ? key.replace(/Ms$/, 'Seconds') : key,
        key.endsWith('Ms') && typeof value === 'number' ? value / 1000 : value])))));
    const errors: unknown[] = [];
    for (const target of targets) { try { await driver.stop(target); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Seed restore cleanup failed');
    console.log('seed cut verification host load end', Bun.env.REZICS_SEED_VERIFY_CUT ?? 'all', loadavg());
  }
  } finally {
    try { await shutdownTelemetry(); } finally { await sink.stop(); }
  }
}, seedVerificationPlan(Bun.env.REZICS_SEED_VERIFY_CUT).budgetMs);
