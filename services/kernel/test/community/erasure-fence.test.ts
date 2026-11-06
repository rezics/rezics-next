import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { CloudEvent } from '../../src/events/log.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { closeErasureFence, lockErasureFence } from '../../src/community/erasure-fence.ts';
import { createPartyLocatorEffect } from '../../src/community/party-locator.ts';
import { eraseAccountCommunityRecordsPage } from '../../src/community/account-erasure-records.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import {
  createNativeContentSystemWithWriteRateOverrides,
  type NativeContentSystem,
} from '../content/support/native-system.ts';
import { HIGH_RATE_OVERRIDES, seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';

type Person = { accountId: string; bearer: string };
type OutboxRow = {
  partition_no: number;
  position: string;
  event_seq: number;
  epoch: number;
  id: string;
  type: string;
  subject: string | null;
  data: unknown;
  recorded_at: Date;
};

let system: NativeContentSystem;
let realmId: string;
let inFlightRealmId: string;
const owner = (): Person => ({ accountId: system.actors.other.actor.accountId, bearer: system.actors.other.bearer });
const moderator = (): Person => ({
  accountId: system.actors.moderator.actor.accountId,
  bearer: system.actors.moderator.bearer,
});
const key = () => JSON.stringify(crypto.randomUUID());

async function request<T>(person: Person, method: string, path: string, body?: unknown): Promise<T> {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${person.bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': key() }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function createPerson(): Promise<Person> {
  return accountDeletionRuntime(system).person();
}

async function erase(person: Person) {
  const runtime = accountDeletionRuntime(system);
  return deletePersona({ version: 1, pool: system.database.pool, auth: runtime.auth }, person);
}

async function ban(target: Person, ownerRealmId = realmId, actor = moderator()): Promise<CloudEvent> {
  await request(actor, 'PUT', `/v1/realms/${ownerRealmId}/bans/${target.accountId}`, {
    reason: `Fence case ${target.accountId}`,
  });
  const { rows } = await system.database.pool.query<OutboxRow>(
    `SELECT partition_no,position::text,event_seq,epoch,id::text,type,subject,data,recorded_at
     FROM core.outbox WHERE type='com.rezics.community.realm.ban.v1' AND data->>'realmId'=$1
       AND data->>'accountId'=$2 ORDER BY position DESC,event_seq LIMIT 1`,
    [ownerRealmId, target.accountId],
  );
  const row = rows[0];
  if (!row) throw new Error('Native ban route did not write its community event');
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    ...(row.subject ? { subject: row.subject } : {}),
    time: row.recorded_at.toISOString(),
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  };
}

async function closeFence(accountId: string): Promise<void> {
  const route = routeOf(accountId)!;
  await runCommand(system.database.pool, { partition: partitionOf(route) }, async (tx) =>
    noEffect(await closeErasureFence(tx, accountId)),
  );
}

async function waitForLockedStatement(pattern: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await system.database.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE pid <> pg_backend_pid() AND state='active' AND wait_event_type='Lock' AND query LIKE $1 LIMIT 1`,
      [pattern],
    );
    if (rows.length) return;
    await Bun.sleep(10);
  }
  throw new Error(`Community erasure fence close did not wait on its expected lock: ${pattern}`);
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    HIGH_RATE_OVERRIDES,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  await seedGovernanceAuthority(
    system.database.pool,
    PLATFORM_RESOURCE.route,
    PLATFORM_RESOURCE.id,
    owner().accountId,
    ['space:create', 'realm:create'],
  );
  const { space } = await request<{ space: { spaceId: string } }>(owner(), 'POST', '/v1/spaces', {
    title: 'Community locator fence space',
  });
  const { realm } = await request<{ realm: { realmId: string } }>(owner(), 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Community locator fence realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  realmId = realm.realmId;
  await seedGovernanceAuthority(system.database.pool, routeOf(realmId)!, realmId, owner().accountId, ['access:grant']);
  await request(owner(), 'POST', '/v1/roleGrants', {
    resource: { route: routeOf(realmId), id: realmId },
    subject: { kind: 'account', id: moderator().accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  });
  const { space: inFlightSpace } = await request<{ space: { spaceId: string } }>(owner(), 'POST', '/v1/spaces', {
    title: 'Community in-flight locator space',
  });
  const { realm: inFlightRealm } = await request<{ realm: { realmId: string } }>(owner(), 'POST', '/v1/realms', {
    spaceId: inFlightSpace.spaceId,
    title: 'Community in-flight locator realm',
    visibility: 'public',
    contextId: GLOBAL_CONTEXT,
  });
  inFlightRealmId = inFlightRealm.realmId;
  await seedGovernanceAuthority(system.database.pool, routeOf(inFlightRealmId)!, inFlightRealmId, owner().accountId, [
    'access:grant',
  ]);
  await request(owner(), 'POST', '/v1/roleGrants', {
    resource: { route: routeOf(inFlightRealmId), id: inFlightRealmId },
    subject: { kind: 'account', id: moderator().accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  });
});

afterAll(async () => {
  await system?.close();
});

test('a community party locator effect that runs after the fence closes writes no locator and minimizes its record', async () => {
  const person = await createPerson();
  const target = await createPerson();
  await request(owner(), 'POST', '/v1/roleGrants', {
    resource: { route: routeOf(realmId), id: realmId },
    subject: { kind: 'account', id: person.accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  });
  const event = await ban(target, realmId, person);
  const erased = await erase(person);
  await closeFence(person.accountId);
  await createPartyLocatorEffect(system.database.pool, () => new Date()).run(event);

  expect(
    (
      await system.database.pool.query('SELECT 1 FROM community.party_locator WHERE route=$1 AND account_id=$2', [
        routeOf(person.accountId),
        person.accountId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await system.database.pool.query(
        'SELECT actor,reason FROM community.realm_ban WHERE realm_id=$1 AND account_id=$2',
        [realmId, target.accountId],
      )
    ).rows,
  ).toEqual([{ actor: null, reason: '' }]);
  expect(
    (
      await system.database.pool.query(
        `SELECT resolved_at IS NOT NULL AS resolved FROM access.erasure_late_item
         WHERE route=$1 AND account_id=$2 AND participant='community'`,
        [routeOf(person.accountId), person.accountId],
      )
    ).rows,
  ).toEqual([{ resolved: true }]);
  expect(new Date(erased.at).getTime()).toBeGreaterThan(0);
});

test('a community locator committed before closure is found and fence closure waits for its in-flight transaction', async () => {
  const person = await createPerson();
  const event = await ban(person);
  const effect = createPartyLocatorEffect(system.database.pool, () => new Date());
  await effect.run(event);
  await ban(person, inFlightRealmId);
  const erased = await erase(person);

  const inFlight = await system.database.pool.connect();
  const closer = await system.database.pool.connect();
  try {
    await inFlight.query('BEGIN');
    await lockErasureFence(inFlight, person.accountId);
    const { rows } = await inFlight.query<{ due_at: string; owner_route: number; owner_id: string; key: string }>(
      `SELECT lower(valid)::text AS due_at,route AS owner_route,realm_id::text AS owner_id,account_id::text AS key
       FROM community.realm_ban WHERE route=$1 AND realm_id=$2 AND account_id=$3`,
      [routeOf(inFlightRealmId), inFlightRealmId, person.accountId],
    );
    const source = rows[0];
    if (!source) throw new Error('Native ban route did not write its locator source');
    await inFlight.query(
      `INSERT INTO community.party_locator(route,account_id,kind,due_at,owner_route,owner_id,key)
       VALUES ($1,$2,'ban_target',$3::timestamptz,$4,$5,$6)`,
      [routeOf(person.accountId), person.accountId, source.due_at, source.owner_route, source.owner_id, source.key],
    );
    let closed = false;
    await closer.query('BEGIN');
    const closing = closeErasureFence(closer, person.accountId).then((value) => {
      closed = true;
      return value;
    });
    await waitForLockedStatement('%community.erasure_fence%');
    expect(closed).toBe(false);
    await inFlight.query('COMMIT');
    await closing;
    await closer.query('COMMIT');
  } catch (error) {
    await inFlight.query('ROLLBACK').catch(() => {});
    await closer.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    inFlight.release();
    closer.release();
  }

  const page = await eraseAccountCommunityRecordsPage(
    { clock: () => new Date(), pool: system.database.pool },
    person.accountId,
    {
      erasedAt: erased.at,
      after: null,
    },
  );
  expect(page.found).toBeGreaterThanOrEqual(2);
  expect(page.pending).toBe(0);
  expect(page.next).toBeNull();
  expect(
    (
      await system.database.pool.query('SELECT 1 FROM community.party_locator WHERE route=$1 AND account_id=$2', [
        routeOf(person.accountId),
        person.accountId,
      ])
    ).rows,
  ).toEqual([]);
});
