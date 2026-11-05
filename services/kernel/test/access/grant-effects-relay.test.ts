import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import { migrate } from '../../scripts/database.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createGrantCommands, type GrantRecipient } from '../../src/access/grant-commands.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { runCommand } from '../../src/command/command.ts';
import {
  EFFECTS_CONSUMER,
  EFFECTS_QUEUE,
  effectWorkflowId,
  registerEffects,
  relayEffects,
} from '../../src/events/effects.ts';
import { EVENT_TYPES, readBatch, type CloudEvent, type Envelope } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient, DBOS_SCHEMA, WORK_APPLICATION, type WorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { grantFixture } from './grant-fixture.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const eventTypes = [
  'com.rezics.access.grant.create.v1',
  'com.rezics.access.grant.change.v1',
  'com.rezics.access.grant.revoke.v1',
  'com.rezics.access.role-grant.create.v1',
  'com.rezics.access.role-grant.change.v1',
  'com.rezics.access.role-grant.revoke.v1',
  'com.rezics.access.assignment.create.v1',
  'com.rezics.access.assignment.revoke.v1',
] as const;
const recorded: CloudEvent[] = [];
let effects: ReturnType<typeof registerEffects>;
let f: Awaited<ReturnType<typeof grantFixture>>;
let commands: ReturnType<typeof createGrantCommands>;
let admin: Pool;
let database: string;
let systemPool: Pool;
let workClient: WorkClient;
const key = () => Bun.randomUUIDv7();

beforeAll(async () => {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL must name the migrated test database');
  admin = new Pool({ connectionString: source, max: 1 });
  database = `grant_relay_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = new URL(source);
  url.pathname = `/${database}`;
  await admin.query(`CREATE DATABASE ${database}`);
  migrate(url.toString());
  // Reuse real Auth issuance/installed Access against an empty, independently
  // migrated kernel database, without inheriting any partition-zero history.
  process.env.DATABASE_URL = url.toString();
  try {
    // platform.governance now expands to gate:any, so the grantor token must carry that scope.
    f = await grantFixture(['gate:any']);
  } finally {
    process.env.DATABASE_URL = source;
  }
  commands = createGrantCommands({ pool: f.pool, access: f.access, managementAction: 'access:grant' });
  await bootstrapGovernance(f.pool, f.actor);
  effects = registerEffects([
    { name: 'grant_audit', types: [...eventTypes], run: async (event) => void recorded.push(event) },
  ]);
  systemPool = new Pool({ connectionString: url.toString(), max: 10 });
  workClient = await createWorkClient(url.toString(), systemPool);
  // Preserve native partition concurrency; shorten only the fixture's idle poll.
  await workClient.registerQueue(EFFECTS_QUEUE, { ...WORK_QUEUES.effects, minPollingIntervalMs: 20 });
  DBOS.setConfig({
    name: WORK_APPLICATION,
    systemDatabaseUrl: url.toString(),
    systemDatabaseSchemaName: DBOS_SCHEMA,
    systemDatabasePool: systemPool,
    runMigrations: false,
    logLevel: 'warn',
  });
  await DBOS.launch();
}, 60_000);

afterAll(async () => {
  try {
    if (DBOS.isInitialized()) await DBOS.shutdown({ workflowCompletionTimeoutMS: 5000 });
  } finally {
    try {
      await workClient?.close();
    } finally {
      try {
        await systemPool?.end();
      } finally {
        try {
          await f?.close();
        } finally {
          if (admin) {
            try {
              if (database) await dropTestDatabase(admin, database);
            } finally {
              await admin.end();
            }
          }
        }
      }
    }
  }
}, 30_000);

async function checkpoint(partition: number) {
  const { rows } = await f.reader.query(
    'SELECT position::text FROM core.consumer_checkpoint WHERE consumer=$1 AND partition_no=$2',
    [EFFECTS_CONSUMER, partition],
  );
  return BigInt(rows[0]!.position);
}

async function committed(transactionId: string) {
  const receipt = await f.reader.query<{ position: string }>(
    'SELECT position::text FROM core.receipt WHERE transaction_id=$1',
    [transactionId],
  );
  expect(receipt.rows).toHaveLength(1);
  return BigInt(receipt.rows[0]!.position);
}

async function finishEffects(envelopes: readonly Envelope[]) {
  const ids = envelopes.flatMap((envelope) =>
    envelope.events.map((_, seq) => effectWorkflowId(envelope, seq, 'grant_audit')),
  );
  // A failed native workflow cannot leave an unbounded getResult await behind.
  for (let attempt = 0; attempt < 200; attempt++) {
    const statuses = await Promise.all(ids.map((id) => DBOS.getWorkflowStatus(id)));
    if (statuses.every((status) => status?.status === 'SUCCESS')) return;
    if (statuses.some((status) => status?.status === 'ERROR')) throw new Error('Grant effect failed');
    await Bun.sleep(25);
  }
  throw new Error('Grant effects did not finish within five seconds');
}

test('real Global grants pass the production relay, advance its checkpoint and replay one effect', async () => {
  const context = await f.context();
  const input = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account' as const, id: f.recipient },
    actions: ['access:grant'],
    valid: '(,)',
    key: key(),
  };
  const created = await commands.create(context, input);
  const position = await committed(created.transactionId);
  expect(position).toBe(3n); // Bootstrap and its organization:create standing grant precede this command.
  expect(await commands.create(context, input)).toEqual({ ...created, replayed: true });
  const changed = await commands.change(context, {
    ...input,
    key: key(),
    previous: { actions: input.actions, valid: input.valid },
    valid: '[2030-01-01,2031-01-01)',
  });
  const next = await committed(changed.transactionId);
  expect(next).toBe(position + 1n);
  const envelopes: Envelope[] = [];
  await readBatch(f.pool, {
    consumer: 'grant_replay',
    partition: 0,
    apply: async (batch) => {
      envelopes.push(...batch.filter((envelope) => envelope.position >= position));
    },
  });
  expect(envelopes.map((envelope) => envelope.events[0]!.data)).toEqual([created.value, changed.value]);
  expect(await relayEffects(f.pool, effects, 0)).toEqual({ status: 'read', envelopes: 4, position: next });
  expect(await checkpoint(0)).toBe(next);
  await finishEffects(envelopes);
  expect(recorded.map((event) => event.data)).toEqual([created.value, changed.value]);
  await effects.enqueue(envelopes);
  await finishEffects(envelopes);
  expect(recorded).toHaveLength(2);
  expect(await relayEffects(f.pool, effects, 0)).toEqual({ status: 'read', envelopes: 0, position: next });
  expect(await checkpoint(0)).toBe(next);
  await commands.revoke(await f.context(), { ...input, valid: changed.value.valid, key: key() });
}, 20_000);

test('native grant mutations and assignment creation conform to the registry and relay', async () => {
  const recipients: GrantRecipient[] = [
    { subject: { kind: 'account', id: f.recipient } },
    { subject: { kind: 'organization', id: f.principal, role: 'owner' } },
    { subject: { kind: 'organization', id: f.principal, role: 'member' } },
    { subject: { kind: 'active_accounts' } },
    ...(['', 'owner', 'member'] as const).map((subjectRole) => ({ subjectId: f.recipient, subjectRole })),
  ];
  for (const recipient of recipients) {
    const context = await f.context();
    const input = { resource: PLATFORM_RESOURCE, ...recipient, actions: ['access:grant'], valid: '(,)', key: key() };
    const created = await commands.create(context, input);
    const changed = await commands.change(context, {
      ...input,
      previous: { actions: input.actions, valid: input.valid },
      valid: '[2030-01-01,2031-01-01)',
      key: key(),
    });
    const revoked = await commands.revoke(context, { ...input, valid: changed.value.valid, key: key() });
    for (const [operation, result] of [
      ['create', created],
      ['change', changed],
      ['revoke', revoked],
    ] as const)
      expect(Value.Check(EVENT_TYPES()[`com.rezics.access.grant.${operation}.v1`], result.value)).toBe(true);
    if (recipient.subject) {
      const role = {
        resource: PLATFORM_RESOURCE,
        subject: recipient.subject,
        role: 'platform.governance',
        valid: '(,)',
        key: key(),
      };
      const createdRole = await commands.createRole(context, role);
      const changedRole = await commands.changeRole(context, {
        ...role,
        previous: { role: role.role, valid: role.valid },
        valid: '[2030-01-01,2031-01-01)',
        key: key(),
      });
      const revokedRole = await commands.revokeRole(context, { ...role, valid: changedRole.value.valid, key: key() });
      for (const [operation, result] of [
        ['create', createdRole],
        ['change', changedRole],
        ['revoke', revokedRole],
      ] as const)
        expect(Value.Check(EVENT_TYPES()[`com.rezics.access.role-grant.${operation}.v1`], result.value)).toBe(true);
    }
  }
  // Only the independent principal's starting delegation permission is fixture SQL;
  // Global grantor authority above comes exclusively from bootstrapGovernance.
  await f.grant(f.actor, 'account:delegate', { route: routeOf(f.actor)!, id: f.actor });
  const assignments = createDelegationCommands({ pool: f.pool, access: f.access, action: 'account:delegate' });
  const context = await f.context();
  const input = {
    principalId: f.actor,
    assignedActorId: f.recipient,
    requestId: newId(routeOf(f.actor)!),
    valid: '(,)',
    key: key(),
  };
  const created = await assignments.create(context, input);
  expect(Value.Check(EVENT_TYPES()['com.rezics.access.assignment.create.v1'], created.value)).toBe(true);
  const revoked = await assignments.revoke(context, {
    principalId: input.principalId,
    requestId: input.requestId,
    key: key(),
  });
  expect(Value.Check(EVENT_TYPES()['com.rezics.access.assignment.revoke.v1'], revoked.value)).toBe(true);
  for (const partition of [0, partitionOf(routeOf(f.actor)!)]) {
    const envelopes: Envelope[] = [];
    await readBatch(f.pool, {
      consumer: 'grant_conformance',
      partition,
      apply: async (batch) => {
        envelopes.push(...batch);
      },
    });
    const grants = envelopes.filter((envelope) =>
      envelope.events.some((event) => eventTypes.includes(event.type as (typeof eventTypes)[number])),
    );
    expect((await relayEffects(f.pool, effects, partition)).status).toBe('read');
    expect(await checkpoint(partition)).toBe(envelopes.at(-1)!.position);
    await finishEffects(grants);
  }
  expect(new Set(recorded.map((event) => event.type))).toEqual(new Set(eventTypes));
}, 30_000);

test('production validation still stops on extra data, credentials, wrong payloads and unknown types', async () => {
  const data = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'active_accounts' },
    actions: ['access:grant'],
    valid: '(,)',
  };
  const badEvents = [
    { type: eventTypes[0], data: { ...data, extra: true } },
    { type: eventTypes[0], data: { ...data, token: 'private' } },
    {
      type: eventTypes[0],
      data: { ...data, subject: { kind: 'account', id: '00000000-0000-0000-0000-000000000000' } },
    },
    { type: eventTypes[3], data },
    { type: 'com.rezics.access.grant.future.v1', data },
  ];
  for (const [index, event] of badEvents.entries()) {
    const partition = 4000 + index;
    const snapshot = async () =>
      (
        await f.reader.query(
          `SELECT position,
            (SELECT count(*) FROM core.receipt WHERE partition_no=$1) AS receipts,
            (SELECT count(*) FROM core.outbox WHERE partition_no=$1) AS events
          FROM core.partition WHERE partition_no=$1`,
          [partition],
        )
      ).rows;
    const before = await snapshot();
    await expect(
      runCommand(
        f.pool,
        {
          partition,
          basis: { actorAccountId: f.actor, clientId: 'grant-relay', requestedBy: null },
          receipt: { actorAccountId: f.actor, kind: 'fixture.grant-relay', key: key(), digest: new Uint8Array(32) },
        },
        async () => ({ value: null, events: [event] }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(await snapshot()).toEqual(before);
    // Simulate a historic or defective writer so the reader's defence is still exercised.
    await f.reader.query(
      `WITH fence AS (
        UPDATE core.partition SET position=position+1 WHERE partition_no=$1
        RETURNING partition_no, position, epoch
      )
      INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, data)
      SELECT partition_no, position, 0, 1, epoch, $2, $3, $4::jsonb FROM fence`,
      [partition, Bun.randomUUIDv7(), event.type, JSON.stringify(event.data)],
    );
    const count = recorded.length;
    for (let replay = 0; replay < 2; replay++) {
      expect(await relayEffects(f.pool, effects, partition)).toEqual({
        status: 'stopped',
        reason: index === badEvents.length - 1 ? 'unknown_type' : 'invalid_data',
        envelopes: 0,
        position: 0n,
      });
      expect(await checkpoint(partition)).toBe(0n);
      expect(recorded).toHaveLength(count);
    }
  }
});
