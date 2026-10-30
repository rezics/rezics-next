import { afterEach, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import type { ContentEditionRevisionView, ContentEditionView } from '../../src/content/edition-model.ts';
import { readContentEditionSaleAuthority } from '../../src/content/edition-sale.ts';
import { clearErasedPostRevisions } from '../../src/content/erased-post-cleanup.ts';
import { seedGovernanceAuthority, seedResourceDenial } from './support/disclosure-fixtures.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

let system: NativeContentSystem | undefined;
let app: Kernel;
afterEach(async () => { await system?.close(); system = undefined; });
async function wire(bearer: string, path: string, method = 'GET', body?: unknown, version?: string,
  key = randomUUID(), extra: Record<string, string> = {}) {
  return app.handle(new Request(`https://content.test${path}`, { method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
      'idempotency-key': JSON.stringify(key), ...(version ? { 'if-match': JSON.stringify(version) } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
async function value<T>(response: Promise<Response>, status: number): Promise<T> {
  const result = await response;
  const text = await result.text();
  expect({ status: result.status, error: result.status === status ? null : text }).toEqual({ status, error: null });
  return JSON.parse(text) as T;
}
async function fixture() {
  system = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  const native = system;
  await bootstrapRelease(native.database.pool, bundledRelease);
  const consent = createCurrentConsentReader({ database: native.database.authPool });
  app = createKernel({ pool: native.database.pool, routeKey: native.routeKey, tokens: native.tokenKeys,
    receiptKeys: testReceiptKeys(), access: native.access,
    content: { readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }) },
  });
  const author = native.actors.author;
  const buyer = native.actors.other;
  const token = author.bearer;
  const scheme = await value<{ subject: { id: string } }>(wire(token, '/v1/subjects', 'POST', {
    type: 'skos:ConceptScheme', labels: { en: 'Edition topics' },
  }), 201);
  const concept = await value<{ subject: { id: string } }>(wire(token, '/v1/subjects', 'POST', {
    type: 'skos:Concept', labels: { en: 'Edition source' }, statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
    },
  }), 201);
  const space = await value<{ space: { spaceId: string } }>(wire(token, '/v1/spaces', 'POST', { title: 'Edition home' }), 201);
  const realm = await value<{ realm: { realmId: string; headRevisionId: string } }>(wire(token, '/v1/realms', 'POST', {
    spaceId: space.space.spaceId, title: 'Edition realm', visibility: 'public', contextId: GLOBAL_CONTEXT,
  }), 201);
  await value(wire(token, `/v1/realms/${realm.realm.realmId}/boardScheme`, 'PUT',
    { schemeId: scheme.subject.id }, realm.realm.headRevisionId), 200);
  const board = await value<{ board: { id: string } }>(wire(token,
    `/v1/realms/${realm.realm.realmId}/boards`, 'POST', {
      conceptId: concept.subject.id, title: 'Edition board', visibility: 'published',
    }), 201);
  const body = fromPlainText('Exact authored edition snapshot');
  const created = await value<{ thread: { id: string; firstPost: { id: string; revisionId: string; sha256: string } } }>(
    wire(token, '/v1/threads', 'POST', { title: 'Protected source', body,
      licence: 'CC0-1.0', subjectIds: [concept.subject.id], boardId: board.board.id, visibility: 'protected' }), 201);
  const thread = created.thread;
  const post = thread.firstPost;
  const route = routeOf(post.id)!;
  // Actual installed formula grants: the buyer can read the container, never the protected source post.
  await seedGovernanceAuthority(native.database.pool, route, thread.id, buyer.actor.accountId, ['thread:read']);
  const draft = await value<{ editionId: string; editionRevision: string }>(
    wire(token, '/v1/contentEditions', 'POST', { postId: post.id, revisionId: post.revisionId, targetSubjectId: concept.subject.id }), 201);
  return { native, author, buyer, token, thread, post, route, draft, body,
    targetSubjectId: concept.subject.id, unassociatedSubjectId: scheme.subject.id };
}

test('native immutable authored edition binds exact source revision creator sale authority and current protected Access read without generic post or lifecycle bypass', async () => {
  const f = await fixture();
  const id = f.draft.editionId;
  const base = `/v1/contentEditions/${id}`;
  expect(f.draft.editionRevision).toBe('1');
  expect(await value<ContentEditionView>(wire(f.token, base), 200)).toEqual({
    editionId: id, editionRevision: '1', state: 'draft', targetSubjectId: f.targetSubjectId,
    creatorAccountId: f.author.actor.accountId, revisionId: f.post.revisionId,
    sha256: f.post.sha256, licence: 'CC0-1.0',
  });
  expect((await wire(f.token, `${base}/revision`)).status).toBe(404);
  expect(await readContentEditionSaleAuthority({ pool: f.native.database.pool, access: f.native.access }, id,
    { actor: f.buyer.actor, deadline: Date.now() + 10000 })).toBeNull();
  expect((await wire(f.buyer.bearer, '/v1/contentEditions', 'POST',
    { postId: f.post.id, revisionId: f.post.revisionId, targetSubjectId: f.targetSubjectId })).status).toBe(404);
  const key = randomUUID();
  const published = await value(wire(f.token, `${base}:publish`, 'POST', {}, '1', key), 200);
  expect(await value(wire(f.token, `${base}:publish`, 'POST', {}, '1', key), 200)).toEqual(published);
  await seedGovernanceAuthority(f.native.database.pool, f.route, id, f.buyer.actor.accountId, ['edition:read']);
  const sale = await readContentEditionSaleAuthority({ pool: f.native.database.pool, access: f.native.access }, id,
    { actor: f.buyer.actor, deadline: Date.now() + 10000 });
  expect(sale).toEqual({
    benefit: { kind: 'content-edition', resourceType: 'content.edition',
      resource: { route: f.route, id },
      version: { revisionId: f.post.revisionId, sha256: f.post.sha256 }, action: 'edition:read' },
    targetSubjectId: f.targetSubjectId, creatorAccountId: f.author.actor.accountId, licence: 'CC0-1.0',
    source: { threadId: f.thread.id, postId: f.post.id, revisionId: f.post.revisionId, sha256: f.post.sha256 },
    editionRevision: '2',
  });
  const metadata = await value<ContentEditionView>(wire(f.buyer.bearer, base), 200);
  expect(metadata).toEqual({
    editionId: id, editionRevision: '2', state: 'published', targetSubjectId: f.targetSubjectId,
    creatorAccountId: f.author.actor.accountId, revisionId: f.post.revisionId,
    sha256: f.post.sha256, licence: 'CC0-1.0',
  });
  expect(metadata).not.toHaveProperty('body');
  expect(metadata).not.toHaveProperty('postId');
  expect(metadata).not.toHaveProperty('threadId');
  const delivered = await value<ContentEditionRevisionView>(wire(f.buyer.bearer, `${base}/revision`), 200);
  expect(delivered).toEqual({ editionId: id, revisionId: f.post.revisionId,
    sha256: f.post.sha256, licence: 'CC0-1.0', body: f.body });
  expect((await wire(f.buyer.bearer, `/v1/posts/${f.post.id}`)).status).toBe(404);
  await value(wire(f.token, `/v1/posts/${f.post.id}/revisions`, 'POST',
    { body: fromPlainText('New head does not retarget an edition') }, f.post.revisionId), 201);
  expect(await value(wire(f.buyer.bearer, `${base}/revision`), 200)).toEqual(delivered);
  await seedResourceDenial(f.native.database.pool, f.route, f.thread.id, f.buyer.actor.accountId, ['thread:read']);
  expect((await wire(f.buyer.bearer, `${base}/revision`, 'GET', undefined, undefined, randomUUID(),
    { 'if-none-match': JSON.stringify(f.post.sha256) })).status).toBe(404);
});

test('current creator revocation, terminal unpublication and native source erasure refuse fixed edition bytes', async () => {
  const f = await fixture();
  const base = `/v1/contentEditions/${f.draft.editionId}`;
  await value(wire(f.token, `${base}:publish`, 'POST', {}, '1'), 200);
  await value(wire(f.token, `${base}/revision`), 200);
  await seedResourceDenial(f.native.database.pool, f.route, f.post.id, f.author.actor.accountId, ['post:revise']);
  expect((await wire(f.token, `${base}/revision`)).status).toBe(503);
  // Unpublication uses its own native owner action, never Commerce refund authority.
  await value(wire(f.token, `${base}:unpublish`, 'POST', {}, '2'), 200);
  expect((await wire(f.token, `${base}/revision`)).status).toBe(404);
  expect((await wire(f.token, `${base}:publish`, 'POST', {}, '3')).status).toBe(404);
  // A separate edition is needed; a terminal publication cannot be revived.
  const otherSource = await value<{ post: { id: string; revisionId: string } }>(wire(f.token,
    `/v1/threads/${f.thread.id}/posts`, 'POST', { body: fromPlainText('Second exact source'), licence: 'CC0-1.0', subjectIds: [f.targetSubjectId] }), 201);
  const other = await value<{ editionId: string }>(wire(f.token, '/v1/contentEditions', 'POST',
    { postId: otherSource.post.id, revisionId: otherSource.post.revisionId, targetSubjectId: f.targetSubjectId }), 201);
  const otherBase = `/v1/contentEditions/${other.editionId}`;
  await value(wire(f.token, `${otherBase}:publish`, 'POST', {}, '1'), 200);
  await value(wire(f.token, `${otherBase}/revision`), 200);
  await value(wire(f.token, `/v1/posts/${otherSource.post.id}`, 'DELETE'), 200);
  expect((await wire(f.token, `${otherBase}/revision`, 'GET', undefined, undefined, randomUUID(),
    { 'if-none-match': '*' })).status).toBe(404);
  await clearErasedPostRevisions(f.native.database.pool, { postId: otherSource.post.id }, Date.now() + 10000,
    () => new Date(Date.now() + 31 * 86400000));
  const erased = await f.native.database.pool.query<{ body: Buffer | null }>(
    'SELECT body FROM content.revision WHERE route=$1 AND thread_id=$2 AND post_id=$3 AND revision_id=$4',
    [f.route, f.thread.id, otherSource.post.id, otherSource.post.revisionId]);
  expect(erased.rows[0]?.body).toBeNull();
  expect((await wire(f.token, `${otherBase}/revision`)).status).toBe(404);
});

test('edition target requires an existing readable association in the selected original revision', async () => {
  const f = await fixture();
  const input = { postId: f.post.id, revisionId: f.post.revisionId };
  expect((await wire(f.token, '/v1/contentEditions', 'POST', input)).status).toBe(400);
  expect((await wire(f.token, '/v1/contentEditions', 'POST',
    { ...input, targetSubjectId: f.unassociatedSubjectId })).status).toBe(404);
  const base = `/v1/contentEditions/${f.draft.editionId}`;
  await value(wire(f.token, `${base}:publish`, 'POST', {}, '1'), 200);
  const delivered = await value<ContentEditionRevisionView>(wire(f.token, `${base}/revision`), 200);
  await value(wire(f.token, `/v1/posts/${f.post.id}/revisions`, 'POST', {
    body: fromPlainText('Only the new head associates the other subject'), subjectIds: [f.unassociatedSubjectId],
  }, f.post.revisionId), 201);
  expect((await wire(f.token, '/v1/contentEditions', 'POST',
    { ...input, targetSubjectId: f.unassociatedSubjectId })).status).toBe(404);
  expect(await value<ContentEditionRevisionView>(wire(f.token, `${base}/revision`), 200)).toEqual(delivered);
  const moderator = f.native.actors.moderator;
  await seedGovernanceAuthority(f.native.database.pool, 0, GLOBAL_CONTEXT, moderator.actor.accountId, ['moderation:hide']);
  await value(wire(moderator.bearer, `/v1/subjects/${f.targetSubjectId}:hide`, 'POST',
    { reason: 'Withhold the original edition subject' }), 200);
  expect((await wire(f.token, '/v1/contentEditions', 'POST',
    { ...input, targetSubjectId: f.targetSubjectId })).status).toBe(404);
  expect((await wire(f.token, base)).status).toBe(404);
  expect((await wire(f.token, `${base}/revision`, 'GET', undefined, undefined, randomUUID(),
    { 'if-none-match': '*' })).status).toBe(404);
  expect(await readContentEditionSaleAuthority({ pool: f.native.database.pool, access: f.native.access },
    f.draft.editionId, { actor: f.author.actor, deadline: Date.now() + 10000 })).toBeNull();
});
