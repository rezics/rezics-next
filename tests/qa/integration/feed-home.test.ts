import { HubStore } from '../../../services/main/src/modules/hub/store.ts';
import { PackageArtifactStore } from '../../../services/main/src/modules/package/lock-artifacts.ts';
import { FeedViewerStateReader } from '../../../services/main/src/modules/feed/viewer-state.ts';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { FeedStore } from '../../../services/main/src/modules/feed/store.ts';
import { HomePersonalStore } from '../../../services/main/src/modules/feed/personal.ts';
import { RankingHomeTrendingReader } from '../../../services/main/src/modules/feed/trending.ts';
import { ReadRankingProjection, rankingBuckets } from '../../../services/main/src/modules/rankings/projection.ts';
import { FeedRefreshWorker } from '../../../services/main/src/modules/feed/refresh.ts';
import type { FeedItem, FeedVoteResult } from '../../../services/main/src/modules/feed/contract.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import type { FollowResult } from '../../../services/main/src/modules/follows/contract.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { DATASET, GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { selectRealmLocal, realmSelectionDigest } from '../../../services/main/src/modules/work/select-realm.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { startMediaStack } from './media-support.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, expected = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== expected) throw new Error(`Expected ${expected}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
interface Page { items: FeedItem[]; nextCursor: string | null; projection: { status: string };
  caughtUp: { state: string; asOf: string } | null; ranking: { version: string; decayHours: number }; window: string }

test('G282: follows and home feed use real receipts, relay progress, public reads and one vote per person', async () => {
  const stack = await startMediaStack('feed-home');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const a = await stack.member('a'), b = await stack.member('b');
    const principals = new Map([[a.token, { ...a.principal, emailVerified: true }], [b.token, { ...b.principal, emailVerified: true }]]);
    const account = { verify: async (request: Request, scopes: readonly string[]) => {
      const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
      if (!principal) throw new AccountAssertionDenied('Authentication required');
      if (request.headers.has('x-read-only') && scopes.some(scope => ['feed:vote', 'follow:write'].includes(scope))) {
        throw new AccountAssertionDenied('Write scope required');
      }
      return { ...principal, currentAssertion: async () => principal };
    } };
    stack.access.configureBaseline(stack.fuseki);
    const feed = new FeedStore(stack.accessPool), follows = new FollowsStore(stack.accessPool);
    const consumer = `feed-${randomUUID()}`;
    const structureObjects = stack.objects('feed/structure/');
    await structureObjects.initialize();
    Object.assign(stack.env, { structureObjects });
    let viewerWork: string | undefined, viewerBatches = 0;
    let viewerNextUnread: { work: string; occurrence: string } | undefined;
    const feedViewerState: FeedViewerStateReader = { read: async (_reader, targets) => {
      viewerBatches++;
      return new Map(targets.filter(target => target.work === viewerWork).map(target => [target.activity,
        { status: 'available', ...(viewerNextUnread ? { nextUnread: viewerNextUnread } : {}), shelf: null, progress: null, spoiler: { policy: 'hide-unread', hidden: true } }]));
    } };
    const realmReplies = new RealmReplyStore(new RealmReplyContentStore(stack.contentPool), stack.content, stack.access, stack.env);
    const deps = { environment: stack.env, access: stack.access, account, feed, follows, realmReplies, feedViewerState,
      reviews: new ReaderReviews(stack.accessPool),
      homePersonal: new HomePersonalStore(stack.accessPool), libraryStatus: new ReaderLibraryStatusStore(stack.contentPool),
      progress: new StructureProgressStore(stack.contentPool),
      hub: new HubStore(stack.contentPool, stack.content, stack.access, stack.env,
        new PackageArtifactStore(stack.contentPool, prefix => stack.objects(prefix))),
      content: stack.content, contentAuthoring: stack.content, media: stack.media, structureObjects,
      profiles: new ProfilesAccess(stack.accessPool), agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      relayPosition: new RelayHandoffPositions(relay, consumer) };
    const app = createMainApp(stack.fuseki, deps);
    const call = (method: string, path: string, body?: unknown, token?: string, key = randomUUID()) => app.handle(
      new Request(`http://main.local${path}`, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const provision = async (name: string, token: string, kind = 'person') => (await json<{ agent: string }>(
      await call('POST', '/v1/agents', { profile: 'agent-provision-v1', kind, displayName: name }, token), 201)).agent;
    const author = await provision('Feed author', a.token), reader = await provision('Feed reader', b.token);
    const pen = await provision('Reader pen name', b.token), organization = await provision('Organization', b.token, 'organization');
    const grant = async (scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), a.principalId, author, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), author, scope, action]);
    };
    const first = await stack.publicWork(author, ['en'], 'Public first');
    const second = await stack.publicWork(author, ['zh-Hans'], '公开作品');
    for (const work of [first.work, second.work]) {
      await grant(`work:edit:${work}`, 'work.edit');
      const head = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ?head } } LIMIT 2`)).results!.bindings[0]!.head!.value;
      await json(await call('POST', `/v1/works/${work.slice(-36)}/agent-credits`, {
        profile: 'native-agent-credit-v1', credit: native(), agent: work === first.work ? reader : author,
        role: 'author', expectedWorkHead: head, actingSubject: author }, a.token), 201);
    }
    const hidden = await stack.privateWork(author, 'Private must never appear');
    await stack.contribution(hidden.work, author, 'en', 'Unselected publication must never appear');
    const realm = await json<{ realm: string; space: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Feed community', capabilities: ['realm'], actingSubject: author }, a.token), 201);
    const adopt = { context: { kind: 'realm-local' as const, id: realm.realm }, work: first.work,
      mainVersion: first.mainVersion, contribution: first.variants[0]!.contribution,
      publicationDecision: first.variants[0]!.decision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review' as const, actingSubject: author };
    const adoption = await selectRealmLocal(stack.env,
      stack.admission(author, `publication:adopt:${realm.realm}`, 'publication.adopt', realmSelectionDigest(adopt)), adopt);
    expect(adoption.outcome).toBe('succeeded');
    const collection = native();
    await json(await call('POST', '/v1/collections', { collection, name: 'Public reading shelf',
      disclosure: 'public', actingSubject: author }, a.token), 201);
    const zone = native();
    // The owner bootstrap is exercised separately; this declared public Zone
    // fixture tests navigation disclosure without inventing a second Zone API.
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} a rv:Zone ; rv:space ${iri(realm.space)} ; rv:zoneState rv:Active ;
        rv:disclosure rv:Public ; rv:zoneHead ${iri(zone + '-head')} . ${iri(realm.space)} rv:zoneCapability ${iri(zone)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(zone + '-head')} a rv:ZoneRevision ; rv:component ${iri(zone)} . } }`);
    const follow = (target: string, kind: string, actingSubject = reader, following = true, expectedRevision: string | null = null) =>
      ({ profile: 'follow-command-v1', target, kind, actingSubject, following, expectedRevision });
    const followKey = randomUUID();
    const saved = await json<FollowResult>(await call('POST', '/v1/follows', follow(realm.realm, 'realm'), b.token, followKey));
    expect(await json(await call('POST', '/v1/follows', follow(realm.realm, 'realm'), b.token, followKey)))
      .toMatchObject({ revision: saved.revision, replayed: true });
    expect((await call('POST', '/v1/follows', follow(zone, 'zone'), b.token, followKey)).status).toBe(409);
    expect((await call('POST', '/v1/follows', follow(hidden.work, 'work'), b.token)).status).toBe(404);
    expect((await call('POST', '/v1/follows', follow(author, 'agent', author), b.token)).status).toBe(403);
    expect((await call('POST', '/v1/follows', follow(author, 'agent', organization), b.token)).status).toBe(403);
    const personFollow = await json<FollowResult>(await call('POST', '/v1/follows', follow(pen, 'agent'), b.token));
    expect(await json(await call('GET', `/v1/follows/${pen.slice(-36)}?kind=agent`)))
      .toMatchObject({ following: null, followers: { value: 1 } });
    await json(await call('POST', '/v1/follows', follow(pen, 'agent', reader, false, personFollow.revision), b.token));
    await json(await call('POST', '/v1/follows', follow(zone, 'zone'), b.token));
    await json(await call('POST', '/v1/follows', follow(first.work, 'work'), b.token));
    const navigation = await json<{ items: { id: string; name: { value: string }; icon: unknown }[] }>(
      await call('GET', `/v1/me/follows?actingSubject=${encodeURIComponent(reader)}&kind=realm`, undefined, b.token));
    expect(navigation.items).toEqual([expect.objectContaining({ id: realm.realm, name: expect.objectContaining({ value: 'Feed community' }) })]);
    expect(navigation.items[0]?.icon).toBeDefined();
    const mine = await json<{ items: unknown[] }>(await call('GET', `/v1/me/follows?actingSubject=${encodeURIComponent(author)}`, undefined, a.token));
    expect(mine.items).toEqual([]);
    const state = await json<{ following: null; followers: { value: number } }>(await call('GET', `/v1/follows/${realm.realm.slice(-36)}?kind=realm`));
    expect(state).toMatchObject({ following: null, followers: { value: 1 } });
    const racingFollows = await Promise.all([true, false].map(following => call('POST', '/v1/follows',
      follow(realm.realm, 'realm', reader, following, saved.revision), b.token)));
    expect(racingFollows.map(response => response.status).sort()).toEqual([200, 409]);

    expect((await call('GET', '/v1/feed')).status).toBe(503);
    expect(await new FeedRefreshWorker(deps, feed, relay).tick()).toBe('relay-behind');
    await initializeRelayCheckpoint(relay, consumer, stack.env.lineage.dataEpoch);
    const drain = async () => {
      for (let i = 0; i < 150; i++) if (!await relayMainOutboxOnce(stack.fuseki, relay, consumer)) return;
      throw new Error('Fixture exceeded relay budget');
    };
    const refresh = async () => {
      for (let i = 0; i < 20; i++) if (await new FeedRefreshWorker(deps, feed, relay).tick() === 'current') return;
      throw new Error('Fixture exceeded refresh budget');
    };
    await drain(); await refresh();
    const before = stack.fuseki.queries;
    const all = await json<Page>(await call('GET', '/v1/feed?sort=new'));
    expect(stack.fuseki.queries - before).toBeLessThanOrEqual(160);
    expect(all.projection.status).toBe('current');
    expect(viewerBatches).toBe(0);
    expect(all.items.map(item => item.kind).sort()).toEqual(['adoption', 'collection', 'work']);
    expect(all.items.filter(item => item.target.work === first.work)).toHaveLength(1);
    expect(all.items.find(item => item.target.work === first.work)?.reasons).toEqual(expect.arrayContaining([
      { kind: 'realm-pick', realm: realm.realm, curator: author },
      { kind: 'new-work', actor: author },
    ]));
    expect(all.items.find(item => item.target.work === first.work)?.authors).toEqual([
      expect.objectContaining({ agent: reader, displayName: 'Feed reader' }),
    ]);
    expect(all.items.some(item => item.target.id === hidden.work)).toBe(false);
    expect(all.items.every(item => item.actor.name === 'Feed author' && item.vote === 0)).toBe(true);
    await stack.fuseki.update(`PREFIX schema: <https://schema.org/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.work)} a schema:Book } }`);
    const bookFeed = await json<Page>(await call('GET', '/v1/feed?sort=new&interests=books'));
    expect(bookFeed.items.length).toBeGreaterThan(0);
    expect(bookFeed.items.every(item => item.target.work === first.work)).toBe(true);
    expect((await json<Page>(await call('GET', '/v1/feed?sort=new&interests=software'))).items).toEqual([]);
    expect((await json<Page>(await call('GET', '/v1/feed?sort=new&interests=books,software'))).items.length)
      .toBe(bookFeed.items.length);
    expect((await call('GET', '/v1/feed?interests=books,books')).status).toBe(400);
    expect((await call('GET', '/v1/feed?interests=unknown')).status).toBe(400);
    if (bookFeed.nextCursor) {
      expect((await call('GET', `/v1/feed?sort=new&interests=software&cursor=${bookFeed.nextCursor}`)).status).toBe(400);
    }
    await stack.fuseki.update(`PREFIX schema: <https://schema.org/> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.work)} a schema:Book } }`);
    const firstItem = all.items.find(item => item.target.id === first.work)!;
    expect(firstItem.target.excerpt).toBeTruthy();
    const authQuery = `actingSubject=${encodeURIComponent(reader)}`;
    const followed = await json<Page>(await call('GET', `/v1/feed?sort=new&${authQuery}`, undefined, b.token));
    expect(followed.items.length).toBeGreaterThan(0);
    expect(followed.items.every(item => item.target.work === first.work && item.reason.kind === 'followed')).toBe(true);
    expect(followed.caughtUp?.state).toBe('caught-up');
    expect(followed.items.map(item => item.time)).toEqual([...followed.items.map(item => item.time)].sort().reverse());
    expect(all.items.every(item => item.group.count === 1 && item.group.actors.length === 1 && item.primaryAction.kind
      && item.viewerState.status === 'anonymous' && item.reason.kind === 'recommended')).toBe(true);
    expect(all.ranking).toMatchObject({ version: 'home-best-v1', decayHours: 24 });
    const trendingProjection = new ReadRankingProjection(stack.accessPool, stack.content,
      stack.contentPool, stack.env);
    for (let attempt = 0; attempt < 100 && await trendingProjection.tick(); attempt++) { /* bounded source catch-up */ }
    const trendCheckpoint = await trendingProjection.current();
    await stack.accessPool.query(`INSERT INTO access.read_ranking_score
      (generation, metric, interval, bucket, work, score, growth)
      VALUES ($1,'reads','day',$2,$3,5,5)`, [trendCheckpoint.generation,
      rankingBuckets(new Date(), 'day').current, first.work]);
    Object.assign(deps, { homeTrending: new RankingHomeTrendingReader(trendingProjection) });
    const publicTrend = await json<{ items: { work: string; realm: string; reason: string }[] }>(
      await call('GET', '/v1/trending?scope=global&window=day'));
    expect(publicTrend.items).toEqual([expect.objectContaining({ work: first.work,
      realm: realm.realm, reason: 'growth-in-realm' })]);
    expect(await json<{ items: { work: string }[] }>(await call('GET',
      `/v1/trending?scope=followed&window=day&actingSubject=${encodeURIComponent(reader)}`, undefined, b.token)))
      .toMatchObject({ items: [{ work: first.work }] });
    expect((await call('GET', '/v1/trending?kind=adoption')).status).toBe(400);
    expect(firstItem.card.kind).toBe('activity');
    expect(firstItem.primaryAction).toEqual({ kind: 'open', href: expect.stringContaining(first.work.slice(-36)) });
    expect(followed.items.every(item => item.viewerState.status === 'unavailable')).toBe(true);
    const thin = await json<Page>(await call('GET', `/v1/feed?sort=best&${authQuery}`, undefined, b.token));
    expect(thin.items.some(item => item.reason.kind === 'recommended' && item.reason.basis === 'thin-following')).toBe(true);
    const preferencesPath = '/v1/me/feed-preferences';
    const defaults = await json<{ revision: string | null; preferences: { tab: string; sort: string } }>(
      await call('GET', `${preferencesPath}?${authQuery}`, undefined, b.token));
    expect(defaults).toMatchObject({ revision: null, preferences: { tab: 'following', sort: 'best' } });
    const settings = { actingSubject: reader, expectedRevision: null, preferences: {
      tab: 'all', sort: 'new', density: 'compact', contentLanguages: [], recommendations: false } };
    const settingsKey = randomUUID();
    const savedSettings = await json<{ revision: string }>(await call('PUT', preferencesPath, settings, b.token, settingsKey));
    expect(await json(await call('PUT', preferencesPath, settings, b.token, settingsKey)))
      .toMatchObject({ revision: savedSettings.revision, replayed: true });
    expect((await call('PUT', preferencesPath, settings, b.token)).status).toBe(409);
    expect(await json(await call('GET', `/v1/feed?${authQuery}`, undefined, b.token)))
      .toMatchObject({ scope: 'all', sort: 'new' });
    expect(await json<{ items: unknown[] }>(await call('GET',
      `/v1/trending?scope=global&window=day&${authQuery}`, undefined, b.token)))
      .toMatchObject({ items: [] });
    await json(await call('PUT', preferencesPath, { actingSubject: reader,
      expectedRevision: savedSettings.revision, preferences: {
        tab: 'following', sort: 'best', density: 'card', contentLanguages: [], recommendations: true } }, b.token));
    await json(await call('PUT', '/v1/me/mutes', {
      actingSubject: reader, kind: 'realm', target: realm.realm, strength: 'mute' }, b.token));
    expect(await json<{ items: unknown[] }>(await call('GET',
      `/v1/trending?scope=followed&window=day&actingSubject=${encodeURIComponent(reader)}`, undefined, b.token)))
      .toMatchObject({ items: [] });
    await json(await call('PUT', '/v1/me/mutes', {
      actingSubject: reader, kind: 'realm', target: realm.realm, strength: 'clear' }, b.token));
    const headBefore = await json<{ newPosts: { value: number } }>(await call('GET',
      `/v1/feed/head?scope=all&after=0&${authQuery}`, undefined, b.token));
    expect(headBefore.newPosts.value).toBeGreaterThan(0);
    const personalPage = await json<Page>(await call('GET', `/v1/feed?scope=all&sort=new&limit=1&${authQuery}`,
      undefined, b.token));
    expect(personalPage.nextCursor).toBeTruthy();
    const feedback = { actingSubject: reader, kind: 'activity', target: firstItem.id, strength: 'hide' };
    await json(await call('POST', '/v1/me/feed-feedback', feedback, b.token));
    expect((await call('GET', `/v1/feed?scope=all&sort=new&limit=1&cursor=${
      encodeURIComponent(personalPage.nextCursor!)}&${authQuery}`, undefined, b.token)).status).toBe(409);
    expect((await json<Page>(await call('GET', `/v1/feed?scope=all&sort=new&${authQuery}`,
      undefined, b.token))).items.some(item => item.id === firstItem.id)).toBe(false);
    const headAfter = await json<{ newPosts: { value: number } }>(await call('GET',
      `/v1/feed/head?scope=all&after=0&${authQuery}`, undefined, b.token));
    expect(headAfter.newPosts.value).toBeLessThan(headBefore.newPosts.value);
    await json(await call('POST', '/v1/me/feed-feedback', { ...feedback, strength: 'clear' }, b.token));
    const watermarkScope = `realm:${realm.realm}`;
    const checkpoint = await feed.checkpoint(stack.env.lineage.dataEpoch);
    expect((await call('PUT', `/v1/me/feed-watermarks/${encodeURIComponent(watermarkScope)}`, {
      actingSubject: reader, scope: watermarkScope, dataEpoch: randomUUID(),
      sequence: checkpoint.sequence }, b.token)).status).toBe(409);
    await json(await call('PUT', `/v1/me/feed-watermarks/${encodeURIComponent(watermarkScope)}`, {
      actingSubject: reader, scope: watermarkScope, dataEpoch: stack.env.lineage.dataEpoch,
      sequence: checkpoint.sequence }, b.token));
    expect(await json(await call('GET', `/v1/me/feed-watermarks?${authQuery}`, undefined, b.token)))
      .toMatchObject({ items: [expect.objectContaining({ scope: watermarkScope,
        sequence: checkpoint.sequence })] });
    const zoneNav = await json<{ items: { id: string; newSince?: { state: string; count: { value: number } } }[] }>(
      await call('GET', `/v1/me/follows?${authQuery}&kind=zone&include=newSince`, undefined, b.token));
    expect(zoneNav.items.find(item => item.id === zone)?.newSince).toMatchObject({ state: 'none', count: { value: 0 } });
    const interests = await json<{ kinds: { id: string; available: boolean }[];
      topicsStatus: string; topics: unknown[] }>(await call('GET', '/v1/onboarding/interests?locale=en'));
    expect(interests.kinds.map(item => item.id)).toEqual(['books', 'software', 'ai', 'recipes', 'media', 'discussions']);
    expect(interests.kinds.map(item => item.available)).toEqual([true, true, true, true, false, true]);
    expect(interests).toMatchObject({ topicsStatus: 'empty', topics: [] });
    await stack.fuseki.update(`PREFIX schema: <https://schema.org/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.work)} a schema:VideoObject } }`);
    const mediaInterests = await json<typeof interests>(await call('GET', '/v1/onboarding/interests?locale=en'));
    expect(mediaInterests.kinds.find(item => item.id === 'media')?.available).toBe(true);
    const mediaFeed = await json<Page>(await call('GET', '/v1/feed?interests=media'));
    expect(mediaFeed.items.find(item => item.target.work === first.work)?.card.kind).toBe('activity');
    await stack.fuseki.update(`PREFIX schema: <https://schema.org/> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.work)} a schema:VideoObject } }`);
    const suggested = await json<{ items: { id: string; realm: string; sampleWorks: { id: string }[] }[] }>(
      await call('GET', '/v1/onboarding/suggested-follows?locale=en'));
    expect(suggested.items.find(item => item.realm === realm.realm)?.sampleWorks.some(item => item.id === first.work)).toBe(true);
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.work)} a rv:SkillPackage } }`);
    const aiSuggested = await json<{ items: { realm: string; reason: { kind: string; interest: string | null } }[] }>(
      await call('GET', '/v1/onboarding/suggested-follows?interests=ai'));
    expect(aiSuggested.items.find(item => item.realm === realm.realm)?.reason)
      .toEqual({ kind: 'matching-kind', interest: 'ai' });
    expect((await json<Page>(await call('GET', '/v1/feed?interests=ai'))).items
      .some(item => item.target.work === first.work)).toBe(true);
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(first.work)} a rv:SkillPackage } }`);
    const topWeek = await json<Page>(await call('GET', '/v1/feed?sort=top&window=week'));
    expect(topWeek.window).toBe('week');
    expect(topWeek.caughtUp).toBeNull();
    expect((await call('GET', '/v1/feed?window=day')).status).toBe(400);
    expect((await call('GET', `/v1/feed?sort=top&${authQuery}`, undefined, b.token)).status).toBe(400);
    expect((await call('GET', '/v1/feed?scope=following')).status).toBe(400);
    const filtered = await json<Page>(await call('GET', '/v1/feed?contentLanguages=zh-Hans&kinds=work'));
    expect(filtered.items.map(item => item.target.id)).toEqual([second.work]);
    const realmOnly = await json<Page>(await call('GET', `/v1/feed?realms=${encodeURIComponent(realm.realm)}`));
    expect(realmOnly.items.map(item => item.kind)).toEqual(['adoption']);
    const mute = { actingSubject: reader, kind: 'realm', target: realm.realm, strength: 'mute' };
    await json(await call('PUT', '/v1/me/mutes', mute, b.token));
    expect(await json(await call('GET', `/v1/me/mutes?${authQuery}`, undefined, b.token)))
      .toMatchObject({ items: [expect.objectContaining({ kind: 'realm', target: realm.realm })] });
    expect((await json<Page>(await call('GET', `/v1/feed?scope=all&sort=new&${authQuery}`,
      undefined, b.token))).items.some(item => item.realm?.id === realm.realm)).toBe(false);
    await json(await call('PUT', '/v1/me/mutes', { ...mute, strength: 'clear' }, b.token));
    const pageOne = await json<Page>(await call('GET', '/v1/feed?sort=new&limit=1'));
    expect(pageOne.nextCursor).toBeTruthy();
    const pageTwo = await json<Page>(await call('GET', `/v1/feed?sort=new&limit=1&cursor=${pageOne.nextCursor}`));
    expect(pageTwo.items[0]?.id).not.toBe(pageOne.items[0]?.id);
    expect((await call('GET', `/v1/feed?sort=best&limit=1&cursor=${pageOne.nextCursor}`)).status).toBe(400);
    const votePath = `/v1/feed/${firstItem.id.slice(-36)}/vote`;
    const vote = (value: number, expectedRevision: string | null = null, actingSubject = reader) =>
      ({ profile: 'feed-vote-command-v1', value, expectedRevision, actingSubject });
    const voteKey = randomUUID();
    const readOnlyVote = await app.handle(new Request(`http://main.local${votePath}`, { method: 'POST',
      headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID(),
        'x-read-only': 'true' }, body: JSON.stringify(vote(1)) }));
    expect(readOnlyVote.status).toBe(401);
    const up = await json<FeedVoteResult>(await call('POST', votePath, vote(1), b.token, voteKey));
    expect(up.score).toBe(1);
    expect(await json(await call('POST', votePath, vote(1), b.token, voteKey))).toMatchObject({ score: 1, replayed: true });
    expect((await call('POST', votePath, vote(-1), b.token, voteKey)).status).toBe(409);
    expect((await call('POST', votePath, vote(1, null, pen), b.token)).status).toBe(409);
    const down = await json<FeedVoteResult>(await call('POST', votePath, vote(-1, up.revision, pen), b.token));
    expect(down.score).toBe(-1);
    const race = await Promise.all([0, 1].map(value => call('POST', votePath, vote(value, down.revision), b.token)));
    expect(race.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await call('GET', `/v1/feed?sort=new&limit=1&cursor=${pageOne.nextCursor}`)).status).toBe(409);
    const updated = await json<Page>(await call('GET', `/v1/feed?scope=all&${authQuery}`, undefined, b.token));
    const updatedItem = updated.items.find(item => item.id === firstItem.id)!;
    expect(updatedItem.voteRevision).toBeTruthy();
    expect(updatedItem.score).toBe(updatedItem.vote);
    const publicSerialized = JSON.stringify(await json(await call('GET', '/v1/feed')));
    for (const secret of [a.principalId, a.principal.issuer, b.principalId, b.principal.subject]) expect(publicSerialized).not.toContain(secret);

    // A stale projected public activity is hidden immediately; following never
    // turns anonymous hydration into the reader's private Work inventory.
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(first.work)} rv:protectionHead ${iri(native())} } }`);
    const protectedPage = await json<Page>(await call('GET', `/v1/feed?scope=all&${authQuery}`, undefined, b.token));
    expect(protectedPage.items.some(item => item.target.work === first.work)).toBe(false);
    const hiddenFollows = await json<{ items: { id: string; available: boolean; name: unknown; revision: string }[] }>(
      await call('GET', `/v1/me/follows?${authQuery}`, undefined, b.token));
    const hiddenFollow = hiddenFollows.items.find(item => item.id === first.work)!;
    expect(hiddenFollow).toMatchObject({ available: false, name: null });
    await json(await call('POST', '/v1/follows', follow(first.work, 'work', reader, false, hiddenFollow.revision), b.token));
    expect((await call('POST', votePath, vote(1, updatedItem.voteRevision), b.token)).status).toBe(404);
    // Replay proves the historical command despite subsequent target hiding.
    expect(await json(await call('POST', votePath, vote(1), b.token, voteKey))).toMatchObject({ replayed: true, score: 1 });
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(first.work)} rv:protectionHead ?p } }`);
    const rows = (await stack.accessPool.query('SELECT value FROM access.feed_vote WHERE principal_id = $1 AND target = $2',
      [b.principalId, firstItem.id])).rows;
    expect(rows).toHaveLength(1);

    // Exact tag filters reuse the classification owner, including Realm-local
    // rejection overriding global acceptance. Sparse pages remain traversable.
    for (const [scope, action] of [['classification:define:global', 'classification.proposition.define'],
      ['classification:decide:global', 'classification.decision.set'],
      [`classification:context:${realm.realm}`, 'classification.context.configure'],
      [`classification:decide:${realm.realm}`, 'classification.decision.set']] as const) await grant(scope, action);
    await json(await call('POST', '/v1/classification-contexts', { profile: 'classification-context-v1',
      realm: realm.realm, actingSubject: author }, a.token), 201);
    const tag = await json<{ sense: string }>(await call('POST', '/v1/classification-propositions', {
      profile: 'classification-proposition-v1', label: 'Feed adventures', actingSubject: author }, a.token), 201);
    const decision = { profile: 'classification-direct-decision-v1', work: first.work, mainVersion: first.mainVersion,
      sense: tag.sense, expectedDecisionHead: null, actingSubject: author };
    await json(await call('POST', '/v1/classification-decisions', { ...decision,
      context: { kind: 'global' }, outcome: 'accepted' }, a.token), 201);
    await json(await call('POST', '/v1/classification-decisions', { ...decision,
      context: { kind: 'realm-classification', id: realm.realm }, outcome: 'rejected' }, a.token), 201);
    await drain(); await refresh();
    const collect = async (query: string) => {
      const items: FeedItem[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 30; i++) {
        const page: Page = await json(await call('GET', `/v1/feed?${query}${cursor ? `&cursor=${cursor}` : ''}`));
        items.push(...page.items); cursor = page.nextCursor;
        if (!cursor) return items;
      }
      throw new Error('Feed cursor did not terminate');
    };
    const tagged = await collect(`concepts=${encodeURIComponent(tag.sense)}`);
    expect(tagged.map(item => item.target.work)).toEqual([first.work]);
    const decisions = await collect('kinds=decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.realm?.id).toBe(realm.realm);

    const rootRevision = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?draft WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(first.variants[0]!.contribution)} rv:publicationHead ?decision }
      GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:selectedDraft ?draft } } LIMIT 1`)).results!.bindings[0]!.draft!.value;
    for (const [scope, action] of [[`review:decide:${realm.realm}`, 'review.decide'],
      [`reply:place:${realm.realm}`, 'reply.place']] as const) await grant(scope, action);
    const makeReply = async (body: string, parent?: { reply: string; revisionId: string }) => {
      const reply = native(), variantId = `urn:rezics:variant:${randomUUID()}`;
      const draft = await json<{ revisionId: string }>(await call('POST', '/v1/member-reply-drafts', {
        profile: 'member-reply-draft-v1', reply, variantId, rootTarget: first.work, rootRevision,
        language: 'en', direction: 'ltr', expectedHead: null, body, actingSubject: reader }, b.token), 201);
      await json(await call('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply, variantId,
        revisionId: draft.revisionId, author: reader, rootTarget: first.work, rootRevision,
        parentReply: parent?.reply ?? null, parentRevision: parent?.revisionId ?? null, contextRevision: null }, b.token), 201);
      const revisionDigest = (await stack.contentPool.query<{ byte_digest: string }>(
        'SELECT byte_digest FROM content.revision WHERE id = $1', [draft.revisionId])).rows[0]!.byte_digest;
      return { reply, revisionId: draft.revisionId, revisionDigest };
    };
    const approve = async (reply: Awaited<ReturnType<typeof makeReply>>) => {
      const review = { profile: 'realm-reply-review-v1', realm: realm.realm, ...reply,
        expectedGeneration: '0', supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'feed-test-v1',
        dependencyDigest: createHash('sha256').update(first.work).digest('hex'), reasonReference: null, actingSubject: author };
      const approved = await json<{ decisionId: string }>(await call('POST', '/v1/realm-reply-reviews', review, a.token), 201);
      const placed = await json<{ placement: string }>(await call('POST', '/v1/realm-reply-placements', {
        profile: 'realm-reply-placement-v1', realm: realm.realm, ...reply, reviewDecisionId: approved.decisionId,
        expectedHead: null, actingSubject: author }, a.token), 201);
      return { review, approved, placed };
    };
    const discussion = await makeReply('A reviewed discussion');
    const accepted = await approve(discussion);
    const reply = await makeReply('A reviewed response', discussion);
    await approve(reply);
    const unreviewed = await makeReply('Secret unreviewed reply text');
    await drain(); await refresh();
    const discussions = await collect('kinds=discussion');
    expect(discussions).toHaveLength(1);
    expect(discussions[0]?.target).toMatchObject({ id: discussion.reply, excerpt: 'A reviewed discussion', language: 'en' });
    expect(discussions[0]?.comments).toEqual({ value: 2, kind: 'exact' });
    expect((await collect('kinds=reply')).map(item => item.target.id)).toEqual([reply.reply]);
    expect((await collect('interests=discussions')).map(item => item.target.id).sort())
      .toEqual([discussion.reply, reply.reply].sort());
    expect((await collect('')).some(item => item.target.id === unreviewed.reply)).toBe(false);
    await json(await call('POST', '/v1/realm-reply-reviews', { ...accepted.review, outcome: 'revoked',
      expectedGeneration: '1', supersedes: accepted.approved.decisionId, reasonReference: 'review-revoked' }, a.token), 201);
    expect(await collect('kinds=discussion')).toEqual([]); // Suppressed even before projection catches up.

    // A new selected contribution becomes activity; an unselected draft did not.
    const next = await stack.contribution(second.work, author, 'zh-Hans', 'Reviewed next chapter');
    const head = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(second.mainVersion)} rv:selectionHead ?head } } LIMIT 1`)).results!.bindings[0]!.head!.value;
    const selection = { context: { kind: 'main-version-default' as const, id: second.mainVersion }, work: second.work,
      contribution: next.contribution, publicationDecision: next.decision, expectedSelectionHead: head,
      selectionBasis: 'main-maintainer' as const, actingSubject: author };
    await selectMainDefault(stack.env, stack.admission(author, `publication:select:${second.mainVersion}`,
      'publication.select', mainSelectionDigest(selection)), selection);
    await drain(); await refresh();
    expect((await collect('kinds=contribution'))[0]?.target.excerpt).toBe('Reviewed next chapter');
    expect((await collect('kinds=work')).some(item => item.target.id === second.work)).toBe(true);
    const groupBefore = (await collect('kinds=contribution'))[0]!;
    const third = await stack.contribution(second.work, author, 'zh-Hans', 'Another reviewed chapter');
    const currentSelection = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(second.mainVersion)} rv:selectionHead ?head } } LIMIT 1`)).results!.bindings[0]!.head!.value;
    const another = { ...selection, contribution: third.contribution, publicationDecision: third.decision,
      expectedSelectionHead: currentSelection };
    await selectMainDefault(stack.env, stack.admission(author, `publication:select:${second.mainVersion}`,
      'publication.select', mainSelectionDigest(another)), another);
    await drain(); await refresh();
    const grouped = await collect('kinds=contribution&sort=new');
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ id: groupBefore.id, group: { key: groupBefore.group.key, count: 2 },
      target: { excerpt: 'Another reviewed chapter' }, time: groupBefore.time });
    expect(grouped[0]!.group.actors).toHaveLength(1);
    expect((await stack.accessPool.query<{ group_key: string }>(`SELECT group_key FROM access.feed_item
      WHERE data_epoch = $1 AND group_key = $2`, [stack.env.lineage.dataEpoch, groupBefore.group.key])).rows).toHaveLength(2);

    // Top reaches old highly voted activity; finite windows keep sparse seek
    // continuation without silently restricting All to a recent candidate pool.
    const oldItem = (await collect('kinds=work')).find(item => item.target.work === second.work)!;
    const oldRow = (await stack.accessPool.query('SELECT occurred_at, sort_time, score FROM access.feed_item WHERE data_epoch=$1 AND id=$2',
      [stack.env.lineage.dataEpoch, oldItem.id])).rows[0]!;
    await stack.accessPool.query(`UPDATE access.feed_item SET occurred_at=now()-interval '40 days',
      sort_time=now()-interval '40 days', score=99 WHERE data_epoch=$1 AND id=$2`, [stack.env.lineage.dataEpoch, oldItem.id]);
    expect((await collect('sort=top&window=all'))[0]!.id).toBe(oldItem.id);
    expect((await collect('sort=top&window=week')).some(item => item.id === oldItem.id)).toBe(false);
    expect((await collect('sort=top&window=month')).some(item => item.id === oldItem.id)).toBe(false);
    await stack.accessPool.query('UPDATE access.feed_item SET occurred_at=$3, sort_time=$4, score=$5 WHERE data_epoch=$1 AND id=$2',
      [stack.env.lineage.dataEpoch, oldItem.id, oldRow.occurred_at, oldRow.sort_time, oldRow.score]);
    viewerWork = second.work;
    const personalized = await json<Page>(await call('GET', `/v1/feed?scope=all&sort=new&${authQuery}`, undefined, b.token));
    expect(personalized.items.find(item => item.target.work === second.work)).toMatchObject({
      target: { excerpt: null }, viewerState: { status: 'available', shelf: null, progress: null,
        spoiler: { policy: 'hide-unread', hidden: true } } });
    viewerWork = undefined;

    // Chapter cards come from public Content eligibility in a real book
    // composition. Native text selections alone do not invent chapter numbers.
    await stack.fuseki.update(`PREFIX schema: <https://schema.org/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(second.work)} a schema:Book } }`);
    await grant(`work:edit:${second.work}`, 'work.edit');
    const composition = await json<{ structure: string; revision: string }>(await call('POST', '/v1/compositions', {
      profile: 'book-composition', work: second.work, mainVersion: second.mainVersion, actingSubject: author }, a.token), 201);
    const chapters: string[] = [];
    for (let ordinal = 1; ordinal <= 2; ordinal++) {
      const chapter = await stack.privateWork(author, `Chapter ${ordinal}`);
      chapters.push(chapter.work);
      const variant = `urn:rezics:variant:${randomUUID()}`;
      await grant(`work:read:${chapter.work}`, 'work.read');
      await grant(`content:draft:${chapter.work}`, 'content.draft');
      await grant(`content:publish:${chapter.work}`, 'content.publish');
      await grant(`content:search-eligibility:${chapter.work}`, 'content.search-eligibility');
      const saved = await json<{ revisionId: string; sourcePosition: { dataEpoch: string } }>(await call('POST', '/v1/content-drafts', {
        profile: 'content-text-v1', resourceId: chapter.work, variantId: variant,
        language: { kind: 'tag', tag: 'zh-Hans', originalTag: 'zh-Hans' }, direction: 'ltr', expectedHead: null,
        body: ordinal === 2 ? '# Chapter 1\nPublished chapter 2' : `Published chapter ${ordinal}`,
        actingSubject: author }, a.token), 201);
      const exact = (await stack.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('Missing chapter fixture');
      const published = await json<{ decision: string }>(await call('POST', '/v1/content-publications', {
        profile: 'content-publication-v1', preparationId: `feed-chapter-${randomUUID()}`, revisionId: saved.revisionId,
        expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
        resourceId: chapter.work, variantId: variant, expectedPublicationHead: null, actingSubject: author }, a.token), 201);
      await json(await call('POST', '/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
        resourceId: chapter.work, variantId: variant, publicationDecision: published.decision, expectedEligibilityHead: null,
        actingSubject: author, rightsBasis: 'original-contribution', disclosure: 'public' }, a.token), 201);
    }
    // Book order can differ from publication time; Read starts at its first chapter.
    const placements = await json<{ revision: string; occurrences: string[] }>(await call('POST',
      `/v1/compositions/${composition.structure.slice(-36)}/changes`, { profile: 'book-composition',
        expectedHead: composition.revision, actingSubject: author, operations: chapters.toReversed().map((target, index) => ({
          op: 'insert', parent: composition.structure, position: 'last', role: 'chapter', target,
          label: { value: index === 0 ? 'Untitled chapter' : `Chapter ${index + 1}`,
            language: 'zh-Hans' } })) }, a.token));
    await drain(); await refresh();
    const chapterCard = (await collect('sort=new&kinds=contribution')).find(item => item.card.kind === 'chapter')!;
    expect(chapterCard).toMatchObject({ kind: 'contribution', target: { work: second.work,
      excerpt: '# Chapter 1\nPublished chapter 2' },
      group: { count: 2, range: { kind: 'chapters', from: 1, to: 2 } },
      card: { kind: 'chapter', occurrence: placements.occurrences[0], number: 1, title: 'Chapter 1',
        excerpt: '# Chapter 1\nPublished chapter 2' },
      primaryAction: { kind: 'read-chapter', work: second.work, occurrence: placements.occurrences[0],
        href: `/w/${second.work.slice(-36)}/read/${placements.occurrences[0]!.slice(-36)}?language=zh-hans` } });
    expect(chapterCard.card).not.toHaveProperty('wordCount');
    viewerWork = second.work; viewerNextUnread = { work: second.work, occurrence: placements.occurrences[0]! };
    const readerPage = await json<Page>(await call('GET', `/v1/feed?scope=all&sort=new&${authQuery}`, undefined, b.token));
    expect(readerPage.items.find(item => item.card.kind === 'chapter')).toMatchObject({
      primaryAction: { kind: 'next-unread', work: second.work, occurrence: placements.occurrences[0] },
      target: { excerpt: null } });
    viewerWork = undefined; viewerNextUnread = undefined;

    const batch = { profile: 'follow-batch-v1', actingSubject: reader,
      targets: [{ target: second.work, kind: 'work' as const }] };
    const batchKey = randomUUID();
    const batchResult = await json<{ items: { target: string }[] }>(await call('POST',
      '/v1/me/follows/batch', batch, b.token, batchKey));
    expect(batchResult.items.map(item => item.target)).toEqual([second.work]);
    expect(await json(await call('POST', '/v1/me/follows/batch', batch, b.token, batchKey)))
      .toMatchObject({ replayed: true });
    expect((await call('POST', '/v1/me/follows/batch', { ...batch,
      targets: [batch.targets[0], batch.targets[0]] }, b.token)).status).toBe(400);
    await json(await call('PUT', `/v1/works/${second.work.slice(-36)}/reader-status`, {
      actingSubject: reader, expectedVersion: 0, status: 'reading', startedOn: null, finishedOn: null }, b.token));
    const resume = await json<{ items: { work: string; nextUnread: { occurrence: string } }[] }>(
      await call('GET', `/v1/me/continue?${authQuery}`, undefined, b.token));
    expect(resume.items.find(item => item.work === second.work)?.nextUnread.occurrence)
      .toBe(placements.occurrences[0]);
    await json(await call('PUT', `/v1/me/continue/${second.work.slice(-36)}/hidden`,
      { actingSubject: reader, hidden: true }, b.token));
    expect((await json<{ items: { work: string }[] }>(await call('GET', `/v1/me/continue?${authQuery}`,
      undefined, b.token))).items.some(item => item.work === second.work)).toBe(false);
    expect((await json<Page>(await call('GET', `/v1/feed?scope=all&sort=new&${authQuery}`,
      undefined, b.token))).items.some(item => item.target.work === second.work)).toBe(true);
    await json(await call('PUT', `/v1/me/continue/${second.work.slice(-36)}/hidden`,
      { actingSubject: reader, hidden: false }, b.token));
    deps.feedViewerState = new FeedViewerStateReader();
    const realViewer = await json<Page>(await call('GET', `/v1/feed?scope=all&sort=new&${authQuery}`,
      undefined, b.token));
    expect(realViewer.items.find(item => item.target.work === second.work && item.card.kind === 'chapter'))
      .toMatchObject({ viewerState: { status: 'available', shelf: { status: 'reading' },
        spoiler: { policy: 'hide-unread', hidden: true } }, target: { excerpt: null },
      primaryAction: { kind: 'next-unread', occurrence: placements.occurrences[0] } });
    const append = async (expectedHead: string, amount: number) => json<{ revision: string; occurrences: string[] }>(
      await call('POST', `/v1/compositions/${composition.structure.slice(-36)}/changes`, {
        profile: 'book-composition', expectedHead, actingSubject: author,
        operations: Array.from({ length: amount }, (_, index) => ({ op: 'insert',
          parent: composition.structure, position: 'last', role: 'chapter', target: chapters[0],
          label: { value: `Extra chapter ${index + 1}`, language: 'zh-Hans' } })) }, a.token));
    const moreChapters = await append(placements.revision, 16);
    const lastChapters = await append(moreChapters.revision, 3);
    const pageEdge = moreChapters.occurrences[3]!;
    await json(await call('PUT', `/v1/compositions/${composition.structure.slice(-36)}/occurrences/${pageEdge.slice(-36)}/progress`,
      { actingSubject: reader, expectedVersion: 0, completed: true, position: null }, b.token));
    const edgeFeed = await json<Page>(await call('GET', `/v1/feed?scope=all&sort=new&${authQuery}`,
      undefined, b.token));
    expect(edgeFeed.items.find(item => item.target.work === second.work && item.card.kind === 'chapter'))
      .toMatchObject({ primaryAction: { kind: 'next-unread', occurrence: moreChapters.occurrences[4] } });
    const distant = lastChapters.occurrences.at(-1)!;
    await json(await call('PUT', `/v1/compositions/${composition.structure.slice(-36)}/occurrences/${distant.slice(-36)}/progress`,
      { actingSubject: reader, expectedVersion: 0, completed: false, position: 'paragraph-3' }, b.token));
    const longResume = await json<{ items: { work: string; nextUnread: { occurrence: string };
      unreadCount: { kind: string } }[] }>(await call('GET', `/v1/me/continue?${authQuery}`, undefined, b.token));
    expect(longResume.items.find(item => item.work === second.work)).toMatchObject({
      nextUnread: { occurrence: distant }, unreadCount: { kind: 'lower-bound' } });
    const distantFeed = await json<Page>(await call('GET', `/v1/feed?scope=all&sort=new&${authQuery}`,
      undefined, b.token));
    expect(distantFeed.items.find(item => item.target.work === second.work && item.card.kind === 'chapter'))
      .toMatchObject({ primaryAction: { kind: 'next-unread', occurrence: distant },
        viewerState: { progress: { occurrence: distant } } });
    // The Work selects zh-Hans only. An English feed therefore has no selected
    // Main content language, while this reader's chapter progress does.
    for (const scope of ['following', 'all']) {
      const languageLess = await json<Page>(await call('GET',
        `/v1/feed?scope=${scope}&sort=best&language=en&${authQuery}`, undefined, b.token));
      expect(languageLess.items.find(item => item.target.work === second.work && item.card.kind === 'chapter'))
        .toMatchObject({ primaryAction: { kind: 'next-unread', occurrence: distant },
          viewerState: { nextUnread: { occurrence: distant, language: 'zh-hans' },
            progress: { occurrence: distant } } });
    }
    const absentOccurrence = native();
    await stack.contentPool.query(`UPDATE structure.progress SET occurrence = $1
      WHERE principal_issuer = $2 AND principal_subject = $3 AND structure = $4 AND occurrence = $5`,
    [absentOccurrence, b.principal.issuer, b.principal.subject, composition.structure, distant]);
    try {
      const unreadable = await json<Page>(await call('GET',
        `/v1/feed?scope=all&sort=best&language=en&${authQuery}`, undefined, b.token));
      expect(unreadable.items.find(item => item.target.work === second.work && item.card.kind === 'chapter'))
        .toMatchObject({ viewerState: { progress: { occurrence: absentOccurrence } },
          primaryAction: { kind: 'read-chapter' } });
    } finally {
      await stack.contentPool.query(`UPDATE structure.progress SET occurrence = $1
        WHERE principal_issuer = $2 AND principal_subject = $3 AND structure = $4 AND occurrence = $5`,
      [distant, b.principal.issuer, b.principal.subject, composition.structure, absentOccurrence]);
    }

    // Hub cards expose exact public previews and declared compatibility, never
    // a private draft or guessed version/changelog metadata.
    for (const kind of ['prompt', 'skill'] as const) {
      const resource = await stack.publicWork(author, ['en'], `Public ${kind}`);
      await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(resource.work)} a rv:${kind === 'prompt' ? 'PromptTemplate' : 'SkillPackage'} } }`);
      const variant = `urn:rezics:variant:${randomUUID()}`;
      await grant(`content:draft:${resource.work}`, 'content.draft');
      await grant(`content:publish:${resource.work}`, 'content.publish');
      await grant(`content:search-eligibility:${resource.work}`, 'content.search-eligibility');
      const identity = { resourceId: resource.work, variantId: variant, language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr', expectedHead: null, actingSubject: author };
      const text = 'An exact published prompt preview';
      const saved = kind === 'prompt'
        ? await json<{ revision: string }>(await call('POST', '/v1/prompts/revisions', {
          ...identity, profile: 'rezics-prompt-revision-v1', content: text,
          parameterSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
            properties: {}, required: [], additionalProperties: false }, examples: [],
          applicability: { models: [], tools: [] } }, a.token), 201)
        : await json<{ revision: string }>(await call('POST', '/v1/hub/imports', { ...identity,
          profile: 'agent-skills-directory-import-v1', sourceFormat: 'agent-skills-directory-v1', sourceLocator: { label: 'feed-example' },
          files: [{ path: 'SKILL.md', executable: false, bytesBase64: Buffer.from('---\nname: feed-example\ndescription: A public example\n---\nRead the example.\n').toString('base64') },
            { path: 'rezics.package-requirements.json', executable: false, bytesBase64: Buffer.from(JSON.stringify({
              profile: 'rezics-skill-package-requirements-v1', requirements: [
                { ecosystem: 'npm', selector: '^1.0.0', strength: 'required', target: { name: 'example' } }] })).toString('base64') }] }, a.token), 201);
      await drain(); await refresh();
      const privateDraft = (await collect('sort=new')).filter(item => item.target.work === resource.work);
      expect(privateDraft.every(item => item.card.kind === 'work')).toBe(true);
      expect(JSON.stringify(privateDraft)).not.toContain(text);
      const exact = (await stack.content.readExactBatch([saved.revision], async ids => new Set(ids)))[0];
      if (exact?.status !== 'available') throw new Error('Missing Hub fixture');
      const published = await json<{ decision: string }>(await call('POST', '/v1/content-publications', {
        profile: 'content-publication-v1', preparationId: `feed-hub-${randomUUID()}`, revisionId: saved.revision,
        expectedDigest: exact.reference.byteDigest, expectedContentEpoch: (await stack.content.ownerPosition()).dataEpoch,
        resourceId: resource.work, variantId: variant, expectedPublicationHead: null, actingSubject: author }, a.token), 201);
      await json(await call('POST', '/v1/content-search-eligibility', { profile: 'content-search-eligibility-v1',
        resourceId: resource.work, variantId: variant, publicationDecision: published.decision, expectedEligibilityHead: null,
        actingSubject: author, rightsBasis: 'original-contribution', disclosure: 'public' }, a.token), 201);
      await drain(); await refresh();
      const cards = (await collect('sort=new')).filter(item => item.target.work === resource.work);
      expect(cards.length).toBeGreaterThan(0);
      if (kind === 'prompt') {
        expect(cards.every(item => item.card.kind === 'prompt' && item.card.preview === text)).toBe(true);
        expect(cards[0]!.primaryAction).toMatchObject({ kind: 'copy-prompt', work: resource.work,
          revision: `urn:rezics:content:revision:${saved.revision}` });
      } else {
        expect(cards.every(item => item.card.kind === 'release')).toBe(true);
        expect(cards[0]!.card).toEqual({ kind: 'release' });
        expect(cards[0]!.primaryAction).toMatchObject({ kind: 'install', work: resource.work,
          compatibilityTargets: [{ ecosystem: 'npm', selector: '^1.0.0', target: { name: 'example' } }] });
      }
    }

    await stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    try { expect((await call('GET', '/v1/feed')).status).toBe(503); }
    finally { await stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id'); }
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true } }`);
    try { expect((await call('GET', '/v1/feed')).status).toBe(503); }
    finally { await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true } }`); }
    await refresh();
    expect((await call('GET', '/v1/feed')).status).toBe(200);
    // A replaced epoch copies retained references in bounded, restartable steps.
    const restoreEpoch = randomUUID();
    const retainedCount = (await stack.accessPool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM access.feed_item WHERE data_epoch = $1', [stack.env.lineage.dataEpoch])).rows[0]!.count;
    const copied = await feed.initialize(restoreEpoch);
    expect(copied.rebuild_epoch).toBe(stack.env.lineage.dataEpoch);
    expect((await call('GET', '/v1/feed')).status).toBe(503);
    await feed.copyRetained(copied);
    expect((await feed.checkpoint(restoreEpoch)).rebuild_epoch).toBeNull();
    expect((await stack.accessPool.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM access.feed_item WHERE data_epoch = $1', [restoreEpoch])).rows[0]!.count).toBe(retainedCount);
    await feed.copyRetained(await feed.initialize(stack.env.lineage.dataEpoch));
    await refresh();
    expect((await call('GET', '/v1/feed')).status).toBe(200);
    // Private vote erasure subtracts its accepted contribution to every retained score.
    const beforeErase = (await stack.accessPool.query<{ score: number }>(
      'SELECT score FROM access.feed_item WHERE data_epoch = $1 AND id = $2', [stack.env.lineage.dataEpoch, firstItem.id])).rows[0]!.score;
    const cast = (await stack.accessPool.query<{ value: number }>(
      'SELECT value FROM access.feed_vote WHERE principal_id = $1 AND target = $2', [b.principalId, firstItem.id])).rows[0]!.value;
    await stack.accessPool.query('DELETE FROM access.feed_vote WHERE principal_id = $1 AND target = $2', [b.principalId, firstItem.id]);
    expect((await stack.accessPool.query<{ score: number }>('SELECT score FROM access.feed_item WHERE data_epoch = $1 AND id = $2',
      [stack.env.lineage.dataEpoch, firstItem.id])).rows[0]!.score).toBe(beforeErase - cast);
    // The relationship cap is maintained atomically, independent of inventory
    // size. Tombstones remain removable without disclosing a hidden target.
    await stack.accessPool.query(`INSERT INTO access.follow (principal_id, target, kind, acting_subject, following, revision)
      SELECT $1, 'https://rezics.com/id/' || gen_random_uuid(), 'work', $2, true, gen_random_uuid()
      FROM generate_series(1, 1000 - (SELECT active_count FROM access.follow_inventory WHERE principal_id = $1))`,
    [b.principalId, reader]);
    await stack.accessPool.query('UPDATE access.follow_inventory SET active_count = 1000 WHERE principal_id = $1', [b.principalId]);
    expect((await call('POST', '/v1/follows', follow(author, 'agent'), b.token)).status).toBe(400);
    await expect(stack.accessPool.query("UPDATE access.follow_receipt SET result = '{}' WHERE principal_id = $1",
      [b.principalId])).rejects.toThrow('immutable');
    // A requested 20-item page spans a Realm pick, a new Work, a review and
    // grouped chapters, while the whole read stays inside its 160-call budget.
    await grant(`rating:context:${realm.realm}`, 'rating.context.create');
    const rating = await json<{ context: string }>(await call('POST', '/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm: realm.realm,
      question: 'How good was this Work?', actingSubject: author }, a.token), 201);
    await grant(`rating:observe:${rating.context}`, 'rating.observation.set');
    await json(await call('POST', '/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1', context: rating.context,
      work: second.work, mainVersion: second.mainVersion, expectedRevisionHead: null,
      value: 8, actingSubject: author }, a.token), 201);
    await json(await call('POST', '/v1/reviews', { profile: 'reader-review-command-v1',
      actingSubject: author, context: rating.context, work: second.work, expectedRevision: null,
      language: 'en', text: 'A complete feed review', spoiler: false }, a.token), 201);
    await drain(); await refresh();
    await stack.accessPool.query(`UPDATE access.feed_item SET sort_time = now() - interval '100 milliseconds'
      WHERE data_epoch = $1 AND (kind IN ('work', 'adoption', 'review') OR group_key = $2)`,
    [stack.env.lineage.dataEpoch, chapterCard.group.key]);
    const mixedBefore = stack.fuseki.queries;
    const mixed = await json<Page>(await call('GET', '/v1/feed?scope=all&sort=new&limit=20'));
    expect(stack.fuseki.queries - mixedBefore).toBeLessThanOrEqual(140);
    expect(mixed.items.length).toBeGreaterThan(0);
    expect(mixed.items.some(item => item.kind === 'review')).toBe(true);
    expect(mixed.items.some(item => item.card.kind === 'chapter')).toBe(true);
    expect(mixed.items.some(item => item.kind === 'work')).toBe(true);
    expect(mixed.items.some(item => item.kind === 'adoption')).toBe(true);
    await stack.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [b.principalId]);
    expect((await call('GET', `/v1/me/follows?${authQuery}`, undefined, b.token)).status).toBe(403);
    expect((await call('POST', votePath, vote(1), b.token, voteKey)).status).toBe(403);
  } finally { await relay.end(); await stack.stop(); }
}, 180_000);
