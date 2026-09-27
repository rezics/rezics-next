import { Pool } from 'pg';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { relayMainOutboxOnce } from './modules/outbox/relay.ts';
import { cleanEnv } from 'envalid';
import { relaySpec } from './config.ts';

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
  while (running) {
    const batch = await relayMainOutboxOnce(fuseki, pool, consumer);
    if (!batch) await Bun.sleep(interval);
  }
} finally {
  await pool.end();
}
