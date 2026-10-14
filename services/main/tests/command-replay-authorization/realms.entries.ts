import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { AdmissionConflict, AdmissionDenied } from '../../src/modules/access/admission.ts';
import { deactivateFixtureController, expireFixtureAuthority, grantFixtureAuthority, reduceFixtureGrant } from '../../src/modules/access/fixture-authority.ts';
import { AccessRealmManagement } from '../../src/modules/access/realm-management.ts';
import { RealmAdminConflict, RealmAdminDenied } from '../../src/modules/realm-admin/contract.ts';
import { RealmJoinRequests } from '../../src/modules/realm-admin/join-requests.ts';
import { choosePublicModerator, moderatorSlot, publishRealmProfile, readCurrentProfile } from '../../src/modules/realm-profile/commands.ts';
import { RealmReplyStore, realmReplyDigest } from '../../src/modules/realm-reply/store.ts';
import { RealmReplyContentStore } from '../../src/modules/realm-reply/content-store.ts';
import { RealmSubmissionStore } from '../../src/modules/realm-submission/store.ts';
import type { SubmissionRequest } from '../../src/modules/realm-submission/schema.ts';
import { SourceNativeWorkAdoptionStore } from '../../src/modules/source/native-work-adoption.ts';
import { GRAPHS, iri, RV } from '../../src/modules/work/activate.ts';
import { changeZoneConfiguration, publishZoneSite, readZoneConfiguration } from '../../src/modules/zone/configuration.ts';
import { withdrawZoneRealmAttachment } from '../../src/modules/zone/realm-attachment-withdrawal.ts';
import { type Loss, type Member, type ReplayEntry, stack, request, principal, graphSnapshot, proposal } from './fixtures.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
async function answer<T>(response: Promise<Response>, status = 201): Promise<T> {
  const result = await response, body = await result.text();
  expect(result.status, body).toBe(status);
  return JSON.parse(body) as T;
}

// Setup invokes public owners; no fabricated admissions or outcomes are seeded.
const realmFixtures = new Map<string, Promise<{ owner: Member; realm: string; space: string }>>();
async function realmFixture(family = 'ordinary') {
  const prior = realmFixtures.get(family);
  if (prior) return prior;
  const created = (async () => {
  const owner = await personFixture();
  await owner.grant('space:create:root', 'space.create');
  const realm = await answer<{ realm: string; space: string }>(owner.send('POST', '/v1/spaces', {
    profile: 'space-realm-v1', name: 'Replay community', capabilities: ['realm'], actingSubject: owner.actor,
  }));
  return { ...realm, owner };
  })();
  realmFixtures.set(family, created);
  return created;
}
let sharedZone: Promise<{ owner: Member; zone: string; zoneRevision: string; navigationRevision: string }> | undefined;
async function zoneFixture() {
  if (sharedZone) return sharedZone;
  sharedZone = (async () => {
  const owner = await personFixture();
  await owner.grant('space:create:root', 'space.create');
  const zone = await answer<{ zone: string; zoneRevision: string; navigationRevision: string }>(
    owner.send('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Replay site',
      language: 'en', visibility: 'public', capabilities: ['zone'], actingSubject: owner.actor }));
  return { ...zone, owner };
  })();
  return sharedZone;
}
async function personFixture() {
  const member = await stack.member(randomUUID(), { verified: true });
  const deps = stack.composition.dependencies;
  const provision = await deps.agentProvisioning!.provision(deps.account, request(member),
    { kind: 'person', displayName: 'Replay reader' }, randomUUID(), true);
  expect(provision.state).toBe('active');
  const actor = provision.agent;
  // The token still names the same Account principal; the real provision owner
  // allocated its Person and installed the current direct controller.
  return { ...member, actor,
    grant: async (scope: string, action: string) => (await grantFixtureAuthority(stack.accessPool, {
      scope, requireDispatch: true, representations: [{ principalId: member.principalId, actor, action,
        lifetime: action === 'agent.control' ? 'infinity' : '8 hours' }],
      grant: { actor, action, lifetime: action === 'agent.control' ? 'infinity' : '8 hours' } })).grantId,
    send: (method: string, path: string, body?: unknown, key: string = randomUUID()) =>
      stack.call(method, path, { token: member.token, body, key }) };
}
async function controllerLoss(member: Member) {
  const spare = await stack.member(randomUUID());
  const authority = await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
    representations: [member, spare].map(controller => ({ principalId: controller.principalId,
      actor: member.actor, action: 'agent.control', lifetime: 'infinity' as const })),
    grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
  return Object.assign(() => deactivateFixtureController(stack.accessPool, authority.representationIds[0]!), {
    restore: async () => {
      await grantFixtureAuthority(stack.accessPool, { scope: 'work:create:root', requireDispatch: true,
        representations: [{ principalId: member.principalId, actor: member.actor, action: 'agent.control', lifetime: 'infinity' }],
        grant: { actor: member.actor, action: 'agent.control', lifetime: 'infinity' } });
    },
  });
}
let sharedWork: Promise<Awaited<ReturnType<SourceNativeWorkAdoptionStore['adopt']>>> | undefined;
async function workFixture() {
  if (!sharedWork) sharedWork = (async () => {
  const member = await stack.member(randomUUID());
  await member.grant('work:create:root', 'work.create');
  const offered = await proposal(member, `OL${Math.floor(Math.random() * 900000000) + 100000000}W`, 'Replay root', 1);
  const owner = new SourceNativeWorkAdoptionStore(stack.contentPool, stack.composition.dependencies.sourceProposals!,
    stack.env, stack.composition.dependencies.account, stack.access);
  return owner.adopt(member.principalId, request(member), offered.proposal.split('/').at(-1)!, {
    actingSubject: member.actor, authorityPath: 'represented-agent', confirmedTitle: 'Replay root',
  });
  })();
  return (await sharedWork)!.adoption;
}
async function authoredWork(member: Member) {
  return answer<{ work: string; mainVersion: string; workRevision: string }>(member.send('POST', '/v1/works', {
    profile: 'metadata-only-v1', authoring: 'own-work', title: 'Authored replay target', language: 'en', actingSubject: member.actor,
  }));
}
async function textCandidate(member: Member, work: { work: string; mainVersion: string }) {
  await member.grant(`contribution:create:${work.work}`, 'contribution.create');
  const draft = await answer<{ contribution: string; draftRevision: string }>(member.send('POST', '/v1/contributions', {
    profile: 'text-contribution-v1', work: work.work, language: 'en', body: 'Retained offered text', actingSubject: member.actor,
  }));
  await member.grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
  await member.grant(`contribution:read:${draft.contribution}`, 'contribution.read');
  const published = await answer<{ publicationDecision: string; selectedDraft: string }>(member.send('POST', '/v1/contribution-publications', {
    profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
    expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: member.actor,
  }));
  return { actingSubject: member.actor, kind: 'contribution' as const, ...work,
    contribution: draft.contribution, publicationDecision: published.publicationDecision, selectedDraft: published.selectedDraft, correctionOf: null };
}
async function publicationCandidate(member: Member, work: { work: string; mainVersion: string; workRevision: string }) {
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const draft = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(member.send('POST', '/v1/content-drafts', {
    profile: 'content-text-v1', resourceId: work.work, variantId, expectedHead: null,
    body: 'Retained publication', language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: member.actor,
  }));
  const publication = await answer<{ decision: string }>(member.send('POST', '/v1/content-publications', {
    profile: 'content-publication-v1', preparationId: randomUUID(), revisionId: draft.revisionId,
    expectedDigest: draft.byteDigest, expectedContentEpoch: draft.sourcePosition.dataEpoch,
    resourceId: work.work, variantId, expectedPublicationHead: null, actingSubject: member.actor,
  }));
  await answer(member.send('POST', '/v1/content-search-eligibility', {
    profile: 'content-search-eligibility-v1', resourceId: work.work, variantId,
    publicationDecision: publication.decision, expectedEligibilityHead: null,
    actingSubject: member.actor, disclosure: 'public', rightsBasis: 'original-contribution',
  }));
  return { actingSubject: member.actor, kind: 'content-publication' as const, ...work,
    variant: variantId, publicationDecision: publication.decision, contentRevision: draft.revisionId };
}
async function grantLoss(member: Member, scope: string, action: string) {
  const grant = await member.grant(scope, action);
  return Object.assign((loss: Loss) => reduceFixtureGrant(stack.accessPool, grant,
    loss === 'expired' ? { validUntil: new Date(0) } : { active: false }), {
    restore: async () => { await member.grant(scope, action); },
  });
}
async function actorLoss(member: Member, action: string, loss: Loss) {
  if (loss === 'expired') {
    await member.grant('work:create:root', action);
    return Object.assign(() => expireFixtureAuthority(stack.accessPool, member.actor), {
      restore: async () => { await member.grant('work:create:root', action); },
    });
  }
  return controllerLoss(member);
}
async function admissionSnapshot(member: Member, key: string, resource: string, receipt: string) {
  return { graph: await graphSnapshot(resource, receipt), admissions: (await stack.accessPool.query(`
    SELECT to_jsonb(a) AS row FROM access.admission a WHERE principal_id = $1 AND idempotency_key = $2 ORDER BY id`,
  [member.principalId, key])).rows };
}

const joinEntries: ReplayEntry[] = ['request', 'withdraw', 'decide'].map(command => ({
  operation: command === 'request' ? 'POST /v1/realms/{}/join-requests'
    : `POST /v1/realms/{}/join-requests/{}/${command === 'decide' ? 'decisions' : 'withdraw'}`,
  authorityClass: command === 'decide' ? 'domain-grant' : 'controller',
  scope: command === 'decide' ? 'governance:realm:{realm}' : 'Agent',
  action: command === 'decide' ? 'realm.members.manage' : 'access.membership.consent',
  family: `Realm join ${command}`, owners: [`modules/realm-admin/join-requests.ts#RealmJoinRequests.${command}`],
  subcases: command === 'decide' ? ['accepted', 'declined'] : ['requester'],
  denied: RealmAdminDenied, conflict: RealmAdminConflict, registration: 'turned',
  requestBuilder: async (subcase, loss) => {
    const { owner, realm, space } = await realmFixture('join-requests');
    const admin = new AccessRealmManagement(stack.accessPool);
    await owner.grant('work:create:root', 'agent.control');
    await admin.initialize(await principal(owner), realm, owner.actor, stack.env);
    const settings = await admin.spaceSettings(await principal(owner), space, owner.actor, stack.env);
    await admin.changeSpaceSettings(await principal(owner), space, { actingSubject: owner.actor,
      expectedGeneration: settings.generation, reason: 'Receive join requests',
      settings: { visibility: 'public', listing: 'listed', history: 'from-admission', admission: 'request' } }, randomUUID(), stack.env);
    const requester = await stack.member(randomUUID()), manager = await stack.member(randomUUID());
    const member = command === 'decide' ? manager : requester;
    const lose = command === 'decide'
      ? await grantLoss(manager, `governance:realm:${realm}`, 'realm.members.manage')
      : await actorLoss(requester, 'access.membership.consent', loss);
    if (command === 'decide') await requester.grant('work:create:root', 'access.membership.consent');
    const requests = new RealmJoinRequests(stack.accessPool, stack.env);
    const basis = await requests.basis(await principal(requester), realm, requester.actor);
    const input = { actingSubject: requester.actor, expectedMembershipGeneration: basis.membershipGeneration,
      expectedPolicyRevision: basis.policyRevision, termsRevision: basis.termsRevision, reason: 'Join this Realm' };
    const key = randomUUID();
    const offered = command === 'request' ? undefined
      : await requests.request(await principal(requester), realm, input, randomUUID());
    const generation = (await admin.spaceSettings(await principal(owner), space, owner.actor, stack.env)).generation;
    const decision = { actingSubject: manager.actor, expectedGeneration: generation, expectedRequestGeneration: '0',
      decision: subcase as 'accepted' | 'declined', reason: 'Reviewed request' };
    const withdrawal = { actingSubject: requester.actor, expectedRequestGeneration: '0', reason: 'Withdraw request' };
    let saved: { requestId: string };
    return { command: async (fresh, changed) => {
      const actualKey = fresh ? randomUUID() : key;
      const result = command === 'request' ? await requests.request(await principal(member), realm,
        { ...input, ...(changed ? { reason: 'Different request' } : {}) }, actualKey)
        : command === 'withdraw' ? await requests.withdraw(await principal(member), realm, offered!.requestId,
          { ...withdrawal, ...(changed ? { reason: 'Different withdrawal' } : {}) }, actualKey)
          : await requests.decide(await principal(member), realm, offered!.requestId,
            { ...decision, ...(changed ? { reason: 'Different decision' } : {}) }, actualKey);
      saved ??= result;
      return result;
    }, advance: async () => {
      if (command === 'request') await requests.withdraw(await principal(requester), realm, saved.requestId, withdrawal, randomUUID());
      else {
        const current = await admin.spaceSettings(await principal(owner), space, owner.actor, stack.env);
        await admin.changeSpaceSettings(await principal(owner), space, { actingSubject: owner.actor,
          expectedGeneration: current.generation, reason: 'Advance management head', settings: current.settings }, randomUUID(), stack.env);
      }
    }, lose, restore: lose.restore,
    snapshot: async () => ({ requests: (await stack.accessPool.query(`SELECT to_jsonb(q) AS request,
      (SELECT to_jsonb(b) FROM access.realm_join_request_basis b WHERE b.request_id=q.id) AS basis,
      (SELECT to_jsonb(d) FROM access.realm_join_request_decision d WHERE d.request_id=q.id) AS decision
      FROM access.realm_join_request q WHERE realm=$1 ORDER BY id`, [realm])).rows,
    receipts: (await stack.accessPool.query(`SELECT to_jsonb(r) AS row FROM access.realm_join_request_receipt r
      WHERE request_id=$1 UNION ALL SELECT to_jsonb(r) FROM access.realm_join_request_command_receipt r
      WHERE request_id=$1`, [saved.requestId])).rows,
    membership: (await stack.accessPool.query('SELECT to_jsonb(m) AS row FROM access.membership m WHERE owner_subject=$1 ORDER BY id', [realm])).rows }) };
  },
}));

const profileEntries: ReplayEntry[] = ['profile', 'public-choice'].map(kind => ({
  operation: kind === 'profile' ? 'PUT /v1/realms/{}/profile' : 'PUT /v1/realms/{}/moderators/{}/public-choice',
  authorityClass: 'domain-grant', scope: kind === 'profile' ? 'realm:profile:{realm}' : 'realm:moderator-choice:{realm}:{agent}',
  action: kind === 'profile' ? 'realm.profile.publish' : 'realm.moderator.choose',
  family: `Realm ${kind}`, owners: [`modules/realm-profile/commands.ts#${kind === 'profile' ? 'publishRealmProfile' : 'choosePublicModerator'}`],
  subcases: ['represented-agent'], denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
  requestBuilder: async () => {
    const { realm } = await realmFixture(), member = await stack.member(randomUUID());
    const deps = stack.composition.dependencies, key = randomUUID();
    const scope = kind === 'profile' ? `realm:profile:${realm}` : `realm:moderator-choice:${realm.slice(-36)}:${member.actor.slice(-36)}`;
    const lose = await grantLoss(member, scope, kind === 'profile' ? 'realm.profile.publish' : 'realm.moderator.choose');
    const profile = { name: { original: 'en', labels: { en: 'Saved community' } },
      description: { original: 'en', labels: { en: 'Saved description' } }, iconSelection: null,
      bannerSelection: null, count: { kind: 'unknown' as const, value: null }, moderators: [] };
    const originalHead = kind === 'profile' ? (await readCurrentProfile(stack.env, realm))?.revision ?? null : null;
    const input = { realm, actingSubject: member.actor, expectedHead: originalHead, idempotencyKey: key };
    let saved: { revision: string; receipt: string };
    const execute = (actualKey: string, expectedHead: string | null, changed = false) => kind === 'profile'
      ? publishRealmProfile(stack.env, stack.media.store, deps.account, stack.access, request(member), {
        ...input, expectedHead, idempotencyKey: actualKey, profile: { ...profile,
          ...(changed ? { description: { original: 'en', labels: { en: 'Different description' } } } : {}) } })
      : choosePublicModerator(stack.env, deps.account, stack.access, request(member), {
        ...input, expectedHead, idempotencyKey: actualKey, agent: member.actor, public: !changed });
    return { command: async (fresh, changed) => {
      const result = await execute(fresh ? randomUUID() : key, fresh ? saved.revision : originalHead, changed);
      saved ??= result;
      return result;
    }, advance: async () => { await execute(randomUUID(), saved.revision, true); }, lose, restore: lose.restore,
    snapshot: () => admissionSnapshot(member, key, kind === 'profile' ? realm : moderatorSlot(realm, member.actor), saved.receipt) };
  },
}));

const zoneEntries: ReplayEntry[] = (['configure', 'retire', 'recover', 'publish', 'withdraw'] as const).map(operation => ({
  operation: operation === 'configure' ? 'PUT /v1/zones/{}/configuration'
    : `POST /v1/zones/{}/${({ retire: 'retirements', recover: 'recoveries', publish: 'site-publications', withdraw: 'realm-attachment-withdrawals' })[operation]}`,
  authorityClass: 'domain-grant', scope: operation === 'withdraw' ? 'realm:attach:{realm}' : 'zone:edit:{zone}',
  action: operation === 'withdraw' ? 'realm.attach' : 'zone.edit', family: `Zone ${operation}`,
  owners: operation === 'withdraw' ? ['modules/zone/realm-attachment-withdrawal.ts#withdrawZoneRealmAttachment']
    : ['modules/zone/configuration.ts#changeZoneConfiguration'],
  subcases: operation === 'withdraw' ? ['represented-agent', 'steward'] : ['represented-agent'],
  denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
  requestBuilder: async subcase => {
    const baseline = subcase === 'creator-controller' || subcase === 'steward-controller';
    let site: Awaited<ReturnType<typeof zoneFixture>>;
    if (baseline) {
      const owner = await personFixture();
      site = { ...await answer<{ zone: string; zoneRevision: string; navigationRevision: string }>(
        owner.send('POST', '/v1/spaces', { profile: 'space-zone-v1', name: 'Controlled site',
          language: 'en', visibility: 'public', capabilities: ['zone'], actingSubject: owner.actor })), owner };
    } else site = await zoneFixture();
    const member = baseline && operation !== 'withdraw' ? site.owner
      : subcase === 'steward' || subcase === 'steward-controller' ? await personFixture() : await stack.member(randomUUID());
    const deps = stack.composition.dependencies, key = randomUUID();
    let expectedHead = (await readZoneConfiguration(stack.env, site.zone)).revision;
    const configure = (actor: Member, revision: string, patch: { prepareHomeDocument?: true; defaultRealm?: string | null; name?: string }) =>
      changeZoneConfiguration(stack.env, deps.account, stack.access, request(actor), { zone: site.zone,
        expectedHead: revision, actingSubject: actor.actor, idempotencyKey: randomUUID(), operation: 'configure', patch }, stack.media, stack.content);
    if (operation === 'recover') expectedHead = (await changeZoneConfiguration(stack.env, deps.account, stack.access,
      request(site.owner), { zone: site.zone, expectedHead, actingSubject: site.owner.actor,
        idempotencyKey: randomUUID(), operation: 'retire' }, stack.media, stack.content)).revision;
    const realm = operation === 'withdraw' ? await realmFixture() : undefined;
    let publication: Parameters<typeof publishZoneSite>[4] | undefined;
    if (realm) {
      await site.owner.grant(`governance:realm:${realm.realm}`, 'realm.settings.manage');
      await site.owner.grant(`realm:attach:${realm.realm}`, 'realm.attach');
      expectedHead = (await configure(site.owner, expectedHead, { defaultRealm: realm.realm })).revision;
    }
    if (operation === 'publish') {
      expectedHead = (await configure(site.owner, expectedHead, { prepareHomeDocument: true })).revision;
      const state = await readZoneConfiguration(stack.env, site.zone);
      const page = state.configuration.homeDocument!, variantId = `urn:rezics:variant:${randomUUID()}`;
      const draft = await answer<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(site.owner.send('POST', '/v1/content-drafts', {
        profile: 'content-text-v1', resourceId: page, variantId, expectedHead: null,
        document: fromPlainText('Retained home page', 'blocks'), language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr', actingSubject: site.owner.actor }));
      publication = { zone: site.zone, expectedHead, actingSubject: member.actor, idempotencyKey: key,
        routesRevision: site.navigationRevision, navigationRevision: site.navigationRevision,
        pages: [{ page, variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest, contentEpoch: draft.sourcePosition.dataEpoch }] };
    }
    // Attachment authority consumes Realm stewardship in addition to its action.
    if (operation === 'withdraw' && (baseline || subcase === 'steward')) {
      await member.grant(`governance:realm:${realm!.realm}`, 'realm.settings.manage');
    }
    const lose = baseline ? await controllerLoss(member) : operation === 'withdraw' && subcase === 'steward'
      ? await grantLoss(member, `governance:realm:${realm!.realm}`, 'realm.settings.manage')
      : await grantLoss(member, operation === 'withdraw' ? `realm:attach:${realm!.realm}` : `zone:edit:${site.zone}`,
        operation === 'withdraw' ? 'realm.attach' : 'zone.edit');
    const input = { zone: site.zone, expectedHead, actingSubject: member.actor, idempotencyKey: key };
    let saved: { receipt: string };
    return { command: async (fresh, changed) => {
      const actualKey = fresh ? randomUUID() : key;
      const result = operation === 'withdraw'
        ? await withdrawZoneRealmAttachment(stack.env, deps.account, stack.access, request(member), {
          zone: changed ? id() : site.zone, realm: realm!.realm, actingSubject: member.actor, idempotencyKey: actualKey })
        : operation === 'publish' ? await publishZoneSite(stack.env, deps.account, stack.access, request(member), {
          ...publication!, idempotencyKey: actualKey, ...(changed ? { navigationRevision: id() } : {}) }, stack.content)
          : await changeZoneConfiguration(stack.env, deps.account, stack.access, request(member), {
            ...input, idempotencyKey: actualKey, operation,
            ...(operation === 'configure' ? { patch: { name: changed ? 'Different site' : 'Saved site' } }
              : changed ? { expectedHead: id() } : {}) }, stack.media, stack.content);
      saved ??= result;
      return result;
    }, advance: async () => {
      const current = await readZoneConfiguration(stack.env, site.zone);
      if (operation === 'retire') await changeZoneConfiguration(stack.env, deps.account, stack.access, request(site.owner), {
        zone: site.zone, expectedHead: current.revision, actingSubject: site.owner.actor, idempotencyKey: randomUUID(), operation: 'recover' }, stack.media, stack.content);
      else await configure(site.owner, current.revision, { name: 'Advanced site' });
    }, lose, restore: lose.restore, snapshot: async () => ({ ...await admissionSnapshot(member, key, site.zone, saved.receipt),
      pins: publication ? (await stack.contentPool.query(`SELECT to_jsonb(p) AS row FROM content.publication_preparation p
        WHERE revision_id=$1 ORDER BY operation_id`, [publication.pages[0]!.revisionId])).rows : [] }) };
  },
}));

const submissionEntries: ReplayEntry[] = (['submit', 'withdraw', 'decide'] as const).map(command => ({
  operation: command === 'submit' ? 'POST /v1/realms/{}/submissions'
    : `POST /v1/realms/{}/submissions/{}/${command === 'decide' ? 'decisions' : 'withdrawals'}`,
  authorityClass: 'domain-grant', scope: command === 'decide' ? 'review:decide:{realm}' : 'submission:submit:{realm}',
  action: command === 'decide' ? 'review.decide' : `submission.${command}`, family: `Realm submission ${command}`,
  owners: [`modules/realm-submission/store.ts#RealmSubmissionStore.${command}`],
  subcases: command === 'decide' ? ['accept', 'accept-work', 'accept-content-publication', 'reject', 'request-changes']
    : command === 'submit' ? ['contribution', 'correction'] : ['contribution'],
  denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
  requestBuilder: async subcase => {
    const baseline = ['author-controller', 'work', 'content-publication'].includes(subcase);
    const resource = baseline || subcase.startsWith('accept-');
    const { realm } = await realmFixture(), author = resource ? await personFixture() : await stack.member(randomUUID());
    const reviewer = await stack.member(randomUUID());
    const work = resource ? await authoredWork(author) : await workFixture(), key = randomUUID();
    const member = command === 'decide' ? reviewer : author;
    const lose = baseline ? await controllerLoss(member) : await grantLoss(member, command === 'decide' ? `review:decide:${realm}` : `submission:submit:${realm}`,
      command === 'decide' ? 'review.decide' : `submission.${command}`);
    if (command !== 'submit' && !baseline) await author.grant(`submission:submit:${realm}`, 'submission.submit');
    if (command === 'decide' && subcase.startsWith('accept')) await reviewer.grant(`publication:adopt:${realm}`, 'publication.adopt');
    const store = new RealmSubmissionStore(stack.accessPool, stack.access, stack.env);
    let input: SubmissionRequest = subcase.endsWith('content-publication') ? await publicationCandidate(author, work)
      : resource ? { actingSubject: author.actor, kind: 'work', work: work.work,
        mainVersion: work.mainVersion, workRevision: work.workRevision } : await textCandidate(author, { work: work.work, mainVersion: work.mainVersion });
    if (subcase === 'correction') {
      const first = (await store.submit(await principal(author), realm, input, randomUUID())).submission;
      await reviewer.grant(`review:decide:${realm}`, 'review.decide');
      await reviewer.grant(`publication:adopt:${realm}`, 'publication.adopt');
      const accepted = (await store.decide(await principal(reviewer), realm, first.id, {
        actingSubject: reviewer.actor, expectedRevision: first.revision, outcome: 'accept', expectedSelectionHead: null,
        publicReason: null, internalNote: null }, randomUUID())).submission;
      expect(accepted.selection).toBeTruthy();
      input = { ...input, kind: 'correction', correctionOf: accepted.selection } as SubmissionRequest;
    }
    const offered = command === 'submit' ? undefined : (await store.submit(await principal(author), realm, input, randomUUID())).submission;
    const decision = { actingSubject: reviewer.actor, expectedRevision: offered?.revision ?? randomUUID(),
      outcome: (subcase.startsWith('accept') ? 'accept' : subcase) as 'accept' | 'reject' | 'request-changes', expectedSelectionHead: null,
      publicReason: 'Reviewed offer', internalNote: 'Private retained note' };
    const withdrawal = { actingSubject: author.actor, expectedRevision: offered?.revision ?? randomUUID() };
    let saved: Awaited<ReturnType<typeof store.submit>>;
    return { command: async (fresh, changed) => {
      const actualKey = fresh ? randomUUID() : key;
      const result = command === 'submit' ? await store.submit(await principal(member), realm, {
        ...input, ...(changed ? ['work', 'content-publication'].includes(input.kind) ? { workRevision: id() } : { selectedDraft: id() } : {}) }, actualKey)
        : command === 'withdraw' ? await store.withdraw(await principal(member), realm, offered!.id, {
          ...withdrawal, ...(changed ? { expectedRevision: randomUUID() } : {}) }, actualKey)
          : await store.decide(await principal(member), realm, offered!.id, {
            ...decision, ...(changed ? { internalNote: 'Different retained note' } : {}) }, actualKey);
      saved ??= result;
      return result;
    }, advance: async () => {
      if (command === 'submit') {
        await author.grant(`submission:submit:${realm}`, 'submission.withdraw');
        await store.withdraw(await principal(author), realm, saved.submission.id, {
          actingSubject: author.actor, expectedRevision: saved.submission.revision }, randomUUID());
      }
      // Withdrawals and terminal decisions have no later mutable workflow head.
    }, lose, restore: lose.restore,
    snapshot: async () => ({ operations: (await stack.accessPool.query(`SELECT to_jsonb(o) AS operation,
      to_jsonb(a) AS admission FROM access.realm_submission_operation o JOIN access.admission a ON a.id=o.admission_id
      WHERE o.submission_id=$1 ORDER BY a.id`, [saved.submission.id])).rows,
    submissions: (await stack.accessPool.query('SELECT to_jsonb(s) AS row FROM access.realm_submission s WHERE id=$1', [saved.submission.id])).rows,
    graph: (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${iri(GRAPHS.current)} ${iri(GRAPHS.receipts)} } GRAPH ?g { ?s ?p ?o }
      FILTER(?s = ${iri(saved.submission.selection ?? work.work)}
        || ?s = ${iri(saved.submission.adoptionReceipt ?? work.work)} || EXISTS {
        GRAPH ${iri(GRAPHS.receipts)} { ?s rv:admissionId ?a }
        VALUES ?a { ${(await stack.accessPool.query<{ admission_id: string }>('SELECT admission_id FROM access.realm_submission_operation WHERE submission_id=$1 ORDER BY admission_id', [saved.submission.id])).rows.map(row => `"${row.admission_id}"`).join(' ')} }
      }) } ORDER BY ?g ?s ?p ?o LIMIT 256`)).results?.bindings }) };
  },
}));

const replyEntries: ReplayEntry[] = (['create', 'review', 'place'] as const).map(command => ({
  operation: `POST /v1/${command === 'create' ? 'realm-replies' : command === 'review' ? 'realm-reply-reviews' : 'realm-reply-placements'}`,
  authorityClass: command === 'create' ? 'controller' : 'domain-grant', scope: command === 'create' ? 'reply:create:{rootTarget}'
    : command === 'review' ? 'review:decide:{realm}' : 'reply:place:{realm}',
  action: command === 'create' ? 'reply.create' : command === 'review' ? 'review.decide' : 'reply.place',
  family: `Realm reply ${command}`, owners: [`modules/realm-reply/store.ts#RealmReplyStore.${command}`],
  subcases: command === 'create' ? ['person-controller'] : ['reviewed-revision'],
  losses: command === 'create' ? ['revoked'] : ['expired', 'revoked'],
  denied: AdmissionDenied, conflict: AdmissionConflict, registration: 'turned',
  requestBuilder: async subcase => {
    const baseline = command === 'create' || subcase === 'member-controller';
    const realmSetup = await realmFixture(baseline && command === 'place' ? 'member-direct' : 'ordinary'), { realm } = realmSetup;
    const author = await personFixture();
    const moderator = await stack.member(randomUUID());
    if (baseline && command === 'place') {
      await realmSetup.owner.grant('work:create:root', 'agent.control');
      const admin = new AccessRealmManagement(stack.accessPool);
      const current = await admin.settings(await principal(realmSetup.owner), realm, realmSetup.owner.actor, stack.env);
      await admin.changeSettings(await principal(realmSetup.owner), realm, { actingSubject: realmSetup.owner.actor,
        expectedGeneration: current.generation, expectedRulesRevision: current.ruleBasis.revision,
        reason: 'Allow member discussion', settings: { ...current.settings, reviewMode: 'open', reviewRequired: false } }, randomUUID(), stack.env);
    }
    const work = await authoredWork(author), reply = id(), variantId = `urn:rezics:variant:${randomUUID()}`, key = randomUUID();
    await author.grant(`work:read:${work.work}`, 'work.read');
    await author.grant(`content:draft:${reply}`, 'content.draft');
    const draft = await answer<{ revisionId: string; revisionDigest: string }>(author.send('POST', '/v1/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply, variantId, rootTarget: work.work, rootRevision: work.workRevision,
      language: 'en', direction: 'ltr', expectedHead: null, body: 'Retained discussion', actingSubject: author.actor }));
    const member = command === 'create' || baseline ? author : moderator;
    const action = command === 'create' ? 'reply.create' : command === 'review' ? 'review.decide' : 'reply.place';
    const scope = command === 'create' ? `reply:create:${work.work}`
      : command === 'review' ? `review:decide:${realm}` : `reply:place:${realm}`;
    const lose = baseline ? await controllerLoss(member) : await grantLoss(member, scope, action);
    const store = new RealmReplyStore(new RealmReplyContentStore(stack.contentPool), stack.content, stack.access, stack.env, stack.accessPool);
    const identity = { reply, variantId, revisionId: draft.revisionId, author: author.actor,
      rootTarget: work.work, rootRevision: work.workRevision, parentReply: null, parentRevision: null, contextRevision: null };
    const review = { realm, reply, revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
      expectedGeneration: '0', supersedes: null, outcome: 'approved' as const,
      method: 'human' as const, methodRevision: 'realm-manager-v1', dependencyDigest: realmReplyDigest(work.work), reasonReference: null };
    if (command !== 'create') {
      await store.create(await principal(author), identity, randomUUID(), realmReplyDigest({ profile: 'realm-reply-identity-v1', ...identity }));
    }
    let approved: Awaited<ReturnType<typeof store.review>> | undefined;
    if (command === 'place' && !baseline) {
      await moderator.grant(`review:decide:${realm}`, 'review.decide');
      approved = await store.review(await principal(moderator), moderator.actor, review, randomUUID(),
        realmReplyDigest({ profile: 'realm-reply-review-v1', actingSubject: moderator.actor, ...review }));
    }
    const placement = { realm, reply, revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
      reviewDecisionId: approved?.decisionId ?? null, expectedHead: null };
    let saved: unknown;
    return { command: async (fresh, changed) => {
      const actualKey = fresh ? randomUUID() : key;
      const changedIdentity = { ...identity, ...(changed ? { contextRevision: id() } : {}) };
      const changedPlacement = { ...placement, ...(changed ? { expectedHead: id() } : {}) };
      const result = command === 'create' ? await store.create(await principal(member), {
        ...changedIdentity }, actualKey,
      realmReplyDigest({ profile: 'realm-reply-identity-v1', ...changedIdentity }))
        : command === 'review' ? await store.review(await principal(member), member.actor, {
          ...review, ...(changed ? { reasonReference: 'Different binding' } : {}) }, actualKey,
        realmReplyDigest({ profile: 'realm-reply-review-v1', actingSubject: member.actor, ...review,
          ...(changed ? { reasonReference: 'Different binding' } : {}) }))
          : await store.place(await principal(member), member.actor, changedPlacement, actualKey,
          realmReplyDigest({ profile: 'realm-reply-placement-v1', actingSubject: member.actor, ...changedPlacement }));
      saved ??= result;
      return result;
    }, advance: async () => {
      const next = await answer<{ revisionId: string; revisionDigest: string }>(author.send('POST', '/v1/member-reply-drafts', { profile: 'member-reply-draft-v1',
        reply, variantId, rootTarget: work.work, rootRevision: work.workRevision,
        language: 'en', direction: 'ltr', expectedHead: draft.revisionId,
        body: 'Advanced unreviewed discussion', actingSubject: author.actor }));
      if (command === 'review' || command === 'place' && !baseline) {
        const prior = command === 'review' ? saved as Awaited<ReturnType<typeof store.review>> : approved!;
        const input = { ...review, revisionId: next.revisionId, revisionDigest: next.revisionDigest,
          expectedGeneration: prior.generation, supersedes: prior.decisionId };
        approved = await store.review(await principal(moderator), moderator.actor, input, randomUUID(),
          realmReplyDigest({ profile: 'realm-reply-review-v1', actingSubject: moderator.actor, ...input }));
      }
      if (command === 'place') {
        const input = { ...placement, revisionId: next.revisionId, revisionDigest: next.revisionDigest,
          reviewDecisionId: baseline ? null : approved!.decisionId,
          expectedHead: (saved as Awaited<ReturnType<typeof store.place>>).placement };
        await store.place(await principal(member), member.actor, input, randomUUID(),
          realmReplyDigest({ profile: 'realm-reply-placement-v1', actingSubject: member.actor, ...input }));
      }
    }, lose, restore: lose.restore, snapshot: async () => ({ saved,
      admissions: (await stack.accessPool.query(`SELECT to_jsonb(a) AS row FROM access.admission a
        WHERE principal_id=$1 AND idempotency_key=$2 ORDER BY id`, [member.principalId, key])).rows,
      content: (await stack.contentPool.query(`SELECT to_jsonb(v) AS variant,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM content.revision r WHERE r.variant_id=v.id) AS revisions,
        (SELECT to_jsonb(r) FROM content.reply r WHERE r.id=$1) AS reply,
        (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM content.realm_review_decision d WHERE d.variant_id=v.id) AS reviews,
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY operation_id) FROM content.realm_placement_preparation p WHERE p.variant_id=v.id) AS placements,
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.operation_id) FROM content.publication_preparation p
          JOIN content.revision r ON r.id=p.revision_id WHERE r.variant_id=v.id) AS pins
        FROM content.variant v WHERE id=$2`, [reply, variantId])).rows,
      receipts: (await stack.contentPool.query(`SELECT to_jsonb(r) AS row FROM content.receipt r
        WHERE operation_id = ANY($1::text[]) ORDER BY operation_id`,
      [(await stack.accessPool.query<{ id: string }>('SELECT id FROM access.admission WHERE principal_id=$1 AND idempotency_key=$2',
        [member.principalId, key])).rows.map(row => row.id)])).rows,
      graph: (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?g ?s ?p ?o WHERE {
        VALUES ?g { ${iri(GRAPHS.current)} ${iri(GRAPHS.receipts)} } GRAPH ?g { ?s ?p ?o }
        FILTER(?s = ${iri(reply)} || EXISTS { GRAPH ?g { ?s rv:reply ${iri(reply)} } }
          || EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ?s rv:admissionId ?a }
            VALUES ?a { ${(await stack.accessPool.query<{ id: string }>('SELECT id FROM access.admission WHERE principal_id=$1 AND idempotency_key=$2', [member.principalId, key])).rows.map(row => `"${row.id}"`).join(' ')} } })
        } ORDER BY ?g ?s ?p ?o LIMIT 256`)).results?.bindings }) };
  },
}));

// Newly provisioned controllers are open-ended. Their lawful loss is removal;
// the accepted legacy-controller driver separately retains upgrade expiry.
const controllerEntries: ReplayEntry[] = [
  ...zoneEntries.filter(entry => entry.action === 'zone.edit').map(entry => ({ ...entry,
    authorityClass: 'controller' as const, family: `${entry.family} by creator`, subcases: ['creator-controller'],
    losses: ['revoked' as const] })),
  ...zoneEntries.filter(entry => entry.action === 'realm.attach').map(entry => ({ ...entry,
    authorityClass: 'controller' as const, family: `${entry.family} by steward`, subcases: ['steward-controller'],
    losses: ['revoked' as const] })),
  ...replyEntries.filter(entry => entry.action === 'reply.place').map(entry => ({ ...entry,
    authorityClass: 'controller' as const, family: `${entry.family} by member`, subcases: ['member-controller'],
    losses: ['revoked' as const] })),
  ...submissionEntries.filter(entry => entry.action !== 'review.decide').map(entry => ({ ...entry,
    authorityClass: 'controller' as const, family: `${entry.family} by author`, subcases: entry.action === 'submission.submit' ? ['work', 'content-publication'] : ['author-controller'],
    losses: ['revoked' as const] })),
];
export const entries: ReplayEntry[] = [...joinEntries, ...profileEntries, ...zoneEntries, ...submissionEntries, ...replyEntries, ...controllerEntries];
export const area = 'realms';
export const moduleOwners = ['realm-admin', 'realm-profile', 'realm-reply', 'realm-submission', 'zone'];
export const replayEntries = entries;
export const coveredOperations = [...new Set(replayEntries.map(entry => entry.operation))];
export const uncoveredOperations: string[] = [];
