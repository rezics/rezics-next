import type { PoolClient } from 'pg';
import { isEconomyBookId } from '../contract.ts';
import type { createNativeMarket } from './market-runner.ts';
import type { MarketStoreDatabase } from './market-store.ts';

export type MarketRepairBinding = Readonly<{ bookId: string; node: string; itemHomeId: string }>;
type Request = MarketRepairBinding & Readonly<{ transactionId: string; tradeId: string }>;
type Claim = Readonly<{ transactionId: string; tradeId: string; claimId: string }>;
type Settlement = Readonly<{ finish: 'completed' | 'not_found' }> | Readonly<{ retry: 'owner_retry' | 'unavailable' }>;
type ResumeTrade = ReturnType<typeof createNativeMarket>['resumeTrade'];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const repairWindow = 8;

function validBinding({ bookId, node, itemHomeId }: MarketRepairBinding): boolean {
  return isEconomyBookId(bookId) && isEconomyBookId(itemHomeId) && node.trim().length > 0 && node.length <= 255;
}

/** Accept within the authorized command transaction, alongside its original receipt. */
export async function enqueueMarketRepair(
  tx: Pick<PoolClient, 'query'>,
  request: Request,
): Promise<{ kind: 'queued' | 'replayed' | 'conflict' | 'not_found' | 'invalid_owner_request' }> {
  const { transactionId, bookId, node, itemHomeId, tradeId } = request;
  if (!validBinding(request) || !uuid.test(transactionId) || !isEconomyBookId(tradeId))
    return { kind: 'invalid_owner_request' };
  const { rowCount } = await tx.query(
    `INSERT INTO economy.market_repair_request (transaction_id, book_id, node, item_home_id, trade_id)
     SELECT $1, $2, $3, $4, $5
     WHERE EXISTS (
       SELECT 1 FROM economy.market_trade WHERE book_id = $2 AND trade_id = $5
         AND payload #>> '{terms,item,homeId}' = $4
         AND payload #>> '{terms,price,ledgerBookId}' = $2
         AND payload #>> '{buyer,tradeId}' = $5
     )
     ON CONFLICT (transaction_id) DO NOTHING`,
    [transactionId, bookId, node, itemHomeId, tradeId],
  );
  if (rowCount === 1) return { kind: 'queued' };
  const { rows } = await tx.query<MarketRepairBinding & { tradeId: string }>(
    `SELECT book_id AS "bookId", node, item_home_id AS "itemHomeId", trade_id AS "tradeId"
     FROM economy.market_repair_request WHERE transaction_id = $1`,
    [transactionId],
  );
  const prior = rows[0];
  if (!prior) return { kind: 'not_found' };
  if (prior.bookId !== bookId || prior.node !== node || prior.itemHomeId !== itemHomeId || prior.tradeId !== tradeId)
    return { kind: 'conflict' };
  return { kind: 'replayed' };
}

export function createMarketRepairQueue(database: MarketStoreDatabase, binding: MarketRepairBinding) {
  if (!validBinding(binding)) throw new TypeError('Invalid market repair binding');
  const { bookId, node, itemHomeId } = binding;
  return {
    claim(): Promise<Claim | null> {
      const claimId = crypto.randomUUID();
      return database.transaction(async (tx) => {
        const { rows } = await tx.query<Omit<Claim, 'claimId'>>(
          `WITH ready AS (
             SELECT transaction_id FROM economy.market_repair_request
             WHERE book_id = $1 AND node = $2 AND item_home_id = $3 AND finished_at IS NULL
               AND available_at <= statement_timestamp()
             ORDER BY available_at, transaction_id LIMIT 1 FOR UPDATE SKIP LOCKED
           )
           UPDATE economy.market_repair_request AS request
           SET claim_id = $4, available_at = statement_timestamp() + interval '30 seconds',
               attempts = least(attempts + 1, 5)
           FROM ready WHERE request.transaction_id = ready.transaction_id
           RETURNING request.transaction_id::text AS "transactionId", request.trade_id AS "tradeId"`,
          [bookId, node, itemHomeId, claimId],
        );
        return rows[0] ? { ...rows[0], claimId } : null;
      });
    },

    settle(claim: Claim, settlement: Settlement): Promise<boolean> {
      const outcome = 'finish' in settlement ? settlement.finish : null;
      const failure = 'retry' in settlement ? settlement.retry : null;
      return database.transaction(async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE economy.market_repair_request
           SET claim_id = NULL, outcome = $7::text, last_failure = $8::text,
               finished_at = CASE WHEN $7 IS NOT NULL THEN statement_timestamp() END,
               available_at = CASE WHEN $8 IS NULL THEN available_at
                                   ELSE statement_timestamp() +
                                     least(300, 30 * power(2, attempts - 1)) * interval '1 second' END
           WHERE book_id = $1 AND node = $2 AND item_home_id = $3
             AND transaction_id = $4 AND trade_id = $5 AND claim_id = $6
             AND finished_at IS NULL AND available_at > statement_timestamp()`,
          [bookId, node, itemHomeId, claim.transactionId, claim.tradeId, claim.claimId, outcome, failure],
        );
        return rowCount === 1;
      });
    },
  };
}

export async function runMarketRepairWindow(
  queue: ReturnType<typeof createMarketRepairQueue>,
  resumeTrade: ResumeTrade,
): Promise<void> {
  for (let attempt = 0; attempt < repairWindow; attempt++) {
    const claim = await queue.claim();
    if (!claim) return;
    let settlement: Settlement;
    try {
      const result = await resumeTrade(claim.tradeId);
      if (result.kind === 'not_found') settlement = { finish: 'not_found' };
      else if (result.kind !== 'ok') settlement = { retry: 'unavailable' };
      else if (result.value.retry.length > 0) settlement = { retry: 'owner_retry' };
      else settlement = { finish: 'completed' };
    } catch {
      settlement = { retry: 'unavailable' };
    }
    // Existing trade leases and receipts make replay safe if this settlement is lost.
    if (!(await queue.settle(claim, settlement))) return;
  }
}
