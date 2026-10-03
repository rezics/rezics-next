import { replacementController } from './g-523-controller-fixture.ts';
import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry, AdmissionDenied, AdmissionConflict, type AdmissionRequest }
  from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { receiptFamilyFor } from '../../../services/main/src/modules/access/receipt-families.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { RealmSubmissionReads } from '../../../services/main/src/modules/realm-submission/reads.ts';
import { RealmSubmissionStore } from '../../../services/main/src/modules/realm-submission/store.ts';
import { WorkMaintainers } from '../../../services/main/src/modules/work/maintainers.ts';
import { allocateAgentHandle } from '../../../services/main/src/modules/agent/handle.ts';
import { NameRegistry } from '../../../services/main/src/modules/address/registry.ts';
import { MediaAccessBatchReader } from '../../../services/main/src/modules/media/access-batch.ts';
import { StudioAccess } from '../../../services/main/src/modules/studio/access.ts';
import { createAdmittedTextContribution } from '../../../services/main/src/modules/contribution/create-admitted.ts';
import { publishAdmittedTextContribution } from '../../../services/main/src/modules/contribution/publish-admitted.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { agentProvisionHarness } from './agent-provision-support.ts';
import { startMediaStack, png, sha } from './media-support.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const short = (s: string) => s.slice(-36);

async function fixture() {
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID!);
  const original = [Bun.env.ACCOUNT_DATABASE_URL, Bun.env.ACCESS_DATABASE_URL];
  Bun.env.ACCOUNT_DATABASE_URL = databases.urls.account;
  Bun.env.ACCESS_DATABASE_URL = databases.urls.access;
  let h: Awaited<ReturnType<typeof agentProvisionHarness>>;
  try { h = await agentProvisionHarness(); }
  catch (error) { await databases.close(); throw error; }
  finally { [Bun.env.ACCOUNT_DATABASE_URL, Bun.env.ACCESS_DATABASE_URL] = original; }
  const storage = await startMediaStack('author-baseline');
  const access = new AccessAdmissionRegistry(h.accessPool);
  access.configureBaseline(h.fuseki);
  // Account introspection stays real. OAuth consent ceilings have their own
  // baseline/IAM tests; this fixture token carries agent:create only.
  const account = { verify: (request: Request) => h.verifier.verify(request, ['agent:create']) };
  const app = createMainApp(h.fuseki, { environment: h.env, account, access,
    content: storage.content, contentAuthoring: storage.content, media: storage.media,
    mediaAccess: new MediaAccessBatchReader(h.accessPool, h.fuseki),
    studioAccess: new StudioAccess(h.accessPool, h.fuseki),
    profiles: new ProfilesAccess(h.accessPool), personPreferences: new PersonPreferencesStore(h.accessPool), actingContexts: new AccessActingContexts(h.accessPool, h.env),
    realmSubmissions: new RealmSubmissionStore(h.accessPool, access, h.env),
    realmSubmissionReads: new RealmSubmissionReads(h.accessPool) });
  const request = () => new Request('http://main.test', { headers: { authorization: `Bearer ${h.token}` } });
  const call = (method: string, path: string, body?: unknown, key = randomUUID()) => app.handle(new Request(
    `http://main.test${path}`, { method, headers: { authorization: `Bearer ${h.token}`,
      'content-type': 'application/json', 'idempotency-key': key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  async function agent(kind: 'person' | 'organization' = 'person') {
    const response = await h.call(h.main(), h.token, randomUUID(), {
      profile: 'agent-provision-v1', kind, displayName: 'Author baseline' });
    expect(response.status).toBe(201);
    return (await response.json() as { agent: string }).agent;
  }
  await h.accountPool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [h.user.id]);
  const actor = await agent();
  const principal = await account.verify(request());
  async function work(actingSubject = actor) {
    const response = await call('POST', '/v1/works', { profile: 'metadata-only-v1', authoring: 'own-work', language: 'en',
      title: 'Author Work', actingSubject });
    expect(response.status).toBe(201);
    return response.json() as Promise<{ work: string; mainVersion: string; workRevision: string }>;
  }
  async function contribution(work: string) {
    const draft = await createAdmittedTextContribution(h.env, account, access, request(), {
      work, language: 'en', body: 'An original author contribution.', actingSubject: actor,
      idempotencyKey: randomUUID() });
    const publication = await publishAdmittedTextContribution(h.env, account, access, request(), {
      contribution: draft.contribution!, expectedDraftHead: draft.draftRevision!, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor, idempotencyKey: randomUUID() });
    return { contribution: draft.contribution!, publicationDecision: publication.publicationDecision!,
      selectedDraft: draft.draftRevision! };
  }
  const admit = (action: string, scope: string, extra: Partial<AdmissionRequest> = {}) => access.register({
    principal, actingSubject: actor, action, scope, idempotencyKey: randomUUID(), requestDigest: digest(scope), ...extra });
  return { ...h, access, storage, app, actor, principal, account, request, call, agent, work, contribution, admit,
    close: async () => { await storage.stop(); await h.close(); await databases.close(); } };
}

test('author baseline: metadata, own libraries, handles and narrow resource admissions without grants', async () => {
  const h = await fixture();
  try {
    const work = await h.work();
    const other = await h.agent();
    const otherWork = await h.work(other);
    const covers = new MediaAccessBatchReader(h.accessPool, h.fuseki);
    expect(await covers.canReadWorks(h.principal, h.actor, [work.work, otherWork.work]))
      .toEqual(new Set([work.work]));
    const authority = await h.access.withWorkEditAuthority(h.principal, h.actor, work.work, async proof => proof);
    expect(authority.grantId).toBeNull();
    expect(authority.baseline).toMatchObject({ kind: 'author-baseline-v1', workGeneration: '0' });
    await expect(h.access.withWorkEditAuthority(h.principal, h.actor, otherWork.work, async () => true))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const metadata = { profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: h.actor,
      state: { kind: 'header', originalTitle: null, localized: [{ language: 'en', title: 'Edited title',
        description: 'Author description', mainVersionLabel: null }] } };
    const edited = await h.call('PUT', `/v1/works/${short(work.work)}/metadata`, metadata);
    expect(edited.status).toBe(200);
    expect((await h.call('PUT', `/v1/works/${short(otherWork.work)}/metadata`, metadata)).status).toBe(403);
    const contribution = await h.contribution(work.work);
    const library = await h.call('GET', `/v1/me/contributions?actingSubject=${encodeURIComponent(h.actor)}`);
    expect(library.status).toBe(200);
    expect((await library.json() as { items: { id: string }[] }).items.map(row => row.id)).toContain(contribution.contribution);
    expect((await h.call('GET', `/v1/me/contributions?actingSubject=${encodeURIComponent(id())}`)).status).toBe(403);
    const contexts = new AccessActingContexts(h.accessPool, h.env);
    const handle = allocateAgentHandle(h.actor);
    expect((await contexts.discover(h.principal)).contexts.find(row => row.actingSubject === h.actor)?.handle)
      .toBe(handle);
    const vanity = `writer_${randomUUID().slice(0, 8)}`;
    const names = new NameRegistry(h.accessPool);
    await h.access.withOwnerAuthority({ principal:h.principal,actingSubject:h.actor,
      scope:`agent:control:${h.actor}`,action:'agent.control' },client => names.write(client,h.principal,{
      scope:'agent',holder:h.actor,actingSubject:h.actor,operation:'claim',name:vanity,expectedRevision:null,idempotencyKey:randomUUID(),
    },h.actor));
    expect((await contexts.discover(h.principal)).contexts.find(row => row.actingSubject === h.actor)?.handle).toBe(vanity);
    expect((await contexts.checkContentDraft(h.principal, work.work, h.actor, '0')).decision).toBe('eligible-now');
    for (const [action, prefix] of [['work.edit', 'work:edit'], ['content.draft', 'content:draft'],
      ['content.publish', 'content:publish'], ['content.search-eligibility', 'content:search-eligibility'],
      ['media.avatar', 'media:avatar']] as const) {
      const admitted = await h.admit(action, `${prefix}:${work.work}`);
      expect(admitted.dispatchEligible).toBe(true);
      await expect(h.admit(action, `${prefix}:${otherWork.work}`)).rejects.toBeInstanceOf(AdmissionDenied);
      await expect(h.admit(action, `${prefix}:${work.work}`, { actingSubject: other })).rejects.toBeInstanceOf(AdmissionDenied);
      await expect(h.admit(action, `${prefix}:${work.work}`, { principal: { ...h.principal, emailVerified: false } }))
        .rejects.toBeInstanceOf(AdmissionDenied);
    }
    expect((await h.admit('media.upload', `media:owner:${h.actor}`)).dispatchEligible).toBe(true);
    await expect(h.admit('media.upload', `media:owner:${other}`)).rejects.toBeInstanceOf(AdmissionDenied);
    // Provisioning grants only recipient consent; author operations still rely
    // on the baseline instead of manufactured resource permissions.
    expect((await h.accessPool.query('SELECT action,scope_id FROM access.permission_grant WHERE recipient_subject = $1',
      [h.actor])).rows).toEqual([{ action: 'access.membership.consent',scope_id: 'work:create:root' }]);
    await h.access.closeScope(`content:publish:${work.work}`, '0');
    await expect(h.admit('content.publish', `content:publish:${work.work}`)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.accessPool.query('SELECT open FROM access.scope_gate WHERE id = $1',
      [`content:publish:${work.work}`])).rows[0]?.open).toBe(false);
    const suspended = await Promise.all([
      ['work.edit', `work:edit:${work.work}`], ['content.draft', `content:draft:${work.work}`],
      ['content.publish', `content:publish:${otherWork.work}`],
      ['content.search-eligibility', `content:search-eligibility:${work.work}`],
      ['media.avatar', `media:avatar:${work.work}`], ['media.upload', `media:owner:${h.actor}`],
    ].map(([action, scope]) => h.admit(action!, scope!, action === 'content.publish' ? { actingSubject: other } : {})));
    await h.accountPool.query(`UPDATE rezics_account_security SET suspended_at = now(), generation = generation + 1
      WHERE user_id = $1`, [h.user.id]);
    expect((await h.call('GET', `/v1/me/contributions?actingSubject=${encodeURIComponent(h.actor)}`)).status).toBe(401);
    expect((await h.call('PUT', `/v1/works/${short(work.work)}/metadata`, metadata)).status).toBe(401);
    await expect(h.access.withWorkEditAuthority(h.principal, h.actor, work.work, async () => true))
      .rejects.toBeInstanceOf(AdmissionDenied);
    for (const pending of suspended) {
      await expect(h.access.claim(pending.id, pending.requestDigest, h.principal)).rejects.toBeInstanceOf(AdmissionDenied);
    }
  } finally { await h.close(); }
}, 120_000);

test('author baseline: transfer fences registered and claimed commands; restored membership cannot revive a ticket', async () => {
  const h = await fixture();
  try {
    const work = await h.work();
    const organization = await h.agent('organization');
    const maintainers = new WorkMaintainers(h.accessPool, h.env);
    const commands = await Promise.all([
      ['work.edit', 'work:edit'], ['content.draft', 'content:draft'], ['content.publish', 'content:publish'],
      ['content.search-eligibility', 'content:search-eligibility'], ['media.avatar', 'media:avatar'],
    ].map(([action, prefix]) => h.admit(action!, `${prefix}:${work.work}`)));
    const claimed = commands[0]!;
    await h.access.claim(claimed.id, claimed.requestDigest, h.principal);
    const move = { work: work.work, actingSubject: h.actor, target: organization,
      action: 'transfer' as const, expectedGeneration: '0' };
    await expect(maintainers.change(h.principal, move, randomUUID())).rejects.toBeInstanceOf(AdmissionConflict);
    await h.access.recordGraphOutcome(claimed.id, { outcome: 'cancelled', admissionId: claimed.id,
      requestDigest: claimed.requestDigest, authorityEpoch: claimed.authorityEpoch, scope: claimed.scope,
      receipt: `urn:rezics:receipt:${digest(`${claimed.id}\0${receiptFamilyFor(claimed.action)}`)}`,
      dataEpoch: h.env.lineage.dataEpoch, sequence: '1' });
    expect((await maintainers.change(h.principal, move, randomUUID())).generation).toBe('1');
    await expect(h.access.withWorkEditAuthority(h.principal, h.actor, work.work, async () => true))
      .rejects.toBeInstanceOf(AdmissionDenied);
    for (const command of commands.slice(1)) {
      await expect(h.access.claim(command.id, command.requestDigest, h.principal)).rejects.toBeInstanceOf(AdmissionDenied);
      await expect(h.admit(command.action, command.scope)).rejects.toBeInstanceOf(AdmissionDenied);
    }
    await maintainers.change(h.principal, { ...move, actingSubject: organization, target: h.actor,
      expectedGeneration: '1' }, randomUUID());
    for (const command of commands.slice(1)) {
      await expect(h.access.claim(command.id, command.requestDigest, h.principal)).rejects.toBeInstanceOf(AdmissionDenied);
    }
    expect((await h.admit('work.edit', `work:edit:${work.work}`)).dispatchEligible).toBe(true);
    await h.fuseki.update(`INSERT DATA { GRAPH <urn:rezics:graph:current> {
      <${work.work}> <https://rezics.com/vocab/protectionHead> <${id()}> } }`);
    await expect(h.admit('work.edit', `work:edit:${work.work}`)).rejects.toBeInstanceOf(AdmissionDenied);
    await replacementController(h.accessPool, h.actor);
    await h.accessPool.query(`UPDATE access.representation SET active = false,generation = generation + 1
      WHERE subject_id = $1 AND principal_id = (SELECT id FROM access.principal
        WHERE account_issuer = $2 AND account_subject = $3) AND action = 'agent.control'`,
      [h.actor, h.principal.issuer, h.principal.subject]);
    await expect(h.admit('work.edit', `work:edit:${work.work}`)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.call('GET', `/v1/my/submissions?actingSubject=${encodeURIComponent(h.actor)}`)).status).toBe(404);
  } finally { await h.close(); }
}, 120_000);

test('author baseline: public author submissions preserve Realm review, isolation and live bans', async () => {
  const h = await fixture();
  try {
    const work = await h.work();
    const candidate = await h.contribution(work.work);
    const response = await h.call('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Authors Realm',
      capabilities: ['realm'], actingSubject: h.actor });
    expect(response.status).toBe(201);
    const realm = (await response.json() as { realm: string }).realm;
    const submission = { ...candidate, work: work.work, mainVersion: work.mainVersion,
      actingSubject: h.actor, kind: 'contribution', correctionOf: null };
    const path = `/v1/realms/${short(realm)}/submissions`;
    const key = randomUUID();
    const submitted = await h.call('POST', path, submission, key);
    expect(submitted.status, await submitted.clone().text()).toBe(201);
    const opened = await submitted.json() as { submission: { id: string; revision: string; state: string } };
    expect(opened.submission.state).toBe('pending');
    expect((await h.call('POST', path, submission, key)).status).toBe(200);
    const mine = await h.call('GET', `/v1/my/submissions?actingSubject=${encodeURIComponent(h.actor)}`);
    expect(mine.status).toBe(200);
    expect((await mine.json() as { items: unknown[] }).items).toHaveLength(1);
    const detail = await h.call('GET', `/v1/me/agents/${short(h.actor)}/works/${short(work.work)}`);
    expect(detail.status, await detail.clone().text()).toBe(200);
    expect(await detail.json()).toMatchObject({ item: { id: work.work,
      submissions: [{ id: opened.submission.id, state: 'pending' }] } });
    const other = await h.agent();
    expect((await h.call('POST', path, { ...submission, actingSubject: other })).status).toBe(403);
    const withdrawPath = `${path}/${opened.submission.id}/withdrawals`;
    await expect(h.admit('submission.withdraw', `submission:submit:${realm}`))
      .rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.call('POST', withdrawPath, { actingSubject: other,
      expectedRevision: opened.submission.revision })).status).toBe(403);
    const withdrawal = await h.call('POST', withdrawPath, { actingSubject: h.actor,
      expectedRevision: opened.submission.revision });
    expect(withdrawal.status, await withdrawal.clone().text()).toBe(200);
    expect((await withdrawal.json() as { submission: { state: string } }).submission.state).toBe('withdrawn');
    await expect(h.admit('submission.submit', `submission:submit:${realm}`)).rejects.toBeInstanceOf(AdmissionDenied);
    const pending = await h.admit('submission.submit', `submission:submit:${realm}`,
      { baselineContribution: candidate.contribution });
    await h.accessPool.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1) ON CONFLICT DO NOTHING', [realm]);
    await h.accessPool.query(`INSERT INTO access.realm_admin_settings (realm,who_may_submit,visibility,review_mode)
      VALUES ($1,'closed','public','mandatory') ON CONFLICT (realm) DO UPDATE SET who_may_submit = 'closed'`, [realm]);
    await expect(h.access.claim(pending.id, pending.requestDigest, h.principal)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.call('POST', path, submission)).status).toBe(403);
    await h.accessPool.query("UPDATE access.realm_admin_settings SET who_may_submit = 'granted' WHERE realm = $1", [realm]);
    const beforeTransfer = await h.admit('submission.submit', `submission:submit:${realm}`,
      { baselineContribution: candidate.contribution });
    const organization = await h.agent('organization');
    await new WorkMaintainers(h.accessPool, h.env).change(h.principal, { work: work.work,
      actingSubject: h.actor, target: organization, expectedGeneration: '0', action: 'transfer' }, randomUUID());
    expect(await new MediaAccessBatchReader(h.accessPool, h.fuseki)
      .canReadWorks(h.principal, h.actor, [work.work])).toEqual(new Set());
    await expect(h.access.claim(beforeTransfer.id, beforeTransfer.requestDigest, h.principal)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await h.call('POST', path, submission)).status).toBe(403);
  } finally { await h.close(); }
}, 120_000);

test('author baseline: exact Content publication and search eligibility use resource gates; uploads need no grants', async () => {
  const h = await fixture();
  try {
    const work = await h.work();
    const variant = `urn:rezics:variant:${randomUUID()}`;
    const saved = await h.call('POST', '/v1/content-drafts', { profile: 'content-text-v1',
      resourceId: work.work, variantId: variant, actingSubject: h.actor, expectedHead: null,
      body: 'Original Content author text.', language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const draft = await saved.json() as { revisionId: string; sourcePosition: { dataEpoch: string } };
    const exact = (await h.storage.content.readExactBatch([draft.revisionId!], async ids => new Set(ids)))[0]!;
    if (exact.status !== 'available') throw new Error('draft unavailable');
    const publication = await h.call('POST', '/v1/content-publications', { profile: 'content-publication-v1',
      preparationId: randomUUID(), revisionId: draft.revisionId, expectedDigest: exact.reference.byteDigest,
      expectedContentEpoch: draft.sourcePosition.dataEpoch, resourceId: work.work, variantId: variant,
      expectedPublicationHead: null, actingSubject: h.actor });
    expect(publication.status).toBe(201);
    const published = await publication.json() as { decision: string; status: string };
    expect(published.status, JSON.stringify(published)).toBe('active');
    const eligibilityInput = {
      resourceId: work.work, variantId: variant, publicationDecision: published.decision, expectedEligibilityHead: null,
      actingSubject: h.actor, rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };
    const eligibilityKey = randomUUID();
    const eligibility = await h.call('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', ...eligibilityInput }, eligibilityKey);
    expect(eligibility.status, await eligibility.clone().text()).toBe(201);
    expect((await h.call('POST', '/v1/content-search-eligibility', {
      profile: 'content-search-eligibility-v1', ...eligibilityInput }, eligibilityKey)).status).toBe(200);
    expect((await h.accessPool.query('SELECT id FROM access.scope_gate WHERE id = ANY($1::text[])',
      [[`content:publish:${variant}`, `content:search-eligibility:${variant}`]])).rowCount).toBe(0);
    const bytes = png(64, 64);
    const upload = await h.call('POST', '/v1/media/uploads', { profile: 'media-image-upload-v1', asset: null,
      mediaType: 'image/png', byteLength: bytes.length, sha256: sha(bytes), disclosure: 'public', actingSubject: h.actor });
    expect(upload.status).toBe(201);
    const reserved = await upload.json() as { upload: string; asset: string };
    const activated = await h.app.handle(new Request(`http://main.test/v1/media/uploads/${reserved.upload}/bytes`, {
      method: 'PUT', headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/octet-stream' },
      body: new Blob([bytes]) }));
    expect(activated.status).toBe(201);
    const avatar = await h.call('PUT', `/v1/resources/${short(work.work)}/avatar`, {
      profile: 'resource-avatar-selection-v1', asset: reserved.asset, expectedSelection: null, actingSubject: h.actor });
    expect(avatar.status, await avatar.clone().text()).toBe(201);
    const selection = await avatar.json() as { selection: string };
    const own = await h.call('GET', `/v1/resources/${short(work.work)}?actingSubject=${encodeURIComponent(h.actor)}`);
    expect(own.status, await own.clone().text()).toBe(200);
    expect(await own.json()).toMatchObject({ disclosure: 'restricted',
      avatar: { kind: 'image', selection: selection.selection } });
    expect((await h.app.handle(new Request(`http://main.test/v1/resources/${short(work.work)}`))).status).toBe(404);
    const stranger = await h.agent();
    expect((await h.call('GET', `/v1/resources/${short(work.work)}?actingSubject=${encodeURIComponent(stranger)}`)).status)
      .toBe(404);
    const batch = await h.call('POST', '/v1/resources/summaries', { profile: 'resource-summary-batch-v1',
      resources: [work.work], actingSubject: h.actor });
    expect(batch.status, await batch.clone().text()).toBe(200);
    expect(await batch.json()).toMatchObject({ summaries: [{ status: 'available', disclosure: 'restricted',
      avatar: { kind: 'image', selection: selection.selection } }] });
  } finally { await h.close(); }
}, 120_000);
