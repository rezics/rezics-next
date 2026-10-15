import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fromPlainText } from '@rezics/document';
import { createMainApp } from '../../../services/main/src/app.ts';
import type { VerifiedPrincipal } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import type { DecisionInput, DecisionResult, ReportResult } from '../../../services/main/src/modules/governance/store.ts';
import type { RoleCommand } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { readZoneConfiguration } from '../../../services/main/src/modules/zone/configuration.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../../../services/main/src/modules/zone/presentation-format.ts';
import { MediaScreenStore } from '../../../services/main/src/modules/media-screen/store.ts';
import { screenVerdict } from '../../../services/main/src/modules/media-screen/policy.ts';
import { GRAPHS, iri, RV } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack, sha, png } from './media-support.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';
import { fixtureReasons } from './g-565-decision-support.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const short = (id: string) => id.slice(-36);
const requests = new WeakMap<Response, string>();
type Stack = Awaited<ReturnType<typeof startMediaStack>>;
interface Actor { actor: string; token: string; principal: VerifiedPrincipal; principalId: string }
interface Realm { realm: string; space: string }
interface Work { work: string; mainVersion: string; workRevision: string }
interface Reply { reply: string; variantId: string; revisionId: string; revisionDigest: string; placement: string; reviewDecisionId: string }
interface Site { zone: string; space: string; navigationRevision: string; homeRevision?: string; homeDraftStatus?: number }
interface Observable { status: number; body: string; headers: [string, string][] }
interface Decision { input: DecisionInput; response: Observable; result: DecisionResult | null; reportId: string }
interface Page { items: Array<{ id: string; reply?: string }>; nextCursor: string | null;
  count?: { value: number; kind: string; total: number | null } }

// Compare all exposed bytes and headers. No request-cost equivalence is inferred.
async function observable(response: Response): Promise<Observable> {
  return { status: response.status, body: await response.text(), headers: [...response.headers.entries()].sort() };
}
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, `${requests.get(response) ?? 'read'}: ${body}`).toBe(status);
  return JSON.parse(body) as T;
}

let stack: Stack;
let app: ReturnType<typeof createMainApp>;
let builder: Actor, manager: Actor, member: Actor, party: Actor, platform: Actor;
let realm: Realm, unaffected: Realm, privateRealm: Realm, unlistedRealm: Realm;
let work: Work, selection: string, opener: Reply, reply: Reply, restrictedReply: Reply;
let replyImage: { asset: string; representation: string; use: string; digest: string };
let sites: Site[];
let rule: DecisionInput['rule'];
let closure: Decision, restoration: Decision, searchRestriction: Decision, replyRestriction: Decision;
const principals = new Map<string, VerifiedPrincipal>();
const readers = ['anonymous', 'member', 'manager', 'case-party'] as const;
type Reader = typeof readers[number];
const states = ['public', 'closed', 'restored'] as const;

function actorFor(reader: Reader): Actor | undefined {
  return reader === 'manager' ? manager : reader === 'member' ? member : reader === 'case-party' ? party : undefined;
}
function call(method: string, path: string, actor?: Actor, body?: unknown, key: string = randomUUID()) {
  return app.handle(new Request(`http://main.local${path}`, { method,
    headers: { ...(actor ? { authorization: `Bearer ${actor.token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'idempotency-key': key },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })).then(response => {
    requests.set(response, `${method} ${path}`); return response;
  });
}
function get(path: string, reader: Reader) {
  const actor = actorFor(reader);
  const url = new URL(`http://main.local${path}`);
  if (actor && !url.pathname.includes('/modules/')
    && !path.startsWith('/v1/zones/') && !url.pathname.endsWith('/roster') && url.pathname !== '/v1/realms') {
    url.searchParams.set('actingSubject', actor.actor);
  }
  return call('GET', `${url.pathname}${url.search}`, actor);
}
async function grant(actor: Actor, scope: string, action: string) {
  await grantFixtureAuthority(stack.accessPool, { scope, requireDispatch: true,
    representations: [{ principalId: actor.principalId, actor: actor.actor, action, lifetime: '8 hours' }],
    grant: { actor: actor.actor, action, lifetime: '8 hours' } });
}
async function provision(name: string, kind: 'person' | 'organization' = 'person'): Promise<Actor> {
  const token = randomUUID();
  const principal = { issuer: 'https://qa-realm-closure.test', subject: randomUUID(), emailVerified: true };
  principals.set(token, { ...principal, currentAssertion: async () => principal });
  const { agent } = await json<{ agent: string }>(await call('POST', '/v1/agents',
    { token } as Actor, { profile: 'agent-provision-v1', kind, displayName: name }), 201);
  const row = (await stack.accessPool.query<{ id: string }>(
    'SELECT id FROM access.principal WHERE account_issuer=$1 AND account_subject=$2',
    [principal.issuer, principal.subject])).rows[0]!;
  return { actor: agent, token, principal, principalId: row.id };
}
async function createRealm(name: string, visibility = 'public') {
  return json<Realm>(await call('POST', '/v1/spaces', builder, { profile: 'space-realm-v1', name,
    capabilities: ['realm'], actingSubject: builder.actor,
    initialSettings: { visibility, reviewRequired: true, whoMaySubmit: 'granted', rules: [] } }), 201);
}
async function createWork(): Promise<Work & { contribution: string; publicationDecision: string }> {
  await grant(builder, 'work:create:root', 'work.create');
  const created = await json<Work>(await call('POST', '/v1/works', builder, {
    profile: 'metadata-only-v1', title: 'Independent original', language: 'en', authoring: 'own-work',
    actingSubject: builder.actor }), 201);
  await grant(builder, `work:read:${created.work}`, 'work.read');
  await grant(builder, `contribution:create:${created.work}`, 'contribution.create');
  const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST',
    '/v1/contributions', builder, { profile: 'text-contribution-v1', work: created.work, language: 'en',
      body: 'Independent public original', actingSubject: builder.actor }), 201);
  await grant(builder, `contribution:read:${draft.contribution}`, 'contribution.read');
  await grant(builder, `contribution:publish:${draft.contribution}`, 'contribution.publish');
  const published = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications',
    builder, { profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null, rightsBasis: 'original-contribution',
      disclosure: 'public', actingSubject: builder.actor }), 201);
  await grant(builder, `publication:select:${created.mainVersion}`, 'publication.select');
  await json(await call('POST', '/v1/publication-selections', builder, { profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: created.mainVersion }, work: created.work,
    contribution: draft.contribution, publicationDecision: published.publicationDecision, expectedSelectionHead: null,
    selectionBasis: 'main-maintainer', actingSubject: builder.actor }), 201);
  return { ...created, contribution: draft.contribution, publicationDecision: published.publicationDecision };
}
async function place(body: string, parent?: Reply): Promise<Reply> {
  const id = native(), variantId = `urn:rezics:variant:${randomUUID()}`;
  // Member reply drafts and identities require the provisioned Person's
  // baseline proof. Delegated organization grants cannot replace that author.
  const saved = await json<{ revisionId: string; revisionDigest: string }>(await call('POST',
    '/v1/member-reply-drafts', member, { profile: 'member-reply-draft-v1', reply: id, variantId,
      rootTarget: work.work, rootRevision: work.workRevision, originRealm: realm.realm,
      language: 'en', direction: 'ltr', expectedHead: null, body, actingSubject: member.actor }), 201);
  await json(await call('POST', '/v1/realm-replies', member, { profile: 'realm-reply-identity-v1',
    reply: id, variantId, revisionId: saved.revisionId, author: member.actor, rootTarget: work.work,
    rootRevision: work.workRevision, parentReply: parent?.reply ?? null, parentRevision: parent?.revisionId ?? null,
    contextRevision: null }), 201);
  const review = await json<{ decisionId: string }>(await call('POST', '/v1/realm-reply-reviews', manager,
    { profile: 'realm-reply-review-v1', realm: realm.realm, reply: id, revisionId: saved.revisionId,
      revisionDigest: saved.revisionDigest, expectedGeneration: '0', supersedes: null, outcome: 'approved',
      method: 'human', methodRevision: 'realm-manager-v1', dependencyDigest: sha(work.work),
      reasonReference: null, actingSubject: manager.actor }), 201);
  const placed = await json<{ placement: string }>(await call('POST', '/v1/realm-reply-placements', manager,
    { profile: 'realm-reply-placement-v1', realm: realm.realm, reply: id, revisionId: saved.revisionId,
      revisionDigest: saved.revisionDigest, reviewDecisionId: review.decisionId, expectedHead: null,
      actingSubject: manager.actor }), 201);
  return { reply: id, variantId, ...saved, placement: placed.placement, reviewDecisionId: review.decisionId };
}
async function installManager(target: Realm) {
  const { invitation: policy } = await json<{ invitation: { policyRevision: string; termsRevision: string } }>(
    await call('POST', `/v1/realms/${short(target.realm)}/invitations`, builder,
      { actingSubject: builder.actor, member: manager.actor, expiresInSeconds: 3600 }));
  const consent = await json<{ consentReference: string }>(await call('POST', '/v1/me/membership-consents', manager,
    { profile: 'access-membership-consent-v1', kind: 'realm', ownerSubject: target.realm, memberSubject: manager.actor,
      expectedGeneration: '0', expectedPolicyRevision: policy.policyRevision, termsRevision: policy.termsRevision }));
  const admin = await json<{ generation: string }>(await call('GET',
    `/v1/realms/${short(target.realm)}/settings?actingSubject=${encodeURIComponent(builder.actor)}`, builder));
  await json(await call('POST', `/v1/realms/${short(target.realm)}/members`, builder, {
    actingSubject: builder.actor, expectedGeneration: admin.generation, member: manager.actor,
    expectedMembershipGeneration: '0', action: 'add', consent: consent.consentReference,
    durationSeconds: null, reason: 'Admit the Person manager' }), 201);
  const roleId = randomUUID();
  const changeRole = async (change: RoleCommand['change']) => {
    const roles = await json<{ generation: string }>(await call('GET',
      `/v1/realms/${short(target.realm)}/roles?actingSubject=${encodeURIComponent(builder.actor)}`, builder));
    const input: RoleCommand = { actingSubject: builder.actor, expectedGeneration: roles.generation,
      reason: 'Assign current Realm management authority', change };
    const impact = await json<{ digest: string }>(await call('POST',
      `/v1/realms/${short(target.realm)}/role-impact`, builder, input));
    await json(await call('POST', `/v1/realms/${short(target.realm)}/role-changes`, builder,
      { ...input, impactDigest: impact.digest }), 201);
  };
  await changeRole({ kind: 'role', roleId, name: 'Managers', permissions: ['governance.moderate', 'governance.rule.publish',
    'realm.members.manage', 'realm.roles.manage', 'realm.settings.manage', 'review.decide', 'publication.adopt'] });
  await changeRole({ kind: 'assignment', roleId, member: manager.actor, assigned: true,
    validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  const verified = await json<{ roles: { id: string; holders: { member: string }[] | null }[] }>(await call('GET',
    `/v1/realms/${short(target.realm)}/roles?actingSubject=${encodeURIComponent(manager.actor)}`, manager));
  expect(verified.roles.find(role => role.id === roleId)?.holders?.some(holder => holder.member === manager.actor)).toBe(true);
}
async function head(resource: string) {
  if (sites?.some(site => site.zone === resource)) return (await readZoneConfiguration(stack.env, resource)).revision;
  const rows = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(resource)} rv:head ?head } } LIMIT 2`, 4096)).results?.bindings ?? [];
  expect(rows).toHaveLength(1);
  return rows[0]!.head!.value;
}
async function decide(resource: string, options: { rights?: boolean; component?: 'record' | 'body';
  effect?: 'disclosure' | 'search'; revision?: string; expectedHead?: string } = {}): Promise<Decision> {
  const rights = options.rights ?? false;
  const key = randomUUID();
  const report = await json<ReportResult>(await call('POST', rights ? '/v1/rights/complaints' : '/v1/reports', party,
      { profile: rights ? 'rights-complaint-v1' : 'content-report-v1', actingSubject: party.actor,
        authority: { kind: 'platform', scopeId: 'governance:platform' }, context: 'urn:rezics:context:global',
        target: { owner: options.revision ? 'content' : 'graph', resource, component: options.component ?? 'record' },
        disclosure: 'parties', reasonCode: 'reviewed_removal', statement: 'Review the exact named target',
        evidence: [{ owner: options.revision ? 'content' : 'graph', resource, component: options.component ?? 'record',
          revision: options.revision ?? null, locator: null }],
        idempotencyKey: key, ...(rights ? { complaint: { process: 'ordinary_dispute', claimantKind: 'rights_holder',
          claimantName: 'Case party', claimantContact: null, claimedWork: 'Realm discussion', claimedRight: 'copyright',
          noticeDigest: sha(resource), noticeReceivedAt: new Date().toISOString() } } : {}) }, key), 201);
  const claimKey = randomUUID();
  await json(await call('POST', `/v1/safety-cases/${report.caseId}/claim`, platform,
    { actingSubject: platform.actor, idempotencyKey: claimKey }, claimKey));
  const basis = await json<{ generation: string; reports: { evidenceDigest: string }[] }>(await call('GET',
    `/v1/safety-cases/${report.caseId}?actingSubject=${encodeURIComponent(platform.actor)}`, platform));
  const input: DecisionInput = { caseId: report.caseId, expectedGeneration: basis.generation,
    actingSubject: platform.actor, outcome: rights ? 'interim_restrict' : 'restrict',
    targets: [{ owner: options.revision ? 'content' : 'graph', resource, component: options.component ?? 'record',
      locator: null, scopeKind: options.revision ? 'exact_revision' : 'component', revision: options.revision ?? null,
      expectedHead: options.expectedHead ?? options.revision ?? await head(resource), effect: options.effect ?? 'disclosure' }],
    rule, evidenceDigest: basis.reports[0]!.evidenceDigest, reversesDecisionId: null,
    answersStepId: null, rationale: 'Exact platform finding', disclosure: 'parties', reasons: fixtureReasons,
    idempotencyKey: randomUUID() };
  const endpoint = rights ? '/v1/rights/restrictions' : '/v1/moderation/decisions';
  let response = await observable(await call('POST', endpoint, platform,
    { profile: rights ? 'rights-restriction-v1' : 'moderation-decision-v1', ...input }, input.idempotencyKey));
  let result = response.status === 200 || response.status === 202 ? JSON.parse(response.body) as DecisionResult : null;
  for (let attempt = 0; attempt < 3 && result?.operation.status !== 'completed' && response.status === 202; attempt++) {
    response = await observable(await call('POST', endpoint, platform,
      { profile: rights ? 'rights-restriction-v1' : 'moderation-decision-v1', ...input }, input.idempotencyKey));
    result = response.status === 200 || response.status === 202 ? JSON.parse(response.body) as DecisionResult : null;
  }
  return { input, response, result, reportId: report.reportId };
}
async function restore(original: Decision, resource: string, rights = false): Promise<Decision> {
  completed(original, 'Restriction prerequisite (trust-ops session 1)');
  const key = randomUUID();
  await json(await call('POST', `/v1/safety-cases/${original.input.caseId}/claim`, platform,
    { actingSubject: platform.actor, idempotencyKey: key }, key));
  const basis = await json<{ generation: string }>(await call('GET',
    `/v1/safety-cases/${original.input.caseId}?actingSubject=${encodeURIComponent(platform.actor)}`, platform));
  const input: DecisionInput = { ...original.input, expectedGeneration: basis.generation, outcome: 'restore',
    targets: [{ ...original.input.targets[0]!, expectedHead: await head(resource) }],
    reversesDecisionId: original.result!.decisionId, idempotencyKey: randomUUID() };
  const endpoint = rights ? '/v1/rights/restrictions' : '/v1/moderation/decisions';
  const profile = rights ? 'rights-restriction-v1' : 'moderation-decision-v1';
  let response = await observable(await call('POST', endpoint, platform, { profile, ...input }, input.idempotencyKey));
  for (let attempt = 0; attempt < 3 && response.status === 202; attempt++) {
    response = await observable(await call('POST', endpoint, platform, { profile, ...input }, input.idempotencyKey));
  }
  return { input, response, result: response.status === 200 ? JSON.parse(response.body) as DecisionResult : null,
    reportId: original.reportId };
}
function completed(decision: Decision, purpose: string) {
  expect(decision.response.status, `${purpose}: Governance Realm target must confirm; ${decision.response.body}`).toBe(200);
  expect(decision.result?.operation.status, purpose).toBe('completed');
}

async function settleReadProjections() {
  const { relayPool, relayConsumer, feedWorker } = stack.composition;
  if (!relayPool || !relayConsumer || !feedWorker) throw new Error('Closure fixture needs the composed read projection owners');
  await initializeRelayCheckpoint(relayPool, relayConsumer, stack.env.lineage.dataEpoch);
  for (let batch = 0; batch < 400; batch++) {
    if (!await relayMainOutboxOnce(stack.fuseki, relayPool, relayConsumer)) {
      for (let page = 0; page < 400; page++) if (await feedWorker.tick() === 'current') return;
      throw new Error('Closure fixture read projection exceeded its preparation budget');
    }
  }
  throw new Error('Closure fixture relay exceeded its preparation budget');
}

beforeAll(async () => {
  stack = await startMediaStack('realm-platform-closure');
  app = createMainApp(stack.fuseki, { ...stack.composition.dependencies,
    account: { verify: async request => {
      const principal = principals.get(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      if (!principal) throw new AccountAssertionDenied('Unknown closure fixture bearer');
      return principal;
    } } });
  // A provisioned organization with explicit fixture authority owns this multi-Space
  // corpus; an ordinary Person's three monthly Space creations remain a product limit.
  builder = await provision('Corpus builder', 'organization'); manager = await provision('Realm manager'); member = await provision('Realm member');
  party = await provision('Case party'); platform = await provision('Platform decider');
  await grant(builder, 'space:create:root', 'space.create');
  realm = await createRealm('Platform closure community'); unaffected = await createRealm('Unaffected community');
  privateRealm = await createRealm('Private request community', 'private');
  const privateSettings = await json<{ generation: string }>(await call('GET',
    `/v1/spaces/${short(privateRealm.space)}/settings?actingSubject=${encodeURIComponent(builder.actor)}`, builder));
  await json(await call('PUT', `/v1/spaces/${short(privateRealm.space)}/settings`, builder, {
    actingSubject: builder.actor, expectedGeneration: privateSettings.generation,
    settings: { visibility: 'private', listing: 'listed', admission: 'request', history: 'everything' },
    reason: 'Private request restoration control' }), 201);
  unlistedRealm = await createRealm('Unlisted community');
  const settings = await json<{ generation: string; settings: object }>(await call('GET',
    `/v1/spaces/${short(unlistedRealm.space)}/settings?actingSubject=${encodeURIComponent(builder.actor)}`, builder));
  await json(await call('PUT', `/v1/spaces/${short(unlistedRealm.space)}/settings`, builder, {
    actingSubject: builder.actor, expectedGeneration: settings.generation,
    settings: { visibility: 'public', listing: 'unlisted', admission: 'open', history: 'everything' },
    reason: 'Unlisted restoration control' }), 201);
  const policy = await json<{ policyRevision: string; termsRevision: string }>(await call('GET',
    `/v1/realms/${short(realm.realm)}/joining?actingSubject=${encodeURIComponent(member.actor)}`, member));
  await grant(member, 'work:create:root', 'access.membership.consent');
  const consent = await json<{ consentReference: string }>(await call('POST', '/v1/me/membership-consents', member,
    { profile: 'access-membership-consent-v1', kind: 'realm', ownerSubject: realm.realm, memberSubject: member.actor,
      expectedGeneration: '0', expectedPolicyRevision: policy.policyRevision, termsRevision: policy.termsRevision }));
  const admin = await json<{ generation: string }>(await call('GET',
    `/v1/realms/${short(realm.realm)}/settings?actingSubject=${encodeURIComponent(builder.actor)}`, builder));
  await json(await call('POST', `/v1/realms/${short(realm.realm)}/members`, builder, {
    actingSubject: builder.actor, expectedGeneration: admin.generation, member: member.actor,
    expectedMembershipGeneration: '0', action: 'add', consent: consent.consentReference,
    durationSeconds: null, reason: 'Admitted closure reader' }), 201);
  await json(await call('PUT', `/v1/realms/${short(realm.realm)}/roster/listing`, member,
    { actingSubject: member.actor, expectedMembershipGeneration: '1', listed: true }));
  await grant(manager, 'work:create:root', 'access.membership.consent');
  for (const target of [realm, unaffected, privateRealm, unlistedRealm]) await installManager(target);
  const original = await createWork(); work = original;
  await grant(manager, `work:read:${work.work}`, 'work.read');
  await grant(manager, `reply:place:${realm.realm}`, 'reply.place');
  await grant(party, `work:read:${work.work}`, 'work.read');
  await grant(builder, `publication:adopt:${realm.realm}`, 'publication.adopt');
  const adopted = await json<{ selection: string }>(await call('POST', '/v1/publication-selections', builder,
    { profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: realm.realm }, work: work.work,
      mainVersion: work.mainVersion, contribution: original.contribution, publicationDecision: original.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review', actingSubject: builder.actor }), 201);
  selection = adopted.selection;
  await grant(builder, `work:read:${work.work}`, 'work.read');
  opener = await place('Closure acceptance thread\nApproved public discussion');
  reply = await place('Approved reply retained through restoration', opener);
  restrictedReply = await place('Independently restricted reply', opener);
  await grant(member, `media:owner:${member.actor}`, 'media.upload');
  const imageBytes = png(32, 32);
  const reserved = await json<{ asset: string; upload: string }>(await call('POST', '/v1/media/uploads', member,
    { profile: 'media-image-upload-v1', asset: null, mediaType: 'image/png', byteLength: imageBytes.length,
      sha256: sha(imageBytes), disclosure: 'public', actingSubject: member.actor }), 201);
  const activated = await json<{ representation: string }>(await app.handle(new Request(
    `http://main.local/v1/media/uploads/${reserved.upload}/bytes`, { method: 'PUT',
      headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/octet-stream' },
      body: new Blob([imageBytes]) })), 201);
  // Match the media stack's deterministic benign screening fixture.
  const screens = new MediaScreenStore(stack.contentPool);
  for (let count = 0; count < 100; count++) {
    const lease = await screens.leaseNext();
    if (!lease) break;
    await screens.settle(lease, screenVerdict({ Drawing: 0.05, Hentai: 0.01, Neutral: 0.9, Porn: 0.01, Sexy: 0.03 }));
  }
  await grant(member, `content:publish:${reply.reply}`, 'media.use');
  const imageUse = await json<{ use: string }>(await call('POST', '/v1/media/uses', member,
    { target: reply.reply, representation: activated.representation, occurrence: randomUUID(),
      context: realm.realm, actingSubject: member.actor }), 201);
  replyImage = { asset: reserved.asset, representation: activated.representation, use: imageUse.use,
    digest: sha(imageBytes) };
  sites = [];
  const same = { zone: native(), space: realm.space };
  await grant(builder, `zone:edit:${same.zone}`, 'zone.edit');
  const created = await json<{ revision: string }>(await call('POST', '/v1/zones', builder,
    { ...same, disclosure: 'public', name: 'Same Space site', language: 'en', actingSubject: builder.actor }), 201);
  sites.push({ ...same, navigationRevision: created.revision });
  sites.push(await json<Site>(await call('POST', '/v1/spaces', builder,
    { profile: 'space-zone-v1', name: 'Cross Space site', language: 'en', capabilities: ['zone'],
      visibility: 'public', listing: 'listed', actingSubject: builder.actor }), 201));
  for (const site of sites) {
    await grant(builder, `zone:edit:${site.zone}`, 'zone.edit');
    await grant(builder, `realm:attach:${realm.realm}`, 'realm.attach');
    await json(await call('PUT', `/v1/zones/${short(site.zone)}/configuration`, builder,
      { expectedHead: (await readZoneConfiguration(stack.env, site.zone)).revision, defaultRealm: realm.realm,
        presentation: { ...DEFAULT_ZONE_PRESENTATION, modules: [{ id: 'latest', type: 'shelf',
          title: 'Latest Realm adoptions', source: { kind: 'query-block', block: 'new-adoptions' } }] },
        actingSubject: builder.actor }));
    const mount = await json<{ revision: string }>(await call('POST', `/v1/zones/${short(site.zone)}/mounts`, builder,
      { expectedHead: site.navigationRevision, target: work.work, routeSegment: 'original',
        disclosure: 'public', actingSubject: builder.actor }));
    site.navigationRevision = mount.revision;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    await json(await call('PUT', `/v1/zones/${short(site.zone)}/configuration`, builder, {
      expectedHead: (await readZoneConfiguration(stack.env, site.zone)).revision,
      prepareHomeDocument: true, actingSubject: builder.actor,
    }));
    const homeDocument = (await readZoneConfiguration(stack.env, site.zone)).homeDocument!;
    const draftResponse = await call('POST', '/v1/content-drafts', builder,
      { profile: 'content-text-v1', resourceId: homeDocument, variantId,
        expectedHead: null, document: fromPlainText('Independent Zone home document', 'blocks'),
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', actingSubject: builder.actor });
    site.homeDraftStatus = draftResponse.status;
    // The same-Space Zone's ordinary editor has no Zone-only Space creation receipt.
    // Keep that missing Content authority adapter inside the named acceptance case.
    if (site.space === realm.space && draftResponse.status === 403) continue;
    const draft = await json<{ revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string } }>(draftResponse, 201);
    site.homeRevision = draft.revisionId;
    await grant(party, `work:read:${site.zone}`, 'work.read');
    await json(await call('POST', `/v1/zones/${short(site.zone)}/site-publications`, builder,
      { routesRevision: site.navigationRevision, navigationRevision: site.navigationRevision,
        expectedHead: (await readZoneConfiguration(stack.env, site.zone)).revision, actingSubject: builder.actor,
        pages: [{ page: homeDocument, variantId, revisionId: draft.revisionId, byteDigest: draft.byteDigest,
          contentEpoch: draft.sourcePosition.dataEpoch }] }), 201);
  }
  for (const action of ['governance.moderate', 'governance.rights.decide', 'governance.safety.evidence', 'governance.rule.publish']) {
    await grant(platform, 'governance:platform', action);
  }
  const key = randomUUID();
  const publishedRule = await json<DecisionInput['rule']>(await call('POST', '/v1/governance/rules', platform,
    { profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`, scopeId: 'governance:platform',
      actingSubject: platform.actor, expectedRevision: null, document: { rule: 'Platform closure acceptance' },
      idempotencyKey: key }, key), 201);
  rule = { ref: publishedRule.ref, revision: publishedRule.revision, digest: publishedRule.digest };
  replyRestriction = await decide(restrictedReply.reply,
    { component: 'body', revision: restrictedReply.revisionId });
  await settleReadProjections();
  await waitForRealmDirectory(stack.env, () => call('GET', '/v1/realms'));
}, 180_000);

afterAll(async () => { if (app) await app.stop(); if (stack) await stack.stop(); });

const surfaces = ['home', 'landing', 'works', 'selection', 'threads', 'best', 'top', 'thread', 'reply', 'roster', 'zone'] as const;
function pathFor(surface: typeof surfaces[number], id: string) {
  const root = `/v1/realms/${short(id)}`;
  return surface === 'home' ? root : surface === 'landing' ? `${root}/join-page`
    : surface === 'best' || surface === 'top' ? `${root}/threads?sort=${surface}&window=all`
    : surface === 'selection' ? `${root}/decisions/${short(selection)}`
      : surface === 'thread' ? `${root}/threads/${short(opener.reply)}`
        : surface === 'reply' ? `${root}/threads/${short(reply.reply)}` : `${root}/${surface}`;
}
for (const state of states) describe(state, () => {
  const acceptanceTest = state === 'public' ? test : test.failing;
  beforeAll(async () => {
    if (state === 'closed') closure = await decide(realm.realm);
    if (state === 'restored' && closure.result?.operation.status === 'completed') {
      restoration = await restore(closure, realm.realm);
      if (restoration.result?.operation.status === 'completed') {
        await settleReadProjections();
        await waitForRealmDirectory(stack.env, () => call('GET', '/v1/realms'),
          page => page.items.some(item => item.id === realm.realm));
      }
    }
  }, 30_000);
  function ready() {
    if (state !== 'public') completed(closure, 'whole-Realm closure prerequisite (trust-ops session 1)');
    if (state === 'restored') completed(restoration, 'whole-Realm restoration prerequisite (trust-ops session 1)');
  }
  for (const reader of readers) {
    // Realm Governance closure/restoration and direct Realm read gates are missing.
    for (const surface of surfaces) {
      // Realm Zone entry selection cannot distinguish the same-Space Zone from cross-Space attachments.
      const surfaceTest = surface === 'zone' ? test.failing : acceptanceTest;
      surfaceTest(`${state}-${surface}-${reader}`, async () => {
      ready();
      if (state === 'closed') {
        const actual = await observable(await get(pathFor(surface, realm.realm), reader));
        const absent = await observable(await get(pathFor(surface, native()), reader));
        expect(absent.status).toBe(404); expect(actual).toEqual(absent);
      } else {
        const response = await get(pathFor(surface, realm.realm), reader);
        // A public Realm has no request-admission landing; restoration preserves that policy.
        if (surface === 'landing') { expect(response.status).toBe(404); return; }
        const body = await json<Record<string, unknown>>(response);
        if (surface === 'home') expect(body.name).toMatchObject({ value: 'Platform closure community' });
        if (surface === 'works') expect((body.items as { id: string }[]).map(item => item.id)).toContain(work.work);
        if (surface === 'roster') expect((body.items as { agent: string }[]).map(item => item.agent)).toContain(member.actor);
        if (surface === 'zone') expect(body.realm).toBe(realm.realm);
        if (surface === 'threads' || surface === 'best' || surface === 'top') {
          expect((body.items as { reply: string }[]).map(item => item.reply)).toContain(opener.reply);
        }
        if (surface === 'reply') expect(JSON.stringify(body)).toContain('Approved reply retained through restoration');
      }
      });
    }
    // Realm closure gating in the placement and root-count read adapters is missing.
    for (const surface of ['reply-placement', 'reply-root-count'] as const) {
      acceptanceTest(`${state}-${surface}-${reader}`, async () => {
        ready();
        const route = (id: string) => `/v1/realms/${encodeURIComponent(id)}/${surface === 'reply-placement'
          ? `replies/${encodeURIComponent(reply.reply)}` : `reply-roots/${encodeURIComponent(work.work)}/count`}`
          + `?actingSubject=${encodeURIComponent(actorFor(reader)?.actor ?? member.actor)}`;
        const actual = await call('GET', route(realm.realm), actorFor(reader));
        if (reader === 'anonymous') {
          expect(actual.status).toBe(401);
          expect(await observable(actual)).toEqual(await observable(await call('GET', route(native()))));
        } else if (state === 'closed') {
          const absent = await observable(await call('GET', route(native()), actorFor(reader)));
          expect(absent.status).toBe(404);
          expect(await observable(actual)).toEqual(absent);
        } else {
          const body = await json<{ placement?: string; revisionId?: string; count?: number }>(actual);
          if (surface === 'reply-placement') expect(body).toMatchObject({ placement: reply.placement, revisionId: reply.revisionId });
          else expect(body.count).toBeGreaterThanOrEqual(2);
        }
      });
    }
    // Exact Content revision target resolution for reviewed Realm replies is missing.
    test.failing(`${state}-reply-exact-Content-revision-${reader}`, async () => {
      ready();
      const actual = await get(`/v1/content-revisions/${reply.revisionId}`, reader);
      if (state === 'closed') {
        const absent = await observable(await get(`/v1/content-revisions/${randomUUID()}`, reader));
        expect(absent.status).toBe(404); expect(await observable(actual)).toEqual(absent);
      } else expect(JSON.stringify(await json(actual))).toContain('Approved reply retained through restoration');
    });
    // Reply-target media delivery and its current Realm occurrence fence are missing.
    for (const surface of ['use', 'representation', 'representation-bytes'] as const) {
      test.failing(`${state}-reply-media-${surface}-${reader}`, async () => {
        ready();
        const route = (missing = false) => surface === 'use'
          ? `/v1/media/uses/${missing ? randomUUID() : replyImage.use}`
          : `/v1/media/representations/${missing ? randomUUID() : replyImage.representation}`
            + `${surface === 'representation-bytes' ? '/bytes' : ''}?use=${missing ? randomUUID() : replyImage.use}`;
        const actual = await get(route(), reader);
        if (state === 'closed') {
          const absent = await observable(await get(route(true), reader));
          expect(absent.status).toBe(404); expect(await observable(actual)).toEqual(absent);
        } else if (surface === 'representation') {
          expect(await json(actual)).toMatchObject({ sha256: replyImage.digest });
        } else {
          expect(actual.status).toBe(200);
          expect(sha(new Uint8Array(await actual.arrayBuffer()))).toBe(replyImage.digest);
        }
      });
    }
    // Realm Governance closure and restoration are missing.
    acceptanceTest(`${state}-directory-${reader}`, async () => {
      ready();
      for (const sort of ['activity', 'members', 'newest', 'growing']) {
        const page = await json<Page>(await get(`/v1/realms?sort=${sort}`, reader));
        expect(page.items.map(item => item.id)).toContain(unaffected.realm);
        if (state === 'closed') {
          expect(page.items.map(item => item.id)).not.toContain(realm.realm);
          expect(JSON.stringify(page)).not.toContain('Platform closure community');
        } else expect(page.items.map(item => item.id)).toContain(realm.realm);
        expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
      }
      const search = await json<Page>(await get('/v1/realms?q=Platform%20closure', reader));
      expect(search.items.map(item => item.id)).toEqual(state === 'closed' ? [] : [realm.realm]);
    });
    for (const [index, space] of ['same-Space', 'cross-Space'].entries()) {
      // Same-Space Zone Content authority, Realm closure and mounted Realm occurrence disclosure adapters are missing.
      const zoneTest = index === 0 ? test.failing : acceptanceTest;
      zoneTest(`${state}-${space}-Zone-discussion-and-own-pages-${reader}`, async () => {
        ready(); const site = sites[index]!;
        expect(site.homeDraftStatus, `${space} Zone editors must publish their own home document`).toBe(201);
        const routes = await json<{ realm: string | null; page?: unknown }>(await get(
          `/v1/zones/${short(site.zone)}/routes?path=%2F`, reader));
        const presentation = await json<{ realm: string | null; presentation: { modules: { id: string }[] };
          moduleData: { id: string; sources: { state: string; source: { kind: string; block: string } }[] }[] }>(
          await get(`/v1/zones/${short(site.zone)}/presentation`, reader));
        expect(routes.realm).toBe(state === 'closed' ? null : realm.realm);
        expect(presentation.realm).toBe(state === 'closed' ? null : realm.realm);
        expect(JSON.stringify(routes.page)).toContain('Independent Zone home document');
        expect(presentation.presentation.modules.map(module => module.id)).toContain('latest');
        const module = presentation.moduleData.find(module => module.id === 'latest');
        expect(module).toBeDefined();
        expect(module!.sources).toContainEqual(expect.objectContaining({
          state: state === 'closed' ? 'unavailable' : 'public-read',
          source: { kind: 'query-block', block: 'new-adoptions' } }));
        const exact = await get(`/v1/content-revisions/${site.homeRevision}`, reader);
        expect(exact.status).toBe(200);
        expect(await exact.text()).toContain('Independent Zone home document');
        const ownWork = await json<{ resource: { id: string } }>(await get(
          `/v1/zones/${short(site.zone)}/routes?path=%2Foriginal`, reader));
        expect(ownWork.resource.id).toBe(work.work);
        const mounted = `/v1/realms/${short(realm.realm)}/modules/new-adoptions`;
        if (state === 'closed') {
          const absent = await observable(await get(`/v1/realms/${short(native())}/modules/new-adoptions`, reader));
          expect(absent.status).toBe(404); expect(await observable(await get(mounted, reader))).toEqual(absent);
        } else {
          expect((await json<Page>(await get(mounted, reader))).items.map(item => item.id)).toContain(work.work);
        }
      });
    }
    // Realm Governance closure and restoration are missing.
    acceptanceTest(`${state}-independent-publication-${reader}`, async () => {
      ready(); expect((await get(`/v1/works/${short(work.work)}`, reader)).status).toBe(200);
    });
    // Realm Governance closure/restoration and current feed occurrence ancestry are missing.
    acceptanceTest(`${state}-feed-${reader}: retained Realm occurrences follow current disclosure`, async () => {
      ready();
      // A completed decision is enough for omission; no feed drain runs in the
      // closed phase. Public originals remain independently eligible.
      const page = await json<{ items: { id: string; realm: { id: string } | null }[] }>(
        await get('/v1/feed?scope=all&sort=new&limit=20', reader));
      if (state === 'closed') {
        expect(page.items.some(item => item.realm?.id === realm.realm)).toBe(false);
        const delivered = JSON.stringify(page.items);
        for (const occurrence of [realm.realm, selection, opener.reply, opener.placement, reply.reply, reply.placement]) {
          expect(delivered).not.toContain(occurrence);
        }
        expect(delivered).not.toContain('Approved public discussion');
        expect(delivered).not.toContain('Approved reply retained through restoration');
      } else expect(page.items.some(item => item.realm?.id === realm.realm)).toBe(true);
    });
    // Realm Governance closure/restoration before independent reply fence checks is missing.
    acceptanceTest(`${state}-independently-restricted-reply-${reader}`, async () => {
      ready(); completed(replyRestriction, 'Independent reply restriction');
      expect((await get(`/v1/realms/${short(realm.realm)}/threads/${short(restrictedReply.reply)}`, reader)).status).toBe(404);
      if (state !== 'closed') {
        const thread = await json<{ items: { reply: string; body: string; title: string | null;
          author: unknown; document?: unknown }[] }>(await get(
          `/v1/realms/${short(realm.realm)}/threads/${short(opener.reply)}`, reader));
        // A body restriction may retain a neutral position in the parent chain.
        const retained = thread.items.find(item => item.reply === restrictedReply.reply);
        if (retained) expect(retained).toMatchObject({ body: '', title: null, author: null });
        expect(retained?.document).toBeUndefined();
        expect(JSON.stringify(thread)).not.toContain('Independently restricted reply');
      }
    });
  }
});

// Realm record rights restriction and notice restoration are missing.
test.failing('rights whole-Realm restriction confirms through existing rights and notice APIs', async () => {
  const decision = await decide(unaffected.realm, { rights: true });
  completed(decision, 'Rights Realm target prerequisite (trust-ops session 1)');
  for (const reader of readers) {
    expect(await observable(await get(`/v1/realms/${short(unaffected.realm)}`, reader)))
      .toEqual(await observable(await get(`/v1/realms/${short(native())}`, reader)));
  }
  const notices = await json<{ items: { caseId: string }[] }>(await call('GET', '/v1/safety-notices', builder));
  expect(notices.items.some(item => item.caseId === decision.input.caseId)).toBe(true);
  const reopened = await restore(decision, unaffected.realm, true);
  completed(reopened, 'Rights notice restoration prerequisite (trust-ops session 1)');
  expect((await get(`/v1/realms/${short(unaffected.realm)}`, 'anonymous')).status).toBe(200);
});

// Realm record evidence for Governance search restrictions is missing.
test.failing('narrow Realm search restriction is not whole-Realm closure', async () => {
  searchRestriction = await decide(unlistedRealm.realm, { effect: 'search' });
  completed(searchRestriction, 'Narrow Realm target prerequisite (trust-ops session 1)');
  for (const reader of readers) expect((await get(`/v1/realms/${short(unlistedRealm.realm)}`, reader)).status).toBe(200);
});

test('stale Realm head never confirms a closure', async () => {
  const stale = await decide(unlistedRealm.realm, { expectedHead: native() });
  expect(stale.response.status).toBe(409);
  expect(stale.result?.operation.status).not.toBe('completed');
  expect((await get(`/v1/realms/${short(unlistedRealm.realm)}`, 'anonymous')).status).toBe(200);
});

test('Realm manager cannot close a Realm through a platform decision', async () => {
  const input = { ...closure.input, actingSubject: manager.actor, idempotencyKey: randomUUID() };
  expect((await call('POST', '/v1/moderation/decisions', manager,
    { profile: 'moderation-decision-v1', ...input }, input.idempotencyKey)).status).toBe(403);
});

// Platform Realm closure confirmation before the restoration authority check is missing.
test.failing('Realm manager cannot restore a platform-closed Realm', async () => {
  completed(closure, 'Closure prerequisite (trust-ops session 1)');
  const input = { ...closure.input, outcome: 'restore', actingSubject: manager.actor,
    reversesDecisionId: closure.result!.decisionId, idempotencyKey: randomUUID() };
  expect((await call('POST', '/v1/moderation/decisions', manager,
    { profile: 'moderation-decision-v1', ...input }, input.idempotencyKey)).status).toBe(403);
});

// Realm closure/restoration and private request landing disclosure are missing.
test.failing('private request landing is absent while closed and returns its prior admission policy after restoration', async () => {
  const route = `/v1/realms/${short(privateRealm.realm)}/join-page`;
  const before = await json<{ action: { kind: string } }>(await call('GET', route));
  expect(before.action.kind).toBe('request');
  const decision = await decide(privateRealm.realm);
  completed(decision, 'Private Realm target prerequisite (trust-ops session 1)');
  expect(await observable(await call('GET', route)))
    .toEqual(await observable(await call('GET', `/v1/realms/${short(native())}/join-page`)));
  completed(await restore(decision, privateRealm.realm), 'Private Realm restoration');
  expect((await json<{ action: { kind: string } }>(await call('GET', route))).action.kind).toBe('request');
  expect((await get(`/v1/realms/${short(privateRealm.realm)}`, 'anonymous')).status).toBe(404);
});

// Realm Governance restriction and restoration are missing.
test.failing('whole-Realm restore preserves a narrower search restriction and unlisted policy', async () => {
  completed(searchRestriction, 'Search target prerequisite (trust-ops session 1)');
  const decision = await decide(unlistedRealm.realm);
  completed(decision, 'Whole-Realm target prerequisite (trust-ops session 1)');
  completed(await restore(decision, unlistedRealm.realm), 'Whole-Realm restoration with independent search fence');
  const home = await json<{ listing: string }>(await get(`/v1/realms/${short(unlistedRealm.realm)}`, 'anonymous'));
  expect(home.listing).toBe('unlisted');
  const fences = await stack.accessPool.query<{ decision_id: string; effect: string; state: string }>(
    'SELECT decision_id,effect,state FROM access.governance_enforcement WHERE resource=$1', [unlistedRealm.realm]);
  expect(fences.rows).toContainEqual(expect.objectContaining({ decision_id: searchRestriction.result!.decisionId,
    effect: 'search', state: 'restricted' }));
});

// Zone record Governance target evidence and public route/presentation disclosure adapters are missing.
test.failing('a named Zone record decision closes the Zone while its attached Realm and discussion remain available', async () => {
  const site = sites.find(site => site.homeRevision)!;
  expect(site).toBeDefined();
  const decision = await decide(site.zone, { component: 'record' });
  completed(decision, 'Zone record target prerequisite');
  await settleReadProjections();
  try {
    for (const reader of readers) {
      expect((await get(`/v1/realms/${short(realm.realm)}`, reader)).status).toBe(200);
      expect((await get(`/v1/realms/${short(realm.realm)}/threads/${short(opener.reply)}`, reader)).status).toBe(200);
      for (const path of ['/routes?path=%2F', '/presentation']) {
        const absent = await observable(await get(`/v1/zones/${short(native())}${path}`, reader));
        expect(absent.status).toBe(404);
        expect(await observable(await get(`/v1/zones/${short(site.zone)}${path}`, reader))).toEqual(absent);
      }
    }
  } finally {
    completed(await restore(decision, site.zone), 'Independent Zone restoration');
  }
});

// Zone record Governance evidence, Realm closure/restoration and current binding disclosure adapters are missing.
test.failing('restoration uses current placement, detachment, reassignment and independent Zone restriction bindings', async () => {
  const removed = await place('Placement removed during closure', opener);
  const changed = await place('Placement replaced during closure', opener);
  const restricted = await json<Site>(await call('POST', '/v1/spaces', builder,
    { profile: 'space-zone-v1', name: 'Independently restricted site', language: 'en', capabilities: ['zone'],
      visibility: 'public', listing: 'listed', actingSubject: builder.actor }), 201);
  await grant(builder, `zone:edit:${restricted.zone}`, 'zone.edit');
  const configure = async (zone: string, defaultRealm: string | null) => json(await call('PUT',
    `/v1/zones/${short(zone)}/configuration`, builder,
    { expectedHead: (await readZoneConfiguration(stack.env, zone)).revision, defaultRealm,
      actingSubject: builder.actor }));
  await configure(restricted.zone, realm.realm);
  sites.push({ ...restricted, navigationRevision: (await readZoneConfiguration(stack.env, restricted.zone)).revision });
  const zoneRestriction = await decide(restricted.zone);
  completed(zoneRestriction, 'Independent Zone record restriction');
  const decision = await decide(realm.realm);
  completed(decision, 'Whole-Realm closure before binding changes');
  await json(await call('POST', '/v1/realm-reply-reviews', manager,
    { profile: 'realm-reply-review-v1', realm: realm.realm, reply: removed.reply,
      revisionId: removed.revisionId, revisionDigest: removed.revisionDigest,
      expectedGeneration: '1', supersedes: removed.reviewDecisionId, outcome: 'revoked',
      method: 'human', methodRevision: 'realm-manager-v1', dependencyDigest: sha(work.work),
      reasonReference: 'placement-removed-during-closure', actingSubject: manager.actor }), 201);
  const replacement = await json<{ revisionId: string; revisionDigest: string }>(await call('POST',
    '/v1/member-reply-drafts', member,
    { profile: 'member-reply-draft-v1', reply: changed.reply, variantId: changed.variantId,
      rootTarget: work.work, rootRevision: work.workRevision, originRealm: realm.realm,
      language: 'en', direction: 'ltr', expectedHead: changed.revisionId,
      body: 'Current replacement placement', actingSubject: member.actor }), 201);
  const approval = await json<{ decisionId: string }>(await call('POST', '/v1/realm-reply-reviews', manager,
    { profile: 'realm-reply-review-v1', realm: realm.realm, reply: changed.reply,
      revisionId: replacement.revisionId, revisionDigest: replacement.revisionDigest,
      expectedGeneration: '0', supersedes: null, outcome: 'approved', method: 'human',
      methodRevision: 'realm-manager-v1', dependencyDigest: sha(work.work), reasonReference: null,
      actingSubject: manager.actor }), 201);
  const placement = await json<{ placement: string }>(await call('POST', '/v1/realm-reply-placements', manager,
    { profile: 'realm-reply-placement-v1', realm: realm.realm, reply: changed.reply,
      ...replacement, reviewDecisionId: approval.decisionId, expectedHead: changed.placement,
      actingSubject: manager.actor }), 201);
  await configure(sites[0]!.zone, null);
  await grant(builder, `realm:attach:${unaffected.realm}`, 'realm.attach');
  await configure(sites[1]!.zone, unaffected.realm);
  completed(await restore(decision, realm.realm), 'Whole-Realm restoration after binding changes');
  for (const reader of readers) {
    expect((await get(`/v1/realms/${short(realm.realm)}/threads/${short(removed.reply)}`, reader)).status).toBe(404);
    const delivered = await json(await get(`/v1/realms/${short(realm.realm)}/threads/${short(changed.reply)}`, reader));
    expect(JSON.stringify(delivered)).toContain('Current replacement placement');
    expect(JSON.stringify(delivered)).not.toContain('Placement replaced during closure');
    if (reader !== 'anonymous') {
      const current = await json(await get(`/v1/realms/${encodeURIComponent(realm.realm)}/replies/${encodeURIComponent(changed.reply)}`, reader));
      expect(current).toMatchObject({ revisionId: replacement.revisionId, placement: placement.placement });
    }
    for (const [site, currentRealm] of [[sites[0]!, null], [sites[1]!, unaffected.realm]] as const) {
      expect(await json(await get(`/v1/zones/${short(site.zone)}/routes?path=%2F`, reader)))
        .toMatchObject({ realm: currentRealm });
    }
    expect((await get(`/v1/zones/${short(restricted.zone)}/presentation`, reader)).status).toBe(404);
  }
  const fences = await stack.accessPool.query<{ decision_id: string; state: string }>(
    'SELECT decision_id,state FROM access.governance_enforcement WHERE resource=$1', [restricted.zone]);
  expect(fences.rows).toContainEqual(expect.objectContaining({ decision_id: zoneRestriction.result!.decisionId,
    state: 'restricted' }));
});

test('Realm-local moderation authority cannot decide whole-Realm closure', async () => {
  const scopeId = `governance:realm:${realm.realm}`;
  await grant(manager, scopeId, 'governance.moderate');
  const ruleKey = randomUUID();
  const localRule = await json<DecisionInput['rule']>(await call('POST', '/v1/governance/rules', manager,
    { profile: 'governance-rule-v1', ref: `urn:rezics:rule:${randomUUID()}`, scopeId,
      actingSubject: manager.actor, expectedRevision: null, document: { rule: 'Realm-local moderation' },
      idempotencyKey: ruleKey }, ruleKey), 201);
  const reportKey = randomUUID();
  const report = await json<ReportResult>(await call('POST', '/v1/reports', manager,
    { profile: 'content-report-v1', actingSubject: manager.actor, authority: { kind: 'realm', scopeId },
      context: realm.realm, target: { owner: 'graph', resource: realm.realm, component: 'record' },
      disclosure: 'parties', reasonCode: 'reviewed_removal', statement: 'Realm owner request',
      evidence: [{ owner: 'graph', resource: realm.realm, component: 'record', revision: null, locator: null }],
      idempotencyKey: reportKey }, reportKey), 201);
  const input: DecisionInput = { caseId: report.caseId, expectedGeneration: report.caseGeneration,
    actingSubject: manager.actor, outcome: 'restrict', targets: [{ owner: 'graph', resource: realm.realm,
      component: 'record', locator: null, scopeKind: 'component', revision: null,
      expectedHead: await head(realm.realm), effect: 'disclosure' }],
    rule: { ref: localRule.ref, revision: localRule.revision, digest: localRule.digest },
    evidenceDigest: report.evidenceDigest, reversesDecisionId: null, answersStepId: null,
    rationale: 'Local grant is insufficient for closure', disclosure: 'parties', reasons: fixtureReasons,
    idempotencyKey: randomUUID() };
  expect((await call('POST', '/v1/moderation/decisions', manager,
    { profile: 'moderation-decision-v1', ...input }, input.idempotencyKey)).status).toBe(403);
  expect((await get(`/v1/realms/${short(realm.realm)}`, 'anonymous')).status).toBe(200);
});
