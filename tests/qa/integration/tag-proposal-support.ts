import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { RealmSubmissionStore } from '../../../services/main/src/modules/realm-submission/store.ts';
import { RealmSubmissionReads } from '../../../services/main/src/modules/realm-submission/reads.ts';
import { ManagementReadStore } from '../../../services/main/src/modules/management-reads/read-store.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';
import { startMediaStack } from './media-support.ts';

export const short = (id: string) => id.slice(-36);
export async function json<T>(response: Response, status = 201): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json() as Promise<T>;
}

export async function authorProposalFixture() {
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID!);
  const original = [Bun.env.ACCOUNT_DATABASE_URL, Bun.env.ACCESS_DATABASE_URL];
  Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
  Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
  let h: Awaited<ReturnType<typeof agentProvisionHarness>>;
  try { h = await agentProvisionHarness(); }
  catch (error) { await databases.close(); throw error; }
  finally { [Bun.env.ACCOUNT_DATABASE_URL, Bun.env.ACCESS_DATABASE_URL] = original; }
  const storage = await startMediaStack('author-proposals');
  let graphCalls = 0;
  const query = h.fuseki.query.bind(h.fuseki);
  h.fuseki.query = (...args) => { graphCalls++; return query(...args); };
  const access = new AccessAdmissionRegistry(h.accessPool);
  access.configureBaseline(h.fuseki);
  let oauthAllowed = true;
  const account = { verify: async (request: Request) => {
    if (!oauthAllowed) throw new AccountAssertionDenied('OAuth scope unavailable');
    return h.verifier.verify(request, ['agent:create']);
  } };
  const app = createMainApp(h.fuseki, { environment: h.env, account, access,
    realmAdmin: new AccessRealmManagement(h.accessPool),
    content: storage.content, contentAuthoring: storage.content,
    realmSubmissions: new RealmSubmissionStore(h.accessPool, access, h.env),
    realmSubmissionReads: new RealmSubmissionReads(h.accessPool),
    managementReads: new ManagementReadStore(h.accessPool, h.env) });
  const call = (method: string, path: string, body?: unknown, key = randomUUID()) => app.handle(new Request(
    `http://main.test${path}`, { method, headers: { authorization: `Bearer ${h.token}`,
      'content-type': 'application/json', 'idempotency-key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
  const agent = async () => (await json<{ agent: string }>(await h.call(h.main(), h.token, randomUUID(), {
    profile: 'agent-provision-v1', kind: 'person', displayName: 'Author proposals' }))).agent;
  const actor = await agent();
  await h.accessPool.query(`INSERT INTO access.scope_gate (id)
    VALUES ('classification:decide:global'), ('classification:define:global') ON CONFLICT DO NOTHING`);
  const principal = await account.verify(new Request('http://main.test', { headers: { authorization: `Bearer ${h.token}` } }));
  const work = async (actingSubject = actor) => {
    const { work, mainVersion, workRevision } = await json<{ work: string; mainVersion: string; workRevision: string }>(
      await call('POST', '/v1/works', { profile: 'metadata-only-v1', language: 'en', title: 'Whole serial', actingSubject }));
    return { work, mainVersion, workRevision };
  };
  const realm = async () => (await json<{ realm: string }>(await call('POST', '/v1/spaces', {
    profile: 'space-realm-v1', name: 'Author Realm', capabilities: ['realm'], actingSubject: actor }))).realm;
  const grant = async (agent: string, scope: string, action: string) => {
    const p = (await h.accessPool.query<{ id: string }>('SELECT id FROM access.principal WHERE account_issuer = $1 AND account_subject = $2',
      [principal.issuer, principal.subject])).rows[0]!.id;
    await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await h.accessPool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,now() + interval '1 hour') ON CONFLICT DO NOTHING`, [randomUUID(), p, agent, action]);
    await h.accessPool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), agent, scope, action]);
  };
  const publish = async (resource: string, makePublic = true) => {
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const draft = await json<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(await call('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: resource, variantId: variant, actingSubject: actor, expectedHead: null,
      body: 'A chapter published after adoption.', language: { kind: 'tag', tag: 'zh', originalTag: 'zh' }, direction: 'ltr' }));
    const exact = (await storage.content.readExactBatch([draft.revisionId], async ids => new Set(ids)))[0]!;
    if (exact.status !== 'available') throw new Error('Content draft unavailable');
    const publication = await json<{ decision: string }>(await call('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: randomUUID(), revisionId: draft.revisionId,
      expectedDigest: exact.reference.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
      resourceId: resource, variantId: variant, expectedPublicationHead: null, actingSubject: actor }));
    if (makePublic) await json(await call('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', resourceId: resource, variantId: variant,
      publicationDecision: publication.decision, expectedEligibilityHead: null, actingSubject: actor,
      rightsBasis: 'original-contribution', disclosure: 'public' }));
    return { variant, publicationDecision: publication.decision, contentRevision: draft.revisionId };
  };
  return { ...h, storage, access, app, actor, principal, call, work, realm, agent, grant, publish,
    graphCalls: () => graphCalls,
    oauth: (allowed: boolean) => { oauthAllowed = allowed; },
    close: async () => { await storage.stop(); await h.close(); await databases.close(); } };
}
