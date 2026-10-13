import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { redactCommandOutput } from '../../../scripts/fixture/command-output.ts';
import { restoreStateVolume } from '../../../scripts/operations/search-state.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { searchGenerationRoutes } from '../../../services/main/src/routes/search-generations.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { DATASET, GRAPHS, RV, activateMetadataWork, initializeFreshGraph, iri,
  metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { assertPublicTextReady, SearchIndexUncertain } from '../../../services/main/src/modules/work/search-readiness.ts';
import { fusekiSecrets, pinnedImage, qaStack, requireFaultTier, root, rootCommand,
  standaloneFuseki, type StandaloneFuseki } from './search-ops-support.ts';

test('OPS15/OPS16: committed crash auditing clears uncertainty only after qualification and failed audit keeps public search fenced', async () => {
  const { runId, artifacts } = requireFaultTier();
  const stack = qaStack(`${runId}-cf`);
  const backup = `rezics-crash-producer-${randomUUID()}`;
  let backupCreated = false;
  const failedVolume = `rezics-crash-audit-${randomUUID()}`;
  let copied = false;
  let copy: StandaloneFuseki | undefined;
  let started = false;
  const evidence: Record<string, unknown> = { image: pinnedImage() };
  const redact = (value: string) => {
    let text = redactCommandOutput(value);
    for (const secret of Object.values(fusekiSecrets(stack.composeEnv))) text = text.replaceAll(secret, '[redacted]');
    return text.slice(-8000);
  };
  const record = () => writeFileSync(join(artifacts, 'crash-fence-contract.json'),
    `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const docker = (args: string[]) => {
    const result = spawnSync('docker', args, { cwd: root, env: preserveReapEnvironment(stack.dockerEnv),
      encoding: 'utf8', timeout: 180_000, maxBuffer: 4_000_000 });
    if (result.error || result.status !== 0) throw new Error(redact(
      `docker ${args[0]}: ${result.stderr || result.stdout || result.error?.message}`));
    return `${result.stdout}${result.stderr}`;
  };
  // Hash every relative file name and its bytes through a read-only mount;
  // an RDF dump alone cannot detect a changed Lucene or journal file.
  const backupBytes = () => docker(['run', '--rm', '--network', 'none',
    '--volume', `${backup}:/backup:ro`, '--entrypoint', 'sh', pinnedImage(), '-ec',
    "cd /backup; find . -type f -exec sha256sum {} + | LC_ALL=C sort | sha256sum"]).trim();
  try {
    started = true;
    await rootCommand(['stack:up', ...stack.args], 180_000);
    const lineage = { dataEpoch: stack.apps.MAIN_DATA_EPOCH!, routingEpoch: stack.apps.MAIN_ROUTING_EPOCH! };
    const fuseki = stack.fuseki;
    await initializeFreshGraph(fuseki, lineage);
    const generation = (client: FusekiClient) => {
      const dependencies = { environment: { fuseki: client, lineage }, account: {}, access: {} } as MainWorkDependencies;
      const app = searchGenerationRoutes(client, dependencies);
      return async () => {
        const response = await app.handle(new Request('http://main.local/v1/search/generations/current'));
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
    };
    const title = `Crash qualification ${randomUUID()}`;
    const created = await activateMetadataWork({ fuseki, lineage, objectDirectory: stack.apps.MAIN_OBJECT_DIRECTORY! }, {
      title, admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `crash-contract-${randomUUID()}`, requestDigest: metadataWorkRequestDigest(title),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const committed = await generation(fuseki)();
    expect(committed.status).toBe(200);
    expect(committed.body.state).toBe('active');
    const beforeDelta = await fuseki.searchDeltaSince('-1');
    evidence.committed = { receipt: created.receipt, generation: committed, delta: beforeDelta,
      health: await fuseki.commandHealth() };
    record();
    expect(stack.compose(['kill', '-s', 'SIGKILL', 'fuseki']).status).toBe(0);
    // There is no public pre-audit state while the process is dead. Capture
    // actual transport/API answers; restart readiness already includes auditing.
    let deadHealth: unknown;
    try {
      const response = await fetch(new URL('command', stack.apps.FUSEKI_URL!), { signal: AbortSignal.timeout(2000) });
      deadHealth = { status: response.status, body: await response.text() };
      throw new Error('killed native process unexpectedly served command health');
    } catch (error) {
      if (error instanceof Error && error.message.includes('unexpectedly served')) throw error;
      deadHealth = { unavailable: true, error: redact(error instanceof Error ? error.message : String(error)) };
    }
    const deadGeneration = await generation(fuseki)();
    evidence.afterSigkill = { health: deadHealth, generation: deadGeneration };
    record();
    expect(deadGeneration.status).toBe(503);
    // Stop-copy isolation retains the committed RDF and Lucene bytes without
    // admitting any reader on the original killed process's state.
    restoreStateVolume(stack.dockerEnv, pinnedImage(), stack.stateVolume, backup);
    backupCreated = true;
    const restoredFromBytes = backupBytes();
    evidence.producerBackup = { volume: backup, restoredFromBytes };
    restoreStateVolume(stack.dockerEnv, pinnedImage(), backup, failedVolume);
    copied = true;
    const dump = docker(['run', '--rm', '--network', 'none', '--volume', `${failedVolume}:/fuseki/databases`,
      '--entrypoint', 'sh', pinnedImage(), '-ec',
      'java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbdump --loc=/fuseki/databases/rezics/tdb2']);
    expect(dump).toContain(created.receipt);
    expect(dump).toContain(String(committed.body.generation));
    evidence.stoppedCopy = { durableReceiptPresent: true, rdfGeneration: committed.body.generation,
      volume: failedVolume, originalVolume: stack.stateVolume };
    record();
    await stack.runner.start();
    const receipt = await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(created.receipt)} rv:outcome rv:Succeeded . }
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${committed.body.sequence} ;
        rv:textIndexGeneration ${iri(String(committed.body.generation))} . } }`);
    const health = await fuseki.commandHealth() as { textIndexUncertain: boolean };
    const ready = await assertPublicTextReady(fuseki, lineage);
    const after = await generation(fuseki)();
    const delta = await fuseki.searchDeltaSince('-1');
    const logs = redact(stack.compose(['logs', '--no-color', '--tail', '80', 'fuseki']).output);
    evidence.afterSuccessfulAudit = { receipt, health, ready, generation: after, delta, logs };
    record();
    expect(receipt.boolean).toBe(true);
    expect(health.textIndexUncertain).toBe(false);
    expect(after).toMatchObject({ status: 200, body: { state: 'active', sequence: committed.body.sequence,
      generation: committed.body.generation } });
    expect(delta).toMatchObject({ available: true, sequence: committed.body.sequence,
      generation: committed.body.generation });
    expect(logs).toContain('public text crash fence cleared after committed generation audit');
    expect(logs).toContain(`luceneGeneration=${delta.luceneGeneration}`);
    // A missing required public anchor prevents audit qualification. This
    // control is damaged only on its isolated copy; automatic recovery cannot
    // turn an incomplete authority cut into a usable public generation.
    docker(['run', '--rm', '--network', 'none', '--volume', `${failedVolume}:/fuseki/databases`,
      '--entrypoint', 'sh', pinnedImage(), '-ec', `exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/failed-audit.ru <<'RU'
PREFIX rv: <${RV}> DELETE DATA { GRAPH <urn:rezics:search:public> {
  <urn:rezics:search:public:anchor> a rv:SearchGraphAnchor . } }
RU
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/failed-audit.ru`]);
    const controlAt = Date.now();
    const name = `rezics-crash-failed-${randomUUID().slice(0, 12)}`;
    copy = await standaloneFuseki(stack.dockerEnv, { name, volume: failedVolume, image: pinnedImage(),
      secrets: fusekiSecrets(stack.composeEnv) }, { onAllocated: allocated => { copy = allocated; } });
    const client = new FusekiClient(copy.url, stack.composeEnv.FUSEKI_MAINTENANCE_TOKEN!, stack.composeEnv.FUSEKI_COMMAND_TOKEN!);
    const failedHealth = await client.commandHealth() as { textIndexUncertain: boolean };
    const failedGeneration = await generation(client)();
    const failedDelta = await client.searchDeltaSince('-1');
    const failedReceipt = await client.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(created.receipt)} rv:outcome rv:Succeeded . } }`);
    const failedLogs = redact(docker(['logs', '--tail', '80', name]));
    evidence.afterFailedAudit = { health: failedHealth, generation: failedGeneration, delta: failedDelta,
      receipt: failedReceipt, logs: failedLogs, elapsedMs: Date.now() - controlAt };
    record();
    expect(failedReceipt.boolean).toBe(true);
    expect(failedHealth.textIndexUncertain).toBe(true);
    await expect(assertPublicTextReady(client, lineage)).rejects.toBeInstanceOf(SearchIndexUncertain);
    expect(failedGeneration).toMatchObject({ status: 200, body: { state: 'uncertain', population: null,
      sequence: committed.body.sequence, generation: committed.body.generation } });
    expect(failedDelta.available).toBe(false);
    expect(failedLogs).toContain('public anchor absent');
    expect(failedLogs).not.toContain('public text crash fence cleared');
    expect(Date.now() - controlAt).toBeLessThan(600_000);
    expect((await generation(fuseki)()).body.state).toBe('active');
    const finalBackupBytes = backupBytes();
    evidence.producerBackupFinalBytes = finalBackupBytes;
    expect(finalBackupBytes).toBe(restoredFromBytes);
  } finally {
    record();
    copy?.remove();
    if (copied) docker(['volume', 'rm', failedVolume]);
    // Retain the immutable producer backup for the residual cut and review.
    evidence.producerBackupRetained = backupCreated;
    if (started) await rootCommand(['stack:reset', ...stack.args], 120_000);
  }
}, qaStartupTestTimeout(300_000));
