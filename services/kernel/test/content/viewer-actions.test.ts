import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { seedGovernanceAuthority } from './support/disclosure-fixtures.ts';
import { createNativeContentSystem, type NativeContentSystem } from './support/native-system.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

let native: NativeContentSystem;
let app: Kernel;
let author: string;
let other: string;
let board: string;
let realm: string;
let thread: { id: string; firstPost: { id: string; revisionId: string } };
let edition: { editionId: string; editionRevision: string };
type Entry = { type: string; id: string; error?: string; viewerActions?: { action: string; operations: string[] }[] };
async function wire(token: string | undefined, path: string, method = 'GET', body?: unknown, version?: string) {
  return app.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(randomUUID()),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(version ? { 'if-match': JSON.stringify(version) } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function value<T>(response: Promise<Response>, status: number): Promise<T> {
  const result = await response;
  const body = await result.json();
  expect({ status: result.status, error: result.status === status ? null : body }).toEqual({ status, error: null });
  return body as T;
}
const reference = (kind: string, id: string) => ({ type: `content.${kind}`, id });
async function actions(token?: string, refs = [reference('post', thread.firstPost.id)]) {
  const response = await wire(token, '/v1/viewerActions', 'POST', { resources: refs });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return value<{ resources: Entry[] }>(Promise.resolve(response), 200).then((body) => body.resources);
}
const operations = (entry: Entry) => entry.viewerActions?.flatMap((action) => action.operations) ?? [];

beforeAll(async () => {
  native = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  await bootstrapRelease(native.database.pool, bundledRelease);
  const consent = createCurrentConsentReader({ database: native.database.authPool });
  app = createKernel({
    pool: native.database.pool,
    access: native.access,
    routeKey: native.routeKey,
    tokens: native.tokenKeys,
    receiptKeys: testReceiptKeys(),
    content: {
      readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
    },
  });
  author = native.actors.author.bearer;
  other = native.actors.other.bearer;
  const scheme = await value<{ subject: { id: string } }>(
    wire(author, '/v1/subjects', 'POST', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Viewer topics' },
    }),
    201,
  );
  const concept = await value<{ subject: { id: string } }>(
    wire(author, '/v1/subjects', 'POST', {
      type: 'skos:Concept',
      labels: { en: 'Viewer source' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
      },
    }),
    201,
  );
  const space = await value<{ space: { spaceId: string } }>(
    wire(author, '/v1/spaces', 'POST', { title: 'Viewer home' }),
    201,
  );
  const created = await value<{ realm: { realmId: string; headRevisionId: string } }>(
    wire(author, '/v1/realms', 'POST', {
      spaceId: space.space.spaceId,
      title: 'Viewer realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    }),
    201,
  );
  realm = created.realm.realmId;
  await value(
    wire(
      author,
      `/v1/realms/${realm}/boardScheme`,
      'PUT',
      { schemeId: scheme.subject.id },
      created.realm.headRevisionId,
    ),
    200,
  );
  board = (
    await value<{ board: { id: string } }>(
      wire(author, `/v1/realms/${realm}/boards`, 'POST', {
        conceptId: concept.subject.id,
        title: 'Viewer board',
        visibility: 'published',
      }),
      201,
    )
  ).board.id;
  thread = (
    await value<{ thread: typeof thread }>(
      wire(author, '/v1/threads', 'POST', {
        title: 'Viewer post',
        body: fromPlainText('An authored edition source'),
        licence: 'CC0-1.0',
        subjectIds: [concept.subject.id],
        boardId: board,
        visibility: 'published',
      }),
      201,
    )
  ).thread;
  edition = await value(
    wire(author, '/v1/contentEditions', 'POST', {
      postId: thread.firstPost.id,
      revisionId: thread.firstPost.revisionId,
      targetSubjectId: concept.subject.id,
    }),
    201,
  );
});
afterAll(async () => {
  await native?.close();
});

test('native author, another account and anonymous see only their permitted mounted Content operations', async () => {
  const refs = [
    reference('board', board),
    reference('thread', thread.id),
    reference('post', thread.firstPost.id),
    reference('edition', edition.editionId),
    reference('post', newId(routeOf(thread.id)!)),
  ];
  const own = await actions(author, refs);
  expect(own.map(({ type, id }) => ({ type, id }))).toEqual(refs);
  expect(operations(own[0]!)).toContain('board.get');
  expect(operations(own[1]!)).toContain('thread.get');
  expect(own[2]!.viewerActions).toContainEqual({
    action: 'post:revise',
    operations: ['content_edition.create', 'post.revise'],
  });
  expect(own[3]!.viewerActions).toContainEqual({ action: 'edition:sell', operations: ['content_edition.publish'] });
  expect(own[4]).toEqual({ ...refs[4]!, error: 'not_found' });
  for (const token of [other, undefined]) {
    const entries = await actions(token, refs);
    expect(operations(entries[2]!)).toContain('post.get');
    expect(operations(entries[2]!)).not.toContain('post.revise');
    expect(operations(entries[2]!)).not.toContain('content_edition.create');
    expect(entries[3]).toEqual({ ...refs[3]!, error: 'not_found' });
  }
  // The advertised owner operation actually publishes the draft on the real kernel.
  await value(
    wire(author, `/v1/contentEditions/${edition.editionId}:publish`, 'POST', {}, edition.editionRevision),
    200,
  );
  expect((await actions(author, [refs[3]!]))[0]!.viewerActions).toContainEqual({
    action: 'edition:sell',
    operations: ['content_edition.publish'],
  });
});

test('explicit native moderator and reader grants offer take-down and report without inventing author authority', async () => {
  await seedGovernanceAuthority(
    native.database.pool,
    routeOf(thread.id)!,
    thread.firstPost.id,
    native.actors.other.actor.accountId,
    ['report:create', 'moderation:takedown'],
  );
  const [entry] = await actions(other);
  expect(operations(entry!)).toContain('report.create');
  expect(operations(entry!)).toContain('post.takedown');
  expect(operations(entry!)).not.toContain('content_edition.create');
});

test('protected containers, taken-down posts, missing ancestors and Realm bans conceal action references', async () => {
  const post = reference('post', thread.firstPost.id);
  const update = (visibility: string) =>
    native.database.pool.query(
      'UPDATE content.board SET visibility=$3,security_revision=security_revision+1 WHERE route=$1 AND board_id=$2',
      [routeOf(board), board, visibility],
    );
  await update('protected');
  try {
    expect((await actions(other))[0]).toEqual({ ...post, error: 'not_found' });
  } finally {
    await update('published');
  }
  await native.database.pool.query("UPDATE content.post SET visibility='taken_down' WHERE route=$1 AND post_id=$2", [
    routeOf(post.id),
    post.id,
  ]);
  try {
    expect((await actions(author))[0]).toEqual({ ...post, error: 'not_found' });
  } finally {
    await native.database.pool.query("UPDATE content.post SET visibility='published' WHERE route=$1 AND post_id=$2", [
      routeOf(post.id),
      post.id,
    ]);
  }
  await native.database.pool.query('UPDATE content.post SET reply_to_post_id=$3 WHERE route=$1 AND post_id=$2', [
    routeOf(post.id),
    post.id,
    newId(routeOf(post.id)!),
  ]);
  try {
    expect((await actions(author))[0]).toEqual({ ...post, error: 'not_found' });
  } finally {
    await native.database.pool.query('UPDATE content.post SET reply_to_post_id=NULL WHERE route=$1 AND post_id=$2', [
      routeOf(post.id),
      post.id,
    ]);
  }
  await native.database.pool.query(
    `INSERT INTO community.realm_ban(route,realm_id,account_id,valid,reason,transaction_id)
     VALUES ($1,$2,$3,tstzrange(transaction_timestamp(),NULL,'[)'),'Viewer ban',$4)`,
    [routeOf(realm), realm, native.actors.author.actor.accountId, newId(routeOf(realm)!)],
  );
  try {
    expect((await actions(author))[0]).toEqual({ ...post, error: 'not_found' });
  } finally {
    await native.database.pool.query(
      'DELETE FROM community.realm_ban WHERE route=$1 AND realm_id=$2 AND account_id=$3',
      [routeOf(realm), realm, native.actors.author.actor.accountId],
    );
  }
});

test('101 references are rejected before any positive answer', async () => {
  await value(
    wire(author, '/v1/viewerActions', 'POST', {
      resources: Array.from({ length: 101 }, () => reference('post', newId(routeOf(thread.id)!))),
    }),
    400,
  );
});
