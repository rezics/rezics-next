import { Pool } from 'pg';
import { FusekiClient } from './infrastructure/fuseki.ts';
import { pendingRealmPolicies, recoverRealmPolicies, settleRealmPolicy } from './modules/access/realm-management-recovery.ts';
import type { WorkActivationEnvironment } from './modules/work/activate.ts';

// Operator command uses service credentials to resume committed owner intents:
// task goal -- slot -- bun services/main/src/realm-policy.ts list [cursor]
// task goal -- slot -- bun services/main/src/realm-policy.ts recover [Realm IRI]
const [command, target, ...extra] = process.argv.slice(2);
if (!['list', 'recover'].includes(command ?? '') || extra.length) throw new Error('Use list [cursor] or recover [Realm IRI]');
if (!process.env.ACCESS_DATABASE_URL) throw new Error('ACCESS_DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.ACCESS_DATABASE_URL });
try {
  if (command === 'list') console.log(JSON.stringify(await pendingRealmPolicies(pool, target)));
  else {
    const { FUSEKI_URL, FUSEKI_MAINTENANCE_TOKEN, FUSEKI_COMMAND_TOKEN, MAIN_DATA_EPOCH, MAIN_ROUTING_EPOCH } = process.env;
    if (!FUSEKI_URL || !FUSEKI_COMMAND_TOKEN || !MAIN_DATA_EPOCH || !MAIN_ROUTING_EPOCH) throw new Error('Graph owner environment is required');
    const env: WorkActivationEnvironment = { fuseki: new FusekiClient(FUSEKI_URL, FUSEKI_MAINTENANCE_TOKEN, FUSEKI_COMMAND_TOKEN),
      objectDirectory: '', lineage: { dataEpoch: MAIN_DATA_EPOCH, routingEpoch: MAIN_ROUTING_EPOCH } };
    const result = target ? { realm: target, status: 'completed', replayed: !await settleRealmPolicy(pool, target, env) }
      : await recoverRealmPolicies(pool, env);
    console.log(JSON.stringify(result));
    if ('items' in result && result.items.some(item => item.status === 'pending')) process.exitCode = 1;
  }
} finally { await pool.end(); }
