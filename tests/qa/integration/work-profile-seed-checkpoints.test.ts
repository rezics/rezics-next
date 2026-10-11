import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { root, VOLUME_KINDS, stream, dockerEnvironment } from '../../../scripts/fixture/stack.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { createCorpusBackupDriver, type CorpusRestoreSmokeInput }
  from '../../../scripts/load/corpus-backup-driver.ts';
import { restoreWorkProfileCorpus, workProfileDimensions, WORK_PROFILE_DIMENSIONS, WORK_PROFILE_SCALES,
  type CorpusApi } from '../../../scripts/load/work-profile-corpus.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { readRetainedSeed, seedAuthorName, seedApi, seedCensus, seedSelection,
  type RetainedSeedCut } from '../support/seed-checkpoints.ts';

async function openCopy(input: CorpusRestoreSmokeInput) {
  const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId,
    REZICS_QA_STACK_MODE: 'scale', REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
  const previous = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
  Object.assign(Bun.env, env);
  try {
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
  const retained = readRetainedSeed();
  const fixed = { unrelatedWorks: 0, unrelatedPosts: 0, follows: 0, memberships: 0,
    historyDepth: 0, realmSize: 0, conceptVocabulary: 0 };
  for (const dimension of WORK_PROFILE_DIMENSIONS)
    expect(WORK_PROFILE_SCALES.map(scale => workProfileDimensions(dimension, scale, fixed)[dimension]))
      .toEqual(dimension === 'historyDepth' ? [2, 8, 32]
        : dimension === 'recipeOccurrences' ? [100, 400, 1600] : [4, 16, 64]);
  const qaRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Run through goalctl integration QA');
  // The harness's empty startup store is unused. Each modest restored copy
  // runs alone under catalogue-disk, avoiding stacked Docker admission.
  await stream('task', ['stack:down', '--', '--profile', 'qa', '--run-id', qaRunId, '--persistent'], dockerEnvironment());
  let verifying: RetainedSeedCut;
  let copy: { stack: MediaStack; api: CorpusApi; input: CorpusRestoreSmokeInput } | undefined;
  const stores: CorpusRestoreSmokeInput[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  let isolatedWrite: Awaited<ReturnType<typeof seedPublicProfileWork>> | undefined;
  const targets: string[] = [];
  const driver = createCorpusBackupDriver({ sourceRunId: retained.sourceRunId,
    directory: join(root, '.temp/work-profiles/seed-checkpoints'), resumeSource: false,
    quiesce: async () => { throw new Error('Routine TEST never builds a checkpoint'); },
    async smokeRead(input) {
      const stack = await openCopy(input);
      try {
        const client = seedApi(stack, (await stack.member(seedAuthorName, { stable: true, verified: true })).token);
        expect(await seedCensus(client, verifying)).toEqual(verifying.manifest.dimensions);
        for (const created of retained.cuts[2]!.works.slice(verifying.works.length))
          await expect(client.read(seedSelection(created.mainVersion))).rejects.toThrow('HTTP 404');
        if (isolatedWrite)
          await expect(client.read(seedSelection(isolatedWrite.mainVersion))).rejects.toThrow('HTTP 404');
        copy = { stack, api: client, input };
        stores.push(input);
        return async () => { copy = undefined; await stack.stop(); };
      } catch (error) { await stack.stop(); throw error; }
    },
  });
  try {
    for (const cut of retained.cuts) {
      verifying = cut;
      const target = `seed-${cut.manifest.scale}-${qaRunId}`;
      targets.push(target);
      const elapsedMs = await restoreWorkProfileCorpus(cut.manifest, target, driver);
      const timing = driver.preparation(target)!;
      expect(elapsedMs).toBeLessThan(600_000);
      expect(timing.totalMs).toBeLessThan(600_000);
      for (const value of [timing.restoreMs, timing.startupMs, timing.readinessMs]) expect(value).toBeGreaterThan(0);
      expect(timing.restoreMs + timing.startupMs + timing.readinessMs).toBeCloseTo(timing.totalMs, 3);
      evidence.push({ scale: cut.manifest.scale, dimensions: cut.manifest.dimensions, ...timing });
      if (cut.manifest.scale === 'small') {
        isolatedWrite = await seedPublicProfileWork(copy!.api, `checkpoint-isolated-${qaRunId}`, {
          actingSubject: retained.actor, title: 'Checkpoint isolated write', body: 'Only the first copy contains this Work' });
        expect(await copy!.api.read(seedSelection(isolatedWrite.mainVersion))).toMatchObject({ work: isolatedWrite.work });
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
  }
}, 3 * 600_000);
