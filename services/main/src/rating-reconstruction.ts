import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import {
  listLegacyTargetsNeedingReconstruction,
  reconstructLegacyTargetRatings,
  type LegacyRatingCursor,
} from './modules/rating/legacy-reconstruction.ts';

const args = process.argv.slice(2);
const take = (flag: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
};
const envFile = take('--env'),
  context = take('--context'),
  target = take('--target');
const batches = Number(take('--batches') ?? '1'),
  batchSize = Number(take('--batch-size') ?? '100');
const restart = args.includes('--restart');
if (restart) args.splice(args.indexOf('--restart'), 1);
const list = args.includes('--list');
if (list) args.splice(args.indexOf('--list'), 1);
const afterContext = take('--after-context'),
  afterTarget = take('--after-target');
if (
  args.length ||
  !envFile ||
  (!list && (!context || !target)) ||
  (list && (target || batches !== 1 || restart || !afterContext !== !afterTarget)) ||
  !Number.isInteger(batches) ||
  batches < 1 ||
  batches > 32 ||
  !Number.isInteger(batchSize) ||
  batchSize < 1 ||
  batchSize > 100
) {
  throw new Error(
    'Use --env <apps.env> --context <IRI> --target <IRI> [--batches 1..32] [--batch-size 1..100] [--restart]\n' +
      'or --env <apps.env> --list [--context <IRI>] [--batch-size 1..100] [--after-context <IRI> --after-target <IRI>]',
  );
}
const env = readEnv(resolve(envFile));
const requireValue = (name: string) => {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name} in the environment file`);
  return value;
};
if (list) {
  const pool = new Pool({
    connectionString: requireValue('ACCESS_DATABASE_URL'),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  });
  try {
    console.log(
      JSON.stringify(
        await listLegacyTargetsNeedingReconstruction(pool, {
          ...(context ? { context } : {}),
          ...(afterContext && afterTarget ? { after: { context: afterContext, target: afterTarget } } : {}),
          limit: batchSize,
        }),
      ),
    );
  } finally {
    await pool.end();
  }
  process.exit(0);
}
if (!context || !target) throw new Error('--context and --target are required');
const identity = createHash('sha256').update(JSON.stringify({ context, target })).digest('hex');
const checkpoint = join(process.cwd(), '.temp/rating-reconstruction', `${identity}.json`);
let saved: { cursor: LegacyRatingCursor | null; complete: boolean } | undefined;
if (!restart) {
  try {
    saved = JSON.parse(readFileSync(checkpoint, 'utf8')) as typeof saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
const pool = new Pool({
  connectionString: requireValue('ACCESS_DATABASE_URL'),
  max: 2,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});
try {
  const environment = {
    fuseki: new FusekiClient(
      requireValue('FUSEKI_URL'),
      requireValue('FUSEKI_MAINTENANCE_TOKEN'),
      requireValue('FUSEKI_COMMAND_TOKEN'),
    ),
    lineage: {
      dataEpoch: requireValue('MAIN_DATA_EPOCH'),
      routingEpoch: requireValue('MAIN_ROUTING_EPOCH'),
    },
    objectDirectory: requireValue('MAIN_OBJECT_DIRECTORY'),
  };
  let result;
  // Rechecking a completed job is cheap and detects a later recovery cut. A lost
  // response or checkpoint cannot duplicate values because the owner applies CAS.
  for (let index = 0; index < batches; index++) {
    result = await reconstructLegacyTargetRatings(environment, pool, {
      context,
      target,
      batchSize,
      ...(saved?.cursor ? { cursor: saved.cursor } : {}),
    });
    saved = { cursor: result.cursor, complete: result.complete };
    mkdirSync(dirname(checkpoint), { recursive: true });
    const staging = `${checkpoint}.${process.pid}.tmp`;
    writeFileSync(staging, JSON.stringify(saved), { mode: 0o600 });
    renameSync(staging, checkpoint);
    if (result.complete) break;
  }
  console.log(JSON.stringify({ ...result, checkpoint }));
} finally {
  await pool.end();
}
