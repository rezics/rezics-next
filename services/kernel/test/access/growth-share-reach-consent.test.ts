import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Type } from 'typebox';
import { createInternalConsentHandler } from '../../../auth/src/internal-consent.ts';
import { migrate } from '../../../auth/scripts/database.ts';
import { createAuthConsentReader } from '../../src/access/auth-consent.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { shareAccount } from '../../src/access/account-share.ts';
import { createAccess } from '../../src/access/permission.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { PLATFORM_RESOURCE } from '../../src/access/governance-reach.ts';
import { principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { registerEventTypes } from '../../src/events/catalogue.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { resetGrowthTables } from './growth-reset.ts';

const eventType = 'com.rezics.test.access-growth.v1';
registerEventTypes({
  [eventType]: Type.Object({ accountId: Type.String() }, { additionalProperties: false }),
});

const shareAction = 'subject:write';
const shareRoute = 0x2345;
const otherRoute = 0x6789;
const shareRunsPerScale = 4;
const shareEvidence = new Map<string, NonNullable<Awaited<ReturnType<typeof readAccount>>>>();
const shareProbes = new Map<string, { actor: AccountActor; route: number; id: string }>();
const shareSpare = new Map<number, { actor: AccountActor; route: number; id: string }>();
type AccountActor = {
  kind: 'account';
  accountId: string;
  clientId: string;
  scopes: readonly string[];
  requestedBy: null;
  authnEpoch: number;
};

let database: GrowthDatabase;
let shareAccess: ReturnType<typeof createAccess>;

beforeAll(async () => {
  database = await openGrowthDatabase();
  migrate(database.url);
  shareAccess = createAccess({
    actions: new Map([[shareAction, { anonymous: false }]]),
    accountEvidence: (actor) => shareEvidence.get(actor.accountId) ?? null,
  });
}, 120_000);

afterAll(async () => {
  jwksServer?.stop(true);
  await database?.close();
});

function accountActor(accountId: string, authnEpoch = 1): AccountActor {
  return {
    kind: 'account',
    accountId,
    clientId: 'growth-share-client',
    scopes: [shareAction],
    requestedBy: null,
    authnEpoch,
  };
}

async function insertAccounts(target: GrowthDatabase, route: number, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await target.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
     SELECT $1,id,'actor','active',id,true FROM unnest($2::uuid[]) id`,
    [route, ids],
  );
}

async function insertShareDecoys(target: GrowthDatabase, ids: readonly string[], action = shareAction): Promise<void> {
  if (ids.length === 0) return;
  await target.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,id,$2,'(,)',id
     FROM unnest($1::uuid[]) id`,
    [ids, action],
  );
  await target.admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
     SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,id,$2,'resource','(,)',id
     FROM unnest($1::uuid[]) id`,
    [ids, action],
  );
  await target.admin.query(
    `INSERT INTO access.resource_role_grant
      (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
     SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,'identity',id,'','growth.unrelated','(,)',id
     FROM unnest($1::uuid[]) id`,
    [ids],
  );
  await target.admin.query(
    `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
     SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,'organization',$2,id,id
     FROM unnest($1::uuid[]) id`,
    [ids, newId(0x3456)],
  );
  await target.admin.query(
    `INSERT INTO access.principal_assignment
      (route,principal_id,request_id,assigned_actor_id,valid,issued_valid,creator_principal_id,transaction_id)
     SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,id,id,'(,)','(,)',id,id
     FROM unnest($1::uuid[]) id`,
    [ids],
  );
}

async function insertReceiptDecoys(target: GrowthDatabase, partition: number, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await target.admin.query(
    `INSERT INTO core.receipt
      (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
     SELECT $1,'account',id,'growth.share.decoy','decoy-'||id,decode(repeat('00',32),'hex'),1,1,id,'{}'::jsonb
     FROM unnest($2::uuid[]) id`,
    [partition, ids],
  );
}

async function seedShareProbe(target: GrowthDatabase, scale: number, repetition: number, spare = false): Promise<void> {
  const id = newId(shareRoute);
  await insertAccounts(target, shareRoute, [id]);
  await target.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$2,$3,'(,)',$2)`,
    [shareRoute, id, shareAction],
  );
  const account = await readAccount(target.admin, shareRoute, id);
  if (!account) throw new Error('Growth account fixture was not inserted');
  shareEvidence.set(id, account);
  const probe = { actor: accountActor(id, Number(account.minimumAuthnEpoch)), route: shareRoute, id };
  if (spare) shareSpare.set(scale, probe);
  else shareProbes.set(`${scale}:${repetition}`, probe);
}

async function shareOperation(
  target: GrowthDatabase,
  probe: { actor: AccountActor; route: number; id: string },
  key: string,
) {
  const authorization = resourceAuthorization({
    access: shareAccess,
    actor: probe.actor,
    action: shareAction,
    anchor: {
      resource: { route: probe.route, id: probe.id },
      async validate(client) {
        const result = await client.query(
          "SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2 AND state='active'",
          [probe.route, probe.id],
        );
        return result.rowCount === 1;
      },
    },
    context: {
      pool: target.pool,
      deadline: Date.now() + 30_000,
      partition: partitionOf(probe.route),
    },
  });
  const outcome = await runCommand(
    target.pool,
    {
      ...principalCommandIdentity(probe.actor),
      partition: partitionOf(probe.route),
      deadline: Date.now() + 30_000,
      receipt: { kind: 'growth.share-account', key, digest: Buffer.alloc(32) },
      authorization,
    },
    async (tx) => {
      expect(await shareAccount(tx, probe.id)).toBe('active');
      return {
        value: true,
        events: [{ type: eventType, subject: probe.id, data: { accountId: probe.id } }],
      };
    },
  );
  expect(outcome.replayed).toBe(false);
}

function growthSeries(
  error: Error & {
    samples?: readonly { scale: number; cost: { rows: number; blocks: number; statements: number } }[];
  },
) {
  return (
    error.samples?.map(({ scale, cost }) => ({
      scale,
      rows: cost.rows,
      blocks: cost.blocks,
      statements: cost.statements,
    })) ?? []
  );
}

async function printEvidence(
  label: string,
  error: Error & {
    samples?: readonly { scale: number; cost: { rows: number; blocks: number; statements: number } }[];
    violations?: unknown;
  },
  target: GrowthDatabase,
  operation: () => Promise<unknown>,
  matches: (sql: string) => boolean,
): Promise<void> {
  const measured = await capture(target, operation);
  const statements = measured.capture.statements
    .map((sql, index) => ({ sql, plan: measured.capture.plans[index] }))
    .filter(({ sql }) => matches(sql));
  console.info(
    `[growth evidence: ${label}] ${JSON.stringify({
      series: growthSeries(error),
      violations: error.violations,
      statements,
    })}`,
  );
}

// account-share.sql's FOR SHARE lookup can grow in block work as same-route account rows increase.
test('Account share stays within its bound as unrelated accounts in its partition grow', async () => {
  await resetGrowthTables(database.admin, [
    'access.account',
    'access.resource_grant',
    'access.resource_role_grant',
    'access.resource_denial',
    'access.membership_inverse',
    'access.principal_assignment',
    'core.receipt',
  ]);
  shareEvidence.clear();
  shareProbes.clear();
  shareSpare.clear();

  let failure: unknown;
  try {
    await checkGrowth(database, {
      name: 'account share',
      scales: [1, 8, 64],
      repetitions: 3,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(target, scale, previous) {
        const count = (scale - previous) * 500;
        const sameRoute = Array.from({ length: count }, () => newId(shareRoute));
        const otherPartition = Array.from({ length: count }, () => newId(otherRoute));
        await insertAccounts(target, shareRoute, sameRoute);
        await insertAccounts(target, otherRoute, otherPartition);
        await insertShareDecoys(target, [...sameRoute, ...otherPartition]);
        await insertReceiptDecoys(target, partitionOf(shareRoute), sameRoute);
        await insertReceiptDecoys(target, partitionOf(otherRoute), otherPartition);

        const scaleIndex = [1, 8, 64].indexOf(scale);
        const firstRepetition = scaleIndex * shareRunsPerScale;
        for (let repetition = 0; repetition < shareRunsPerScale; repetition++)
          await seedShareProbe(target, scale, firstRepetition + repetition);
        await seedShareProbe(target, scale, 99, true);
      },
      operation: async (target, scale, repetition) => {
        const probe = shareProbes.get(`${scale}:${repetition}`);
        if (!probe) throw new Error(`Missing share probe for ${scale}:${repetition}`);
        await shareOperation(target, probe, `share:${scale}:${repetition}`);
      },
      warmup: async (target, scale, repetition) => {
        const probe = shareProbes.get(`${scale}:${repetition}`);
        if (!probe) throw new Error(`Missing share warm-up probe for ${scale}:${repetition}`);
        await shareOperation(target, probe, `share:warmup:${scale}:${repetition}`);
      },
    });
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) return;
  if (!(failure instanceof Error) || failure.name !== 'GrowthBoundError') throw failure;
  const spare = shareSpare.get(64);
  if (!spare) throw new Error('Missing spare account share probe');
  await printEvidence(
    'account share',
    failure as Error & {
      samples?: readonly { scale: number; cost: { rows: number; blocks: number; statements: number } }[];
      violations?: unknown;
    },
    database,
    () => shareOperation(database, spare, 'share:diagnostic:64'),
    (sql) => /FOR SHARE/i.test(sql),
  );
  throw failure;
}, 180_000);

const reachAction = 'moderation:takedown';
const reachRoute = 0x3456;
const reachOtherRoute = 0x789a;
const reachActorId = newId(reachRoute);
const reachActor: AccountActor = {
  kind: 'account',
  accountId: reachActorId,
  clientId: 'growth-reach-client',
  scopes: [reachAction],
  requestedBy: null,
  authnEpoch: 1,
};
let reachAccount: NonNullable<Awaited<ReturnType<typeof readAccount>>>;
let reachAccess: ReturnType<typeof createAccess>;

async function reachOperation(target: GrowthDatabase, key: string): Promise<void> {
  const resource = { route: reachRoute, id: reachActorId };
  const authorization = resourceAuthorization({
    access: reachAccess,
    actor: reachActor,
    action: reachAction,
    anchor: {
      resource,
      async validate(client) {
        const result = await client.query(
          "SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2 AND state='active'",
          [reachRoute, reachActorId],
        );
        return result.rowCount === 1;
      },
    },
    context: { pool: target.pool, deadline: Date.now() + 30_000, partition: partitionOf(reachRoute) },
  });
  const outcome = await runCommand(
    target.pool,
    {
      ...principalCommandIdentity(reachActor),
      partition: partitionOf(reachRoute),
      deadline: Date.now() + 30_000,
      receipt: { kind: 'growth.governance-reach', key, digest: Buffer.alloc(32) },
      authorization,
    },
    async () => ({
      value: true,
      events: [{ type: eventType, subject: reachActorId, data: { accountId: reachActorId } }],
    }),
  );
  expect(outcome.replayed).toBe(false);
  expect(reachAccount.accountId).toBe(reachActorId);
  const recorded = await target.admin.query(
    `SELECT count(*)::integer AS count FROM access.governance_reach
     WHERE route=$1 AND transaction_id=$2 AND action=$3 AND resource_id=$4`,
    [reachRoute, outcome.transactionId, reachAction, reachActorId],
  );
  expect(recorded.rows[0]?.count).toBe(1);
}

// governance-reach-record.sql's conflict-checking INSERT can grow in block work with same-route reach-record history.
test('Governance reach use stays within its bound as reach records grow', async () => {
  await resetGrowthTables(database.admin, [
    'access.account',
    'access.resource_grant',
    'access.resource_role_grant',
    'access.resource_denial',
    'access.governance_reach',
    'access.membership_inverse',
    'access.principal_assignment',
    'core.receipt',
  ]);
  await insertAccounts(database, reachRoute, [reachActorId]);
  reachAccount = (await readAccount(database.admin, reachRoute, reachActorId))!;
  if (!reachAccount) throw new Error('Growth governance actor was not inserted');
  reachAccess = createAccess({
    actions: new Map([[reachAction, { anonymous: false }]]),
    accountEvidence: (actor) => (actor.accountId === reachActorId ? reachAccount : null),
  });
  await database.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$5)`,
    [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, reachActorId, reachAction, newId(0)],
  );

  let failure: unknown;
  try {
    await checkGrowth(database, {
      name: 'governance reach use in a successful command',
      scales: [1, 8, 64],
      repetitions: 3,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(target, scale, previous) {
        const count = (scale - previous) * 500;
        const sameAccounts = Array.from({ length: count }, () => newId(reachRoute));
        const otherAccounts = Array.from({ length: count }, () => newId(reachOtherRoute));
        await insertAccounts(target, reachRoute, sameAccounts);
        await insertAccounts(target, reachOtherRoute, otherAccounts);
        await insertShareDecoys(target, [...sameAccounts, ...otherAccounts], reachAction);
        await insertReceiptDecoys(target, partitionOf(reachRoute), sameAccounts);
        await insertReceiptDecoys(target, partitionOf(reachOtherRoute), otherAccounts);

        const sameResources = Array.from({ length: count }, () => newId(reachRoute));
        const otherResources = Array.from({ length: count }, () => newId(reachOtherRoute));
        const rows = [...sameResources, ...otherResources];
        const routes = [...sameResources.map(() => reachRoute), ...otherResources.map(() => reachOtherRoute)];
        const transactions = rows.map(() => newId(0));
        const actors = rows.map(() => newId(reachRoute));
        await target.admin.query(
          `INSERT INTO access.governance_reach(route,transaction_id,action,resource_id,actor_account_id)
           SELECT route,transaction_id,$1,resource_id,actor_account_id
           FROM unnest($2::integer[],$3::uuid[],$4::uuid[],$5::uuid[]) AS rows(route,transaction_id,resource_id,actor_account_id)`,
          [reachAction, routes, transactions, rows, actors],
        );
      },
      operation: async (target, scale, repetition) => {
        await reachOperation(target, `reach:${scale}:${repetition}`);
      },
      warmup: async (target, scale, repetition) => {
        await reachOperation(target, `reach:warmup:${scale}:${repetition}`);
      },
    });
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) return;
  if (!(failure instanceof Error) || failure.name !== 'GrowthBoundError') throw failure;
  await printEvidence(
    'governance reach use',
    failure as Error & {
      samples?: readonly { scale: number; cost: { rows: number; blocks: number; statements: number } }[];
      violations?: unknown;
    },
    database,
    () => reachOperation(database, 'reach:diagnostic:64'),
    (sql) => /INSERT INTO access\.governance_reach/i.test(sql),
  );
  throw failure;
}, 180_000);

const consentPrefix = 'growth-current-consent';
const consentRunsPerScale = 4;
const consentSelectedPerScale = consentRunsPerScale + 1;
const consentProbes = new Map<string, { actorAccountId: string; clientId: string }>();
const consentSpare = new Map<number, { actorAccountId: string; clientId: string }>();
const consentAction = 'subject:write';
const consentServiceToken = 'growth-kernel.access';
const consentAudience = 'growth-auth-consent';
const consentUrl = 'http://127.0.0.1:1/internal/v1/consents:read';
let authPool: ReturnType<GrowthDatabase['openPool']>;
let consentReader: ReturnType<typeof createAuthConsentReader>;
let jwksServer: ReturnType<typeof Bun.serve>;

type ConsentProbe = { actorAccountId: string; clientId: string };

async function insertConsentPopulation(target: GrowthDatabase, scale: number, previous: number): Promise<void> {
  const clientRows: string[] = [];
  const consentAccounts: string[] = [];
  const consentClients: string[] = [];
  const selectedAccounts: string[] = [];
  for (let local = 0; local < consentSelectedPerScale; local++) {
    const actorAccountId = `${consentPrefix}-person-${scale}-${local}`;
    const clientId = `${consentPrefix}-selected-${scale}-${local}`;
    const probe = { actorAccountId, clientId };
    const repetition = [1, 8, 64].indexOf(scale) * consentRunsPerScale + local;
    if (local < consentRunsPerScale) consentProbes.set(`${scale}:${repetition}`, probe);
    else consentSpare.set(scale, probe);
    selectedAccounts.push(actorAccountId);
    clientRows.push(clientId);
    consentAccounts.push(actorAccountId);
    consentClients.push(clientId);
    for (let index = 0; index < scale * 500; index++) {
      const historyClient = `${consentPrefix}-history-${scale}-${local}-${index}`;
      clientRows.push(historyClient);
      consentAccounts.push(actorAccountId);
      consentClients.push(historyClient);
    }
  }

  const unrelatedAccounts = Array.from(
    { length: (scale - previous) * 500 },
    (_, index) => `${consentPrefix}-other-${previous * 500 + index}`,
  );
  const unrelatedClients = unrelatedAccounts.map((id) => `${consentPrefix}-other-client-${id.slice(-24)}`);
  clientRows.push(...unrelatedClients);
  consentAccounts.push(...unrelatedAccounts);
  consentClients.push(...unrelatedClients);

  await target.admin.query(
    `INSERT INTO "user"(id,name,email,"emailVerified")
     SELECT DISTINCT id,'',id||'@growth-consent.test',false FROM unnest($1::text[]) id`,
    [[...selectedAccounts, ...unrelatedAccounts]],
  );
  await target.admin.query(
    `INSERT INTO auth_client(client_id,first_party,scopes)
     SELECT id,false,ARRAY[$2]::text[] FROM unnest($1::text[]) id`,
    [clientRows, consentAction],
  );
  await target.admin.query(
    `INSERT INTO auth_client_coverage(client_id,ready)
     SELECT id,true FROM unnest($1::text[]) id`,
    [clientRows],
  );
  await target.admin.query(
    `INSERT INTO auth_consent(account_id,client_id,scopes)
     SELECT account_id,client_id,ARRAY[$3]::text[]
     FROM unnest($1::text[],$2::text[]) AS consents(account_id,client_id)`,
    [consentAccounts, consentClients, consentAction],
  );
  await target.admin.query(
    `INSERT INTO auth_client_reduction(client_id,operation_id,scopes,first_party)
     SELECT id,'growth-reduction-'||id,ARRAY[]::text[],false
     FROM unnest($1::text[]) id`,
    [unrelatedClients],
  );
}

async function currentConsentRequest(probe: ConsentProbe): Promise<void> {
  const result = await consentReader({
    ...probe,
    deadline: Date.now() + 30_000,
  });
  expect(result).toEqual({ ...probe, scopes: [consentAction] });
}

// current-consent.ts's joined SELECT can grow in block work as same-owner auth_consent history accumulates.
test('Current consent adapter read stays within its bound as consent history grows', async () => {
  consentProbes.clear();
  consentSpare.clear();
  authPool = database.openPool({ max: 1 });
  const keyPair = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(keyPair.publicKey)), kid: 'growth-consent-edge' };
  jwksServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  const issuer = jwksServer.url.origin;
  const authHandler = createInternalConsentHandler({
    database: authPool,
    issuer,
    jwksUrl: `${issuer}/certs`,
    audience: consentAudience,
    allowedServiceTokenIds: [consentServiceToken],
  });
  consentReader = createAuthConsentReader({
    url: consentUrl,
    serviceTokenId: consentServiceToken,
    serviceTokenSecret: 'growth-consent-test-secret',
    async fetch(url, init) {
      expect(url).toBe(consentUrl);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      expect(init.cache).toBe('no-store');
      const headers = new Headers(init.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('CF-Access-Client-Id')).toBe(consentServiceToken);
      expect(headers.get('CF-Access-Client-Secret')).toBe('growth-consent-test-secret');
      const assertion = await new SignJWT({ type: 'app', sub: '', common_name: consentServiceToken })
        .setIssuer(issuer)
        .setAudience([consentAudience])
        .setIssuedAt()
        .setExpirationTime('1m')
        .setProtectedHeader({ alg: 'RS256', kid: 'growth-consent-edge' })
        .sign(keyPair.privateKey);
      headers.set('Cf-Access-Jwt-Assertion', assertion);
      return authHandler(new Request(url, { ...init, headers }));
    },
  });

  let failure: unknown;
  try {
    await checkGrowth(database, {
      name: 'current consent adapter request',
      scales: [1, 8, 64],
      repetitions: 3,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(target, scale, previous) {
        await insertConsentPopulation(target, scale, previous);
      },
      operation: async (_target, scale, repetition) => {
        const probe = consentProbes.get(`${scale}:${repetition}`);
        if (!probe) throw new Error(`Missing current-consent probe for ${scale}:${repetition}`);
        await currentConsentRequest(probe);
      },
      warmup: async (_target, scale, repetition) => {
        const probe = consentProbes.get(`${scale}:${repetition}`);
        if (!probe) throw new Error(`Missing current-consent warm-up probe for ${scale}:${repetition}`);
        await currentConsentRequest(probe);
      },
    });
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) return;
  if (!(failure instanceof Error) || failure.name !== 'GrowthBoundError') throw failure;
  const spare = consentSpare.get(64);
  if (!spare) throw new Error('Missing spare current-consent probe');
  await printEvidence(
    'current consent adapter',
    failure as Error & {
      samples?: readonly { scale: number; cost: { rows: number; blocks: number; statements: number } }[];
      violations?: unknown;
    },
    database,
    () => currentConsentRequest(spare),
    (sql) => /FROM auth_consent c JOIN auth_client/i.test(sql),
  );
  throw failure;
}, 180_000);
