import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { AuthenticationError, type Access, type AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  readPublicAccount,
  readPublicIdentities,
  readPublicIdentityObservations,
  type PublicIdentity,
} from '../../src/access/account-data.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const route = 0x4567;
const identity = {
  first: newId(route),
  second: newId(route),
  pending: newId(route),
  deleted: newId(route),
  deletedOrganization: newId(route),
  suspended: newId(route),
  organization: newId(route),
  automation: newId(route),
  operator: newId(route),
  renamed: newId(route),
};
const batchIds = Array.from({ length: 100 }, () => newId(route));
const actor: AccountActor = {
  kind: 'account',
  accountId: identity.operator,
  clientId: 'web',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const access: Access = {
  async authenticate(token) {
    if (token !== 'identity-reader') throw new AuthenticationError(401, 'Bearer error="invalid_token"');
    return actor;
  },
  async authorize() {
    return true;
  },
};
const kernel = createKernel({ pool, access, routeKey: new Uint8Array(32).fill(13) });

type Body = { accounts: PublicIdentity[]; code?: string };

async function seed(): Promise<void> {
  const rows = [
    {
      id: identity.first,
      kind: 'actor',
      handle: 'first',
      displayName: 'First Person',
      state: 'active',
      operator: null,
    },
    {
      id: identity.second,
      kind: 'actor',
      handle: 'second',
      displayName: 'Second Person',
      state: 'active',
      operator: null,
    },
    {
      id: identity.pending,
      kind: 'actor',
      handle: 'pending',
      displayName: 'Pending Person',
      state: 'pending',
      operator: null,
    },
    {
      id: identity.deleted,
      kind: 'actor',
      handle: 'deleted',
      displayName: 'Deleted Person',
      state: 'active',
      operator: null,
    },
    {
      id: identity.deletedOrganization,
      kind: 'organization',
      handle: 'deleted_group',
      displayName: 'Deleted Group',
      state: 'active',
      operator: null,
    },
    {
      id: identity.suspended,
      kind: 'actor',
      handle: 'suspended',
      displayName: 'Suspended Person',
      state: 'active',
      operator: null,
    },
    {
      id: identity.organization,
      kind: 'organization',
      handle: 'open_group',
      displayName: 'Open Group',
      state: 'active',
      operator: null,
    },
    {
      id: identity.automation,
      kind: 'actor',
      handle: 'helper_bot',
      displayName: 'Helper Bot',
      state: 'active',
      operator: identity.operator,
    },
    {
      id: identity.operator,
      kind: 'actor',
      handle: 'operator',
      displayName: 'Operator',
      state: 'active',
      operator: null,
    },
    {
      id: identity.renamed,
      kind: 'actor',
      handle: 'before_rename',
      displayName: 'Before Rename',
      state: 'active',
      operator: null,
    },
    ...batchIds.map((id, index) => ({
      id,
      kind: 'actor',
      handle: `batch_${index}`,
      displayName: `Batch ${index}`,
      state: 'active',
      operator: null,
    })),
  ];
  await admin.query(
    `INSERT INTO access.account(route, account_id, kind, handle, display_name, state, operator_account_id, transaction_id)
     SELECT $1, input.account_id, input.kind, input.handle, input.display_name, input.state,
            input.operator_account_id, input.account_id
     FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::uuid[])
       AS input(account_id, kind, handle, display_name, state, operator_account_id)`,
    [
      route,
      rows.map(({ id }) => id),
      rows.map(({ kind }) => kind),
      rows.map(({ handle }) => handle),
      rows.map(({ displayName }) => displayName),
      rows.map(({ state }) => (state === 'suspended' ? 'active' : state)),
      rows.map(({ operator }) => operator),
    ],
  );
  await suspendAccount(admin, identity.suspended);
  await suspendAccount(admin, identity.suspended);
  await admin.query(
    `UPDATE access.account SET state = 'deleted', handle = NULL, display_name = NULL
     WHERE route = $1 AND account_id = ANY($2::uuid[])`,
    [route, [identity.deleted, identity.deletedOrganization]],
  );
}

beforeAll(seed);
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function request(path: string, authenticated = false): Promise<{ response: Response; body: Body }> {
  const response = await kernel.handle(
    new Request(`https://kernel.test${path}`, {
      headers: authenticated ? { authorization: 'Bearer identity-reader' } : {},
    }),
  );
  const body = (await response.json()) as Body;
  if (response.status === 503) throw new Error(JSON.stringify(body));
  return { response, body };
}

function identities(ids: readonly string[]): string {
  return `/v1/accounts?ids=${encodeURIComponent(ids.join(','))}`;
}

test('the public batch returns visible identities in first-request order and hides lifecycle details', async () => {
  const unknown = newId(route);
  const requested = [
    identity.second,
    identity.deleted,
    identity.deletedOrganization,
    identity.pending,
    unknown,
    identity.first,
    identity.second,
    identity.suspended,
    identity.organization,
    identity.automation,
  ];
  const { response, body } = await request(identities(requested));
  expect(response.status).toBe(200);
  expect(body.accounts).toEqual([
    {
      id: identity.second,
      kind: 'actor',
      handle: 'second',
      displayName: 'Second Person',
      state: 'active',
      automated: false,
      operatorId: null,
    },
    {
      id: identity.deleted,
      kind: 'actor',
      state: 'deleted',
    },
    {
      id: identity.deletedOrganization,
      kind: 'organization',
      state: 'deleted',
    },
    {
      id: identity.first,
      kind: 'actor',
      handle: 'first',
      displayName: 'First Person',
      state: 'active',
      automated: false,
      operatorId: null,
    },
    {
      id: identity.suspended,
      kind: 'actor',
      handle: 'suspended',
      displayName: 'Suspended Person',
      state: 'active',
      automated: false,
      operatorId: null,
    },
    {
      id: identity.organization,
      kind: 'organization',
      handle: 'open_group',
      displayName: 'Open Group',
      state: 'active',
      automated: false,
      operatorId: null,
    },
    {
      id: identity.automation,
      kind: 'actor',
      handle: 'helper_bot',
      displayName: 'Helper Bot',
      state: 'active',
      automated: true,
      operatorId: identity.operator,
    },
  ]);
  expect(response.headers.get('cache-control')).toBe('no-cache');
  expect(response.headers.get('etag')).toMatch(/^"[A-Za-z0-9_-]+"$/);
  const observations = await readPublicIdentityObservations(pool, requested);
  expect(observations.map(({ id }) => id)).toEqual(
    requested.filter((id) => id !== identity.pending && id !== unknown),
  );
  expect(observations.filter(({ state }) => state === 'deleted')).toEqual([
    { id: identity.deleted, kind: 'actor', state: 'deleted' },
    { id: identity.deletedOrganization, kind: 'organization', state: 'deleted' },
  ]);
});

test('the public identity names no private field for any kind and hides the operator of a deleted account', async () => {
  const { body } = await request(
    identities([
      identity.first,
      identity.organization,
      identity.automation,
      identity.deleted,
      identity.deletedOrganization,
    ]),
  );
  for (const account of body.accounts)
    expect(Object.keys(account).sort()).toEqual(
      account.state === 'deleted'
        ? ['id', 'kind', 'state']
        : ['automated', 'displayName', 'handle', 'id', 'kind', 'operatorId', 'state'],
    );

  const operated = newId(route);
  await admin.query(
    `INSERT INTO access.account(route, account_id, kind, handle, display_name, state, operator_account_id, transaction_id)
     VALUES ($1, $2, 'actor', 'doomed_bot', 'Doomed Bot', 'active', $3, $2)`,
    [route, operated, identity.operator],
  );
  await admin.query(
    `UPDATE access.account SET state = 'deleted', handle = NULL, display_name = NULL
     WHERE route = $1 AND account_id = $2`,
    [route, operated],
  );
  const { body: tombstone } = await request(identities([operated]));
  expect(tombstone.accounts).toEqual([
    {
      id: operated,
      kind: 'actor',
      state: 'deleted',
    },
  ]);
});

test('deleted actor and organization point and batch reads stop at the account row', async () => {
  const expected: PublicIdentity[] = [
    { id: identity.deletedOrganization, kind: 'organization', state: 'deleted' },
    { id: identity.deleted, kind: 'actor', state: 'deleted' },
  ];
  const query = spyOn(pool, 'query');
  try {
    for (const { id, kind } of expected) {
      query.mockClear();
      expect(await readPublicAccount(pool, route, id)).toEqual({ accountId: id, kind, state: 'deleted' });
      expect(query).toHaveBeenCalledTimes(1);
    }
    query.mockClear();
    expect(
      await readPublicIdentities(
        pool,
        [route, route],
        expected.map(({ id }) => id),
      ),
    ).toEqual(expected);
    expect(query).toHaveBeenCalledTimes(1);
  } finally {
    query.mockRestore();
  }
});

test('anonymous and authenticated callers receive the same public identity', async () => {
  const path = identities([identity.first, identity.deleted, identity.suspended]);
  const anonymous = await request(path);
  const authenticated = await request(path, true);
  expect(anonymous.response.status).toBe(200);
  expect(authenticated.response.status).toBe(200);
  expect(authenticated.body).toEqual(anonymous.body);
  expect(authenticated.response.headers.get('etag')).toBe(anonymous.response.headers.get('etag'));
});

test('the next read sees a handle and display name change', async () => {
  const path = identities([identity.renamed]);
  const before = await request(path);
  const nativeBefore = await readPublicIdentityObservations(pool, [identity.renamed]);
  expect(before.body.accounts).toEqual([
    {
      id: identity.renamed,
      kind: 'actor',
      handle: 'before_rename',
      displayName: 'Before Rename',
      state: 'active',
      automated: false,
      operatorId: null,
    },
  ]);
  await admin.query(
    `UPDATE access.account SET handle = 'after_rename', display_name = 'After Rename'
     WHERE route = $1 AND account_id = $2`,
    [route, identity.renamed],
  );
  const after = await request(path);
  const nativeAfter = await readPublicIdentityObservations(pool, [identity.renamed]);
  expect(nativeAfter).not.toEqual(nativeBefore);
  expect(after.body.accounts).toEqual([
    {
      id: identity.renamed,
      kind: 'actor',
      handle: 'after_rename',
      displayName: 'After Rename',
      state: 'active',
      automated: false,
      operatorId: null,
    },
  ]);
  expect(after.response.headers.get('etag')).not.toBe(before.response.headers.get('etag'));
});

test('the request accepts one to one hundred IDs and rejects malformed or unknown query input', async () => {
  const invalid = [
    '/v1/accounts',
    '/v1/accounts?ids=',
    identities(Array.from({ length: 101 }, () => identity.first)),
    '/v1/accounts?ids=not-a-uuid',
    `/v1/accounts?ids=${identity.first.toUpperCase()}`,
    `${identities([identity.first])}&other=value`,
  ];
  for (const path of invalid) {
    const { response, body } = await request(path);
    expect([response.status, body.code]).toEqual([400, 'invalid_request']);
  }

  const { response, body } = await request(identities(batchIds));
  expect(response.status).toBe(200);
  expect(body.accounts).toHaveLength(100);
  expect(body.accounts.map(({ id }) => id)).toEqual(batchIds);
  expect(await readPublicIdentityObservations(pool, batchIds)).toHaveLength(100);
});

test('the observation validates before SQL and deduplicates native seeks by route', async () => {
  const query = spyOn(pool, 'query');
  try {
    await Promise.all(
      [[], Array.from({ length: 101 }, () => identity.first), ['not-a-uuid']].map((ids) =>
        expect(readPublicIdentityObservations(pool, ids)).rejects.toMatchObject({ code: 'invalid_request' }),
      ),
    );
    expect(query).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
  }

  const otherRoute = route + 1;
  const other = newId(otherRoute);
  await admin.query(
    "INSERT INTO access.account(route,account_id,kind,handle,display_name,state,transaction_id) VALUES ($1,$2,'actor','other_route','Other Route','active',$2)",
    [otherRoute, other],
  );
  const batch = spyOn(pool, 'query');
  try {
    const routed = [identity.first, identity.second, other, identity.first];
    expect((await readPublicIdentityObservations(pool, routed)).map(({ id }) => id)).toEqual(
      routed,
    );
    expect(batch).toHaveBeenCalledTimes(2);
  } finally {
    batch.mockRestore();
  }
});

test('an account ID array derives each exact route from UUID bytes 10 and 11', () => {
  expect(batchIds.every((id) => routeOf(id) === route)).toBe(true);
});
