import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LifecycleDeniedError,
  LIFECYCLE_ACTIONS,
} from '../../src/access/lifecycle.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const routeKey = new Uint8Array(32).fill(29);
const kernel = createKernel({ pool, routeKey });
const commands = createLifecycleCommands({ pool, access });
const provisions = new Map<
  object,
  { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
>();
const internal = createLifecycleInternals({
  pool,
  routeKey,
  provisioningEvidence: async (proof) => provisions.get(proof as object) ?? null,
  recoveryEvidence: async () => null,
});
let sequence = 0;
const key = () => `profile-${++sequence}`;
let accountId: string;
const links = [{ label: 'Website', url: 'https://example.com/about?hello=world#links' }];

async function context(id: string) {
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10_000 },
    {
      accountId: id,
      clientId: 'profile-client',
      scopes: [...LIFECYCLE_ACTIONS.keys()],
      requestedBy: null,
      authnEpoch: 1,
    },
  );
  return { actor, account: await readAccount(pool, routeOf(id)!, id), deadline: Date.now() + 10_000 };
}
async function person(handle: string) {
  const registrationKey = key();
  const id = internal.registrationTarget(registrationKey);
  const claim = await internal.reserveHandle({ handle, accountId: id, key: registrationKey });
  await internal.createPending({
    handle,
    accountId: id,
    reservationId: claim.value.reservationId,
    key: registrationKey,
  });
  const evidence = {};
  provisions.set(evidence, {
    accountId: id,
    registrationId: claim.value.reservationId,
    authIdentityId: id,
    authnEpoch: 1,
  });
  await internal.activate({ accountId: id, evidence, key: key() });
  await internal.claimHandle({ handle, accountId: id, reservationId: claim.value.reservationId, key: key() });
  return id;
}
async function read(query: string) {
  const response = await kernel.handle(new Request(`https://kernel.test/v1/accounts?${query}`));
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  await bootstrapRelease(pool, bundledRelease);
  accountId = await person('profile_handle');
});
afterAll(async () => {
  await pool.end();
});

test('handle reads the public profile and ids keep their identity projection with next null', async () => {
  await commands.updateAccount(await context(accountId), {
    accountId,
    key: key(),
    patch: {
      displayName: 'Profile',
      biography: 'A biography',
      links,
    },
  });
  await ensureAccountAgent(pool, { account: accountId, kind: 'person', name: 'Profile', language: 'en' });
  const identity = {
    id: accountId,
    kind: 'actor',
    handle: 'profile_handle',
    displayName: 'Profile',
    state: 'active',
    automated: false,
    operatorId: null,
  };
  expect(await read('handle=PROFILE_HANDLE')).toEqual({
    status: 200,
    body: {
      accounts: [
        {
          ...identity,
          publicViews: { posts: true, reviews: true, collections: true, realms: false },
          bio: 'A biography',
          links,
          avatar: null,
          subject: { id: accountAgentId(accountId), label: 'Profile', type: 'schema:Person' },
          verified: false,
        },
      ],
      next: null,
    },
  });
  expect(await read(`ids=${accountId}`)).toEqual({ status: 200, body: { accounts: [identity], next: null } });
});

test('profile patch opts Realms into the public identity read', async () => {
  await commands.updateAccount(await context(accountId), {
    accountId,
    key: key(),
    patch: { publicViews: { realms: true } },
  });

  expect((await read('handle=profile_handle')).body.accounts[0].publicViews).toEqual({
    posts: true,
    reviews: true,
    collections: true,
    realms: true,
  });
});

test('unknown, reserved and pending claims return an empty list', async () => {
  const empty = { status: 200, body: { accounts: [], next: null } };
  expect(await read('handle=unknown_profile')).toEqual(empty);
  const id = newId(0x4567);
  for (const state of ['reserved', 'pending']) {
    const handle = `${state}_profile`;
    const route = createHash('sha256').update(handle).digest().readUInt16BE(0);
    await pool.query(
      `INSERT INTO access.handle_claim(route, normalized_handle, account_id, state, expires_at, reserved_until, transaction_id)
      VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'pending' THEN now() + interval '1 day' END,
        CASE WHEN $4 = 'reserved' THEN now() + interval '1 day' END, $3)`,
      [route, handle, id, state],
    );
    expect(await read(`handle=${handle}`)).toEqual(empty);
  }
});

test('exactly one valid ids or handle query is required', async () => {
  for (const query of [
    '',
    `ids=${accountId}&handle=profile_handle`,
    'handle=',
    'handle=@profile',
    'handle=a,b',
    `handle=${'a'.repeat(65)}`,
    'handle=profile_handle&extra=value',
  ])
    expect((await read(query)).status).toBe(400);
});

test('profile patch sets and clears links, refuses invalid links and preserves the previous value on refusal', async () => {
  const invalid = [
    null,
    {},
    Array(6).fill(links[0]),
    [{ label: '', url: 'https://example.com' }],
    [{ label: 'a'.repeat(65), url: 'https://example.com' }],
    [{ label: 'Site', url: '/relative' }],
    [{ label: 'Site', url: 'http://example.com' }],
    [{ label: 'Site', url: 'https://user:secret@example.com' }],
    [{ label: 'Site', url: 'https://@example.com' }],
    [{ label: 'Site', url: 'https://example.com/' + 'a'.repeat(2048) }],
    [{ label: 'Site', url: 'https://' }],
    [{ label: 'Site', url: 'https://example.com', extra: true }],
  ];
  for (const value of invalid)
    await expect(
      commands.updateAccount(await context(accountId), { accountId, key: key(), patch: { links: value } }),
    ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect((await read('handle=profile_handle')).body.accounts[0].links).toEqual(links);
  await commands.updateAccount(await context(accountId), { accountId, key: key(), patch: { links: [] } });
  expect((await read('handle=profile_handle')).body.accounts[0].links).toEqual([]);
  const maximum = Array.from({ length: 5 }, (_, i) => ({ label: 'a'.repeat(64), url: `https://example.com/${i}` }));
  await commands.updateAccount(await context(accountId), { accountId, key: key(), patch: { links: maximum } });
  expect((await read('handle=profile_handle')).body.accounts[0].links).toEqual(maximum);
});

test('fencing and deletion erase biography and links, and a deleted handle is unknown', async () => {
  for (const tombstone of [false, true]) {
    const handle = tombstone ? 'deleted_profile' : 'fenced_profile';
    const id = await person(handle);
    await commands.updateAccount(await context(id), {
      accountId: id,
      key: key(),
      patch: { biography: 'Erase me', links },
    });
    if (tombstone) await commands.tombstone(await context(id), { accountId: id, key: key() });
    else await internal.raiseFence({ accountId: id, key: key() });
    const stored = await pool.query('SELECT biography, links FROM access.account WHERE route=$1 AND account_id=$2', [
      routeOf(id),
      id,
    ]);
    expect(stored.rows).toEqual([{ biography: null, links: [] }]);
    const byHandle = await read(`handle=${handle}`);
    if (tombstone) {
      const byIds = await read(`ids=${id}`);
      const unknown = await read('handle=unknown_deleted_profile');
      expect(unknown).toEqual({ status: 200, body: { accounts: [], next: null } });
      expect(byHandle).toEqual(unknown);
      expect(byIds).toEqual({
        status: 200,
        body: {
          accounts: [
            {
              id,
              kind: 'actor',
              state: 'deleted',
              handle: null,
              displayName: null,
              automated: false,
              operatorId: null,
            },
          ],
          next: null,
        },
      });
    } else expect(byHandle.body.accounts[0]).toMatchObject({ bio: null, links: [] });
  }
});
