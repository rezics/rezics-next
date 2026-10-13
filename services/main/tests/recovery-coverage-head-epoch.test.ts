import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { sealRecoveryPayload } from '../../account/src/recovery-envelope.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { cloneQaOwnerDatabases } from '../../../tests/qa/support/databases.ts';
import { fusekiSecrets, pinnedImage, qaStack, standaloneFuseki } from
  '../../../tests/qa/fault-recovery/search-ops-support.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../src/modules/access/admission.ts';
import { assertRetainedAuthorityCapture } from '../src/modules/erasure/authority.ts';
import { journalErasure } from '../src/modules/erasure/journal.ts';
import { assertCurrentRecoveryCoverageHead, RecoveryCoverageHeadConflict,
  retainRecoveryCoverageHead } from '../src/modules/outbox/recovery-coverage-head.ts';
import { initializeRelayCheckpoint } from '../src/modules/outbox/relay.ts';
import { hash, initializeFreshGraph } from '../src/modules/work/activate.ts';
import { assertRecoveryCoverage, captureGraphRecoveryCoverage, type RecoveryCoverage } from
  '../src/modules/work/restore-lineage.ts';

let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let graph: Awaited<ReturnType<typeof standaloneFuseki>>;
let access: Pool, account: Pool, content: Pool, sourceRelay: Pool, retainedRelay: Pool;
let fuseki: FusekiClient, consumer: string, generation: string;
let qa: ReturnType<typeof qaStack>;
const hmacKey = 'd3'.repeat(32);
const volume = `rezics-coverage-epoch-${randomUUID()}`;

beforeAll(async () => {
  const started = Date.now(), runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated QA owner tier');
  qa = qaStack(runId);
  databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content', 'relay'], 'owner');
  const pool = (url: string) => new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 1500 });
  access = pool(databases.urls.access); account = pool(databases.urls.account);
  content = pool(databases.urls.content); sourceRelay = pool(databases.urls.relay);
  await migrateContent(content);
  graph = await standaloneFuseki(qa.dockerEnv, {
    name: volume, volume, image: pinnedImage(),
    secrets: fusekiSecrets(qa.composeEnv),
  });
  fuseki = new FusekiClient(graph.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);
  const lineage = { dataEpoch: randomUUID(), routingEpoch: '1' };
  await initializeFreshGraph(fuseki, lineage);
  consumer = `coverage-epoch:${randomUUID()}`;
  await initializeRelayCheckpoint(sourceRelay, consumer, lineage.dataEpoch);
  generation = await engageAccessRecoveryFence(access);
  expect(Date.now() - started).toBeLessThan(600_000);
}, 120_000);

afterAll(async () => {
  await Promise.allSettled([access?.end(), account?.end(), content?.end(), sourceRelay?.end(), retainedRelay?.end()]);
  graph?.remove();
  if (qa) spawnSync('docker', ['volume', 'rm', '-f', volume], { env: qa.dockerEnv, timeout: 60_000 });
  await databases?.close();
}, 60_000);

async function capture(relay: Pool) {
  const coverage = await captureGraphRecoveryCoverage(fuseki, account, access, relay, consumer, content);
  assertRecoveryCoverage(coverage);
  return { coverage, sealedCoverage: JSON.stringify(sealRecoveryPayload(coverage, hmacKey,
    'graph-recovery-coverage')), hmacKey };
}

async function erase(relay: Pool) {
  const ref = randomUUID();
  return journalErasure(relay, {
    operationId: randomUUID(), requestDigest: hash(ref), kind: 'revision',
    principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: generation,
    targets: [{ kind: 'content_revision', ref }],
  });
}

async function retainedState() {
  return {
    heads: (await retainedRelay.query(`SELECT to_jsonb(head) AS row
      FROM relay.recovery_coverage_head head ORDER BY consumer`)).rows,
    authority: (await retainedRelay.query(`SELECT to_jsonb(authority) AS row
      FROM relay.current_authority_coverage authority ORDER BY id`)).rows,
    epoch: (await retainedRelay.query<{ epoch: string | null }>(
      'SELECT max(erasure_epoch)::text AS epoch FROM relay.erasure')).rows[0]!.epoch,
  };
}

async function assertPublished(coverage: RecoveryCoverage, sealedCoverage: string) {
  await assertCurrentRecoveryCoverageHead(retainedRelay, coverage);
  expect(await assertRetainedAuthorityCapture(retainedRelay, consumer, { sealedCoverage, hmacKey }))
    .toEqual(coverage);
  const state = await retainedState();
  expect(state.heads).toHaveLength(1);
  expect(state.authority).toHaveLength(1);
  expect(state.heads[0]!.row.erasure_epoch?.toString() ?? null).toBe(coverage.erasureJournal!.epoch);
  expect(state.authority[0]!.row.coverage_digest).toBe(state.heads[0]!.row.coverage_digest);
  expect(state.authority[0]!.row.coverage_generation).toBe(state.heads[0]!.row.generation);
  return state;
}

test('signed current coverage publishes at the retained journal epoch; historical and superseded captures refuse without changing authority', async () => {
  const historical = await capture(sourceRelay);
  expect(historical.coverage.erasureJournal!.epoch).toBeNull();
  await retainRecoveryCoverageHead(sourceRelay, historical.sealedCoverage, hmacKey);
  // The head write advances real cluster WAL, just as the physical restore fixture's second capture does.
  const historicalNewer = await capture(sourceRelay);
  const { accountPg: firstPg, ...firstOwners } = historical.coverage;
  const { accountPg: newerPg, ...newerOwners } = historicalNewer.coverage;
  expect(newerOwners).toEqual(firstOwners);
  expect((await account.query('SELECT $2::pg_lsn > $1::pg_lsn AS advanced',
    [firstPg.flushedLsn, newerPg.flushedLsn])).rows).toEqual([{ advanced: true }]);
  expect(historicalNewer.sealedCoverage).not.toBe(historical.sealedCoverage);

  const firstErasure = await erase(sourceRelay);
  const current = await capture(sourceRelay);
  expect(current.coverage.erasureJournal!.epoch).toBe(firstErasure.erasureEpoch);
  const retainedUrl = await databases.snapshot('relay', () => sourceRelay.end());
  retainedRelay = new Pool({ connectionString: retainedUrl, max: 2, connectionTimeoutMillis: 1500 });
  const beforeHistoricalRefusal = await retainedState();
  expect(beforeHistoricalRefusal.epoch).toBe(firstErasure.erasureEpoch);
  await expect(retainRecoveryCoverageHead(retainedRelay, historicalNewer.sealedCoverage, hmacKey))
    .rejects.toThrow('relay erasure journal moved after current coverage capture');
  const afterHistoricalRefusal = await retainedState();
  expect(afterHistoricalRefusal).toEqual(beforeHistoricalRefusal);
  await assertCurrentRecoveryCoverageHead(retainedRelay, historical.coverage);

  await retainRecoveryCoverageHead(retainedRelay, current.sealedCoverage, hmacKey);
  const published = await assertPublished(current.coverage, current.sealedCoverage);
  expect(published.heads[0]!.row.generation).toBe(beforeHistoricalRefusal.heads[0]!.row.generation + 1);
  expect(published.authority[0]!.row.revision).toBe(beforeHistoricalRefusal.authority[0]!.row.revision + 1);

  const secondErasure = await erase(retainedRelay);
  expect(BigInt(secondErasure.erasureEpoch)).toBeGreaterThan(BigInt(firstErasure.erasureEpoch));
  const beforeStaleRefusal = await retainedState();
  expect(beforeStaleRefusal.epoch).toBe(secondErasure.erasureEpoch);
  await expect(retainRecoveryCoverageHead(retainedRelay, current.sealedCoverage, hmacKey))
    .rejects.toBeInstanceOf(RecoveryCoverageHeadConflict);
  const afterStaleRefusal = await retainedState();
  expect(afterStaleRefusal).toEqual(beforeStaleRefusal);
  await assertCurrentRecoveryCoverageHead(retainedRelay, current.coverage);
  expect(await assertRetainedAuthorityCapture(retainedRelay, consumer, current)).toEqual(current.coverage);

  const latest = await capture(retainedRelay);
  expect(latest.coverage.erasureJournal!.epoch).toBe(secondErasure.erasureEpoch);
  await retainRecoveryCoverageHead(retainedRelay, latest.sealedCoverage, hmacKey);
  const latestPublished = await assertPublished(latest.coverage, latest.sealedCoverage);
  await expect(assertCurrentRecoveryCoverageHead(retainedRelay, current.coverage))
    .rejects.toThrow('signed recovery coverage is not the retained current capture');

  const client = await retainedRelay.connect();
  try {
    for (const mode of ['READ COMMITTED READ ONLY', 'REPEATABLE READ']) {
      await client.query(`BEGIN ISOLATION LEVEL ${mode}`);
      await expect(retainRecoveryCoverageHead(client, latest.sealedCoverage, hmacKey))
        .rejects.toThrow('borrowed recovery head requires an active writable READ COMMITTED transaction');
      await client.query('ROLLBACK');
      expect(await retainedState()).toEqual(latestPublished);
    }
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await expect(retainRecoveryCoverageHead(client, current.sealedCoverage, hmacKey))
      .rejects.toThrow('relay erasure journal moved after current coverage capture');
    expect((await client.query('SELECT 1 AS usable')).rows).toEqual([{ usable: 1 }]);
    expect(await retainedState()).toEqual(latestPublished);
    await retainRecoveryCoverageHead(client, latest.sealedCoverage, hmacKey);
    // Publication retains the actual allocator fence until the caller completes its transaction.
    const observer = await retainedRelay.connect();
    try {
      await observer.query('BEGIN');
      expect((await observer.query(`SELECT pg_try_advisory_xact_lock(
        hashtextextended('rezics-relay-erasure-epoch', 0)) AS available`)).rows)
        .toEqual([{ available: false }]);
    } finally { await observer.query('ROLLBACK'); observer.release(); }
    await client.query('ROLLBACK');
  } finally { await client.query('ROLLBACK'); client.release(); }
  expect(await retainedState()).toEqual(latestPublished);
  await expect(retainRecoveryCoverageHead(retainedRelay, latest.sealedCoverage, 'e4'.repeat(32)))
    .rejects.toThrow();
  expect(await retainedState()).toEqual(latestPublished);

  const artifacts = Bun.env.REZICS_QA_ARTIFACT_DIR;
  if (!artifacts) throw new Error('QA evidence directory is unavailable');
  writeFileSync(join(artifacts, 'recovery-coverage-head-epoch.json'), JSON.stringify({
    historical: historical.coverage, historicalNewer: historicalNewer.coverage,
    current: current.coverage, latest: latest.coverage, firstErasure, secondErasure,
    beforeHistoricalRefusal, afterHistoricalRefusal, published,
    beforeStaleRefusal, afterStaleRefusal, latestPublished,
  }, null, 2), { mode: 0o600 });
}, 60_000);
