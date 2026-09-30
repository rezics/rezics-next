import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../src/app.ts';
import { RealmReplyContentStore } from '../src/modules/realm-reply/content-store.ts';
import { RealmReplyStore } from '../src/modules/realm-reply/store.ts';
import { contentDraftIntentDigest } from '../../content/src/core.ts';

const short = (id: string) => id.slice(-36);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function json(response: Response, status = 200): Promise<Record<string, any>> {
  const body = await response.json() as Record<string, any>;
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}

test('Work activity: reviewed body, public history, pagination, revocation, erasure and stale cursors', async () => {
  const stack = await startMediaStack('work-activity');
  try {
    const member = await stack.member('activity-owner');
    const work = await stack.publicWork(member.actor, ['en'], 'Activity public Work');
    const workHead = await stack.fuseki.query(`SELECT ?head WHERE {
      GRAPH <urn:rezics:graph:current> { <${work.work}> <https://rezics.com/vocab/head> ?head }
    }`);
    const workRevision = workHead.results!.bindings[0]!.head!.value;
    const privateWork = await stack.privateWork(member.actor, 'Activity private Work');
    const missing = `/v1/resources/${randomUUID()}`;
    const root = `/v1/resources/${short(work.work)}`;
    await member.grant('space:create:root', 'space.create');
    const createRealm = async (name: string) => json(await member.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name, capabilities: ['realm'],
      actingSubject: member.actor }), 201);
    const realm = await createRealm('Activity Realm');
    const realmId = realm.realm as string;
    const replyStore = new RealmReplyStore(new RealmReplyContentStore(stack.contentPool),
      stack.content, stack.access, stack.env);
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      content: stack.content, media: stack.media, realmReplies: replyStore,
      account: { verify: async () => member.principal } });
    const read = (path: string, authenticated = false) => app.handle(new Request(`http://main.local${path}`,
      authenticated ? { headers: { authorization: 'Bearer activity' } } : {}));
    const post = (path: string, body: unknown) => app.handle(new Request(`http://main.local${path}`,
      { method: 'POST', headers: { authorization: 'Bearer activity', 'content-type': 'application/json',
        'idempotency-key': randomUUID() }, body: JSON.stringify(body) }));
    expect((await read(`${missing}/discussion`)).status).toBe(404);
    expect((await read(`/v1/works/${short(privateWork.work)}/history`)).status).toBe(404);
    await member.grant(`work:read:${privateWork.work}`, 'work.read');
    expect((await read(`/v1/works/${short(privateWork.work)}/history?actingSubject=${encodeURIComponent(member.actor)}`,
      true)).status).toBe(200);
    expect((await read(`${root}/discussion`)).status).toBe(200);
    expect((await json(await read(`${root}/discussion`))).items).toEqual([]);

    const reply = `https://rezics.com/id/${randomUUID()}`;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    const draft = { operationId: randomUUID(), variant: {
      id: variantId, resourceId: reply,
      language: { kind: 'tag' as const, tag: 'en', originalTag: 'en' }, direction: 'ltr' as const,
    }, expectedHead: null, model: 'member-reply-v1', sourceRevision: workRevision,
    serializedJson: JSON.stringify({ rootTarget: work.work, rootRevision: workRevision,
      body: 'Reviewed reply body', deleted: false }) };
    const saved = await stack.content.saveDraft({ ...draft, provenance: {
      kind: 'admitted-original-contribution-v1', author: member.actor, admissionId: randomUUID(),
      authorityEpoch: '1', scope: `content:draft:${reply}`, expectedHead: null,
      rightsBasis: 'original-contribution', requestDigest: contentDraftIntentDigest(draft, member.actor) } });
    const revisionId = saved.revisionId!;
    const digest = (await stack.contentPool.query<{ byte_digest: string }>(
      'SELECT byte_digest FROM content.revision WHERE id = $1', [revisionId])).rows[0]!.byte_digest;
    await member.grant(`reply:create:${work.work}`, 'reply.create');
    await member.grant(`review:decide:${realmId}`, 'review.decide');
    await member.grant(`reply:place:${realmId}`, 'reply.place');
    await json(await post('/v1/realm-replies', { profile: 'realm-reply-identity-v1',
      reply, variantId, revisionId, author: member.actor, rootTarget: work.work,
      rootRevision: workRevision, parentReply: null, parentRevision: null,
      contextRevision: null }), 201);
    const reviewInput = { profile: 'realm-reply-review-v1', realm: realmId, reply,
      revisionId, revisionDigest: digest, expectedGeneration: '0', supersedes: null,
      outcome: 'approved', method: 'human', methodRevision: 'realm-manager-v1',
      dependencyDigest: sha(work.work), reasonReference: null, actingSubject: member.actor };
    const review = await json(await post('/v1/realm-reply-reviews', reviewInput), 201);
    const placed = await json(await post('/v1/realm-reply-placements', {
      profile: 'realm-reply-placement-v1', realm: realmId, reply, revisionId,
      revisionDigest: digest, reviewDecisionId: review.decisionId,
      expectedHead: null, actingSubject: member.actor }), 201);
    const secondRealmId = (await createRealm('Second Activity Realm')).realm as string;
    await member.grant(`review:decide:${secondRealmId}`, 'review.decide');
    await member.grant(`reply:place:${secondRealmId}`, 'reply.place');
    const secondReview = await json(await post('/v1/realm-reply-reviews', {
      ...reviewInput, realm: secondRealmId }), 201);
    const secondPlacement = await json(await post('/v1/realm-reply-placements', {
      profile: 'realm-reply-placement-v1', realm: secondRealmId, reply, revisionId,
      revisionDigest: digest, reviewDecisionId: secondReview.decisionId,
      expectedHead: null, actingSubject: member.actor }), 201);
    const discussion = await json(await read(`${root}/discussion?limit=1`));
    expect(discussion.items).toMatchObject([{ reply, realm: secondRealmId,
      placement: secondPlacement.placement, body: 'Reviewed reply body' }]);
    const nextDiscussion = await json(await read(`${root}/discussion?limit=1&cursor=${discussion.nextCursor}`));
    expect(nextDiscussion.items).toMatchObject([{ reply, realm: realmId,
      placement: placed.placement, body: 'Reviewed reply body' }]);
    expect((await read(`${root}/discussion?language=ja&cursor=${discussion.nextCursor}`)).status).toBe(400);
    expect(JSON.stringify(discussion)).not.toContain(member.actor);
    const scoped = await json(await read(`${root}/discussion?realm=${encodeURIComponent(realmId)}`));
    expect(scoped.items).toHaveLength(1);
    expect((await read(`${root}/discussion?realm=${encodeURIComponent('https://rezics.com/id/' + randomUUID())}`)).status).toBe(404);
    const history = await json(await read(`/v1/works/${short(work.work)}/history?limit=1`));
    expect(history.items).toMatchObject([{ kind: 'reply-placement', id: secondPlacement.placement }]);
    expect(history.nextCursor).toBeString();
    expect((await read(`/v1/works/${short(work.work)}/history?kind=metadata-revision&cursor=${history.nextCursor}`)).status).toBe(400);
    const next = await json(await read(`/v1/works/${short(work.work)}/history?limit=1&cursor=${history.nextCursor}`));
    expect(next.items).toHaveLength(1);
    expect(next.items[0].kind).toBe('reply-placement');
    expect((await json(await read(`/v1/works/${short(work.work)}/history?kind=metadata-revision`))).items).toHaveLength(1);
    const revoked = await json(await post('/v1/realm-reply-reviews', { ...reviewInput,
      expectedGeneration: '1', supersedes: review.decisionId, outcome: 'revoked',
      reasonReference: 'test-revocation' }), 201);
    expect(revoked.outcome).toBe('revoked');
    expect((await json(await read(`${root}/discussion`))).items).toMatchObject([
      { realm: secondRealmId, body: 'Reviewed reply body' }]);
    expect((await json(await read(`/v1/works/${short(work.work)}/history?kind=reply-placement`))).items)
      .toMatchObject([{ id: secondPlacement.placement }]);
    await stack.contentPool.query(`UPDATE content.revision SET availability = 'erased',
      serialized_bytes = NULL, body = NULL WHERE id = $1`, [revisionId]);
    expect((await json(await read(`${root}/discussion`))).items).toEqual([]);
    await stack.publicWork(member.actor, ['en'], 'Graph position changed');
    expect((await read(`/v1/works/${short(work.work)}/history?limit=1&cursor=${history.nextCursor}`)).status).toBe(409);
  } finally { await stack.stop(); }
}, 180_000);
