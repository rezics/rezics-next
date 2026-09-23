import { Pool } from 'pg';
import { initializeRelayCheckpoint } from './modules/outbox/relay.ts';

function required(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const pool = new Pool({ connectionString: required('MAIN_RELAY_DATABASE_URL') });
try {
  await initializeRelayCheckpoint(pool, required('MAIN_RELAY_CONSUMER'), required('MAIN_DATA_EPOCH'));
} finally {
  await pool.end();
}
