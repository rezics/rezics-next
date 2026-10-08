import { Pool } from 'pg';
import { boundedPool } from './infrastructure/pg-pool.ts';
import { shutdownTelemetry, withWorkerTelemetry } from '@rezics/observability/runtime';
import { logWorkerFault, telemetryLog } from '@rezics/observability/log';
import { migrateContent } from '../../content/src/index.ts';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { prepareLibraryShelves } from './modules/library/backfill.ts';
import { prepareChapterPosts } from './modules/post/backfill.ts';
import { mainConfig } from './config.ts';
import { composeMain } from './composition.ts';

const config = mainConfig();
const fusekiUrl = config.FUSEKI_URL;
const port = config.MAIN_PORT;

const fuseki = new FusekiClient(fusekiUrl, config.FUSEKI_MAINTENANCE_TOKEN, config.FUSEKI_COMMAND_TOKEN);
const pool = boundedPool({ connectionString: config.ACCESS_DATABASE_URL });
// OPS06: the broker lane observes the relay checkpoint through a read-only session.
const relayUrl = config.MAIN_RELAY_DATABASE_URL;
const relayPool = relayUrl ? boundedPool({ connectionString: relayUrl, max: 2,
  options: '-c default_transaction_read_only=on' }) : undefined;
const erasureRelayUrl = relayUrl ?? config.ACCOUNT_RELAY_DATABASE_URL;
const erasureRelayPool = erasureRelayUrl ? boundedPool({ connectionString: erasureRelayUrl, max: 2 }) : undefined;
const ownerRelayUrl = config.OWNER_RELAY_DATABASE_URL ?? relayUrl;
const ownerRelayPool = ownerRelayUrl
  ? boundedPool({ connectionString: ownerRelayUrl, max: 4 }) : undefined;
const recommendationRelayUrl = config.ACCOUNT_RELAY_DATABASE_URL ?? relayUrl;
const recommendationRelayPool = recommendationRelayUrl ? boundedPool({ connectionString: recommendationRelayUrl,
  max: 2, options: '-c default_transaction_read_only=on' }) : undefined;
const contentPool = boundedPool({ connectionString: config.CONTENT_DATABASE_URL });
// Production schemas are applied by the locked release job before writers start.
// A development start migrates on its own connection: DDL may wait on a peer
// that is migrating, which the request bounds would cut short.
if (process.env.NODE_ENV !== 'production') {
  const migration = new Pool({ connectionString: config.CONTENT_DATABASE_URL, max: 1 });
  try { await migrateContent(migration); } finally { await migration.end(); }
}
const composed = await composeMain({
  config, fuseki, accessPool: pool, contentPool, relayPool, erasureRelayPool, ownerRelayPool,
  recommendationRelayPool, startNotificationRealtime: hub => hub.start(),
});
const { app, environment, templateSeek } = composed;
const templatePreparation = templateSeek.backfill(environment.lineage.dataEpoch)
  .catch(error => { console.error('Template directory is unavailable', error); });
void templatePreparation.then(() => templateSeek.startRecovery(environment.lineage.dataEpoch));
// A failed or partial conversion must not take Main down: unconverted chapters
// stay legacy until a restart resumes the migration.
await withWorkerTelemetry('main.post.backfill', () => prepareChapterPosts(environment, pool), undefined, 'startup')
  .catch(error => logWorkerFault('main.post.backfill', error));
app.listen({ hostname: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', port });
telemetryLog('main_listening');
const libraryBackfillController = new AbortController();
const libraryBackfill = withWorkerTelemetry('main.library.backfill', () => prepareLibraryShelves(contentPool, pool, fuseki,
  { signal: libraryBackfillController.signal }), undefined, 'startup').catch(error => {
  if (!libraryBackfillController.signal.aborted) logWorkerFault('main.library.backfill', error);
});
composed.feedWorker?.start();
composed.occurrenceLabelWorker.start();
composed.realmPolicyRecovery.start();
composed.contentProjectionWorker.start();
composed.libraryImportRetentionWorker.start();
composed.mediaScreenWorker.start();
composed.requiredMediaMatchWorker?.start();
composed.mediaRenditionWorker.start();
composed.discoveryWorker?.start();
composed.recommendationWorker?.enablePublicRefresh();
composed.recommendationWorker?.start();
composed.serialStats?.start();
composed.zoneBrowse?.start();
composed.readRankings.start();
composed.correctionWorker.start();
composed.notificationProducerWorker.start();
composed.notificationDigestWorker.start();
composed.rightsCounterNoticeWorker.start();
composed.notificationDeliveryWorker?.start();
composed.statementSeekWorker.start();

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
  await templatePreparation;
  await templateSeek.stopRecovery();
  await composed.occurrenceLabelWorker.stop();
  await composed.statementSeekWorker.stop();
  await composed.realmPolicyRecovery.stop();
  await composed.libraryImportRetentionWorker.stop();
  await composed.mediaScreenWorker.stop();
  await composed.requiredMediaMatchWorker?.stop();
  await composed.mediaRenditionWorker.stop();
  await composed.serialStats?.stop();
  await composed.zoneBrowse?.stop();
  await composed.readRankings.stop();
  libraryBackfillController.abort();
  await libraryBackfill;
  await app.stop();
  await composed.feedWorker?.stop();
  await composed.discoveryWorker?.stop();
  await composed.correctionWorker.stop();
  await composed.notificationProducerWorker.stop();
  await composed.notificationDigestWorker.stop();
  await composed.rightsCounterNoticeWorker.stop();
  await composed.notificationDeliveryWorker?.stop();
  await composed.notificationRealtime?.stop();
  await composed.recommendationWorker?.stop();
  await composed.contentProjectionWorker.stop();
  } finally {
    try { await Promise.all([pool.end(), contentPool.end(), relayPool?.end(), erasureRelayPool?.end(), ownerRelayPool?.end(), recommendationRelayPool?.end()]); }
    finally { telemetryLog('main_stopped'); await shutdownTelemetry(); }
  }
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
