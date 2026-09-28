import { Pool } from 'pg';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { relayMainOutboxOnce, RelayEventBlocked } from './modules/outbox/relay.ts';
import { cleanEnv } from 'envalid';
import { relaySpec } from './config.ts';
import { runMainRelay } from './modules/outbox/worker.ts';

const config = cleanEnv(process.env, relaySpec);
const interval = config.MAIN_RELAY_INTERVAL_MS;
if (!Number.isInteger(interval) || interval < 100 || interval > 60_000) {
  throw new Error('MAIN_RELAY_INTERVAL_MS must be an integer from 100 to 60000');
}

const fuseki = new FusekiClient(config.FUSEKI_URL, config.FUSEKI_MAINTENANCE_TOKEN, config.FUSEKI_COMMAND_TOKEN);
const pool = new Pool({ connectionString: config.MAIN_RELAY_DATABASE_URL });
const consumer = config.MAIN_RELAY_CONSUMER;
let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

try {
  await runMainRelay(async () => !!await relayMainOutboxOnce(fuseki, pool, consumer), () => running, interval,
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
  await pool.end();
}
