import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { memberFixture, nativeId } from './member-reply-fixture.ts';
import { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { createMainApp } from '../src/app.ts';
import { AccessRealmManagement } from '../src/modules/access/realm-management.ts';
import { RealmSubmissionStore } from '../src/modules/realm-submission/store.ts';
import type { RealmVisibility, RealmReviewMode } from '../src/modules/space/policy.ts';

export async function realmVisibilityFixture() {
  const h = await memberFixture();
  expect((await h.post('/v1/publication-selections', h.selection)).status).toBe(201);
  const created = await h.post('/v1/spaces', { profile: 'space-realm-v1', name: 'Visibility Realm',
    capabilities: ['realm'], actingSubject: h.actor });
  expect(created.status).toBe(201);
  const realm = created.body.realm as string;
  const principal = await h.principal();
  const principalId = await h.access.activePrincipalId(principal);
  const admin = new AccessRealmManagement(h.accessPool);
  await admin.initialize(principal, realm, h.actor, h.env);
  const submissions = new RealmSubmissionStore(h.accessPool, h.access, h.env);
  const app = createMainApp(h.fuseki, { environment: h.env, account: { verify: request => h.verifier.verify(request, ['work:read']) }, access: h.access,
    contentAuthoring: h.content, content: h.content, realmReplies: h.replies, realmAdmin: admin,
    realmSubmissions: submissions, discovery: new DiscoveryProjection(h.accessPool) });
  const root = `/v1/realms/${realm.slice(-36)}`;
  const call = async (method: string, path: string, body?: object, actor: string | null = h.actor, key = randomUUID()) => {
    const url = new URL(`http://main.local${path}`);
    if (method === 'GET' && actor) url.searchParams.set('actingSubject', actor);
    const response = await app.handle(new Request(url, { method, headers: {
      ...(actor ? { authorization: `Bearer ${h.token}` } : {}),
      'content-type': 'application/json', 'idempotency-key': key }, body: body ? JSON.stringify(body) : undefined }));
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
  };
  const grant = async (actor: string, scope: string, action: string) => {
    await h.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await h.accessPool.query(`INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,now()+interval '1 hour')`, [randomUUID(),actor,scope,action]);
    await h.accessPool.query(`INSERT INTO access.representation
      (id,principal_id,subject_id,action,valid_until) VALUES ($1,$2,$3,$4,now()+interval '1 hour')`,
    [randomUUID(),principalId,actor,action]);
  };
  for (const actor of [h.actor,h.pen]) await grant(actor, `submission:submit:${realm}`, 'submission.submit');
  const settingsInput = async (visibility: RealmVisibility, reviewMode: RealmReviewMode) => {
    const current = await call('GET', `${root}/settings`);
    expect(current.status, JSON.stringify(current.body)).toBe(200);
    return { actingSubject: h.actor, expectedGeneration: current.body.generation,
      expectedRulesRevision: current.body.ruleBasis.revision, reason: 'Change community policy',
      settings: { visibility, reviewMode, reviewRequired: reviewMode === 'mandatory', whoMaySubmit: 'granted', rules: [] } };
  };
  const policy = async (visibility: RealmVisibility, mode: RealmReviewMode) => {
    const result = await call('PUT', `${root}/settings`, await settingsInput(visibility, mode));
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return result;
  };
  const draftInput = (actor = h.actor, originRealm: string | null = realm) => ({
    profile: 'member-reply-draft-v1', reply: nativeId(), variantId: `urn:rezics:variant:${randomUUID()}`,
    originRealm, rootTarget: h.work.work, rootRevision: h.first.draftRevision, language: 'en', direction: 'ltr',
    expectedHead: null, body: 'Realm discussion secret', actingSubject: actor });
  const reply = async (actor = h.actor, originRealm: string | null = realm) => {
    const input = draftInput(actor, originRealm);
    const draft = await call('POST', '/v1/member-reply-drafts', input, actor);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const identity = await call('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply: input.reply,
      variantId: input.variantId, revisionId: draft.body.revisionId, author: actor,
      rootTarget: input.rootTarget, rootRevision: input.rootRevision,
      parentReply: null, parentRevision: null, contextRevision: null }, actor);
    expect(identity.status, JSON.stringify(identity.body)).toBe(201);
    const bytes = (await h.contentPool.query('SELECT byte_digest FROM content.revision WHERE id=$1',
      [draft.body.revisionId])).rows[0].byte_digest;
    const placement = { profile: 'realm-reply-placement-v1', realm, reply: input.reply,
      revisionId: draft.body.revisionId, revisionDigest: bytes, reviewDecisionId: null,
      expectedHead: null, actingSubject: actor };
    return { input, draft, placement, path: `/v1/member-replies/${input.reply.slice(-36)}` };
  };
  const submit = async (actor = h.actor) => {
    const candidate = await h.contribution(`Policy submission ${randomUUID()}`, actor);
    const input = { actingSubject: actor, kind: 'contribution' as const, work: h.work.work, mainVersion: h.work.mainVersion, contribution: candidate.contribution,
      publicationDecision: candidate.publicationDecision, selectedDraft: candidate.draftRevision, correctionOf: null };
    const body = input;
    const key = randomUUID();
    return { input: body, key, result: await call('POST', `${root}/submissions`, body, actor, key) };
  };
  return { ...h, realm, principal, principalId, admin, app, root, call, grant, settingsInput, policy, draftInput, reply, submit };
}
