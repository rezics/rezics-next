import { Pool } from 'pg';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { relayMainOutboxOnce } from './modules/outbox/relay.ts';

function required(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const interval = Number(Bun.env.MAIN_RELAY_INTERVAL_MS ?? '1000');
if (!Number.isInteger(interval) || interval < 100 || interval > 60_000) {
  throw new Error('MAIN_RELAY_INTERVAL_MS must be an integer from 100 to 60000');
}

const fuseki = new FusekiClient(required('FUSEKI_URL'));
const pool = new Pool({ connectionString: required('MAIN_RELAY_DATABASE_URL') });
const consumer = required('MAIN_RELAY_CONSUMER');
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
