import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { boundedPool } from '../../../services/main/src/infrastructure/pg-pool.ts';
import {
  AccessGroups,
  GroupDenied,
  GroupStale,
  GroupConflict,
} from '../../../services/main/src/modules/access/groups.ts';
import { AccessProtectedChanges } from '../../../services/main/src/modules/access/protected-set.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { receiptFamilyFor } from '../../../services/main/src/modules/access/receipt-families.ts';
import {
  ControlDenied,
  ControlStale,
  ControlConflict,
} from '../../../services/main/src/modules/access/topology-control.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

const work = 'work:create:root';
const inventory = 'access:group-inventory';
const topology = 'access:representation-topology';
const native = () => `https://rezics.com/id/${randomUUID()}`;
const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Pause only the owner call; PostgreSQL still holds the actual transaction locks. */
function pausedPool(
  pool: Pool,
  matches: (sql: string, values: unknown[]) => boolean,
  before = false,
) {
  const reached = barrier(),
    resume = barrier();
  let paused = false;
  const wrapped = new Proxy(pool, {
    get(target, property) {
      if (property === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key) {
              if (key === 'query')
                return async (sql: string, values: unknown[] = []) => {
                  const stop = !paused && matches(sql, values);
                  if (stop) paused = true;
                  if (stop && before) {
                    reached.release();
                    await resume.promise;
                  }
                  const result = await connection.query(sql, values);
                  if (stop && !before) {
                    reached.release();
                    await resume.promise;
                  }
                  return result;
                };
              const value = Reflect.get(connection, key);
              return typeof value === 'function' ? value.bind(connection) : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { pool: wrapped, reached: reached.promise, resume: resume.release };
}

async function blockedBy(monitor: Pool, waiting: number, holder: number) {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    if (
      (await monitor.query('SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked', [holder, waiting]))
        .rows[0].blocked
    )
      return;
    await Bun.sleep(10);
  }
  throw new Error('The competing owner did not reach the forced PostgreSQL lock wait');
}

async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use isolated goalctl integration QA');
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const config = { connectionString: databases.urls.access, max: 1 };
  const monitor = boundedPool(config),
    left = boundedPool(config),
    right = boundedPool(config);
  const sqlstates: string[] = [];
  for (const pool of [left, right]) {
    pool.on('connect', (client) => {
      client.connection.prependListener('errorMessage', (error: { code: string }) => {
        sqlstates.push(error.code);
      });
    });
  }
  const owner = native(),
    approvalSubject = native(),
    member = native(),
    otherMember = native();
  const managerId = randomUUID(),
    approverId = randomUUID();
  const manager = { issuer: 'https://group-protection.test', subject: randomUUID() };
  const approver = { ...manager, subject: randomUUID() };
  const group = randomUUID(),
    otherGroup = randomUUID();
  try {
    for (const [id, principal] of [
      [managerId, manager],
      [approverId, approver],
    ] as const) {
      await monitor.query(
        `INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,$2,$3)`,
        [id, principal.issuer, principal.subject],
      );
    }
    for (const agent of [owner, approvalSubject, member, otherMember]) {
      await monitor.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [
        agent,
      ]);
    }
    for (const [principal, subject, actions] of [
      [managerId, owner, ['access.group.manage', 'access.group.assign.work.create']],
      [
        approverId,
        approvalSubject,
        ['access.protected-change.approve', 'access.grant.assign.work.create'],
      ],
    ] as const) {
      for (const action of actions) {
        await monitor.query(
          `INSERT INTO access.representation
          (id, principal_id, subject_id, action, valid_until)
          VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 hour')`,
          [randomUUID(), principal, subject, action],
        );
        await monitor.query(
          `INSERT INTO access.permission_grant
          (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
          VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '1 hour')`,
          [randomUUID(), subject, work, action],
        );
      }
    }
    for (const id of [group, otherGroup]) {
      await monitor.query('INSERT INTO access.recipient_group (id, scope_id) VALUES ($1,$2)', [
        id,
        work,
      ]);
    }
    await monitor.query(
      `INSERT INTO access.group_permission_grant
      (id, group_id, issuer_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$3,$4,'work.create',clock_timestamp() + interval '30 minutes')`,
      [randomUUID(), group, owner, work],
    );
    const leftPid = (await left.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const rightPid = (await right.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    const generation = async () =>
      (
        await monitor.query(
          'SELECT group_generation::text AS generation FROM access.scope_gate WHERE id = $1',
          [inventory],
        )
      ).rows[0].generation as string;
    const epoch = async (scope = work) =>
      (
        await monitor.query(
          'SELECT authority_epoch::text AS epoch FROM access.scope_gate WHERE id = $1',
          [scope],
        )
      ).rows[0].epoch as string;
    const context = (expectedGroupGeneration: string) => ({
      principal: manager,
      issuerSubject: owner,
      expectedGroupGeneration,
    });
    const protect = (pool: Pool, id = group) =>
      new AccessProtectedChanges(pool).protect(manager, receipt(), {
        objectKind: 'group',
        objectId: id,
        issuerSubject: owner,
        approvalSubject,
        requiredApprovals: 1,
      });
    const approved = async (id = randomUUID(), memberId = randomUUID(), pool = left) => {
      const changes = new AccessProtectedChanges(pool);
      const proposed = await changes.propose(manager, receipt(), {
        proposalId: id,
        issuerSubject: owner,
        expectedAuthorityEpoch: await epoch(),
        change: { kind: 'group-member', groupId: group, memberId, agentSubject: member },
      });
      await changes.approve(approver, receipt(), {
        proposalId: id,
        approverSubject: approvalSubject,
        changeDigest: proposed.changeDigest,
      });
      return { id, memberId };
    };
    return {
      monitor,
      left,
      right,
      leftPid,
      rightPid,
      sqlstates,
      owner,
      member,
      otherMember,
      manager,
      managerId,
      approver,
      approvalSubject,
      group,
      otherGroup,
      generation,
      context,
      epoch,
      protect,
      approved,
      close: async () => {
        await Promise.all([left.end(), right.end(), monitor.end()]);
        await databases.close();
      },
    };
  } catch (error) {
    await Promise.all([left.end(), right.end(), monitor.end()]);
    await databases.close();
    throw error;
  }
}

test('ordinary group mutations queue on inventory while sharing Work, then both commit without a lock upgrade', async () => {
  const f = await fixture();
  const paused = pausedPool(
    f.left,
    (sql, values) => sql.includes('FOR UPDATE') && values[0] === inventory,
  );
  const pending: Promise<unknown>[] = [];
  try {
    const generation = await f.generation(),
      epoch = await f.epoch();
    const first = new AccessGroups(paused.pool).addMember(
      f.context(generation),
      randomUUID(),
      f.group,
      f.member,
      receipt(),
    );
    pending.push(first);
    // Attach rejection handlers while forcing the competing transaction's exact wait.
    const firstResult = first.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await paused.reached;
    const second = new AccessGroups(f.right).addMember(
      f.context(String(BigInt(generation) + 1n)),
      randomUUID(),
      f.otherGroup,
      f.otherMember,
      receipt(),
    );
    pending.push(second);
    const secondResult = second.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await blockedBy(f.monitor, f.rightPid, f.leftPid);
    paused.resume();
    expect(await firstResult).toEqual({ value: String(BigInt(generation) + 1n) });
    expect(await secondResult).toEqual({ value: String(BigInt(generation) + 2n) });
    expect(f.sqlstates).not.toContain('40P01');
    expect(await f.epoch()).toBe(epoch);
  } finally {
    paused.resume();
    await Promise.allSettled(pending);
    await f.close();
  }
}, 30_000);

test('group protection queues behind an approved activation and both commit without upgrading Work', async () => {
  const f = await fixture();
  const paused = pausedPool(
    f.left,
    (sql) => sql.includes('INSERT INTO access.protected_change_activation'),
    true,
  );
  const pending: Promise<unknown>[] = [];
  try {
    await f.protect(f.left);
    const proposal = await f.approved();
    const epoch = await f.epoch(),
      topologyEpoch = await f.epoch(topology);
    const activationReceipt = receipt();
    const first = new AccessProtectedChanges(paused.pool).activate(
      f.manager,
      activationReceipt,
      proposal.id,
    );
    pending.push(first);
    const firstResult = first.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await paused.reached;
    const second = f.protect(f.right, f.otherGroup);
    pending.push(second);
    const secondResult = second.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await blockedBy(f.monitor, f.rightPid, f.leftPid);
    paused.resume();
    expect(await firstResult).toHaveProperty('value.status', 'activated');
    expect(await secondResult).toHaveProperty('value.objectId', f.otherGroup);
    expect(f.sqlstates).not.toContain('40P01');
    expect(await f.epoch()).toBe(epoch);
    expect(await f.epoch(topology)).toBe(String(BigInt(topologyEpoch) + 1n));
    expect(
      (
        await f.monitor.query('SELECT protected_change_id FROM access.group_member WHERE id = $1', [
          proposal.memberId,
        ])
      ).rows,
    ).toEqual([{ protected_change_id: proposal.id }]);
    expect(
      await new AccessProtectedChanges(f.left).activate(f.manager, activationReceipt, proposal.id),
    ).toMatchObject({ status: 'activated', authorityEpoch: epoch, replayed: true });
  } finally {
    paused.resume();
    await Promise.allSettled(pending);
    await f.close();
  }
}, 30_000);

test('protection committed ahead of a queued ordinary effect rejects it without an effect or receipt', async () => {
  const f = await fixture();
  const paused = pausedPool(
    f.left,
    (sql) => sql.includes('INSERT INTO access.protected_set'),
    true,
  );
  const pending: Promise<unknown>[] = [];
  try {
    const generation = await f.generation(),
      epoch = await f.epoch();
    const memberId = randomUUID(),
      commandReceipt = receipt();
    const protection = f.protect(paused.pool);
    pending.push(protection);
    const protectedResult = protection.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await paused.reached;
    const addition = new AccessGroups(f.right).addMember(
      f.context(generation),
      memberId,
      f.group,
      f.member,
      commandReceipt,
    );
    pending.push(addition);
    const denied = addition.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await blockedBy(f.monitor, f.rightPid, f.leftPid);
    paused.resume();
    expect(await protectedResult).toHaveProperty('value.objectId', f.group);
    expect(await denied).toHaveProperty('error');
    expect(((await denied) as { error: unknown }).error).toBeInstanceOf(GroupDenied);
    expect(await f.generation()).toBe(generation);
    expect(await f.epoch()).toBe(epoch);
    expect(
      (await f.monitor.query('SELECT id FROM access.group_member WHERE id = $1', [memberId])).rows,
    ).toEqual([]);
    expect(
      (
        await f.monitor.query(
          'SELECT 1 FROM access.group_change_receipt WHERE idempotency_key = $1',
          [commandReceipt.idempotencyKey],
        )
      ).rows,
    ).toEqual([]);
    expect(f.sqlstates).not.toContain('40P01');
  } finally {
    paused.resume();
    await Promise.allSettled(pending);
    await f.close();
  }
}, 30_000);

test('an ordinary effect committed first is retained when queued protection follows', async () => {
  const f = await fixture();
  const paused = pausedPool(f.left, (sql) => sql.includes('INSERT INTO access.group_member'), true);
  const pending: Promise<unknown>[] = [];
  try {
    const generation = await f.generation(),
      memberId = randomUUID();
    const addition = new AccessGroups(paused.pool).addMember(
      f.context(generation),
      memberId,
      f.group,
      f.member,
      receipt(),
    );
    pending.push(addition);
    const added = addition.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await paused.reached;
    const protection = f.protect(f.right);
    pending.push(protection);
    const protectedResult = protection.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await blockedBy(f.monitor, f.rightPid, f.leftPid);
    paused.resume();
    expect(await added).toEqual({ value: String(BigInt(generation) + 1n) });
    expect(await protectedResult).toHaveProperty('value.objectId', f.group);
    expect(
      (await f.monitor.query('SELECT id FROM access.group_member WHERE id = $1', [memberId])).rows,
    ).toEqual([{ id: memberId }]);
    await expect(
      new AccessGroups(f.right).addMember(
        f.context(await f.generation()),
        randomUUID(),
        f.group,
        f.otherMember,
        receipt(),
      ),
    ).rejects.toBeInstanceOf(GroupDenied);
    expect(f.sqlstates).not.toContain('40P01');
  } finally {
    paused.resume();
    await Promise.allSettled(pending);
    await f.close();
  }
}, 30_000);

test('a queued activation rechecks the inventory generation after a safe writer commits', async () => {
  const f = await fixture();
  const paused = pausedPool(
    f.left,
    (sql, values) => sql.includes('FOR UPDATE') && values[0] === inventory,
  );
  const pending: Promise<unknown>[] = [];
  try {
    await f.protect(f.left);
    const proposal = await f.approved();
    const generation = await f.generation(),
      epoch = await f.epoch(),
      topologyEpoch = await f.epoch(topology);
    const addition = new AccessGroups(paused.pool).addMember(
      f.context(generation),
      randomUUID(),
      f.otherGroup,
      f.otherMember,
      receipt(),
    );
    pending.push(addition);
    const added = addition.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await paused.reached;
    const activationReceipt = receipt();
    const activation = new AccessProtectedChanges(f.right).activate(
      f.manager,
      activationReceipt,
      proposal.id,
    );
    pending.push(activation);
    const stale = activation.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await blockedBy(f.monitor, f.rightPid, f.leftPid);
    paused.resume();
    expect(await added).toEqual({ value: String(BigInt(generation) + 1n) });
    expect(((await stale) as { error: unknown }).error).toBeInstanceOf(ControlStale);
    expect(
      (
        await f.monitor.query(
          'SELECT 1 FROM access.protected_change_activation WHERE proposal_id = $1',
          [proposal.id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.monitor.query('SELECT 1 FROM access.group_member WHERE id = $1', [
          proposal.memberId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.monitor.query(
          'SELECT 1 FROM access.authority_control_receipt WHERE idempotency_key = $1',
          [activationReceipt.idempotencyKey],
        )
      ).rows,
    ).toEqual([]);
    expect(await f.epoch()).toBe(epoch);
    expect(await f.epoch(topology)).toBe(topologyEpoch);
    expect(f.sqlstates).not.toContain('40P01');
  } finally {
    paused.resume();
    await Promise.allSettled(pending);
    await f.close();
  }
}, 30_000);

for (const revoked of [
  'requester-mandate',
  'requester-ceiling',
  'approver-mandate',
  'approver-ceiling',
] as const) {
  test(`approved activation refuses a revoked ${revoked} and leaves no effect or receipt`, async () => {
    const f = await fixture();
    try {
      await f.protect(f.left);
      const proposal = await f.approved(),
        activationReceipt = receipt();
      const table = revoked.endsWith('mandate') ? 'representation' : 'permission_grant';
      const subjectColumn = table === 'representation' ? 'subject_id' : 'recipient_subject';
      const subject = revoked.startsWith('requester') ? f.owner : f.approvalSubject;
      const action =
        revoked === 'requester-mandate'
          ? 'access.group.manage'
          : revoked === 'requester-ceiling'
            ? 'access.group.assign.work.create'
            : revoked === 'approver-mandate'
              ? 'access.protected-change.approve'
              : 'access.grant.assign.work.create';
      await f.monitor.query(
        `UPDATE access.${table} SET active = false WHERE ${subjectColumn} = $1 AND action = $2`,
        [subject, action],
      );
      await expect(
        new AccessProtectedChanges(f.left).activate(f.manager, activationReceipt, proposal.id),
      ).rejects.toBeInstanceOf(ControlDenied);
      expect(
        (
          await f.monitor.query('SELECT 1 FROM access.group_member WHERE id = $1', [
            proposal.memberId,
          ])
        ).rows,
      ).toEqual([]);
      expect(
        (
          await f.monitor.query(
            'SELECT 1 FROM access.protected_change_activation WHERE proposal_id = $1',
            [proposal.id],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await f.monitor.query(
            'SELECT 1 FROM access.authority_control_receipt WHERE idempotency_key = $1',
            [activationReceipt.idempotencyKey],
          )
        ).rows,
      ).toEqual([]);
      expect(f.sqlstates).not.toContain('40P01');
    } finally {
      await f.close();
    }
  }, 30_000);
}

test('ordinary receipt replay and stale/conflicting intents retain their current-generation semantics', async () => {
  const f = await fixture();
  try {
    const groups = new AccessGroups(f.left),
      generation = await f.generation();
    const memberId = randomUUID(),
      commandReceipt = receipt();
    const next = await groups.addMember(
      f.context(generation),
      memberId,
      f.otherGroup,
      f.member,
      commandReceipt,
    );
    expect(
      await groups.addMember(
        f.context(generation),
        memberId,
        f.otherGroup,
        f.member,
        commandReceipt,
      ),
    ).toBe(next);
    await expect(
      groups.addMember(f.context(generation), randomUUID(), f.otherGroup, f.otherMember, receipt()),
    ).rejects.toBeInstanceOf(GroupStale);
    await expect(
      groups.addMember(f.context(next), memberId, f.otherGroup, f.member, {
        ...commandReceipt,
        requestDigest: 'b'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(GroupConflict);
    expect(
      (await f.monitor.query('SELECT id FROM access.group_member WHERE id = $1', [memberId])).rows,
    ).toEqual([{ id: memberId }]);
    expect(await f.generation()).toBe(next);
  } finally {
    await f.close();
  }
}, 30_000);

test('a proposal committed after the activation fence lookup cannot bypass that fence', async () => {
  const f = await fixture();
  const proposalId = randomUUID(),
    memberId = randomUUID(),
    activationReceipt = receipt();
  const paused = pausedPool(
    f.left,
    (sql, values) =>
      sql.startsWith('SELECT kind FROM access.protected_change_proposal') &&
      values[0] === proposalId,
  );
  const pending: Promise<unknown>[] = [];
  try {
    await f.protect(f.right);
    const activation = new AccessProtectedChanges(paused.pool).activate(
      f.manager,
      activationReceipt,
      proposalId,
    );
    pending.push(activation);
    const outcome = activation.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await paused.reached;
    await f.approved(proposalId, memberId, f.right);
    paused.resume();
    expect(((await outcome) as { error: unknown }).error).toBeInstanceOf(ControlDenied);
    expect(
      (await f.monitor.query('SELECT 1 FROM access.group_member WHERE id = $1', [memberId])).rows,
    ).toEqual([]);
    expect(
      (
        await f.monitor.query(
          'SELECT 1 FROM access.authority_control_receipt WHERE idempotency_key = $1',
          [activationReceipt.idempotencyKey],
        )
      ).rows,
    ).toEqual([]);
    // A subsequent caller request sees the committed immutable kind and takes its fence.
    expect(
      await new AccessProtectedChanges(f.left).activate(f.manager, activationReceipt, proposalId),
    ).toMatchObject({ status: 'activated', replayed: false });
    expect(f.sqlstates).not.toContain('40P01');
  } finally {
    paused.resume();
    await Promise.allSettled(pending);
    await f.close();
  }
}, 30_000);

test('approved activation preserves an independent selected authority witness through claim and terminal sealing', async () => {
  const f = await fixture();
  try {
    const selectedMember = randomUUID();
    await f.monitor.query(
      `INSERT INTO access.group_member (id, group_id, agent_subject) VALUES ($1,$2,$3)`,
      [selectedMember, f.group, f.owner],
    );
    await f.monitor.query(
      `INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',clock_timestamp() + interval '1 hour')`,
      [randomUUID(), f.managerId, f.owner],
    );
    const registry = new AccessAdmissionRegistry(f.monitor);
    const intent = {
      principal: f.manager,
      actingSubject: f.owner,
      scope: work,
      action: 'work.create',
      idempotencyKey: randomUUID(),
      requestDigest: 'c'.repeat(64),
    };
    const admission = await registry.register(intent);
    const before = (
      await f.monitor.query(
        'SELECT authority_witness, authority_epoch FROM access.admission WHERE id = $1',
        [admission.id],
      )
    ).rows[0];
    expect(
      before.authority_witness.some(
        (item: { table: string; id: string }) =>
          item.table === 'group_member' && item.id === selectedMember,
      ),
    ).toBe(true);
    await f.protect(f.left);
    const proposal = await f.approved(),
      activationReceipt = receipt();
    const activated = await new AccessProtectedChanges(f.left).activate(
      f.manager,
      activationReceipt,
      proposal.id,
    );
    expect(activated).toMatchObject({
      authorityEpoch: before.authority_epoch,
      status: 'activated',
      replayed: false,
    });
    await expect(
      new AccessProtectedChanges(f.left).activate(
        f.manager,
        { ...activationReceipt, requestDigest: 'd'.repeat(64) },
        proposal.id,
      ),
    ).rejects.toBeInstanceOf(ControlConflict);
    expect((await registry.claim(admission.id, intent.requestDigest)).state).toBe('claimed');
    await registry.recordGraphOutcome(admission.id, {
      admissionId: admission.id,
      scope: work,
      requestDigest: admission.requestDigest,
      authorityEpoch: admission.authorityEpoch,
      receipt: `urn:rezics:receipt:${createHash('sha256')
        .update(`${admission.id}\0${receiptFamilyFor(intent.action)}`)
        .digest('hex')}`,
      outcome: 'cancelled',
      dataEpoch: 'group-protection-fixture',
      sequence: '1',
    });
    const after = (
      await f.monitor.query(
        'SELECT authority_witness, authority_epoch, state FROM access.admission WHERE id = $1',
        [admission.id],
      )
    ).rows[0];
    expect(after).toEqual({ ...before, state: 'sealed' });
    expect(await f.epoch()).toBe(before.authority_epoch);
    expect(f.sqlstates).not.toContain('40P01');
  } finally {
    await f.close();
  }
}, 30_000);
