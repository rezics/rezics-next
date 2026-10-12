import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { root, stream, dockerEnvironment } from '../../../scripts/fixture/stack.ts';
import { createCorpusBackupDriver } from '../../../scripts/load/corpus-backup-driver.ts';
import { workProfileCorpusApi, type WorkProfileCorpusManifest } from '../../../scripts/load/work-profile-corpus.ts';
import { seedPublicProfileWork } from '../../../scripts/load/work-profile-work.ts';
import { runBoundedIndices } from '../../../scripts/load/schedule.ts';
import { startMediaStack, type MediaStack } from '../integration/media-support.ts';
import { readRetainedSeed, seedAuthorName } from '../support/seed-checkpoints.ts';

test('unrelated public Work growth from the retained small cut never refuses publication', async () => {
  const manifest: WorkProfileCorpusManifest = Bun.env.REZICS_SEED_SMALL_MANIFEST
    ? JSON.parse(readFileSync(Bun.env.REZICS_SEED_SMALL_MANIFEST, 'utf8')) as WorkProfileCorpusManifest
    : readRetainedSeed().cuts[0]!.manifest;
  expect(manifest.scale).toBe('small');
  expect(manifest.dimensions.unrelatedWorks).toBe(4);
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through goalctl');
  await stream('task', ['stack:down', '--', '--profile', 'qa', '--run-id', runId], dockerEnvironment());
  let stack: MediaStack | undefined;
  const target = `seed-publish-${runId}`;
  const started = performance.now();
  const signal = AbortSignal.timeout(600_000);
  const driver = createCorpusBackupDriver({ sourceRunId: runId, directory: `${root}/.temp/seed-publish`,
    resumeSource: false,
    quiesce: async () => { throw new Error('Publication regression never builds a backup'); },
    async smokeRead(input) {
      Object.assign(Bun.env, input.apps, { REZICS_QA_RUN_ID: input.runId });
      stack = await startMediaStack('seed-publish', { library: true, ownerUrls: {
        access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
        relay: input.apps.ACCOUNT_RELAY_DATABASE_URL! } });
      return async () => { await stack!.stop(); stack = undefined; };
    },
  });
  try {
    console.log('stage 16 reproduction host load', loadavg());
    await driver.restore(manifest.backup, target, signal);
    const member = await stack!.member(seedAuthorName, { stable: true, verified: true });
    const api = workProfileCorpusApi('http://main.local', member.token, {
      signal, fetch: ((input, init) => stack!.main.handle(new Request(input, init))) as typeof fetch,
    });
    const { agent } = await api.command<{ agent: string }>(`${manifest.id}:base:author`, { method: 'POST',
      stage: 'medium', path: '/v1/agents', body: { profile: 'agent-provision-v1', kind: 'person',
        displayName: 'Checkpoint corpus author' } });
    await runBoundedIndices(12, 2, async offset => {
      const index = offset + 4;
      const staged = { ...api, command: <T>(key: string, command: Parameters<typeof api.command>[1]) =>
        api.command<T>(key, { ...command, stage: 'medium' }) };
      await seedPublicProfileWork(staged, `${manifest.id}:unrelatedWorks:${index}`, {
        actingSubject: agent, title: `Checkpoint public Work ${index}`, body: `Checkpoint selected text ${index}` });
    }, () => {});
    expect(performance.now() - started).toBeLessThan(600_000);
  } finally {
    console.log('stage 16 reproduction seconds', (performance.now() - started) / 1000, 'host load', loadavg());
    await driver.stop(target);
  }
}, 660_000);
