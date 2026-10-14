import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { qaStartupTestTimeout, runQaStartupChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { copyVolume, removeVolumes, run } from '../../../scripts/fixture/stack.ts';
import { RetainedSources, sourceKey } from '../../../scripts/qa/retained-source.ts';
import { prepareRetainedContentSource, readRetainedPostgresControl, retainStoppedContentWriters, retainedContentSourceAdapter, retainedContentSourceDirectory } from './retained-content-source-support.ts';
import { qaStack, requireFaultTier, root, rootCommand } from './search-ops-support.ts';

test('D016STOP01: an expired PostgreSQL stop refuses before copy with its control evidence', async () => {
  const { runId, artifacts } = requireFaultTier();
  const stack = qaStack(`rc-stop-${runId.slice(0, 22)}`);
  const target = `${stack.project}_stop_probe`;
  let copyStarted = false;
  try {
    const startup = await runQaStartupChildAsync(root, ['stack:up', ...stack.args], 180_000);
    if (!startup.ok) throw new Error(`stop regression startup failed: ${startup.output.slice(-2000)}`);
    // A real frozen postmaster cannot finish shutdown before Compose's grace expires.
    const freeze = stack.compose(['exec', '-T', 'postgres', 'sh', '-ec', 'kill -STOP 1']);
    if (freeze.status !== 0) throw new Error(`postmaster pause failed: ${freeze.output}`);
    let failure: unknown;
    try {
      await retainStoppedContentWriters(stack, async () => {
        copyStarted = true;
        await copyVolume(stack.stateVolume, target, stack.dockerEnv);
      });
    } catch (error) { failure = error; }
    const control = readRetainedPostgresControl(`${stack.project}_postgres_data`, stack.dockerEnv);
    const state = JSON.parse(run('docker', ['inspect', `${stack.project}-postgres-1`, '--format', '{{json .State}}'], stack.dockerEnv));
    writeFileSync(join(artifacts, 'retained-content-source-stop-regression.json'), JSON.stringify({
      forcedPostmasterPause: true, startupAdmissionWaitMs: startup.admissionWaitMs,
      state, control, copyStarted, failure: failure instanceof Error ? failure.message : null,
    }, null, 2) + '\n', { mode: 0o600 });
    expect(state.ExitCode).toBe(137);
    expect(failure instanceof Error ? failure.message : null).toContain('Content producer stop failed');
    expect(failure instanceof Error ? failure.message : null).toContain(control);
    expect(copyStarted).toBe(false);
  } finally {
    await rootCommand(['stack:reset', ...stack.args], 120_000);
    removeVolumes([target], stack.dockerEnv);
  }
}, qaStartupTestTimeout(360_000));

test('D016: preparation publishes and verifies immutable complete Content source custody', async () => {
  const { artifacts } = requireFaultTier();
  const prepared = await prepareRetainedContentSource();
  const directory = retainedContentSourceDirectory();
  const adapter = retainedContentSourceAdapter(directory);
  const selected = await new RetainedSources(directory).select(adapter);
  const evidence = { sourceKey: selected.key, manifestDigest: selected.digest,
    integrityDigest: selected.integrity.digest, rdfDigest: selected.integrity.rdfDigest,
    manifestPath: selected.provenance.manifestPath, backupPath: selected.provenance.backupPath,
    producerRevision: selected.provenance.producerRevision, qaIdentity: selected.provenance.qaIdentity,
    image: selected.specification.compatibility.selectedNativeImage,
    built: prepared.built, buildCount: prepared.built ? 1 : 0, reuseCount: prepared.built ? 0 : 1,
    elapsedMs: prepared.elapsedMs, admissionWaitMs: prepared.admissionWaitMs,
    phases: selected.provenance.phases, sourceVolumes: selected.metadata.sourceVolumes };
  writeFileSync(join(artifacts, 'retained-content-source-preparation.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  expect(selected.key).toBe(sourceKey(adapter.specification));
  expect(selected.digest).toBe(prepared.manifest.digest);
  expect(selected.integrity.digest).toBe(prepared.manifest.integrity.digest);
  expect(prepared.elapsedMs).toBeLessThan(600_000);
}, qaStartupTestTimeout(600_000));
