import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { entityPage } from '../../../services/main/src/modules/entity-page/contract.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { RealmReplyContentStore } from '../../../services/main/src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../../../services/main/src/modules/realm-reply/store.ts';

const short = (ref: string) => ref.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`${response.status}, expected ${status}: ${text}`);
  return JSON.parse(text) as T;
}

test('a projection page links its real ratings, reviews and discussion through the resource section reads', async () => {
  const stack = await startMediaStack('projection-sections', { library: true, agents: true });
  try {
    const owner = await stack.member('owner');
    const person = (await json<{ agent: string }>(await owner.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Projection reviewer',
    }), 201)).agent;
    const work = await stack.publicWork(owner.actor);
    await owner.grant(`work:read:${work.work}`, 'work.read');
    await owner.grant('semantic:create:root', 'semantic.change');
    await owner.grant('projection:create:root', 'projection.create');
    const subject = (await json<{ component: string }>(await owner.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
      state: { component: 'resource', types: ['https://rezics.com/vocab/Character'], properties: [{
        predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: work.work },
      }] },
    }), 201)).component;
    const projection = (await json<{ projection: { id: string; revision: string } }>(await owner.send('POST',
      '/v1/projections', { subject, frames: [work.work], actingSubject: owner.actor }), 201)).projection;
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      content: stack.content, contentAuthoring: stack.content, media: stack.media, mediaAccess: stack.mediaAccess,
      reviews: new ReaderReviews(stack.accessPool), targetRatingInventory: new TargetRatingInventoryStore(stack.accessPool),
      realmReplies: new RealmReplyStore(new RealmReplyContentStore(stack.contentPool), stack.content, stack.access, stack.env),
      account: { verify: async () => ({ ...owner.principal, emailVerified: true }) },
    });
    const call = (method: string, path: string, body?: object) => {
      const url = new URL(path, 'http://main.local');
      if (method === 'GET') url.searchParams.set('actingSubject', owner.actor);
      return app.handle(new Request(url, {
        method, headers: { authorization: `Bearer ${owner.token}`, 'idempotency-key': randomUUID(),
          ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
      }));
    };
    await owner.grant('space:create:root', 'space.create');
    const realm = (await json<{ realm: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'Projection discussion', capabilities: ['realm'], actingSubject: owner.actor,
    }), 201)).realm;
    await owner.grant(`rating:context:${realm}`, 'rating.context.create');
    const context = (await json<{ context: string }>(await call('POST', '/v1/rating-contexts', {
      profile: 'realm-target-rating-context-v3', realm, targetGrain: 'projection', language: 'en',
      question: 'How good is this framed character?', actingSubject: owner.actor,
    }), 201)).context;
    await owner.grant(`rating:observe:${context}`, 'rating.observation.set');
    await json(await call('POST', '/v1/rating-observations', { profile: 'realm-target-rating-observation-v1',
      context, target: projection.id, value: 8, expectedRevisionHead: null, actingSubject: owner.actor }), 201);
    const review = await json<{ review: string }>(await call('POST', '/v1/reviews', {
      profile: 'reader-review-command-v1', context, target: projection.id, rating: 8,
      expectedRevision: null, language: 'en', text: 'A review of the framed character', spoiler: false,
      actingSubject: person,
    }), 201);
    const reply = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
    for (const [scope, action] of [[`content:draft:${reply}`, 'content.draft'],
      [`reply:create:${projection.id}`, 'reply.create'], [`review:decide:${realm}`, 'review.decide'],
      [`reply:place:${realm}`, 'reply.place']]) await owner.grant(scope!, action!);
    const draft = await json<{ revisionId: string }>(await call('POST', '/v1/member-reply-drafts', {
      profile: 'member-reply-draft-v1', reply, variantId, rootTarget: projection.id, rootRevision: projection.revision,
      language: 'en', direction: 'ltr', expectedHead: null, body: 'Discussion of the framed character', actingSubject: owner.actor,
    }), 201);
    await json(await call('POST', '/v1/realm-replies', { profile: 'realm-reply-identity-v1', reply, variantId,
      revisionId: draft.revisionId, author: owner.actor, rootTarget: projection.id, rootRevision: projection.revision,
      parentReply: null, parentRevision: null, contextRevision: null }), 201);
    const current = await json<{ revisionDigest: string }>(await call('GET',
      `/v1/member-replies/${short(reply)}?actingSubject=${encodeURIComponent(owner.actor)}`));
    const approved = await json<{ decisionId: string }>(await call('POST', '/v1/realm-reply-reviews', {
      profile: 'realm-reply-review-v1', realm, reply, revisionId: draft.revisionId, revisionDigest: current.revisionDigest,
      expectedGeneration: '0', supersedes: null, outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
      dependencyDigest: createHash('sha256').update(projection.revision).digest('hex'), reasonReference: null, actingSubject: owner.actor,
    }), 201);
    await json(await call('POST', '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1', realm, reply,
      revisionId: draft.revisionId, revisionDigest: current.revisionDigest, reviewDecisionId: approved.decisionId,
      expectedHead: null, actingSubject: owner.actor }), 201);
    const page = await json<Static<typeof entityPage>>(await call('GET', `/v1/resources/${short(projection.id)}/page`));
    expect(Value.Check(entityPage, page)).toBe(true);
    expect(Object.keys(page.projection!).sort()).toEqual(['frames', 'relations', 'statements', 'subject']);
    const section = (name: string) => {
      const href = page.sections.find(item => item.id === name)!.href;
      expect(href).toBe(`/v1/resources/${short(projection.id)}/${name}`);
      return href;
    };
    expect(await json(await call('GET', `${section('ratings')}?scope=realm&realm=${encodeURIComponent(realm)}&context=${encodeURIComponent(context)}`)))
      .toMatchObject({ count: 1, target: projection.id, targetGrain: 'projection' });
    expect(await json(await call('GET', `${section('reviews')}?context=${encodeURIComponent(context)}`)))
      .toMatchObject({ items: [{ id: review.review, work: projection.id, rating: 8 }] });
    expect(await json(await call('GET', section('discussion')))).toMatchObject({ items: [{ reply, body: 'Discussion of the framed character' }] });
    expect(await json(await call('GET', `/v1/resources/${short(subject)}/discussion`))).toMatchObject({ items: [] });
    expect((await call('GET', `${section('discussion')}?limit=21`)).status).toBe(400);
  } finally { await stack.stop(); }
}, 240_000);
