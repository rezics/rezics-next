import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { profileRequest, startWorkProfileSink } from '../support/work-profile.ts';
import { runWorkProfileChild } from '../support/work-profile-child.ts';

// Initialize the SDK before loading pg and the composed Main app, as growth workers do.
if (Bun.env.REZICS_TELEMETRY_RESTORE_CHILD === '1') {
  const { expect } = await import('bun:test');
  const sink = startWorkProfileSink({ settleMs: 25 });
  startTelemetry('main', { ...Bun.env, ...sink.env, OTEL_SERVICE_NAME: 'main' });
  const { join } = await import('node:path');
  const { writeFileSync } = await import('node:fs');
  const { root, stream, dockerEnvironment } = await import('../../../scripts/fixture/stack.ts');
  const { createCorpusBackupDriver } = await import('../../../scripts/load/corpus-backup-driver.ts');
  const { restoreWorkProfileCorpus } = await import('../../../scripts/load/work-profile-corpus.ts');
  const { startMediaStack } = await import('./media-support.ts');
  const { readRetainedSeed, seedDirectory, seedAuthorName, seedSelection } = await import('../support/seed-checkpoints.ts');
  const retained = readRetainedSeed();
  const cut = retained.cuts[0]!;
  const qaRunId = Bun.env.REZICS_QA_RUN_ID;
  if (!qaRunId) throw new Error('Run through goalctl integration QA');
  await stream('task', ['stack:down', '--', '--profile', 'qa', '--run-id', qaRunId, '--persistent'], dockerEnvironment());
  const target = `telemetry-small-${qaRunId}`;
  const driver = createCorpusBackupDriver({
    sourceRunId: retained.sourceRunId, directory: seedDirectory,
    resumeSource: false, restoreResourceClass: 'ordinary',
    quiesce: async () => { throw new Error('Telemetry qualification only restores retained checkpoints'); },
    async smokeRead(input) {
      const env = { ...input.apps, REZICS_QA_RUN_ID: input.runId,
        REZICS_QA_STACK_MODE: 'scale', REZICS_QA_STACK_TIER: 'integration', REZICS_STACK_PROFILE: 'qa' };
      const previous = new Map(Object.keys(env).map(key => [key, Bun.env[key]]));
      Object.assign(Bun.env, env);
      const stack = await (async () => {
        try { return await startMediaStack('telemetry-restored-peers', { library: true,
          ownerUrls: { access: input.apps.ACCESS_DATABASE_URL!, content: input.apps.CONTENT_DATABASE_URL!,
            relay: input.apps.ACCOUNT_RELAY_DATABASE_URL! } }); }
        finally { for (const [key, value] of previous) {
          if (value === undefined) delete Bun.env[key]; else Bun.env[key] = value;
        } }
      })();
      try {
        expect(new URL(input.apps.FUSEKI_URL!).origin).not.toBe(new URL(Bun.env.FUSEKI_URL!).origin);
        const member = await stack.member(seedAuthorName, { stable: true, verified: true });
        const work = cut.works[0]!;
        const measured = await profileRequest(sink, async headers => {
          headers.set('authorization', `Bearer ${member.token}`);
          const response = await stack.main.handle(new Request(`http://main.local${seedSelection(work.mainVersion)}`, { headers }));
          expect(response.status).toBe(200);
          const body = await response.json();
          expect(body).toMatchObject({ work: work.work, mainVersion: work.mainVersion,
            body: 'Checkpoint selected text 0' });
          return body;
        }, { service: 'main', flush: flushTelemetryTraces });
        const profile = measured.profile;
        writeFileSync(join(root, '.temp', `telemetry-restored-peers-${qaRunId}.json`), JSON.stringify(profile, null, 2) + '\n');
        expect(profile.postgresStatements).toBeGreaterThan(0);
        expect(profile.fusekiRequests).toBeGreaterThan(0);
        expect(profile.fusekiSentBytes).toBeGreaterThan(0);
        expect(profile.fusekiReceivedBytes).toBeGreaterThan(0);
        expect(profile.unclassifiedFetches).toBe(0);
        console.log(JSON.stringify({ scale: cut.manifest.scale, postgresStatements: profile.postgresStatements,
          fusekiRequests: profile.fusekiRequests, fusekiSentBytes: profile.fusekiSentBytes,
          fusekiReceivedBytes: profile.fusekiReceivedBytes }));
        return () => stack.stop();
      } catch (error) { await stack.stop(); throw error; }
    },
  });
  try {
    const elapsedMs = await restoreWorkProfileCorpus(cut.manifest, target, driver);
    expect(elapsedMs).toBeLessThan(600_000);
  } finally {
    await driver.stop(target);
    await shutdownTelemetry();
    await sink.stop();
  }
} else {
  const { expect, test } = await import('bun:test');
  test('restored small checkpoint reads retain Main SQL and Fuseki attribution without per-read peer registration', async () => {
    const { stdout } = await runWorkProfileChild('tests/qa/integration/telemetry-restored-peers.test.ts', {
      env: { REZICS_TELEMETRY_RESTORE_CHILD: '1' }, timeoutMs: 660_000,
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
    expect(result.scale).toBe('small');
    expect(result.postgresStatements).toBeGreaterThan(0);
    expect(result.fusekiRequests).toBeGreaterThan(0);
  }, 700_000);
}
