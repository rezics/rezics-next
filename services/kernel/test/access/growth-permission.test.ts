import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess as createPermissionAccess } from '../../src/access/permission.ts';
import { creationCapability, parentCreationAuthorization } from '../../src/access/parent-creation.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import type { AccountActor, Resource } from '../../src/request/access.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthCheck,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const action = 'subject:read';
const anchorRoute = 0x6789;
const anchorPartition = partitionOf(anchorRoute);
const ordinalsPerScaleUnit = 100;
const runsPerScale = 4;
const schema = 'growth_permission_test';
const resources = `${schema}.resources`;

let db: GrowthDatabase | undefined;
let actorId = '';
let organizationId = '';
let transactionId = '';
let target: Resource;
let actor: AccountActor;
let permissions: ReturnType<typeof createPermissionAccess>;

const seededAccountIds: string[] = [];
const seededResourceIds: string[] = [];

// This population matches lifecycle-create.sql account inserts and grant-create.sql's one-action direct grants.
const population: Population = {
  name: 'access-permission-unrelated',
  hotPartition: anchorPartition,
  hotShare: 1,
  rows: ({ route }) => {
    const accountId = newId(route);
    const resourceId = newId(route);
    const rowTransactionId = newId(route);
    seededAccountIds.push(accountId);
    seededResourceIds.push(resourceId);
    return {
      'access.account': [
        {
          route,
          account_id: accountId,
          kind: 'actor',
          handle: null,
          state: 'pending',
          registration_id: null,
          registration_expires_at: null,
          transaction_id: rowTransactionId,
        },
      ],
      'access.resource_grant': [
        {
          route,
          resource_id: resourceId,
          subject_kind: 'identity',
          subject_id: accountId,
          subject_role: '',
          action,
          valid: '(,)',
          transaction_id: rowTransactionId,
        },
      ],
    };
  },
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  actorId = newId(anchorRoute);
  organizationId = newId(anchorRoute);
  transactionId = newId(anchorRoute);
  target = { route: anchorRoute, id: newId(anchorRoute) };
  actor = {
    kind: 'account',
    accountId: actorId,
    clientId: 'growth-test',
    scopes: [action],
    requestedBy: null,
    authnEpoch: 1,
  };

  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${resources} (
    route integer NOT NULL,
    id uuid NOT NULL,
    creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
    PRIMARY KEY (route, id)
  )`);
  await db.admin.query(`INSERT INTO ${resources} (route, id) VALUES ($1, $2)`, [target.route, target.id]);
  // Keep the fixture's anchored parent and child reads on the primary-key plan at every measured scale.
  const unrelatedResources = Array.from({ length: 1_024 }, () => newId(anchorRoute));
  await db.admin.query(
    `INSERT INTO ${resources} (route, id)
     SELECT $1, resource_id FROM unnest($2::uuid[]) AS rows(resource_id)`,
    [anchorRoute, unrelatedResources],
  );
  await db.admin.query(`ANALYZE ${resources}`);

  // These direct fixture writes use the same account, membership and grant columns as Access test fixtures.
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $3), ($1, $4, 'organization', 'active', $3)`,
    [anchorRoute, actorId, transactionId, organizationId],
  );
  await db.admin.query(
    `INSERT INTO access.organization_member
     (route, organization_id, member_account_id, role, valid, transaction_id)
     VALUES ($1, $2, $3, 'owner', '(,)'::tstzrange, $4)`,
    [anchorRoute, organizationId, actorId, transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant
     (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
     VALUES ($1, $2, 'identity', $3, 'owner', $4, '(,)'::tstzrange, $5)`,
    [target.route, target.id, organizationId, action, transactionId],
  );

  const account = await readAccount(db.pool, anchorRoute, actorId);
  if (!account) throw new Error('Growth fixture actor account was not readable');
  permissions = createPermissionAccess({
    actions: new Map([[action, { anonymous: false }]]),
    accountEvidence: () => account,
  });
}, 90_000);

afterAll(async () => {
  if (!db) return;
  try {
    if (seededResourceIds.length)
      await db.admin.query('DELETE FROM access.resource_grant WHERE resource_id = ANY($1::uuid[])', [
        seededResourceIds,
      ]);
    if (target?.id)
      await db.admin.query('DELETE FROM access.resource_grant WHERE route = $1 AND resource_id = $2', [
        target.route,
        target.id,
      ]);
    if (organizationId && actorId)
      await db.admin.query(
        'DELETE FROM access.organization_member WHERE route = $1 AND organization_id = $2 AND member_account_id = $3',
        [anchorRoute, organizationId, actorId],
      );
    const accounts = [...seededAccountIds, actorId, organizationId].filter(Boolean);
    if (accounts.length)
      await db.admin.query('DELETE FROM access.account WHERE account_id = ANY($1::uuid[])', [accounts]);
    await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await db.close();
  }
});

function growth(name: string, operation: GrowthCheck['operation']): GrowthCheck {
  return {
    name,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    warmups: 1,
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
        from: previous * ordinalsPerScaleUnit,
        to: scale * ordinalsPerScaleUnit,
      });
    },
    operation,
  };
}

async function prepare(growthDb: GrowthDatabase, resource = target): Promise<unknown> {
  const evidence = await permissions.prepare!(actor, action, resource, {
    pool: growthDb.pool,
    deadline: Date.now() + 5_000,
  });
  if (typeof evidence !== 'object' || evidence === null) throw new Error('Permission preparation produced no evidence');
  return evidence;
}

test('Permission preparation stays within its bound as O grows', async () => {
  const report = await checkGrowth(
    db!,
    growth('Permission preparation stays within its bound as O grows', async (growthDb) => prepare(growthDb)),
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(report.samples.every(({ cost }) => cost.statements === 3)).toBe(true);
}, 85_000);

test('Final permission check stays within its bound as G grows', async () => {
  const evidenceByRun = new Map<number, unknown>();
  const check = growth('Final permission check stays within its bound as G grows', async (growthDb, _scale, run) => {
    const evidence = evidenceByRun.get(run);
    if (!evidence) throw new Error(`No prepared permission evidence for run ${run}`);
    const client = await growthDb.pool.connect();
    try {
      if (!(await permissions.authorize(client, actor, action, target, evidence)))
        throw new Error('The bounded resource grant did not authorize its actor');
    } finally {
      client.release();
    }
  });
  const grow = check.grow;
  const scaleIndex = new Map([
    [1, 0],
    [8, 1],
    [64, 2],
  ]);
  await checkGrowth(db!, {
    ...check,
    grow: async (growthDb, scale, previous) => {
      await grow(growthDb, scale, previous);
      const firstRun = scaleIndex.get(scale)! * runsPerScale;
      for (let run = firstRun; run < firstRun + runsPerScale; run++) evidenceByRun.set(run, await prepare(growthDb));
    },
  });
  expect(evidenceByRun.size).toBe(runsPerScale * 3);
}, 85_000);

test('Parent creation authorization stays within its bound as G grows', async () => {
  const operation: GrowthCheck['operation'] = async (growthDb) => {
    const child: Resource = { route: target.route, id: newId(target.route) };
    const deadline = Date.now() + 5_000;
    const authorization = parentCreationAuthorization({
      access: permissions,
      actor,
      action,
      parent: {
        resource: target,
        async validate(client) {
          return (
            (await client.query(`SELECT 1 FROM ${resources} WHERE route = $1 AND id = $2`, [target.route, target.id]))
              .rowCount === 1
          );
        },
      },
      context: {
        pool: growthDb.pool,
        deadline,
        resource: child,
        creation: {
          async validate(tx, resource) {
            return (
              (
                await tx.query(
                  `SELECT 1 FROM ${resources}
                     WHERE route = $1 AND id = $2 AND creation_xid = pg_current_xact_id()`,
                  [resource.route, resource.id],
                )
              ).rowCount === 1
            );
          },
        },
      },
    });
    await runCommand(
      growthDb.pool,
      {
        partition: partitionOf(child.route),
        deadline,
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        authorization,
      },
      async (tx) => {
        await tx.query(`INSERT INTO ${resources} (route, id) VALUES ($1, $2)`, [child.route, child.id]);
        await creationCapability(tx, child, actor.accountId);
        return { value: child, events: [{ type: 'com.rezics.growth.parent-created.v1', data: child }] };
      },
    );
  };
  const report = await checkGrowth(
    db!,
    growth('Parent creation authorization stays within its bound as G grows', operation),
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
}, 85_000);
