import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('VIEW01: concurrent normalized Work slug claims have one stable native target', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE
    || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `address-api-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  try {
    async function signUp(name: string) {
      const email = `address-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await account.handle(new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { user: { id: string } };
      return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
    }
    const operator = await signUp('operator');
    operators.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const verifier = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Address verifier', scope: 'address:claim',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['address:claim'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Address native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: 'openid address:claim',
      skip_consent: true, require_pkce: true } });
    async function tokenFor(user: { email: string; password: string }) {
      const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signIn.status).toBe(200);
      const challengeSecret = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: client.client_id, redirect_uri: redirectUri,
        scope: 'openid address:claim', state: randomUUID(),
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(challengeSecret).digest('base64url'),
        code_challenge_method: 'S256',
      })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, {
        headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: client.client_id, code, redirect_uri: redirectUri,
          code_verifier: challengeSecret, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    }
    const editor = await signUp('editor');
    const token = await tokenFor(editor);
    const actor = ID + randomUUID();
    const principalId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3)`,
    [principalId, `${base}/api/auth`, editor.id]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind)
      VALUES ($1,'agent')`, [actor]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'address.claim',now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const env: WorkActivationEnvironment = { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: join(state, 'objects') };
    function admission(title: string): RegisteredAdmission {
      const id = randomUUID();
      return { id, principalId, actingSubject: actor, scope: 'work:create:root',
        action: 'work.create', idempotencyKey: `address-work-${id}`,
        requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
        expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), state: 'claimed',
        dispatchEligible: true, replayed: false };
    }
    async function createWork(name: string) {
      const title = `Address ${name} ${randomUUID()}`;
      const result = await activateMetadataWork(env, { title, admission: admission(title) });
      if (!result.work) throw new Error('Work activation failed');
      return result.work;
    }
    const workA = await createWork('A');
    const workB = await createWork('B');
    const access = new AccessAdmissionRegistry(accessPool);
    const app = createMainApp(fuseki, { environment: env,
      account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
        audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
        introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: verifier.client_id, clientSecret: verifier.client_secret! }),
      access });
    const claim = (work: string, slug: string, key = `address-${randomUUID()}`) =>
      app.handle(new Request('http://main.local/v1/addresses/claims', {
        method: 'POST', headers: { authorization: `Bearer ${token}`,
          'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ profile: 'work-address-claim-v1', work, slug,
          actingSubject: actor }),
      }));
    const read = (slug: string) => app.handle(new Request(
      `http://main.local/v1/addresses/work/${slug}`));
    for (const work of [workA, workB]) {
      const scope = `address:claim:${work}`;
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    expect((await claim(workA, 'Alpha-Work')).status).toBe(403);
    for (const work of [workA, workB]) {
      const scope = `address:claim:${work}`;
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,'address.claim',now() + interval '1 hour')`,
      [randomUUID(), actor, scope]);
    }
    const firstKey = `address-first-${randomUUID()}`;
    const first = await claim(workA, 'Alpha-Work', firstKey);
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { address: string; revision: string;
      slug: string; work: string; replayed: boolean; sourcePosition: { sequence: string } };
    expect(firstBody).toMatchObject({ slug: 'alpha-work', work: workA, replayed: false });
    const consumer = `view01:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, consumer, env.lineage.dataEpoch);
    await relayPool.query('UPDATE relay.checkpoint SET sequence = $2 WHERE consumer = $1',
      [consumer, (BigInt(firstBody.sourcePosition.sequence) - 1n).toString()]);
    expect((await relayMainOutboxOnce(fuseki, relayPool, consumer))?.sequence)
      .toBe(firstBody.sourcePosition.sequence);
    const delivered = await relayPool.query<{ envelope: { type: string; data: {
      receipt: { action: string; routeBinding: string; routeRevision: string;
        normalizedSlug: string; work: string } } } }>(`SELECT envelope
      FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2`,
    [env.lineage.dataEpoch, firstBody.sourcePosition.sequence]);
    expect(delivered.rows[0]?.envelope).toMatchObject({ type: 'com.rezics.address.claimed.v1',
      data: { receipt: { action: 'address.claim', routeBinding: firstBody.address,
        routeRevision: firstBody.revision, normalizedSlug: 'alpha-work', work: workA } } });
    const replay = await claim(workA, 'alpha-work', firstKey);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ address: firstBody.address,
      revision: firstBody.revision, work: workA, replayed: true });
    expect((await claim(workA, 'changed-work', firstKey)).status).toBe(409);
    expect((await read('ALPHA-WORK')).status).toBe(200);
    expect(await (await read('alpha-work')).json()).toMatchObject({
      address: firstBody.address, revision: firstBody.revision,
      work: workA, slug: 'alpha-work' });
    expect((await read('missing-work')).status).toBe(404);
    const raceSlug = `race-${randomUUID().replaceAll('-', '')}`;
    const race = await Promise.all([claim(workA, raceSlug), claim(workB, raceSlug)]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = race[0]!.status === 201 ? workA : workB;
    expect(await (await read(raceSlug)).json()).toMatchObject({ work: winner });
    expect((await claim(workB === winner ? workA : workB, raceSlug)).status).toBe(409);
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end(), relayPool.end()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
