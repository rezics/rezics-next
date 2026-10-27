import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  createAgentVerificationCommands,
  readPendingAgentVerificationRequests,
} from '../../src/access/agent-verification.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { newId } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { migrate } from '../../scripts/database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL must name the migrated test database');
const accountRoute = 0x5235;
const catalogueSubject = newId(0x6544);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(41)]]) };
const actions = new Map(
  ['account:update', 'account:read', 'account:manage', 'account:verify_agent'].map((action) => [
    action,
    { anonymous: false },
  ]),
);
let owner: Pool;
let databaseName: string;
let databaseUrl: string;
let db: GrowthDatabase;
let access: ReturnType<typeof admittedAccess>;
let commands: ReturnType<typeof createAgentVerificationCommands>;
let requestContexts: Array<{
  actor: Awaited<ReturnType<typeof authenticateAccount>>;
  pool: GrowthDatabase['pool'];
  deadline: number;
}>;
let governanceContext: {
  actor: Awaited<ReturnType<typeof authenticateAccount>>;
  pool: GrowthDatabase['pool'];
  deadline: number;
};
let requestIds: string[] = [];
let decidedIds: string[] = [];
let pendingRequestId: string;

async function insertDecidedRequests(database: GrowthDatabase, count: number): Promise<string[]> {
  const requestIds = Array.from({ length: count }, () => newId(0));
  const accountIds = Array.from({ length: count }, () => newId(0x5236));
  await database.admin.query(
    `INSERT INTO access.agent_verification_request
      (route, request_id, account_id, account_kind, requested_by, catalogue_subject_id, statement,
       links, state, reason, decision_receipt_id, decided_by, transaction_id)
     SELECT 0, request_id, account_id, 'actor', $3, $4, 'Previously decided request', '[]'::jsonb,
            'rejected', 'Not approved', request_id, $3, request_id
     FROM unnest($1::uuid[], $2::uuid[]) seed(request_id, account_id)`,
    [requestIds, accountIds, governanceContext.actor.accountId, catalogueSubject],
  );
  decidedIds.push(...requestIds);
  return requestIds;
}

beforeAll(async () => {
  owner = new Pool({ connectionString: sourceUrl, max: 1 });
  databaseName = `agent_verification_growth_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(sourceUrl!);
  target.pathname = `/${databaseName}`;
  databaseUrl = target.toString();
  await owner.query(`CREATE DATABASE "${databaseName}"`);
  migrate(databaseUrl);
  db = await openGrowthDatabase(databaseUrl);
  access = admittedAccess({ actions });
  commands = createAgentVerificationCommands({ pool: db.pool, access, clock: () => new Date() });

  const requests = Array.from({ length: 24 }, () => newId(accountRoute));
  const governance = newId(accountRoute);
  await db.admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id)
     SELECT $1, account_id, 'actor', 'active', account_id FROM unnest($2::uuid[]) seed(account_id)`,
    [accountRoute, [...requests, governance]],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     SELECT $1, account_id, account_id, 'account:update', '(,)', account_id
     FROM unnest($2::uuid[]) seed(account_id)`,
    [accountRoute, requests],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES (0, $1, $2, 'account:verify_agent', '(,)', $2)`,
    [PLATFORM_RESOURCE.id, governance],
  );

  requestContexts = [];
  for (const accountId of requests) {
    const actor = await authenticateAccount(
      access,
      { pool: db.pool, deadline: Date.now() + 10_000 },
      { accountId, clientId: 'agent-verification-growth', scopes: ['account:update'] },
    );
    requestContexts.push({ actor, pool: db.pool, deadline: Date.now() + 10_000 });
  }
  const governanceActor = await authenticateAccount(
    access,
    { pool: db.pool, deadline: Date.now() + 10_000 },
    { accountId: governance, clientId: 'agent-verification-growth', scopes: ['account:verify_agent'] },
  );
  governanceContext = { actor: governanceActor, pool: db.pool, deadline: Date.now() + 10_000 };
}, 60_000);

afterAll(async () => {
  try {
    await db?.close();
  } finally {
    try {
      if (databaseName) await dropTestDatabase(owner, databaseName);
    } finally {
      await owner?.end();
    }
  }
}, 30_000);

test('agent verification request stays bounded as decided requests grow', async () => {
  let nextRequest = 0;
  const report = await checkGrowth(db, {
    name: 'agent verification request stays bounded as decided requests grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    warmups: 1,
    async grow(database, scale, previous) {
      await insertDecidedRequests(database, scale - previous);
    },
    async operation() {
      const context = requestContexts[nextRequest++];
      if (!context) throw new Error('Growth check exhausted its unique request accounts');
      const result = await commands.request(context, {
        accountId: context.actor.accountId,
        subject: catalogueSubject,
        statement: 'This account is associated with the catalogue person.',
        links: [],
        key: randomUUID(),
      });
      requestIds.push(result.value.id);
      expect(result.value.state).toBe('pending');
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.relations?.['access.agent_verification_request']?.rows).toBeGreaterThan(0);
  }

  await db.admin.query('DELETE FROM access.agent_verification_request WHERE request_id = ANY($1::uuid[])', [
    [...requestIds, ...decidedIds],
  ]);
  requestIds = [];
  decidedIds = [];
});

test('pending agent verification page stays bounded as decided requests grow', async () => {
  pendingRequestId = newId(0);
  await db.admin.query(
    `INSERT INTO access.agent_verification_request
      (route, request_id, account_id, account_kind, requested_by, catalogue_subject_id, statement, links, state, transaction_id, created_at)
     VALUES (0, $1, $2, 'actor', $3, $4, 'Pending request', '[]'::jsonb, 'pending', $1, '2000-01-01T00:00:00Z')`,
    [pendingRequestId, requestContexts[0]!.actor.accountId, governanceContext.actor.accountId, catalogueSubject],
  );
  const report = await checkGrowth(db, {
    name: 'pending agent verification page stays bounded as decided requests grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    warmups: 1,
    grow: async (database, scale, previous) => {
      await insertDecidedRequests(database, scale - previous);
    },
    async operation() {
      const page = await readPendingAgentVerificationRequests(
        db.pool,
        access,
        governanceContext,
        tokens,
        { limit: 1 },
        new Date(),
      );
      expect(page.verificationRequests).toHaveLength(1);
      expect(page.verificationRequests[0]!.id).toBe(pendingRequestId);
      expect(page.next).toBeNull();
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.relations?.['access.agent_verification_request']?.rows).toBe(1);
  }
}, 60_000);
