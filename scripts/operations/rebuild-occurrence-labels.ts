import { join, resolve } from 'node:path';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { backfillOccurrenceLabels } from '../../services/main/src/modules/structure/label-index-backfill.ts';
import { parseOptions, readEnv, stackDirectory } from '../dev/config.ts';

// task goal -- slot -- bun scripts/operations/rebuild-occurrence-labels.ts
//   [--generation <IRI> --reset --job <stable-id>] [stack options]
// No reset: online backfill, resumed from committed native descriptors.
// Reset: rebuild one generation; search is unavailable until coverage returns.
const root = resolve(import.meta.dir, '../..'), args = process.argv.slice(2);
function option(name: string) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(at, 2); return value;
}
const generation = option('--generation'), job = option('--job'), reset = args.includes('--reset');
if (reset) args.splice(args.indexOf('--reset'), 1);
const apps = readEnv(join(stackDirectory(root, parseOptions(args)), 'apps.env'));
const result = await backfillOccurrenceLabels({
  fuseki: new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!),
  lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! },
  objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
}, { generation, reset, job });
console.log(JSON.stringify(result));
