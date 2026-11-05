import { expect, test } from 'bun:test';
import type { CrossMediaSeedResult } from '../../services/importer/src/cross-media-seed.ts';
import { createDevelopmentShowcaseClient, seedDevelopmentCommunity } from './showcase-community.ts';

const accountId = '20000000-0000-7000-8000-000000000001';
const subjectId = '10000000-0000-7000-8000-000000000001';
const boardId = '30000000-0000-7000-8000-000000000001';
const threadId = '40000000-0000-7000-8000-000000000001';
const postId = '50000000-0000-7000-8000-000000000001';
const revisionId = '60000000-0000-7000-8000-000000000001';
const sha256 = 'a'.repeat(64);

const imported = {
  readings: [
    {
      source: 'vndb',
      externalId: 'v2002',
      selection: 'selected',
      route: '202',
      subject: { subject: { id: subjectId } },
    },
  ],
  workLinks: [
    { source: { provider: 'vndb', externalId: 'v2002', subject: { subjectId, route: '202' } } },
  ],
} as unknown as Pick<CrossMediaSeedResult, 'readings' | 'workLinks'>;

class MemoryJournal {
  readonly actions = new Map<string, { body: string; idempotencyKey: string; state: string }>();

  prepareAction(key: string, body: unknown, idempotencyKey: string): unknown {
    const prior = this.actions.get(key);
    if (prior) return JSON.parse(prior.body) as unknown;
    this.actions.set(key, { body: JSON.stringify(body), idempotencyKey, state: 'prepared' });
    return body;
  }
  action(key: string) {
    const prior = this.actions.get(key);
    return prior ? { idempotency_key: prior.idempotencyKey } : null;
  }
  acknowledgeAction(key: string) {
    this.actions.get(key)!.state = 'acknowledged';
  }
  refuseAction(key: string) {
    this.actions.get(key)!.state = 'refused';
  }
}

test('native Board and authored thread resume unknown delivery and repeated seed without duplicate effects', async () => {
  const journal = new MemoryJournal();
  const stored = new Map<string, unknown>();
  const calls: { method: string; path: string; key?: string; body?: Record<string, unknown>; authorized: boolean }[] = [];
  const effects = { board: 0, thread: 0 };
  let boardPosts = 0;
  const fetcher: typeof fetch = async (request, init) => {
    const url = new URL(String(request));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, path: url.pathname, ...(body ? { body } : {}), authorized: headers.has('authorization') });
    if (method === 'GET') {
      expect(url.searchParams.get('purpose')).toBe('discussion');
      expect(headers.has('authorization')).toBe(false);
      return Response.json({
        boards: [
          { id: boardId, realmId: null, title: 'Development showcase discussion', purpose: 'discussion', visibility: 'published', availability: 'available' },
        ],
        next: null,
      });
    }

    const encodedKey = headers.get('idempotency-key');
    const key = encodedKey ? (JSON.parse(encodedKey) as string) : '';
    const prior = stored.get(key);
    calls[calls.length - 1]!.key = key;
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer showcase-token');
    if (url.pathname === '/v1/boards') {
      if (!prior) {
        effects.board++;
        stored.set(key, {
          board: { id: boardId, realmId: null, title: 'Development showcase discussion', purpose: 'discussion', visibility: 'published', availability: 'available' },
        });
      }
      boardPosts++;
      if (boardPosts === 1) throw new Error('connection closed after commit');
      return Response.json(stored.get(key), { status: 201 });
    }
    if (url.pathname === '/v1/threads') {
      if (!prior) {
        effects.thread++;
        stored.set(key, {
          thread: {
            id: threadId,
            boardId,
            kind: 'discussion',
            authorId: accountId,
            firstPost: { id: postId, revisionId, sha256, authorId: accountId, licence: 'CC-BY-4.0', subjectIds: [subjectId] },
          },
        });
      }
      return Response.json(stored.get(key), { status: 201 });
    }
    throw new Error(`Unexpected route ${url.pathname}`);
  };
  const client = createDevelopmentShowcaseClient({
    origin: 'http://kernel.test',
    actor: { accountId, clientId: 'rezics-dev-showcase' },
    credential: { keyId: 'credential-1' },
    tokenProvider: async () => 'showcase-token',
    journal,
    fetch: fetcher,
  });

  const first = await seedDevelopmentCommunity({ result: imported, actor: { accountId, clientId: 'rezics-dev-showcase' }, client });
  expect(first).toMatchObject({ state: 'unknown_delivery', operation: 'board.create_global' });
  const resumed = await seedDevelopmentCommunity({ result: imported, actor: { accountId, clientId: 'rezics-dev-showcase' }, client });
  const repeated = await seedDevelopmentCommunity({ result: imported, actor: { accountId, clientId: 'rezics-dev-showcase' }, client });

  expect(resumed).toMatchObject({ state: 'published', source: { subjectId }, board: { id: boardId }, thread: { threadId } });
  expect(repeated).toEqual(resumed);
  expect(effects).toEqual({ board: 1, thread: 1 });
  const boardCommands = calls.filter((call) => call.method === 'POST' && call.path === '/v1/boards');
  const threadCommands = calls.filter((call) => call.method === 'POST' && call.path === '/v1/threads');
  expect(boardCommands.map(({ key, body }) => ({ key, body }))).toEqual([
    { key: 'local-showcase-board:' + subjectId, body: { conceptId: subjectId, title: 'Development showcase discussion', purpose: 'discussion', visibility: 'published' } },
    { key: 'local-showcase-board:' + subjectId, body: { conceptId: subjectId, title: 'Development showcase discussion', purpose: 'discussion', visibility: 'published' } },
    { key: 'local-showcase-board:' + subjectId, body: { conceptId: subjectId, title: 'Development showcase discussion', purpose: 'discussion', visibility: 'published' } },
  ]);
  expect(threadCommands[0]?.body).toMatchObject({ boardId, subjectIds: [subjectId], licence: 'CC-BY-4.0', visibility: 'published' });
  expect(threadCommands.map((call) => call.key)).toEqual([
    'local-showcase-thread:' + subjectId,
    'local-showcase-thread:' + subjectId,
  ]);
});

test('a refused Board command stops before directory or thread work, and a missing source performs no request', async () => {
  const journal = new MemoryJournal();
  const actor = { accountId, clientId: 'rezics-dev-showcase' };
  const refusedClient = createDevelopmentShowcaseClient({
    origin: 'http://kernel.test',
    actor,
    credential: { keyId: 'credential-1' },
    tokenProvider: async () => 'showcase-token',
    journal,
    fetch: async () => Response.json({ code: 'forbidden' }, { status: 403 }),
  });
  const refused = await seedDevelopmentCommunity({ result: imported, actor, client: refusedClient });
  expect(refused).toMatchObject({ state: 'refused', operation: 'board.create_global', code: 'http-403' });

  const missing = await seedDevelopmentCommunity({
    result: { readings: [], workLinks: [] } as Pick<CrossMediaSeedResult, 'readings' | 'workLinks'>,
    actor,
    client: { read: async () => { throw new Error('no request expected'); }, command: async () => { throw new Error('no request expected'); } },
  });
  expect(missing).toEqual({ state: 'missing_source', operation: 'vndb:v2002' });

  const stale = await seedDevelopmentCommunity({
    result: {
      ...imported,
      workLinks: [{ source: { provider: 'vndb', externalId: 'v2002', subject: { subjectId: postId, route: '202' } } }],
    } as unknown as Pick<CrossMediaSeedResult, 'readings' | 'workLinks'>,
    actor,
    client: { read: async () => { throw new Error('no request expected'); }, command: async () => { throw new Error('no request expected'); } },
  });
  expect(stale).toEqual({ state: 'missing_source', operation: 'vndb:v2002' });
});
