import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { LifecycleRequest } from '../../src/access/lifecycle.ts';
import type { RealmMembershipCommands } from '../../src/access/membership-work.ts';
import type { MembershipWorkInput } from '@rezics/auth/membership-workflows';

// Root bun test does not load services/kernel/bunfig.toml. Register Reylo before
// any SQL-bearing module; a static import would link before the plugin runs.
await import('reylo/register');
const { createPool } = await import('../../src/database/pool.ts');
const { createLifecycleInternals } = await import('../../src/access/lifecycle.ts');
const { createWorkClient } = await import('../../src/work/client.ts');
const { authenticated } = await import('./membership-work-fixture.ts');
const { createMembershipInverseCommands } = await import('../../src/access/membership-inverse.ts');
const { WORK_QUEUES } = await import('../../src/work/queues.ts');
const { createMembershipWorkPorts, enqueueMembership } = await import('../../src/access/membership-work.ts');
const { newId, routeOf } = await import('../../src/route/route.ts');
const { KERNEL_WORK_MODULES } = await import('../../src/work/modules.ts');

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
type WorkerHandle = {
  child: ReturnType<typeof Bun.spawn>;
  boundary: string | undefined;
  until(marker: string): Promise<void>;
  configure?(actor: string, stop: string, fail: boolean): Promise<void>;
  kill(): Promise<void>;
  stop(): Promise<void>;
  shutdown(): Promise<void>;
};
let sharedWorker: WorkerHandle | undefined;
let controlId = 0;
function spawnWorker(actor: string, stop = '', fail = false, registry = false, reusable = false): WorkerHandle {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/membership-work-fixture.ts`], {
    // The fixture's static SQL imports need the kernel Bun preload.
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      MEMBERSHIP_ACTOR: actor,
      MEMBERSHIP_STOP: stop,
      MEMBERSHIP_FAIL: fail ? 'yes' : '',
      MEMBERSHIP_REGISTRY: registry ? 'yes' : '',
      MEMBERSHIP_CONTROL: reusable ? 'yes' : '',
    },
    stdin: reusable ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      output += new TextDecoder().decode(chunk);
    }
  })();
  const errors = new Response(child.stderr).text();
  const handle: WorkerHandle = {
    child,
    boundary: undefined,
    async until(marker: string) {
      const deadline = Date.now() + 20000;
      while (!output.includes(marker)) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Missing ${marker}: ${output}\n${child.exitCode === null ? '' : await errors}`);
        await Bun.sleep(20);
      }
    },
    async configure(nextActor, nextStop, nextFail) {
      if (!reusable || !child.stdin) throw new Error('Worker does not accept control messages');
      const id = ++controlId;
      this.boundary = nextStop ? `boundary:${nextStop}:${id}` : undefined;
      child.stdin.write(`${JSON.stringify({ id, actor: nextActor, stop: nextStop, fail: nextFail })}\n`);
      await child.stdin.flush();
      await this.until(`configured:${id}`);
    },
    async kill() {
      child.kill('SIGKILL');
      await child.exited;
      await reading;
      if (sharedWorker === handle) sharedWorker = undefined;
    },
    async stop() {
      if (reusable) return;
      child.kill('SIGTERM');
      expect(await child.exited, await errors).toBe(0);
      await reading;
    },
    async shutdown() {
      if (child.stdin) await child.stdin.end();
      child.kill('SIGTERM');
      expect(await child.exited, await errors).toBe(0);
      await reading;
      if (sharedWorker === handle) sharedWorker = undefined;
    },
  };
  return handle;
}
async function worker(actor: string, stop = '', fail = false, registry = false): Promise<WorkerHandle> {
  if (registry) return spawnWorker(actor, stop, fail, true);
  if (!sharedWorker) {
    sharedWorker = spawnWorker(actor, stop, fail, false, true);
    await sharedWorker.until('worker-ready');
  }
  await sharedWorker.configure!(actor, stop, fail);
  return sharedWorker;
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
  expect(DBOS.isInitialized()).toBe(false);
  const first = await worker(actor, phase);
  const handle = await enqueueMembership(client, id, input);
  try {
    await first.until(first.boundary!);
    await superset(input.kind === 'membership' ? input.memberAccountId : actor);
  } finally {
    await first.kill();
  }
  const before = await pool.query('SELECT function_id FROM dbos.operation_outputs WHERE workflow_uuid=$1', [id]);
  const restarted = await worker(actor);
  await restarted.until('worker-ready');
  const result = await handle.getResult();
  expect(result).toMatchObject({ status: 'completed' });
  expect((await client.getWorkflow(id))!.workflowID).toBe(id);
  await superset(input.kind === 'membership' ? input.memberAccountId : actor);
  const history = await pool.query('SELECT function_id FROM dbos.operation_outputs WHERE workflow_uuid=$1', [id]);
  expect(history.rowCount!).toBeGreaterThan(before.rowCount!);
  return result;
}
afterAll(async () => {
  await sharedWorker?.shutdown();
  await client.close();
  await pool.end();
});

test('accounts compose once before the single kernel launch with exactly the shared queues', async () => {
  expect(KERNEL_WORK_MODULES.filter((module) => module.name === 'accounts')).toHaveLength(1);
  const runtime = await worker('', '', false, true);
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
    const first = await worker(owner, phase, true);
    const handle = await enqueueMembership(client, id, input);
    let reservationId: string;
    try {
      await first.until(first.boundary!);
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
    const restarted = await worker(owner);
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
  const runtime = await worker(owner);
  const handle = await enqueueMembership(client, id, input);
  expect((await enqueueMembership(client, id, input)).workflowID).toBe(handle.workflowID);
  await expect(enqueueMembership(client, id, { ...input, role: 'owner' })).rejects.toMatchObject({
    code: 'membership_work_conflict',
  });
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
    code: 'realm_membership_unavailable',
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
  const runtime = await worker(owner);
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

test('realm membership work authorizes through the installed realm authorize port and organizations are unchanged', async () => {
  const actor = await person();
  const realmId = newId(0x3790);
  const organizationId = newId(0x3791);
  const request = await authenticated(pool, actor);
  const calls: string[] = [];
  const realm: RealmMembershipCommands = {
    authority: {
      async readTerminal() {
        calls.push('terminal-read');
        return null;
      },
      async readChange() {
        calls.push('change-read');
        return null;
      },
    },
    async authorize(reference, input) {
      calls.push(`authorize:${reference}`);
      if (input.kind !== 'membership' || input.principal.kind !== 'realm' || input.principal.id !== realmId)
        throw new Error('unexpected realm authorization');
      return request;
    },
    async publish(context, input) {
      calls.push(context === request ? 'publish:request' : 'publish:other');
      if (input.kind !== 'membership' || input.principal.id !== realmId)
        throw new Error('unexpected realm publication');
      return { published: true };
    },
    async terminalize() {
      calls.push('terminalize');
      return { terminal: true };
    },
  };
  let organizations = 0;
  const ports = createMembershipWorkPorts(workContext, {
    realm,
    async authorize(_reference, input) {
      organizations += 1;
      if (input.kind === 'membership' && input.principal.kind === 'realm')
        throw new Error('organization authorizer received a realm');
      return request;
    },
  });
  const organization: MembershipWorkInput = {
    kind: 'membership',
    principal: { kind: 'organization', id: organizationId },
    memberAccountId: actor,
    role: 'member',
    authorization: 'authenticated-fixture',
  };
  const realmInput: MembershipWorkInput = {
    kind: 'membership',
    principal: { kind: 'realm', id: realmId },
    memberAccountId: actor,
    role: 'member',
    authorization: 'realm-approval',
  };
  expect(await ports.authorize(organization.authorization, organization)).toBe(request);
  const organizationHeld = (await ports.reserve({ accountId: actor, principal: organization.principal, key: key() }))
    .value;
  expect(organizationHeld.principal).toEqual({ kind: 'organization', id: organizationId });
  expect(calls).toEqual([]);
  expect(organizations).toBe(1);
  expect((await inverseRows(actor)).some((row) => row.group_id === organizationId)).toBe(true);
  expect(await authority(organizationId, actor)).toEqual([]);

  // Enqueue check, then the same port again when the publication step resolves.
  expect(await ports.authorize(realmInput.authorization, realmInput)).toBe(request);
  const held = (await ports.reserve({ accountId: actor, principal: realmInput.principal, key: key() })).value;
  const resolved: LifecycleRequest = await ports.authorize(realmInput.authorization, realmInput);
  expect(await ports.publish(resolved, realmInput, held, key())).toEqual({ published: true });
  expect(calls).toEqual(['authorize:realm-approval', 'authorize:realm-approval', 'publish:request']);
  expect(organizations).toBe(1);
  expect((await inverseRows(actor)).some((row) => row.group_id === realmId)).toBe(true);
});

test('a missing realm port denies realm membership work and changes nothing', async () => {
  const actor = await person();
  const realmId = newId(0x3792);
  const ports = createMembershipWorkPorts(workContext);
  const input: MembershipWorkInput = {
    kind: 'membership',
    principal: { kind: 'realm', id: realmId },
    memberAccountId: actor,
    role: 'member',
    authorization: 'realm-approval',
  };
  const held = { accountId: actor, principal: input.principal, reservationId: newId(routeOf(actor)!) };
  async function realmRows() {
    const inverse = await pool.query(
      `SELECT group_id::text FROM access.membership_inverse
       WHERE route=$1 AND account_id=$2 AND kind='realm' AND group_id=$3`,
      [routeOf(actor), actor, realmId],
    );
    const coordination = await pool.query(
      `SELECT reservation_id::text FROM access.lifecycle_coordination
       WHERE route=$1 AND account_id=$2 AND related_account_id=$3`,
      [routeOf(actor), actor, realmId],
    );
    return { inverse: inverse.rows, coordination: coordination.rows };
  }
  const before = await realmRows();
  await expect(ports.authorize(input.authorization, input)).rejects.toMatchObject({
    code: 'realm_membership_unavailable',
  });
  expect(() => ports.reserve({ accountId: actor, principal: input.principal, key: key() })).toThrow(
    'Realm membership command adapter is unavailable',
  );
  await expect(ports.publish(await authenticated(pool, actor), input, held, key())).rejects.toMatchObject({
    code: 'realm_membership_unavailable',
  });
  await expect(ports.terminalize(held, key())).rejects.toMatchObject({ code: 'realm_membership_unavailable' });
  expect(await realmRows()).toEqual(before);
  expect(before).toEqual({ inverse: [], coordination: [] });
});
