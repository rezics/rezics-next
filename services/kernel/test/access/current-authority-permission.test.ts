import { afterEach, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { createKernel, createKernelAccessResolver } from '../../src/http/kernel.ts';
import { readContentEditionMechanicalSaleAuthority } from '../../src/content/edition-sale.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { ACCESS_WORK_AXES } from '../../src/access/work.ts';
import {
  createNativeContentSystem,
  nativeOperator,
  type NativeContentSystem,
} from '../content/support/native-system.ts';
import { seedGovernanceAuthority } from '../content/support/disclosure-fixtures.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { currentAuthorityOperands, startCurrentAuthorityWorker } from './support/current-authority-worker.ts';

let native: NativeContentSystem | undefined;
let worker: Awaited<ReturnType<typeof startCurrentAuthorityWorker>> | undefined;
let relay: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => {
  try {
    await worker?.close();
  } finally {
    worker = undefined;
    relay?.stop(true);
    relay = undefined;
    await native?.close();
    native = undefined;
  }
});

test('native parent and isolated worker retain current board sale authority and observe ordinary grant revocation and bans', async () => {
  native = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  const system = native;
  const pool = system.database.pool;
  await bootstrapRelease(pool, bundledRelease);
  const consent = createCurrentConsentReader({ database: system.database.authPool });
  const readConsent = ({ actorAccountId, clientId }: { actorAccountId: string; clientId: string }) =>
    consent.readCurrentConsent({ actorAccountId, clientId });
  const app = createKernel({
    pool,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
    receiptKeys: testReceiptKeys(),
    access: system.access,
    content: { readConsent },
  });
  const author = system.actors.author;
  const reader = system.actors.other;
  async function call(bearer: string, path: string, method = 'GET', body?: unknown, version?: string) {
    const response = await app.handle(
      new Request(`https://content.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(crypto.randomUUID()),
          ...(version ? { 'if-match': JSON.stringify(version) } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await response.text() };
  }
  async function value<T>(pending: ReturnType<typeof call>, status: number): Promise<T> {
    const response = await pending;
    expect({ status: response.status, error: response.status === status ? null : response.body }).toEqual({
      status,
      error: null,
    });
    return JSON.parse(response.body) as T;
  }
  const scheme = await value<{ subject: { id: string } }>(
    call(author.bearer, '/v1/subjects', 'POST', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Current authority' },
    }),
    201,
  );
  const concept = await value<{ subject: { id: string } }>(
    call(author.bearer, '/v1/subjects', 'POST', {
      type: 'skos:Concept',
      labels: { en: 'Native source' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
      },
    }),
    201,
  );
  const space = await value<{ space: { spaceId: string } }>(
    call(author.bearer, '/v1/spaces', 'POST', {
      title: 'Authority home',
    }),
    201,
  );
  const realm = await value<{ realm: { realmId: string; headRevisionId: string } }>(
    call(author.bearer, '/v1/realms', 'POST', {
      spaceId: space.space.spaceId,
      title: 'Authority Realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    }),
    201,
  );
  const realmId = realm.realm.realmId;
  await value(
    call(
      author.bearer,
      `/v1/realms/${realmId}/boardScheme`,
      'PUT',
      {
        schemeId: scheme.subject.id,
      },
      realm.realm.headRevisionId,
    ),
    200,
  );
  const board = await value<{ board: { id: string } }>(
    call(author.bearer, `/v1/realms/${realmId}/boards`, 'POST', {
      conceptId: concept.subject.id,
      title: 'Protected authority board',
      visibility: 'protected',
    }),
    201,
  );
  const boardId = board.board.id;
  const resource = { route: routeOf(boardId)!, id: boardId };
  const created = await value<{
    thread: { id: string; firstPost: { id: string; revisionId: string; sha256: string } };
  }>(
    call(author.bearer, '/v1/threads', 'POST', {
      title: 'Native sale source',
      body: fromPlainText('A genuinely authored source'),
      licence: 'CC0-1.0',
      subjectIds: [concept.subject.id],
      boardId,
      visibility: 'protected',
    }),
    201,
  );
  const post = created.thread.firstPost;
  const edition = await value<{ editionId: string }>(
    call(author.bearer, '/v1/contentEditions', 'POST', {
      postId: post.id,
      revisionId: post.revisionId,
      targetSubjectId: concept.subject.id,
    }),
    201,
  );
  await value(call(author.bearer, `/v1/contentEditions/${edition.editionId}:publish`, 'POST', {}, '1'), 200);

  const issuer = system.nativeAuth.verifier.issuer;
  relay = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => system.nativeAuth.handler(new Request(`${issuer}${new URL(request.url).pathname}`, request)),
  });
  worker = await startCurrentAuthorityWorker({
    databaseUrl: pool.options.connectionString!,
    authDatabaseUrl: system.database.authPool.options.connectionString!,
    routeKey: Buffer.from(system.routeKey).toString('base64url'),
    referenceKeys: {
      current: system.tokenKeys.current,
      keys: [...system.tokenKeys.keys].map(([id, key]) => [id, Buffer.from(key).toString('base64url')]),
    },
    issuer,
    audience: system.nativeAuth.verifier.audience,
    authRelay: `http://127.0.0.1:${relay.port}`,
  });
  const child = worker;
  const dependencies = { pool, access: system.access, readConsent, clock: () => new Date() };
  const sale = await readContentEditionMechanicalSaleAuthority(dependencies, edition.editionId, {
    deadline: Date.now() + 10_000,
  });
  expect(sale?.creatorAccountId).toBe(author.actor.accountId);
  expect(sale?.source.postId).toBe(post.id);
  const childSale = await child.send({ kind: 'sale', editionId: edition.editionId });
  expect(JSON.parse(childSale.body)).toEqual(sale);

  // Bootstrap only the grantor's authority. Every mutation below is an ordinary
  // authenticated grant command, and both compositions read the resulting rows.
  const grantor = nativeOperator(system);
  await seedGovernanceAuthority(pool, resource.route, boardId, grantor.actor.accountId, ['access:grant', 'board:read']);
  const grant = {
    resource,
    subject: { kind: 'account', id: reader.actor.accountId },
    actions: ['board:read'],
    valid: '(,)',
  };
  async function readable(status: number) {
    const parent = await call(reader.bearer, `/v1/boards/${boardId}`);
    const isolated = await child.send({
      kind: 'http',
      url: `https://content.test/v1/boards/${boardId}`,
      method: 'GET',
      headers: [['authorization', `Bearer ${reader.bearer}`]],
    });
    expect({ parent: parent.status, child: isolated.status }).toEqual({ parent: status, child: status });
  }
  await readable(404);
  await value(call(grantor.bearer, '/v1/grants', 'POST', grant), 201);
  await readable(200);
  await value(call(grantor.bearer, '/v1/grants:revoke', 'POST', grant), 200);
  await readable(404);
  await value(call(grantor.bearer, '/v1/grants', 'POST', grant), 201);
  await readable(200);
  await value(
    call(author.bearer, `/v1/realms/${realmId}/bans/${reader.actor.accountId}`, 'PUT', { reason: 'Current ban' }),
    200,
  );
  await readable(404);
  expect(
    await pool
      .query('SELECT 1 FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4', [
        resource.route,
        boardId,
        reader.actor.accountId,
        'board:read',
      ])
      .then((result) => result.rowCount),
  ).toBe(1);
  expect(
    await readContentEditionMechanicalSaleAuthority(dependencies, edition.editionId, { deadline: Date.now() + 10_000 }),
  ).toEqual(sale);
  expect(JSON.parse((await child.send({ kind: 'sale', editionId: edition.editionId })).body)).toEqual(sale);
  const operands = await currentAuthorityOperands(pool, system.access, author.bearer, resource);
  const isolatedOperands = JSON.parse((await child.send({ kind: 'operands', bearer: author.bearer, resource })).body);
  expect(isolatedOperands).toEqual(operands);
  expect(operands.roles.find(([role]) => role === 'content.board.owner')?.[1]).toContain('board:read');
  expect(
    operands.grants.some(
      (row) => row.subject_id === author.actor.accountId && row.grant_role === 'content.board.owner',
    ),
  ).toBe(true);

  // The lazy Kernel projection must carry the native owner's exact work object,
  // context and result. A proxy that forwards only the callable fails here.
  const composition = createKernelAccessResolver({
    pool,
    tokens: system.tokenKeys,
    clock: () => new Date(),
    access: system.access,
  });
  composition.resolveAccess({ actions: system.actions });
  const roles = composition.realmRoleReader;
  const input = { realmId, accountId: reader.actor.accountId, at: new Date().toISOString() };
  const bound = roles.work!.bound(input)!;
  const result = await roles(pool, input);
  const actual = roles.work!.actual(input, result)!;
  for (const axis of ACCESS_WORK_AXES) expect(actual[axis]).toBeLessThanOrEqual(bound[axis]);
  expect(actual.points).toBeGreaterThan(0);
  expect(roles.work!.actual(input, result)).toBeUndefined();
  const batchInput = { pairs: [{ realmId, accountId: reader.actor.accountId }], at: new Date().toISOString() };
  const batchBound = roles.batchWork!.bound(batchInput)!;
  const batchResult = await roles.batch!(pool, batchInput);
  const batchActual = roles.batchWork!.actual(batchInput, batchResult)!;
  for (const axis of ACCESS_WORK_AXES) expect(batchActual[axis]).toBeLessThanOrEqual(batchBound[axis]);
  expect(batchActual.points).toBeGreaterThan(0);
  expect(roles.batchWork!.actual(batchInput, batchResult)).toBeUndefined();
}, 120_000);
