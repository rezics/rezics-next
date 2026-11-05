import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount, type AuthService } from '../src/index.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

const issuer = 'https://inventory.auth.test';
const prefix = randomUUID();
const web = `${prefix}-web`;
const person = randomUUID();
const other = randomUUID();
const password = 'inventory fixture correct horse battery staple';
const accounts = new Map<string, AccessAccount>();
let fixture: ReturnType<typeof testDatabase> | undefined;
let database: Pool;
let service: AuthService;
let cookie: string;
let otherCookie: string;
let unavailable = false;
let clockOffset = 0;
const owned = Array.from({ length: 23 }, (_, i) => `${prefix}-owned-${String(i).padStart(2, '0')}`);
const foreign = `${prefix}-foreign`;

function headers(session = cookie) {
  return new Headers({ origin: issuer, cookie: session, 'content-type': 'application/json' });
}
function request(path: string, session = cookie, additions: Record<string, string> = {}) {
  const h = headers(session);
  for (const [key, value] of Object.entries(additions)) h.set(key, value);
  return service.handler(new Request(`${issuer}${path}`, { headers: h }));
}
async function signin(accountId: string) {
  const response = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: headers(''),
      body: JSON.stringify({ account_id: accountId, password, client_id: web, scope: ['read'] }),
    }),
  );
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url, max: 1 });
  const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: prefix };
  service = await createAuthService({
    database,
    issuer,
    audience: 'https://inventory.api.test',
    secret: 'inventory-fixture-persistent-secret-at-least-32-bytes',
    clock: () => new Date(Date.now() + clockOffset),
    signing: { activeKid: prefix, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        if (unavailable) throw new Error('Current account authority unavailable');
        return accounts.get(id) ?? null;
      },
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async authorizeProvisioning(accountId) {
        return { accountId };
      },
    }),
  });
  await service.internal.registerClient({ clientId: web, firstParty: true, scopes: ['read'], displayName: 'Login' });
  for (const id of [person, other]) {
    const account: AccessAccount = { accountId: id, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false };
    accounts.set(id, account);
    await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    account.state = 'active';
  }
  cookie = await signin(person);
  otherCookie = await signin(other);
  for (const clientId of [...owned, foreign]) {
    await service.internal.registerClient({
      clientId,
      firstParty: false,
      scopes: ['read', 'write'],
      displayName: 'Application',
    });
    await database.query(
      `UPDATE auth_client SET "userId"=$2,"clientSecret"='never disclose',contacts='["private@example.test"]',
         metadata='{"private":"never disclose"}',"referenceId"='not ownership',disabled=$3 WHERE client_id=$1`,
      [clientId, clientId === foreign ? other : person, clientId === owned[1]],
    );
  }
  // Deployment and organization pointers must never synthesize ownership.
  await database.query('UPDATE auth_client SET "referenceId"=$2 WHERE client_id=$1', [web, person]);
  await database.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes) VALUES
       ($1,$3,ARRAY['read','write','old']),($2,$4,ARRAY['write'])`,
    [person, other, owned[0], foreign],
  );
}, 60000);
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

test('the live authenticated account can page its actual owned OAuth clients and granted consents for security and deletion preflight without secrets foreign ownership pending-scope escalation or invented zero', async () => {
  const first = await request('/clients');
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toBe('private, no-store');
  const page = await first.json();
  expect(Object.keys(page).sort()).toEqual(['clients', 'next']);
  expect(page.clients).toHaveLength(20);
  expect(page.clients.map((row: { client_id: string }) => row.client_id)).toEqual(owned.slice(0, 20));
  expect(page.clients[0]).toEqual({
    client_id: owned[0],
    display_name: 'Application',
    disabled: false,
    scopes: ['read', 'write'],
  });
  expect(page.clients[1].disabled).toBe(true);
  expect(typeof page.next).toBe('string');
  expect(page.next).not.toContain(owned[19]);
  const last = await (await request(`/clients?cursor=${encodeURIComponent(page.next)}`)).json();
  expect(last.clients.map((row: { client_id: string }) => row.client_id)).toEqual(owned.slice(20));
  expect(last.next).toBeNull();
  expect((await (await request('/clients?limit=100')).json()).clients).toHaveLength(23);
  expect(await service.security.listClients({ headers: headers(otherCookie) })).toEqual({
    clients: [{ client_id: foreign, display_name: 'Application', disabled: false, scopes: ['read', 'write'] }],
    next: null,
  });
  const consents = await service.security.listConsents({ headers: headers(), limit: 1 });
  expect(consents.consents).toEqual([
    {
      client_id: owned[0]!,
      display_name: 'Application',
      granted: ['read', 'write'],
      status: 'current',
      reducible: true,
      pending_reduction: false,
    },
  ]);
  expect(consents.next).not.toBeNull();
  const standing = await (await request(`/consents?limit=1&cursor=${encodeURIComponent(consents.next!)}`)).json();
  expect(standing).toEqual({
    consents: [
      {
        client_id: web,
        display_name: 'Login',
        granted: ['read'],
        status: 'current',
        reducible: false,
        pending_reduction: false,
      },
    ],
    next: null,
  });
  expect(JSON.stringify([page, last, consents, standing])).not.toMatch(
    /never disclose|private@example|clientSecret|referenceId|contacts|metadata|token|cookie/,
  );
});

test('cursor account session view limit integrity and exact route/query isolation fail closed', async () => {
  const page = await (await request('/clients?limit=1')).json();
  const token: string = page.next;
  for (const [path, session] of [
    [`/clients?limit=1&cursor=${token}`, otherCookie],
    [`/consents?limit=1&cursor=${token}`, cookie],
    [`/clients?limit=2&cursor=${token}`, cookie],
    [`/clients?limit=1&cursor=${token.slice(0, 20)}${token[20] === 'A' ? 'B' : 'A'}${token.slice(21)}`, cookie],
    ['/clients?cursor=guessed-client-id', cookie],
    ['/clients?limit=0', cookie],
    ['/clients?limit=101', cookie],
    ['/clients?limit=1&limit=1', cookie],
    ['/clients?limit=', cookie],
    ['/consents?cursor=', cookie],
    ['/clients?owner=someone', cookie],
    [`/clients?accountId=${person}`, cookie],
    [`/consents?client_id=${foreign}`, cookie],
    ['/sessions?limit=1', cookie],
    ['/passkeys?cursor=x', cookie],
    [`/consent/${owned[0]}?limit=1`, cookie],
  ]) {
    const response = await request(path!, session);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'authentication_denied' });
  }
  const replacement = await signin(person);
  expect((await request(`/clients?limit=1&cursor=${token}`, replacement)).status).toBe(400);
  clockOffset = 901_000;
  try {
    expect((await request(`/clients?limit=1&cursor=${token}`)).status).toBe(400);
  } finally {
    clockOffset = 0;
  }
  expect(
    (await service.handler(new Request(`https://foreign.auth.test/clients?limit=1`, { headers: headers() }))).status,
  ).toBe(400);
  expect((await request('/clients/', cookie)).status).toBe(404);
  await expect(service.security.listClients({ headers: headers(), accountId: other } as never)).rejects.toMatchObject({
    status: 400,
  });
  await expect(service.security.listConsents({ headers: headers(), limit: 101 })).rejects.toMatchObject({
    status: 400,
  });
});

test('pending reduction intersects stored current client scopes and distinguishes unavailable native records', async () => {
  const id = owned[0]!;
  const read = async () =>
    (await service.security.listConsents({ headers: headers() })).consents.find((row) => row.client_id === id)!;
  await database.query(
    `UPDATE auth_consent SET pending_scopes=ARRAY['read','new'],pending_reference='pending' WHERE account_id=$1 AND client_id=$2`,
    [person, id],
  );
  expect(await read()).toMatchObject({ granted: ['read'], status: 'current', pending_reduction: true });
  await database.query(`UPDATE auth_consent SET pending_scopes=ARRAY[]::text[] WHERE account_id=$1 AND client_id=$2`, [
    person,
    id,
  ]);
  expect(await read()).toMatchObject({ granted: [], status: 'inactive', pending_reduction: true });
  await database.query(
    `UPDATE auth_consent SET pending_scopes=NULL,pending_reference=NULL WHERE account_id=$1 AND client_id=$2`,
    [person, id],
  );
  await database.query('UPDATE auth_client SET disabled=true WHERE client_id=$1', [id]);
  expect(await read()).toMatchObject({ granted: [], status: 'unavailable', reducible: false });
  await database.query('UPDATE auth_client SET disabled=false WHERE client_id=$1', [id]);
  await database.query('UPDATE auth_client_coverage SET ready=false WHERE client_id=$1', [id]);
  expect(await read()).toMatchObject({ granted: [], status: 'unavailable' });
  await database.query('UPDATE auth_client_coverage SET ready=true WHERE client_id=$1', [id]);
  await database.query(
    'INSERT INTO auth_client_reduction (client_id,operation_id,scopes,first_party) VALUES ($1,$2,ARRAY[]::text[],false)',
    [id, randomUUID()],
  );
  expect(await read()).toMatchObject({ granted: [], status: 'unavailable', pending_reduction: true });
  await database.query('DELETE FROM auth_client_reduction WHERE client_id=$1', [id]);
  await database.query('UPDATE auth_client SET erasure_fenced=true WHERE client_id=$1', [id]);
  expect(await read()).toEqual({
    client_id: id,
    display_name: null,
    granted: [],
    status: 'unavailable',
    reducible: false,
    pending_reduction: false,
  });
  await database.query('UPDATE auth_client SET erasure_fenced=false WHERE client_id=$1', [id]);
});

test('native session account epoch consent fence and origin denial or unavailable never invent an empty inventory', async () => {
  for (const path of ['/clients', '/consents']) {
    expect((await request(path, '')).status).toBe(401);
    expect((await request(path, cookie, { origin: 'https://other.test' })).status).toBe(403);
    expect((await request(path, cookie, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const account = accounts.get(person)!;
    for (const change of [{ automated: true }, { fenced: true }, { state: 'deleted' }, { authnEpoch: 2 }]) {
      const before = { ...account };
      Object.assign(account, change);
      try {
        expect((await request(path)).status).toBe(401);
      } finally {
        Object.assign(account, before);
        delete account.fenced;
      }
    }
    unavailable = true;
    try {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({ error: 'authentication_denied' });
    } finally {
      unavailable = false;
    }
  }
  await database.query('UPDATE auth_client SET disabled=true WHERE client_id=$1', [web]);
  try {
    expect((await request('/clients')).status).toBe(401);
  } finally {
    await database.query('UPDATE auth_client SET disabled=false WHERE client_id=$1', [web]);
  }
  await database.query(
    `UPDATE auth_consent SET pending_scopes=ARRAY[]::text[],pending_reference='pending' WHERE account_id=$1 AND client_id=$2`,
    [person, web],
  );
  try {
    expect((await request('/consents')).status).toBe(401);
  } finally {
    await database.query(
      'UPDATE auth_consent SET pending_scopes=NULL,pending_reference=NULL WHERE account_id=$1 AND client_id=$2',
      [person, web],
    );
  }
});
