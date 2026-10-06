import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { startTelemetry, flushTelemetryTraces, shutdownTelemetry } from '@rezics/observability/runtime';
import { profileRequest, startWorkProfileSink } from '../../../tests/qa/support/work-profile.ts';
import { workProfileCorpusApi, workProfileDimensions, WORK_PROFILE_SCALES,
  type CorpusDimensions } from '../../../scripts/load/work-profile-corpus.ts';

// Initialize instrumentation before pg or any application module is imported.
const sink = startWorkProfileSink({ settleMs: 25, maxSpans: 500_000 });
startTelemetry('main', { ...process.env, ...sink.env });
const { startHomeStack } = await import('../../../tests/qa/integration/feed-read-support.ts');
const { createMainApp } = await import('../src/app.ts');
const { GovernanceRules } = await import('../src/modules/governance/rules.ts');
const { GovernanceStore } = await import('../src/modules/governance/store.ts');
const { AccessRealmManagement } = await import('../src/modules/access/realm-management.ts');
const { AccessRealmJoining } = await import('../src/modules/access/realm-management-joining.ts');
const { AccessRealmRoster } = await import('../src/modules/access/roster.ts');
const { DEFAULT_ZONE_PRESENTATION } = await import('../src/modules/zone/presentation-format.ts');
const { readZoneConfiguration } = await import('../src/modules/zone/configuration.ts');
const { seedPublicProfileWork } = await import('../../../scripts/load/work-profile-work.ts');
const { captureFusekiQueryPlan } = await import('../../../scripts/load/fuseki-plan.ts');
const { startFusekiMeter } = await import('../../../scripts/load/measurement.ts');
const { cloneOwners, requireQa } = await import('../../../tests/qa/integration/recommendation-support.ts');

const started = performance.now();
const corpusKey = `g1026:${randomUUID()}`;
const artifacts = process.env.G1026_ARTIFACT_DIR ?? '.temp/work-profiles';
// The platform role is an immutable singleton. Each probe owns its SQL owners;
// the shared graph remains intact, and both projections start at its current cut.
const owners = await cloneOwners(requireQa(), ['access', 'content', 'relay']);
Object.assign(process.env, {
  ACCESS_DATABASE_URL: owners.urls.access,
  CONTENT_DATABASE_URL: owners.urls.content,
  ACCOUNT_RELAY_DATABASE_URL: owners.urls.relay,
});
const home = await startHomeStack(`g-1026-community-${randomUUID()}`, { projectionStart: 'current' })
  .catch(async error => {
    await owners.close();
    await shutdownTelemetry();
    await sink.stop();
    throw error;
  });
try {
const { stack } = home;
// This corpus measures community/site APIs, which do not consume Home target
// indexes. Refresh its feed/ranking references without unrelated author backfill.
home.deps.feed.projectTargets = async () => false;
const nativeQuery = stack.fuseki.query.bind(stack.fuseki);
let selectedQuery: string | undefined;
stack.fuseki.query = async (query, maxBytes) => {
  if (query.includes('SELECT DISTINCT ?id ?reply ?work ?author') && query.includes('?epochOrder')) selectedQuery = query;
  return nativeQuery(query, maxBytes);
};
const rules = new GovernanceRules(stack.accessPool);
// Diagnostic reconstruction of the prior algorithms on the same native owners;
// it changes only batching, not admission, returned data, caches or budgets.
if (process.env.G1026_PHASE === 'before') {
  rules.currentRealmHeads = async (realm, refs) => new Map((await Promise.all(refs.map(async ref => {
    const head = await rules.current(ref, `governance:realm:${realm}`);
    return head ? [ref,head] as const : null;
  }))).filter((row): row is NonNullable<typeof row> => row !== null));
  const exact = stack.store.itemDeliveryBatch.bind(stack.store);
  stack.store.itemDeliveryBatch = async uses => new Map((await Promise.all(uses.map(async use => {
    const item = (await exact([use])).get(use);
    return item ? [use,item] as const : null;
  }))).filter((row): row is NonNullable<typeof row> => row !== null));
}
const admin = new AccessRealmManagement(stack.accessPool);
const joining = new AccessRealmJoining(stack.accessPool, stack.env);
const roster = new AccessRealmRoster(stack.accessPool, stack.env);
const deps = { ...home.deps, realmAdmin: admin, realmJoining: joining, realmRoster: roster,
  governance: { rules, store: new GovernanceStore(stack.accessPool,
    { capture: async () => { throw new Error('Evidence is outside this corpus'); } },
    { current: async () => null }, rules) } };
const app = createMainApp(stack.fuseki, deps);
const apiFor = (token: string) => {
  const api = workProfileCorpusApi('http://main.local', token,
  { fetch: (async (input, init) => {
    const response = await app.handle(new Request(input, init));
    if (response.status >= 202 && response.status !== 204) {
      throw new Error(`Public corpus ${new URL(String(input)).pathname}: ${response.status} ${await response.text()}`);
    }
    return response;
  }) as typeof fetch });
  return { ...api, command: <T>(key: string, command: Parameters<typeof api.command>[1], signal?: AbortSignal) => {
    const body = command.body;
    return api.command<T>(`${corpusKey}:${key}`, { ...command,
      body: body && typeof body === 'object' && 'idempotencyKey' in body
        ? { ...body, idempotencyKey: `${corpusKey}:${body.idempotencyKey}` } : body }, signal);
  } };
};
const authorApi = apiFor(home.author.token), readerApi = apiFor(home.reader.token);
const actor = (await authorApi.command<{ agent: string }>('g1026:author', { method: 'POST', path: '/v1/agents',
  body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Community cost author' } })).agent;
const reader = (await readerApi.command<{ agent: string }>('g1026:reader', { method: 'POST', path: '/v1/agents',
  body: { profile: 'agent-provision-v1', kind: 'person', displayName: 'Community cost reader' } })).agent;
const signed = (path: `/v1/${string}`) => `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(reader)}`;
const evidence: Array<Record<string, unknown>> = [];
const profiles: Array<{ dimension: string; scale: string; operation: string; viewer: string;
  temperature: string; profile: Awaited<ReturnType<typeof profileRequest>>['profile'] }> = [];
const allDimensions = ['realmSize', 'historyDepth', 'follows', 'memberships', 'unrelatedWorks'] as const;
const selectedDimensions = allDimensions.filter(dimension=>!process.env.G1026_DIMENSIONS
  || process.env.G1026_DIMENSIONS.split(',').includes(dimension));
assert(selectedDimensions.length, 'Choose at least one known community profile dimension');
const fixed: CorpusDimensions = { unrelatedWorks: 0, unrelatedPosts: 0, follows: 0,
  memberships: 0, historyDepth: 0, realmSize: 0, conceptVocabulary: 0 };
const grant = async (scope: string, action: string) => {
  await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
  await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(),home.author.principalId,actor,action]);
  await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
    VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(),actor,scope,action]);
};
const boundedPreparation = () => assert(performance.now() - started < 600_000,
  'Public corpus preparation including readiness exceeded 600 seconds');
const createRealm = async (key: string) => {
  const created = await authorApi.command<{ realm: string; space: string }>(key, { method: 'POST', path: '/v1/spaces',
    body: { profile: 'space-realm-v1', name: key, capabilities: ['realm'], actingSubject: actor } });
  await authorApi.command(`${key}:manage`, { method: 'POST', path: `/v1/realms/${created.realm.slice(-36)}/management`,
    body: { actingSubject: actor } });
  const settings = await authorApi.read<Awaited<ReturnType<typeof admin.settings>>>(
    `/v1/realms/${created.realm.slice(-36)}/settings?actingSubject=${encodeURIComponent(actor)}`);
  await authorApi.command(`${key}:open`, { method: 'PUT', path: `/v1/realms/${created.realm.slice(-36)}/settings`,
    body: { actingSubject: actor, expectedGeneration: settings.generation,
      expectedRulesRevision: settings.ruleBasis.revision, reason: 'Cost corpus public membership',
      settings: { ...settings.settings, selfJoin: true } } });
  return created;
};
const join = async (realm: string, key: string) => {
  const policy = await readerApi.read<Awaited<ReturnType<typeof joining.policyFor>>>(
    `/v1/realms/${realm.slice(-36)}/joining?actingSubject=${encodeURIComponent(reader)}`);
  return readerApi.command(key, { method: 'POST', path: `/v1/realms/${realm.slice(-36)}/join`, body: {
    actingSubject: reader, expectedMembershipGeneration: policy.membershipGeneration,
    expectedPolicyRevision: policy.policyRevision, termsRevision: policy.termsRevision, listed: true } });
};
async function measure(dimension: string, scale: string, operation: string, path: `/v1/${string}`,
  validate: (body: any) => void) {
  if (process.env.G1026_OPERATIONS && !process.env.G1026_OPERATIONS.split(',').includes(operation)) return;
  if (operation === 'threads-best' || operation === 'threads-top') await home.project();
  for (const viewer of ['anonymous', 'member']) for (const temperature of ['first', 'warm']) {
    await flushTelemetryTraces();
    sink.clear();
    const { profile } = await profileRequest(sink, async headers => {
      if (viewer === 'member') headers.set('authorization', `Bearer ${home.reader.token}`);
      const requestPath = viewer === 'member' && operation !== 'roster' ? signed(path) : path;
      const response = await app.handle(new Request(`http://main.local${requestPath}`, { headers }));
      const body = await response.json();
      assert.equal(response.status, 200, `${requestPath}: ${JSON.stringify(body)}`);
      validate(body);
    }, { service: 'main', flush: flushTelemetryTraces });
    assert(profile.postgresStatements !== null && profile.postgresStatements > 0,
      'A real database request must export SQL spans');
    profiles.push({ dimension, scale, operation, viewer, temperature, profile });
    console.log(JSON.stringify({ stage: 'measured', dimension, scale, operation, viewer, temperature, elapsedMs: performance.now()-started }));
  }
}

  // Authorization prerequisite only; workload entities/relationships/revisions
  // still come exclusively from public commands. The reader remains an ordinary
  // person. Use the existing operator role rather than changing product quotas.
  const administratorDigest = createHash('sha256').update(corpusKey).digest('hex');
  await stack.accessPool.query('SELECT access.seed_platform_grants($1,$2)',
    [home.author.principalId,`urn:rezics:access-receipt:${administratorDigest}`]);
  const community = await createRealm('g1026:community');
  await join(community.realm, 'g1026:community:join');
  const root = `/v1/realms/${community.realm.slice(-36)}` as const;
  const zoneId = `https://rezics.com/id/${randomUUID()}`;
  await grant(`zone:edit:${zoneId}`, 'zone.edit');
  await authorApi.command('g1026:zone', { method: 'POST', path: '/v1/zones', body: {
    zone: zoneId, space: community.space, disclosure: 'public', actingSubject: actor } });
  const configuration = await readZoneConfiguration(stack.env, zoneId);
  const configured = await authorApi.command<{ revision: string }>('g1026:zone:realm', {
    method: 'PUT', path: `/v1/zones/${zoneId.slice(-36)}/configuration`, body: {
      expectedHead: configuration.revision, defaultRealm: community.realm, actingSubject: actor } });
  const zone = { zone: zoneId, zoneRevision: configured.revision };
  const zoneRoot = `/v1/zones/${zone.zone.slice(-36)}` as const;
  const work = await seedPublicProfileWork(authorApi, 'g1026:work', {
    actingSubject: actor, title: 'Community target', body: 'Public community body' });
  await grant(`review:decide:${community.realm}`, 'review.decide');
  await grant(`reply:place:${community.realm}`, 'reply.place');
  await grant(`governance:realm:${community.realm}`, 'governance.rule.publish');
  const posts: Array<{ reply: string; revision: string; placement: string; variant: string }> = [];
  async function post(index: number, parent?: typeof posts[number]) {
    const reply = `https://rezics.com/id/${randomUUID()}`, variant = `urn:rezics:variant:${randomUUID()}`;
    const draft = await authorApi.command<{ revisionId: string; revisionDigest: string }>(`g1026:post:${index}:draft`, {
      method: 'POST', path: '/v1/member-reply-drafts', body: { profile: 'member-reply-draft-v1', reply,
        variantId: variant, rootTarget: work.work, rootRevision: work.draftRevision, language: 'en', direction: 'ltr',
        expectedHead: null, body: `Discussion ${index}\nCommunity text ${index}`, actingSubject: actor } });
    await authorApi.command(`g1026:post:${index}:identity`, { method: 'POST', path: '/v1/realm-replies', body: {
      profile: 'realm-reply-identity-v1', reply, variantId: variant, revisionId: draft.revisionId, author: actor,
      rootTarget: work.work, rootRevision: work.draftRevision, parentReply: parent?.reply ?? null,
      parentRevision: parent?.revision ?? null, contextRevision: null } });
    const review = await authorApi.command<{ decisionId: string }>(`g1026:post:${index}:review`, {
      method: 'POST', path: '/v1/realm-reply-reviews', body: { profile: 'realm-reply-review-v1', realm: community.realm,
        reply, revisionId: draft.revisionId, revisionDigest: draft.revisionDigest, expectedGeneration: '0', supersedes: null,
        outcome: 'approved', method: 'human', methodRevision: 'g1026-v1', dependencyDigest: 'a'.repeat(64),
        reasonReference: null, actingSubject: actor } });
    const placed = await authorApi.command<{ placement: string }>(`g1026:post:${index}:place`, {
      method: 'POST', path: '/v1/realm-reply-placements', body: { profile: 'realm-reply-placement-v1',
        realm: community.realm, reply, revisionId: draft.revisionId, revisionDigest: draft.revisionDigest,
        reviewDecisionId: review.decisionId, expectedHead: null, actingSubject: actor } });
    return { reply, revision: draft.revisionId, placement: placed.placement, variant };
  }
  const opening = await post(0);
  await post(-1, opening);
  posts.push(opening);
  // Every isolated dimension needs the same two-item page. Keep the opening
  // (and its child) outside that page, as the original Realm-size-first sweep did.
  posts.push(await post(1), await post(2));

  // All relationship targets exist before the sweeps. Following an existing
  // Agent changes only follows; joining an existing Realm changes only memberships.
  const followTargets: string[] = [];
  for (let index = 0; index < (selectedDimensions.includes('follows') ? 64 : 0); index++) {
    followTargets.push((await authorApi.command<{ agent: string }>(`g1026:follow-target:${index}`, {
      method: 'POST',path: '/v1/agents',body: { profile: 'agent-provision-v1',kind: 'person',
        displayName: `Unrelated author ${index}` } })).agent);
  }
  const joinTargets: Array<{ realm: string; space: string }> = [];
  for (let index = 0; index < (selectedDimensions.includes('memberships') ? 24 : 0); index++) joinTargets.push(await createRealm(`g1026:join-target:${index}`));
  const actual: CorpusDimensions = { ...fixed,realmSize: posts.length,historyDepth: 1,follows: 1,memberships: 1 };
  async function inventory(path: `/v1/${string}`) {
    const items: any[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: any[]; nextCursor: string | null } = await readerApi.read(
        `${path}&actingSubject=${encodeURIComponent(reader)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      items.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  // One dimension at a time. Each public command is read back before its measurement.
  for (const dimension of selectedDimensions) {
    let grown = actual[dimension];
    for (const scale of WORK_PROFILE_SCALES) {
      const dimensions = workProfileDimensions(dimension, scale, fixed);
      console.log(JSON.stringify({ stage: 'grow',dimension,scale,elapsedMs: performance.now()-started }));
      for (; grown < dimensions[dimension]; grown++) {
        boundedPreparation();
        const key = `g1026:${dimension}:${grown}`;
        if (dimension === 'realmSize') posts.push(await post(grown + 1));
        else if (dimension === 'historyDepth') {
          const edited = await authorApi.command<{ revisionId: string }>(key, { method: 'POST', path: '/v1/member-reply-drafts',
            body: { profile: 'member-reply-draft-v1', reply: opening.reply, variantId: opening.variant,
              rootTarget: work.work, rootRevision: work.draftRevision, language: 'en', direction: 'ltr',
              expectedHead: opening.revision, body: `Unplaced history revision ${grown}`, actingSubject: actor } });
          opening.revision = edited.revisionId;
          const exact = await authorApi.read<{ revisionId: string }>(
            `/v1/member-replies/${opening.reply.slice(-36)}?actingSubject=${encodeURIComponent(actor)}`);
          assert.equal(exact.revisionId, edited.revisionId);
        } else if (dimension === 'follows') {
          await readerApi.command(key, { method: 'POST', path: '/v1/follows', body: { profile: 'follow-command-v1',
            actingSubject: reader, target: followTargets[grown]!, following: true, expectedRevision: null } });
        } else if (dimension === 'memberships') {
          const target = joinTargets[grown]!;
          await join(target.realm, key);
          const interest = await readerApi.read<{ revision: string }>(`/v1/me/follow-state?target=${encodeURIComponent(target.space)}&kind=space&actingSubject=${encodeURIComponent(reader)}`);
          await readerApi.command(`${key}:unfollow`, { method: 'POST',path: '/v1/follows',body: {
            profile: 'follow-command-v1',actingSubject: reader,target: target.space,following: false,expectedRevision: interest.revision } });
        } else {
          const created = await seedPublicProfileWork(authorApi, key, { actingSubject: actor, title: key, body: `Unrelated corpus ${grown}` });
          const selected = await authorApi.read<{ contribution: string; selectedDraft: string; body: string }>(
            `/v1/main-versions/${created.mainVersion.slice(-36)}/selection?language=en`);
          assert.equal(selected.contribution, created.contribution);
          assert.equal(selected.selectedDraft, created.draftRevision);
          assert.equal(selected.body, `Unrelated corpus ${grown}`);
        }
      }
      actual[dimension] = grown;
      if (dimension === 'realmSize') {
        const page = await inventory(`${root}/threads?sort=new&limit=20`);
        assert.deepEqual(page.map(item => item.reply).sort(), posts.map(item => item.reply).sort());
      }
      if (dimension === 'follows') assert.equal((await inventory('/v1/me/follows?limit=20')).length, actual.follows);
      if (dimension === 'memberships') assert.equal((await inventory('/v1/me/memberships?limit=20')).length, actual.memberships);
      boundedPreparation();
      evidence.push({ dimension, scale, dimensions: { ...actual },
        cumulativeMs: performance.now() - started, basis: 'public command corpus; no stopped backup/restore; first is not engine-cold' });
      console.log(JSON.stringify({ stage: 'measure',dimension,scale,elapsedMs: performance.now()-started }));
      await measure(dimension, scale, 'header', root, body => assert.equal(body.id, community.realm));
      for (const sort of ['best', 'new', 'top']) await measure(dimension, scale, `threads-${sort}`,
        `${root}/threads?sort=${sort}&limit=2`, body => {
          assert.equal(body.items.length, 2); assert(body.items.every((item: any) => item.title.startsWith('Discussion')));
        });
      await measure(dimension, scale, 'thread', `${root}/threads/${opening.reply.slice(-36)}`, body => {
        assert.equal(body.items.length, 2); assert.equal(body.items[0].title, 'Discussion 0');
      });
      await measure(dimension, scale, 'roster', `${root}/roster?limit=2`, body => assert.equal(body.items.length, 1));
      await measure(dimension, scale, 'zone-home', `${zoneRoot}/routes?path=%2F`, body => assert.equal(body.kind, 'home'));
      await measure(dimension, scale, 'zone-presentation', `${zoneRoot}/presentation`, body => assert.equal(body.zone, zone.zone));
    }
  }

  // Only surface shards need rule/banner preparation and assertions.
  if (!process.env.G1026_OPERATIONS || process.env.G1026_OPERATIONS.split(',')
    .some(operation => operation === 'header-rules' || operation === 'zone-banners')) {
  // Rules are part of every community header. References retain live scope/revision checks.
  let profileHead: string | null = null;
  const publishedRules = [];
  for (let index = 0; index < 12; index++) {
    const ref = `urn:rezics:g1026:rule:${randomUUID()}`, key = `g1026:rule:${index}`;
    await authorApi.command(key, { method: 'POST', path: '/v1/governance/rules', body: {
      profile: 'governance-rule-v1', ref, scopeId: `governance:realm:${community.realm}`, actingSubject: actor,
      expectedRevision: null, document: { text: `Rule ${index}` }, idempotencyKey: key } });
    publishedRules.push({ id: `rule-${index}`, title: { original: 'en', labels: { en: `Rule ${index}` } },
      body: { original: 'en', labels: { en: 'Be kind' } }, governanceRule: { ref, revision: '1' } });
    if (![0,3,11].includes(index)) continue;
    // Settings owns the current rules document; publish that owner through its API too.
    const rulesKey = `g1026:rules-document:${index}`;
    const rulesRef = `urn:rezics:realm-rules:${community.realm.slice(-36)}`;
    const current = await rules.current(rulesRef);
    await authorApi.command(rulesKey, { method: 'POST', path: '/v1/governance/rules', body: {
      profile: 'governance-rule-v1', ref: rulesRef, scopeId: `governance:realm:${community.realm}`, actingSubject: actor,
      expectedRevision: current?.revision ?? null, document: { profile: 'realm-settings-rules-v2', public: true,
        rules: publishedRules }, idempotencyKey: rulesKey } });
    const published: { revision: string } = await authorApi.command(`g1026:profile:${index}`, {
      method: 'PUT', path: `${root}/profile`, body: { profile: 'realm-public-profile-v2', expectedHead: profileHead,
        actingSubject: actor, publication: { name: { original: 'en', labels: { en: 'Cost community' } },
          description: { original: 'en', labels: { en: 'Read together' } }, rules: publishedRules,
          iconSelection: null, bannerSelection: null, moderators: [], count: { kind: 'exact', value: null } } } });
    profileHead = published.revision;
    await measure('rules', String(index + 1), 'header-rules', root, body => {
      assert.equal(body.rules.length, index + 1);
      assert(body.rules.every((rule: any) => rule.governanceRule?.revision === '1'));
      assert.equal(body.membership.count.value, 1);
    });
  }
  // Updating a linked governance head must invalidate only that link, with
  // authored text and other links retained; a batch is not a stale-result cache.
  const stale = publishedRules[0]!.governanceRule;
  const staleKey = 'g1026:rule:stale';
  await authorApi.command(staleKey, { method: 'POST',path: '/v1/governance/rules',body: {
    profile: 'governance-rule-v1',ref: stale.ref,scopeId: `governance:realm:${community.realm}`,
    actingSubject: actor,expectedRevision: '1',document: { text: 'Revised rule' },idempotencyKey: staleKey } });
  const changedHeader = await readerApi.read<{ rules: { title: { value: string }; governanceRule: unknown }[] }>(
    `${root}?actingSubject=${encodeURIComponent(reader)}`);
  assert.equal(changedHeader.rules[0]!.governanceRule, null);
  assert.equal(changedHeader.rules[0]!.title.value, 'Rule 0');
  assert(changedHeader.rules.slice(1).every(rule => rule.governanceRule !== null));

  // Valid UUIDs with no publication item exercise the unavailable banner branch on real Content.
  let zoneHead = zone.zoneRevision;
  for (const size of [1,3,6]) {
    const changed = await authorApi.command<{ revision: string }>(`g1026:banners:${size}`, {
      method: 'PUT', path: `${zoneRoot}/configuration`, body: { expectedHead: zoneHead, actingSubject: actor,
        presentation: { ...DEFAULT_ZONE_PRESENTATION, slides: Array.from({ length: size }, (_, index) => ({
          id: `slide-${index}`, title: `Slide ${index}`, href: '/', art: { landscape: { use: `https://rezics.com/id/${randomUUID()}` } }})) } } });
    zoneHead = changed.revision;
    await measure('banners', String(size), 'zone-banners', `${zoneRoot}/presentation`, body => {
      assert.equal(body.slideMedia.length, size); assert(body.slideMedia.every((slide: any) => slide.art.landscape === null));
    });
  }
  }
  // Capture the actual list-selection algebra. It cannot attest native TDB2 visits.
  const meter = startFusekiMeter(process.env.FUSEKI_URL!);
  // Query capture uses a separate HTTP peer; the application client stays untouched.
  if (!selectedQuery) await readerApi.read(`${root}/threads?sort=new&limit=2&actingSubject=${encodeURIComponent(reader)}`);
  assert(selectedQuery, 'The operation must capture its actual selection query');
  try {
    meter.beginCapture();
    const result = await fetch(`${meter.url}query`, { method: 'POST', headers: {
      'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' }, body: selectedQuery });
    assert.equal(result.status, 200); await result.json();
    const captured = meter.endCapture();
    const plan = captureFusekiQueryPlan(captured[0]!, { label: 'g-1026-realm-selection', directory: `${artifacts}/plans` });
    evidence.push({ plan });
  } finally { await meter.stop(); }
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(`${artifacts}/g-1026-${process.env.G1026_PHASE ?? 'after'}-${selectedDimensions.join('-')}-${process.env.G1026_GROUP ?? 'all'}.json`, JSON.stringify({ evidence, profiles }, null, 2));
  console.log(JSON.stringify({ evidence, profiles: profiles.length }));
} finally {
  try { await home.stop(); }
  finally {
    try { await owners.close(); }
    finally {
      await shutdownTelemetry();
      await sink.stop();
    }
  }
}
