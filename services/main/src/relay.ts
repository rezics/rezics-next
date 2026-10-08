import { boundedPool } from './infrastructure/pg-pool.ts';
import { shutdownTelemetry, withWorkerTelemetry } from '@rezics/observability/runtime';
import { telemetryLog } from '@rezics/observability/log';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { relayMainOutboxOnce, RelayEventBlocked } from './modules/outbox/relay.ts';
import { cleanEnv } from 'envalid';
import { relaySpec } from './config.ts';
import { runMainRelay } from './modules/outbox/worker.ts';
import { S3ImmutableObjects } from './infrastructure/immutable-objects.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody } from './modules/outbox/receipt-custody.ts';
import { proofRetirementSender } from './modules/graph/slim-command.ts';

const config = cleanEnv(process.env, relaySpec);
const interval = config.MAIN_RELAY_INTERVAL_MS;
if (!Number.isInteger(interval) || interval < 100 || interval > 60_000) {
  throw new Error('MAIN_RELAY_INTERVAL_MS must be an integer from 100 to 60000');
}

const fuseki = new FusekiClient(config.FUSEKI_URL, config.FUSEKI_MAINTENANCE_TOKEN, config.FUSEKI_COMMAND_TOKEN);
const pool = boundedPool({ connectionString: config.MAIN_RELAY_DATABASE_URL });
const accessPool = boundedPool({ connectionString: config.ACCESS_DATABASE_URL });
const ownerOutbox = config.MAIN_S3_ENDPOINT ? new ReceiptCustody(new PostgresReceiptCustodyStore(accessPool),
  new S3ImmutableObjects({ endpoint: config.MAIN_S3_ENDPOINT, bucket: config.MAIN_S3_BUCKET,
    region: config.MAIN_S3_REGION, accessKeyId: config.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: config.MAIN_S3_SECRET_KEY!, prefix: 'semantic/work/' }), fuseki,
  config.FUSEKI_TITLE_ADMISSION_KEY, proofRetirementSender(config.FUSEKI_URL, config.FUSEKI_COMMAND_TOKEN)) : undefined;
const consumer = config.MAIN_RELAY_CONSUMER;
let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

try {
  telemetryLog('main_relay_started');
  await runMainRelay(() => withWorkerTelemetry('main.outbox.relay', async () => !!await relayMainOutboxOnce(fuseki, pool, consumer, { ownerOutbox }),
    worked => ({ outcome: worked ? 'worked' : 'idle', processed: worked ? 1 : 0, unit: 'batch' })), () => running, interval,
    { consumer });
} catch (error) {
  console.error(JSON.stringify(error instanceof RelayEventBlocked
    ? { level: 'error', event: 'main_relay_blocked', consumer,
      dataEpoch: error.batch.dataEpoch, sequence: error.batch.sequence,
      batchId: error.batch.batchId, eventId: error.eventId, reason: error.reason }
    : { level: 'error', event: 'main_relay_failed', consumer,
      reason: error instanceof Error ? error.message : String(error) }));
  throw error;
} finally {
  try { await Promise.all([pool.end(), accessPool.end()]); }
  finally { telemetryLog('main_relay_stopped'); await shutdownTelemetry(); }
}
