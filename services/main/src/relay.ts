import { boundedPool } from './infrastructure/pg-pool.ts';
import { shutdownTelemetry, withWorkerTelemetry } from '@rezics/observability/runtime';
import { telemetryLog } from '@rezics/observability/log';
import { FusekiClient, fusekiReadBudget } from './infrastructure/fuseki.ts';
import { relayMainOutboxOnce, RelayEventBlocked } from './modules/outbox/relay.ts';
import { cleanEnv } from 'envalid';
import { relaySpec } from './config.ts';
import { runMainRelay } from './modules/outbox/worker.ts';
import { S3ImmutableObjects } from './infrastructure/immutable-objects.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody } from './modules/outbox/receipt-custody.ts';
import { proofRetirementSender } from './modules/graph/slim-command.ts';
import { repairRetainedBatchGraphCut, repairRetainedBatchGraphCuts } from './modules/outbox/repair-graph-cut.ts';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ args: process.argv.slice(2), options: {
  'repair-graph-cut': { type: 'boolean' }, 'data-epoch': { type: 'string' }, sequence: { type: 'string' },
  'repair-graph-cuts': { type: 'boolean' }, after: { type: 'string' }, limit: { type: 'string' },
} });
const single = args['repair-graph-cut'];
const bulk = args['repair-graph-cuts'];
if (single && bulk || single && (!args['data-epoch'] || !args.sequence || args.after !== undefined || args.limit !== undefined)
  || bulk && (!args['data-epoch'] || args.sequence !== undefined
    || args.after !== undefined && !/^(0|[1-9][0-9]{0,99})$/.test(args.after)
    || args.limit !== undefined && (!/^[1-9][0-9]{0,3}$/.test(args.limit) || Number(args.limit) > 1000))
  || !single && !bulk && (args['data-epoch'] !== undefined || args.sequence !== undefined
    || args.after !== undefined || args.limit !== undefined)) {
  throw new Error('Use task main:relay -- --repair-graph-cuts --data-epoch <epoch> [--after <sequence>] [--limit <1..1000>] or --repair-graph-cut --data-epoch <epoch> --sequence <sequence>');
}

const config = cleanEnv(process.env, relaySpec);
const interval = config.MAIN_RELAY_INTERVAL_MS;
if (!Number.isInteger(interval) || interval < 100 || interval > 60_000) {
  throw new Error('MAIN_RELAY_INTERVAL_MS must be an integer from 100 to 60000');
}

const fuseki = new FusekiClient(config.FUSEKI_URL, config.FUSEKI_MAINTENANCE_TOKEN, config.FUSEKI_COMMAND_TOKEN);
// Repairs also bound custody's SQL and immutable-object reads, which the exact
// source reader may consult when the native outbox header has been retired.
const repairOptions = single || bulk ? '-c statement_timeout=5s -c lock_timeout=2s -c transaction_timeout=30s' : undefined;
const pool = boundedPool({ connectionString: config.MAIN_RELAY_DATABASE_URL, options: repairOptions });
const accessPool = boundedPool({ connectionString: config.ACCESS_DATABASE_URL, options: repairOptions });
const ownerOutbox = config.MAIN_S3_ENDPOINT ? new ReceiptCustody(new PostgresReceiptCustodyStore(accessPool),
  new S3ImmutableObjects({ endpoint: config.MAIN_S3_ENDPOINT, bucket: config.MAIN_S3_BUCKET,
    region: config.MAIN_S3_REGION, accessKeyId: config.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: config.MAIN_S3_SECRET_KEY!, prefix: 'semantic/work/',
    ...(single || bulk ? { readSignal: () => fusekiReadBudget.getStore()?.signal ?? AbortSignal.timeout(20_000) } : {}) }), fuseki,
  config.FUSEKI_TITLE_ADMISSION_KEY, proofRetirementSender(config.FUSEKI_URL, config.FUSEKI_COMMAND_TOKEN)) : undefined;
const consumer = config.MAIN_RELAY_CONSUMER;
let running = true;
process.on('SIGINT', () => { running = false; });
process.on('SIGTERM', () => { running = false; });

try {
  if (bulk) {
    console.log(JSON.stringify(await repairRetainedBatchGraphCuts(fuseki, pool, args['data-epoch']!,
      args.after, args.limit === undefined ? undefined : Number(args.limit), ownerOutbox)));
  } else if (single) {
    const graphSequence = await repairRetainedBatchGraphCut(fuseki, pool, args['data-epoch']!, args.sequence!, ownerOutbox);
    console.log(JSON.stringify({ event: 'main_relay_graph_cut_repaired', dataEpoch: args['data-epoch'], sequence: args.sequence, graphSequence }));
  } else {
    telemetryLog('main_relay_started');
    await runMainRelay(() => withWorkerTelemetry('main.outbox.relay', async () => !!await relayMainOutboxOnce(fuseki, pool, consumer, { ownerOutbox }),
      worked => ({ outcome: worked ? 'worked' : 'idle', processed: worked ? 1 : 0, unit: 'batch' })), () => running, interval,
      { consumer });
  }
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
  finally { if (!bulk) telemetryLog('main_relay_stopped'); await shutdownTelemetry(); }
}
