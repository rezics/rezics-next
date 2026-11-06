/** Test-local SDK process: the parent owns real Auth, personas and the same Realm
 * database. Isolation gives the kernel its actual SDK singleton while the shared
 * harness captures all nested kernel/Access/proof/DBOS statements. */
import { strict as assert } from 'node:assert';
import { createAccess } from '../../src/access/index.ts';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { createAuthConsentReader, readAuthConsentConfig } from '../../src/access/auth-consent.ts';
import { createAccountsWorkModule } from '../../src/access/membership-work.ts';
import { createRealmMembershipReconciler } from '../../src/access/realm-membership-transition-legacy.ts';
import { createRealmMembership, readMembershipInitiator } from '../../src/community/membership.ts';
import { createCommunityWorkModule } from '../../src/community/work.ts';

const communityWorkModule = createCommunityWorkModule({ deadlineNow: () => Date.now() });
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { productionActions } from '../support/production-actions.ts';
import { checkGrowth, openGrowthDatabase, assertGrowthAccessPaths } from '../support/growth.ts';

export type TransitionGrowthConfig = {
  databaseUrl: string;
  accountId: string;
  bearer: string;
  realmId: string;
  legacyAccountId: string;
  issuer: string;
  audience: string;
  jwks: { keys: object[] };
  routeKey: string;
  keys: [number, string][];
};
const config = JSON.parse(await Bun.stdin.text()) as TransitionGrowthConfig;
const db = await openGrowthDatabase(config.databaseUrl);
const tokens = {
  current: config.keys[0]![0],
  keys: new Map(config.keys.map(([id, key]) => [id, Buffer.from(key, 'base64url')])),
};
const env = {
  ...process.env,
  KERNEL_ROUTE_KEY: config.routeKey,
  KERNEL_SESSION_KEYS: config.keys.map(([id, key]) => `${id}:${key}`).join(','),
  AUTH_ISSUER: config.issuer,
  AUTH_AUDIENCE: config.audience,
  AUTH_JWKS_URL: `${config.issuer}/.well-known/jwks.json`,
};
let roleReader: ReturnType<typeof createRealmMembership>['roleReader'] = async () => null;
const access = createAccess({
  actions: productionActions(),
  realmRoleReader: (client, input) => roleReader(client, input),
  auth: {
    issuer: config.issuer,
    audience: config.audience,
    jwksUrl: env.AUTH_JWKS_URL,
    fetch: async () => Response.json(config.jwks),
  },
});
const consent = readAuthConsentConfig(env);
assert(consent);
const realm = createRealmMembership({
  pool: db.pool,
  access,
  referenceKeys: tokens,
  restorer: createInitiatorRestorer({
    pool: db.pool,
    access,
    readOperation: readMembershipInitiator,
    readConsent: createAuthConsentReader(consent),
  }),
});
roleReader = realm.roleReader;
const sdkPool = db.openPool({ max: 6 });
const work = await createWorkClient(db.url, sdkPool);
const runtime = await composeWork([createAccountsWorkModule({ realm, access }), communityWorkModule], {
  databaseUrl: db.url,
  pool: db.pool,
  client: work,
  env,
  executorId: `transition-growth-${crypto.randomUUID()}`,
});
const kernel = createKernel({
  pool: db.pool,
  access,
  workClient: work,
  tokens,
  routeKey: Buffer.from(config.routeKey, 'base64url'),
  writeRate: createWriteRateLimiter({ secret: 'transition-growth-native-write-rate-secret' }),
});
const reconciler = createRealmMembershipReconciler({
  pool: db.pool,
  keys: tokens,
  barrierId: 'stopped-old-writers-growth',
  authority: realm.authority,
  certify: realm.certifyLegacy,
});
try {
  await runtime.launch();
  await reconciler.page({ accountId: config.legacyAccountId });
  const actorRoute = routeOf(config.accountId)!;
  const realmRoute = routeOf(config.realmId)!;
  async function command(method: 'POST' | 'DELETE') {
    const response = await kernel.handle(
      new Request(`http://kernel.test/v1/realms/${config.realmId}/membership`, {
        method,
        headers: { authorization: `Bearer ${config.bearer}`, 'idempotency-key': JSON.stringify(crypto.randomUUID()) },
      }),
    );
    const value = (await response.json()) as { workflowId: string };
    assert.equal(response.status, 202, JSON.stringify(value));
    await work.retrieveWorkflow(value.workflowId).getResult();
  }
  const report = await checkGrowth(db, {
    name: 'native Realm transition publication, exact finalization and selected legacy redrive',
    scales: [64, 512, 4096],
    repetitions: 3,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    includeBackends: true,
    counted: {
      read: (value) => ({ output: (value as { output: number }).output }),
      limits: { output: 1 },
      bounds: { output: 'constant', connections: 'constant' },
    },
    async grow(database, scale, previous) {
      const ids = Array.from({ length: scale - previous }, () => newId(actorRoute));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
        SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) id`,
        [actorRoute, ids],
      );
      await database.admin.query(
        `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
        SELECT $1,id,'realm',$3,id,id FROM unnest($2::uuid[]) id`,
        [actorRoute, ids, config.realmId],
      );
      await database.admin.query(
        `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
        SELECT $1,id,id,$3,'membership',id FROM unnest($2::uuid[]) id`,
        [actorRoute, ids, config.realmId],
      );
      // Historical generations share the actual actor and Realm point prefix.
      // Their proof/receipt facts are population only, never user authority.
      await database.admin.query(
        `INSERT INTO access.realm_membership_transition
        (route,account_id,realm_id,reservation_id,generation_id,operation_id,hold_transaction_id,proof_transaction_id,outcome,consumed_transaction_id)
        SELECT $1,$3,$4,id,id,'noise:'||id,id,id,'published',id FROM unnest($2::uuid[]) id`,
        [actorRoute, ids, config.accountId, config.realmId],
      );
      await database.admin.query(
        `INSERT INTO community.realm_membership_proof
        (route,realm_id,account_id,reservation_id,generation_id,operation_id,outcome,transaction_id,principal_id,command_kind,command_key,at)
        SELECT $1,$3,$4,id,id,'noise:'||id,'published',id,$4,'community.realm.membership','noise:'||id,'2000-01-01'
        FROM unnest($2::uuid[]) id`,
        [realmRoute, ids, config.realmId, config.accountId],
      );
      await database.admin.query(
        `INSERT INTO core.receipt
        (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
        SELECT $1,'account',$3,'community.realm.membership','noise:'||id,decode(repeat('0',64),'hex'),1,1,id,
         jsonb_build_object('realmId',$4::text,'accountId',$3::text,'reservationId',id::text,'transition',
           jsonb_build_object('generationId',id::text,'operationId','noise:'||id,'outcome','published'))
        FROM unnest($2::uuid[]) id`,
        [realmRoute >>> 4, ids, config.accountId, config.realmId],
      );
      await database.admin.query(
        `INSERT INTO community.realm_member
        (route,realm_id,account_id,reservation_id,role,valid,transaction_id)
        SELECT $1,$3,$4,id,'member',tstzrange('2000-01-01'::timestamptz+(n+$5)*interval '2 seconds',
         '2000-01-01'::timestamptz+((n+$5)*2+1)*interval '1 second','[)'),id
        FROM unnest($2::uuid[]) WITH ORDINALITY x(id,n)`,
        [realmRoute, ids, config.realmId, config.accountId, previous],
      );
    },
    async operation() {
      await command('POST');
      await command('DELETE');
      const page = await reconciler.page({ accountId: config.legacyAccountId, redrive: true });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]!.state, 'pending');
      return { output: page.items.length };
    },
  });
  assertGrowthAccessPaths('Realm transition', report.samples, [
    'access.realm_membership_transition',
    'community.realm_membership_proof',
    'core.receipt',
  ]);
  for (const sample of report.samples) {
    const statements = sample.statementRepetitions
      .flat()
      .map((item) => item.statement)
      .join('\n');
    assert.match(statements, /realm_membership_transition/);
    assert.match(statements, /realm_membership_proof/);
    assert.match(statements, /dbos\./);
    const controls = sample.occurrenceRepetitions
      .flatMap((run) => run.statements)
      .filter((item) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(item.statement.trim()));
    // The shared ledger owns attribution; raw occurrences remain in the report.
    assert(sample.backendRepetitions.every((backends) => backends.length > 0));
    assert(controls.length > 0);
  }
  console.log(
    'TRANSITION_GROWTH ' + JSON.stringify(report.samples.map(({ scale, cost, counted }) => ({ scale, cost, counted }))),
  );
} finally {
  await runtime.shutdown();
  await work.close();
  await db.close();
}
