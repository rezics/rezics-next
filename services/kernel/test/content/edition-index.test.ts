import { afterEach, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import type { ContentEditionView } from '../../src/content/edition-model.ts';
import { createCreatorEditionIndexEffect, readCreatorEditions, type CreatorEditionPage } from '../../src/content/edition-index.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { partitionOf } from '../../src/route/route.ts';
import { CommandUnavailableError } from '../../src/command/command.ts';
import type { Access } from '../../src/request/access.ts';
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

async function project(f: Awaited<ReturnType<typeof fixture>>, editionId: string) {
  const basis = await f.native.database.pool.query(
    `SELECT w.epoch, w.position FROM content.edition e JOIN editorial.write_basis w
       ON w.partition_no=$1 AND w.transaction_id=e.recorded_transaction_id
     WHERE e.route=$2 AND e.edition_id=$3`,
    [partitionOf(f.route), f.route, editionId],
  );
  const committed = await f.native.database.pool.query<{
    id: string; type: string; subject: string; data: unknown;
  }>(`SELECT id,type,subject,data FROM core.outbox WHERE partition_no=$1 AND position=$2
       AND type='com.rezics.content.edition.created.v1' AND subject=$3`,
    [partitionOf(f.route), basis.rows[0]!.position, editionId]);
  const row = committed.rows[0]!;
  const event: CloudEvent = {
    specversion: '1.0', datacontenttype: 'application/json',
    id: row.id, type: row.type, subject: row.subject, data: row.data,
    time: new Date().toISOString(),
    source: `urn:rezics:log:${partitionOf(f.route)}.${basis.rows[0]!.epoch}`,
    sequence: String(basis.rows[0]!.position).padStart(19, '0'),
  };
  const effect = createCreatorEditionIndexEffect(f.native.database.pool);
  await effect.run(event);
  await effect.run(event);
  return { effect, event };
}

test('Native creator edition inventory for returning to genuine draft and published bindings', async () => {
  const f = await fixture();
  const accountId = f.author.actor.accountId;
  const path = `/v1/accounts/${accountId}/editions`;
  const { effect, event } = await project(f, f.draft.editionId);
  const initial = await value<CreatorEditionPage>(wire(f.token, path), 200);
  expect(initial).toEqual({
    editions: [await value<ContentEditionView>(wire(f.token, `/v1/contentEditions/${f.draft.editionId}`), 200)],
    next: null,
  });
  expect(Object.keys(initial.editions[0]!).sort()).toEqual([
    'creatorAccountId', 'editionId', 'editionRevision', 'licence', 'revisionId', 'sha256', 'state', 'targetSubjectId',
  ]);
  expect((await wire(f.buyer.bearer, path)).status).toBe(404);
  expect((await wire(f.token, `/v1/accounts/${f.buyer.actor.accountId}/editions`)).status).toBe(404);
  expect((await app.handle(new Request(`https://content.test${path}`))).status).toBe(401);
  expect((await wire(f.token, path)).headers.get('cache-control')).toBe('private, no-store');
  await expect(effect.run({ ...event, id: randomUUID() })).rejects.toThrow('Edition creation provenance mismatch');

  // Creation remains the sole authority: the projector accepts a committed event,
  // never client source/rights and never an order or entitlement record.
  const second = await value<{ editionId: string; editionRevision: string }>(wire(f.token, '/v1/contentEditions', 'POST', {
    postId: f.post.id, revisionId: f.post.revisionId, targetSubjectId: f.targetSubjectId,
  }), 201);
  await project(f, second.editionId);
  await value(wire(f.token, `/v1/contentEditions/${second.editionId}:publish`, 'POST', {}, '1'), 200);
  const both = await value<CreatorEditionPage>(wire(f.token, path), 200);
  expect(both.editions.map((edition) => edition.state)).toEqual(['draft', 'published']);
  expect(both.editions[1]).toEqual(await value(wire(f.token, `/v1/contentEditions/${second.editionId}`), 200));

  const firstPage = await value<CreatorEditionPage>(wire(f.token, `${path}?limit=1`), 200);
  expect(firstPage.editions.map((edition) => edition.editionId)).toEqual([f.draft.editionId]);
  expect(firstPage.next).toBeString();
  const continuation = encodeURIComponent(firstPage.next!);
  const secondPage = await value<CreatorEditionPage>(wire(f.token, `${path}?limit=1&cursor=${continuation}`), 200);
  expect(secondPage.editions.map((edition) => edition.editionId)).toEqual([second.editionId]);
  expect((await wire(f.token, `${path}?limit=2&cursor=${continuation}`)).status).toBe(400);
  expect((await wire(f.buyer.bearer, `/v1/accounts/${f.buyer.actor.accountId}/editions?limit=1&cursor=${continuation}`)).status).toBe(400);
  expect((await wire(f.token, `${path}?cursor=forged`)).status).toBe(400);

  // A denied first candidate consumes the examined budget. A full hidden page
  // still offers its signed continuation, without refilling from the next row.
  await seedResourceDenial(f.native.database.pool, f.route, f.draft.editionId, accountId, ['edition:read']);
  const hidden = await value<CreatorEditionPage>(wire(f.token, `${path}?limit=1`), 200);
  expect(hidden.editions).toEqual([]);
  expect(hidden.next).toBeString();
  await value(wire(f.token, `/v1/contentEditions/${second.editionId}:unpublish`, 'POST', {}, '2'), 200);
  const withdrawn = await value<CreatorEditionPage>(wire(f.token, path), 200);
  expect(withdrawn.editions.map((edition) => [edition.editionId, edition.state])).toEqual([[second.editionId, 'withdrawn']]);

  // Refusals introduced between page preparation and final metadata cannot leak.
  let reads = 0;
  const access: Access = {
    authenticate: (...args) => f.native.access.authenticate(...args),
    prepare: async (actor, action, resource, context) => {
      if (action === 'edition:read' && resource.id === second.editionId && ++reads === 2)
        await seedResourceDenial(f.native.database.pool, f.route, second.editionId, accountId, ['edition:read']);
      return f.native.access.prepare?.(actor, action, resource, context);
    },
    authorize: (...args) => f.native.access.authorize(...args),
  };
  const raced = await readCreatorEditions({ pool: f.native.database.pool, access }, f.author.actor,
    { accountId }, { deadline: Date.now() + 10000 });
  expect(reads).toBe(2);
  expect(raced.editions).toEqual([]);
}, 60000);

test('creator inventory preserves current source denial and retryable partition failures', async () => {
  const f = await fixture();
  await project(f, f.draft.editionId);
  const accountId = f.author.actor.accountId;
  const path = `/v1/accounts/${accountId}/editions`;
  await seedResourceDenial(f.native.database.pool, f.route, f.post.id, accountId, ['post:read']);
  expect(await value<CreatorEditionPage>(wire(f.token, path), 200)).toEqual({ editions: [], next: null });
  await f.native.database.pool.query("UPDATE core.partition SET write_state='moved',moved_to='other' WHERE partition_no=$1",
    [partitionOf(f.route)]);
  await expect(readCreatorEditions({ pool: f.native.database.pool, access: f.native.access }, f.author.actor,
    { accountId }, { deadline: Date.now() + 10000 })).rejects.toBeInstanceOf(CommandUnavailableError);
}, 60000);

