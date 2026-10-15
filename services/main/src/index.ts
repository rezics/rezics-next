import { Pool } from 'pg';
import { boundedPool } from './infrastructure/pg-pool.ts';
import { shutdownTelemetry } from '@rezics/observability/runtime';
import { telemetryLog } from '@rezics/observability/log';
import { migrateContent } from '../../content/src/index.ts';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { mainLifecycle } from './lifecycle.ts';
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
  try { await migrateContent(migration, undefined, { accessUrl: config.ACCESS_DATABASE_URL }); } finally { await migration.end(); }
}
const composed = await composeMain({
  config, fuseki, accessPool: pool, contentPool, relayPool, erasureRelayPool, ownerRelayPool,
  recommendationRelayPool,
});
const lifecycle = mainLifecycle(composed, () => {
  composed.app.listen({ hostname: process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1', port });
  telemetryLog('main_listening');
});
await lifecycle.start();

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await lifecycle.stop();
  } finally {
    try { await Promise.all([pool.end(), contentPool.end(), relayPool?.end(), erasureRelayPool?.end(), ownerRelayPool?.end(), recommendationRelayPool?.end()]); }
    finally { telemetryLog('main_stopped'); await shutdownTelemetry(); }
  }
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
