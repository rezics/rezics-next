import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { assertSourceSupportWithdrawal } from '../fixtures/source-support-withdrawal.ts';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:net';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, fusekiReadBudget, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { grantFixtureAuthority, reduceFixtureGrant } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { OpenLibraryConversionStore } from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { OpenLibrarySourceGraph } from '../../../services/main/src/modules/source/graph-projection.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import { SourceNativeWorkProposalStore } from '../../../services/main/src/modules/source/native-work-proposal.ts';
import { SourceNativeWorkAdoptionStore, type NativeWorkSourceAdoption, type NativeWorkSourceTitleApplication } from '../../../services/main/src/modules/source/native-work-adoption.ts';
import { type NativeWorkSourceAttachment, type NativeWorkSupportCollection, SourceNativeWorkAttachmentStore } from '../../../services/main/src/modules/source/native-work-attachment.ts';
import { readTitleControl } from '../../../services/main/src/modules/work/title-control.ts';

// Public requests have no enclosing wall deadline. Measure the existing owner
// exchange budgets separately, through body completion, without timing out or
// substituting an API response. Closed parent contexts identify background work.
class CompletionEvidence {
  readonly context = new AsyncLocalStorage<{ id: string; closed: boolean }>();
  readonly violations: Array<{ operation: string; elapsedMs: number; boundMs: number }> = [];
  private next = 0;
  private readonly path: string;

  constructor() {
    mkdirSync('.temp/goal', { recursive: true });
    this.path = `.temp/goal/step-completion-${Bun.env.REZICS_QA_RUN_ID}-${process.pid}.jsonl`;
  }

  record(event: string, detail: object): void {
    const parent = this.context.getStore();
    appendFileSync(this.path, `${JSON.stringify({ time: new Date().toISOString(),
      run: Bun.env.REZICS_QA_RUN_ID, event, parent: parent?.id,
      parentCompleted: parent?.closed ?? false, ...detail })}\n`);
  }

  async measure<T>(operation: string, boundMs: number | null, run: () => Promise<T>): Promise<T> {
    const id = `step-${++this.next}`;
    const started = performance.now();
    const parent = this.context.getStore();
    this.record('start', { id, operation, boundMs });
    try {
      const result = await run();
      this.record('completed', { id, operation, elapsedMs: performance.now() - started });
      return result;
    } catch (error) {
      this.record('failed', { id, operation, elapsedMs: performance.now() - started,
        error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      const elapsedMs = performance.now() - started;
      if (boundMs !== null && elapsedMs > boundMs && parent && !parent.closed) {
        this.violations.push({ operation, elapsedMs, boundMs });
      }
    }
  }

  async publicCall(request: Request, handle: () => Promise<Response>): Promise<Response> {
    const caller = this.context.getStore()?.id;
    const parent = { id: `request-${++this.next}`, closed: false };
    return this.context.run(parent, () => this.measure(`${request.method} ${new URL(request.url).pathname}`, null,
      async () => {
        try {
          this.record('request', { method: request.method, url: request.url, caller,
            key: request.headers.get('idempotency-key'), body: await request.clone().text() });
          const response = await handle();
          // Observe the complete bytes on a clone; callers still consume the real response.
          this.record('response', { status: response.status, body: await response.clone().text() });
          return response;
        } finally { parent.closed = true; }
      }));
  }
}

class ObservedFuseki extends FusekiClient {
  constructor(url: string, private readonly evidence: CompletionEvidence) { super(url); }
  override query(...args: Parameters<FusekiClient['query']>): ReturnType<FusekiClient['query']> {
    return this.evidence.measure(`Fuseki query ${args[0]}`, 10_000, () => super.query(...args));
  }
  override command(envelope: CommandEnvelope): ReturnType<FusekiClient['command']> {
    return this.evidence.measure(`Fuseki command ${envelope.receipt}`, envelope.deadlineMs + 2_000,
      () => super.command(envelope));
  }
  override commandHealth(): ReturnType<FusekiClient['commandHealth']> {
    return this.evidence.measure('Fuseki command health', 10_000, () => super.commandHealth());
  }
}

type SourceApiCall = (method: string, path: string, token: string, body?: object, key?: string) => Promise<Response>;

async function sourceTitleProposal(call: SourceApiCall, token: string, workId: string, title: string): Promise<string> {
  const observed = await call('POST', '/v1/sources/acquisitions/open-library/works', token, {
    profile: 'open-library-work-acquisition-v1', workId,
  });
  expect(observed.status).toBe(201);
  const observation = (await observed.json() as { observation: { observation: string } }).observation.observation;
  const converted = await call('POST', `/v1/sources/observations/${observation.split('/').at(-1)}/conversions/open-library-work`,
    token, { profile: 'open-library-work-map-v1' });
  expect(converted.status).toBe(201);
  const conversion = (await converted.json() as { conversion: { conversion: string } }).conversion.conversion.split('/').at(-1)!;
  expect((await call('POST', `/v1/sources/conversions/${conversion}/source-graph`, token,
    { profile: 'source-open-library-work-v1' })).status).toBe(200);
  const response = await call('POST', `/v1/sources/conversions/${conversion}/proposals/native-work`, token,
    { profile: 'open-library-native-work-proposal-v1' });
  expect(response.status).toBe(201);
  const proposed = (await response.json() as { proposal: { proposal: string; candidateTitle: string } }).proposal;
  expect(proposed.candidateTitle).toBe(title);
  return proposed.proposal;
}

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

async function qualifyAuthenticatedSourceSteps(continuation: boolean): Promise<void> {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_DATABASE_URL
    || !Bun.env.ACCOUNT_MAIN_RESOURCE || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const evidence = new CompletionEvidence();
  evidence.record('scenario', { continuation });
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const server = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!evidence.context.getStore() || !url.startsWith(base)
      || !/\/api\/auth\/(jwks|oauth2\/introspect)$/.test(url)) return originalFetch(input, init);
    const started = performance.now();
    const operation = `Account ${new URL(url).pathname}`;
    evidence.record('account-start', { operation, boundMs: 3_000 });
    const onAbort = () => evidence.record('account-abort', {
      operation, elapsedMs: performance.now() - started });
    init?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await originalFetch(input, init);
      evidence.record('account-headers', { operation, status: response.status,
        elapsedMs: performance.now() - started });
      const json = response.json.bind(response);
      Object.defineProperty(response, 'json', { configurable: true, value: () => evidence.measure(operation,
        null, async () => {
          try { return await json(); }
          finally {
            init?.signal?.removeEventListener('abort', onAbort);
            const elapsedMs = performance.now() - started;
            evidence.record('account-body-completed', { operation, elapsedMs });
            if (elapsedMs > 3_000) evidence.violations.push({ operation, elapsedMs, boundMs: 3_000 });
          }
        }) });
      return response;
    } catch (error) {
      init?.signal?.removeEventListener('abort', onAbort);
      const elapsedMs = performance.now() - started;
      evidence.record('account-failed', { operation, elapsedMs });
      if (elapsedMs > 3_000) evidence.violations.push({ operation, elapsedMs, boundMs: 3_000 });
      throw error;
    }
  }) as typeof fetch;
  try {
    const signUp = async (name: string) => {
      const email = `source-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }),
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
    await grantRecordedPlatformUse(accessPool, principalId, ['catalogue-import', 'developer-extras']);
    const signedIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: member.email, password: member.password }),
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get('set-cookie')!;
    const tokenFor = async (scope: string, sessionCookie = cookie) =>
      (await signIn({
        account: base, clientId: client.client_id, redirectUri, scope,
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
      }, sessionCookie)).accessToken;
    const fullToken = await tokenFor(allowed);
    const readToken = await tokenFor('openid source:read');
    const sourceAdoptToken = await tokenFor('openid source:adopt source:read');
    const otherMember = await signUp('other');
    const otherPrincipalId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3)`, [otherPrincipalId, `${base}/api/auth`, otherMember.id]);
    await grantRecordedPlatformUse(accessPool, otherPrincipalId, ['catalogue-import']);
    const otherToken = await tokenFor('openid source:adopt source:read work:edit', otherMember.cookie);
    await migrateContent(contentPool);
    const sourceIntake = new SourceIntakeStore(contentPool);
    const fuseki = new ObservedFuseki(Bun.env.FUSEKI_URL!, evidence);
    const sourceConversions = new OpenLibraryConversionStore(contentPool, sourceIntake);
    const sourceGraph = new OpenLibrarySourceGraph(fuseki,
      { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! }, sourceConversions);
    const sourceProposals = new SourceNativeWorkProposalStore(contentPool, sourceGraph, sourceConversions);
    let failNextBinding = false;
    let failNextTitleBinding = false;
    let loseNextWithdrawalResponse = false;
    let failNextSourceFetch = false;
    const bindingFaultPool = new Proxy(contentPool, { get(target, property) {
      if (property === 'query') return (query: string, values: unknown[]) => {
        if (failNextBinding && query.includes('INSERT INTO source.native_work_binding')) {
          failNextBinding = false;
          throw new Error('injected post-graph binding write failure');
        }
        if (failNextTitleBinding && query.includes('INSERT INTO source.native_work_title_application')) {
          failNextTitleBinding = false;
          throw new Error('injected post-edit source application write failure');
        }
        if (loseNextWithdrawalResponse && query.includes('INSERT INTO source.native_work_support_withdrawal')) {
          loseNextWithdrawalResponse = false;
          return target.query(query, values).then(() => {
            throw new Error('injected lost committed withdrawal response');
          });
        }
        return target.query(query, values);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as Pool;
    const mainAccount = new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE!, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    const mainAccess = new AccessAdmissionRegistry(accessPool);
    // Intake authority is independent of the adoption actor's later mandate.
    const importAdministrator = `https://rezics.com/id/${randomUUID()}`;
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')",
      [importAdministrator]);
    await grantFixtureAuthority(accessPool, {
      scope: 'work:create:root', requireDispatch: true,
      representations: [{ principalId, actor: importAdministrator, action: 'work.create', lifetime: '8 hours' }],
      grant: { actor: importAdministrator, action: 'work.create', lifetime: '8 hours' },
    });
    const actor = `https://rezics.com/id/${randomUUID()}`;
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
    const authority = (scope: string, action: string) => grantFixtureAuthority(accessPool, {
      scope, requireDispatch: true,
      representations: [{ principalId, actor, action, lifetime: '8 hours' }],
      grant: { actor, action, lifetime: '8 hours' },
    });
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
    const workObjects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
      bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
      accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/source-attachment-test/' });
    await workObjects.initialize();
    const environment = { fuseki, workObjects,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! },
      objectDirectory: `.temp/source-auth-${randomUUID()}` };
    const sourceAdoptions = new SourceNativeWorkAdoptionStore(bindingFaultPool, sourceProposals,
      environment, mainAccount, mainAccess);
    const titles: Record<string, string> = { OL991401W: 'Source title refreshed',
      OL991402W: 'Conflicting title', OL991403W: 'Historical title acknowledgement',
      OL991404W: 'Historical title acknowledgement' };
    const app = createMainApp(fuseki, { environment,
      platformAccess: new AccessExposure(accessPool), account: mainAccount,
      access: mainAccess, actingContexts: new AccessActingContexts(accessPool), sourceIntake,
      sourceConversions, sourceGraph, sourceProposals, sourceAdoptions,
      sourceAttachments: new SourceNativeWorkAttachmentStore(attachmentFaultPool, sourceProposals,
        sourceAdoptions, environment, attachmentAccess),
      openLibraryFetch: (async (url: string) => {
        if (failNextSourceFetch) {
          failNextSourceFetch = false;
          return new Response('', { status: 503 });
        }
        const workId = url.split('/').at(-1)!.slice(0, -5);
        return new Response(JSON.stringify({ key: `/works/${workId}`, type: { key: '/type/work' },
          title: titles[workId] ?? 'Source title', revision: 1,
          description: { value: 'Source-only expression' },
          authors: [{ author: { key: '/authors/OL1A' } }], subjects: ['Source term'] }),
        { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const call = (method: string, path: string, token: string, body?: object,
      key = `source-${randomUUID()}`) => {
      const request = new Request(`http://main.local${path}`, {
        method, headers: { authorization: `Bearer ${token}`,
          ...(method === 'POST' ? { 'idempotency-key': key } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return evidence.publicCall(request, () => app.handle(request));
    };
    async function assertAttachmentCompletion(input: {
      call: SourceApiCall; pool: Pool; accessPool: Pool; fuseki: FusekiClient; adoption: NativeWorkSourceAdoption;
      humanRevision: string; actor: string; fullToken: string; readToken: string;
      sourceAdoptToken: string; otherToken: string; otherWork: string;
      loseNextAttachmentCommitResponse: () => void;
      beforeNextAuthority: (callback: () => Promise<void>) => void;
    }): Promise<void> {
      const { call, pool, adoption, fullToken, readToken } = input;
      const path = `/v2/works/${adoption.work.split('/').at(-1)}/source-supports`;
      const singular = `/v1/works/${adoption.work.split('/').at(-1)}/source-support`;
      const before = await (await call('GET', singular, readToken)).json();
      const title = 'Source title refreshed';
      const proposal = await sourceTitleProposal(call, fullToken, 'OL991401W', title);
      const different = await sourceTitleProposal(call, fullToken, 'OL991402W', 'Conflicting title');
      const body = { profile: 'native-work-source-title-attachment-v2', proposal,
        expectedHead: input.humanRevision, confirmedTitle: title, titleLanguage: 'en', actingSubject: input.actor };
      const key = `attachment-${randomUUID()}`;
      expect((await call('POST', path, readToken, body, key)).status).toBe(401);
      expect((await call('POST', path, input.sourceAdoptToken, body, key)).status).toBe(401);
      expect((await call('GET', path, input.otherToken)).status).toBe(404);
      expect((await call('POST', path, input.otherToken, body, key)).status).toBe(404);
      expect((await call('POST', path, fullToken, { ...body, proposal: adoption.proposal }, key)).status).toBe(409);
      expect((await call('POST', path, fullToken,
        { ...body, proposal: different, confirmedTitle: 'Conflicting title' }, key)).status).toBe(409);
      expect((await call('POST', path, fullToken, { ...body, expectedHead: adoption.workRevision }, key)).status).toBe(409);
      expect((await call('POST', path, fullToken,
        { ...body, actingSubject: `https://rezics.com/id/${randomUUID()}` }, key)).status).toBe(403);
      const scope = `work:edit:${adoption.work}`;
      const currentGrant = await authority(scope, 'work.edit');
      await reduceFixtureGrant(accessPool, currentGrant.grantId, { active: false });
      expect((await call('POST', path, fullToken, body, key)).status).toBe(403);
      await authority(scope, 'work.edit');

      input.loseNextAttachmentCommitResponse();
      const first = await call('POST', path, fullToken, body, key);
      expect(first.status).toBe(503);
      const retries = await Promise.all([call('POST', path, fullToken, body, key), call('POST', path, fullToken, body, key)]);
      for (const response of retries) expect(response.status).toBe(200);
      const saved = await retries[0]!.json() as { attachment: NativeWorkSourceAttachment; replayed: boolean };
      expect(await retries[1]!.json()).toEqual(saved);
      expect(saved).toMatchObject({ replayed: true, attachment: { originalBinding: adoption.binding,
        work: adoption.work, verifiedHead: input.humanRevision, title,
        headGuarantee: 'verified-before-commit', rightsStatus: 'undetermined',
        authority: { action: 'work.edit', scope, actingSubject: input.actor } } });
      expect(saved.attachment.binding).not.toBe(adoption.binding);
      expect(saved.attachment.sourceRecord).not.toBe(adoption.sourceRecord);
      expect((await call('POST', path, fullToken, body, `changed-${key}`)).status).toBe(409);
      expect((await call('POST', path, fullToken, { ...body, proposal: different }, key)).status).toBe(409);
      expect((await call('POST', `/v2/works/${input.otherWork.split('/').at(-1)}/source-supports`,
        fullToken, body, key)).status).toBe(409);
      // Attaching a proposal reserves it against later native adoption as well.
      expect((await call('POST', `/v1/sources/proposals/${proposal.split('/').at(-1)}/adoption/native-work`,
        fullToken, { profile: 'source-native-work-adoption-v1', actingSubject: input.actor,
          confirmedTitle: title, titleLanguage: 'en' })).status).toBe(409);
      expect(await (await call('GET', singular, readToken)).json()).toEqual(before);
      const budget = { signal: AbortSignal.timeout(15_000), callsLeft: 32, bytesLeft: 262_144 };
      const collection = await fusekiReadBudget.run(budget, () => call('GET', path, readToken));
      expect(collection.status).toBe(200);
      expect(collection.headers.get('cache-control')).toBe('no-store');
      const supports = await collection.json() as NativeWorkSupportCollection;
      expect(supports.supports).toHaveLength(2);
      expect(supports.supports[0]).toEqual({ kind: 'adoption', support: before });
      expect(supports.supports[1]).toMatchObject({ kind: 'attachment', support: {
        state: 'recorded', attachment: saved.attachment, currentHead: input.humanRevision,
        verifiedRevisionIsHead: true, withdrawal: null } });
      expect(32 - budget.callsLeft).toBeLessThanOrEqual(20);
      expect(262_144 - budget.bytesLeft).toBeLessThan(100_000);
      const exactPath = `${path}/${saved.attachment.binding.split('/').at(-1)}`;
      expect(await (await call('GET', exactPath, readToken)).json()).toEqual(supports.supports[1]);
      expect((await call('GET', exactPath, input.otherToken)).status).toBe(404);
      await expect(pool.query('UPDATE source.native_work_support_attachment SET title = $1 WHERE id = $2',
        ['Changed', saved.attachment.binding.split('/').at(-1)])).rejects.toThrow('immutable');

      // Force a human edit between completed Jena preflight and the Access/Source
      // lock envelope. The resulting attachment must explicitly remain historical.
      const raceTitle = 'Historical title acknowledgement';
      const raceProposal = await sourceTitleProposal(call, fullToken, 'OL991403W', raceTitle);
      const raceAdopted = await call('POST', `/v1/sources/proposals/${raceProposal.split('/').at(-1)}/adoption/native-work`,
        fullToken, { profile: 'source-native-work-adoption-v1', actingSubject: input.actor,
          confirmedTitle: raceTitle, titleLanguage: 'en' });
      expect(raceAdopted.status).toBe(201);
      const raceWork = (await raceAdopted.json() as { adoption: NativeWorkSourceAdoption }).adoption;
      const raceScope = `work:edit:${raceWork.work}`;
      await authority(raceScope, 'work.edit');
      const raceSecond = await sourceTitleProposal(call, fullToken, 'OL991404W', raceTitle);
      const racePath = `/v2/works/${raceWork.work.split('/').at(-1)}/source-supports`;
      let laterHead = '';
      input.beforeNextAuthority(async () => {
        const edit = await call('POST', '/v1/content-edits', fullToken,
          { profile: 'metadata-only-v1', work: raceWork.work, expectedHead: raceWork.workRevision,
            title: raceTitle, actingSubject: input.actor });
        expect(edit.status).toBe(200);
        laterHead = (await edit.json() as { revision: string }).revision;
      });
      const raceBody = { ...body, proposal: raceSecond, expectedHead: raceWork.workRevision, confirmedTitle: raceTitle };
      const raced = await Promise.all([call('POST', racePath, fullToken, raceBody, 'same-race-attachment'),
        call('POST', racePath, fullToken, raceBody, 'same-race-attachment')]);
      // Depending on preflight timing the second caller either replays or sees stale
      // native head. Exactly one immutable attachment is possible in both orders.
      expect(raced.filter(response => response.status === 201)).toHaveLength(1);
      expect(raced.every(response => [200, 201, 409].includes(response.status))).toBe(true);
      const raceCollection = await (await call('GET', racePath, readToken)).json() as NativeWorkSupportCollection;
      expect(raceCollection.currentHead).toBe(laterHead);
      expect(raceCollection.supports[1]).toMatchObject({ kind: 'attachment', support: {
        verifiedRevisionIsHead: false, attachment: { verifiedHead: raceWork.workRevision,
          headGuarantee: 'verified-before-commit' } } });
      expect((await pool.query('SELECT id FROM source.native_work_support_attachment WHERE work = $1', [raceWork.work])).rowCount).toBe(1);
    }
    if (continuation) {
      // Build the original applied support independently of the earlier controls.
      // Retained provider bytes, confirmed title and exact native head are the
      // same inputs as the original sequence, rather than seeded owner rows.
      const proposal = await sourceTitleProposal(call, fullToken, 'OL45804W', 'Source title');
      await authority('work:create:root', 'work.create');
      const adoptionBody = { profile: 'source-native-work-adoption-v1',
        actingSubject: actor, confirmedTitle: 'Source title', titleLanguage: 'en' };
      const adopted = await call('POST', `/v1/sources/proposals/${proposal.split('/').at(-1)}/adoption/native-work`,
        fullToken, adoptionBody);
      expect(adopted.status).toBe(201);
      const adoption = (await adopted.json() as { adoption: NativeWorkSourceAdoption }).adoption;
      expect(adoption).toMatchObject({ title: 'Source title', rightsStatus: 'undetermined',
        adoptedFields: ['title', 'semanticTypes'] });
      const refreshedBytes = Buffer.from(JSON.stringify({ key: '/works/OL45804W',
        type: { key: '/type/work' }, title: 'Source title refreshed', revision: 2,
        description: { value: 'Changed source-only expression' } }));
      const refreshed = await sourceIntake.submit(principalId, `source-refresh-${randomUUID()}`, {
        provider: 'open-library', namespace: 'work', externalId: 'OL45804W',
        sourceRevision: 'open-library-revision:2', mediaType: 'application/json', retention: 'retained',
        rawBytesBase64: refreshedBytes.toString('base64'),
        coverage: { scope: 'open-library-work-response-v1', complete: true, omittedFields: [] },
        rightsEvidence: { basis: 'unknown', note: '' },
      }, { profile: 'open-library-work-acquisition-v1', url: 'https://openlibrary.org/works/OL45804W.json',
        status: 200, etag: null, lastModified: null, fetchedAt: new Date().toISOString() });
      const converted = await sourceConversions.convert(principalId,
        refreshed.observation.observation.split('/').at(-1)!);
      const conversion = converted!.conversion.conversion.split('/').at(-1)!;
      await sourceGraph.project(principalId, conversion);
      const refreshedProposal = await sourceProposals.propose(principalId, conversion);
      const titlePath = `/v1/works/${adoption.work.split('/').at(-1)}/source-title-applications/`
        + refreshedProposal!.proposal.proposal.split('/').at(-1)!;
      const titleBody = { profile: 'native-work-source-title-application-v1',
        titleControl: { head: null, epoch: '0', protection: null }, expectedHead: adoption.workRevision,
        actingSubject: actor, confirmedTitle: 'Source title refreshed' };
      expect((await call('POST', titlePath, readToken, titleBody)).status).toBe(401);
      expect((await call('POST', titlePath, sourceAdoptToken, titleBody)).status).toBe(401);
      expect((await call('POST', titlePath, fullToken, titleBody)).status).toBe(403);
      await authority(`work:edit:${adoption.work}`, 'work.edit');
      await authority(`work:title:apply:${adoption.work}`, 'work.title.apply');
      await authority(`work:read:${adoption.work}`, 'work.read');
      failNextTitleBinding = true;
      expect((await call('POST', titlePath, fullToken, titleBody)).status).toBe(503);
      expect(failNextTitleBinding).toBe(false);
      expect((await contentPool.query('SELECT id FROM source.native_work_title_application WHERE work = $1',
        [adoption.work])).rowCount).toBe(0);
      expect((await fuseki.query(`PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        ASK { GRAPH <urn:rezics:graph:current> { <${adoption.work}>
          rdfs:label "Source title refreshed"@en . } }`)).boolean).toBe(true);
      const pending = await call('POST', `/v1/works/${adoption.work.split('/').at(-1)}/source-support/withdrawal`,
        sourceAdoptToken, { profile: 'native-work-source-support-withdrawal-v1', binding: adoption.binding,
          expectedSupport: adoption.binding, reason: 'Explicit withdrawal' });
      expect(pending.status).toBe(409);
      expect(await pending.json()).toMatchObject({ code: 'source_support_pending' });
      const appliedResponse = await call('POST', titlePath, fullToken, titleBody);
      expect(appliedResponse.status).toBe(200);
      const applied = await appliedResponse.json() as { application: NativeWorkSourceTitleApplication; replayed: boolean };
      expect(applied).toMatchObject({ replayed: true, application: {
        predecessor: adoption.workRevision, title: 'Source title refreshed', rightsStatus: 'undetermined' } });
      const edited = await call('POST', '/v1/content-edits', fullToken, { profile: 'metadata-only-v1',
        work: adoption.work, expectedHead: applied.application.workRevision,
        titleControl: (await readTitleControl(environment, adoption.work)).basis,
        title: 'Source title refreshed', actingSubject: actor });
      expect(edited.status).toBe(200);
      const humanRevision = (await edited.json() as { revision: string }).revision;
      const otherProposal = await sourceTitleProposal(call, fullToken, 'OL45805W', 'Source title');
      const otherResponse = await call('POST', `/v1/sources/proposals/${otherProposal.split('/').at(-1)}/adoption/native-work`,
        fullToken, adoptionBody);
      expect(otherResponse.status).toBe(201);
      const otherWork = (await otherResponse.json() as { adoption: NativeWorkSourceAdoption }).adoption.work;
      const attachmentProposal = await sourceTitleProposal(call, fullToken, 'OL991401W', 'Source title refreshed');
      const path = `/v2/works/${adoption.work.split('/').at(-1)}/source-supports`;
      const body = { profile: 'native-work-source-title-attachment-v2', proposal: attachmentProposal,
        expectedHead: humanRevision, confirmedTitle: 'Source title refreshed', titleLanguage: 'en', actingSubject: actor };
      const key = `attachment-${randomUUID()}`;
      expect((await call('POST', path, readToken, body, key)).status).toBe(401);
      expect((await call('POST', path, sourceAdoptToken, body, key)).status).toBe(401);
      expect((await call('POST', path, otherToken, body, key)).status).toBe(404);
      expect((await call('POST', path, fullToken, { ...body, expectedHead: adoption.workRevision }, key)).status).toBe(409);
      loseNextAttachmentCommitResponse = true;
      expect((await call('POST', path, fullToken, body, key)).status).toBe(503);
      const retries = await Promise.all([call('POST', path, fullToken, body, key), call('POST', path, fullToken, body, key)]);
      for (const response of retries) expect(response.status).toBe(200);
      const saved = await retries[0]!.json() as { attachment: NativeWorkSourceAttachment; replayed: boolean };
      expect(await retries[1]!.json()).toEqual(saved);
      expect(saved).toMatchObject({ replayed: true, attachment: { originalBinding: adoption.binding,
        work: adoption.work, verifiedHead: humanRevision, title: 'Source title refreshed',
        headGuarantee: 'verified-before-commit', rightsStatus: 'undetermined',
        authority: { action: 'work.edit', scope: `work:edit:${adoption.work}`, actingSubject: actor } } });
      expect(saved.attachment.binding).not.toBe(adoption.binding);
      expect(saved.attachment.sourceRecord).not.toBe(adoption.sourceRecord);
      const supportsResponse = await call('GET', path, readToken);
      expect(supportsResponse.status).toBe(200);
      const supports = await supportsResponse.json() as NativeWorkSupportCollection;
      expect(supports.supports).toHaveLength(2);
      expect(supports.supports[0]).toMatchObject({ kind: 'adoption', support: {
        state: 'recorded', supportIdentity: applied.application.application,
        latestApplication: applied.application, currentHead: humanRevision } });
      expect(supports.supports[1]).toMatchObject({ kind: 'attachment', support: {
        state: 'recorded', attachment: saved.attachment, currentHead: humanRevision,
        verifiedRevisionIsHead: true, withdrawal: null } });
      const exactPath = `${path}/${saved.attachment.binding.split('/').at(-1)}`;
      await assertSourceSupportWithdrawal({ call, pool: contentPool, fuseki, adoption,
        application: applied.application, humanRevision, sourceAdoptToken, readToken, fullToken,
        otherToken, otherWork, actor, titlePath, titleBody,
        failNextAcquisition: () => { failNextSourceFetch = true; },
        loseNextWithdrawalResponse: () => { loseNextWithdrawalResponse = true; } });
      evidence.record('continuation-start', { path, originalBinding: adoption.binding,
        attachment: saved.attachment.binding, humanRevision });
      // Exact attachment.finish() continuation: the withdrawn applied support
      // and independent recorded attachment must remain distinguishable.
      const afterAResponse = await call('GET', path, readToken);
      expect(afterAResponse.status).toBe(200);
      const afterA = await afterAResponse.json() as NativeWorkSupportCollection;
      expect(afterA.supports[0]).toMatchObject({ kind: 'adoption', support: { state: 'withdrawn' } });
      expect(afterA.supports[1]).toEqual(supports.supports[1]);
      const withdrawPath = `${exactPath}/withdrawal`;
      const intent = { profile: 'native-work-source-support-withdrawal-v2',
        expectedSupport: saved.attachment.binding, reason: 'Withdraw only this independent support' };
      expect((await call('POST', withdrawPath, readToken, intent, key)).status).toBe(401);
      expect((await call('POST', withdrawPath, otherToken, intent, key)).status).toBe(404);
      expect((await call('POST', withdrawPath, sourceAdoptToken,
        { ...intent, expectedSupport: adoption.binding }, key)).status).toBe(409);
      const withdrawals = await Promise.all([call('POST', withdrawPath, sourceAdoptToken, intent, key),
        call('POST', withdrawPath, sourceAdoptToken, intent, key)]);
      expect(withdrawals.map(response => response.status).sort()).toEqual([200, 201]);
      const receipts = await Promise.all(withdrawals.map(response => response.json())) as Array<{ withdrawal: object }>;
      expect(receipts[0]!.withdrawal).toEqual(receipts[1]!.withdrawal);
      expect((await call('POST', withdrawPath, sourceAdoptToken, intent, `changed-${key}`)).status).toBe(409);
      expect((await call('POST', path, fullToken, body, key)).status).toBe(200);
      const afterBResponse = await call('GET', path, readToken);
      expect(afterBResponse.status).toBe(200);
      const afterB = await afterBResponse.json() as NativeWorkSupportCollection;
      expect(afterB.currentHead).toBe(humanRevision);
      expect(afterB.supports[0]).toEqual(afterA.supports[0]);
      expect(afterB.supports[1]).toMatchObject({ kind: 'attachment', support: { state: 'withdrawn',
        attachment: saved.attachment, withdrawal: receipts[0]!.withdrawal } });
      const legacy = afterB.supports[0]!;
      if (legacy.kind !== 'adoption' || !legacy.support.withdrawal) throw new Error('missing v1 withdrawal');
      const replayA = await call('POST', `${path}/${adoption.binding.split('/').at(-1)}/withdrawal`,
        sourceAdoptToken, { profile: 'native-work-source-support-withdrawal-v2',
          expectedSupport: legacy.support.supportIdentity, reason: legacy.support.withdrawal.reason },
        (await contentPool.query('SELECT idempotency_key FROM source.native_work_support_withdrawal WHERE binding_id = $1',
          [adoption.binding.split('/').at(-1)])).rows[0].idempotency_key);
      expect(replayA.status).toBe(200);
      expect(await replayA.json()).toEqual({ kind: 'adoption', withdrawal: legacy.support.withdrawal, replayed: true });
      evidence.record('continuation-completed', { path });
      evidence.record('verdict', { violations: evidence.violations });
      expect(evidence.violations).toEqual([]);
      return;
    }
    const proposal = await sourceTitleProposal(call, fullToken, 'OL45804W', 'Source title');
    const adoptionPath = `/v1/sources/proposals/${proposal.split('/').at(-1)}/adoption/native-work`;
    const adoptionBody = { profile: 'source-native-work-adoption-v1',
      actingSubject: actor, confirmedTitle: 'Source title', titleLanguage: 'en' };
    expect((await call('POST', adoptionPath, readToken, adoptionBody)).status).toBe(401);
    expect((await call('POST', adoptionPath, sourceAdoptToken, adoptionBody)).status).toBe(401);
    expect((await call('POST', adoptionPath, fullToken,
      { ...adoptionBody, confirmedTitle: 'Different title' })).status).toBe(409);
    expect((await call('POST', adoptionPath, fullToken, adoptionBody)).status).toBe(403);
    expect((await contentPool.query('SELECT id FROM source.native_work_binding WHERE principal_id = $1',
      [principalId])).rowCount).toBe(0);
    await authority('work:create:root', 'work.create');
    failNextBinding = true;
    expect((await call('POST', adoptionPath, fullToken, adoptionBody)).status).toBe(503);
    expect(failNextBinding).toBe(false);
    expect((await contentPool.query('SELECT id FROM source.native_work_binding WHERE principal_id = $1',
      [principalId])).rowCount).toBe(0);
    expect((await fuseki.query(`PREFIX schema: <https://schema.org/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      ASK { GRAPH <urn:rezics:graph:current> { ?work a schema:CreativeWork ;
        rdfs:label "Source title"@en . } }`)).boolean).toBe(true);
    // The injected failure ran after native creation and before binding. With
    // no binding row, truthful replay must recover that exact committed Work.
    const adopted = await call('POST', adoptionPath, fullToken, adoptionBody);
    expect(adopted.status).toBe(200);
    const saved = await adopted.json() as { adoption: NativeWorkSourceAdoption; replayed: boolean };
    expect(saved).toMatchObject({ replayed: true, adoption: { title: 'Source title',
      adoptedFields: ['title', 'semanticTypes'], rightsStatus: 'undetermined' } });
    expect(await (await call('POST', adoptionPath, fullToken, adoptionBody)).json())
      .toEqual({ ...saved, replayed: true });
    expect((await call('GET', adoptionPath, readToken)).status).toBe(200);
    await authority(`work:edit:${saved.adoption.work}`, 'work.edit');
    await authority(`work:title:apply:${saved.adoption.work}`, 'work.title.apply');
    await authority(`work:read:${saved.adoption.work}`, 'work.read');
    // Attachment preflight needs the exact native head and confirmed title. A
    // real editor sets that title; the original attachment fixture remains intact.
    const edited = await call('POST', '/v1/content-edits', fullToken, {
      profile: 'metadata-only-v1', work: saved.adoption.work, expectedHead: saved.adoption.workRevision,
      titleControl: (await readTitleControl(environment, saved.adoption.work)).basis,
      title: 'Source title refreshed', actingSubject: actor,
    });
    expect(edited.status).toBe(200);
    const humanRevision = (await edited.json() as { revision: string }).revision;
    const otherProposal = await sourceTitleProposal(call, fullToken, 'OL45805W', 'Source title');
    const otherAdopted = await call('POST', `/v1/sources/proposals/${otherProposal.split('/').at(-1)}/adoption/native-work`,
      fullToken, adoptionBody);
    expect(otherAdopted.status).toBe(201);
    const otherWork = (await otherAdopted.json() as { adoption: NativeWorkSourceAdoption }).adoption.work;
    await assertAttachmentCompletion({ call, pool: contentPool, accessPool, fuseki,
      adoption: saved.adoption, humanRevision, actor, fullToken, readToken, sourceAdoptToken,
      otherToken, otherWork,
      beforeNextAuthority: callback => { beforeAttachmentAuthority = callback; },
      loseNextAttachmentCommitResponse: () => { loseNextAttachmentCommitResponse = true; } });
    evidence.record('verdict', { violations: evidence.violations });
    expect(evidence.violations).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    evidence.record('cleanup-start', {});
    await server.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
    evidence.record('cleanup-completed', {});
  }
}

test('LIVE13: applied-and-withdrawn Source support completes the independent attachment collection continuation',
  () => qualifyAuthenticatedSourceSteps(true), 60_000);

test('IAM10/LIVE01/LIVE02/LIVE03/LIVE05/LIVE13: authenticated Source attachment completes each bounded dependency and preserves race/replay receipts',
  () => qualifyAuthenticatedSourceSteps(false), 60_000);
