import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readEnv } from '../../../scripts/dev/config.ts';
import { root, VOLUME_KINDS } from '../../../scripts/fixture/stack.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { createCorpusBackupDriver, type CorpusRestoreSmokeInput,
  type ManagedCorpusBackupDriver } from '../../../scripts/load/corpus-backup-driver.ts';
import { prepareWorkProfileCorpus, restoreWorkProfileCorpus, workProfileCorpusApi,
  workProfileDimensions, WORK_PROFILE_DIMENSIONS, WORK_PROFILE_SCALES,
  type CorpusApi, type CorpusDimensions, type WorkProfileCorpusManifest,
  type WorkProfileCorpusRecipe } from '../../../scripts/load/work-profile-corpus.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';

const fixed: CorpusDimensions = { unrelatedWorks: 0, unrelatedPosts: 0, follows: 0,
  memberships: 0, historyDepth: 0, realmSize: 0, conceptVocabulary: 0 };
const authorName = 'checkpoint-corpus-author';
const short = (id: string) => id.slice(-36);
const selection = (id: string): `/v1/${string}` => `/v1/main-versions/${short(id)}/selection?language=en`;

function apiFor(stack: MediaStack, token: string) {
  return workProfileCorpusApi('http://main.local', token, {
    fetch: ((input, init) => stack.main.handle(new Request(input, init))) as typeof fetch,
  });
}

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
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  }
}

test('API seed retains 4/16/64 Work checkpoints, preserves ids and restores isolated stores within the deadline', async () => {
  // All axes use the owner's one scale table. The real restore census below
  // exercises the Work axis; other scenario recipes retain their own meaning.
  for (const dimension of WORK_PROFILE_DIMENSIONS) {
    expect(WORK_PROFILE_SCALES.map(scale => workProfileDimensions(dimension, scale, fixed)[dimension]))
      .toEqual(dimension === 'historyDepth' ? [2, 8, 32] : [4, 16, 64]);
  }
  const sourceRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!sourceRunId || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL)
    throw new Error('Run through goalctl integration QA');
  const compose = readEnv(join(root, '.temp/stack', `rezics-qa-${sourceRunId}`, 'compose.env'));
  expect(compose.REZICS_STACK_STORAGE).toBe('persistent');
  const directory = join(root, '.temp/work-profiles', `seed-checkpoints-${sourceRunId}`);
  const buildStartedAt = performance.now();
  let source = await startMediaStack('seed-checkpoint-source', { library: true });
  const sourceStartupMs = performance.now() - buildStartedAt;
  let sourceStopped = false;
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  let relayClosed = false;
  const works: Awaited<ReturnType<typeof seedPublicProfileWork>>[] = [];
  const checkpoints: WorkProfileCorpusManifest[] = [];
  const copies = new Map<string, { stack: MediaStack; api: CorpusApi; input: CorpusRestoreSmokeInput }>();
  const targets: string[] = [];
  let currentApi: CorpusApi;
  let actor = '';
  let verifying: WorkProfileCorpusManifest | undefined;
  let driver: ManagedCorpusBackupDriver | undefined;
  const evidence: Array<Record<string, unknown>> = [];
  try {
    currentApi = apiFor(source, (await source.member(authorName, { stable: true, verified: true })).token);
    await initializeRelayCheckpoint(relay, Bun.env.MAIN_RELAY_CONSUMER!, source.env.lineage.dataEpoch);
    const api: CorpusApi = { command: (key, command, signal) => currentApi.command(key, command, signal),
      read: (path, signal) => currentApi.read(path, signal) };
    async function census(client: CorpusApi, count: number) {
      const ids = new Set<string>();
      for (let index = 0; index < count; index++) {
        const created = works[index]!;
        const selected = await client.read<{ work: string; mainVersion: string; contribution: string;
          selectedDraft: string; body: string }>(selection(created.mainVersion));
        expect(selected).toMatchObject({ work: created.work, mainVersion: created.mainVersion,
          contribution: created.contribution, selectedDraft: created.draftRevision,
          body: `Checkpoint selected text ${index}` });
        ids.add(selected.work);
      }
      expect(ids.size).toBe(count);
      return { ...fixed, unrelatedWorks: ids.size };
    }
    const recipe: WorkProfileCorpusRecipe = {
      version: 'public-work-checkpoints-v1', fixed,
      async initialize(client, key) {
        actor = (await client.command<{ agent: string }>(`${key}:author`, { method: 'POST',
          path: '/v1/agents', body: { profile: 'agent-provision-v1', kind: 'person',
            displayName: 'Checkpoint corpus author' } })).agent;
      },
      async grow(client, dimension, index, key) {
        expect(dimension).toBe('unrelatedWorks');
        const created = await seedPublicProfileWork(client, key, { actingSubject: actor,
          title: `Checkpoint public Work ${index}`, body: `Checkpoint selected text ${index}` });
        if (works[index]) expect(created).toEqual(works[index]);
        works[index] = created;
      },
      verify: client => census(client, works.length),
    };
    function createDriver(resumeSource: boolean) {
      return createCorpusBackupDriver({ sourceRunId: sourceRunId!, directory: join(directory, 'backups'),
        resumeSource,
        async quiesce(signal) {
          signal.throwIfAborted();
          if (!relayClosed) { await relay.end(); relayClosed = true; }
          await source.stop();
          sourceStopped = true;
          return async () => {
            source = await startMediaStack('seed-checkpoint-source', { library: true });
            sourceStopped = false;
            currentApi = apiFor(source, (await source.member(authorName, { stable: true, verified: true })).token);
          };
        },
        async smokeRead(input) {
          const stack = await openCopy(input);
          try {
            const client = apiFor(stack, (await stack.member(authorName, { stable: true, verified: true })).token);
            expect(await census(client, verifying!.dimensions.unrelatedWorks)).toEqual(verifying!.dimensions);
            // Later checkpoint entities must be absent, not merely omitted from the census.
            for (const created of works.slice(verifying!.dimensions.unrelatedWorks))
              await expect(client.read(selection(created.mainVersion))).rejects.toThrow('HTTP 404');
            copies.set(input.target, { stack, api: client, input });
            return async () => { copies.delete(input.target); await stack.stop(); };
          } catch (error) { await stack.stop(); throw error; }
        },
      });
    }
    for (const scale of WORK_PROFILE_SCALES) {
      driver = createDriver(scale !== 'large');
      const input = { recipe, api, backups: driver, dimension: 'unrelatedWorks' as const,
        scale, directory: join(directory, 'manifests'), startedAt: buildStartedAt };
      const checkpoint = await prepareWorkProfileCorpus(input);
      checkpoints.push(checkpoint);
      expect(await prepareWorkProfileCorpus(input)).toEqual(checkpoint);
    }
    expect(works).toHaveLength(64);
    const buildMs = performance.now() - buildStartedAt;
    expect(buildMs).toBeLessThan(600_000);
    evidence.push({ stage: 'build', sourceStartupMs, totalMs: buildMs,
      largestCheckpointPreparationMs: checkpoints[2]!.preparationMs });
    for (const checkpoint of checkpoints) {
      verifying = checkpoint;
      const target = `seed-checkpoint-${checkpoint.scale}`;
      targets.push(target);
      const elapsedMs = await restoreWorkProfileCorpus(checkpoint, target, driver!);
      const timing = driver!.preparation(target)!;
      expect(elapsedMs).toBeLessThan(600_000);
      expect(timing.totalMs).toBeLessThan(600_000);
      expect(timing.restoreMs).toBeGreaterThan(0);
      expect(timing.startupMs).toBeGreaterThan(0);
      expect(timing.readinessMs).toBeGreaterThan(0);
      expect(timing.restoreMs + timing.startupMs + timing.readinessMs).toBeCloseTo(timing.totalMs, 3);
      evidence.push({ stage: 'restore', scale: checkpoint.scale, dimensions: checkpoint.dimensions,
        ...timing });
      // Keep two smallest copies alive for isolation; the largest is just a census.
      if (checkpoint.scale === 'large') await driver!.stop(target);
    }
    const first = copies.get('seed-checkpoint-small')!;
    const second = copies.get('seed-checkpoint-medium')!;
    expect(first.input.runId).not.toBe(second.input.runId);
    for (const kind of VOLUME_KINDS)
      expect(`rezics-qa-${first.input.runId}_${kind}`).not.toBe(`rezics-qa-${second.input.runId}_${kind}`);
    for (const key of ['ACCESS_DATABASE_URL', 'CONTENT_DATABASE_URL', 'ACCOUNT_RELAY_DATABASE_URL',
      'FUSEKI_URL', 'MAIN_S3_ENDPOINT', 'MAIN_OBJECT_DIRECTORY'])
      expect(first.input.apps[key]).not.toBe(second.input.apps[key]);
    const created = await seedPublicProfileWork(first.api, 'checkpoint-isolated-write', {
      actingSubject: actor, title: 'Checkpoint isolated write', body: 'Only the small copy contains this Work' });
    expect(await first.api.read(selection(created.mainVersion))).toMatchObject({ work: created.work });
    await expect(second.api.read(selection(created.mainVersion))).rejects.toThrow('HTTP 404');
    expect(await census(second.api, 16)).toEqual(checkpoints[1]!.dimensions);
  } finally {
    writeFileSync(join(root, '.temp', `work-profile-seed-checkpoints-${sourceRunId}.json`),
      JSON.stringify(evidence, null, 2) + '\n');
    console.log('seed-checkpoint preparation seconds', JSON.stringify(evidence.map(item =>
      Object.fromEntries(Object.entries(item).map(([key, value]) =>
        [key.endsWith('Ms') ? key.replace(/Ms$/, 'Seconds') : key,
          key.endsWith('Ms') && typeof value === 'number' ? value / 1000 : value])))));
    const errors: unknown[] = [];
    for (const target of targets) {
      try { await driver?.stop(target); } catch (error) { errors.push(error); }
    }
    if (!relayClosed) { try { await relay.end(); } catch (error) { errors.push(error); } }
    if (!sourceStopped) { try { await source.stop(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Seed checkpoint cleanup failed');
  }
}, 480_000);
