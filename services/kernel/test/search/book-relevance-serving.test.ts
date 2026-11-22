import { expect, test } from 'bun:test';
import { bookRelevanceBound } from '../../src/search/book-relevance-bound.ts';
import { bookBindingStep } from '../../src/request/book-binding-steps.ts';
import { createBookCaptureReads, createBookRelevanceReads } from '../../src/search/book-relevance-reads.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type { PublicSearchPage, SearchPrincipal } from '../../src/search/service-contract.ts';

test('direct relevance requires one complete small shard including deleted documents and its write history', async () => {
  const shard = {
    routing: { primary: true, state: 'STARTED', relocating_node: null, node: 'native-node' },
    seq_no: { max_seq_no: 6, local_checkpoint: 6 },
    refresh: { external_total: 3 },
    retention_leases: { primary_term: 2 },
    docs: { count: 4, deleted: 6 },
  };
  const stats = {
    _shards: { total: 1, successful: 1, failed: 0 },
    indices: { books: { uuid: 'incarnation', shards: { '0': [shard] } } },
  };
  const search = { request: async () => ({ status: 200, body: stats }) } as unknown as OpenSearch;
  const bound = () => bookRelevanceBound(search, 'books', 5);
  expect(await bound()).toEqual({ uuid: 'incarnation', node: 'native-node', term: 2, sequence: 6, refresh: 3 });
  shard.docs.count = 6;
  expect(await bound()).toBeNull();
  shard.docs.count = 1;
  shard.docs.deleted = 33;
  expect(await bound()).toBeNull();
  shard.docs.deleted = 0;
  shard.seq_no = { max_seq_no: 4000, local_checkpoint: 4000 };
  expect(await bound()).toBeNull();
  shard.seq_no = { max_seq_no: 6, local_checkpoint: 5 };
  expect(await bound()).toBeNull();
  shard.seq_no.local_checkpoint = 6;
  stats._shards.total = 2;
  expect(await bound()).toBeNull();
});

const page = (): PublicSearchPage => ({
  subjects: [],
  kinds: { values: [], next: 'original-kind-cursor' },
  next: null,
  as_of: new Date().toISOString(),
});

test('only readers waiting before capture share a ranking and each completes before the common final', async () => {
  const read = createBookRelevanceReads();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const events: string[] = [];
  type Execute = Parameters<typeof read>[2];
  const reader = (id: string, execute: Execute, denied = false) =>
    read(
      'same Book plan',
      {
        principal: `account:${id}`,
        now: Date.now(),
        deadline: Date.now() + 5000,
        async complete(own) {
          events.push('viewer ' + id);
          if (denied) throw new Error('withdrawn');
          expect(own.kinds?.next).toBe('account:' + id);
        },
      },
      execute,
    );
  const first = reader('first', async (captured) => {
    await entered.promise;
    captured!();
    await finish.promise;
    return page();
  });
  const shared =
    (principal: SearchPrincipal): Execute =>
    async (captured, complete) => {
      events.push('rank');
      captured!();
      const result = page();
      result.kinds!.next = principal;
      await complete!(result, async (member) => member.principal);
      events.push('final');
      return result;
    };
  const allowed = reader('allowed', shared('account:allowed'));
  const denied = reader('denied', shared('account:denied'), true);
  const replies = Promise.allSettled([allowed, denied]);
  entered.resolve();
  const [a, b] = await replies;
  expect(a.status).toBe('fulfilled');
  expect(b.status).toBe('rejected');
  expect(b.status === 'rejected' && b.reason.message).toBe('withdrawn');
  expect(events[0]).toBe('rank');
  expect(events.slice(1, -1).sort()).toEqual(['viewer allowed', 'viewer denied']);
  expect(events.at(-1)).toBe('final');
  finish.resolve();
  await first;
});

test('a failed final withholds every reader and a fresh search can use the registration', async () => {
  const read = createBookRelevanceReads();
  const gate = Promise.withResolvers<void>();
  const reader = { principal: 'anonymous' as const, now: 0, deadline: Date.now() + 5000, complete: async () => {} };
  const first = read('book', reader, async () => {
    await gate.promise;
    return page();
  });
  const execute: Parameters<typeof read>[2] = async (_captured, complete) => {
    await complete!(page(), async () => null);
    throw new Error('privacy cut changed');
  };
  const denied = Promise.allSettled([read('book', reader, execute), read('book', reader, execute)]);
  gate.resolve();
  await first;
  expect((await denied).map((reply) => reply.status)).toEqual(['rejected', 'rejected']);
  expect((await read('book', reader, async () => page())).next).toBeNull();
});

test('a page with more hits gives each waiting reader its own observation and cursor', async () => {
  const read = createBookRelevanceReads();
  const gate = Promise.withResolvers<void>();
  const reader = { principal: 'anonymous' as const, now: 0, deadline: Date.now() + 5000, complete: async () => {} };
  const first = read('book', reader, async () => {
    await gate.promise;
    return page();
  });
  const open = (next: string) =>
    read('book', reader, async (_captured, complete) => {
      const own = { ...page(), next };
      await complete?.(own, async () => null);
      return own;
    });
  const replies = Promise.all([open('cursor-a'), open('cursor-b')]);
  gate.resolve();
  await first;
  expect((await replies).map((result) => result.next)).toEqual(['cursor-a', 'cursor-b']);
});

test('PIT retention batches distinct waiting registrations under their earliest remaining deadline', async () => {
  const capture = createBookCaptureReads();
  const owner = {};
  const gate = Promise.withResolvers<void>();
  const now = Date.now();
  const batches: { keys: readonly string[]; deadline: number }[] = [];
  const retain = (key: string, deadline: number) =>
    capture(async () =>
      bookBindingStep('retain', owner, 'one target', key, deadline, key, async (keys, until) => {
        batches.push({ keys, deadline: until });
        if (key === 'first') await gate.promise;
        return keys.map((id) => 'observation:' + id);
      }),
    );
  const first = retain('first', now + 3000);
  const second = retain('a', now + 2400);
  const third = retain('b', now + 2100);
  const expired = Promise.allSettled([retain('lost', now - 1)]);
  const repeat = retain('b', now + 2500);
  gate.resolve();
  expect(await Promise.all([first, second, third, repeat])).toEqual([
    'observation:first',
    'observation:a',
    'observation:b',
    'observation:b',
  ]);
  expect((await expired)[0]).toMatchObject({ status: 'rejected', reason: { code: 'deadline_exceeded' } });
  expect(batches).toEqual([
    { keys: ['first'], deadline: now + 3000 },
    { keys: ['a', 'b'], deadline: now + 2100 },
    { keys: ['b'], deadline: now + 2500 },
  ]);
});
