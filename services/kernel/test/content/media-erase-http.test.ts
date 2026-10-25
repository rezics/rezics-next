import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createContentSystem } from './support/system.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

const databaseUrl = process.env.DATABASE_URL!;
if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated application template');

let system: Awaited<ReturnType<typeof createContentSystem>>;

beforeAll(async () => {
  system = await createContentSystem({ databaseUrl });
});

afterAll(async () => {
  await system?.close();
});

type Credential = (typeof system.actors)['worker'];
type Result = { response: Response; status: number; body: Record<string, unknown> | null };

async function call(
  method: string,
  path: string,
  credential: Credential | null,
  body?: unknown,
  key?: string,
): Promise<Result> {
  const headers = new Headers();
  if (credential) headers.set('authorization', `Bearer ${credential.bearer}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (key !== undefined) headers.set(IDEMPOTENCY_HEADER, JSON.stringify(key));
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { response, status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function seedContainer(route: number, ownerId: string, otherId: string) {
  const boardId = newId(0x9876);
  const threadId = newId(route);
  const boardRoute = routeOf(boardId)!;
  const threadRoute = routeOf(threadId)!;
  await system.database.pool.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,'Media erase fixture','published',1,$3)`,
    [boardRoute, boardId, ownerId],
  );
  await system.database.pool.query(
    `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id)
    VALUES ($1,$2,$3,$4,'Media erase fixture','published',1,$3)`,
    [threadRoute, threadId, ownerId, boardId],
  );
  for (const accountId of [ownerId, otherId])
    await system.database.pool.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
      VALUES ($1,$2,$3,'media:create','(,)',$3)`,
      [threadRoute, threadId, accountId],
    );
  return { boardId, threadId, threadRoute };
}

const sha256 = 'a'.repeat(64);

async function upload(credential: Credential, containerId: string) {
  const reservationKey = crypto.randomUUID();
  const reservation = await call(
    'POST',
    '/v1/media',
    credential,
    { containerId, purpose: 'post-image', mediaType: 'image/png', byteCount: 256, sha256 },
    reservationKey,
  );
  expect(reservation.status).toBe(201);
  const media = reservation.body?.media as { id: string };
  const completed = await call(
    'POST',
    `/v1/media/${media.id}:complete`,
    credential,
    { containerId, reservationRequestId: reservationKey, byteCount: 256, sha256 },
    crypto.randomUUID(),
  );
  expect(completed.status).toBe(200);
  return { id: media.id, reservationKey };
}

async function mediaSnapshot(id: string) {
  const route = routeOf(id)!;
  const [media, partition] = await Promise.all([
    system.database.pool.query(
      `SELECT erased, collection_pending, security_revision::text AS security_revision, state
       FROM content.media WHERE route=$1 AND media_id=$2`,
      [route, id],
    ),
    system.database.pool.query('SELECT position::text AS position FROM core.partition WHERE partition_no=$1', [
      partitionOf(route),
    ]),
  ]);
  return { media: media.rows[0], position: partition.rows[0]?.position };
}

function withoutRequestId(body: Record<string, unknown> | null) {
  if (!body) return null;
  const { request_id: _requestId, ...problem } = body;
  return problem;
}

test.serial('media owner erases through the mounted kernel with current account and collection checks', async () => {
  const owner = system.actors.worker;
  const other = system.actors.otherWorker;
  const route = 0x4312;
  const container = await seedContainer(route, owner.actor.accountId, other.actor.accountId);
  const ownerMedia = await upload(owner, container.threadId);
  const otherMedia = await upload(other, container.threadId);

  const operation = system.kernel.routes.find(
    (candidate) => candidate.method === 'delete' && candidate.path === '/v1/media/:id',
  );
  expect(operation?.hooks.detail?.operationId).toBe('media.erase');
  expect(operation?.hooks.detail?.['x-action']).toBe('media:erase');
  expect(operation?.hooks.detail?.['x-exposure']).toBe('public');

  const beforeOther = await mediaSnapshot(ownerMedia.id);
  expect((await call('DELETE', `/v1/media/${ownerMedia.id}`, other, undefined, crypto.randomUUID())).status).toBe(403);
  expect(await mediaSnapshot(ownerMedia.id)).toEqual(beforeOther);

  const beforeAnonymous = await mediaSnapshot(ownerMedia.id);
  expect((await call('DELETE', `/v1/media/${ownerMedia.id}`, null, undefined, crypto.randomUUID())).status).toBe(401);
  expect(await mediaSnapshot(ownerMedia.id)).toEqual(beforeAnonymous);

  const governanceId = (
    await system.database.pool.query(
      'SELECT account_id FROM access.governance_bootstrap WHERE route=$1 AND resource_id=$2',
      [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id],
    )
  ).rows[0]?.account_id as string;
  const governance = await system.auth.issue({
    accountId: governanceId,
    clientId: system.auth.ordinaryClient.id,
    scopes: ['account:suspend'],
  });
  const suspension = await call(
    'POST',
    `/v1/accounts/${other.actor.accountId}:suspend`,
    governance,
    { reason: 'Media erase suspended-account fixture' },
    crypto.randomUUID(),
  );
  expect(suspension.status).toBe(200);
  const beforeSuspended = await mediaSnapshot(otherMedia.id);
  expect((await call('DELETE', `/v1/media/${otherMedia.id}`, other, undefined, crypto.randomUUID())).status).toBe(401);
  expect(await mediaSnapshot(otherMedia.id)).toEqual(beforeSuspended);

  const pendingMedia = await upload(owner, container.threadId);
  await system.database.pool.query('UPDATE content.media SET collection_pending=true WHERE route=$1 AND media_id=$2', [
    routeOf(pendingMedia.id),
    pendingMedia.id,
  ]);
  const beforePending = await mediaSnapshot(pendingMedia.id);
  expect((await call('DELETE', `/v1/media/${pendingMedia.id}`, owner, undefined, crypto.randomUUID())).status).toBe(
    403,
  );
  expect(await mediaSnapshot(pendingMedia.id)).toEqual(beforePending);

  const key = crypto.randomUUID();
  const erased = await call('DELETE', `/v1/media/${ownerMedia.id}`, owner, undefined, key);
  expect(erased.status).toBe(204);
  expect(erased.response.headers.get(SESSION_HEADER)).toBeString();
  const afterErase = await mediaSnapshot(ownerMedia.id);
  expect(afterErase.media).toEqual({
    erased: true,
    collection_pending: false,
    security_revision: '2',
    state: 'uploaded',
  });
  const replay = await call('DELETE', `/v1/media/${ownerMedia.id}`, owner, undefined, key);
  expect(replay.status).toBe(204);
  expect(replay.body).toBeNull();
  expect(replay.response.headers.get(SESSION_HEADER)).toBe(erased.response.headers.get(SESSION_HEADER));
  expect(await mediaSnapshot(ownerMedia.id)).toEqual(afterErase);

  const erasedRead = await call('GET', `/v1/media/${ownerMedia.id}:authorizeDownload?variant=original`, null);
  const missingRead = await call('GET', `/v1/media/${newId(route)}:authorizeDownload?variant=original`, null);
  expect(erasedRead.status).toBe(404);
  expect(withoutRequestId(erasedRead.body)).toEqual(withoutRequestId(missingRead.body));
});
