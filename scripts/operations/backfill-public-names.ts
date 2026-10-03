import { resolve, join } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { COMMAND_MODULE_VERSION } from '../../services/main/src/infrastructure/profile.ts';
import { backfillPublicNameProjections } from '../../services/main/src/modules/search/backfill.ts';
import { parseOptions, readEnv, stackDirectory } from '../dev/config.ts';

const args = process.argv.slice(2);
const take = (flag: string) => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
};
const batches = Number(take('--batches') ?? '64');
const restart = args.includes('--restart');
if (restart) args.splice(args.indexOf('--restart'), 1);
const options = parseOptions(args);
const root = resolve(import.meta.dir, '../..');
const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
const fuseki = new FusekiClient(
  apps.FUSEKI_URL!,
  apps.FUSEKI_MAINTENANCE_TOKEN!,
  apps.FUSEKI_COMMAND_TOKEN!,
);
if ((await fuseki.commandHealth()).moduleVersion !== COMMAND_MODULE_VERSION)
  throw new Error(
    `Deploy Fuseki command module ${COMMAND_MODULE_VERSION} before backfilling names`,
  );
const pool = new Pool({
  connectionString: apps.ACCESS_DATABASE_URL,
  max: 2,
  statement_timeout: 10_000,
  connectionTimeoutMillis: 5000,
});
try {
  console.log(
    JSON.stringify(
      await backfillPublicNameProjections(
        {
          fuseki,
          lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
          objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
        },
        pool,
        batches,
        restart,
      ),
    ),
  );
} finally {
  await pool.end();
}
