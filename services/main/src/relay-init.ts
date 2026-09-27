import { Pool } from 'pg';
import { cleanEnv } from 'envalid';
import { initializeRelayCheckpoint } from './modules/outbox/relay.ts';
import { relayInitSpec } from './config.ts';

const config = cleanEnv(process.env, relayInitSpec);
const pool = new Pool({ connectionString: config.MAIN_RELAY_DATABASE_URL });
try {
  await initializeRelayCheckpoint(pool, config.MAIN_RELAY_CONSUMER, config.MAIN_DATA_EPOCH);
} finally {
  await pool.end();
}
