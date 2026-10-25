import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createPool } from '../../src/database/pool.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { authenticated } from './membership-work-fixture.ts';
import { createMembershipInverseCommands } from '../../src/access/membership-inverse.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { createMembershipWorkPorts, enqueueMembership } from '../../src/access/membership-work.ts';
import type { MembershipWorkInput } from '@rezics/auth/membership-workflows';
import { newId, routeOf } from '../../src/route/route.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';

const pool = createPool(process.env.DATABASE_URL!);
const client = await createWorkClient(process.env.DATABASE_URL!);
const proofs = new Map<
  string,
  { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
>();
const native = createLifecycleInternals({
  pool,
  routeKey: Buffer.alloc(32, 59),
  provisioningEvidence: async (proof) => proofs.get(String(proof)) ?? null,
  recoveryEvidence: async () => null,
});
const key = () => randomUUID();
const workContext = {
  pool,
  client,
  queues: WORK_QUEUES,
  env: { KERNEL_ROUTE_KEY: Buffer.alloc(32, 59).toString('base64url') },
};
async function person() {
  const accountId = native.registrationTarget(key());
  const held = (await native.reserveHandle({ accountId, handle: `m_${key().replaceAll('-', '')}`, key: key() })).value;
  await native.createPending({ ...held, key: key() });
  const proof = key();
  proofs.set(proof, { accountId, registrationId: held.reservationId, authIdentityId: accountId, authnEpoch: 1 });
  await native.activate({ accountId, evidence: proof, key: key() });
  return accountId;
}
function worker(actor: string, stop = '', fail = false, registry = false) {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/membership-work-fixture.ts`], {
    env: {
      ...process.env,
      MEMBERSHIP_ACTOR: actor,
      MEMBERSHIP_STOP: stop,
      MEMBERSHIP_FAIL: fail ? 'yes' : '',
      MEMBERSHIP_REGISTRY: registry ? 'yes' : '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const reading = (async () => {
    for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
  })();
  const errors = new Response(child.stderr).text();
  return {
    child,
    async until(marker: string) {
      const deadline = Date.now() + 20000;
      while (!output.includes(marker)) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Missing ${marker}: ${output}\n${child.exitCode === null ? '' : await errors}`);
        await Bun.sleep(20);
      }
    },
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
      await reading;
    },
    async stop() {
      child.kill('SIGTERM');
      expect(await child.exited, await errors).toBe(0);
      await reading;
    },
  };
}
async function inverseRows(accountId: string) {
  return (
    await pool.query(
      'SELECT group_id::text,reservation_id::text FROM access.membership_inverse WHERE route=$1 AND account_id=$2',
      [routeOf(accountId), accountId],
    )
  ).rows;
}
async function authority(group: string, account: string) {
  return (
    await pool.query(
      'SELECT member_account_id::text FROM access.organization_member WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND upper_inf(valid)',
      [routeOf(group), group, account],
    )
  ).rows;
}
async function superset(accountId: string) {
  const missing = await pool.query(
    `SELECT m.organization_id FROM access.organization_member m WHERE m.member_account_id=$1 AND upper_inf(m.valid) AND NOT EXISTS (SELECT 1 FROM access.membership_inverse i WHERE i.route=$2 AND i.account_id=$1 AND i.kind='organization' AND i.group_id=m.organization_id)`,
    [accountId, routeOf(accountId)],
  );
  expect(missing.rows).toEqual([]);
}
async function restartAt(actor: string, input: MembershipWorkInput, phase: string) {
  const id = `membership-test:${key()}`;
  const handle = await enqueueMembership(client, id, input);
  expect(DBOS.isInitialized()).toBe(false);
  const first = worker(actor, phase);
  try {
    await first.until(`boundary:${phase}`);
    await superset(input.kind === 'membership' ? input.memberAccountId : actor);
  } finally {
    await first.kill();
  }
  const before = await pool.query('SELECT function_id FROM dbos.operation_outputs WHERE workflow_uuid=$1', [id]);
  const restarted = worker(actor);
  try {
    await restarted.until('worker-ready');
    const result = await handle.getResult();
    expect(result).toMatchObject({ status: 'completed' });
    expect((await client.getWorkflow(id))!.workflowID).toBe(id);
    await superset(input.kind === 'membership' ? input.memberAccountId : actor);
    const history = await pool.query('SELECT function_id FROM dbos.operation_outputs WHERE workflow_uuid=$1', [id]);
    expect(history.rowCount!).toBeGreaterThan(before.rowCount!);
    return result;
  } finally {
    await restarted.stop();
  }
}
afterAll(async () => {
  await client.close();
  await pool.end();
});

test('accounts compose once before the single kernel launch with exactly the shared queues', async () => {
  expect(KERNEL_WORK_MODULES.filter((module) => module.name === 'accounts')).toHaveLength(1);
  const runtime = worker('', '', false, true);
  try {
    await runtime.until('registry-ok');
    expect(await runtime.child.exited).toBe(0);
  } finally {
    await runtime.kill();
  }
});

test('durable owner, join, role and leave preserve inverse ordering across process death at every native boundary', async () => {
  const owner = await person();
  for (const phase of ['reserve', 'before-publish', 'publish']) {
    const organizationId = newId(0x3710);
    await restartAt(owner, { kind: 'organization', organizationId, authorization: 'authenticated-fixture' }, phase);
    expect(await authority(organizationId, owner)).toHaveLength(1);
    const member = await person();
    const input = {
      kind: 'membership' as const,
      principal: { kind: 'organization' as const, id: organizationId },
      memberAccountId: member,
      role: 'member' as const,
      authorization: 'authenticated-fixture',
    };
    await restartAt(owner, input, phase);
    expect(await authority(organizationId, member)).toHaveLength(1);
    const reservationId = (await inverseRows(member))[0]!.reservation_id;
    await restartAt(owner, { ...input, role: 'owner', reservationId }, 'publish');
    const boundary = phase === 'reserve' ? 'publish' : phase === 'before-publish' ? 'before-release' : 'release';
    await restartAt(owner, { ...input, role: null, reservationId }, boundary);
    expect(await authority(organizationId, member)).toEqual([]);
    expect(await inverseRows(member)).toEqual([]);
  }
}, 180000);

test('compensation persists an exact terminal barrier before cleanup and cannot delete a successor reservation', async () => {
  const owner = await person();
  const organizationId = newId(0x3720);
  const ownerHold = (
    await native.reserveCoordination({
      accountId: owner,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    })
  ).value;
  await native.createOrganization({
    organizationId,
    ownerAccountId: owner,
    ownerReservationId: ownerHold.reservationId,
    key: key(),
  });
  for (const phase of ['before-terminalize', 'terminalize', 'before-release', 'release']) {
    const member = await person();
    const input: MembershipWorkInput = {
      kind: 'membership',
      principal: { kind: 'organization', id: organizationId },
      memberAccountId: member,
      role: 'member',
      authorization: 'authenticated-fixture',
    };
    const id = `membership-test:${key()}`;
    const handle = await enqueueMembership(client, id, input);
    const first = worker(owner, phase, true);
    let reservationId: string;
    try {
      await first.until(`boundary:${phase}`);
      await superset(member);
      expect(await authority(organizationId, member)).toEqual([]);
      reservationId =
        (
          await pool.query(
            'SELECT reservation_id::text FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2 AND member_account_id=$3',
            [routeOf(organizationId), organizationId, member],
          )
        ).rows[0]?.reservation_id ?? (await inverseRows(member))[0]!.reservation_id;
      if (phase !== 'before-terminalize')
        expect(
          (
            await pool.query(
              'SELECT terminal FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND reservation_id=$4',
              [routeOf(organizationId), organizationId, member, reservationId],
            )
          ).rows,
        ).toEqual([{ terminal: true }]);
    } finally {
      await first.kill();
    }
    const restarted = worker(owner);
    try {
      await restarted.until('worker-ready');
      await expect(handle.getResult()).rejects.toThrow('Membership workflow step failed: publish');
      expect(await inverseRows(member)).toEqual([]);
      expect(
        (await pool.query('SELECT function_id FROM dbos.operation_outputs WHERE workflow_uuid=$1', [id])).rows,
      ).toHaveLength(4);
      const successor = (
        await native.reserveCoordination({
          accountId: member,
          relatedAccountId: organizationId,
          purpose: 'membership',
          key: key(),
        })
      ).value;
      expect(successor.reservationId).not.toBe(reservationId!);
      await expect(
        native.releaseMembershipCoordination({
          organizationId,
          memberAccountId: member,
          reservationId: reservationId!,
          key: key(),
        }),
      ).rejects.toThrow();
      expect((await inverseRows(member))[0]!.reservation_id).toBe(successor.reservationId);
      const ports = createMembershipWorkPorts(workContext, {
        authorize: async () => {
          throw new Error('No approval');
        },
      });
      const context = await authenticated(pool, owner);
      await expect(
        ports.publish(
          context,
          input,
          { accountId: member, principal: input.principal, reservationId: reservationId! },
          key(),
        ),
      ).rejects.toThrow();
      await superset(member);
    } finally {
      await restarted.stop();
    }
  }
}, 120000);

test('cap1000 denies admission with typed membership_limit before authority and enqueue retries preserve immutable input', async () => {
  const owner = await person();
  const member = await person();
  const group = newId(0x3730);
  const ownerHold = (
    await native.reserveCoordination({ accountId: owner, relatedAccountId: group, purpose: 'membership', key: key() })
  ).value;
  await native.createOrganization({
    organizationId: group,
    ownerAccountId: owner,
    ownerReservationId: ownerHold.reservationId,
    key: key(),
  });
  const inverse = createMembershipInverseCommands({ pool });
  for (let index = 0; index < 1000; index++)
    await inverse.reserve({ accountId: member, principal: { kind: 'organization', id: newId(0x3740) }, key: key() });
  const input: MembershipWorkInput = {
    kind: 'membership',
    principal: { kind: 'organization', id: group },
    memberAccountId: member,
    role: 'member',
    authorization: 'authenticated-fixture',
  };
  const id = `membership-test:${key()}`;
  const handle = await enqueueMembership(client, id, input);
  expect((await enqueueMembership(client, id, input)).workflowID).toBe(handle.workflowID);
  await expect(enqueueMembership(client, id, { ...input, role: 'owner' })).rejects.toMatchObject({
    code: 'membership_work_conflict',
  });
  const runtime = worker(owner);
  try {
    await runtime.until('worker-ready');
    expect(await handle.getResult()).toEqual({ status: 'membership_limit', code: 'membership_limit' });
    expect(await authority(group, member)).toEqual([]);
    expect(
      await pool
        .query('SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid=$1', [id])
        .then((result) => result.rows),
    ).toHaveLength(1);
    expect(await inverseRows(member)).toHaveLength(1000);
  } finally {
    await runtime.stop();
  }
}, 60000);

test('missing authorization and Realm capabilities fail closed, and secret or follow inputs never enqueue', async () => {
  const ports = createMembershipWorkPorts(workContext);
  const actor = await person();
  const input = {
    kind: 'membership' as const,
    memberAccountId: actor,
    principal: { kind: 'realm' as const, id: newId(0x3770) },
    role: 'member' as const,
    authorization: 'unresolved-reference',
  };
  await expect(ports.authorize(input.authorization, input)).rejects.toMatchObject({
    code: 'membership_authorization_unavailable',
  });
  expect(() => ports.reserve({ accountId: actor, principal: input.principal, key: key() })).toThrow(
    'Realm membership command adapter is unavailable',
  );
  expect(() => createMembershipWorkPorts({ ...workContext, env: {} })).toThrow('KERNEL_ROUTE_KEY');
  const id = `membership-test:${key()}`;
  for (const invalid of [
    { ...input, password: 'private-secret' },
    { ...input, authorization: undefined },
    { ...input, kind: 'follow' },
    { ...input, principal: { ...input.principal, credential: 'private-secret' } },
  ])
    await expect(enqueueMembership(client, id, invalid as MembershipWorkInput)).rejects.toThrow(
      'Invalid membership work input',
    );
  expect(await client.getWorkflow(id)).toBeUndefined();
  const rows = await pool.query('SELECT output,error FROM dbos.operation_outputs WHERE workflow_uuid LIKE $1', [
    'membership-test:%',
  ]);
  expect(JSON.stringify(rows.rows)).not.toContain('private-secret');
});

test('concurrent joins, role changes and leave retain the superset and last-owner protection', async () => {
  const owner = await person();
  const member = await person();
  const group = newId(0x3780);
  const held = (
    await native.reserveCoordination({ accountId: owner, relatedAccountId: group, purpose: 'membership', key: key() })
  ).value;
  await native.createOrganization({
    organizationId: group,
    ownerAccountId: owner,
    ownerReservationId: held.reservationId,
    key: key(),
  });
  const input = {
    kind: 'membership' as const,
    memberAccountId: member,
    principal: { kind: 'organization' as const, id: group },
    role: 'member' as const,
    authorization: 'authenticated-fixture',
  };
  const runtime = worker(owner);
  try {
    await runtime.until('worker-ready');
    const joins = await Promise.all([
      enqueueMembership(client, `membership-test:${key()}`, input),
      enqueueMembership(client, `membership-test:${key()}`, { ...input, role: 'owner' }),
    ]);
    const joined = await Promise.all(joins.map((handle) => handle.getResult()));
    expect(joined.every((result) => result.status === 'completed')).toBe(true);
    expect(await inverseRows(member)).toHaveLength(1);
    const reservationId = (await inverseRows(member))[0]!.reservation_id;
    const racing = await Promise.all([
      enqueueMembership(client, `membership-test:${key()}`, { ...input, role: null, reservationId }),
      enqueueMembership(client, `membership-test:${key()}`, { ...input, role: 'member', reservationId }),
      enqueueMembership(client, `membership-test:${key()}`, input),
    ]);
    await Promise.allSettled(racing.map((handle) => handle.getResult()));
    await superset(member);
    // Regardless of which mutation won, no second reservation authorizes alone.
    expect((await inverseRows(member)).length).toBeLessThanOrEqual(1);
    const ownerLeave = await enqueueMembership(client, `membership-test:${key()}`, {
      ...input,
      memberAccountId: owner,
      reservationId: held.reservationId,
      role: null,
    });
    await expect(ownerLeave.getResult()).rejects.toThrow();
    expect(await authority(group, owner)).toHaveLength(1);
    expect(await inverseRows(owner)).toHaveLength(1);
    const history = (await client.getWorkflow(joins[0]!.workflowID))!;
    expect(history.input).toEqual([input]);
    expect(JSON.stringify(history)).not.toContain('deadline');
  } finally {
    await runtime.stop();
  }
}, 60000);
