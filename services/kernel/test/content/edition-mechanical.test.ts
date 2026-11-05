import { afterEach, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  readContentEditionSaleAuthority,
  readContentEditionMechanicalSaleAuthority,
} from '../../src/content/edition-sale.ts';
import { AccessUnavailableError } from '../../src/request/unavailable.ts';
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
  return { native, author, buyer, token, thread, post, route, draft, body, targetSubjectId: concept.subject.id };
}

test('mechanical edition eligibility restores the native publisher without inventing a buyer or bypassing caller reads', async () => {
  const f = await fixture();
  const id = f.draft.editionId;
  const base = `/v1/contentEditions/${id}`;
  const deps = { pool: f.native.database.pool, access: f.native.access };
  const mechanical = () => readContentEditionMechanicalSaleAuthority(deps, id, { deadline: Date.now() + 10000 });
  expect(await mechanical()).toBeNull();
  await value(wire(f.token, `${base}:publish`, 'POST', {}, '1'), 200);
  const authority = await mechanical();
  expect(authority).toEqual({
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
  // Eligibility itself neither grants this real buyer edition access nor reads its bytes.
  expect((await wire(f.buyer.bearer, `${base}/revision`)).status).toBe(404);
  await seedGovernanceAuthority(f.native.database.pool, f.route, id, f.buyer.actor.accountId, ['edition:read']);
  expect(await value(wire(f.buyer.bearer, base), 200)).toEqual({
    editionId: id,
    editionRevision: '2',
    state: 'published',
    targetSubjectId: f.targetSubjectId,
    creatorAccountId: f.author.actor.accountId,
    revisionId: f.post.revisionId,
    sha256: f.post.sha256,
    licence: 'CC0-1.0',
  });
  expect(await value(wire(f.buyer.bearer, `${base}/revision`), 200)).toEqual({
    editionId: id,
    revisionId: f.post.revisionId,
    sha256: f.post.sha256,
    licence: 'CC0-1.0',
    body: f.body,
  });
  expect((await wire(f.buyer.bearer, `/v1/posts/${f.post.id}`)).status).toBe(404);
  await seedResourceDenial(f.native.database.pool, f.route, f.thread.id, f.buyer.actor.accountId, ['thread:read']);
  expect(await mechanical()).toEqual(authority);
  expect(
    await readContentEditionSaleAuthority(deps, id, { actor: f.buyer.actor, deadline: Date.now() + 10000 }),
  ).toBeNull();
  expect(
    (
      await wire(f.buyer.bearer, `${base}/revision`, 'GET', undefined, undefined, randomUUID(), {
        'if-none-match': '*',
      })
    ).status,
  ).toBe(404);
  // A source read is an independent restored action, never reused post:revise evidence.
  await seedResourceDenial(f.native.database.pool, f.route, f.post.id, f.author.actor.accountId, ['post:read']);
  await expect(mechanical()).rejects.toBeInstanceOf(AccessUnavailableError);
});

test('mechanical edition eligibility preserves immutable subject association and refuses removed native source', async () => {
  const f = await fixture();
  const id = f.draft.editionId;
  const base = `/v1/contentEditions/${id}`;
  const deps = { pool: f.native.database.pool, access: f.native.access };
  const mechanical = () => readContentEditionMechanicalSaleAuthority(deps, id, { deadline: Date.now() + 10000 });
  await value(wire(f.token, `${base}:publish`, 'POST', {}, '1'), 200);
  const authority = await mechanical();
  expect(authority?.targetSubjectId).toBe(f.targetSubjectId);
  await value(
    wire(
      f.token,
      `/v1/posts/${f.post.id}/revisions`,
      'POST',
      { body: fromPlainText('A new head cannot reassociate the pinned source'), subjectIds: [] },
      f.post.revisionId,
    ),
    201,
  );
  expect(await mechanical()).toEqual(authority);
  await value(wire(f.token, `/v1/posts/${f.post.id}`, 'DELETE'), 200);
  expect(await mechanical()).toBeNull();
  expect(
    (await wire(f.token, `${base}/revision`, 'GET', undefined, undefined, randomUUID(), { 'if-none-match': '*' }))
      .status,
  ).toBe(404);
});
