import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { FeedRefreshWorker } from '../../../services/main/src/modules/feed/refresh.ts';
import { FeedStore } from '../../../services/main/src/modules/feed/store.ts';
import { HomePersonalStore } from '../../../services/main/src/modules/feed/personal.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { RealmReplyThreadStore } from '../../../services/main/src/modules/realm-reply/thread-store.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import type { FeedItem } from '../../../services/main/src/modules/feed/contract.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startMediaStack } from './media-support.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

test('G324: text reviews become grouped, live, spoiler-safe Work cards', async () => {
  const stack = await startMediaStack('feed-reviews');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const a = await stack.member('reviewer'), b = await stack.member('helpful-reader');
    const principals = new Map([[a.token, a.principal], [b.token, b.principal]]);
    const account = { verify: async (request: Request) => {
      const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
      if (!principal) throw new AccountAssertionDenied('Authentication required');
      const verified = { ...principal, emailVerified: true };
      return { ...verified, currentAssertion: async () => verified };
    } };
    stack.access.configureBaseline(stack.fuseki);
    const feed = new FeedStore(stack.accessPool);
    const consumer = `feed-review-${randomUUID()}`;
    const deps = { environment: stack.env, access: stack.access, account,
      feed, follows: new FollowsStore(stack.accessPool), homePersonal: new HomePersonalStore(stack.accessPool),
      reviews: new ReaderReviews(stack.accessPool), profiles: new ProfilesAccess(stack.accessPool), personPreferences: new PersonPreferencesStore(stack.accessPool),
      realmReplies: new RealmReplyStore(new RealmReplyContentStore(stack.contentPool), stack.content,
        stack.access, stack.env),
      realmReplyThreads: new RealmReplyThreadStore(stack.contentPool, stack.accessPool),
      agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      relayPosition: new RelayHandoffPositions(relay, consumer) };
    const app = createMainApp(stack.fuseki, deps);
    const call = (method: string, path: string, body?: unknown, token?: string) => app.handle(
      new Request(`http://main.local${path}`, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const agent = async (name: string, token: string) => (await json<{ agent: string }>(
      await call('POST', '/v1/agents', { profile: 'agent-provision-v1', kind: 'person', displayName: name }, token), 201)).agent;
    const author = await agent('Reviewer', a.token), helpful = await agent('Helpful reader', b.token);
    const grant = async (scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), a.principalId, author, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), author, scope, action]);
    };
    const first = await stack.publicWork(author, ['en'], 'First reviewed book');
    const second = await stack.publicWork(author, ['en'], 'Second reviewed book');
    // interests=books reads schema:Book. The type command advances each head;
    // this test never compares those heads, and the relay checkpoint below
    // starts after both edits.
    const recordBook = async (work: string) => {
      await grant(`work:edit:${work}`, 'work.edit');
      const head = (await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
      await json(await call('PUT', `/v1/works/${work.slice(-36)}/type`, {
        profile: 'work-type-v2', expectedHead: head, types: ['https://schema.org/Book'],
        actingSubject: author }, a.token));
    };
    await recordBook(first.work);
    await recordBook(second.work);
    await grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Book readers', capabilities: ['realm'], actingSubject: author }, a.token), 201);
    await grant(`rating:context:${realm.realm}`, 'rating.context.create');
    const context = await json<{ context: string }>(await call('POST', '/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm: realm.realm,
      question: 'How good was this Work?', actingSubject: author }, a.token), 201);
    await grant(`rating:observe:${context.context}`, 'rating.observation.set');
    for (const work of [first, second]) await json(await call('POST', '/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1', context: context.context,
      work: work.work, mainVersion: work.mainVersion, expectedRevisionHead: null,
      value: 8, actingSubject: author }, a.token), 201);
    await initializeRelayCheckpoint(relay, consumer, stack.env.lineage.dataEpoch);
    const refresh = async () => {
      for (let i = 0; i < 150; i++) if (!await relayMainOutboxOnce(stack.fuseki, relay, consumer)) break;
      for (let i = 0; i < 30; i++) if (await new FeedRefreshWorker(deps, feed, relay).tick() === 'current') return;
      throw new Error('Feed refresh exceeded fixture budget');
    };
    const cards = async (suffix = '') => (await json<{ items: FeedItem[] }>(
      await call('GET', `/v1/feed?sort=new${suffix}`))).items.filter(item => item.kind === 'review');
    await refresh();
    expect(await cards()).toEqual([]); // Rating observations alone have no feed card.
    const write = (work: string, text: string, spoiler: boolean, expectedRevision: string | null = null) =>
      ({ profile: 'reader-review-command-v1', actingSubject: author, context: context.context,
        target: work, expectedRevision, language: 'en', text, spoiler });
    const one = await json<{ review: string; revision: string }>(await call('POST', '/v1/reviews',
      write(first.work, 'The first opening lines', false), a.token), 201);
    const two = await json<{ review: string; revision: string }>(await call('POST', '/v1/reviews',
      write(second.work, 'The secret ending', true), a.token), 201);
    expect((await json<{ projection: { status: string } }>(await call('GET', '/v1/feed?sort=new')))
      .projection.status).toBe('catching-up');
    await refresh();
    const grouped = await cards();
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.group.count).toBe(2);
    expect(grouped[0]?.actor.id).toBe(author);
    expect(grouped[0]?.realm?.id).toBe(realm.realm);
    expect(grouped[0]?.target.title.value).toContain('reviewed book');
    expect(grouped[0]?.card).toMatchObject({ kind: 'review', review: two.review,
      rating: 8, scale: 10, spoiler: true, opening: null, helpfulCount: 0 });
    expect(grouped[0]?.primaryAction).toEqual({ kind: 'read-review', review: two.review,
      href: `/w/${second.work.slice(-36)}#review-${two.review}` });
    const books = await cards('&interests=books');
    expect(books).toHaveLength(1);
    expect(await cards('&interests=software')).toEqual([]);
    expect((await json<{ newPosts: { value: number }; projection: { reviewSequence: string } }>(
      await call('GET', `/v1/feed/head?after=${(await feed.checkpoint(stack.env.lineage.dataEpoch)).sequence}&afterReview=0`)))
      .newPosts.value).toBe(1);
    await json(await call('PUT', `/v1/reviews/${two.review}/helpful`, {
      profile: 'reader-review-helpful-v1', actingSubject: helpful,
      helpful: true, expectedRevision: null }, b.token));
    await refresh();
    expect((await cards())[0]?.card).toMatchObject({ kind: 'review', helpfulCount: 1, opening: null });
    await json(await call('POST', '/v1/reviews',
      write(second.work, 'A public recommendation', false, two.revision), a.token));
    await refresh();
    expect((await cards())[0]?.card).toMatchObject({ kind: 'review', opening: 'A public recommendation',
      spoiler: false, helpfulCount: 1 });
    await json(await call('DELETE', `/v1/reviews/${one.review}`, {
      profile: 'reader-review-delete-v1', actingSubject: author, expectedRevision: one.revision }, a.token));
    await refresh();
    const afterDelete = await cards();
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]?.card).toMatchObject({ kind: 'review', review: two.review });
    expect(afterDelete[0]?.group.count).toBe(1);
  } finally { await relay.end(); await stack.stop(); }
}, 180_000);
