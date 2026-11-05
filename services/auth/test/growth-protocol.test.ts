import { expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  WEBSITE_CLIENT_ID,
  type AccessAccount,
  type AuthService,
  type AuthServiceOptions,
  type PublicJwks,
} from '../src/index.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';
import {
  capture,
  checkGrowth,
  GrowthBoundError,
  openGrowthDatabase,
  type GrowthCheck,
} from '../../kernel/test/support/growth.ts';

const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const population = 512;
const scopes = ['media:complete', 'media:read', 'offline_access', 'openid'];
const password = 'protocol growth native password';
const hash = (text: string) => createHash('sha256').update(text).digest('base64url');
type Probe = { owner: string; session: string; cookie: string; verifier: string; code: string };
type Tokens = { refresh_token: string; access_token: string; id_token: string };

async function fixture() {
  const postgres = testDatabase();
  const db = await openGrowthDatabase(postgres.url);
  const accounts = new Map<string, AccessAccount>();
  const invalidations: string[] = [];
  let dispatch: (request: Request) => Promise<Response>;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => dispatch(request) });
  const issuer = `http://127.0.0.1:${server.port}`;
  const audience = 'https://protocol-growth.api.test';
  const redirect = `${issuer}/website/callback`;
  const signing = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'issuer',
  };
  const clientKey = await generateKeyPair('ES256', { extractable: true });
  const options: AuthServiceOptions = {
    database: db.pool,
    issuer,
    audience,
    secret: 'protocol-growth-secret-at-least-32-bytes',
    signing: { activeKid: signing.kid, privateKeys: [signing] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        return accounts.get(id) ?? null;
      },
      async authorizeProvisioning(accountId) {
        return { accountId };
      },
      async invalidateAccount({ accountId, previousEpoch }) {
        const account = accounts.get(accountId)!;
        expect(account.authnEpoch).toBe(previousEpoch);
        account.authnEpoch++;
        invalidations.push(accountId);
        return { accountId, minimumAuthnEpoch: account.authnEpoch, receiptId: randomUUID() };
      },
    }),
  };
  const service = await createAuthService(options);
  dispatch = (request) => service.handler(request);
  await service.internal.registerWebsiteClient({
    publicJwks: {
      keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: 'client', alg: 'ES256', use: 'sig' }],
    } as PublicJwks,
    redirectUris: [redirect],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes,
  });
  await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: ['media:read'] });

  function request(path: string | URL, init?: RequestInit, native = service) {
    // Native hint verification fetches the real JWKS route over loopback. Bind
    // that server dispatch to this capture so its SQL belongs to the request.
    dispatch = AsyncResource.bind((incoming: Request) => native.handler(incoming));
    return native.handler(new Request(new URL(path, issuer), init));
  }
  async function confidential(path: string, fields: Record<string, string>) {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'client' })
      .setIssuer(WEBSITE_CLIENT_ID)
      .setSubject(WEBSITE_CLIENT_ID)
      .setAudience(issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(randomUUID())
      .sign(clientKey.privateKey);
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: WEBSITE_CLIENT_ID,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        resource: audience,
        ...fields,
      }),
    });
  }
  async function probe(): Promise<Probe> {
    const owner = randomUUID();
    const account: AccessAccount = {
      accountId: owner,
      kind: 'actor',
      state: 'pending',
      automated: false,
      authnEpoch: 1,
    };
    accounts.set(owner, account);
    await service.internal.provisionPassword({ authorization: owner, email: `${owner}@growth.test`, password });
    account.state = 'active';
    const login = await request('/signin', {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: owner, password, client_id: 'login', scope: ['media:read'] }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const session = (await db.admin.query('SELECT id FROM session WHERE "userId"=$1', [owner])).rows[0].id as string;
    return { owner, session, cookie, verifier: randomBytes(48).toString('base64url'), code: '' };
  }
  async function authorize(probe: Probe) {
    const url = new URL(`${issuer}/authorize`);
    const state = randomBytes(24).toString('base64url');
    url.search = new URLSearchParams({
      client_id: WEBSITE_CLIENT_ID,
      redirect_uri: redirect,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      code_challenge: hash(probe.verifier),
      code_challenge_method: 'S256',
      resource: audience,
    }).toString();
    const response = await request(url, { headers: { cookie: probe.cookie } });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(redirect);
    expect(location.searchParams.get('state')).toBe(state);
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();
    probe.code = code!;
  }
  async function exchange(probe: Probe): Promise<Tokens> {
    const response = await confidential('/token', {
      grant_type: 'authorization_code',
      code: probe.code,
      redirect_uri: redirect,
      code_verifier: probe.verifier,
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as Tokens;
    for (const value of Object.values(tokens)) expect(value).toBeTruthy();
    expect(typeof tokens.refresh_token).toBe('string');
    expect(typeof tokens.access_token).toBe('string');
    expect(typeof tokens.id_token).toBe('string');
    return tokens;
  }

  // Grow native client/session/grant partitions, plus other owners and clients.
  // All growing relations start with a full 512-row page. The signing slots and
  // generation are bounded configuration; only their cold archive grows.
  async function grow(scale: number, previous: number) {
    const range = [previous * population + 1, scale * population];
    await db.admin.query(
      `INSERT INTO auth_client (client_id,first_party,scopes)
      SELECT 'client-'||i,false,ARRAY['media:read'] FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO auth_client_coverage (client_id,ready)
      SELECT 'client-'||i,true FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO auth_client_reduction (client_id,operation_id,scopes,first_party)
      SELECT 'client-'||i,'reduction-'||i,ARRAY['media:read'],false FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO "user" (id,name,"emailVerified")
      SELECT 'owner-'||i,'',false FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO session (id,token,"userId","clientId","createdAt","updatedAt","expiresAt","grantedScope","authnEpoch","authTime","authMethods")
      SELECT p||i,p||i,'owner-'||i,CASE WHEN p='same-client-' THEN 'login' ELSE 'client-'||i END,
      now(),now(),CASE WHEN i%2=0 THEN now()-interval '1 day' ELSE now()+interval '1 day' END,
      'media:read',1,extract(epoch FROM now())::int,'pwd'
      FROM generate_series($1::int,$2::int) i CROSS JOIN unnest(ARRAY['same-client-','other-client-']) p`,
      range,
    );
    await db.admin.query(
      `INSERT INTO auth_consent (account_id,client_id,scopes)
      SELECT 'owner-'||i,c,ARRAY['media:read'] FROM generate_series($1::int,$2::int) i
      CROSS JOIN LATERAL unnest(ARRAY[$3,'client-'||i]) c`,
      [...range, WEBSITE_CLIENT_ID],
    );
    await db.admin.query(
      `INSERT INTO "oauthResource" (id,identifier,name,"allowedScopes")
      SELECT 'resource-'||i,'https://resource.test/'||i,'History','["media:read"]'::jsonb FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO "oauthClientResource" (id,"clientId","resourceId")
      SELECT 'link-'||i,'client-'||i,'https://resource.test/'||i FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO "oauthClientAssertion" (id,"expiresAt")
      SELECT 'assertion-'||i,now()+interval '1 day' FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO auth_recent_oidc_session (session_id,account_id,expires_at)
      SELECT 'recent-'||i,'owner-'||i,now()+interval '10 minutes' FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO auth_signing_key_archive (kid,private_jwk)
      SELECT 'archived-'||i,$3::jsonb || jsonb_build_object('kid','archived-'||i) FROM generate_series($1::int,$2::int) i`,
      [...range, signing],
    );
    await history('unrelated', 'owner-', 'same-client-', null, scale, previous);
    await history('other-partition', 'owner-', 'other-client-', null, scale, previous, true);
  }

  // Family members keep distinct refresh IDs: revoking one token has one
  // directly affected access row, independent of the rest of its family.
  async function history(
    tag: string,
    owner: string,
    session: string,
    family: string | null,
    scale: number,
    previous = 0,
    otherClient = false,
  ) {
    const client = otherClient ? null : WEBSITE_CLIENT_ID;
    const range = [previous * population + 1, scale * population, tag, owner, session, family, client];
    await db.admin.query(
      `INSERT INTO "oauthRefreshFamily" (id,"clientId",revoked,sequence,"expiresAt")
      SELECT $3||'-family-'||i,COALESCE($4,'client-'||i),i%2=0,1,now()+interval '1 day' FROM generate_series($1::int,$2::int) i`,
      [range[0], range[1], tag, client],
    );
    await db.admin.query(
      `INSERT INTO "oauthRefreshToken" (id,token,"clientId","userId","sessionId","authorizationCodeId","expiresAt","createdAt",revoked,"rotatedAt",scopes)
      SELECT $3||'-refresh-'||i,$3||'-hash-'||i,COALESCE($7,'client-'||i),CASE WHEN $4='owner-' THEN $4||i ELSE $4 END,
      CASE WHEN $4='owner-' THEN $5||i ELSE $5 END,COALESCE($6,$3||'-family-'||i),
      now()+interval '1 day',now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour','["openid","offline_access","media:read"]'::jsonb
      FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO "oauthAccessToken" (id,token,"clientId","userId","sessionId","authorizationCodeId","refreshId","expiresAt","createdAt",scopes)
      SELECT $3||'-access-'||i,$3||'-access-hash-'||i,COALESCE($7,'client-'||i),CASE WHEN $4='owner-' THEN $4||i ELSE $4 END,
      CASE WHEN $4='owner-' THEN $5||i ELSE $5 END,COALESCE($6,$3||'-family-'||i),$3||'-refresh-'||i,
      now()+interval '1 day',now(),'["openid","media:read"]'::jsonb FROM generate_series($1::int,$2::int) i`,
      range,
    );
    await db.admin.query(
      `INSERT INTO verification (id,identifier,value,"expiresAt","createdAt")
      SELECT $3||'-code-'||i,$3||'-code-hash-'||i,
      jsonb_build_object('userId',CASE WHEN $4='owner-' THEN $4||i ELSE $4 END,'sessionId',CASE WHEN $4='owner-' THEN $5||i ELSE $5 END,
      'query',jsonb_build_object('client_id',COALESCE($6,'client-'||i),'scope','openid offline_access media:read','redirect_uri',$7::text,'resource',$8::text))::text,
      now()+interval '2 minutes',now() FROM generate_series($1::int,$2::int) i`,
      [range[0], range[1], tag, owner, session, client, redirect, audience],
    );
  }

  async function ownGrants(probe: Probe, scale: number) {
    await db.admin.query(
      `INSERT INTO auth_consent (account_id,client_id,scopes)
      SELECT $1,'client-'||i,ARRAY['media:read'] FROM generate_series(1,$2::int) i`,
      [probe.owner, scale * population],
    );
    // The native owner cap is 64. Keep its full admitted neighborhood fixed;
    // total live/expired sessions and the client partition grow in grow().
    await db.admin.query(
      `INSERT INTO session (id,token,"userId","clientId","createdAt","updatedAt","expiresAt","grantedScope","authnEpoch","authTime","authMethods")
      SELECT $1||'-old-'||i,$1||'-old-'||i,$1,'login',now()-interval '1 day',now(),now()-interval '1 hour',
      'media:read',1,extract(epoch FROM now())::int,'pwd' FROM generate_series(1,63) i`,
      [probe.owner],
    );
  }

  async function check(check: GrowthCheck) {
    try {
      const report = await checkGrowth(db, check);
      console.info(check.name, JSON.stringify(report.samples));
      for (const { cost } of report.samples) {
        expect(cost.statements).toBeGreaterThan(0);
        for (const relation of [
          'session',
          'auth_client',
          'auth_consent',
          'verification',
          'oauthRefreshToken',
          'oauthRefreshFamily',
        ])
          expect(cost.relations[`public.${relation}`]?.sequentialScans ?? 0, relation).toBe(0);
      }
    } catch (error) {
      if (error instanceof GrowthBoundError) {
        // One unused equivalent probe remains for a diagnostic capture after
        // the series, preserving the failing SQL and executed plan together.
        const diagnostic = await capture(db, () => check.operation(db, 64, 0));
        console.error(
          check.name,
          JSON.stringify({
            samples: error.samples,
            sql: diagnostic.capture.statements,
            plans: diagnostic.capture.plans,
          }),
        );
      }
      throw error;
    }
  }
  return {
    db,
    service,
    options,
    issuer,
    request,
    confidential,
    probe,
    authorize,
    exchange,
    grow,
    history,
    ownGrants,
    check,
    invalidations,
    async close() {
      await server.stop(true);
      await db.close();
      postgres.close();
    },
  };
}

test('Authorize stays within its bound as client, session and grant history grows', async () => {
  const f = await fixture();
  try {
    let probes: Probe[] = [];
    await f.check({
      name: 'Authorize with native session and proof',
      bounds,
      repetitions: 3,
      async grow(_, scale, previous) {
        await f.grow(scale, previous);
        probes = [];
        for (let i = 0; i < 5; i++) {
          const probe = await f.probe();
          await f.ownGrants(probe, scale);
          probes.push(probe);
        }
      },
      async operation() {
        await f.authorize(probes.shift()!);
      },
    });
  } finally {
    await f.close();
  }
  const discovery = await fixture();
  try {
    let cold: AuthService[] = [];
    // Startup is outside capture; every metadata sample is the deployment's
    // first native request, including its deferred provider initialization.
    await discovery.check({
      name: 'Cold discovery metadata and signing',
      bounds,
      repetitions: 3,
      async grow(_, scale, previous) {
        await discovery.grow(scale, previous);
        cold = [];
        for (let i = 0; i < 5; i++) cold.push(await createAuthService(discovery.options));
      },
      async operation() {
        const native = cold.shift()!;
        for (const path of ['/.well-known/openid-configuration', '/.well-known/oauth-authorization-server']) {
          const response = await discovery.request(path, undefined, native);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ issuer: discovery.issuer, scopes_supported: scopes });
        }
        const jwks = await discovery.request('/.well-known/jwks.json', undefined, native);
        expect(jwks.status).toBe(200);
        expect((await jwks.json()).keys).toHaveLength(1);
      },
    });
  } finally {
    await discovery.close();
  }
}, 180000);

test('Authorization code exchange stays within its bound as code and token family history grows', async () => {
  const f = await fixture();
  try {
    let probes: Probe[] = [];
    await f.check({
      name: 'Authorization code token exchange with confidential admission',
      bounds,
      repetitions: 3,
      async grow(_, scale, previous) {
        await f.grow(scale, previous);
        probes = [];
        for (let i = 0; i < 5; i++) {
          const probe = await f.probe();
          await f.authorize(probe);
          await f.ownGrants(probe, scale);
          await f.history(probe.owner, probe.owner, probe.session, null, scale);
          probes.push(probe);
        }
      },
      async operation() {
        const probe = probes.shift()!;
        const tokens = await f.exchange(probe);
        expect(
          (await f.db.admin.query('SELECT 1 FROM verification WHERE identifier=$1', [hash(probe.code)])).rowCount,
        ).toBe(0);
        const row = (
          await f.db.admin.query('SELECT "sessionId","authorizationCodeId" FROM "oauthRefreshToken" WHERE token=$1', [
            hash(tokens.refresh_token),
          ])
        ).rows[0];
        expect(row).toMatchObject({ sessionId: probe.session, authorizationCodeId: hash(probe.code) });
      },
    });
  } finally {
    await f.close();
  }
}, 180000);

test('Token revocation and logout stay within their bound as token family and session history grows', async () => {
  // Separate databases keep either endpoint's large population from masking the
  // other's first-scale plan. Both the refresh and signed access branches run.
  for (const operation of ['refresh revocation', 'access revocation', 'logout'] as const) {
    const f = await fixture();
    try {
      let probes: { probe: Probe; tokens: Tokens }[] = [];
      await f.check({
        name: operation,
        bounds,
        repetitions: 3,
        async grow(_, scale, previous) {
          await f.grow(scale, previous);
          probes = [];
          for (let i = 0; i < 5; i++) {
            const probe = await f.probe();
            await f.authorize(probe);
            const tokens = await f.exchange(probe);
            await f.ownGrants(probe, scale);
            await f.history(probe.owner, probe.owner, probe.session, hash(probe.code), scale);
            await f.history(`${probe.owner}-siblings`, probe.owner, probe.session, null, scale);
            probes.push({ probe, tokens });
          }
        },
        async operation() {
          const { probe, tokens } = probes.shift()!;
          const before = f.invalidations.length;
          if (operation === 'logout') {
            const fields = new URLSearchParams({
              client_id: WEBSITE_CLIENT_ID,
              id_token_hint: tokens.id_token,
              post_logout_redirect_uri: `${f.issuer}/`,
              state: 'complete',
            });
            const response = await f.request(`/logout?${fields}`, { headers: { cookie: probe.cookie } });
            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe(`${f.issuer}/?state=complete`);
            expect(response.headers.getSetCookie().some((value) => /session_token=;.*Max-Age=0/.test(value))).toBe(
              true,
            );
            expect((await f.db.admin.query('SELECT 1 FROM session WHERE id=$1', [probe.session])).rowCount).toBe(0);
          } else {
            const refresh = operation === 'refresh revocation';
            const response = await f.confidential('/revoke', {
              token: refresh ? tokens.refresh_token : tokens.access_token,
              token_type_hint: refresh ? 'refresh_token' : 'access_token',
            });
            expect(response.status).toBe(200);
            if (refresh)
              expect(
                (await f.db.admin.query('SELECT revoked FROM "oauthRefreshFamily" WHERE id=$1', [hash(probe.code)]))
                  .rows[0].revoked,
              ).toBe(true);
          }
          expect(f.invalidations.slice(before)).toEqual([probe.owner]);
        },
      });
    } finally {
      await f.close();
    }
  }
}, 480000);
