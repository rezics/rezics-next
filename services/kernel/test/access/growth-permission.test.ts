import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess as createPermissionAccess, permissionEvidenceDeadline } from '../../src/access/permission.ts';
import { creationCapability, parentCreationAuthorization } from '../../src/access/parent-creation.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import type { AccountActor, Resource } from '../../src/request/access.ts';
import {
  capture,
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
const ordinalsPerScaleUnit = 500;
const schema = 'growth_permission_test';
const resources = `${schema}.resources`;
const seedEventType = 'com.rezics.growth.permission-seed.v1';
const seedClientId = 'growth-permission-seed';
const seedCommandKind = 'growth-permission-seed';
const anchorEventType = 'com.rezics.growth.permission-anchor.v1';
const receiptDigest = Buffer.alloc(32, 7);

let db: GrowthDatabase | undefined;
let actorId = '';
let principalId = '';
let assignmentRequestId = '';
let organizationId = '';
let transactionId = '';
let target: Resource;
let actor: AccountActor;
let assignmentActor: AccountActor;
let permissions: ReturnType<typeof createPermissionAccess>;

const seededAccountIds: string[] = [];
const seededOrganizationIds: string[] = [];
const seededResourceIds: string[] = [];
const seededTestResourceIds: string[] = [];
const assignmentGrowthPrincipalIds: string[] = [];

function expectIndex(plans: readonly unknown[], expected: string): void {
  let found = false;
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const plan = node as Record<string, unknown>;
    if (typeof plan['Index Name'] === 'string' && plan['Index Name'].startsWith(expected)) found = true;
    if (typeof plan.Plan === 'object' && plan.Plan !== null) visit(plan.Plan);
    if (Array.isArray(plan.Plans)) for (const child of plan.Plans) visit(child);
  };
  for (const plan of plans) visit(plan);
  expect(found, `plan should use ${expected}`).toBe(true);
}

// This population mirrors Access account, organization membership, grant, role-grant and denial rows, fence.sql records, and the resource creation port's route/id insert.
const population: Population = {
  name: 'access-permission-unrelated',
  hotPartition: anchorPartition,
  hotShare: 1,
  rows: ({ ordinal, route, partition }) => {
    const accountId = newId(route);
    const seededOrganizationId = newId(route);
    const resourceId = newId(route);
    const rowTransactionId = newId(route);
    const position = ordinal * 100 + 100;
    seededAccountIds.push(accountId);
    seededAccountIds.push(seededOrganizationId);
    seededOrganizationIds.push(seededOrganizationId);
    seededResourceIds.push(resourceId);
    seededTestResourceIds.push(resourceId);
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
        {
          route,
          account_id: seededOrganizationId,
          kind: 'organization',
          handle: null,
          state: 'active',
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
      'access.organization_member': [
        {
          route,
          organization_id: seededOrganizationId,
          member_account_id: accountId,
          role: 'member',
          valid: '(,)',
          transaction_id: rowTransactionId,
        },
      ],
      'access.resource_role_grant': [
        {
          route,
          resource_id: resourceId,
          subject_kind: 'identity',
          subject_id: accountId,
          subject_role: '',
          grant_role: 'growth.unused',
          valid: '(,)',
          transaction_id: rowTransactionId,
        },
      ],
      'access.resource_denial': [
        {
          route,
          resource_id: resourceId,
          subject_id: accountId,
          subject_role: '',
          action,
          reason: 'resource',
          valid: '(,)',
          transaction_id: rowTransactionId,
        },
      ],
      [`${schema}.resources`]: [{ route, id: resourceId }],
      'core.outbox': [
        {
          partition_no: partition,
          position,
          event_seq: 0,
          event_count: 1,
          epoch: 1,
          id: newId(route),
          type: seedEventType,
          subject: 'seeded',
          data: { value: 1 },
        },
      ],
      'editorial.write_basis': [
        {
          partition_no: partition,
          transaction_id: rowTransactionId,
          epoch: 1,
          position,
          principal_kind: 'account',
          principal_id: actorId,
          client_id: seedClientId,
          requested_by: null,
        },
      ],
      'core.receipt': [
        {
          partition_no: partition,
          principal_kind: 'account',
          principal_id: actorId,
          command_kind: seedCommandKind,
          idempotency_key: `seed-${ordinal}`,
          request_digest: receiptDigest,
          epoch: 1,
          position,
          transaction_id: rowTransactionId,
          response: { ok: true },
        },
      ],
    };
  },
  finish: async (admin, range) => {
    await admin.query(
      `UPDATE core.partition p SET position = GREATEST(p.position, v.position)
       FROM (SELECT partition_no, max(position)::bigint AS position FROM core.outbox
             WHERE position >= $1 * 100 + 100 AND position < $2 * 100 + 100 GROUP BY partition_no) v
       WHERE p.partition_no = v.partition_no`,
      [range.from, range.to],
    );
  },
};

const assignmentGrowthPopulation: Population = {
  name: 'access-permission-assignment-growth',
  hotPartition: anchorPartition,
  hotShare: 1,
  rows: ({ route }) => {
    const seededPrincipalId = newId(route);
    const requestId = newId(route);
    const rowTransactionId = newId(route);
    assignmentGrowthPrincipalIds.push(seededPrincipalId);
    return {
      'access.account': [
        {
          route,
          account_id: seededPrincipalId,
          kind: 'actor',
          handle: null,
          state: 'active',
          registration_id: null,
          registration_expires_at: null,
          transaction_id: rowTransactionId,
        },
      ],
      'access.principal_assignment': [
        {
          route,
          principal_id: seededPrincipalId,
          request_id: requestId,
          assigned_actor_id: actorId,
          creator_principal_id: seededPrincipalId,
          valid: '(,)',
          transaction_id: rowTransactionId,
        },
      ],
      'access.resource_grant': [
        {
          route: anchorRoute,
          resource_id: target.id,
          subject_kind: 'identity',
          subject_id: seededPrincipalId,
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
  principalId = newId(anchorRoute);
  assignmentRequestId = newId(anchorRoute);
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
  assignmentActor = {
    ...actor,
    requestedBy: `urn:rezics:request:${principalId}:${assignmentRequestId}`,
  };

  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${resources} (
    route integer NOT NULL,
    id uuid NOT NULL,
    creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
    PRIMARY KEY (route, id)
  )`);

  // These fixture writes use the account, membership and grant shapes used by existing Access tests.
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $3), ($1, $4, 'organization', 'active', $3),
            ($1, $5, 'actor', 'active', $3)`,
    [anchorRoute, actorId, transactionId, organizationId, principalId],
  );
  await db.admin.query(
    `INSERT INTO access.organization_member
     (route, organization_id, member_account_id, role, valid, transaction_id)
     VALUES ($1, $2, $3, 'owner', '(,)'::tstzrange, $4)`,
    [anchorRoute, organizationId, actorId, transactionId],
  );

  const account = await readAccount(db.pool, anchorRoute, actorId);
  if (!account) throw new Error('Growth fixture actor account was not readable');
  permissions = createPermissionAccess({
    actions: new Map([[action, { anonymous: false }]]),
    accountEvidence: () => account,
  });

  // The fixed parent and its role grant are created before the first scale through the command and Access fixtures used by these tests.
  await runCommand(
    db.pool,
    {
      partition: anchorPartition,
      deadline: Date.now() + 5_000,
      basis: { actorAccountId: actorId, clientId: actor.clientId, requestedBy: null },
    },
    async (tx) => {
      await tx.query(`INSERT INTO ${resources} (route, id) VALUES ($1, $2)`, [target.route, target.id]);
      return {
        value: target,
        events: [{ type: anchorEventType, subject: 'permission-parent', data: target }],
      };
    },
  );
  await db.admin.query(
    `INSERT INTO access.principal_assignment
     (route, principal_id, request_id, assigned_actor_id, creator_principal_id, valid, transaction_id)
     VALUES ($1, $2, $3, $4, $2, '(,)'::tstzrange, $5)`,
    [anchorRoute, principalId, assignmentRequestId, actorId, transactionId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant
     (route, resource_id, subject_kind, subject_id, subject_role, action, valid, transaction_id)
     VALUES ($1, $2, 'identity', $3, '', $4, '(,)'::tstzrange, $5),
            ($1, $2, 'identity', $6, '', $4, '(,)'::tstzrange, $5)`,
    [target.route, target.id, actorId, action, transactionId, principalId],
  );
  await db.admin.query(`ANALYZE ${resources}`);
}, 90_000);

afterAll(async () => {
  if (!db) return;
  try {
    await resetSeededRows();
    if (target?.id)
      await db.admin.query('DELETE FROM access.resource_grant WHERE route = $1 AND resource_id = $2', [
        target.route,
        target.id,
      ]);
    if (assignmentRequestId)
      await db.admin.query(
        'DELETE FROM access.principal_assignment WHERE route = $1 AND principal_id = $2 AND request_id = $3',
        [anchorRoute, principalId, assignmentRequestId],
      );
    if (organizationId && actorId)
      await db.admin.query(
        'DELETE FROM access.organization_member WHERE route = $1 AND organization_id = $2 AND member_account_id = $3',
        [anchorRoute, organizationId, actorId],
      );
    const accounts = [
      ...seededAccountIds,
      ...assignmentGrowthPrincipalIds,
      actorId,
      principalId,
      organizationId,
    ].filter(Boolean);
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

async function resetSeededRows(): Promise<void> {
  const database = db!;
  if (seededResourceIds.length) {
    await database.admin.query('DELETE FROM access.resource_grant WHERE resource_id = ANY($1::uuid[])', [
      seededResourceIds,
    ]);
    await database.admin.query('DELETE FROM access.resource_role_grant WHERE resource_id = ANY($1::uuid[])', [
      seededResourceIds,
    ]);
    await database.admin.query('DELETE FROM access.resource_denial WHERE resource_id = ANY($1::uuid[])', [
      seededResourceIds,
    ]);
  }
  if (assignmentGrowthPrincipalIds.length) {
    await database.admin.query('DELETE FROM access.principal_assignment WHERE principal_id = ANY($1::uuid[])', [
      assignmentGrowthPrincipalIds,
    ]);
    await database.admin.query(
      'DELETE FROM access.resource_grant WHERE route = $1 AND resource_id = $2 AND subject_id = ANY($3::uuid[])',
      [anchorRoute, target.id, assignmentGrowthPrincipalIds],
    );
    await database.admin.query('DELETE FROM access.account WHERE account_id = ANY($1::uuid[])', [
      assignmentGrowthPrincipalIds,
    ]);
  }
  if (seededOrganizationIds.length)
    await database.admin.query('DELETE FROM access.organization_member WHERE organization_id = ANY($1::uuid[])', [
      seededOrganizationIds,
    ]);
  if (seededAccountIds.length)
    await database.admin.query('DELETE FROM access.account WHERE account_id = ANY($1::uuid[])', [seededAccountIds]);
  if (seededTestResourceIds.length)
    await database.admin.query(`DELETE FROM ${resources} WHERE id = ANY($1::uuid[])`, [seededTestResourceIds]);
  await database.admin.query('DELETE FROM core.receipt WHERE command_kind = $1', [seedCommandKind]);
  await database.admin.query('DELETE FROM editorial.write_basis WHERE client_id = $1', [seedClientId]);
  await database.admin.query('DELETE FROM core.outbox WHERE type = $1', [seedEventType]);
  await database.admin.query(
    `UPDATE core.partition p SET position = COALESCE((
       SELECT max(o.position) FROM core.outbox o WHERE o.partition_no = p.partition_no
     ), 0) WHERE p.partition_no = $1`,
    [anchorPartition],
  );
  seededResourceIds.length = 0;
  seededAccountIds.length = 0;
  seededOrganizationIds.length = 0;
  seededTestResourceIds.length = 0;
  assignmentGrowthPrincipalIds.length = 0;
}

async function prepare(pool: Pool, resource = target, principal = actor): Promise<unknown> {
  const evidence = await permissions.prepare!(principal, action, resource, {
    pool,
    deadline: Date.now() + 5_000,
  });
  if (permissionEvidenceDeadline(evidence) === undefined)
    throw new Error('Permission preparation produced no usable evidence');
  return evidence;
}

test('Permission preparation stays within its bound as O grows', async () => {
  await resetSeededRows();
  const report = await checkGrowth(
    db!,
    growth('Permission preparation stays within its bound as O grows', async (growthDb) => prepare(growthDb.pool)),
  );
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(report.samples.every(({ cost }) => cost.statements === 3)).toBe(true);
}, 85_000);

test('Final permission check stays within its bound as G grows', async () => {
  await resetSeededRows();
  await checkGrowth(
    db!,
    growth('Final permission check stays within its bound as G grows', async (growthDb) => {
      // Evidence lives one second, so it is prepared right before the check. The uninstrumented pool keeps the
      // preparation's statements out of the measured window, which holds only the final formula.
      const evidence = await prepare(growthDb.admin);
      const client = await growthDb.pool.connect();
      try {
        if (!(await permissions.authorize(client, actor, action, target, evidence)))
          throw new Error('The bounded resource grant did not authorize its actor');
      } finally {
        client.release();
      }
    }),
  );
  const finalPlan = await capture(db!, async () => {
    const evidence = await prepare(db!.pool);
    const client = await db!.pool.connect();
    try {
      if (!(await permissions.authorize(client, actor, action, target, evidence)))
        throw new Error('The bounded resource grant did not authorize its actor');
    } finally {
      client.release();
    }
  });
  expectIndex(finalPlan.capture.plans, 'resource_grant_pkey');
}, 85_000);

test('Assignment permission check stays within its bound as assignments and grants grow', async () => {
  await resetSeededRows();
  const report = await checkGrowth(db!, {
    name: 'Assignment permission check stays within its bound as assignments and grants grow',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, assignmentGrowthPopulation, {
        from: previous * ordinalsPerScaleUnit,
        to: scale * ordinalsPerScaleUnit,
      });
    },
    operation: async (growthDb) => {
      const evidence = await prepare(growthDb.admin, target, assignmentActor);
      const client = await growthDb.pool.connect();
      try {
        if (!(await permissions.authorize(client, assignmentActor, action, target, evidence)))
          throw new Error('The current assignment and resource grants did not authorize the actor');
      } finally {
        client.release();
      }
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  const assignmentPlan = await capture(db!, async () => {
    const evidence = await prepare(db!.admin, target, assignmentActor);
    const client = await db!.pool.connect();
    try {
      if (!(await permissions.authorize(client, assignmentActor, action, target, evidence)))
        throw new Error('The current assignment and resource grants did not authorize the actor');
    } finally {
      client.release();
    }
  });
  expectIndex(assignmentPlan.capture.plans, 'principal_assignment_pkey');
  expectIndex(assignmentPlan.capture.plans, 'resource_grant_pkey');
}, 300_000);

test('the final delegated formula retains a full-key assignment probe', async () => {
  const measured = await capture(db!, async () => {
    const evidence = await prepare(db!.admin, target, assignmentActor);
    const client = await db!.pool.connect();
    try {
      expect(await permissions.authorize(client, assignmentActor, action, target, evidence)).toBe(true);
    } finally {
      client.release();
    }
  });
  expectIndex(measured.capture.plans, 'principal_assignment_pkey');
});

test('Parent creation authorization stays within its bound as G grows', async () => {
  await resetSeededRows();
  const operation: GrowthCheck['operation'] = async (growthDb, scale, repetition) => {
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
        receipt: {
          actorAccountId: actor.accountId,
          kind: 'growth-permission-parent',
          key: `parent-${scale}-${repetition}`,
          digest: receiptDigest,
        },
        authorization,
      },
      async (tx) => {
        await tx.query(`INSERT INTO ${resources} (route, id) VALUES ($1, $2)`, [child.route, child.id]);
        const capability = await creationCapability(tx, child, actor.accountId);
        capability.complete();
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
