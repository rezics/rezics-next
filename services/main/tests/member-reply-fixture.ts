import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { Pool } from 'pg';
import { agentProvisionHarness } from '../../../tests/qa/integration/agent-provision-support.ts';
import { cloneQaAccountAccessDatabases } from '../../../tests/qa/support/databases.ts';
import { ContentCore } from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { createMainApp } from '../src/app.ts';
import { AccessAdmissionRegistry } from '../src/modules/access/admission.ts';
import { RealmReplyContentStore } from '../src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../src/modules/realm-reply/store.ts';
import { WorkMaintainers } from '../src/modules/work/maintainers.ts';

const scopes = ['agent:create', 'work:create', 'work:edit', 'work:read', 'comment:create',
  'space:create', 'realm:adopt'];
export const nativeId = () => `https://rezics.com/id/${randomUUID()}`;

export async function memberFixture() {
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID!);
  const prior = { account: Bun.env.ACCOUNT_DATABASE_URL, access: Bun.env.ACCESS_DATABASE_URL };
  Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
  Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
  let h: Awaited<ReturnType<typeof agentProvisionHarness>>;
  try { h = await agentProvisionHarness(scopes); }
  catch (error) { await databases.close(); throw error; }
  finally { Bun.env.ACCOUNT_DATABASE_URL = prior.account; Bun.env.ACCESS_DATABASE_URL = prior.access; }
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  await migrateContent(contentPool);
  const content = new ContentCore(contentPool);
  const access = new AccessAdmissionRegistry(h.accessPool);
  access.configureBaseline(h.fuseki);
  const owner = new RealmReplyContentStore(contentPool);
  const replies = new RealmReplyStore(owner, content, access, h.env);
  const maintainers = new WorkMaintainers(h.accessPool, h.env);
  const app = createMainApp(h.fuseki, { environment: h.env, account: h.verifier,
    access, contentAuthoring: content, content, realmReplies: replies, maintainers });
  await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
  const signIn = await fetch(`${h.base}/api/auth/sign-in/email`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: h.base },
    body: JSON.stringify({ email: h.user.email, password: h.user.password }) });
  expect(signIn.status).toBe(200);
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${h.base}/api/auth/oauth2/authorize`);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: h.client.client_id,
    redirect_uri: h.redirectUri, scope: `openid ${scopes.join(' ')}`, state: randomUUID(),
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
  const authorized = await fetch(authorize, { headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
  expect(authorized.status).toBe(302);
  const exchange = await fetch(`${h.base}/api/auth/oauth2/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: h.client.client_id,
      code: new URL(authorized.headers.get('location')!).searchParams.get('code')!,
      redirect_uri: h.redirectUri, code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE! }) });
  expect(exchange.status).toBe(200);
  const token = (await exchange.json() as { access_token: string }).access_token;
  async function agent(name: string, kind: 'person' | 'organization' = 'person') {
    const response = await h.call(h.main(), token, randomUUID(), {
      profile: 'agent-provision-v1', kind, displayName: name });
    expect(response.status).toBe(201);
    return (await response.json() as { agent: string }).agent;
  }
  const actor = await agent('Member');
  const pen = await agent('Pen name');
  async function post(path: string, body: object, key = randomUUID()) {
    const response = await app.handle(new Request(`http://main.local${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  async function get(path: string) {
    const response = await app.handle(new Request(`http://main.local${path}`, {
      headers: { authorization: `Bearer ${token}` } }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  const workBody = { profile: 'metadata-only-v1', language: 'en', title: `Member Work ${randomUUID()}`, actingSubject: actor };
  const workKey = randomUUID();
  const created = await post('/v1/works', workBody, workKey);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const work = created.body as { work: string; mainVersion: string; workRevision: string };
  async function contribution(body = 'A public contribution.', author = actor) {
    const draft = await post('/v1/contributions', { profile: 'text-contribution-v1',
      work: work.work, language: 'en', body, actingSubject: author });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const published = await post('/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: draft.body.contribution, expectedDraftHead: draft.body.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: author });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    return { contribution: draft.body.contribution as string, draftRevision: draft.body.draftRevision as string,
      publicationDecision: published.body.publicationDecision as string };
  }
  const first = await contribution();
  const selection = { profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: first.contribution, publicationDecision: first.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor };
  return { ...h, contentPool, content, access, owner, replies, maintainers, app, token, actor, pen,
    post, get, work, first, selection, contribution, workBody, workKey, agent,
    principal: () => h.verifier.verify(new Request('http://main.local', { headers: { authorization: `Bearer ${token}` } }), ['work:edit']),
    close: async () => { await contentPool.end(); await h.close(); await databases.close(); } };
}
