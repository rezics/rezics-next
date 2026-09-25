import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type CommandEnvelope, type CommandHealth,
  type CommandResult, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const root = resolve(import.meta.dir, '../../..');

class MeteredFusekiClient extends FusekiClient {
  calls = 0;
  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    this.calls++;
    return super.query(sparql, maxResponseBytes);
  }
  override async commandHealth(): Promise<CommandHealth> {
    this.calls++;
    return super.commandHealth();
  }
  override async command(envelope: CommandEnvelope): Promise<CommandResult> {
    this.calls++;
    return super.command(envelope);
  }
}

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

test('VIEW01/VIEW02: Work address claims, renames and dispositions preserve exact identities', async () => {
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
      client_name: 'Address verifier', scope: 'address:claim address:manage',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['address:claim', 'address:manage'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Address native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: 'openid address:claim address:manage',
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
        scope: 'openid address:claim address:manage', state: randomUUID(),
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
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'address.rename',now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'address.dispose',now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    const fuseki = new MeteredFusekiClient(Bun.env.FUSEKI_URL);
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
    const workC = await createWork('C');
    const workD = await createWork('D');
    const workE = await createWork('E');
    const workF = await createWork('F');
    const workG = await createWork('G');
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
    async function assertRelayed(sequence: string, expectedType: string) {
      const consumer = `address-event:${randomUUID()}`;
      await initializeRelayCheckpoint(relayPool, consumer, env.lineage.dataEpoch);
      await relayPool.query('UPDATE relay.checkpoint SET sequence = $2 WHERE consumer = $1',
        [consumer, (BigInt(sequence) - 1n).toString()]);
      expect((await relayMainOutboxOnce(fuseki, relayPool, consumer))?.sequence).toBe(sequence);
      const delivered = await relayPool.query<{ envelope: { type: string } }>(
        'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
        [env.lineage.dataEpoch, sequence]);
      expect(delivered.rows[0]?.envelope.type).toBe(expectedType);
    }
    const rename = (slug: string, newSlug: string, expectedRevision: string,
      key = `rename-${randomUUID()}`, work = workA) => app.handle(new Request(
      'http://main.local/v1/addresses/renames', { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify({ profile: 'work-address-rename-v1',
        work, slug, newSlug, expectedRevision, actingSubject: actor }) }));
    const dispose = (work: string, slug: string, expectedRevision: string,
      operation: 'merge' | 'retire', targetWork?: string,
      key = `dispose-${randomUUID()}`) => app.handle(new Request(
      'http://main.local/v1/addresses/dispositions', { method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'idempotency-key': key }, body: JSON.stringify({
        profile: 'work-address-disposition-v1', work, slug, expectedRevision,
        operation, ...(targetWork ? { targetWork } : {}), actingSubject: actor }) }));
    for (const work of [workA, workB, workC, workD, workE, workF, workG]) {
      const scope = `address:claim:${work}`;
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    fuseki.calls = 0;
    expect((await claim(workA, 'Alpha-Work')).status).toBe(403);
    expect(fuseki.calls).toBeLessThanOrEqual(8);
    for (const work of [workA, workB, workC, workD, workE, workF, workG]) {
      const scope = `address:claim:${work}`;
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,'address.claim',now() + interval '1 hour')`,
      [randomUUID(), actor, scope]);
    }
    const firstKey = `address-first-${randomUUID()}`;
    fuseki.calls = 0;
    const first = await claim(workA, 'Alpha-Work', firstKey);
    expect(first.status).toBe(201);
    expect(fuseki.calls).toBeLessThanOrEqual(8);
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
    fuseki.calls = 0;
    const replay = await claim(workA, 'alpha-work', firstKey);
    expect(replay.status).toBe(200);
    expect(fuseki.calls).toBeLessThanOrEqual(4);
    expect(await replay.json()).toMatchObject({ address: firstBody.address,
      revision: firstBody.revision, work: workA, replayed: true });
    expect((await claim(workA, 'changed-work', firstKey)).status).toBe(409);
    expect((await read('ALPHA-WORK')).status).toBe(200);
    fuseki.calls = 0;
    expect(await (await read('alpha-work')).json()).toMatchObject({
      address: firstBody.address, revision: firstBody.revision,
      work: workA, slug: 'alpha-work' });
    expect(fuseki.calls).toBe(1);
    fuseki.calls = 0;
    expect((await claim(workA, 'another-work-address')).status).toBe(409);
    expect(fuseki.calls).toBeLessThanOrEqual(14);
    expect(await (await read('alpha-work')).json()).toMatchObject({
      address: firstBody.address, work: workA });
    expect((await read('missing-work')).status).toBe(404);
    const raceSlug = `race-${randomUUID().replaceAll('-', '')}`;
    const race = await Promise.all([claim(workB, raceSlug), claim(workC, raceSlug)]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = race[0]!.status === 201 ? workB : workC;
    expect(await (await read(raceSlug)).json()).toMatchObject({ work: winner });
    expect((await claim(workC === winner ? workB : workC, raceSlug)).status).toBe(409);
    const sameWork = await Promise.all([
      claim(workD, `first-${randomUUID().replaceAll('-', '')}`),
      claim(workD, `second-${randomUUID().replaceAll('-', '')}`),
    ]);
    expect(sameWork.map(response => response.status).sort()).toEqual([201, 409]);
    const workDClaim: { slug: string; address: string; revision: string } =
      await sameWork.find(response => response.status === 201)!.json();
    const current = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?route WHERE { GRAPH <urn:rezics:graph:current> {
        ?route a rv:RouteBinding ; rv:routeNamespace "work" ;
          rv:targetWork <${workD}> ; rv:routeState rv:Current . } }`);
    expect(current.results?.bindings).toHaveLength(1);
    const renameScope = `address:rename:${workA}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [renameScope]);
    expect((await rename('alpha-work', 'beta-work', firstBody.revision)).status).toBe(403);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'address.rename',now() + interval '1 hour')`,
    [randomUUID(), actor, renameScope]);
    const renameKey = `rename-first-${randomUUID()}`;
    fuseki.calls = 0;
    const renamed = await rename('Alpha-Work', 'Beta-Work', firstBody.revision, renameKey);
    expect(renamed.status).toBe(201);
    expect(fuseki.calls).toBeLessThanOrEqual(10);
    const renamedBody = await renamed.json() as { address: string; revision: string;
      sourceAddress: string; sourceRevision: string; slug: string; oldSlug: string;
      sourcePosition: { sequence: string } };
    expect(renamedBody).toMatchObject({ oldSlug: 'alpha-work', slug: 'beta-work',
      sourceAddress: firstBody.address });
    fuseki.calls = 0;
    const old = await read('alpha-work');
    expect(old.status).toBe(308);
    expect(fuseki.calls).toBe(2);
    expect(old.headers.get('location')).toBe('/v1/addresses/work/beta-work');
    expect(await old.json()).toMatchObject({ state: 'redirected',
      originalWork: workA, targetWork: workA,
      canonical: { address: renamedBody.address, slug: 'beta-work' } });
    expect(await (await read('beta-work')).json()).toMatchObject({ state: 'current',
      address: renamedBody.address, work: workA });
    fuseki.calls = 0;
    const reverse = await app.handle(new Request(
      `http://main.local/v1/works/${workA.slice(ID.length)}/addresses`));
    expect(reverse.status).toBe(200);
    expect(fuseki.calls).toBe(1);
    expect(await reverse.json()).toMatchObject({ work: workA,
      canonical: { address: renamedBody.address, slug: 'beta-work' } });
    const exact = (slug: string, revision: string) => app.handle(new Request(
      `http://main.local/v1/addresses/work/${slug}/revisions/${revision.slice(ID.length)}`));
    fuseki.calls = 0;
    expect(await (await exact('alpha-work', firstBody.revision)).json()).toMatchObject({
      address: firstBody.address, revision: firstBody.revision,
      state: 'current', work: workA });
    expect(fuseki.calls).toBe(1);
    expect(await (await exact('alpha-work', renamedBody.sourceRevision)).json())
      .toMatchObject({ address: firstBody.address, state: 'redirected',
        redirectWork: workA });
    expect((await exact('alpha-work', renamedBody.revision)).status).toBe(404);
    expect((await rename('alpha-work', 'stale-work', firstBody.revision)).status).toBe(409);
    expect((await rename('alpha-work', 'changed-work', firstBody.revision, renameKey)).status)
      .toBe(409);
    expect((await rename('alpha-work', 'beta-work', firstBody.revision, renameKey)).status)
      .toBe(200);
    const renameConsumer = `view02:${randomUUID()}`;
    await initializeRelayCheckpoint(relayPool, renameConsumer, env.lineage.dataEpoch);
    await relayPool.query('UPDATE relay.checkpoint SET sequence = $2 WHERE consumer = $1',
      [renameConsumer, (BigInt(renamedBody.sourcePosition.sequence) - 1n).toString()]);
    expect((await relayMainOutboxOnce(fuseki, relayPool, renameConsumer))?.sequence)
      .toBe(renamedBody.sourcePosition.sequence);
    const renameEvent = await relayPool.query<{ envelope: { type: string; data: {
      receipt: { sourceAddress: string; newAddress: string; work: string } } } }>(
      'SELECT envelope FROM relay.delivered_event WHERE data_epoch = $1 AND sequence = $2',
      [env.lineage.dataEpoch, renamedBody.sourcePosition.sequence]);
    expect(renameEvent.rows[0]?.envelope).toMatchObject({ type: 'com.rezics.address.renamed.v1',
      data: { receipt: { sourceAddress: firstBody.address,
        newAddress: renamedBody.address, work: workA } } });
    const next = await Promise.all([
      rename('beta-work', 'gamma-work', renamedBody.revision),
      rename('beta-work', 'delta-work', renamedBody.revision),
    ]);
    expect(next.map(response => response.status).sort()).toEqual([201, 409]);
    const winnerResponse = next.find(response => response.status === 201)!;
    const nextBody = await winnerResponse.json() as { slug: string; address: string };
    expect((await read('alpha-work')).headers.get('location'))
      .toBe(`/v1/addresses/work/${nextBody.slug}`);
    expect((await read('beta-work')).headers.get('location'))
      .toBe(`/v1/addresses/work/${nextBody.slug}`);
    expect(await (await exact('alpha-work', firstBody.revision)).json())
      .toMatchObject({ state: 'current', address: firstBody.address });
    const disposeScopes = [workA, workD, workE].map(work => `address:dispose:${work}`);
    for (const scope of disposeScopes) {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    expect((await dispose(workD, workDClaim.slug, workDClaim.revision,
      'merge', winner)).status).toBe(403);
    for (const scope of disposeScopes) {
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,'address.dispose',now() + interval '1 hour')`,
      [randomUUID(), actor, scope]);
    }
    const mergeKey = `merge-${randomUUID()}`;
    const merged = await dispose(workD, workDClaim.slug, workDClaim.revision,
      'merge', winner, mergeKey);
    expect(merged.status).toBe(201);
    const mergedBody = await merged.json() as { sourceAddress: string;
      revision: string; sourcePosition: { sequence: string } };
    expect(mergedBody).toMatchObject({ operation: 'merge',
      sourceAddress: workDClaim.address, targetWork: winner });
    await assertRelayed(mergedBody.sourcePosition.sequence, 'com.rezics.address.merged.v1');
    const mergedRoute = await read(workDClaim.slug);
    expect(mergedRoute.status).toBe(308);
    expect(mergedRoute.headers.get('location')).toBe(`/v1/addresses/work/${raceSlug}`);
    expect(await mergedRoute.json()).toMatchObject({ originalWork: workD,
      targetWork: winner });
    expect(await (await exact(workDClaim.slug, workDClaim.revision)).json())
      .toMatchObject({ state: 'current', work: workD });
    expect(await (await exact(workDClaim.slug, mergedBody.revision)).json())
      .toMatchObject({ state: 'redirected', disposition: 'merged',
        redirectWork: winner, work: workD });
    expect((await dispose(workD, workDClaim.slug, workDClaim.revision,
      'merge', winner, mergeKey)).status).toBe(200);
    expect((await dispose(workD, workDClaim.slug, workDClaim.revision,
      'retire')).status).toBe(409);
    const currentA = await app.handle(new Request(
      `http://main.local/v1/works/${workA.slice(ID.length)}/addresses`));
    const canonicalA = (await currentA.json() as { canonical: { slug: string; revision: string } }).canonical;
    const retired = await dispose(workA, canonicalA.slug, canonicalA.revision, 'retire');
    expect(retired.status).toBe(201);
    const retiredBody = await retired.json() as { revision: string;
      sourcePosition: { sequence: string } };
    await assertRelayed(retiredBody.sourcePosition.sequence, 'com.rezics.address.retired.v1');
    expect((await read(canonicalA.slug)).status).toBe(410);
    expect(await (await exact(canonicalA.slug, retiredBody.revision)).json())
      .toMatchObject({ state: 'retired', disposition: 'retired', work: workA });
    expect(await (await app.handle(new Request(
      `http://main.local/v1/works/${workA.slice(ID.length)}/addresses`))).json())
      .toMatchObject({ work: workA, canonical: null });
    expect((await dispose(workA, canonicalA.slug, canonicalA.revision, 'retire')).status)
      .toBe(409);
    const workESlug = `disposition-${randomUUID().replaceAll('-', '')}`;
    const workEClaim = await claim(workE, workESlug);
    expect(workEClaim.status).toBe(201);
    const workERevision = (await workEClaim.json() as { revision: string }).revision;
    const competing = await Promise.all([
      dispose(workE, workESlug, workERevision, 'merge', winner),
      dispose(workE, workESlug, workERevision, 'retire'),
    ]);
    expect(competing.map(response => response.status).sort()).toEqual([201, 409]);
    const finalE = await read(workESlug);
    expect([308, 410]).toContain(finalE.status);

    const chainScopes = [winner, workF, workG].map(work => `address:dispose:${work}`);
    const renameFScope = `address:rename:${workF}`;
    for (const scope of [...chainScopes, renameFScope]) {
      await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    }
    for (const work of [winner, workF, workG]) {
      await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$2,$3,'address.dispose',now() + interval '1 hour')`,
      [randomUUID(), actor, `address:dispose:${work}`]);
    }
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'address.rename',now() + interval '1 hour')`,
    [randomUUID(), actor, renameFScope]);
    const fSlug = `chain-f-${randomUUID().replaceAll('-', '')}`;
    const gSlug = `chain-g-${randomUUID().replaceAll('-', '')}`;
    const fClaim = await claim(workF, fSlug);
    const gClaim = await claim(workG, gSlug);
    expect([fClaim.status, gClaim.status]).toEqual([201, 201]);
    const fRevision = (await fClaim.json() as { revision: string }).revision;
    const { address: gAddress, revision: gRevision } =
      await gClaim.json() as { address: string; revision: string };
    const winnerRoute = await read(raceSlug);
    const winnerRevision = (await winnerRoute.json() as { revision: string }).revision;
    expect((await dispose(winner, raceSlug, winnerRevision, 'merge', workF)).status).toBe(201);
    const twoHop = await read(workDClaim.slug);
    expect(twoHop.status).toBe(308);
    expect(twoHop.headers.get('location')).toBe(`/v1/addresses/work/${fSlug}`);
    expect(await twoHop.json()).toMatchObject({ address: workDClaim.address,
      originalWork: workD, targetWork: workF });
    const renamedFSlug = `chain-f-new-${randomUUID().replaceAll('-', '')}`;
    const renamedF = await rename(fSlug, renamedFSlug, fRevision,
      `rename-chain-${randomUUID()}`, workF);
    expect(renamedF.status).toBe(201);
    const renamedFRevision = (await renamedF.json() as { revision: string }).revision;
    expect((await read(workDClaim.slug)).headers.get('location'))
      .toBe(`/v1/addresses/work/${renamedFSlug}`);
    expect((await dispose(workF, renamedFSlug, renamedFRevision,
      'merge', workD)).status).toBe(409);
    expect((await dispose(workF, renamedFSlug, renamedFRevision,
      'merge', workG)).status).toBe(201);
    for (const slug of [workDClaim.slug, raceSlug, fSlug]) {
      const chained = await read(slug);
      expect(chained.status).toBe(308);
      expect(chained.headers.get('location')).toBe(`/v1/addresses/work/${gSlug}`);
      expect(await chained.json()).toMatchObject({ targetWork: workG,
        canonical: { address: gAddress, slug: gSlug } });
    }
    expect(await (await exact(workDClaim.slug, mergedBody.revision)).json())
      .toMatchObject({ redirectWork: winner, work: workD });
    expect((await dispose(workG, gSlug, gRevision, 'retire')).status).toBe(201);
    for (const slug of [workDClaim.slug, raceSlug, fSlug, renamedFSlug]) {
      const retiredChain = await read(slug);
      expect(retiredChain.status).toBe(410);
      expect(await retiredChain.json()).toMatchObject({ state: 'retired' });
    }
  } finally {
    await account.stop();
    await Promise.all([accountPool.end(), accessPool.end(), relayPool.end()]);
    rmSync(state, { recursive: true, force: true });
  }
}, 180_000);
