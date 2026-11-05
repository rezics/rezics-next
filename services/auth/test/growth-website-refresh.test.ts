import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, WEBSITE_CLIENT_ID, type AccessAccount, type AuthService } from '../src/index.ts';
import type { PublicJwks } from '../src/index.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';

const issuer = 'https://refresh-growth.auth.test';
const audience = 'https://refresh-growth.api.test';
const redirectUri = `${issuer}/website/callback`;
const password = 'correct horse battery staple';
const person = '00000000-0000-7000-8000-123400000071';
const scopes = ['openid', 'offline_access', 'media:read', 'media:complete'];
const perScale = 512;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
let fixture: ReturnType<typeof testDatabase>;
let db: GrowthDatabase;
let service: AuthService;
let clientKey: Awaited<ReturnType<typeof generateKeyPair>>;
const account: AccessAccount = { accountId: person, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false };
let family = '';
let session = '';
let current = '';
let warmupCurrent = '';
let warmupReplayed = '';
let warmupFamily = '';

beforeAll(async () => {
  // This file owns its migrated database and issuer deployment.
  fixture = testDatabase();
  db = await openGrowthDatabase(fixture.url);
  const signing = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)) };
  clientKey = await generateKeyPair('ES256', { extractable: true });
  service = await createAuthService({
    database: db.pool,
    issuer,
    audience,
    secret: 'refresh-growth-secret-with-at-least-32-bytes',
    signing: { activeKid: 'refresh-growth-signing', privateKeys: [{ ...signing, kid: 'refresh-growth-signing' }] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount(accountId) {
        return accountId === person ? { ...account } : null;
      },
      async authorizeProvisioning(accountId) {
        return { accountId };
      },
      async invalidateAccount({ accountId, previousEpoch }) {
        expect(previousEpoch).toBe(account.authnEpoch);
        account.authnEpoch++;
        return { accountId, minimumAuthnEpoch: account.authnEpoch, receiptId: `floor-${account.authnEpoch}` };
      },
    }),
  });
  await service.internal.registerWebsiteClient({
    publicJwks: {
      keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: 'refresh-growth-client', alg: 'ES256', use: 'sig' }],
    } as PublicJwks,
    redirectUris: [redirectUri],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes,
  });
  await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: ['media:read'] });
  await service.internal.provisionPassword({ authorization: person, email: 'refresh@growth.test', password });
  account.state = 'active';
  const primary = await issueRefreshToken(await signInCookie());
  current = primary.token;
  family = primary.family;
  session = primary.session;
  const spare = await issueRefreshToken(await signInCookie());
  warmupCurrent = spare.token;
}, 60000);

afterAll(async () => {
  await db?.close();
  fixture?.close();
}, 60000);

async function token(fields: Record<string, string>) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'refresh-growth-client' })
    .setIssuer(WEBSITE_CLIENT_ID)
    .setSubject(WEBSITE_CLIENT_ID)
    .setAudience(issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomBytes(24).toString('base64url'))
    .sign(clientKey.privateKey);
  return service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: WEBSITE_CLIENT_ID,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        resource: audience,
        ...fields,
      }),
    }),
  );
}

async function signInCookie() {
  const login = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'refresh@growth.test', password, client_id: 'login', scope: ['media:read'] }),
    }),
  );
  expect(login.status).toBe(200);
  return login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function issueRefreshToken(cookie: string) {
  const verifier = randomBytes(48).toString('base64url');
  const authorize = new URL(`${issuer}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: WEBSITE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state: randomBytes(24).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: audience,
  }).toString();
  const authorization = await service.handler(new Request(authorize, { headers: { cookie } }));
  const code = new URL(authorization.headers.get('location')!).searchParams.get('code')!;
  const exchange = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  expect(exchange.status).toBe(200);
  const refresh = (await exchange.json()).refresh_token as string;
  const row = (
    await db.admin.query('SELECT "authorizationCodeId","sessionId" FROM "oauthRefreshToken" WHERE token=$1', [
      createHash('sha256').update(refresh).digest('base64url'),
    ])
  ).rows[0];
  return { token: refresh, family: row.authorizationCodeId as string, session: row.sessionId as string };
}

/**
 * One seed for both operations. The measured family's own rotated history,
 * other families of the same person and client, and other people's families
 * grow independently of the measured request.
 */
async function seed(prefix: string, database: GrowthDatabase, scale: number, previous: number) {
  const range = [previous * perScale + 1, scale * perScale, prefix];
  await database.admin.query(
    `INSERT INTO "oauthRefreshToken" (id,token,"clientId","userId","sessionId","authorizationCodeId","expiresAt","createdAt",revoked,"rotatedAt",scopes)
     SELECT $3||'history-'||i,$3||'history-hash-'||i,$4,$5,$6,$7,now()+interval '1 day',now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour','["openid","offline_access"]'::jsonb
     FROM generate_series($1::int,$2::int) i`,
    [...range, WEBSITE_CLIENT_ID, person, session, family],
  );
  await database.admin.query(
    `INSERT INTO "oauthRefreshFamily" (id,"clientId",revoked,sequence,"expiresAt")
     SELECT $3||'sibling-family-'||i,$4,false,1,now()+interval '1 day' FROM generate_series($1::int,$2::int) i`,
    [...range, WEBSITE_CLIENT_ID],
  );
  await database.admin.query(
    `INSERT INTO "oauthRefreshToken" (id,token,"clientId","userId","sessionId","authorizationCodeId","expiresAt","createdAt",scopes)
     SELECT $3||'sibling-'||i,$3||'sibling-hash-'||i,$4,$5,$6,$3||'sibling-family-'||i,now()+interval '1 day',now(),'["openid","offline_access"]'::jsonb
     FROM generate_series($1::int,$2::int) i`,
    [...range, WEBSITE_CLIENT_ID, person, session],
  );
  await database.admin.query(
    `INSERT INTO "user" (id,name,"emailVerified") SELECT $3||'unrelated-'||i,'',false FROM generate_series($1::int,$2::int) i`,
    range,
  );
  await database.admin.query(
    `INSERT INTO "oauthRefreshFamily" (id,"clientId",revoked,sequence,"expiresAt")
     SELECT $3||'unrelated-family-'||i,$4,i % 2 = 0,1,now()+interval '1 day' FROM generate_series($1::int,$2::int) i`,
    [...range, WEBSITE_CLIENT_ID],
  );
  await database.admin.query(
    `INSERT INTO "oauthRefreshToken" (id,token,"clientId","userId","authorizationCodeId","expiresAt","createdAt",scopes)
     SELECT $3||'unrelated-'||i,$3||'unrelated-hash-'||i,$4,$3||'unrelated-'||i,$3||'unrelated-family-'||i,now()+interval '1 day',now(),'["openid","offline_access"]'::jsonb
     FROM generate_series($1::int,$2::int) i`,
    [...range, WEBSITE_CLIENT_ID],
  );
  for (const table of ['"oauthRefreshToken"', '"oauthRefreshFamily"', '"user"'])
    await database.admin.query(`VACUUM (ANALYZE) ${table}`);
}

test('checkGrowth keeps website refresh rotation constant as family history and unrelated tokens grow', async () => {
  const report = await checkGrowth(db, {
    name: 'website refresh rotation',
    bounds,
    grow: (database, scale, previous) => seed('rotation-', database, scale, previous),
    async operation() {
      const response = await token({ grant_type: 'refresh_token', refresh_token: current });
      expect(response.status).toBe(200);
      current = (await response.json()).refresh_token;
    },
    async warmup() {
      const response = await token({ grant_type: 'refresh_token', refresh_token: warmupCurrent });
      expect(response.status).toBe(200);
      warmupCurrent = (await response.json()).refresh_token;
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeLessThan(60);
    expect(sample.cost.relations?.['public.oauthRefreshToken']?.sequentialScans ?? 0).toBe(0);
    expect(sample.cost.relations?.['public.oauthRefreshFamily']?.sequentialScans ?? 0).toBe(0);
  }
  console.info('Website refresh rotation growth:', JSON.stringify(report.samples));
}, 180000);

test('checkGrowth keeps website refresh replay revocation constant without walking family history', async () => {
  let replayed = '';
  const report = await checkGrowth(db, {
    name: 'website refresh replay',
    bounds,
    repetitions: 1,
    async grow(database, scale, previous) {
      // Each scale replays a parent of a fresh, active rotation: rotate once,
      // then reactivate the family and Access epoch through the seed pool only.
      await seed('replay-', database, scale, previous);
      await database.admin.query('UPDATE "oauthRefreshFamily" SET revoked=false WHERE id=$1', [family]);
      await database.admin.query('UPDATE session SET "authnEpoch"=$2 WHERE id=$1', [session, account.authnEpoch]);
      replayed = current;
      const rotated = await token({ grant_type: 'refresh_token', refresh_token: replayed });
      expect(rotated.status).toBe(200);
      current = (await rotated.json()).refresh_token;
      const warmup = await issueRefreshToken(await signInCookie());
      warmupFamily = warmup.family;
      warmupReplayed = warmup.token;
      const warmupRotated = await token({ grant_type: 'refresh_token', refresh_token: warmupReplayed });
      expect(warmupRotated.status).toBe(200);
      warmupCurrent = (await warmupRotated.json()).refresh_token;
    },
    async operation() {
      const replay = await token({ grant_type: 'refresh_token', refresh_token: replayed });
      expect(replay.status).toBeGreaterThanOrEqual(400);
      expect(
        (await db.admin.query('SELECT revoked FROM "oauthRefreshFamily" WHERE id=$1', [family])).rows[0].revoked,
      ).toBe(true);
    },
    async warmup() {
      const replay = await token({ grant_type: 'refresh_token', refresh_token: warmupReplayed });
      expect(replay.status).toBeGreaterThanOrEqual(400);
      expect(
        (await db.admin.query('SELECT revoked FROM "oauthRefreshFamily" WHERE id=$1', [warmupFamily])).rows[0].revoked,
      ).toBe(true);
      // The spare replay advances the account floor; keep the measured session current.
      await db.admin.query('UPDATE session SET "authnEpoch"=$2 WHERE id=$1', [session, account.authnEpoch]);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
  for (const sample of report.samples) {
    expect(sample.cost.relations?.['public.oauthRefreshToken']?.sequentialScans ?? 0).toBe(0);
    expect(sample.cost.relations?.['public.oauthRefreshToken']?.rows ?? 0).toBeLessThan(10);
  }
  // The rotated child is unusable after its parent's replay.
  expect((await token({ grant_type: 'refresh_token', refresh_token: current })).status).toBeGreaterThanOrEqual(400);
  console.info('Website refresh replay growth:', JSON.stringify(report.samples));
}, 180000);
