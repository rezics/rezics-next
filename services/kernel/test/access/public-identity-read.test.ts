import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { AuthenticationError, type Access, type AccountActor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';

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

type Identity = {
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
  state: 'active' | 'deleted';
  automated: boolean;
  operatorId: string | null;
};
type Body = { accounts: Identity[]; code?: string };

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
     WHERE route = $1 AND account_id = $2`,
    [route, identity.deleted],
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
  const requested = [
    identity.second,
    identity.deleted,
    identity.pending,
    newId(route),
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
      handle: null,
      displayName: null,
      state: 'deleted',
      automated: false,
      operatorId: null,
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
});

test('the public identity names no private field for any kind and hides the operator of a deleted account', async () => {
  const { body } = await request(
    identities([identity.first, identity.organization, identity.automation, identity.deleted]),
  );
  for (const account of body.accounts)
    expect(Object.keys(account).sort()).toEqual([
      'automated',
      'displayName',
      'handle',
      'id',
      'kind',
      'operatorId',
      'state',
    ]);

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
      handle: null,
      displayName: null,
      state: 'deleted',
      automated: false,
      operatorId: null,
    },
  ]);
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
});

test('an account ID array derives each exact route from UUID bytes 10 and 11', () => {
  expect(batchIds.every((id) => routeOf(id) === route)).toBe(true);
});
