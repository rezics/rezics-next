import { expect, test } from 'bun:test';
import { makeSignature } from 'better-auth/crypto';
import type { Pool } from 'pg';
import { consentApi } from '../src/consent.ts';
import type { AccountAuth } from '../src/http.ts';
import { describeScope } from '../src/scope-descriptions.ts';

const origin = 'https://accounts.rezics.test';
const secret = 'library-consent-fixture-signing-secret';
const redirect = 'https://reader.rezics.test/callback';

async function signedQuery(scopes: readonly string[]) {
  const query = new URLSearchParams({
    client_id: 'reader',
    scope: scopes.join(' '),
    redirect_uri: redirect,
    state: 'library-consent',
    exp: String(Math.floor(Date.now() / 1000) + 60),
  });
  const canonical = new URLSearchParams(
    [...query.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ).toString();
  query.set('sig', await makeSignature(canonical, secret));
  return query.toString();
}

function fixture(installedScopes: readonly string[], firstParty = false) {
  const writes: string[] = [];
  const decisions: unknown[] = [];
  const claims: { statements: string[]; released: boolean }[] = [];
  const query = async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM public.rezics_oauth_installation')) {
      const requested = params[1] as string[];
      return {
        rows: [
          {
            id: 'installation',
            covers: requested.every((scope) => installedScopes.includes(scope)),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM "oauthClient"')) {
      return {
        rows: [
          {
            name: 'Reader',
            uri: null,
            icon: null,
            disabled: false,
            redirectUris: [redirect],
            firstParty,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) writes.push(sql);
    if (sql.includes('rezics_account_pending_consent'))
      return { rows: [{ id: 'pending' }], rowCount: 1 };
    throw new Error('unexpected consent storage operation');
  };
  const pool = {
    query,
    connect: async () => {
      const claim = { statements: [] as string[], released: false };
      claims.push(claim);
      return {
        query: async (sql: string) => {
          claim.statements.push(sql);
          if (
            sql === 'BEGIN' ||
            sql === 'COMMIT' ||
            sql === 'ROLLBACK' ||
            sql.startsWith('SET LOCAL ')
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (
            sql.includes('FROM rezics_account_security') ||
            sql.includes('UPDATE rezics_account_pending_consent')
          ) {
            return { rows: [{ id: 'pending' }], rowCount: 1 };
          }
          throw new Error(`unexpected consent connection operation: ${sql}`);
        },
        release() {
          claim.released = true;
        },
      };
    },
  } as unknown as Pool;
  const auth = {
    options: { baseURL: origin },
    $context: Promise.resolve({ secret }),
    api: {
      getSession: async () => ({ user: { id: 'reader-user' }, session: { id: 'reader-session' } }),
    },
    handler: async (request: Request) => {
      decisions.push(await request.json());
      return Response.json({ redirect: true, url: redirect });
    },
  } as unknown as AccountAuth;
  const app = consentApi(auth, pool);
  return {
    writes,
    decisions,
    claims,
    read: (query: string) =>
      app.handle(
        new Request(`${origin}/api/account/consent?${new URLSearchParams({ oauth_query: query })}`),
      ),
    decide: (query: string, accept: boolean, scope?: string) =>
      app.handle(
        new Request(`${origin}/api/account/consent`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({
            oauth_query: query,
            accept,
            ...(scope === undefined ? {} : { scope }),
          }),
        }),
      ),
  };
}

for (const firstParty of [false, true]) {
  test(`${firstParty ? 'first-party' : 'third-party'} consent exposes the complete library mutation description`, async () => {
    const scopes = ['openid', 'work:read', 'library:write'];
    const flow = fixture(scopes, firstParty);
    const query = await signedQuery(scopes);
    const response = await flow.read(query);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scopes.map((item: { scope: string }) => item.scope)).toEqual(scopes);
    expect(body.scopes.find((item: { scope: string }) => item.scope === 'library:write')).toEqual(
      describeScope('library:write'),
    );
    expect((await flow.decide(query, true)).status).toBe(200);
    expect(flow.decisions).toEqual([
      { oauth_query: query, accept: true, ...(firstParty ? {} : { scope: scopes.join(' ') }) },
    ]);
  });
}

test('a read-only installation still refuses a signed library mutation request before pending-consent writes', async () => {
  const flow = fixture(['openid', 'work:read']);
  const query = await signedQuery(['openid', 'work:read', 'library:write']);
  expect((await flow.read(query)).status).toBe(409);
  expect((await flow.decide(query, true)).status).toBe(409);
  expect(flow.writes).toEqual([]);
  expect(flow.decisions).toEqual([]);
});

test('existing read-only requests stay read-only even when installation permits mutation', async () => {
  const flow = fixture(['openid', 'work:read', 'library:write']);
  const query = await signedQuery(['openid', 'work:read']);
  const response = await flow.read(query);
  expect(response.status).toBe(200);
  expect((await response.json()).scopes.map((item: { scope: string }) => item.scope)).toEqual([
    'openid',
    'work:read',
  ]);
  expect((await flow.decide(query, true)).status).toBe(200);
  expect(flow.decisions).toEqual([{ oauth_query: query, accept: true, scope: 'openid work:read' }]);
  expect(flow.writes.every((sql) => sql.includes('rezics_account_pending_consent'))).toBe(true);
});

test('mutation consent cannot be injected into a signed read-only request', async () => {
  const flow = fixture(['openid', 'work:read', 'library:write']);
  const query = await signedQuery(['openid', 'work:read']);
  const response = await flow.decide(query, true, 'openid work:read library:write');
  expect(response.status).toBe(400);
  expect(flow.decisions).toEqual([]);
  expect(flow.writes.some((sql) => sql.startsWith('UPDATE'))).toBe(false);
});

test('selecting only reads from a mutation request preserves the narrower consent', async () => {
  const flow = fixture(['openid', 'work:read', 'library:write']);
  const query = await signedQuery(['openid', 'work:read', 'library:write']);
  expect((await flow.decide(query, true, 'openid work:read')).status).toBe(200);
  expect(flow.decisions).toEqual([{ oauth_query: query, accept: true, scope: 'openid work:read' }]);
});

test('a consent decision claims its pending row on a checked-out connection', async () => {
  const flow = fixture(['openid', 'library:write']);
  const query = await signedQuery(['openid', 'library:write']);
  expect((await flow.decide(query, true)).status).toBe(200);
  expect(
    flow.claims.map((claim) => ({
      released: claim.released,
      statements: claim.statements.map((sql) => sql.replace(/\s+/g, ' ').trim()),
    })),
  ).toEqual([
    {
      released: true,
      statements: [
        'BEGIN',
        "SET LOCAL lock_timeout = '2s'",
        "SET LOCAL statement_timeout = '5s'",
        'SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR SHARE',
        'UPDATE rezics_account_pending_consent SET decided_at = now() WHERE id = $1 AND session_id = $2 AND decided_at IS NULL AND expires_at > now() RETURNING id',
        'COMMIT',
      ],
    },
  ]);
});

test('refusing a library mutation request forwards refusal without granting a scope', async () => {
  const flow = fixture(['openid', 'library:write']);
  const query = await signedQuery(['openid', 'library:write']);
  expect((await flow.decide(query, false)).status).toBe(200);
  expect(flow.decisions).toEqual([{ oauth_query: query, accept: false }]);
});

test('adding mutation scope to the signed query invalidates its signature', async () => {
  const flow = fixture(['openid', 'work:read', 'library:write']);
  const query = new URLSearchParams(await signedQuery(['openid', 'work:read']));
  query.set('scope', 'openid work:read library:write');
  expect((await flow.read(query.toString())).status).toBe(409);
  expect(flow.writes).toEqual([]);
});
