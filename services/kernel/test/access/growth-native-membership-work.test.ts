import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AccountOperation } from '@rezics/auth';
import type { MembershipWorkInput } from '@rezics/auth/membership-workflows';
import { createAccess } from '../../src/access/index.ts';
import { createLifecycleInternals, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import { createMembershipWorkPorts } from '../../src/access/membership-work.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const signing = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'membership-growth', alg: 'ES256' };
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ keys: [jwk] }) });
const issuer = `http://127.0.0.1:${server.port}`;
const route = 0x4410,
  memberRoute = 0x4420,
  groupRoute = 0x4430;
const actor = newId(route),
  member = newId(memberRoute),
  group = newId(groupRoute);
const key = Buffer.alloc(32, 72).toString('base64url');
const env = {
  KERNEL_ROUTE_KEY: key,
  KERNEL_WORKFLOW_REFERENCE_KEYS: JSON.stringify({ current: 1, keys: { 1: key } }),
  AUTH_ISSUER: issuer,
  AUTH_AUDIENCE: 'https://api.membership-growth.test',
  AUTH_JWKS_URL: `${issuer}/jwks`,
};
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
});
afterAll(async () => {
  server.stop(true);
  await db?.close();
});

test('native resolver and membership workflow commands stay bounded across prior approvals, intervals and unrelated accounts', async () => {
  // Privileged component setup, not an ordinary registration/API proof.
  for (const id of [actor, member])
    await db.admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete) VALUES($1,$2,'actor','active',$2,true)`,
      [routeOf(id), id],
    );
  const internal = createLifecycleInternals({
    pool: db.pool,
    routeKey: Buffer.from(key, 'base64url'),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const owner = (
    await internal.reserveCoordination({
      accountId: actor,
      relatedAccountId: group,
      purpose: 'membership',
      key: randomUUID(),
    })
  ).value;
  await internal.createOrganization({
    organizationId: group,
    ownerAccountId: actor,
    ownerReservationId: owner.reservationId,
    key: randomUUID(),
  });
  const access = createAccess({
    actions: LIFECYCLE_ACTIONS,
    auth: { issuer, audience: env.AUTH_AUDIENCE, jwksUrl: env.AUTH_JWKS_URL },
  });
  const approvals = createWorkflowApprovals({
    pool: db.pool,
    access,
    actions: LIFECYCLE_ACTIONS,
    referenceKeys: { current: 1, keys: new Map([[1, Buffer.from(key, 'base64url')]]) },
  });
  const now = Math.floor(Date.now() / 1000);
  const bearer = await new SignJWT({
    sub: actor,
    client_id: 'growth',
    scope: 'organization:membership',
    authn_epoch: 1,
    iat: now,
    exp: now + 300,
    auth_time: now,
    amr: ['pwd'],
  })
    .setIssuer(issuer)
    .setAudience(env.AUTH_AUDIENCE)
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .sign(signing.privateKey);
  const ports = createMembershipWorkPorts({ pool: db.pool, env });
  const boundary = () => ({ pool: db.pool, deadline: Date.now() + 10000 });
  async function approve(role: 'member' | null, reservationId?: string) {
    const operation: AccountOperation = {
      kind: 'membership',
      organizationId: group,
      memberAccountId: member,
      role,
      ...(reservationId === undefined ? {} : { reservationId }),
      authorization: 'input',
    };
    const approval = await approvals.approve(bearer, { operationKey: randomUUID(), operation }, boundary());
    return {
      kind: 'membership',
      principal: { kind: 'organization', id: group },
      memberAccountId: member,
      role,
      ...(reservationId === undefined ? {} : { reservationId }),
      authorization: approval.reference,
    } as const satisfies MembershipWorkInput;
  }
  const report = await checkGrowth(db, {
    name: 'native membership resolve and workflow commands',
    repetitions: 3,
    warmups: 1,
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const ids = Array.from({ length: (scale - previous) * 256 }, () => newId(route));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete) SELECT $1,id,'actor','active',id,true FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) SELECT $1,id,id,'organization:membership','(,)',id FROM unnest($2::uuid[]) id`,
        [route, ids],
      );
      await database.admin.query(
        `INSERT INTO access.workflow_approval(route,approval_id,actor_id,client_id,scopes,authn_epoch,operation_key,operation,digest,created_at,expires_at,jwt_expires_at,transaction_id) SELECT $1,id,$3,'growth',ARRAY['organization:membership'],1,id::text,'{}',repeat('0',64),'2000-01-01','2000-01-01 00:01:00','2000-01-01 00:01:00',id FROM unnest($2::uuid[]) id`,
        [route, ids, actor],
      );
      await database.admin.query(
        `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id) SELECT $1,$2,$3,'member',tstzrange('2000-01-01'::timestamptz + (n+$5) * interval '2 seconds','2000-01-01'::timestamptz + ((n+$5)*2+1) * interval '1 second','[)'),id FROM unnest($4::uuid[]) WITH ORDINALITY AS x(id,n)`,
        [groupRoute, group, member, ids, previous * 256],
      );
      await database.admin.query(
        `INSERT INTO core.receipt(partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response) SELECT $1,'account',$2,'access.workflow-approval.create',$3||':'||id::text,decode(repeat('0',64),'hex'),1,1,id,'{}' FROM unnest($4::uuid[]) id`,
        [route >>> 4, actor, route, ids],
      );
      // Keep fixed member/reservation probes on populated indexes. The measured
      // join/leave cycle adds terminal rows of its own at every repetition.
      await database.admin.query(
        `INSERT INTO access.membership_inverse
          (route,account_id,kind,group_id,reservation_id,transaction_id)
         SELECT $1,id,'organization',$3,id,id FROM unnest($2::uuid[]) id`,
        [route, ids, group],
      );
      await database.admin.query(
        `INSERT INTO access.membership_inverse_terminal
          (route,account_id,kind,group_id,reservation_id,reservation_transaction_id,proof_transaction_id,transaction_id)
         SELECT $1,id,'organization',$3,id,id,id,id FROM unnest($2::uuid[]) id`,
        [route, ids, group],
      );
      await database.admin.query(
        `INSERT INTO access.lifecycle_coordination
          (route,account_id,reservation_id,related_account_id,purpose,transaction_id)
         SELECT $1,id,id,$3,'membership',id FROM unnest($2::uuid[]) id`,
        [route, ids, group],
      );
      await database.admin.query(
        `INSERT INTO access.lifecycle_membership_slot
          (route,organization_id,member_account_id,reservation_id,terminal,transaction_id)
         SELECT $1,$2,id,id,true,id FROM unnest($3::uuid[]) id`,
        [groupRoute, group, ids],
      );
      for (const table of [
        'access.account',
        'access.resource_grant',
        'access.workflow_approval',
        'access.organization_member',
        'core.receipt',
      ])
        await database.admin.query(`VACUUM (ANALYZE) ${table}`);
    },
    async operation() {
      const input = await approve('member');
      await ports.authorize(input.authorization, input);
      const held = (await ports.reserve({ accountId: member, principal: input.principal, key: randomUUID() })).value;
      await ports.publish(await ports.authorize(input.authorization, input), input, held, randomUUID());
      const leave = await approve(null, held.reservationId);
      await ports.authorize(leave.authorization, leave);
      await ports.publish(await ports.authorize(leave.authorization, leave), leave, held, randomUUID());
      await ports.release({ ...held, key: randomUUID() });
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['access.workflow_approval']?.rows).toBeGreaterThan(0);
    expect(sample.cost.relations?.['access.organization_member']?.rows).toBeGreaterThan(0);
  }
  console.log(
    JSON.stringify(
      report.samples.map(({ scale, cost }) => ({
        scale,
        rows: cost.rows,
        statements: cost.statements,
        blocks: cost.blocks,
      })),
    ),
  );
}, 120000);
