import type { CrossMediaSeedResult } from '../../services/importer/src/cross-media-seed.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RESPONSE_LIMIT = 1_048_576;
const DIRECTORY_PAGE_LIMIT = 100;
const DIRECTORY_PAGE_CAP = 1_000;

/** OAuth scopes requested only by the local showcase client, never its importer client. */
export const DEVELOPMENT_SHOWCASE_SCOPES = [
  'board:create',
  'board:read',
  'subject:read',
  'thread:create',
  'post:read',
  'post:revise',
  'edition:read',
  'edition:sell',
  'offer:create',
  'offer:list',
  'gate:selling',
] as const;

export type DevelopmentSeedActor = Readonly<{ accountId: string; clientId: string }>;
export type DevelopmentSeedCredential = Readonly<{ keyId: string }>;
export type DevelopmentSeedFailureState = 'missing_source' | 'refused' | 'unknown_delivery' | 'unavailable';
export type DevelopmentSeedFailure = Readonly<{
  state: DevelopmentSeedFailureState;
  operation: string;
  code?: string;
}>;
export type DevelopmentSeedStep<T> = Readonly<{ state: 'acknowledged'; value: T }> | DevelopmentSeedFailure;

export type DevelopmentCommandIntent = Readonly<{
  actionKey: string;
  idempotencyKey: string;
  method: 'POST';
  path: string;
  body: unknown;
  ifMatch?: string;
}>;

export type DevelopmentSeedJournal = {
  prepareAction(actionKey: string, body: unknown, idempotencyKey: string): unknown;
  action(actionKey: string): { idempotency_key: string } | null;
  acknowledgeAction(actionKey: string): void;
  refuseAction(actionKey: string, errorCode: string): void;
};

export type DevelopmentShowcaseClient = {
  read(path: string, options?: { anonymous?: boolean }): Promise<DevelopmentSeedStep<unknown>>;
  command<T>(intent: DevelopmentCommandIntent, decode: (value: unknown, frozenBody: unknown) => T): Promise<DevelopmentSeedStep<T>>;
};

type RequestOptions = {
  origin: string;
  actor: DevelopmentSeedActor;
  credential: DevelopmentSeedCredential;
  tokenProvider: () => Promise<string>;
  journal: DevelopmentSeedJournal;
  fetch?: typeof fetch;
};

type NativeHttpResult =
  | { state: 'received'; value: unknown }
  | { state: 'missing' }
  | { state: 'refused'; code: string }
  | { state: 'unknown_delivery'; code: string }
  | { state: 'unavailable'; code: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body) throw new TypeError('Native response has no body');
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (item.value.byteLength > RESPONSE_LIMIT - size) throw new TypeError('Native response exceeds its byte limit');
      chunks.push(item.value);
      size += item.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally {
    reader.releaseLock();
  }
}

type NativeRequestInput =
  | { anonymous?: boolean; bodyJson?: never; idempotencyKey?: never; ifMatch?: never }
  | { anonymous?: never; bodyJson: string; idempotencyKey: string; ifMatch?: string };

function sameIntent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Authenticated native writes use the developer's separate, narrowly scoped showcase client. */
export function createDevelopmentShowcaseClient(options: RequestOptions): DevelopmentShowcaseClient {
  const fetcher = options.fetch ?? globalThis.fetch;

  async function request(
    method: 'GET' | 'POST',
    path: string,
    input: NativeRequestInput = {},
  ): Promise<NativeHttpResult> {
    const headers = new Headers({ accept: 'application/json' });
    if (!input.anonymous) headers.set('authorization', `Bearer ${await options.tokenProvider()}`);
    if (input.bodyJson !== undefined) {
      headers.set('content-type', 'application/json');
      headers.set('idempotency-key', JSON.stringify(input.idempotencyKey));
      if (input.ifMatch !== undefined) headers.set('if-match', input.ifMatch);
    }
    const url = new URL(path, options.origin);
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        headers,
        ...(input.bodyJson === undefined ? {} : { body: input.bodyJson }),
        redirect: 'error',
        cache: 'no-store',
      });
    } catch {
      return method === 'POST'
        ? { state: 'unknown_delivery', code: 'transport-unknown' }
        : { state: 'unavailable', code: 'transport-unavailable' };
    }
    if (response.status === 404) return { state: 'missing' };
    if (response.status === 401 || response.status === 403)
      return { state: 'refused', code: `http-${response.status}` };
    if (response.status >= 500)
      return method === 'POST'
        ? { state: 'unknown_delivery', code: `http-${response.status}` }
        : { state: 'unavailable', code: `http-${response.status}` };
    if (!response.ok) return { state: 'refused', code: `http-${response.status}` };
    try {
      return { state: 'received', value: await responseJson(response) };
    } catch {
      return method === 'POST'
        ? { state: 'unknown_delivery', code: 'response-unknown' }
        : { state: 'unavailable', code: 'response-unavailable' };
    }
  }

  return {
    async read(path, input = {}) {
      const result = await request('GET', path, input);
      if (result.state === 'received') return { state: 'acknowledged', value: result.value };
      if (result.state === 'missing') return { state: 'missing_source', operation: path, code: 'http-404' };
      return { state: result.state, operation: path, code: result.code };
    },
    async command<T>(intent, decode) {
      const sealed = {
        actor: options.actor,
        credential: options.credential,
        method: intent.method,
        path: intent.path,
        bodyJson: JSON.stringify(intent.body),
        ...(intent.ifMatch === undefined ? {} : { ifMatch: intent.ifMatch }),
      };
      const stored = options.journal.prepareAction(intent.actionKey, sealed, intent.idempotencyKey);
      const journalled = options.journal.action(intent.actionKey);
      const frozen = record(stored);
      if (
        !journalled ||
        !journalled.idempotency_key ||
        !frozen ||
        !sameIntent(frozen.actor, options.actor) ||
        !sameIntent(frozen.credential, options.credential) ||
        frozen.method !== intent.method ||
        frozen.path !== intent.path ||
        typeof frozen.bodyJson !== 'string' ||
        (frozen.ifMatch !== undefined && typeof frozen.ifMatch !== 'string')
      )
        return { state: 'unavailable', operation: intent.path, code: 'sealed-intent-identity-changed' };
      const frozenBody: unknown = JSON.parse(frozen.bodyJson);
      const ifMatch = typeof frozen.ifMatch === 'string' ? frozen.ifMatch : undefined;

      const result = await request('POST', intent.path, {
        bodyJson: frozen.bodyJson,
        idempotencyKey: journalled.idempotency_key,
        ...(ifMatch === undefined ? {} : { ifMatch }),
      });
      if (result.state === 'missing') {
        options.journal.refuseAction(intent.actionKey, 'native-http-404');
        return { state: 'missing_source', operation: intent.path, code: 'http-404' };
      }
      if (result.state === 'refused') {
        options.journal.refuseAction(intent.actionKey, `native-${result.code}`);
        return { state: 'refused', operation: intent.path, code: result.code };
      }
      if (result.state === 'unknown_delivery')
        return { state: 'unknown_delivery', operation: intent.path, code: result.code };
      if (result.state === 'unavailable') return { state: 'unavailable', operation: intent.path, code: result.code };
      let value: T;
      try {
        value = decode(result.value, frozenBody);
      } catch {
        return { state: 'unknown_delivery', operation: intent.path, code: 'response-unknown' };
      }
      options.journal.acknowledgeAction(intent.actionKey);
      return { state: 'acknowledged', value };
    },
  };
}

function selectedWorkSubject(result: Pick<CrossMediaSeedResult, 'readings' | 'workLinks'>): string | undefined {
  const externalId = 'v2002';
  const reading = result.readings.find(
    (entry) => entry.source === 'vndb' && entry.externalId === externalId && entry.selection === 'selected',
  );
  const readingSubject = (reading?.subject as { subject?: { id?: unknown } } | undefined)?.subject?.id;
  const handoff = result.workLinks.find(
    (entry) => entry.source.provider === 'vndb' && entry.source.externalId === externalId,
  );
  if (typeof readingSubject !== 'string' || !UUID.test(readingSubject) || typeof reading?.route !== 'string') return undefined;
  if (
    handoff &&
    (handoff.source.subject?.subjectId !== readingSubject || handoff.source.subject.route !== reading.route)
  )
    return undefined;
  return readingSubject;
}

function boardFromResponse(value: unknown, expectedTitle: string): { boardId: string } {
  const board = record(record(value)?.board);
  if (
    !board ||
    typeof board.id !== 'string' ||
    !UUID.test(board.id) ||
    board.realmId !== null ||
    board.title !== expectedTitle ||
    board.purpose !== 'discussion' ||
    board.visibility !== 'published' ||
    board.availability !== 'available'
  )
    throw new TypeError('Native Board create response did not acknowledge a published Global discussion Board');
  return { boardId: board.id };
}

function directoryPage(value: unknown): { boards: Record<string, unknown>[]; next: string | null } {
  const page = record(value);
  if (!page || !Array.isArray(page.boards) || !(typeof page.next === 'string' || page.next === null))
    throw new TypeError('Native Board directory response is invalid');
  const boards = page.boards.map((item) => {
    const board = record(item);
    if (!board || typeof board.id !== 'string' || !UUID.test(board.id))
      throw new TypeError('Native Board directory identity is invalid');
    return board;
  });
  return { boards, next: page.next };
}

function threadFromResponse(value: unknown, expected: { boardId: string; subjectId: string; accountId: string }): {
  threadId: string;
  postId: string;
  revisionId: string;
  sha256: string;
} {
  const thread = record(record(value)?.thread);
  const post = record(thread?.firstPost);
  if (
    !thread ||
    typeof thread.id !== 'string' ||
    !UUID.test(thread.id) ||
    thread.boardId !== expected.boardId ||
    thread.kind !== 'discussion' ||
    !post ||
    typeof post.id !== 'string' ||
    !UUID.test(post.id) ||
    typeof post.revisionId !== 'string' ||
    !UUID.test(post.revisionId) ||
    post.authorId !== expected.accountId ||
    post.licence !== 'CC-BY-4.0' ||
    typeof post.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(post.sha256) ||
    !Array.isArray(post.subjectIds) ||
    post.subjectIds.length !== 1 ||
    post.subjectIds[0] !== expected.subjectId
  )
    throw new TypeError('Native thread response did not acknowledge the exact authored source');
  return { threadId: thread.id, postId: post.id, revisionId: post.revisionId, sha256: post.sha256 };
}

export type DevelopmentCommunityOutcome = Readonly<
  | DevelopmentSeedFailure
  | {
      state: 'published';
      source: { provider: 'vndb'; externalId: 'v2002'; subjectId: string };
      board: {
        id: string;
        realmId: null;
        purpose: 'discussion';
        visibility: 'published';
        availability: 'available';
      };
      thread: { id: string; postId: string; revisionId: string; sha256: string };
    }
>;

/** Bind one finite, importer-read work to its published Global discussion Board and authored source post. */
export async function seedDevelopmentCommunity(input: {
  result: Pick<CrossMediaSeedResult, 'readings' | 'workLinks'>;
  actor: DevelopmentSeedActor;
  client: DevelopmentShowcaseClient;
}): Promise<DevelopmentCommunityOutcome> {
  const subjectId = selectedWorkSubject(input.result);
  if (!subjectId) return { state: 'missing_source', operation: 'vndb:v2002' };

  const boardTitle = 'Development showcase discussion';
  const boardIntent: DevelopmentCommandIntent = {
    actionKey: `local-community-board:${subjectId}`,
    idempotencyKey: `local-showcase-board:${subjectId}`,
    method: 'POST',
    path: '/v1/boards',
    body: { conceptId: subjectId, title: boardTitle, purpose: 'discussion', visibility: 'published' },
  };
  const createdBoard = await input.client.command(boardIntent, (value) => boardFromResponse(value, boardTitle));
  if (createdBoard.state !== 'acknowledged') return { ...createdBoard, operation: 'board.create_global' };

  let cursor: string | undefined;
  const seen = new Set<string>();
  let admitted = false;
  let reachedEnd = false;
  for (let pageNumber = 0; pageNumber < DIRECTORY_PAGE_CAP; pageNumber++) {
    const query = new URLSearchParams({ purpose: 'discussion', limit: String(DIRECTORY_PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    const pageResult = await input.client.read(`/v1/boards?${query}`, { anonymous: true });
    if (pageResult.state !== 'acknowledged') return { ...pageResult, operation: 'board.directory' };
    let page: ReturnType<typeof directoryPage>;
    try {
      page = directoryPage(pageResult.value);
    } catch {
      return { state: 'unavailable', operation: 'board.directory', code: 'response-unavailable' };
    }
    if (
      page.boards.some(
        (board) =>
          board.id === createdBoard.value.boardId &&
          board.realmId === null &&
          board.purpose === 'discussion' &&
          board.visibility === 'published' &&
          board.availability === 'available',
      )
    ) {
      admitted = true;
      break;
    }
    if (page.next === null) {
      reachedEnd = true;
      break;
    }
    if (page.next.length > 4096 || seen.has(page.next))
      return { state: 'unavailable', operation: 'board.directory', code: 'cursor-unavailable' };
    seen.add(page.next);
    cursor = page.next;
  }
  if (!admitted)
    return reachedEnd
      ? { state: 'refused', operation: 'board.directory', code: 'board-not-currently-admitted' }
      : { state: 'unavailable', operation: 'board.directory', code: 'directory-page-cap' };

  const sourceBody = {
    boardId: createdBoard.value.boardId,
    kind: 'discussion',
    title: 'A note for the local showcase',
    body: {
      version: 'rezics-document-v1',
      profile: 'text',
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'local-showcase-opening' },
            content: [{ type: 'text', text: 'This original note opens the local showcase discussion.' }],
          },
        ],
      },
    },
    licence: 'CC-BY-4.0',
    subjectIds: [subjectId],
    visibility: 'published',
  };
  const threadIntent: DevelopmentCommandIntent = {
    actionKey: `local-community-thread:${subjectId}`,
    idempotencyKey: `local-showcase-thread:${subjectId}`,
    method: 'POST',
    path: '/v1/threads',
    body: sourceBody,
  };
  const createdThread = await input.client.command(threadIntent, (value) =>
    threadFromResponse(value, { boardId: createdBoard.value.boardId, subjectId, accountId: input.actor.accountId }),
  );
  if (createdThread.state !== 'acknowledged') return { ...createdThread, operation: 'thread.create' };
  return {
    state: 'published',
    source: { provider: 'vndb', externalId: 'v2002', subjectId },
    board: {
      id: createdBoard.value.boardId,
      realmId: null,
      purpose: 'discussion',
      visibility: 'published',
      availability: 'available',
    },
    thread: createdThread.value,
  };
}
