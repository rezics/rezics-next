import { afterAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { createMarketStore } from '../../src/economy/storage/market-store.ts';
import { insertRetainedTrades, retainedTrade } from './fixtures/market-trades.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

type Scan = {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Rows Removed by Filter'?: number;
  Plans?: Scan[];
};

function scans(plan: Scan): Scan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(scans)].filter(({ 'Node Type': kind }) => kind.includes('Scan'));
}

test('both participant seeks stay bounded before and after unrelated history grows in the same market', async () => {
  const bookId = `trade-history:${crypto.randomUUID()}`;
  const itemHomeId = 'market-item-home';
  const accountId = crypto.randomUUID();
  const counterpart = crypto.randomUUID();
  const otherBuyer = crypto.randomUUID();
  const otherSeller = crypto.randomUUID();
  const id = (value: number) => value.toString(16).padStart(64, '0');
  const at = 9007199254740997n;
  const chosen = Array.from({ length: 8 }, (_, index) =>
    retainedTrade({
      bookId,
      itemHomeId,
      buyerId: index % 2 ? accountId : counterpart,
      sellerId: index % 2 ? counterpart : accountId,
      tradeId: id(index + 1),
      startedAt: at - BigInt(Math.floor(index / 2)),
    }),
  );
  await insertRetainedTrades(pool, chosen);
  const appendUnrelated = async (from: number, count: number) => {
    for (let ordinal = from; ordinal < from + count; ordinal += 512) {
      const fixtures = Array.from({ length: Math.min(512, from + count - ordinal) }, (_, index) =>
        retainedTrade({
          bookId,
          itemHomeId,
          buyerId: otherBuyer,
          sellerId: otherSeller,
          tradeId: id(ordinal + index),
          startedAt: at + BigInt(ordinal + index),
        }),
      );
      await insertRetainedTrades(pool, fixtures);
    }
    await pool.query('ANALYZE economy.market_trade');
  };
  await appendUnrelated(100, 1024);
  const findings: Scan[][] = [];
  const query = async (sql: string, operands: unknown[]) => {
    const explain = await pool.query<{ 'QUERY PLAN': [{ Plan: Scan }] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
      operands,
    );
    findings.push(scans(explain.rows[0]!['QUERY PLAN'][0].Plan));
    return pool.query(sql, operands);
  };
  const database = {
    read: <Value>(run: (client: Pick<PoolClient, 'query'>) => Promise<Value>) =>
      run({ query: query as PoolClient['query'] }),
    transaction: <Value>(run: (client: Pick<PoolClient, 'query'>) => Promise<Value>) => run(pool),
  };
  const store = createMarketStore(database, bookId, {
    findListingProof: async () => null,
    findReceipt: async () => null,
  });
  const input = { itemHomeId, accountId, limit: 2 };
  const read = async () => {
    const first = await store.readParticipantTrades({ ...input, after: null });
    const continued = await store.readParticipantTrades({ ...input, after: [at.toString(), id(1)] });
    expect(first.more).toBe(true);
    expect(continued.more).toBe(true);
    return [first, continued].map((page) => page.trades.map(({ buyer }) => buyer.tradeId));
  };
  function verifySeeks() {
    expect(findings).toHaveLength(2);
    return findings.splice(0).map((nodes, page) => {
      expect(nodes.map((node) => node['Index Name']).sort()).toEqual([
        'market_trade_buyer_history_idx',
        'market_trade_seller_history_idx',
      ]);
      for (const node of nodes) {
        expect(node['Node Type']).toBe('Index Scan');
        expect(node['Index Cond']).toContain('book_id');
        expect(node['Index Cond']).toContain('homeId');
        expect(node['Index Cond']).toContain(accountId);
        if (page === 1) expect(node['Index Cond']).toContain('trade_id');
        expect(node['Actual Rows']).toBeLessThanOrEqual(input.limit + 1);
        expect(node['Rows Removed by Filter'] ?? 0).toBe(0);
      }
      return nodes
        .map((node) => ({ index: node['Index Name'], rows: node['Actual Rows'] }))
        .sort((a, b) => (a.index ?? '').localeCompare(b.index ?? ''));
    });
  }
  expect(await read()).toEqual([
    [id(2), id(1)],
    [id(4), id(3)],
  ]);
  const before = verifySeeks();
  await appendUnrelated(2000, 8192);
  expect(await read()).toEqual([
    [id(2), id(1)],
    [id(4), id(3)],
  ]);
  expect(verifySeeks()).toEqual(before);
}, 90_000);
