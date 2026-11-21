import { afterAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { createMarketStore } from '../../src/economy/storage/market-store.ts';
import { insertRetainedListings, retainedListing } from './fixtures/market-trades.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

type Scan = {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: Scan[];
};

test('offer pages seek beyond expired rows and exclude closed history without scanning it', async () => {
  const bookId = `offer-depth:${crypto.randomUUID()}`;
  const itemHomeId = 'offer-item-home';
  const sellerId = crypto.randomUUID();
  const id = (index: number) => index.toString(16).padStart(64, '0');
  const now = BigInt(Date.now());
  const future = now + 600_000n;
  const fixture = (index: number, expiresAt: bigint, cancelled = false) =>
    retainedListing({ bookId, itemHomeId, sellerId, listingId: id(index), expiresAt, cancelled });
  await insertRetainedListings(
    pool,
    [1, 2, 3, 4, 5].map((index) => fixture(index, future + BigInt(index > 2 ? index : 0))),
  );
  const appendUnrelated = async (start: number, count: number) => {
    for (let offset = 0; offset < count; offset += 512) {
      const fixtures = Array.from({ length: Math.min(512, count - offset) }, (_, index) => {
        const ordinal = start + offset + index;
        const cancelled = ordinal % 2 === 0;
        const expiry = (cancelled ? future : now) - 120_000n + BigInt(ordinal);
        return fixture(ordinal, expiry, cancelled);
      });
      await insertRetainedListings(pool, fixtures);
    }
    await pool.query('ANALYZE economy.market_listing');
  };
  await appendUnrelated(100, 2_048);

  const observed: Scan[] = [];
  const query = async (sql: string, operands: unknown[]) => {
    const explain = await pool.query<{ 'QUERY PLAN': [{ Plan: Scan }] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
      operands,
    );
    observed.push(explain.rows[0]!['QUERY PLAN'][0].Plan);
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
  const limit = 2;
  async function readPages() {
    const continuations = [null, [(now - 180_000n).toString(), id(100)], [future.toString(), id(2)]] as const;
    const result: string[][] = [];
    for (const after of continuations) {
      const page = await store.readOpenListings({ itemHomeId, limit, after });
      expect(page.more).toBe(true);
      result.push(page.listings.map(({ listingId }) => listingId));
    }
    expect(result).toEqual([
      [id(1), id(2)],
      [id(1), id(2)],
      [id(3), id(4)],
    ]);
    expect(observed).toHaveLength(3);
    return observed.splice(0).map((plan, page) => {
      expect(plan['Node Type']).toBe('Limit');
      expect(plan.Plans).toHaveLength(1);
      const scan = plan.Plans![0]!;
      expect(scan['Node Type']).toBe('Index Scan');
      expect(scan['Index Name']).toBe('market_listing_open_expiry_idx');
      expect(scan['Index Cond']).toContain('book_id');
      expect(scan['Index Cond']).toContain('item_home_id');
      expect(scan['Index Cond']).toContain('statement_timestamp()');
      if (page !== 0) expect(scan['Index Cond']).toContain('listing_id');
      expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
      expect(scan['Actual Rows']).toBe(limit + 1);
      const buffers = (scan['Shared Hit Blocks'] ?? 0) + (scan['Shared Read Blocks'] ?? 0);
      expect(buffers).toBeLessThanOrEqual(10);
      return buffers;
    });
  }
  const before = await readPages();
  await appendUnrelated(3000, 16_384);
  for (const [index, buffers] of (await readPages()).entries()) {
    expect(buffers).toBeLessThanOrEqual(before[index]! + 2);
  }
}, 90_000);
