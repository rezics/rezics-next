import { resetGrowthTables } from './growth-reset.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { actorFixture } from './actor-side-fixture.ts';
import { createAccess } from '../../src/access/index.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { grantCommand } from '../../src/access/grant-command.ts';
import { runCommand } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

let db: GrowthDatabase;
const reads: { text: string; values?: unknown[] }[] = [];
const rowsPerScaleUnit = 500;

function expectIndex(plan: unknown, expected: string): void {
  let found = false;
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const details = node as Record<string, unknown>;
    if (typeof details['Index Name'] === 'string' && details['Index Name'].startsWith(expected)) found = true;
    if (typeof details.Plan === 'object' && details.Plan !== null) visit(details.Plan);
    if (Array.isArray(details.Plans)) for (const child of details.Plans) visit(child);
  };
  visit(plan);
  expect(found, `plan should use ${expected}`).toBe(true);
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  // Observe every actual connection used by helpers and the executor, in addition
  // to checkGrowth's complete auto_explain capture. No planner settings or timing.
  db.pool.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      const config = args[0] as unknown as string | { text: string; values?: unknown[] };
      const statement = typeof config === 'string' ? { text: config } : config;
      if (
        statement.text.includes('minimum_authn_epoch::text AS "minimumAuthnEpoch"') &&
        statement.text.includes('FROM access.account')
      )
        reads.push(statement);
      return query(...args);
    }) as PoolClient['query'];
  });
  // Reconnect so the extra observer also covers the already probed connection.
  const client = await db.pool.connect();
  client.release(true);
});
afterAll(async () => {
  await db?.close();
});
for (const mode of ['generic', 'multi-action'] as const) {
  test(`${mode} command admission adds one account seek per attempt at all three growth scales`, async () => {
    await resetGrowthTables(db.admin, [
      'access.account',
      'access.membership_inverse',
      'access.organization_member',
      'access.principal_assignment',
      'access.resource_grant',
      'core.receipt',
    ]);
    const f = await actorFixture(db.pool, db.admin);
    await db.admin.query(
      "UPDATE access.organization_member SET valid='[2000-01-01,)' WHERE route=$1 AND organization_id=$2",
      [routeOf(f.organizationId), f.organizationId],
    );
    await db.admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES($1,$2,$3,'subject:update','(,)',$4)`,
      [f.resource.route, f.resource.id, f.actorId, f.transactionId],
    );
    const issuer = 'https://growth-admission.example.test';
    const audience = 'https://api.example.test';
    const keys = await generateKeyPair('ES256');
    const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'ES256' }] };
    let fetches = 0;
    const access = createAccess({
      actions: new Map([
        ['subject:read', { anonymous: false }],
        ['subject:update', { anonymous: false }],
      ]),
      auth: {
        issuer,
        audience,
        jwksUrl: `${issuer}/jwks`,
        async fetch() {
          fetches++;
          return Response.json(jwks);
        },
      },
    });
    // Component fixture issuer, not an ordinary lifecycle proof.
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: issuer,
      aud: audience,
      sub: f.actorId,
      client_id: 'fixture',
      scope: 'subject:read subject:update',
      authn_epoch: 1,
      iat: now,
      exp: now + 300,
      auth_time: now,
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: 'fixture' })
      .sign(keys.privateKey);
    const context = { pool: db.pool, deadline: Date.now() + 180_000 };
    reads.length = 0;
    const actor = await access.authenticate(token, context);
    expect(reads).toHaveLength(1);
    const report = await checkGrowth(db, {
      name: `${mode} command admission`,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      repetitions: 3,
      warmups: 1,
      async grow(database, scale, previous) {
        const from = previous * rowsPerScaleUnit,
          to = scale * rowsPerScaleUnit;
        const ids = Array.from({ length: to - from }, () => newId(routeOf(f.actorId)!));
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
          SELECT $1,id,'actor','active',$3 FROM unnest($2::uuid[]) id`,
          [routeOf(f.actorId), ids, f.transactionId],
        );
        // Other accounts, receipts, assignments and memberships grow with the
        // measured anchor's durable receipt history. Its inverse K stays at two.
        await database.admin.query(
          `INSERT INTO core.receipt
          (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
          SELECT $1::integer,'account',$2::uuid,'admission-history',id::text,$4::bytea,1,1,$5::uuid,'{}'::jsonb
          FROM unnest($3::uuid[]) id
          UNION ALL
          SELECT $1::integer,'account',id,'admission-history',id::text,$4::bytea,1,1,$5::uuid,'{}'::jsonb
          FROM unnest($3::uuid[]) id`,
          [partitionOf(f.resource.route), f.actorId, ids, Buffer.alloc(32), f.transactionId],
        );
        await database.admin.query(
          `INSERT INTO access.principal_assignment
            (route,principal_id,request_id,assigned_actor_id,valid,transaction_id,creator_principal_id,issued_valid)
          SELECT $1,id,id,$2,'(,)',$3,id,'(,)' FROM unnest($4::uuid[]) id`,
          [routeOf(f.actorId), f.actorId, f.transactionId, ids],
        );
        await database.admin.query(
          `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
          SELECT $1,id,'organization',$2,id,$3 FROM unnest($4::uuid[]) id`,
          [routeOf(f.actorId), f.organizationId, f.transactionId, ids],
        );
        await database.admin.query(
          `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
          SELECT $1,$2,id,'member',tstzrange('1900-01-01'::timestamptz,NULL,'[)'),$3
          FROM unnest($4::uuid[]) id`,
          [routeOf(f.organizationId), f.organizationId, f.transactionId, ids],
        );
        await database.admin.query('ANALYZE access.account');
        await database.admin.query('ANALYZE core.receipt');
        await database.admin.query('ANALYZE access.principal_assignment');
        await database.admin.query('ANALYZE access.membership_inverse');
        await database.admin.query('ANALYZE access.organization_member');
      },
      async operation(_database, scale, repetition) {
        const key = `${scale}-${repetition}`;
        reads.length = 0;
        if (mode === 'multi-action')
          await grantCommand(
            { pool: db.pool, access },
            { ...context, actor },
            {
              resource: f.resource,
              actions: ['subject:read', 'subject:update', 'subject:read'],
              kind: 'growth.admission',
              key,
              input: {},
              denied: () => new Error('Denied'),
            },
            async () => 'done',
          );
        else
          await runCommand(
            db.pool,
            {
              partition: partitionOf(f.resource.route),
              deadline: context.deadline,
              basis: { actorAccountId: f.actorId, clientId: actor.clientId, requestedBy: null },
              receipt: { actorAccountId: f.actorId, kind: 'growth.admission', key, digest: Buffer.alloc(32) },
              authorization: resourceAuthorization({
                access,
                actor,
                action: 'subject:read',
                anchor: {
                  resource: f.resource,
                  async validate(client) {
                    return (await client.query('SELECT 1')).rowCount === 1;
                  },
                },
                context: { ...context, partition: partitionOf(f.resource.route) },
              }),
            },
            async () => ({ value: 'done', events: [{ type: 'com.rezics.test.admission-growth.v1', data: {} }] }),
          );
        expect(reads).toHaveLength(1);
        expect(reads[0]!.values).toEqual([routeOf(f.actorId), f.actorId]);
        expect(fetches).toBe(1);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    expect(report.samples.every(({ cost }) => cost.statements === report.samples[0]!.cost.statements)).toBe(true);
    const observed = reads[0]!;
    const explained = await db.admin.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${observed.text}`,
      observed.values,
    );
    expectIndex(explained.rows[0]!['QUERY PLAN'], 'account_pkey');
    expect(
      (
        await db.admin.query(
          'SELECT count(*)::integer AS n FROM access.membership_inverse WHERE route=$1 AND account_id=$2',
          [routeOf(f.actorId), f.actorId],
        )
      ).rows[0].n,
    ).toBe(2);
  }, 120_000);
}
