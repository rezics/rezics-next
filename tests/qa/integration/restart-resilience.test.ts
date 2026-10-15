import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { assertCommandProfiles } from '../../../services/main/src/infrastructure/profile.ts';
import { ContentProjectionWorker } from '../../../services/main/src/content-projection-worker.ts';
import { deliverRetainedContentEligibilityOnce } from '../../../services/main/src/modules/content-publication/eligibility-delivery.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { PostgresRateLimitStore, type RateLimitOptions } from '../../../services/main/src/modules/rate-limit/store.ts';
import { ensureLocalDatasetModelGeneration } from '../../../scripts/datasets/model-bootstrap.ts';
import { readEnv, stackDirectory } from '../../../scripts/dev/config.ts';
import { commandAsync } from '../../../scripts/qa/core.ts';

const root = resolve(import.meta.dir, '../../..');
function stack() {
  const runId = process.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through isolated integration QA');
  const directory = stackDirectory(root, { profile: 'qa', runId });
  return { runId, directory, apps: readEnv(join(directory, 'apps.env')) };
}
async function docker(...args: string[]) {
  const result = await commandAsync(root, 'docker', args, 60_000);
  if (!result.ok) throw new Error(`Docker ${args[0]} failed: ${result.output}`);
}
async function postgresReady(pool: Pool) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await pool.query('SELECT 1'); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

test('Content projection resumes its persisted cut after a PostgreSQL restart without walking acknowledged history', async () => {
  const { runId, apps } = stack();
  const epoch = randomUUID(), history = 1001, consumer = `restart-${randomUUID()}`;
  const relay = new Pool({ connectionString: apps.MAIN_RELAY_DATABASE_URL });
  const contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
  let closed = false;
  const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN, apps.FUSEKI_COMMAND_TOKEN);
  const env = { fuseki, lineage: { dataEpoch: epoch, routingEpoch: '1' }, objectDirectory: apps.MAIN_OBJECT_DIRECTORY! };
  try {
    await migrateContent(contentPool);
    // Retained zero-event maintenance batches exercise the real delivery cursor
    // without manufacturing public eligibility or graph authority.
    await relay.query(`INSERT INTO relay.delivered_batch
      (stream_scope,data_epoch,sequence,batch_id,routing_epoch,event_count)
      SELECT $1,$2,n,'restart-' || n,'1',0 FROM generate_series(1,$3) n`,
    [MAIN_RELAY_STREAM_SCOPE, epoch, history]);
    await relay.query(`INSERT INTO relay.checkpoint (consumer,stream_scope,data_epoch,sequence)
      VALUES ($1,$2,$3,$4)`, [consumer, MAIN_RELAY_STREAM_SCOPE, epoch, history]);
    const content = new ContentCore(contentPool);
    while (await deliverRetainedContentEligibilityOnce(env, content, relay, consumer)) { /* build one durable cut */ }
    const cursor = new ContentProjectionCursor(contentPool);
    const projectionConsumer = `restart-projection-${randomUUID()}`;
    await cursor.initialize(projectionConsumer);
    const before = await cursor.readScan(projectionConsumer);
    await Promise.all([relay.end(), contentPool.end()]);
    closed = true;
    const restartedAt = performance.now();
    await docker('restart', `rezics-qa-${runId}-postgres-1`);
    const freshRelay = new Pool({ connectionString: apps.MAIN_RELAY_DATABASE_URL });
    const freshContent = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    const restored = new ContentCore(freshContent), restoredCursor = new ContentProjectionCursor(freshContent);
    const completed = Promise.withResolvers<void>();
    const faults: unknown[] = [];
    const worker = new ContentProjectionWorker(async () => {
      await deliverRetainedContentEligibilityOnce(env, restored, freshRelay, consumer);
      const result = await relayContentProjectionOnce(env, restored, restoredCursor, projectionConsumer);
      completed.resolve();
      return result;
    }, 1000, error => { faults.push(error); completed.reject(error); });
    const timeout = setTimeout(() => completed.reject(new Error('projection restart exceeded 30 seconds')), 30_000);
    try {
      await postgresReady(freshRelay);
      const pollAt = performance.now();
      worker.start();
      await completed.promise;
      const resumeMs = Math.round(performance.now() - pollAt);
      console.log(JSON.stringify({ measurement: 'projection-restart', history, resumeMs,
        restartToReadyMs: Math.round(performance.now() - restartedAt) }));
      expect(await restoredCursor.readScan(projectionConsumer)).toEqual(before);
      expect(faults).toEqual([]);
      expect(resumeMs).toBeLessThan(3000);
    } finally {
      clearTimeout(timeout);
      await worker.stop();
      await Promise.all([freshRelay.end(), freshContent.end()]);
    }
  } finally {
    if (!closed) await Promise.all([relay.end(), contentPool.end()]);
  }
}, 90_000);

test('rate budgets admit ordinary traffic immediately after reconstruction and retain exhausted windows', async () => {
  const { runId, apps } = stack();
  const options: RateLimitOptions = { secret: 'restart-test-secret-at-least-32-characters', serviceClientIds: new Set(),
    trustedProxyPeers: new Set(), clientIpHeader: 'x-forwarded-for' };
  const budget = { maximum: 2, seconds: 60 }, identity = `restart-${randomUUID()}`;
  let pool = boundedPool({ connectionString: apps.ACCESS_DATABASE_URL });
  try {
    const first = new PostgresRateLimitStore(pool, options);
    expect((await first.consume(identity, 'search', budget)).allowed).toBe(true);
    expect((await first.consume(`${identity}-spent`, 'search', { maximum: 1, seconds: 60 })).allowed).toBe(true);
    await pool.end();
    const storageRestartedAt = performance.now();
    await docker('restart', `rezics-qa-${runId}-postgres-1`);
    pool = boundedPool({ connectionString: apps.ACCESS_DATABASE_URL });
    await postgresReady(pool);
    const restartedAt = performance.now(), restored = new PostgresRateLimitStore(pool, options);
    restored.startExpirySweep();
    try {
      expect((await restored.consume(identity, 'search', budget)).allowed).toBe(true);
      const readyMs = Math.round(performance.now() - restartedAt);
      console.log(JSON.stringify({ measurement: 'rate-limit-restart', readyMs,
        restartToReadyMs: Math.round(performance.now() - storageRestartedAt) }));
      expect(readyMs).toBeLessThan(3000);
      expect((await restored.consume(identity, 'search', budget)).allowed).toBe(false);
      expect((await restored.consume(`${identity}-spent`, 'search', { maximum: 1, seconds: 60 })).allowed).toBe(false);
      await pool.query(`UPDATE access.rate_limit_v1 SET expires_at = now() - interval '1 second'`);
      expect((await restored.consume(identity, 'search', budget)).allowed).toBe(true);
    } finally { await restored.stopExpirySweep(); }
  } finally { await pool.end(); }
}, 30_000);

test('model bootstrap waits for the same Fuseki volume to become ready after restart', async () => {
  const { runId, directory, apps } = stack();
  const fixture = { apps, importOperation: `urn:rezics:operation:fixture-${randomUUID().replaceAll('-', '')}` };
  await new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!, bucket: apps.MAIN_S3_BUCKET!,
    region: apps.MAIN_S3_REGION, accessKeyId: apps.MAIN_S3_ACCESS_KEY!, secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/work/' }).initialize();
  await ensureLocalDatasetModelGeneration(directory, fixture);
  await docker('restart', `rezics-qa-${runId}-fuseki-1`);
  const startedAt = performance.now();
  // This was bootstrap's first await before it learned to wait for readiness.
  // Record whether that same single attempt can survive this real restart.
  let singleAttempt = 'ready';
  try { await assertCommandProfiles(new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN, apps.FUSEKI_COMMAND_TOKEN)); }
  catch { singleAttempt = 'unavailable'; }
  console.log(JSON.stringify({ measurement: 'model-bootstrap-single-attempt', state: singleAttempt,
    elapsedMs: Math.round(performance.now() - startedAt) }));
  const result = await ensureLocalDatasetModelGeneration(directory, fixture);
  console.log(JSON.stringify({ measurement: 'model-bootstrap-restart', readyMs: Math.round(performance.now() - startedAt) }));
  expect(result.state).toBe('current');
}, 120_000);
