import { afterEach, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { ContentEditionRevisionView, ContentEditionView } from '../../src/content/edition-model.ts';
import { readEditionSourceIdentity } from '../../src/content/edition-reads.ts';
import readIdentityLabels from '../../src/semantic/read-related.sql';
import { observeSql } from './support/sql-observer.ts';
import { readContentEditionSaleAuthority } from '../../src/content/edition-sale.ts';
import { clearErasedPostRevisions } from '../../src/content/erased-post-cleanup.ts';
import { seedGovernanceAuthority, seedResourceDenial } from './support/disclosure-fixtures.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

let system: NativeContentSystem | undefined;
let app: Kernel;
afterEach(async () => {
  await system?.close();
  system = undefined;
});
async function wire(
  bearer: string,
  path: string,
  method = 'GET',
  body?: unknown,
  version?: string,
  key = randomUUID(),
  extra: Record<string, string> = {},
) {
  return app.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
        ...(version ? { 'if-match': JSON.stringify(version) } : {}),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
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
  app = createKernel({
    pool: native.database.pool,
    routeKey: native.routeKey,
    tokens: native.tokenKeys,
    receiptKeys: testReceiptKeys(),
    access: native.access,
    content: {
      readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
    },
  });
  const author = native.actors.author;
  const buyer = native.actors.other;
  const token = author.bearer;
  const scheme = await value<{ subject: { id: string } }>(
    wire(token, '/v1/subjects', 'POST', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Edition topics' },
    }),
    201,
  );
  const concept = await value<{ subject: { id: string } }>(
    wire(token, '/v1/subjects', 'POST', {
      type: 'skos:Concept',
      labels: { en: 'Edition source' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
      },
    }),
    201,
  );
  const space = await value<{ space: { spaceId: string } }>(
    wire(token, '/v1/spaces', 'POST', { title: 'Edition home' }),
    201,
  );
  const realm = await value<{ realm: { realmId: string; headRevisionId: string } }>(
    wire(token, '/v1/realms', 'POST', {
      spaceId: space.space.spaceId,
      title: 'Edition realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    }),
    201,
  );
  await value(
    wire(
      token,
      `/v1/realms/${realm.realm.realmId}/boardScheme`,
      'PUT',
      { schemeId: scheme.subject.id },
      realm.realm.headRevisionId,
    ),
    200,
  );
  const board = await value<{ board: { id: string } }>(
    wire(token, `/v1/realms/${realm.realm.realmId}/boards`, 'POST', {
      conceptId: concept.subject.id,
      title: 'Edition board',
      visibility: 'published',
    }),
    201,
  );
  const body = fromPlainText('Exact authored edition snapshot');
  const created = await value<{
    thread: { id: string; firstPost: { id: string; revisionId: string; sha256: string } };
  }>(
    wire(token, '/v1/threads', 'POST', {
      title: 'Protected source',
      body,
      licence: 'CC0-1.0',
      subjectIds: [concept.subject.id],
      boardId: board.board.id,
      visibility: 'protected',
    }),
    201,
  );
  const thread = created.thread;
  const post = thread.firstPost;
  const route = routeOf(post.id)!;
  // Actual installed formula grants: the buyer can read the container, never the protected source post.
  await seedGovernanceAuthority(native.database.pool, route, thread.id, buyer.actor.accountId, ['thread:read']);
  const draft = await value<{ editionId: string; editionRevision: string }>(
    wire(token, '/v1/contentEditions', 'POST', {
      postId: post.id,
      revisionId: post.revisionId,
      targetSubjectId: concept.subject.id,
    }),
    201,
  );
  return {
    native,
    author,
    buyer,
    token,
    thread,
    post,
    route,
    draft,
    body,
    targetSubjectId: concept.subject.id,
    unassociatedSubjectId: scheme.subject.id,
  };
}

test('native immutable authored edition binds exact source revision creator sale authority and current protected Access read without generic post or lifecycle bypass', async () => {
  const f = await fixture();
  const id = f.draft.editionId;
  const base = `/v1/contentEditions/${id}`;
  expect(f.draft.editionRevision).toBe('1');
  expect(await value<ContentEditionView>(wire(f.token, base), 200)).toEqual({
    editionId: id,
    editionRevision: '1',
    state: 'draft',
    targetSubjectId: f.targetSubjectId,
    creatorAccountId: f.author.actor.accountId,
    revisionId: f.post.revisionId,
    sha256: f.post.sha256,
    licence: 'CC0-1.0',
  });
  expect((await wire(f.token, `${base}/revision`)).status).toBe(404);
  expect(
    await readContentEditionSaleAuthority(
      { clock: () => new Date(), pool: f.native.database.pool, access: f.native.access },
      id,
      {
        actor: f.buyer.actor,
        deadline: Date.now() + 10000,
      },
    ),
  ).toBeNull();
  expect(
    (
      await wire(f.buyer.bearer, '/v1/contentEditions', 'POST', {
        postId: f.post.id,
        revisionId: f.post.revisionId,
        targetSubjectId: f.targetSubjectId,
      })
    ).status,
  ).toBe(404);
  const key = randomUUID();
  const published = await value(wire(f.token, `${base}:publish`, 'POST', {}, '1', key), 200);
  expect(await value(wire(f.token, `${base}:publish`, 'POST', {}, '1', key), 200)).toEqual(published);
  await seedGovernanceAuthority(f.native.database.pool, f.route, id, f.buyer.actor.accountId, ['edition:read']);
  const sale = await readContentEditionSaleAuthority(
    { clock: () => new Date(), pool: f.native.database.pool, access: f.native.access },
    id,
    {
      actor: f.buyer.actor,
      deadline: Date.now() + 10000,
    },
  );
  expect(sale).toEqual({
    benefit: {
      kind: 'content-edition',
      resourceType: 'content.edition',
      resource: { route: f.route, id },
      version: { revisionId: f.post.revisionId, sha256: f.post.sha256 },
      action: 'edition:read',
    },
    targetSubjectId: f.targetSubjectId,
    creatorAccountId: f.author.actor.accountId,
    licence: 'CC0-1.0',
    source: { threadId: f.thread.id, postId: f.post.id, revisionId: f.post.revisionId, sha256: f.post.sha256 },
    editionRevision: '2',
  });
  const metadata = await value<ContentEditionView>(wire(f.buyer.bearer, base), 200);
  expect(metadata).toEqual({
    editionId: id,
    editionRevision: '2',
    state: 'published',
    targetSubjectId: f.targetSubjectId,
    creatorAccountId: f.author.actor.accountId,
    revisionId: f.post.revisionId,
    sha256: f.post.sha256,
    licence: 'CC0-1.0',
  });
  expect(metadata).not.toHaveProperty('body');
  expect(metadata).not.toHaveProperty('postId');
  expect(metadata).not.toHaveProperty('threadId');
  const delivered = await value<ContentEditionRevisionView>(wire(f.buyer.bearer, `${base}/revision`), 200);
  expect(delivered).toEqual({
    editionId: id,
    revisionId: f.post.revisionId,
    sha256: f.post.sha256,
    licence: 'CC0-1.0',
    body: f.body,
  });
  expect((await wire(f.buyer.bearer, `/v1/posts/${f.post.id}`)).status).toBe(404);
  await value(
    wire(
      f.token,
      `/v1/posts/${f.post.id}/revisions`,
      'POST',
      { body: fromPlainText('New head does not retarget an edition') },
      f.post.revisionId,
    ),
    201,
  );
  expect(await value(wire(f.buyer.bearer, `${base}/revision`), 200)).toEqual(delivered);
  await seedResourceDenial(f.native.database.pool, f.route, f.thread.id, f.buyer.actor.accountId, ['thread:read']);
  expect(
    (
      await wire(f.buyer.bearer, `${base}/revision`, 'GET', undefined, undefined, randomUUID(), {
        'if-none-match': JSON.stringify(f.post.sha256),
      })
    ).status,
  ).toBe(404);
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
  const otherSource = await value<{ post: { id: string; revisionId: string } }>(
    wire(f.token, `/v1/threads/${f.thread.id}/posts`, 'POST', {
      body: fromPlainText('Second exact source'),
      licence: 'CC0-1.0',
      subjectIds: [f.targetSubjectId],
    }),
    201,
  );
  const other = await value<{ editionId: string }>(
    wire(f.token, '/v1/contentEditions', 'POST', {
      postId: otherSource.post.id,
      revisionId: otherSource.post.revisionId,
      targetSubjectId: f.targetSubjectId,
    }),
    201,
  );
  const otherBase = `/v1/contentEditions/${other.editionId}`;
  await value(wire(f.token, `${otherBase}:publish`, 'POST', {}, '1'), 200);
  await value(wire(f.token, `${otherBase}/revision`), 200);
  await value(wire(f.token, `/v1/posts/${otherSource.post.id}`, 'DELETE'), 200);
  expect(
    (await wire(f.token, `${otherBase}/revision`, 'GET', undefined, undefined, randomUUID(), { 'if-none-match': '*' }))
      .status,
  ).toBe(404);
  await clearErasedPostRevisions(
    f.native.database.pool,
    { postId: otherSource.post.id },
    Date.now() + 10000,
    () => new Date(Date.now() + 31 * 86400000),
  );
  const erased = await f.native.database.pool.query<{ body: Buffer | null }>(
    'SELECT body FROM content.revision WHERE route=$1 AND thread_id=$2 AND post_id=$3 AND revision_id=$4',
    [f.route, f.thread.id, otherSource.post.id, otherSource.post.revisionId],
  );
  expect(erased.rows[0]?.body).toBeNull();
  expect((await wire(f.token, `${otherBase}/revision`)).status).toBe(404);
});

test('edition target requires an existing readable association in the selected original revision', async () => {
  const f = await fixture();
  const input = { postId: f.post.id, revisionId: f.post.revisionId };
  expect((await wire(f.token, '/v1/contentEditions', 'POST', input)).status).toBe(400);
  expect(
    (await wire(f.token, '/v1/contentEditions', 'POST', { ...input, targetSubjectId: f.unassociatedSubjectId })).status,
  ).toBe(404);
  const base = `/v1/contentEditions/${f.draft.editionId}`;
  await value(wire(f.token, `${base}:publish`, 'POST', {}, '1'), 200);
  const delivered = await value<ContentEditionRevisionView>(wire(f.token, `${base}/revision`), 200);
  await value(
    wire(
      f.token,
      `/v1/posts/${f.post.id}/revisions`,
      'POST',
      {
        body: fromPlainText('Only the new head associates the other subject'),
        subjectIds: [f.unassociatedSubjectId],
      },
      f.post.revisionId,
    ),
    201,
  );
  expect(
    (await wire(f.token, '/v1/contentEditions', 'POST', { ...input, targetSubjectId: f.unassociatedSubjectId })).status,
  ).toBe(404);
  expect(await value<ContentEditionRevisionView>(wire(f.token, `${base}/revision`), 200)).toEqual(delivered);
  const moderator = f.native.actors.moderator;
  await seedGovernanceAuthority(f.native.database.pool, 0, GLOBAL_CONTEXT, moderator.actor.accountId, [
    'moderation:hide',
  ]);
  await value(
    wire(moderator.bearer, `/v1/subjects/${f.targetSubjectId}:hide`, 'POST', {
      reason: 'Withhold the original edition subject',
    }),
    200,
  );
  expect(
    (await wire(f.token, '/v1/contentEditions', 'POST', { ...input, targetSubjectId: f.targetSubjectId })).status,
  ).toBe(404);
  expect((await wire(f.token, base)).status).toBe(404);
  expect(
    (await wire(f.token, `${base}/revision`, 'GET', undefined, undefined, randomUUID(), { 'if-none-match': '*' }))
      .status,
  ).toBe(404);
  expect(
    await readContentEditionSaleAuthority(
      { clock: () => new Date(), pool: f.native.database.pool, access: f.native.access },
      f.draft.editionId,
      { actor: f.author.actor, deadline: Date.now() + 10000 },
    ),
  ).toBeNull();
});

const identityOptIn = { 'rezics-edition-identity': 'true' };
type ExactIdentityResponse = Awaited<ReturnType<typeof readEditionSourceIdentity>>['value'];
const exactPath = (f: Awaited<ReturnType<typeof fixture>>) => `/v1/posts/${f.post.id}/revisions/${f.post.revisionId}`;
function metadataIdentity(token: string, path: string) {
  return wire(token, path, 'GET', undefined, undefined, randomUUID(), identityOptIn);
}
async function revisionDate(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.native.database.pool.query<{ recorded_at: Date }>(
    'SELECT recorded_at FROM content.revision WHERE route=$1 AND revision_id=$2',
    [f.route, f.post.revisionId],
  );
  return result.rows[0]!.recorded_at.toISOString();
}

test('default exact revision HTTP preserves legacy query admission and validates only the edition opt-in', async () => {
  const f = await fixture();
  const path = exactPath(f);
  const plain = await value<{ post: ExactIdentityResponse['post'] }>(wire(f.token, path), 200);
  expect(Object.keys(plain)).toEqual(['post']);
  expect(await value(wire(f.token, `${path}?unrelated=value`), 200)).toEqual(plain);
  const response = await wire(f.token, `${path}?editionIdentity=true`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('rezics-session-token')).toBeString();
  const opted = (await response.json()) as ExactIdentityResponse;
  expect(Object.keys(opted).sort()).toEqual(['editionIdentity', 'post']);
  expect(opted.post).toEqual(plain.post);
  expect(opted.editionIdentity).toEqual({
    postId: f.post.id,
    revisionId: f.post.revisionId,
    sha256: f.post.sha256,
    revisionCreatedAt: await revisionDate(f),
    subjects: [{ id: f.targetSubjectId, kind: 'available', label: { value: 'Edition source', language: 'en' } }],
  });
  // Supplied unrelated IDs are still admitted, but confer no associations or authority.
  expect(
    await value(
      wire(f.token, `${path}?unrelated=value&targetSubjectId=${f.unassociatedSubjectId}&editionIdentity=true`),
      200,
    ),
  ).toEqual(opted);
  for (const malformed of ['false', 'True', '1', '']) {
    expect((await wire(f.token, `${path}?editionIdentity=${malformed}`)).status).toBe(400);
    expect((await wire(f.token, `${path}?unrelated=value&editionIdentity=${malformed}`)).status).toBe(400);
  }
  expect((await wire(f.buyer.bearer, path)).status).toBe(404);
  expect((await wire(f.buyer.bearer, `${path}?editionIdentity=true`)).status).toBe(404);
  await seedGovernanceAuthority(f.native.database.pool, f.route, f.post.id, f.buyer.actor.accountId, ['post:read']);
  expect((await wire(f.buyer.bearer, path)).status).toBe(200);
  // Ordinary source reading alone does not turn a noncreator into the edition author.
  expect((await wire(f.buyer.bearer, `${path}?editionIdentity=true`)).status).toBe(404);
}, 60000);

test('default exact identity pins the old immutable revision, digest and associations after a new head', async () => {
  const f = await fixture();
  const path = `${exactPath(f)}?editionIdentity=true`;
  const original = await value<ExactIdentityResponse>(wire(f.token, path), 200);
  const revised = await value<{ post: { revisionId: string } }>(
    wire(
      f.token,
      `/v1/posts/${f.post.id}/revisions`,
      'POST',
      {
        body: fromPlainText('Different head and association'),
        subjectIds: [f.unassociatedSubjectId],
      },
      f.post.revisionId,
    ),
    201,
  );
  const pinned = await value<ExactIdentityResponse>(wire(f.token, path), 200);
  expect(pinned.editionIdentity).toEqual(original.editionIdentity);
  expect(pinned.post.body).toEqual(f.body);
  expect(pinned.post.revisionId).toBe(f.post.revisionId);
  expect(pinned.post.sha256).toBe(f.post.sha256);
  const head = await value<ExactIdentityResponse>(
    wire(f.token, `/v1/posts/${f.post.id}/revisions/${revised.post.revisionId}?editionIdentity=true`),
    200,
  );
  expect(head.editionIdentity.revisionId).toBe(revised.post.revisionId);
  expect(head.editionIdentity.sha256).not.toBe(f.post.sha256);
  expect(head.editionIdentity.subjects).toEqual([
    { id: f.unassociatedSubjectId, kind: 'available', label: { value: 'Edition topics', language: 'en' } },
  ]);
  const reply = await value<{ post: { id: string; revisionId: string } }>(
    wire(f.token, `/v1/threads/${f.thread.id}/posts`, 'POST', {
      body: fromPlainText('Another exact post'),
      licence: 'CC0-1.0',
      subjectIds: [],
    }),
    201,
  );
  expect(
    (await wire(f.token, `/v1/posts/${f.post.id}/revisions/${reply.post.revisionId}?editionIdentity=true`)).status,
  ).toBe(404);
  expect(
    (await wire(f.token, `/v1/posts/${reply.post.id}/revisions/${f.post.revisionId}?editionIdentity=true`)).status,
  ).toBe(404);
}, 60000);

test('default edition metadata opt-in preserves closed shapes and never derives ordinary dates from publication ownership', async () => {
  const f = await fixture();
  const base = `/v1/contentEditions/${f.draft.editionId}`;
  const plain = await value<ContentEditionView>(wire(f.token, base), 200);
  expect(plain).not.toHaveProperty('identity');
  const draft = await value<ContentEditionView>(metadataIdentity(f.token, base), 200);
  expect(draft).toEqual({
    ...plain,
    identity: {
      subject: { id: f.targetSubjectId, kind: 'available', label: { value: 'Edition source', language: 'en' } },
      revisionCreatedAt: await revisionDate(f),
    },
  });
  expect((await metadataIdentity(f.token, base)).headers.get('cache-control')).toBe('private, no-store');
  expect((await metadataIdentity(f.buyer.bearer, base)).status).toBe(404);
  expect(
    (
      await wire(f.token, base, 'GET', undefined, undefined, randomUUID(), {
        'rezics-edition-identity': 'false',
      })
    ).status,
  ).toBe(400);
  await value(wire(f.token, `${base}:publish`, 'POST', {}, '1'), 200);
  await seedGovernanceAuthority(f.native.database.pool, f.route, f.draft.editionId, f.buyer.actor.accountId, [
    'edition:read',
  ]);
  const published = await value<ContentEditionView>(wire(f.buyer.bearer, base), 200);
  expect(published).not.toHaveProperty('identity');
  const recognized = await value<ContentEditionView>(metadataIdentity(f.buyer.bearer, base), 200);
  expect(recognized).toEqual({ ...published, identity: { ...draft.identity!, revisionCreatedAt: null } });
  expect(recognized).not.toHaveProperty('postId');
  expect(recognized).not.toHaveProperty('threadId');
  expect(recognized).not.toHaveProperty('body');
  expect(
    (await wire(f.buyer.bearer, `${exactPath(f)}?editionIdentity=true&editionId=${f.draft.editionId}`)).status,
  ).toBe(404);
  // Published metadata retains its native authority rather than borrowing source permission.
  expect(
    (await value<ContentEditionView>(metadataIdentity(f.token, base), 200)).identity?.revisionCreatedAt,
  ).toBeNull();
  await value(wire(f.token, `${base}:unpublish`, 'POST', {}, '2'), 200);
  const withdrawn = await value<ContentEditionView>(metadataIdentity(f.token, base), 200);
  expect(withdrawn.state).toBe('withdrawn');
  expect(withdrawn.identity?.revisionCreatedAt).toBe(await revisionDate(f));
  await seedResourceDenial(f.native.database.pool, f.route, f.post.id, f.author.actor.accountId, ['post:read']);
  expect((await wire(f.token, `${exactPath(f)}?editionIdentity=true`)).status).toBe(404);
  expect((await wire(f.token, base)).status).toBe(404);
  expect((await metadataIdentity(f.token, base)).status).toBe(404);
}, 60000);

for (const state of ['hidden', 'taken_down', 'redirected', 'denied'] as const) {
  test(`default exact identity withholds a ${state} subject without replacing its pinned ID`, async () => {
    const f = await fixture();
    if (state === 'redirected') {
      await f.native.database.admin.query(
        'INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id) VALUES ($1,$2,1,$3,$2)',
        [routeOf(f.targetSubjectId), f.targetSubjectId, f.unassociatedSubjectId],
      );
    } else if (state === 'denied') {
      await seedResourceDenial(
        f.native.database.pool,
        routeOf(f.targetSubjectId)!,
        f.targetSubjectId,
        f.author.actor.accountId,
        ['subject:read'],
      );
    } else {
      await f.native.database.admin.query(
        'UPDATE semantic.subject SET visibility=$3,security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2',
        [routeOf(f.targetSubjectId), f.targetSubjectId, state],
      );
    }
    const plain = await value<{ post: ExactIdentityResponse['post'] }>(wire(f.token, exactPath(f)), 200);
    const result = await value<ExactIdentityResponse>(wire(f.token, `${exactPath(f)}?editionIdentity=true`), 200);
    expect(result.post).toEqual(plain.post);
    expect(result.editionIdentity.subjects).toEqual([{ id: f.targetSubjectId, kind: 'withheld', label: null }]);
    expect(result.editionIdentity.revisionCreatedAt).toBe(await revisionDate(f));
    expect((await metadataIdentity(f.token, `/v1/contentEditions/${f.draft.editionId}`)).status).toBe(404);
  }, 60000);
}

test('default exact identity distinguishes an unlabelled subject and a deleted subject', async () => {
  const f = await fixture();
  const subject = newId(routeOf(f.targetSubjectId)!);
  // A bare native subject has no contributions or label; deletion leaves the exact
  // authored revision's reference intact. This setup grants no read permission.
  await f.native.database.admin.query(
    "INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id) VALUES ($1,$2,'schema:Book',$2)",
    [routeOf(subject), subject],
  );
  const revised = await value<{ post: { revisionId: string } }>(
    wire(
      f.token,
      `/v1/posts/${f.post.id}/revisions`,
      'POST',
      { body: f.body, subjectIds: [subject] },
      f.post.revisionId,
    ),
    201,
  );
  const path = `/v1/posts/${f.post.id}/revisions/${revised.post.revisionId}?editionIdentity=true`;
  expect((await value<ExactIdentityResponse>(wire(f.token, path), 200)).editionIdentity.subjects).toEqual([
    { id: subject, kind: 'missing', label: null },
  ]);
  await f.native.database.admin.query('DELETE FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
    routeOf(subject),
    subject,
  ]);
  expect((await value<ExactIdentityResponse>(wire(f.token, path), 200)).editionIdentity.subjects).toEqual([
    { id: subject, kind: 'withheld', label: null },
  ]);
}, 60000);

for (const change of ['subject denial', 'source denial', 'subject redirect'] as const) {
  test(`default exact identity fences a ${change} committed during label composition`, async () => {
    const f = await fixture();
    const observer = observeSql(f.native.database.pool);
    const barrier = observer.hold({ statement: readIdentityLabels.sql }, 'after');
    const pending = wire(f.token, `${exactPath(f)}?editionIdentity=true`);
    try {
      await Promise.race([
        barrier.entered,
        pending.then(async (response) => {
          throw new Error(`Expected identity label boundary, received ${response.status}: ${await response.text()}`);
        }),
      ]);
      if (change === 'subject denial') {
        await seedResourceDenial(
          f.native.database.pool,
          routeOf(f.targetSubjectId)!,
          f.targetSubjectId,
          f.author.actor.accountId,
          ['subject:read'],
        );
      } else if (change === 'source denial') {
        await seedResourceDenial(f.native.database.pool, f.route, f.post.id, f.author.actor.accountId, ['post:read']);
      } else {
        await f.native.database.admin.query(
          'INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id) VALUES ($1,$2,1,$3,$2)',
          [routeOf(f.targetSubjectId), f.targetSubjectId, f.unassociatedSubjectId],
        );
      }
      barrier.release();
      if (change === 'source denial') {
        const response = await pending;
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('Exact authored edition snapshot');
      } else {
        const result = await value<ExactIdentityResponse>(pending, 200);
        expect(result.editionIdentity.subjects).toEqual([{ id: f.targetSubjectId, kind: 'withheld', label: null }]);
      }
    } finally {
      barrier.release();
      await pending;
      await observer.close();
    }
  }, 60000);
}

test('default edition opt-ins refuse erased sources while ordinary exact reads retain authorized tombstones', async () => {
  const f = await fixture();
  const path = `${exactPath(f)}?editionIdentity=true`;
  expect((await wire(f.token, path)).status).toBe(200);
  await seedGovernanceAuthority(f.native.database.pool, f.route, f.post.id, f.author.actor.accountId, ['post:read']);
  await value(wire(f.token, `/v1/posts/${f.post.id}`, 'DELETE'), 200);
  const ordinary = await value<{ post: { availability: string; body: null; sha256: null } }>(
    wire(f.token, exactPath(f)),
    200,
  );
  expect(Object.keys(ordinary)).toEqual(['post']);
  expect(ordinary.post).toMatchObject({ availability: 'erased', body: null, sha256: null });
  for (const target of [path, `/v1/contentEditions/${f.draft.editionId}`]) {
    const response = await wire(f.token, target, 'GET', undefined, undefined, randomUUID(), {
      ...identityOptIn,
      'if-none-match': JSON.stringify(f.post.sha256),
    });
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain('revisionCreatedAt');
    expect(text).not.toContain('Exact authored edition snapshot');
  }
}, 60000);

for (const change of ['label edit', 'source denial', 'subject hide', 'edition denial'] as const) {
  test(`default edition metadata fences a ${change} during identity composition`, async () => {
    const f = await fixture();
    const base = `/v1/contentEditions/${f.draft.editionId}`;
    const observer = observeSql(f.native.database.pool);
    const barrier = observer.hold({ statement: readIdentityLabels.sql }, 'after');
    const pending = metadataIdentity(f.token, base);
    try {
      await Promise.race([
        barrier.entered,
        pending.then(async (response) => {
          throw new Error(`Expected identity label boundary, received ${response.status}: ${await response.text()}`);
        }),
      ]);
      if (change === 'label edit') {
        await value(
          wire(
            f.token,
            `/v1/subjects/${f.targetSubjectId}/terms`,
            'PATCH',
            { labels: { en: 'Current edition label' } },
            '1',
          ),
          200,
        );
      } else if (change === 'subject hide') {
        await f.native.database.admin.query(
          "UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1 WHERE route=$1 AND subject_id=$2",
          [routeOf(f.targetSubjectId), f.targetSubjectId],
        );
      } else {
        const source = change === 'source denial';
        await seedResourceDenial(
          f.native.database.pool,
          f.route,
          source ? f.post.id : f.draft.editionId,
          f.author.actor.accountId,
          [source ? 'post:read' : 'edition:read'],
        );
      }
      barrier.release();
      if (change === 'label edit') {
        const result = await value<ContentEditionView>(pending, 200);
        expect(result.identity?.subject).toEqual({
          id: f.targetSubjectId,
          kind: 'available',
          label: { value: 'Current edition label', language: 'en' },
        });
      } else {
        const result = await pending;
        expect(result.status).toBe(404);
        expect(await result.text()).not.toContain('Edition source');
      }
    } finally {
      barrier.release();
      await pending;
      await observer.close();
    }
  }, 60000);
}

test('default exact identity returns the final native post envelope after source visibility changes', async () => {
  const f = await fixture();
  const observer = observeSql(f.native.database.pool);
  const barrier = observer.hold({ statement: readIdentityLabels.sql }, 'after');
  const pending = wire(f.token, `${exactPath(f)}?editionIdentity=true`);
  try {
    await Promise.race([
      barrier.entered,
      pending.then(async (response) => {
        throw new Error(`Expected identity label boundary, received ${response.status}: ${await response.text()}`);
      }),
    ]);
    const changed = await f.native.database.admin.query<{ security_revision: string }>(
      `UPDATE content.post SET visibility='published',security_revision=security_revision+1
       WHERE route=$1 AND post_id=$2 RETURNING security_revision::text`,
      [f.route, f.post.id],
    );
    barrier.release();
    const result = await value<ExactIdentityResponse>(pending, 200);
    expect(result.post.visibility).toBe('published');
    expect(result.post.securityRevision).toBe(changed.rows[0]!.security_revision);
    expect(result.post.revisionId).toBe(f.post.revisionId);
    expect(result.post.sha256).toBe(f.post.sha256);
    expect(result.editionIdentity.sha256).toBe(f.post.sha256);
  } finally {
    barrier.release();
    await pending;
    await observer.close();
  }
}, 60000);
