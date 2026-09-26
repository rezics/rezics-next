import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { OpenLibraryConversionStore }
  from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { OpenLibrarySourceGraph }
  from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { SourceNativeWorkProposalStore }
  from '../../../services/main/src/modules/source/native-work-proposal.ts';
import { SourceNativeWorkAdoptionStore, type NativeWorkSourceAdoption,
  type NativeWorkSourceTitleApplication }
  from '../../../services/main/src/modules/source/native-work-adoption.ts';
import { SourceChildCorrespondenceStore }
  from '../../../services/main/src/modules/source/record-child-correspondence.ts';
import { GoMvsResolutionStore }
  from '../../../services/main/src/modules/package/go-mvs.ts';
import { CargoResolutionStore, type CargoResolution }
  from '../../../services/main/src/modules/package/cargo-resolution.ts';
import { GoProxyCaptureStore }
  from '../../../services/main/src/modules/package/go-proxy-capture.ts';
import { GoSumdbTrustStore }
  from '../../../services/main/src/modules/package/go-sumdb-trust.ts';
import { type IncludedGoSumdbLookup }
  from '../../../services/main/src/modules/package/go-sumdb-lookup.ts';
import includedGoSumdb from '../fixtures/go-sumdb-x-sync.json';
import latestGoSumdb from '../fixtures/go-sumdb-latest.json';
import { cargoFixture } from '../fixtures/cargo-snapshot.ts';
import { assertSourceSupportWithdrawal } from '../fixtures/source-support-withdrawal.ts';
import { assertSourceSupportAttachment } from '../fixtures/source-support-attachment.ts';
import { SourceNativeWorkAttachmentStore } from '../../../services/main/src/modules/source/native-work-attachment.ts';
import { cargoLinksFixture } from '../fixtures/cargo-links-snapshot.ts';
import { assertCargoLockApi } from '../fixtures/cargo-lock-api.ts';
import { assertNpmLockApi } from '../fixtures/npm-lock-api.ts';
import { NpmResolutionStore } from '../../../services/main/src/modules/package/npm-resolution.ts';

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

test('IAM10/LIVE01/LIVE02/LIVE03/LIVE05/LIVE13/PKG01/PKG02/PKG03/PKG04/PKG05/PKG12/PKG13/PKG14/PKG20: real Account and Access fence source and package operations', async () => {
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
    const allowed = 'openid source:intake source:acquire source:convert source:propose source:correspond source:adopt source:read package:capture package:resolve package:verify package:read work:create work:edit work:read';
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
    const tokenFor = async (scope: string, sessionCookie = cookie) => {
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: client.client_id, redirect_uri: redirectUri, scope,
        state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, {
        headers: { cookie: sessionCookie }, redirect: 'manual' });
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
    const sourceCorrespondToken = await tokenFor('openid source:correspond');
    const packageResolveToken = await tokenFor('openid package:resolve');
    const packageCaptureToken = await tokenFor('openid package:capture');
    const packageVerifyToken = await tokenFor('openid package:verify');
    const packageReadToken = await tokenFor('openid package:read');
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
    let failNextTitleBinding = false;
    let loseNextWithdrawalResponse = false;
    const bindingFaultPool = new Proxy(contentPool, { get(target, property) {
      if (property === 'query') return (query: string, values: unknown[]) => {
        if (failNextBinding && query.includes('INSERT INTO source.native_work_binding')) {
          failNextBinding = false;
          throw new Error('injected post-graph binding write failure');
        }
        if (failNextTitleBinding
          && query.includes('INSERT INTO source.native_work_title_application')) {
          failNextTitleBinding = false;
          throw new Error('injected post-edit source application write failure');
        }
        if (loseNextWithdrawalResponse
          && query.includes('INSERT INTO source.native_work_support_withdrawal')) {
          loseNextWithdrawalResponse = false;
          return target.query(query, values).then(() => {
            throw new Error('injected lost committed withdrawal response');
          });
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
    let beforeAttachmentAuthority: (() => Promise<void>) | undefined;
    const attachmentAccess: Pick<AccessAdmissionRegistry, 'withWorkEditAuthority'> = {
      withWorkEditAuthority: async (principal, actingSubject, work, commit) => {
        const before = beforeAttachmentAuthority;
        beforeAttachmentAuthority = undefined;
        if (before) await before();
        return mainAccess.withWorkEditAuthority(principal, actingSubject, work, commit);
      },
    };
    let loseNextAttachmentCommitResponse = false;
    const attachmentFaultPool = new Proxy(contentPool, { get(target, property) {
      if (property === 'connect') return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(owner, member) {
          if (member === 'query') return async (query: string, values?: unknown[]) => {
            const result = await owner.query(query, values);
            if (loseNextAttachmentCommitResponse && query === 'COMMIT') {
              loseNextAttachmentCommitResponse = false;
              throw new Error('injected lost Source commit response');
            }
            return result;
          };
          const value = Reflect.get(owner, member, owner);
          return typeof value === 'function' ? value.bind(owner) : value;
        } });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Pool;
    const environment = { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: `.temp/source-auth-${randomUUID()}` };
    const sourceAdoptions = new SourceNativeWorkAdoptionStore(bindingFaultPool, sourceProposals,
      environment, mainAccount, mainAccess);
    const workObjects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/source-attachment-test/' });
    await workObjects.initialize();
    const nativeEnvironment = { ...environment, workObjects };
    let fetches = 0;
    let failNextSourceFetch = false;
    let packageFetches = 0;
    const packageCaptures = new GoProxyCaptureStore(contentPool,
      (async (url: RequestInfo | URL) => {
        packageFetches++;
        const value = String(url);
        if (value.endsWith('/@v/list')) return new Response('v0.1.0\n');
        if (value.endsWith('.info')) return new Response(JSON.stringify({
          Version: 'v0.1.0', Time: '2022-10-01T00:00:00Z' }));
        if (value.endsWith('.mod')) return new Response('module golang.org/x/sync\n');
        return new Response('', { status: 404 });
      }) as typeof fetch);
    let checksumLookups = 0;
    const packageVerifications = new GoSumdbTrustStore(contentPool, packageCaptures,
      (async () => { checksumLookups++; return includedGoSumdb as IncludedGoSumdbLookup; }) as
        ConstructorParameters<typeof GoSumdbTrustStore>[2],
      (async () => []) as ConstructorParameters<typeof GoSumdbTrustStore>[3],
      (async () => latestGoSumdb) as ConstructorParameters<typeof GoSumdbTrustStore>[4]);
    const app = createMainApp(fuseki, {
      environment: nativeEnvironment,
      account: mainAccount,
      access: mainAccess, sourceIntake,
      sourceConversions, sourceGraph,
      sourceCorrespondences: new SourceChildCorrespondenceStore(contentPool,
        sourceConversions),
      packageResolutions: new GoMvsResolutionStore(contentPool, packageCaptures),
      packageCargoResolutions: new CargoResolutionStore(contentPool),
      packageNpmResolutions: new NpmResolutionStore(contentPool),
      packageCaptures,
      packageVerifications,
      sourceProposals,
      sourceAdoptions,
      sourceAttachments: new SourceNativeWorkAttachmentStore(attachmentFaultPool, sourceProposals,
        sourceAdoptions, nativeEnvironment, attachmentAccess),
      openLibraryFetch: (async (url: string) => {
        fetches++;
        if (failNextSourceFetch) {
          failNextSourceFetch = false;
          return new Response('', { status: 503 });
        }
        const workId = url.split('/').at(-1)!.slice(0, -5);
        const attachmentTitles: Record<string, string> = { OL991401W: 'Source title refreshed',
          OL991402W: 'Conflicting title', OL991403W: 'Historical title acknowledgement',
          OL991404W: 'Historical title acknowledgement' };
        return new Response(JSON.stringify({ key: `/works/${workId}`,
          type: { key: '/type/work' }, title: attachmentTitles[workId] ?? 'Source title', revision: 1,
          description: { value: 'Source-only expression' },
          authors: [{ author: { key: '/authors/OL1A' } }], subjects: ['Source term'] }),
        { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const call = (method: string, path: string, token: string, body?: object,
      key = `source-${randomUUID()}`) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'idempotency-key': key } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}) },
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
    const adoptionWrite = await adoptionResponse.json() as {
      adoption: NativeWorkSourceAdoption; replayed: boolean };
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
    const supportPath = `/v1/works/${adoptionWrite.adoption.work.split('/').at(-1)}/source-support`;
    const supportBefore = await call('GET', supportPath, readToken);
    expect(supportBefore.status).toBe(200);
    expect(await supportBefore.json()).toMatchObject({ field: 'title',
      sourceValue: 'Source title', sourceProposal: proposal.proposal,
      adoptedAtRevision: adoptionWrite.adoption.workRevision,
      currentHead: adoptionWrite.adoption.workRevision,
      appliedRevisionIsHead: true, rightsEvidence: { basis: 'unknown' },
      rightsStatus: 'undetermined' });
    expect((await call('GET', `/v1/works/${randomUUID()}/source-support`, readToken)).status)
      .toBe(404);
    const otherMember = await signUp('other');
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3)`,
    [randomUUID(), `${base}/api/auth`, otherMember.id]);
    const otherReadToken = await tokenFor('openid source:read', otherMember.cookie);
    const otherAdoptToken = await tokenFor('openid source:adopt', otherMember.cookie);
    const otherAttachmentToken = await tokenFor('openid source:adopt source:read work:edit', otherMember.cookie);
    expect((await call('GET', supportPath, otherReadToken)).status).toBe(404);
    const refreshedBytes = Buffer.from(JSON.stringify({ key: '/works/OL45804W',
      type: { key: '/type/work' }, title: 'Source title refreshed', revision: 2,
      description: { value: 'Changed source-only expression' } }));
    const refreshedObservation = await sourceIntake.submit(principalId,
      `source-refresh-${randomUUID()}`, {
        provider: 'open-library', namespace: 'work', externalId: 'OL45804W',
        sourceRevision: 'open-library-revision:2', mediaType: 'application/json',
        retention: 'retained', rawBytesBase64: refreshedBytes.toString('base64'),
        coverage: { scope: 'open-library-work-response-v1', complete: true,
          omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: '' },
      }, { profile: 'open-library-work-acquisition-v1',
        url: 'https://openlibrary.org/works/OL45804W.json', status: 200,
        etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
    const refreshedConversion = await sourceConversions.convert(principalId,
      refreshedObservation.observation.observation.split('/').at(-1)!);
    const refreshedConversionId = refreshedConversion!.conversion.conversion.split('/').at(-1)!;
    await sourceGraph.project(principalId, refreshedConversionId);
    const refreshedProposal = await sourceProposals.propose(principalId, refreshedConversionId);
    const refreshedProposalId = refreshedProposal!.proposal.proposal.split('/').at(-1)!;
    const assessmentPath = `/v1/works/${adoptionWrite.adoption.work.split('/').at(-1)}`
      + `/source-refresh-assessments/${refreshedProposalId}`;
    const assessmentBefore = await call('GET', assessmentPath, readToken);
    expect(assessmentBefore.status).toBe(200);
    expect(await assessmentBefore.json()).toMatchObject({
      adoptedTitle: 'Source title', candidateTitle: 'Source title refreshed',
      sourceTitleChanged: true, representationChanged: true,
      adoptedRevision: adoptionWrite.adoption.workRevision,
      currentHead: adoptionWrite.adoption.workRevision,
      targetHeadChanged: false, rightsStatus: 'undetermined' });
    expect((await call('GET', assessmentPath, otherReadToken)).status).toBe(404);
    const titlePath = `/v1/works/${adoptionWrite.adoption.work.split('/').at(-1)}`
      + `/source-title-applications/${refreshedProposalId}`;
    const titleBody = { profile: 'native-work-source-title-application-v1',
      expectedHead: adoptionWrite.adoption.workRevision, actingSubject: actor,
      confirmedTitle: 'Source title refreshed' };
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`work:edit:${adoptionWrite.adoption.work}`]);
    expect((await call('POST', titlePath, readToken, titleBody)).status).toBe(401);
    expect((await call('POST', titlePath, sourceAdoptToken, titleBody)).status).toBe(401);
    expect((await call('POST', titlePath, fullToken, titleBody)).status).toBe(403);
    expect((await contentPool.query(`SELECT id FROM source.native_work_title_application
      WHERE work = $1`, [adoptionWrite.adoption.work])).rowCount).toBe(0);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.edit',now() + interval '1 hour')`,
    [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.edit',now() + interval '1 hour')`,
    [randomUUID(), actor, `work:edit:${adoptionWrite.adoption.work}`]);
    failNextTitleBinding = true;
    expect((await call('POST', titlePath, fullToken, titleBody)).status).toBe(503);
    expect((await contentPool.query(`SELECT id FROM source.native_work_title_application
      WHERE work = $1`, [adoptionWrite.adoption.work])).rowCount).toBe(0);
    expect((await fuseki.query(`PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      ASK { GRAPH <urn:rezics:graph:current> { <${adoptionWrite.adoption.work}>
        rdfs:label "Source title refreshed"@en . } }`)).boolean).toBe(true);
    const pendingWithdrawal = await call('POST', `${supportPath}/withdrawal`, sourceAdoptToken,
      { profile: 'native-work-source-support-withdrawal-v1', binding: adoptionWrite.adoption.binding,
        expectedSupport: adoptionWrite.adoption.binding, reason: 'Explicit withdrawal' });
    expect(pendingWithdrawal.status).toBe(409);
    expect(await pendingWithdrawal.json()).toMatchObject({ code: 'source_support_pending' });
    const appliedResponse = await call('POST', titlePath, fullToken, titleBody);
    expect(appliedResponse.status).toBe(200);
    const applied = await appliedResponse.json() as {
      application: NativeWorkSourceTitleApplication; replayed: boolean };
    expect(applied).toMatchObject({ replayed: true, application: {
      predecessor: adoptionWrite.adoption.workRevision, title: 'Source title refreshed',
      rightsStatus: 'undetermined' } });
    expect((await call('GET', titlePath, readToken)).status).toBe(200);
    expect((await call('GET', titlePath, otherReadToken)).status).toBe(404);
    expect((await call('POST', titlePath, fullToken,
      { ...titleBody, confirmedTitle: 'Different' })).status).toBe(409);
    const confirmed = await call('POST', '/v1/content-edits', fullToken, {
      profile: 'metadata-only-v1', work: adoptionWrite.adoption.work,
      expectedHead: applied.application.workRevision,
      title: 'Source title refreshed', actingSubject: actor,
    });
    expect(confirmed.status).toBe(200);
    const humanRevision = (await confirmed.json() as { revision: string }).revision;
    expect(humanRevision).not.toBe(adoptionWrite.adoption.workRevision);
    const supportAfter = await call('GET', supportPath, readToken);
    expect(supportAfter.status).toBe(200);
    expect(await supportAfter.json()).toMatchObject({ sourceValue: 'Source title',
      adoptedAtRevision: adoptionWrite.adoption.workRevision,
      currentHead: humanRevision, appliedRevisionIsHead: false });
    const assessmentAfter = await call('GET', assessmentPath, readToken);
    expect(assessmentAfter.status).toBe(200);
    expect(await assessmentAfter.json()).toMatchObject({
      candidateTitle: 'Source title refreshed', currentHead: humanRevision,
      targetHeadChanged: true });
    const laterBytes = Buffer.from(JSON.stringify({ key: '/works/OL45804W',
      type: { key: '/type/work' }, title: 'Later source title', revision: 3 }));
    const laterObservation = await sourceIntake.submit(principalId,
      `source-later-${randomUUID()}`, {
        provider: 'open-library', namespace: 'work', externalId: 'OL45804W',
        sourceRevision: 'open-library-revision:3', mediaType: 'application/json',
        retention: 'retained', rawBytesBase64: laterBytes.toString('base64'),
        coverage: { scope: 'open-library-work-response-v1', complete: true,
          omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: '' },
      }, { profile: 'open-library-work-acquisition-v1',
        url: 'https://openlibrary.org/works/OL45804W.json', status: 200,
        etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
    const laterConversion = await sourceConversions.convert(principalId,
      laterObservation.observation.observation.split('/').at(-1)!);
    const laterConversionId = laterConversion!.conversion.conversion.split('/').at(-1)!;
    await sourceGraph.project(principalId, laterConversionId);
    const laterProposal = await sourceProposals.propose(principalId, laterConversionId);
    const laterProposalId = laterProposal!.proposal.proposal.split('/').at(-1)!;
    const laterTitlePath = `/v1/works/${adoptionWrite.adoption.work.split('/').at(-1)}`
      + `/source-title-applications/${laterProposalId}`;
    expect((await call('POST', laterTitlePath, fullToken, {
      ...titleBody, expectedHead: humanRevision,
      confirmedTitle: 'Later source title' })).status).toBe(409);
    expect((await call('POST', titlePath, fullToken, titleBody)).status).toBe(200);
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
    expect((await call('GET',
      `/v1/works/${adoptionWrite.adoption.work.split('/').at(-1)}`
      + `/source-refresh-assessments/${concurrentProposalId}`, readToken)).status).toBe(409);
    expect((await call('POST',
      `/v1/works/${adoptionWrite.adoption.work.split('/').at(-1)}`
      + `/source-title-applications/${concurrentProposalId}`, fullToken,
      { ...titleBody, expectedHead: humanRevision,
        confirmedTitle: 'Concurrent source title' })).status).toBe(409);
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
    const raceBytes = Buffer.from(JSON.stringify({ key: `/works/${concurrentWorkId}`,
      type: { key: '/type/work' }, title: 'Racing source title', revision: 2 }));
    const raceObservation = await sourceIntake.submit(principalId,
      `source-race-${randomUUID()}`, {
        provider: 'open-library', namespace: 'work', externalId: concurrentWorkId,
        sourceRevision: 'open-library-revision:2', mediaType: 'application/json',
        retention: 'retained', rawBytesBase64: raceBytes.toString('base64'),
        coverage: { scope: 'open-library-work-response-v1', complete: true,
          omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: '' },
      }, { profile: 'open-library-work-acquisition-v1',
        url: `https://openlibrary.org/works/${concurrentWorkId}.json`, status: 200,
        etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
    const raceConversion = await sourceConversions.convert(principalId,
      raceObservation.observation.observation.split('/').at(-1)!);
    const raceConversionId = raceConversion!.conversion.conversion.split('/').at(-1)!;
    await sourceGraph.project(principalId, raceConversionId);
    const raceProposal = await sourceProposals.propose(principalId, raceConversionId);
    const raceProposalId = raceProposal!.proposal.proposal.split('/').at(-1)!;
    const raceWorkHead = (await call('GET',
      `/v1/works/${concurrentAdoption.work.split('/').at(-1)}/source-support`, readToken));
    expect(raceWorkHead.status).toBe(200);
    const raceBase = (await raceWorkHead.json() as { adoptedAtRevision: string })
      .adoptedAtRevision;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [`work:edit:${concurrentAdoption.work}`]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.edit',now() + interval '1 hour')`,
    [randomUUID(), actor, `work:edit:${concurrentAdoption.work}`]);
    const raceSourcePath = `/v1/works/${concurrentAdoption.work.split('/').at(-1)}`
      + `/source-title-applications/${raceProposalId}`;
    const raceSourceBody = { profile: 'native-work-source-title-application-v1',
      expectedHead: raceBase, actingSubject: actor,
      confirmedTitle: 'Racing source title' };
    const raceHumanBody = { profile: 'metadata-only-v1', work: concurrentAdoption.work,
      expectedHead: raceBase, title: 'Concurrent source title', actingSubject: actor };
    const raceSourceKey = `race-source-${randomUUID()}`;
    const raceHumanKey = `race-human-${randomUUID()}`;
    let [raceSource, raceHuman] = await Promise.all([
      call('POST', raceSourcePath, fullToken, raceSourceBody, raceSourceKey),
      call('POST', '/v1/content-edits', fullToken, raceHumanBody, raceHumanKey),
    ]);
    for (let attempt = 0; attempt < 3 && raceSource.status === 202; attempt++) {
      await Bun.sleep(100);
      raceSource = await call('POST', raceSourcePath, fullToken, raceSourceBody, raceSourceKey);
    }
    for (let attempt = 0; attempt < 3 && raceHuman.status === 202; attempt++) {
      await Bun.sleep(100);
      raceHuman = await call('POST', '/v1/content-edits', fullToken,
        raceHumanBody, raceHumanKey);
    }
    const sourceWon = raceSource.status === 200 || raceSource.status === 201;
    const humanWon = raceHuman.status === 200;
    expect(Number(sourceWon) + Number(humanWon)).toBe(1);
    expect(sourceWon ? raceHuman.status : raceSource.status).toBe(409);
    let humanHead: string;
    if (sourceWon) {
      const sourceRevision = (await raceSource.json() as { application: {
        workRevision: string } }).application.workRevision;
      const humanRetry = await call('POST', '/v1/content-edits', fullToken, {
        ...raceHumanBody, expectedHead: sourceRevision, title: 'Racing source title' });
      expect(humanRetry.status).toBe(200);
      humanHead = (await humanRetry.json() as { revision: string }).revision;
    } else {
      humanHead = (await raceHuman.json() as { revision: string }).revision;
    }
    const raceLaterBytes = Buffer.from(JSON.stringify({ key: `/works/${concurrentWorkId}`,
      type: { key: '/type/work' }, title: 'Later racing source title', revision: 3 }));
    const raceLaterObservation = await sourceIntake.submit(principalId,
      `source-race-later-${randomUUID()}`, {
        provider: 'open-library', namespace: 'work', externalId: concurrentWorkId,
        sourceRevision: 'open-library-revision:3', mediaType: 'application/json',
        retention: 'retained', rawBytesBase64: raceLaterBytes.toString('base64'),
        coverage: { scope: 'open-library-work-response-v1', complete: true,
          omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: '' },
      }, { profile: 'open-library-work-acquisition-v1',
        url: `https://openlibrary.org/works/${concurrentWorkId}.json`, status: 200,
        etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
    const raceLaterConversion = await sourceConversions.convert(principalId,
      raceLaterObservation.observation.observation.split('/').at(-1)!);
    const raceLaterConversionId = raceLaterConversion!.conversion.conversion.split('/').at(-1)!;
    await sourceGraph.project(principalId, raceLaterConversionId);
    const raceLaterProposal = await sourceProposals.propose(principalId, raceLaterConversionId);
    const raceLaterProposalId = raceLaterProposal!.proposal.proposal.split('/').at(-1)!;
    expect((await call('POST',
      `/v1/works/${concurrentAdoption.work.split('/').at(-1)}`
      + `/source-title-applications/${raceLaterProposalId}`, fullToken,
      { ...raceSourceBody, expectedHead: humanHead,
        confirmedTitle: 'Later racing source title' })).status).toBe(409);
    expect((await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      ASK { GRAPH <urn:rezics:graph:current> { <${concurrentAdoption.work}>
        rv:head <${humanHead}> . } }`)).boolean).toBe(true);
    const childWorkId = 'OL45806W';
    const childConversion = async (name: string, authorRoles: string[]) => {
      const bytes = Buffer.from(JSON.stringify({ key: `/works/${childWorkId}`,
        type: { key: '/type/work' }, title: name,
        authors: authorRoles.map(role => ({ author: { key: '/authors/OL1A' },
          type: { key: `/type/${role}` } })) }));
      const observation = await sourceIntake.submit(principalId,
        `source-child-${randomUUID()}`, {
          provider: 'open-library', namespace: 'work', externalId: childWorkId,
          sourceRevision: name, mediaType: 'application/json', retention: 'retained',
          rawBytesBase64: bytes.toString('base64'),
          coverage: { scope: 'open-library-work-response-v1', complete: true,
            omittedFields: [] }, rightsEvidence: { basis: 'unknown', note: '' },
        }, { profile: 'open-library-work-acquisition-v1',
          url: `https://openlibrary.org/works/${childWorkId}.json`, status: 200,
          etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
      const converted = await sourceConversions.convert(principalId,
        observation.observation.observation.split('/').at(-1)!);
      return converted!.conversion.conversion.split('/').at(-1)!;
    };
    const childBase = await childConversion('Child base', ['writer', 'editor']);
    const childCandidate = await childConversion('Child candidate', ['editor', 'writer']);
    const childAssessment = await call('GET',
      `/v1/sources/conversions/${childBase}/child-correspondences/${childCandidate}`,
      readToken);
    expect(childAssessment.status).toBe(200);
    const childFields = (await childAssessment.json() as { fields: Array<{
      field: string; base: Array<{ occurrence: string; status: string }>;
      candidate: Array<{ occurrence: string; status: string }> }> }).fields;
    const childAuthors = childFields.find(field => field.field === 'authors')!;
    expect(childAuthors.base.map(item => item.status)).toEqual(['ambiguous', 'ambiguous']);
    const childBody = { profile: 'source-child-correspondence-v1',
      baseConversion: childBase, candidateConversion: childCandidate,
      field: 'authors', baseOccurrence: childAuthors.base[0]!.occurrence,
      candidateOccurrence: childAuthors.candidate[1]!.occurrence,
      confirmedSameSourceChild: true };
    const childPath = '/v1/sources/correspondences';
    expect((await call('POST', childPath, readToken, childBody)).status).toBe(401);
    const childRecorded = await call('POST', childPath, sourceCorrespondToken, childBody);
    expect(childRecorded.status).toBe(201);
    const childId = (await childRecorded.json() as { correspondence: {
      correspondence: string } }).correspondence.correspondence.split('/').at(-1)!;
    expect((await call('GET', `${childPath}/${childId}`, sourceCorrespondToken)).status)
      .toBe(401);
    expect((await call('GET', `${childPath}/${childId}`, readToken)).status).toBe(200);
    expect((await call('GET', `${childPath}/${childId}`, otherReadToken)).status).toBe(404);
    const goBody = { profile: 'go-mvs-stable-unpruned-v1',
      mainModule: 'example.com/main', goDirective: '1.16',
      coverage: { complete: true, unsupportedClauses: [] },
      roots: [{ path: 'example.com/a', version: 'v1.0.0' }],
      releases: [{ path: 'example.com/a', version: 'v1.0.0', requirements: [] }] };
    expect((await call('POST', '/v1/package-resolutions', packageReadToken,
      goBody)).status).toBe(401);
    const goCreated = await call('POST', '/v1/package-resolutions',
      packageResolveToken, goBody);
    expect(goCreated.status).toBe(201);
    const goId = (await goCreated.json() as { resolution: { resolution: string;
      outcome: { status: string } } }).resolution.resolution.split('/').at(-1)!;
    expect((await call('GET', `/v1/package-resolutions/${goId}`,
      packageResolveToken)).status).toBe(401);
    expect((await call('GET', `/v1/package-resolutions/${goId}`,
      packageReadToken)).status).toBe(200);
    const otherPackageReadToken = await tokenFor('openid package:read', otherMember.cookie);
    expect((await call('GET', `/v1/package-resolutions/${goId}`,
      otherPackageReadToken)).status).toBe(404);
    const captureBody = { profile: 'go-module-proxy-capture-v1',
      path: 'golang.org/x/sync', version: 'v0.1.0' };
    const capturePath = '/v1/package-sources/go';
    expect((await call('POST', capturePath, packageReadToken, captureBody)).status)
      .toBe(401);
    expect(packageFetches).toBe(0);
    const captureCreated = await call('POST', capturePath,
      packageCaptureToken, captureBody);
    expect(captureCreated.status).toBe(201);
    expect(packageFetches).toBe(3);
    const captureId = (await captureCreated.json() as { capture: { capture: string } })
      .capture.capture.split('/').at(-1)!;
    expect((await call('GET', `${capturePath}/${captureId}`,
      packageCaptureToken)).status).toBe(401);
    expect((await call('GET', `${capturePath}/${captureId}`,
      packageReadToken)).status).toBe(200);
    expect((await call('GET', `${capturePath}/${captureId}`,
      otherPackageReadToken)).status).toBe(404);
    const verifyPath = `${capturePath}/${captureId}/verify`;
    const verificationKey = `go-verify-${randomUUID()}`;
    expect((await call('POST', verifyPath, packageReadToken,
      undefined, verificationKey)).status).toBe(401);
    expect((await call('POST', verifyPath, packageCaptureToken,
      undefined, verificationKey)).status).toBe(401);
    const otherPackageVerifyToken = await tokenFor('openid package:verify',
      otherMember.cookie);
    expect((await call('POST', verifyPath, otherPackageVerifyToken,
      undefined, verificationKey)).status).toBe(404);
    expect(checksumLookups).toBe(0);
    const verified = await call('POST', verifyPath, packageVerifyToken,
      undefined, verificationKey);
    expect(verified.status).toBe(201);
    const verification = (await verified.json() as { verification: {
      verification: string; trustedTree: { size: number } }; replayed: boolean });
    expect(verification).toMatchObject({ replayed: false,
      verification: { trustedTree: latestGoSumdb.tree } });
    const verificationId = verification.verification.verification.split('/').at(-1)!;
    const receiptPath = `/v1/package-sources/go-verifications/${verificationId}`;
    expect((await call('GET', receiptPath, packageVerifyToken)).status).toBe(401);
    expect((await call('GET', receiptPath, otherPackageReadToken)).status).toBe(404);
    expect((await call('GET', receiptPath, packageReadToken)).status).toBe(200);
    expect(await (await call('POST', verifyPath, packageVerifyToken,
      undefined, verificationKey)).json()).toEqual({ ...verification, replayed: true });
    expect(checksumLookups).toBe(1);
    const derivedPath = '/v1/package-resolutions/from-captures';
    const derivedBody = { profile: 'go-mvs-from-captures-v1',
      mainModule: 'example.com/main',
      roots: [{ path: 'golang.org/x/sync', version: 'v0.1.0' }],
      captures: [captureId] };
    expect((await call('POST', derivedPath, packageCaptureToken,
      derivedBody)).status).toBe(401);
    const otherPackageResolveToken = await tokenFor('openid package:resolve',
      otherMember.cookie);
    expect((await call('POST', derivedPath, otherPackageResolveToken,
      derivedBody)).status).toBe(404);
    const derived = await call('POST', derivedPath, packageResolveToken, derivedBody);
    expect(derived.status).toBe(201);
    expect(await derived.json()).toMatchObject({ resolution: { outcome: {
      status: 'unsupported-semantics', buildList: [] } } });
    const cargoPath = '/v1/package-resolutions/cargo';
    const cargoBody = cargoFixture();
    const cargoKey = `cargo-${randomUUID()}`;
    expect((await call('POST', cargoPath, packageReadToken, cargoBody, cargoKey)).status)
      .toBe(401);
    const cargoCreated = await call('POST', cargoPath, packageResolveToken,
      cargoBody, cargoKey);
    expect(cargoCreated.status).toBe(201);
    const cargoSaved = await cargoCreated.json() as { resolution: {
      resolution: string; request: typeof cargoBody;
      outcome: { status: string; selected: unknown[] } }; replayed: boolean };
    expect(cargoSaved).toMatchObject({ replayed: false,
      resolution: { outcome: { status: 'solved' } } });
    expect(cargoSaved.resolution.request).toEqual(cargoBody);
    expect(cargoSaved.resolution.outcome.selected.every(item =>
      (item as { source: string }).source === cargoBody.registryIndexUrl)).toBe(true);
    const cargoId = cargoSaved.resolution.resolution.split('/').at(-1)!;
    const cargoReadPath = `${cargoPath}/${cargoId}`;
    expect((await call('GET', cargoReadPath, packageResolveToken)).status).toBe(401);
    expect((await call('GET', cargoReadPath, otherPackageReadToken)).status).toBe(404);
    expect(await (await call('GET', cargoReadPath, packageReadToken)).json())
      .toEqual(cargoSaved.resolution);
    expect(await (await call('POST', cargoPath, packageResolveToken,
      cargoBody, cargoKey)).json()).toEqual({ ...cargoSaved, replayed: true });
    expect((await call('POST', cargoPath, packageResolveToken,
      { ...cargoBody, defaultFeatures: false }, cargoKey)).status).toBe(409);
    expect((await call('POST', cargoPath, packageResolveToken,
      { ...cargoBody, registryIndexUrl: 'https://changed.example.invalid/index/' },
      cargoKey)).status).toBe(409);
    await expect(contentPool.query('UPDATE pkg.cargo_resolution SET request_digest = $2 WHERE id = $1',
      [cargoId, '0'.repeat(64)])).rejects.toThrow();
    await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ($1)`,
      [`work:read:${adoptionWrite.adoption.work}`]);
    await accessPool.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.read',now() + interval '1 hour')`, [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.read',now() + interval '1 hour')`,
      [randomUUID(), actor, `work:read:${adoptionWrite.adoption.work}`]);
    const attachment = await assertSourceSupportAttachment({ call, pool: contentPool, accessPool, fuseki,
      adoption: adoptionWrite.adoption, humanRevision, actor, fullToken, readToken,
      sourceAdoptToken, otherToken: otherAttachmentToken, otherWork: concurrentAdoption.work,
      beforeNextAuthority: callback => { beforeAttachmentAuthority = callback; },
      loseNextAttachmentCommitResponse: () => { loseNextAttachmentCommitResponse = true; } });
    const withdrawal = await assertSourceSupportWithdrawal({ call, pool: contentPool, fuseki,
      adoption: adoptionWrite.adoption, application: applied.application, humanRevision,
      sourceAdoptToken, readToken, fullToken, otherToken: otherAdoptToken,
      otherWork: concurrentAdoption.work, actor, titlePath, titleBody,
      failNextAcquisition: () => { failNextSourceFetch = true; },
      loseNextWithdrawalResponse: () => { loseNextWithdrawalResponse = true; } });
    await attachment.finish();
    const cargoLinksBody = cargoLinksFixture();
    const cargoLinksKey = `cargo-links-${randomUUID()}`;
    expect((await call('POST', cargoPath, packageReadToken,
      cargoLinksBody, cargoLinksKey)).status).toBe(401);
    const concurrentCargoLinks = await Promise.all([0, 1].map(() =>
      call('POST', cargoPath, packageResolveToken, cargoLinksBody, cargoLinksKey)));
    expect(concurrentCargoLinks.map(response => response.status).sort()).toEqual([200, 201]);
    const concurrentCargoResults = await Promise.all(concurrentCargoLinks.map(response => response.json())) as
      Array<{ resolution: CargoResolution; replayed: boolean }>;
    const cargoLinksSaved = concurrentCargoResults[0]!.resolution;
    expect(concurrentCargoResults[1]!.resolution).toEqual(cargoLinksSaved);
    expect(cargoLinksSaved).toMatchObject({ profile: 'cargo-index-exact-resolution-v2',
      request: cargoLinksBody, outcome: { status: 'unsatisfiable', selected: [], instances: [],
        edges: [], linksConflicts: [{ kind: 'native-links', links: 'native_shared', packages: [
          { name: 'shared', version: '1.0.0', source: cargoLinksBody.registryIndexUrl,
            roles: ['host', 'target'] },
          { name: 'shared', version: '2.0.0', source: cargoLinksBody.registryIndexUrl,
            roles: ['target'] },
        ] }] } });
    const cargoLinksId = cargoLinksSaved.resolution.split('/').at(-1)!;
    const cargoLinksReadPath = `${cargoPath}/${cargoLinksId}`;
    expect((await call('GET', cargoLinksReadPath, packageResolveToken)).status).toBe(401);
    expect((await call('GET', cargoLinksReadPath, otherPackageReadToken)).status).toBe(404);
    expect(await (await call('GET', cargoLinksReadPath, packageReadToken)).json()).toEqual(cargoLinksSaved);
    expect(await (await call('POST', cargoPath, packageResolveToken,
      cargoLinksBody, cargoLinksKey)).json()).toEqual({ resolution: cargoLinksSaved, replayed: true });
    expect((await call('POST', cargoPath, packageResolveToken,
      { ...cargoLinksBody, profile: 'cargo-index-exact-resolver2-v1' }, cargoLinksKey)).status).toBe(409);
    const v1LinksKey = `cargo-v1-links-${randomUUID()}`;
    const v1LinksBody = { ...cargoLinksBody, profile: 'cargo-index-exact-resolver2-v1' };
    const v1Links = await (await call('POST', cargoPath, packageResolveToken,
      v1LinksBody, v1LinksKey)).json() as { resolution: CargoResolution; replayed: boolean };
    expect(v1Links.resolution).toMatchObject({ profile: 'cargo-index-exact-resolution-v1',
      outcome: { status: 'unsupported-semantics', unsupportedClauses: ['Cargo native links'] } });
    expect(v1Links.resolution.outcome).not.toHaveProperty('linksConflicts');
    expect(await (await call('POST', cargoPath, packageResolveToken,
      v1LinksBody, v1LinksKey)).json()).toEqual({ ...v1Links, replayed: true });
    expect(await (await call('GET', `${cargoPath}/${v1Links.resolution.resolution.split('/').at(-1)}`,
      packageReadToken)).json()).toEqual(v1Links.resolution);
    const distinctLinks = await call('POST', cargoPath, packageResolveToken,
      cargoLinksFixture('distinct-links'));
    expect(distinctLinks.status).toBe(201);
    expect(await distinctLinks.json()).toMatchObject({ resolution: {
      profile: 'cargo-index-exact-resolution-v2', outcome: { status: 'solved', linksConflicts: [] } } });
    const missingLinks = { ...cargoLinksBody, indexFiles: cargoLinksBody.indexFiles
      .filter(file => file.name !== 'windowsonly') };
    expect(await (await call('POST', cargoPath, packageResolveToken, missingLinks)).json())
      .toMatchObject({ resolution: { outcome: { status: 'incomplete-source-data', linksConflicts: [] } } });
    expect((await call('POST', cargoPath, packageResolveToken,
      { ...cargoLinksBody, manifestSha256: '0'.repeat(64) })).status).toBe(422);
    await expect(contentPool.query('UPDATE pkg.cargo_resolution SET outcome = $2 WHERE id = $1',
      [cargoLinksId, JSON.stringify({ status: 'solved' })])).rejects.toThrow();
    const cargoLock = await assertCargoLockApi({ call, pool: contentPool,
      resolveToken: packageResolveToken, readToken: packageReadToken, otherReadToken: otherPackageReadToken });
    const npmLock = await assertNpmLockApi({ call, pool: contentPool, principalId,
      resolveToken: packageResolveToken, readToken: packageReadToken, otherReadToken: otherPackageReadToken });
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalId]);
    expect((await call('GET', attachment.path, readToken)).status).toBe(403);
    expect((await call('POST', withdrawal.path, sourceAdoptToken,
      withdrawal.body, withdrawal.key)).status).toBe(403);
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
    expect((await call('GET', supportPath, fullToken)).status).toBe(403);
    expect((await call('GET', assessmentPath, fullToken)).status).toBe(403);
    expect((await call('POST', laterTitlePath, fullToken,
      { ...titleBody, expectedHead: humanRevision,
        confirmedTitle: 'Later source title' })).status).toBe(403);
    expect((await call('GET', titlePath, fullToken)).status).toBe(403);
    expect((await call('POST', childPath, sourceCorrespondToken, childBody)).status).toBe(403);
    expect((await call('GET', `${childPath}/${childId}`, readToken)).status).toBe(403);
    expect((await call('POST', '/v1/package-resolutions', packageResolveToken,
      goBody)).status).toBe(403);
    expect((await call('GET', `/v1/package-resolutions/${goId}`,
      packageReadToken)).status).toBe(403);
    expect((await call('POST', cargoPath, packageResolveToken,
      cargoBody)).status).toBe(403);
    expect((await call('GET', cargoReadPath, packageReadToken)).status).toBe(403);
    expect((await call('POST', cargoPath, packageResolveToken,
      cargoLinksBody, cargoLinksKey)).status).toBe(403);
    expect((await call('GET', cargoLinksReadPath, packageReadToken)).status).toBe(403);
    expect((await call('POST', cargoPath, packageResolveToken, cargoLock.body, cargoLock.key)).status).toBe(403);
    expect((await call('GET', cargoLock.readPath, packageReadToken)).status).toBe(403);
    for (const npm of [npmLock, npmLock.platform]) {
      const deniedNpmKey = `npm-denied-${randomUUID()}`;
      expect((await call('POST', npm.path, packageResolveToken, npm.body, deniedNpmKey)).status).toBe(403);
      expect((await contentPool.query('SELECT id FROM pkg.npm_resolution WHERE idempotency_key = $1',
        [deniedNpmKey])).rowCount).toBe(0);
      expect((await call('POST', npm.path, packageResolveToken, npm.body, npm.key)).status).toBe(403);
      expect((await call('GET', npm.readPath, packageReadToken)).status).toBe(403);
    }
    expect((await call('POST', capturePath, packageCaptureToken,
      captureBody)).status).toBe(403);
    expect((await call('GET', `${capturePath}/${captureId}`,
      packageReadToken)).status).toBe(403);
    expect((await call('POST', derivedPath, packageResolveToken,
      derivedBody)).status).toBe(403);
    expect((await call('POST', verifyPath, packageVerifyToken)).status).toBe(403);
    expect((await call('GET', receiptPath, packageReadToken)).status).toBe(403);
  } finally {
    server.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
  }
}, 30_000);
