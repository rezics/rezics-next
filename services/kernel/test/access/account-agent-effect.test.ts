import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg, { type Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  ACCOUNT_AGENT_EVENT_TYPES,
  applyAccountAgentEffect,
  createAccountAgentEffect,
} from '../../src/access/account-agent-effect.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { readSubject } from '../../src/semantic/subject.ts';
import { createPool } from '../../src/database/pool.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { ensureActiveAccountAgents, ACCOUNT_AGENT_PAGE_SIZE } from '../../scripts/ensure-account-agents.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const route = 0x5123;
const personId = newId(route);
const organizationId = newId(route);
const softwareId = newId(route);
const renameId = newId(route);
const crashId = newId(route);
const fencedId = newId(route);
const suspendedId = newId(route);
const deletedId = newId(route);

type SeedAccount = {
  id: string;
  kind?: 'actor' | 'organization';
  handle: string;
  displayName: string | null;
  operatorId?: string | null;
  state?: 'active' | 'suspended' | 'deleted';
  fenced?: boolean;
};

async function seedAccounts(accounts: readonly SeedAccount[]): Promise<void> {
  await admin.query(
    `INSERT INTO access.account
       (route, account_id, kind, handle, display_name, state, operator_account_id, authn_fenced, transaction_id)
     SELECT $1, seed.account_id, seed.kind, seed.handle, seed.display_name, seed.state,
            seed.operator_id, seed.fenced, seed.account_id
     FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::text[], $8::boolean[])
       AS seed(account_id, kind, handle, display_name, operator_id, state, fenced)`,
    [
      route,
      accounts.map(({ id }) => id),
      accounts.map(({ kind }) => kind ?? 'actor'),
      accounts.map(({ handle }) => handle),
      accounts.map(({ displayName }) => displayName),
      accounts.map(({ operatorId }) => operatorId ?? null),
      accounts.map(({ state }) => state ?? 'active'),
      accounts.map(({ fenced }) => fenced ?? false),
    ],
  );
}

function event(
  type: (typeof ACCOUNT_AGENT_EVENT_TYPES)[number],
  accountId: string,
  ownerAccountId?: string,
): CloudEvent {
  const data =
    type === 'com.rezics.access.organization-created.v1'
      ? { accountId, ownerAccountId: ownerAccountId! }
      : { accountId };
  return {
    specversion: '1.0',
    id: newId(routeOf(accountId)!),
    source: `urn:rezics:log:${partitionOf(routeOf(accountId)!)}.1`,
    type,
    subject: accountId,
    time: '2026-10-27T00:00:00.000Z',
    datacontenttype: 'application/json',
    sequence: '0000000000000000001',
    data,
  };
}

async function currentSubject(accountId: string) {
  const result = await readSubject(
    pool,
    accountAgentId(accountId),
    async () => true,
    undefined,
    new Uint8Array(32).fill(1),
  );
  if (!result) throw new Error(`Missing account agent for ${accountId}`);
  return result.subject;
}

async function revisionCount(accountId: string): Promise<number> {
  const result = await admin.query(
    'SELECT count(*)::integer AS count FROM semantic.revision WHERE route = $1 AND subject_id = $2::uuid',
    [route, accountAgentId(accountId)],
  );
  return result.rows[0]!.count as number;
}

function failEnsureCheckoutOnce(source: Pool): Pool {
  let checkouts = 0;
  return new Proxy(source, {
    get(target, property) {
      if (property === 'connect')
        return (...args: unknown[]) => {
          checkouts += 1;
          if (checkouts === 2) return Promise.reject(new Error('simulated process loss before ensure'));
          return target.connect(...(args as Parameters<Pool['connect']>));
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Pool;
}

beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  await seedAccounts([
    { id: personId, handle: 'agent_person', displayName: 'Person Display' },
    { id: organizationId, kind: 'organization', handle: 'agent_organization', displayName: 'Organization Display' },
    { id: softwareId, handle: 'agent_software', displayName: 'Software Display', operatorId: personId },
    { id: renameId, handle: 'agent_rename', displayName: 'Before Rename' },
    { id: crashId, handle: 'agent_crash', displayName: 'Crash Recovery' },
    { id: fencedId, handle: 'agent_fenced', displayName: 'Fenced', fenced: true },
    { id: suspendedId, handle: 'agent_suspended', displayName: 'Suspended' },
    { id: deletedId, handle: 'agent_deleted', displayName: 'Deleted', state: 'deleted' },
  ]);
  await suspendAccount(admin, suspendedId);
  await admin.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $2, 'account:update', '(,)', $2)`,
    [route, renameId],
  );
});

afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});

test('activation, organization creation and automated activation ensure the current account agent once', async () => {
  const effect = createAccountAgentEffect(pool);
  expect(effect.name).toBe('account_agent');
  expect(effect.types).toEqual([...ACCOUNT_AGENT_EVENT_TYPES]);
  expect(ACCOUNT_AGENT_EVENT_TYPES).toContain('com.rezics.access.actor-activated.v1');
  expect(ACCOUNT_AGENT_EVENT_TYPES).toContain('com.rezics.access.organization-created.v1');

  await effect.run(event('com.rezics.access.actor-activated.v1', personId));
  await effect.run(event('com.rezics.access.organization-created.v1', organizationId, personId));
  await effect.run(event('com.rezics.access.actor-activated.v1', softwareId));

  expect(await currentSubject(personId)).toMatchObject({
    id: accountAgentId(personId),
    type: 'schema:Person',
    labels: { und: 'Person Display' },
  });
  expect(await currentSubject(organizationId)).toMatchObject({
    id: accountAgentId(organizationId),
    type: 'schema:Organization',
    labels: { und: 'Organization Display' },
  });
  expect(await currentSubject(softwareId)).toMatchObject({
    id: accountAgentId(softwareId),
    type: 'schema:SoftwareApplication',
    labels: { und: 'Software Display' },
  });

  const before = await revisionCount(personId);
  const replay = event('com.rezics.access.actor-activated.v1', personId);
  await effect.run(replay);
  await effect.run(replay);
  expect(await revisionCount(personId)).toBe(before);
});

test('a committed display-name change emits a reference event and old deliveries use the current row', async () => {
  await applyAccountAgentEffect(pool, event('com.rezics.access.actor-activated.v1', renameId));
  const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 30_000 },
    { accountId: renameId, clientId: 'account-agent-effect', scopes: [...LIFECYCLE_ACTIONS.keys()] },
  );
  const commands = createLifecycleCommands({ pool, access });
  const firstInput = { accountId: renameId, key: 'display-name-first', patch: { displayName: 'After Rename' } };
  const first = await commands.updateAccount({ actor, deadline: Date.now() + 30_000 }, firstInput);
  expect(first.replayed).toBe(false);
  const firstEvent = await lastAccountEvent(renameId, 'com.rezics.access.account-display-name-changed.v1');
  expect(firstEvent.data).toEqual({ accountId: renameId });

  const replay = await commands.updateAccount({ actor, deadline: Date.now() + 30_000 }, firstInput);
  expect(replay.replayed).toBe(true);
  await commands.updateAccount(
    { actor, deadline: Date.now() + 30_000 },
    { accountId: renameId, key: 'display-name-unchanged', patch: { displayName: 'After Rename' } },
  );
  const noOpEvents = await admin.query(
    `SELECT count(*)::integer AS count FROM core.outbox
     WHERE partition_no = $1 AND subject = $2 AND type = 'com.rezics.access.account-display-name-changed.v1'`,
    [partitionOf(route), renameId],
  );
  expect(noOpEvents.rows[0]!.count).toBe(1);

  await commands.updateAccount(
    { actor, deadline: Date.now() + 30_000 },
    { accountId: renameId, key: 'display-name-later', patch: { displayName: 'Latest Rename' } },
  );
  const laterEvent = await lastAccountEvent(renameId, 'com.rezics.access.account-display-name-changed.v1');
  await applyAccountAgentEffect(pool, firstEvent);
  expect((await currentSubject(renameId)).labels).toEqual({ und: 'Latest Rename' });
  const latestRevision = await revisionCount(renameId);
  await applyAccountAgentEffect(pool, laterEvent);
  await applyAccountAgentEffect(pool, firstEvent);
  expect(await revisionCount(renameId)).toBe(latestRevision);
});

test('a retry after account commit repairs a crash before the semantic ensure', async () => {
  const interrupted = failEnsureCheckoutOnce(pool);
  const committedEvent = event('com.rezics.access.actor-activated.v1', crashId);
  await expect(applyAccountAgentEffect(interrupted, committedEvent)).rejects.toThrow(
    'simulated process loss before ensure',
  );
  await applyAccountAgentEffect(interrupted, committedEvent);
  expect(await currentSubject(crashId)).toMatchObject({
    id: accountAgentId(crashId),
    type: 'schema:Person',
    labels: { und: 'Crash Recovery' },
  });
});

test('missing, fenced, suspended and deleted account references do not create agent nodes', async () => {
  await applyAccountAgentEffect(pool, event('com.rezics.access.actor-activated.v1', newId(route)));
  await applyAccountAgentEffect(pool, event('com.rezics.access.actor-activated.v1', fencedId));
  await applyAccountAgentEffect(pool, event('com.rezics.access.actor-activated.v1', suspendedId));
  await applyAccountAgentEffect(pool, event('com.rezics.access.actor-activated.v1', deletedId));
  const result = await admin.query(
    'SELECT count(*)::integer AS count FROM semantic.subject WHERE route = $1 AND subject_id = ANY($2::uuid[])',
    [route, [fencedId, suspendedId, deletedId].map(accountAgentId)],
  );
  expect(result.rows[0]!.count).toBe(0);
});

test('the active-account backfill crosses page boundaries and is idempotent', async () => {
  expect(ACCOUNT_AGENT_PAGE_SIZE).toBe(100);
  const accounts = Array.from({ length: ACCOUNT_AGENT_PAGE_SIZE + 1 }, () => newId(route));
  await admin.query(
    `INSERT INTO access.account(route, account_id, kind, handle, display_name, state, transaction_id)
     SELECT $1, id, 'actor', 'backfill_' || replace(id::text, '-', ''), 'Backfill ' || id::text, 'active', id
     FROM unnest($2::uuid[]) AS seed(id)`,
    [route, accounts],
  );
  const processed = await ensureActiveAccountAgents(pool);
  expect(processed).toBeGreaterThanOrEqual(accounts.length);
  const links = await admin.query(
    'SELECT count(*)::integer AS count FROM semantic.account_agent_subject WHERE account_id = ANY($1::uuid[])',
    [accounts],
  );
  expect(links.rows[0]!.count).toBe(accounts.length);
  const revisions = await admin.query(
    'SELECT count(*)::integer AS count FROM semantic.revision WHERE subject_id = ANY($1::uuid[])',
    [accounts.map(accountAgentId)],
  );

  await ensureActiveAccountAgents(pool);
  const revisionsAfter = await admin.query(
    'SELECT count(*)::integer AS count FROM semantic.revision WHERE subject_id = ANY($1::uuid[])',
    [accounts.map(accountAgentId)],
  );
  expect(revisionsAfter.rows[0]!.count).toBe(revisions.rows[0]!.count);
});

test('with no active global definition release the effect completes without creating an agent', async () => {
  const accountId = newId(route);
  await seedAccounts([{ id: accountId, handle: 'agent_before_release', displayName: 'Before Release' }]);
  await withoutActiveRelease(async () => {
    await expect(
      applyAccountAgentEffect(pool, event('com.rezics.access.actor-activated.v1', accountId)),
    ).resolves.toBeUndefined();
    const subjects = await admin.query(
      'SELECT count(*)::integer AS count FROM semantic.subject WHERE route = $1 AND subject_id = $2::uuid',
      [route, accountAgentId(accountId)],
    );
    expect(subjects.rows[0]!.count).toBe(0);
    expect(await revisionCount(accountId)).toBe(0);
    const links = await admin.query(
      'SELECT count(*)::integer AS count FROM semantic.account_agent_subject WHERE account_id = $1::uuid',
      [accountId],
    );
    expect(links.rows[0]!.count).toBe(0);
  });
});

test('running the ensure-account-agents backfill after a release activates creates the missing agent', async () => {
  const accountId = newId(route);
  await seedAccounts([{ id: accountId, handle: 'agent_after_release', displayName: 'After Release' }]);
  await withoutActiveRelease(async () => {
    await applyAccountAgentEffect(pool, event('com.rezics.access.actor-activated.v1', accountId));
    expect(await revisionCount(accountId)).toBe(0);
    await bootstrapRelease(pool, bundledRelease);
    await ensureActiveAccountAgents(pool);
    expect(await currentSubject(accountId)).toMatchObject({
      id: accountAgentId(accountId),
      type: 'schema:Person',
      labels: { und: 'After Release' },
    });
    expect(await revisionCount(accountId)).toBe(1);
  });
});

test('an ensure failure with the missing-release message still throws so delivery retries', async () => {
  const accountId = newId(route);
  await seedAccounts([{ id: accountId, handle: 'agent_other_failure', displayName: 'Other Failure' }]);
  const failure = new Error('Global definition release is not active');
  let checkouts = 0;
  const failing = new Proxy(pool, {
    get(target, property) {
      if (property === 'connect')
        return (...args: unknown[]) => {
          if (++checkouts === 2) return Promise.reject(failure);
          return target.connect(...(args as Parameters<Pool['connect']>));
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const activation = event('com.rezics.access.actor-activated.v1', accountId);
  await expect(applyAccountAgentEffect(failing, activation)).rejects.toBe(failure);
  expect(await revisionCount(accountId)).toBe(0);
  await applyAccountAgentEffect(failing, activation);
  expect((await currentSubject(accountId)).labels).toEqual({ und: 'Other Failure' });
});

async function withoutActiveRelease(run: () => Promise<void>): Promise<void> {
  const saved = await admin.query('DELETE FROM semantic.definition_activation WHERE route = 0 RETURNING *');
  try {
    await run();
  } finally {
    await admin.query('DELETE FROM semantic.definition_activation WHERE route = 0');
    for (const row of saved.rows)
      await admin.query(
        'INSERT INTO semantic.definition_activation (route, head, digest, recorded_transaction_id) VALUES ($1, $2, $3, $4)',
        [row.route, row.head, row.digest, row.recorded_transaction_id],
      );
  }
}

async function lastAccountEvent(
  accountId: string,
  type: 'com.rezics.access.account-display-name-changed.v1',
): Promise<CloudEvent> {
  const { rows } = await admin.query<{
    partition_no: number;
    epoch: number;
    position: string;
    id: string;
    type: string;
    subject: string;
    data: unknown;
    recorded_at: Date;
  }>(
    `SELECT partition_no, epoch, position::text, id::text, type, subject, data, recorded_at
     FROM core.outbox
     WHERE partition_no = $1 AND subject = $2 AND type = $3
     ORDER BY position DESC, event_seq DESC LIMIT 1`,
    [partitionOf(route), accountId, type],
  );
  const row = rows[0];
  if (!row) throw new Error(`Missing committed event ${type}`);
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    subject: row.subject,
    time: row.recorded_at.toISOString(),
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  };
}
