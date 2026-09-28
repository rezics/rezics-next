import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import type { FeedItem } from '../../../services/main/src/modules/feed/contract.ts';
import { HomePersonalStore } from '../../../services/main/src/modules/feed/personal.ts';
import { FeedRefreshWorker } from '../../../services/main/src/modules/feed/refresh.ts';
import { FeedStore } from '../../../services/main/src/modules/feed/store.ts';
import { FollowsStore } from '../../../services/main/src/modules/follows/store.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { startMediaStack } from './media-support.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
async function json<T>(response: Response, expected = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== expected) throw new Error(`Expected ${expected}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

// A shared list on home shows its first three Works and how many it holds.
// Each list card costs a constant number of graph calls (one Collection lookup,
// one composition page, one public-Work-and-type batch, one summary batch) and
// its final fence one more, so a page of lists stays within one Work read.
test('G-377: a home page of four list cards shows their first Works within one Work read budget', async () => {
  const stack = await startMediaStack('home-list-cards');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const a = await stack.member('a');
    const principal = { ...a.principal, emailVerified: true };
    const account = { verify: async (request: Request) => {
      if (request.headers.get('authorization') !== `Bearer ${a.token}`) {
        throw new AccountAssertionDenied('Authentication required');
      }
      return { ...principal, currentAssertion: async () => principal };
    } };
    stack.access.configureBaseline(stack.fuseki);
    const feed = new FeedStore(stack.accessPool);
    const consumer = `home-lists-${randomUUID()}`;
    const structureObjects = stack.objects('home-lists/structure/');
    await structureObjects.initialize();
    Object.assign(stack.env, { structureObjects });
    const deps = { environment: stack.env, access: stack.access, account, feed,
      follows: new FollowsStore(stack.accessPool),
      realmReplies: new RealmReplyStore(new RealmReplyContentStore(stack.contentPool), stack.content, stack.access,
        stack.env),
      reviews: new ReaderReviews(stack.accessPool), homePersonal: new HomePersonalStore(stack.accessPool),
      libraryStatus: new ReaderLibraryStatusStore(stack.contentPool), progress: new StructureProgressStore(stack.contentPool),
      content: stack.content, contentAuthoring: stack.content, media: stack.media, structureObjects,
      profiles: new ProfilesAccess(stack.accessPool), agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env),
      relayPosition: new RelayHandoffPositions(relay, consumer) };
    const app = createMainApp(stack.fuseki, deps);
    const call = (method: string, path: string, body?: unknown) => app.handle(
      new Request(`http://main.local${path}`, { method, headers: {
        authorization: `Bearer ${a.token}`,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const curator = (await json<{ agent: string }>(await call('POST', '/v1/agents',
      { profile: 'agent-provision-v1', kind: 'person', displayName: 'List curator' }), 201)).agent;
    const works = [await stack.publicWork(curator, ['en'], 'First on the list'),
      await stack.publicWork(curator, ['en'], 'Second on the list'),
      await stack.publicWork(curator, ['zh-Hans'], '第三本'),
      await stack.publicWork(curator, ['en'], 'Fourth, past the preview')];
    const hidden = await stack.privateWork(curator, 'Never on a public card');
    const grant = async (scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), a.principalId, curator, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), curator, scope, action]);
    };
    for (const work of [hidden, ...works]) await grant(`work:read:${work.work}`, 'work.read');
    for (let list = 0; list < 4; list++) {
      const collection = native();
      await grant(`collection:edit:${collection}`, 'collection.edit');
      const created = await json<{ structure: string; revision: string }>(await call('POST', '/v1/collections', {
        collection, name: `Reading list ${list + 1}`, disclosure: 'public', actingSubject: curator }), 201);
      await json(await call('POST', `/v1/collections/${collection.slice(-36)}/changes`, {
        expectedHead: created.revision, actingSubject: curator,
        operations: [hidden.work, ...works.map(work => work.work)].map(target => ({ op: 'insert', role: 'member',
          parent: created.structure, position: 'last', target, selection: { mode: 'follow-context' } })) }));
    }
    await initializeRelayCheckpoint(relay, consumer, stack.env.lineage.dataEpoch);
    for (let i = 0; i < 200 && await relayMainOutboxOnce(stack.fuseki, relay, consumer); i++);
    for (let i = 0; i < 20 && await new FeedRefreshWorker(deps, feed, relay).tick() !== 'current'; i++);

    // A signed-out reader's page, which reads every card publicly, and what it cost in graph calls.
    const read = async (limit: number) => {
      const before = stack.fuseki.queries;
      const items = (await json<{ items: FeedItem[] }>(await app.handle(
        new Request(`http://main.local/v1/feed?sort=new&limit=${limit}`)))).items;
      return { items, calls: stack.fuseki.queries - before };
    };
    const two = await read(2);
    const { items, calls } = await read(4);
    expect(two.items).toHaveLength(2);
    // Each further list card costs the same few calls whatever the list holds (10 when written: the item's
    // hydration, its list read and one fence call), so a full page of eight lists stays inside one Work read.
    const perCard = (calls - two.calls) / 2;
    expect(perCard).toBeLessThanOrEqual(12);
    expect(two.calls + 6 * perCard).toBeLessThanOrEqual(WORK_READ_COST.graphCalls);
    const lists = items.filter(item => item.kind === 'collection');
    expect(lists).toHaveLength(4);
    for (const list of lists) {
      // The private Work is neither shown nor counted; the fourth public Work is counted but not shown.
      expect(list.card).toMatchObject({ kind: 'list', count: { value: 4, kind: 'exact' } });
      expect(list.card.kind === 'list' && list.card.works.map(work => [work.id, work.title.value, work.types.length]))
        .toEqual(works.slice(0, 3).map(work => [work.work, work.title, expect.any(Number)]));
    }
  } finally { await relay.end(); await stack.stop(); }
}, 180_000);
