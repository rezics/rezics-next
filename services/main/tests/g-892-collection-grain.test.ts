import { expect, test } from 'bun:test';
import { COLLECTION_GRAIN_COST, readCollectionGrain } from '../src/modules/collection/grain.ts';
import { WorkReadInvalid, WorkReadExpired, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const binding = (value: string) => ({ type: 'uri', value });
const pair = (work: number, member = work) => ({ work: binding(id(work)),
  main: binding(id(work + 10_000)), member: binding(id(member)) });

function fixture(rows: ReturnType<typeof pair>[], hidden = new Set<string>(), denied = new Set<string>()) {
  const queries: string[] = [], batches: string[][] = [];
  let allowed = true, publicCollection = true;
  const session = { principal: { issuer: 'https://account.test', subject: 'reader' },
    options: { actingSubject: id(1) }, request: new Request('http://main.local/v1/collections'),
    position: { dataEpoch: 'epoch', sequence: '10' }, checkDeadline: () => {},
    deps: { account: { verify: async (_request: Request, scopes: string[]) => {
      expect(scopes).toEqual(['semantic:read']); return session.principal;
    } }, access: { canReadSemanticResource: async () => allowed,
      canReadWork: async (_principal: unknown, _actor: string, work: string) => !denied.has(work) } },
    summaries: async (targets: string[]) => {
      batches.push(targets);
      expect(targets.length).toBeLessThanOrEqual(COLLECTION_GRAIN_COST.summaryTargets);
      return targets.map(reference => ({ reference, type: 'work', disclosure: 'public',
        status: hidden.has(reference) || denied.has(reference) ? 'unavailable' : 'available' }));
    },
    query: async (query: string, limit: number) => {
      queries.push(query);
      if (query.startsWith('SELECT ?structure')) return [{ structure: binding(id(2)),
        disclosure: binding(`https://rezics.com/vocab/${publicCollection ? 'Public' : 'Private'}`),
        revision: binding(id(3)), generation: binding(id(4)) }];
      expect(limit).toBe(COLLECTION_GRAIN_COST.candidatePairs);
      expect(query).toContain(`LIMIT ${COLLECTION_GRAIN_COST.candidatePairs}`);
      expect(query).toContain('SELECT DISTINCT ?work ?main ?member');
      expect(query).not.toContain('OFFSET');
      expect(query).toContain('rv:protectionHead');
      expect(query).toContain('rv:ErasedRevision');
      expect(query).toContain('rv:Release');
      const afterWork = query.match(/FILTER\(STR\(\?work\) > "([^"]+)"\)/)?.[1];
      const afterPair = query.match(/FILTER\(\?key > "([^"]+)"\)/)?.[1];
      return rows.filter(row => (!afterWork || row.work.value > afterWork)
        && (!afterPair || `${row.work.value}|${row.member.value}` > afterPair)).slice(0, limit);
    } };
  return { session: session as unknown as WorkReadSession, queries, batches,
    close: () => { allowed = false; publicCollection = false; } };
}

test('G-892: complete sparse traversal skips more than a page of hidden pairs and collapses shared parts', async () => {
  const rows = Array.from({ length: 225 }, (_, i) => pair(i + 100));
  rows.push(pair(325, 700), pair(325, 701), pair(326), pair(327));
  const f = fixture(rows, new Set(rows.slice(0, 225).map(row => row.work.value)));
  const first = await readCollectionGrain(f.session, id(5), { grain: 'parts', limit: 1 });
  expect(first.items).toEqual([{ work: id(325), mainVersion: id(10_325) }]);
  expect(first.nextCursor).toBeString();
  const next = await readCollectionGrain(f.session, id(5), { grain: 'parts', limit: 100, cursor: first.nextCursor! });
  expect(next.items.map(item => item.work)).toEqual([id(326), id(327)]);
  expect(next.nextCursor).toBeNull();
  expect(f.queries.length).toBeGreaterThan(8);
  expect(f.queries[1]).toContain('rv:WorkComposition');
  expect(first).not.toHaveProperty('count');
  expect(JSON.stringify(first)).not.toContain(id(100));
});

test('G-892: private or fenced parents and parts contribute neither results nor continuation', async () => {
  const f = fixture([pair(100, 500), pair(101, 501), pair(102, 502)], new Set([id(500)]), new Set([id(101), id(502)]));
  const result = await readCollectionGrain(f.session, id(5), { grain: 'parts', limit: 1 });
  expect(result.items).toEqual([]);
  expect(result.nextCursor).toBeNull();
  f.close();
  await expect(readCollectionGrain(f.session, id(5), { grain: 'series', limit: 1 })).rejects.toBeInstanceOf(WorkReadMissing);
});

test('G-892: request size never becomes an inventory limit and shared parts collapse at a batch boundary', async () => {
  const rows = Array.from({ length: 240 }, (_, i) => pair(i + 100));
  rows.splice(32, 0, pair(131, 900));
  const f = fixture(rows);
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await readCollectionGrain(f.session, id(5), { grain: 'parts', limit: 100, cursor });
    seen.push(...page.items.map(item => item.work));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(Array.from({ length: 240 }, (_, i) => id(i + 100)));
  expect(new Set(seen).size).toBe(240);
});

test('G-892: cursors bind collection, grain, principal, actor and epoch/sequence; limits are request bounds', async () => {
  const f = fixture([pair(100), pair(101)]);
  const first = await readCollectionGrain(f.session, id(5), { grain: 'series', limit: 1 });
  expect(f.queries[1]).not.toContain('rv:WorkComposition');
  for (const input of [{ grain: 'parts' as const, collection: id(5) }, { grain: 'series' as const, collection: id(6) }]) {
    await expect(readCollectionGrain(f.session, input.collection,
      { grain: input.grain, limit: 1, cursor: first.nextCursor! })).rejects.toBeInstanceOf(WorkReadInvalid);
  }
  f.session.options.actingSubject = id(8);
  await expect(readCollectionGrain(f.session, id(5), { grain: 'series', limit: 1, cursor: first.nextCursor! }))
    .rejects.toBeInstanceOf(WorkReadInvalid);
  f.session.options.actingSubject = id(1);
  f.session.principal!.subject = 'other';
  await expect(readCollectionGrain(f.session, id(5), { grain: 'series', limit: 1, cursor: first.nextCursor! }))
    .rejects.toBeInstanceOf(WorkReadInvalid);
  f.session.principal!.subject = 'reader';
  f.session.position.sequence = '11';
  await expect(readCollectionGrain(f.session, id(5), { grain: 'series', limit: 1, cursor: first.nextCursor! }))
    .rejects.toBeInstanceOf(WorkReadExpired);
  for (const limit of [0, 101, 1.5]) await expect(readCollectionGrain(f.session, id(5), { grain: 'series', limit }))
    .rejects.toBeInstanceOf(WorkReadInvalid);
});

test('G-892: an unavailable owner fails closed instead of declaring a partial inventory complete', async () => {
  const f = fixture([pair(100)]);
  f.session.summaries = async () => { throw new WorkReadUnavailable('owner unavailable'); };
  await expect(readCollectionGrain(f.session, id(5), { grain: 'series', limit: 1 }))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('G-892: public Collections need no explicit grant or credential and granted private Works stay hidden', async () => {
  const f = fixture([pair(100), pair(101)], new Set([id(101)]));
  f.session.principal = null;
  f.session.options.actingSubject = undefined;
  const result = await readCollectionGrain(f.session, id(5), { grain: 'series', limit: 1 });
  expect(result.items).toEqual([{ work: id(100), mainVersion: id(10_100) }]);
  expect(result.nextCursor).toBeNull();
  f.close();
  await expect(readCollectionGrain(f.session, id(5), { grain: 'series', limit: 1 }))
    .rejects.toBeInstanceOf(WorkReadMissing);
});
