import { resolve, join } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { SourceAuthorNameStore } from '../../services/main/src/modules/source/author-name.ts';
import { SourceIntakeStore } from '../../services/main/src/modules/source/intake.ts';
import { parseOptions, readEnv, stackDirectory } from '../dev/config.ts';

const args = process.argv.slice(2);
const index = args.indexOf('--after');
const after = index < 0 ? null : args[index + 1];
if (index >= 0) {
  if (!after) throw new Error('--after requires the previous page cursor');
  args.splice(index, 2);
}
const options = parseOptions(args);
const root = resolve(import.meta.dir, '../..');
const apps = readEnv(join(stackDirectory(root, options), 'apps.env'));
const fuseki = new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
const pool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 2,
  statement_timeout: 2_000, connectionTimeoutMillis: 5_000 });
try {
  const names = new SourceAuthorNameStore(pool, new SourceIntakeStore(pool), fetch, fuseki);
  console.log(JSON.stringify(await names.publishNativePage(after ?? null)));
} finally { await pool.end(); }
