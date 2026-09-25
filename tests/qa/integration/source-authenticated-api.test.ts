import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { OpenLibraryConversionStore }
  from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { OpenLibrarySourceGraph }
  from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { SourceNativeWorkProposalStore }
  from '../../../services/main/src/modules/source/native-work-proposal.ts';
import { SourceNativeWorkAdoptionStore }
  from '../../../services/main/src/modules/source/native-work-adoption.ts';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('IAM10/LIVE01/LIVE02/LIVE13: real Account and Access fence source staging and title-only adoption', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_DATABASE_URL
    || !Bun.env.ACCOUNT_MAIN_RESOURCE || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const server = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  try {
    const signUp = async (name: string) => {
      const email = `source-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Source Main verifier', scope: 'source:intake',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['source:intake'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const allowed = 'openid source:intake source:acquire source:convert source:propose source:adopt source:read work:create';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Source API client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: allowed,
      skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const principalId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1, $2, $3)`,
    [principalId, `${base}/api/auth`, member.id]);
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: member.email, password: member.password }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!;
    const tokenFor = async (scope: string) => {
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: client.client_id, redirect_uri: redirectUri, scope,
        state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchanged = await fetch(`${base}/api/auth/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: client.client_id, code, redirect_uri: redirectUri,
          code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }),
      });
      expect(exchanged.status).toBe(200);
      return (await exchanged.json() as { access_token: string }).access_token;
    };
    const fullToken = await tokenFor(allowed);
    const readToken = await tokenFor('openid source:read');
    const sourceAdoptToken = await tokenFor('openid source:adopt source:read');
    await migrateContent(contentPool);
    const sourceIntake = new SourceIntakeStore(contentPool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const sourceConversions = new OpenLibraryConversionStore(contentPool, sourceIntake);
    const sourceGraph = new OpenLibrarySourceGraph(fuseki,
      { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      sourceConversions);
    const sourceProposals = new SourceNativeWorkProposalStore(contentPool, sourceGraph,
      sourceConversions);
    let failNextBinding = false;
    const bindingFaultPool = new Proxy(contentPool, { get(target, property) {
      if (property === 'query') return (query: string, values: unknown[]) => {
        if (failNextBinding && query.includes('INSERT INTO source.native_work_binding')) {
          failNextBinding = false;
          throw new Error('injected post-graph binding write failure');
        }
        return target.query(query, values);
      };
      return Reflect.get(target, property, target);
    } }) as Pool;
    const mainAccount = new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    const mainAccess = new AccessAdmissionRegistry(accessPool);
    const environment = { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: `.temp/source-auth-${randomUUID()}` };
    let fetches = 0;
    const app = createMainApp(fuseki, {
      environment,
      account: mainAccount,
      access: mainAccess, sourceIntake,
      sourceConversions, sourceGraph,
      sourceProposals,
      sourceAdoptions: new SourceNativeWorkAdoptionStore(bindingFaultPool, sourceProposals,
        environment, mainAccount, mainAccess),
      openLibraryFetch: (async (url: string) => {
        fetches++;
        const workId = url.split('/').at(-1)!.slice(0, -5);
        return new Response(JSON.stringify({ key: `/works/${workId}`,
          type: { key: '/type/work' }, title: 'Source title', revision: 1,
          description: { value: 'Source-only expression' },
          authors: [{ author: { key: '/authors/OL1A' } }], subjects: ['Source term'] }),
        { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const call = (method: string, path: string, token: string, body?: object,
      key = `source-${randomUUID()}`) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const manual = { profile: 'source-manual-intake-v1', provider: 'example',
      namespace: 'work', externalId: `OL-${randomUUID()}`, sourceRevision: null,
      mediaType: 'application/json', retention: 'retained',
      rawBytesBase64: Buffer.from('{"count":0}').toString('base64'),
      coverage: { scope: 'manual-response-v1', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: '' } };
    const before = await contentPool.query('SELECT id FROM source.observation WHERE principal_id = $1',
      [principalId]);
    expect((await call('POST', '/v1/sources/intakes', readToken, manual)).status).toBe(401);
    expect((await contentPool.query('SELECT id FROM source.observation WHERE principal_id = $1',
      [principalId])).rowCount).toBe(before.rowCount);
    const staged = await call('POST', '/v1/sources/intakes', fullToken, manual);
    expect(staged.status).toBe(201);
    expect((await call('POST', '/v1/sources/acquisitions/open-library/works',
      readToken, { profile: 'open-library-work-acquisition-v1', workId: 'OL45804W' })).status)
      .toBe(401);
    expect(fetches).toBe(0);
    const acquired = await call('POST', '/v1/sources/acquisitions/open-library/works',
      fullToken, { profile: 'open-library-work-acquisition-v1', workId: 'OL45804W' });
    expect(acquired.status).toBe(201);
    expect(fetches).toBe(1);
    const observationId = (await acquired.json() as { observation: { observation: string } })
      .observation.observation.split('/').at(-1)!;
    expect((await call('POST',
      `/v1/sources/observations/${observationId}/conversions/open-library-work`,
      readToken, { profile: 'open-library-work-map-v1' })).status).toBe(401);
    expect((await contentPool.query('SELECT id FROM source.conversion WHERE principal_id = $1',
      [principalId])).rowCount).toBe(0);
    const converted = await call('POST',
      `/v1/sources/observations/${observationId}/conversions/open-library-work`,
      fullToken, { profile: 'open-library-work-map-v1' });
    expect(converted.status).toBe(201);
    const conversionId = (await converted.json() as { conversion: { conversion: string } })
      .conversion.conversion.split('/').at(-1)!;
    expect((await call('GET', `/v1/sources/observations/${observationId}`, readToken)).status)
      .toBe(200);
    expect((await call('GET', `/v1/sources/conversions/${conversionId}`, readToken)).status)
      .toBe(200);
    const proposalPath = `/v1/sources/conversions/${conversionId}/proposals/native-work`;
    const proposalBody = { profile: 'open-library-native-work-proposal-v1' };
    expect((await call('POST', proposalPath, readToken, proposalBody)).status).toBe(401);
    expect((await call('POST', proposalPath, fullToken, proposalBody)).status).toBe(409);
    expect((await contentPool.query('SELECT id FROM source.native_work_proposal WHERE principal_id = $1',
      [principalId])).rowCount).toBe(0);
    expect((await call('POST', `/v1/sources/conversions/${conversionId}/source-graph`,
      readToken, { profile: 'source-open-library-work-v1' })).status).toBe(401);
    expect((await call('POST', `/v1/sources/conversions/${conversionId}/source-graph`,
      fullToken, { profile: 'source-open-library-work-v1' })).status).toBe(200);
    const proposalResponse = await call('POST', proposalPath, fullToken, proposalBody);
    expect(proposalResponse.status).toBe(201);
    const proposal = (await proposalResponse.json() as { proposal: {
      proposal: string; candidateTitle: string; rightsStatus: string } }).proposal;
    expect(proposal).toMatchObject({ candidateTitle: 'Source title',
      rightsStatus: 'undetermined' });
    const proposalId = proposal.proposal.split('/').at(-1)!;
    expect((await call('GET', `/v1/sources/proposals/${proposalId}`, readToken)).status)
      .toBe(200);
    const actor = `https://rezics.com/id/${randomUUID()}`;
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')",
      [actor]);
    const adoptionPath = `/v1/sources/proposals/${proposalId}/adoption/native-work`;
    const adoptionBody = { profile: 'source-native-work-adoption-v1',
      actingSubject: actor, confirmedTitle: 'Source title', titleLanguage: 'en' };
    await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ('work:create:root')
      ON CONFLICT DO NOTHING`);
    expect((await call('POST', adoptionPath, readToken, adoptionBody)).status).toBe(401);
    expect((await call('POST', adoptionPath, sourceAdoptToken, adoptionBody)).status).toBe(401);
    expect((await call('POST', adoptionPath, fullToken,
      { ...adoptionBody, confirmedTitle: 'Different title' })).status).toBe(409);
    expect((await call('POST', adoptionPath, fullToken, adoptionBody)).status).toBe(403);
    expect((await contentPool.query('SELECT id FROM source.native_work_binding WHERE principal_id = $1',
      [principalId])).rowCount).toBe(0);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','work.create',now() + interval '1 hour')`,
    [randomUUID(), actor]);
    failNextBinding = true;
    expect((await call('POST', adoptionPath, fullToken, adoptionBody)).status).toBe(503);
    expect((await contentPool.query('SELECT id FROM source.native_work_binding WHERE principal_id = $1',
      [principalId])).rowCount).toBe(0);
    expect((await fuseki.query(`PREFIX schema: <https://schema.org/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      ASK { GRAPH <urn:rezics:graph:current> { ?work a schema:CreativeWork ;
        rdfs:label "Source title"@en . } }`)).boolean).toBe(true);
    const adoptionResponse = await call('POST', adoptionPath, fullToken, adoptionBody);
    expect(adoptionResponse.status).toBe(200);
    const adoptionWrite = await adoptionResponse.json() as { adoption: {
      work: string; mainVersion: string; proposal: string; title: string;
      adoptedFields: string[]; rightsStatus: string }; replayed: boolean };
    expect(adoptionWrite).toMatchObject({ replayed: true, adoption: {
      proposal: proposal.proposal, title: 'Source title', adoptedFields: ['title'],
      rightsStatus: 'undetermined' } });
    expect(adoptionWrite.adoption.work).not.toBe(adoptionWrite.adoption.mainVersion);
    const replay = await call('POST', adoptionPath, fullToken, adoptionBody);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...adoptionWrite, replayed: true });
    expect((await call('GET', adoptionPath, readToken)).status).toBe(200);
    expect((await contentPool.query('SELECT id FROM source.native_work_binding WHERE principal_id = $1',
      [principalId])).rowCount).toBe(1);
    expect((await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      ASK { GRAPH <urn:rezics:graph:current> { <${adoptionWrite.adoption.work}>
        rv:sourceDescription ?value . } }`)).boolean).toBe(false);
    const concurrentWorkId = 'OL45805W';
    const concurrentBytes = Buffer.from(JSON.stringify({ key: `/works/${concurrentWorkId}`,
      type: { key: '/type/work' }, title: 'Concurrent source title' }));
    const concurrentObservation = await sourceIntake.submit(principalId,
      `source-concurrent-${randomUUID()}`, {
        provider: 'open-library', namespace: 'work', externalId: concurrentWorkId,
        sourceRevision: null, mediaType: 'application/json', retention: 'retained',
        rawBytesBase64: concurrentBytes.toString('base64'),
        coverage: { scope: 'open-library-work-response-v1', complete: true,
          omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: '' },
      }, { profile: 'open-library-work-acquisition-v1',
        url: `https://openlibrary.org/works/${concurrentWorkId}.json`, status: 200,
        etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
    const concurrentConversion = await sourceConversions.convert(principalId,
      concurrentObservation.observation.observation.split('/').at(-1)!);
    const concurrentConversionId = concurrentConversion!.conversion.conversion.split('/').at(-1)!;
    await sourceGraph.project(principalId, concurrentConversionId);
    const concurrentProposal = await sourceProposals.propose(principalId, concurrentConversionId);
    const concurrentProposalId = concurrentProposal!.proposal.proposal.split('/').at(-1)!;
    const concurrentPath = `/v1/sources/proposals/${concurrentProposalId}/adoption/native-work`;
    const concurrentBody = { ...adoptionBody, confirmedTitle: 'Concurrent source title' };
    const concurrentResponses = await Promise.all([
      call('POST', concurrentPath, fullToken, concurrentBody),
      call('POST', concurrentPath, fullToken, concurrentBody),
    ]);
    expect(concurrentResponses.every(response => [200, 201, 202].includes(response.status)))
      .toBe(true);
    const settled = await call('POST', concurrentPath, fullToken, concurrentBody);
    expect(settled.status).toBe(200);
    const concurrentAdoption = (await settled.json() as { adoption: { work: string } }).adoption;
    const nativeMatches = await fuseki.query(`PREFIX schema: <https://schema.org/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      SELECT (COUNT(DISTINCT ?work) AS ?count) WHERE {
        GRAPH <urn:rezics:graph:current> { ?work a schema:CreativeWork ;
          rdfs:label "Concurrent source title"@en . }
      }`);
    expect(nativeMatches.results?.bindings[0]?.count?.value).toBe('1');
    expect(concurrentAdoption.work).toMatch(/^https:\/\/rezics\.com\/id\//);
    expect((await contentPool.query('SELECT id FROM source.native_work_binding WHERE proposal_id = $1',
      [concurrentProposalId])).rowCount).toBe(1);
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalId]);
    const beforeDenied = await contentPool.query('SELECT id FROM source.observation WHERE principal_id = $1',
      [principalId]);
    expect((await call('POST', '/v1/sources/intakes', fullToken,
      { ...manual, externalId: `denied-${randomUUID()}` })).status).toBe(403);
    expect((await contentPool.query('SELECT id FROM source.observation WHERE principal_id = $1',
      [principalId])).rowCount)
      .toBe(beforeDenied.rowCount);
    expect((await call('GET', `/v1/sources/observations/${observationId}`, fullToken)).status)
      .toBe(403);
    expect((await call('POST', proposalPath, fullToken, proposalBody)).status).toBe(403);
    expect((await call('GET', `/v1/sources/proposals/${proposalId}`, fullToken)).status)
      .toBe(403);
    expect((await call('POST', adoptionPath, fullToken, adoptionBody)).status).toBe(403);
    expect((await call('GET', adoptionPath, fullToken)).status).toBe(403);
  } finally {
    server.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
  }
});
