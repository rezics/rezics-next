import canonicalize from 'canonicalize';
import { fromPlainText, normalizeDocument, type DocumentSnapshot } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createImageJob } from '../../src/content/image-job.ts';
import { threadTarget } from '../../src/content/commands.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { IDEMPOTENCY_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { Resource } from '../../src/request/access.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  createContentSystem,
  contentGovernanceCredential,
  type ContentCredential,
  type ContentSystem,
} from './support/system.ts';
import { createMediaStorage } from './support/storage.ts';
import { imageSource } from './support/media-fixtures.ts';

export type ContentItem = {
  readonly id: string;
  readonly revisionId: string;
  readonly route?: number;
  readonly threadId?: string;
  readonly parentId?: string | null;
  readonly body?: unknown;
  readonly licence?: string;
  readonly subjectIds?: readonly string[];
  readonly mediaIds?: readonly string[];
};

export type ContentThread = {
  readonly id: string;
  readonly route: number;
  readonly boardId: string;
  readonly firstPost: ContentItem;
};

export type ContentBoard = {
  readonly id: string;
  readonly route: number;
  readonly visibility: string;
  readonly purpose: string;
};

export type CallResult<T extends object = Record<string, unknown>> = {
  readonly response: Response;
  readonly body: T;
};

export type ThreadAtomicityWorld = {
  readonly system: ContentSystem;
  readonly kernel: ReturnType<typeof createKernel>;
  readonly governance: ContentCredential;
  readonly conceptId: string;
  readonly board: ContentBoard;
  readonly thread: ContentThread;
  readonly reply: ContentItem;
};

export type StoredMedia = {
  readonly id: string;
  readonly key: string;
  readonly containerId: string;
  readonly reservationRequestId: string;
  readonly uploaderId: string;
  readonly route: number;
};

export function createAtomicityKernel(system: ContentSystem, pool: Pool = system.database.pool) {
  return createKernel({
    requestDeadlineMs: 30_000,
    pool,
    routeKey: system.routeKey,
    tokens: system.tokenKeys,
    access: () => system.access,
    content: { cursorNow: () => Date.now() },
    writeRate: createWriteRateLimiter({
      secret: randomUUID() + randomUUID(),
      overrides: JSON.stringify({
        'new-account': {
          write: { maximum: 100_000, seconds: 86_400 },
          upload: { maximum: 100_000, seconds: 86_400 },
        },
      }),
    }),
    ratePeer: () => '127.0.0.1',
  });
}

export async function createThreadAtomicityWorld(namespace: string): Promise<ThreadAtomicityWorld> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must name a migrated application template');
  const system = await createContentSystem({ databaseUrl, namespace });
  try {
    const kernel = createAtomicityKernel(system);
    await bootstrapRelease(system.database.pool, bundledRelease);
    const governance = await contentGovernanceCredential(system);

    // Global board creation is delegated by governance. The test contract permits
    // fixture grants; board, thread and post content below still use HTTP commands.
    await system.database.pool.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
       VALUES (0,$1,$2,'board:create','(,)'::tstzrange,$3)
       ON CONFLICT DO NOTHING`,
      [GLOBAL_CONTEXT, governance.actor.accountId, newId(0)],
    );

    const concept = await call<SubjectResponse>(kernel, system.actors.author, 'POST', '/v1/subjects', {
      type: 'skos:Concept',
      labels: { en: `Atomic thread subject ${namespace}` },
    });
    requireStatus(concept, 201, 'create fixture concept');
    const conceptId = concept.body.subject.id;

    const board = await createGlobalBoard(system, kernel, governance, system.actors.author, conceptId, {
      title: `Atomicity public board ${namespace}`,
      visibility: 'published',
    });
    const threadKey = routeIndependentThreadKey(system, system.actors.author.actor.accountId, board.route, namespace);
    const threadResult = await call<ThreadResponse>(
      kernel,
      system.actors.author,
      'POST',
      '/v1/threads',
      {
        title: `Atomicity public thread ${namespace}`,
        body: fromPlainText(`Opening post for ${namespace}: 測試內容`),
        licence: 'CC-BY-4.0',
        subjectIds: [conceptId],
        boardId: board.id,
        visibility: 'published',
      },
      threadKey,
    );
    requireStatus(threadResult, 201, 'create fixture thread');
    const thread = threadResult.body.thread;
    if (thread.route === board.route) throw new Error('Fixture thread and board must use different routes');

    const replyResult = await createReply(system, kernel, system.actors.author, thread, {
      body: fromPlainText(`Existing reply for ${namespace}: 日本語の本文`),
      licence: 'MIT',
      subjectIds: [conceptId],
      parentId: thread.firstPost.id,
    });
    return { system, kernel, governance, conceptId, board, thread, reply: replyResult };
  } catch (error) {
    await system.close();
    throw error;
  }
}

type SubjectResponse = { readonly subject: { readonly id: string } };
type BoardResponse = { readonly board: ContentBoard };
type ThreadResponse = { readonly thread: ContentThread };
type PostResponse = { readonly post: ContentItem };

export async function createGlobalBoard(
  system: ContentSystem,
  kernel: ReturnType<typeof createKernel>,
  governance: ContentCredential,
  creator: ContentCredential,
  conceptId: string,
  input: { readonly title: string; readonly visibility: 'published' | 'protected' },
): Promise<ContentBoard> {
  await grantByHttp(kernel, governance, GLOBAL_CONTEXT_RESOURCE, creator.actor.accountId, ['board:create']);
  const created = await call<BoardResponse>(kernel, creator, 'POST', '/v1/boards', {
    conceptId,
    title: input.title,
    purpose: 'discussion',
    visibility: input.visibility,
  });
  requireStatus(created, 201, 'create fixture board');
  const board = created.body.board;
  await fixtureGrant(system, { route: board.route, id: board.id }, creator.actor.accountId, [
    'board:read',
    'thread:create',
  ]);
  return board;
}

export const GLOBAL_CONTEXT_RESOURCE: Resource = Object.freeze({ route: 0, id: GLOBAL_CONTEXT });

export async function createReply(
  _system: ContentSystem,
  kernel: ReturnType<typeof createKernel>,
  author: ContentCredential,
  thread: ContentThread,
  body: {
    readonly body: unknown;
    readonly licence: string;
    readonly subjectIds: readonly string[];
    readonly parentId?: string;
  },
): Promise<ContentItem> {
  const created = await call<PostResponse>(kernel, author, 'POST', `/v1/threads/${thread.id}/posts`, {
    body: body.body,
    licence: body.licence,
    subjectIds: [...body.subjectIds],
    boardId: thread.boardId,
    ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
  });
  requireStatus(created, 201, 'create fixture reply');
  return created.body.post;
}

export async function createSameRouteThread(
  system: ContentSystem,
  kernel: ReturnType<typeof createKernel>,
  author: ContentCredential,
  board: ContentBoard,
  conceptId: string,
  desiredRoute: number,
  namespace: string,
): Promise<ContentThread> {
  const key = routeIndependentThreadKey(system, author.actor.accountId, board.route, namespace, desiredRoute);
  const created = await call<ThreadResponse>(
    kernel,
    author,
    'POST',
    '/v1/threads',
    {
      title: `Unrelated growth thread ${namespace}`,
      body: fromPlainText(`Unrelated growth anchor: ${namespace} 東京`),
      licence: 'MIT',
      subjectIds: [conceptId],
      boardId: board.id,
      visibility: 'published',
    },
    key,
  );
  requireStatus(created, 201, 'create unrelated same-route growth thread');
  const thread = created.body.thread;
  if (thread.route !== desiredRoute) throw new Error('Growth thread did not use its selected fixture route');
  return thread;
}

export async function grantByHttp(
  kernel: ReturnType<typeof createKernel>,
  governance: ContentCredential,
  resource: Resource,
  accountId: string,
  actions: readonly string[],
): Promise<void> {
  const result = await call(kernel, governance, 'POST', '/v1/grants', {
    resource,
    subject: { kind: 'account', id: accountId },
    actions: [...actions],
    valid: '(,)',
  });
  requireStatus(result, 201, `grant ${actions.join(',')}`);
}

export async function fixtureGrant(
  system: ContentSystem,
  resource: Resource,
  accountId: string,
  actions: readonly string[],
): Promise<void> {
  await system.database.pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     SELECT $1,$2,$3,action,'(,)'::tstzrange,$4 FROM unnest($5::text[]) AS action`,
    [resource.route, resource.id, accountId, newId(resource.route), [...actions]],
  );
}

export async function revokeFixtureGrant(
  system: ContentSystem,
  resource: Resource,
  accountId: string,
  actions: readonly string[],
): Promise<void> {
  const result = await system.database.pool.query(
    `DELETE FROM access.resource_grant
     WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=ANY($4::text[])
       AND valid='(,)'::tstzrange`,
    [resource.route, resource.id, accountId, [...actions]],
  );
  if (result.rowCount !== actions.length)
    throw new Error(`Fixture grant revocation removed ${result.rowCount ?? 0} of ${actions.length} actions`);
}

export async function call<T extends object = Record<string, unknown>>(
  kernel: ReturnType<typeof createKernel>,
  actor: ContentCredential | null,
  method: string,
  path: string,
  body?: unknown,
  key: string = randomUUID(),
  headers: Readonly<Record<string, string>> = {},
): Promise<CallResult<T>> {
  const requestHeaders = new Headers(headers);
  if (actor) requestHeaders.set('authorization', `Bearer ${actor.bearer}`);
  if (body !== undefined) requestHeaders.set('content-type', 'application/json');
  requestHeaders.set(IDEMPOTENCY_HEADER, JSON.stringify(key));
  const response = await kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const wire = await response.text();
  return {
    response,
    body: (wire ? JSON.parse(wire) : {}) as T,
  };
}

export function requireStatus(result: CallResult, expected: number, action: string): void {
  if (result.response.status !== expected)
    throw new Error(`${action} failed (${result.response.status}): ${JSON.stringify(result.body)}`);
}

function routeIndependentThreadKey(
  system: ContentSystem,
  accountId: string,
  boardRoute: number,
  namespace: string,
  desiredRoute?: number,
) {
  for (let index = 0; index < 100_000; index++) {
    const key = `${namespace}-thread-${index}-${randomUUID()}`;
    const route = threadTarget(system.routeKey, accountId, key).route;
    if (route !== boardRoute && (desiredRoute === undefined || route === desiredRoute)) return key;
  }
  throw new Error('Could not derive a thread route independent of the board route');
}

export async function reserveAvailableImage(
  system: ContentSystem,
  kernel: ReturnType<typeof createKernel>,
  uploader: ContentCredential,
  completer: ContentCredential,
  containerId: string,
  storage: ReturnType<typeof createMediaStorage>,
): Promise<StoredMedia> {
  const source = await imageSource('tiny');
  const reserved = await call<MediaResponse>(kernel, uploader, 'POST', '/v1/media', {
    containerId,
    purpose: 'post-image',
    mediaType: source.type,
    byteCount: source.bytes.length,
    sha256: source.sha256,
  });
  requireStatus(reserved, 201, 'reserve fixture image');
  const reservedMedia = reserved.body.media;
  const route = routeOf(reservedMedia.id);
  if (route === null) throw new Error('Production media reservation returned a non-routable media ID');
  const media: StoredMedia = { ...reservedMedia, route };
  await storage.storage.put(media.key, source.bytes, { mediaType: source.type });
  const completed = await call<CompletionResponse>(kernel, completer, 'POST', `/v1/media/${media.id}:complete`, {
    containerId,
    reservationRequestId: media.reservationRequestId,
    byteCount: source.bytes.length,
    sha256: source.sha256,
  });
  requireStatus(completed, 200, 'complete fixture image');
  const outcome = await createImageJob(system.database.pool, storage.storage).process(media.id);
  if (outcome.state !== 'available') throw new Error(`Fixture image processing ended in ${outcome.state}`);
  const stored = await system.database.pool.query<{ state: string; claimed_at: Date | null }>(
    'SELECT state,claimed_at FROM content.media WHERE route=$1 AND media_id=$2',
    [media.route, media.id],
  );
  if (stored.rows[0]?.state !== 'available' || stored.rows[0].claimed_at !== null)
    throw new Error(
      `Fixture image is not available and unclaimed after the production image job: ${JSON.stringify({
        mediaId: media.id,
        route: media.route,
        outcome: outcome.state,
        stored: stored.rows[0] ?? null,
      })}`,
    );
  return media;
}

type MediaResponse = { readonly media: Omit<StoredMedia, 'route'> };
type CompletionResponse = { readonly media: { readonly id: string; readonly state: string } };

export function documentBytes(body: DocumentSnapshot): {
  readonly body: DocumentSnapshot;
  readonly bytes: Buffer;
  readonly sha256: Buffer;
} {
  const normalized = normalizeDocument(body);
  const canonical = canonicalize(normalized);
  if (canonical === undefined) throw new TypeError('Document cannot be canonicalized as RFC 8785 JSON');
  const bytes = Buffer.from(canonical, 'utf8');
  return { body: normalized, bytes, sha256: createHash('sha256').update(bytes).digest() };
}

export function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value)
    .reverse()
    .map(([key, item]) => [key, reverseObjectKeys(item)] as const);
  return Object.fromEntries(entries);
}
