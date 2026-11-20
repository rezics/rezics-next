import type { PoolClient } from 'pg';
import {
  isEconomyBookId,
  type EconomyFailure,
  type EconomyLedger,
  type EconomyResult,
  type HoldAllocationKey,
} from '../contract.ts';
import { createEconomyLedger } from '../ledger.ts';
import { encodeMarketRecord } from './market-codec.ts';
import {
  readFundsInstruction,
  validMarketFundsClaim,
  type MarketFundsClaim,
  type MarketFundsInstruction,
} from './market-funds-work.ts';
import type { MarketStoreDatabase, MarketWork } from './market-store.ts';

type Query = Pick<PoolClient, 'query'>;
type Receipt = Readonly<{ receiptId: string }>;
type Failure = EconomyFailure | 'invalid_request' | 'unproved_work' | 'conflict' | 'out_of_order';
type Result<Value> = Readonly<{ kind: 'ok'; value: Value }> | Readonly<{ kind: Failure }>;

export interface MarketFundsAuthority {
  findIssuedWork(claim: MarketFundsClaim): Promise<MarketWork | null>;
}

type TradePhase = 'prepared' | 'fenced' | 'released' | 'escrowed' | 'settled';
type TradeRow = {
  phase: TradePhase;
  decidedAt: string | null;
  escrowId: string;
  funded: boolean;
  matches: boolean;
};
type ReceiptRow = { receiptId: string; matches: boolean };

function ok<Value>(value: Value): Result<Value> {
  return { kind: 'ok', value };
}

class LedgerRejected extends Error {
  constructor(readonly kind: EconomyFailure) {
    super(kind);
  }
}

function requireLedger<Value>(result: EconomyResult<Value>): Value {
  if (result.kind !== 'ok') throw new LedgerRejected(result.kind);
  return result.value;
}

async function withLedgerEffects<Value>(client: Query, run: () => Promise<Result<Value>>): Promise<Result<Value>> {
  await client.query('SAVEPOINT market_funds_effect');
  let outcome: Result<Value>;
  try {
    outcome = await run();
  } catch (error) {
    if (!(error instanceof LedgerRejected)) throw error;
    outcome = { kind: error.kind };
  }
  if (outcome.kind !== 'ok') await client.query('ROLLBACK TO SAVEPOINT market_funds_effect');
  await client.query('RELEASE SAVEPOINT market_funds_effect');
  return outcome;
}

function allocationKey(instruction: MarketFundsInstruction): HoldAllocationKey {
  return {
    accountId: instruction.buyerId,
    assetId: instruction.money.assetId,
    holdId: instruction.reservationId,
    purpose: 'market_trade',
    reference: instruction.tradeId,
  };
}

async function prepareFunds(ledger: EconomyLedger, instruction: MarketFundsInstruction): Promise<void> {
  const key = allocationKey(instruction);
  const amount = instruction.money.units.toString();
  const balance = requireLedger(await ledger.readBalance(key));
  if (!balance.asset.transferable) throw new LedgerRejected('asset_not_transferable');
  requireLedger(
    await ledger.reserve({
      ...key,
      operationId: `${instruction.id}:reserve`,
      amount,
      expiresAt: new Date(Number(instruction.prepareUntil)).toISOString(),
    }),
  );
  requireLedger(await ledger.allocate({ ...key, operationId: `${instruction.id}:protect`, amount }));
}

async function resolveFunds(ledger: EconomyLedger, instruction: MarketFundsInstruction, escrowId: string | null) {
  const key = allocationKey(instruction);
  const allocation = requireLedger(await ledger.readAllocation(key));
  if (allocation.amount !== instruction.money.units.toString()) throw new LedgerRejected('operation_conflict');
  const command = { ...key, operationId: instruction.id };
  return requireLedger(
    escrowId === null
      ? await ledger.releaseAllocation(command)
      : await ledger.captureAllocation({ ...command, recipientId: escrowId }),
  );
}

async function settleFunds(
  ledger: EconomyLedger,
  instruction: MarketFundsInstruction,
  escrowId: string,
): Promise<void> {
  const { assetId, feeAccountId, feeUnits, sellerUnits } = instruction.money;
  const key = { accountId: escrowId, assetId };
  const balance = requireLedger(await ledger.readBalance(key));
  const gross = instruction.money.units.toString();
  if (balance.posted !== gross || balance.available !== gross) throw new LedgerRejected('operation_conflict');
  const payments = [
    { recipientId: instruction.sellerId, operationId: `${instruction.id}:seller`, units: sellerUnits },
    { recipientId: feeAccountId, operationId: `${instruction.id}:fee`, units: feeUnits },
  ].sort((a, b) => (a.recipientId < b.recipientId ? -1 : 1));
  for (const { units, ...payment } of payments) {
    if (units > 0n) requireLedger(await ledger.transfer({ ...key, ...payment, amount: units.toString() }));
  }
}

function binding(work: MarketWork, instruction: MarketFundsInstruction): string {
  const { buyerId, sellerId, prepareUntil, reservationId, money } = instruction;
  return encodeMarketRecord({ listingId: work.listingId, buyerId, sellerId, prepareUntil, reservationId, money });
}

async function readTrade(
  client: Query,
  work: MarketWork,
  instruction: MarketFundsInstruction,
): Promise<TradeRow | null> {
  const { rows } = await client.query<TradeRow>(
    `SELECT phase, decided_at::text AS "decidedAt", funded, escrow_id AS "escrowId", binding = $3::jsonb AS matches
     FROM economy.market_funds_trade WHERE book_id = $1 AND trade_id = $2`,
    [work.bookId, instruction.tradeId, binding(work, instruction)],
  );
  return rows[0] ?? null;
}

async function readReceipt(client: Query, work: MarketWork): Promise<ReceiptRow | null> {
  const { rows } = await client.query<ReceiptRow>(
    `SELECT receipt_id AS "receiptId", work = $3::jsonb AS matches
     FROM economy.market_funds_receipt WHERE book_id = $1 AND instruction_id = $2`,
    [work.bookId, work.id, encodeMarketRecord(work)],
  );
  return rows[0] ?? null;
}

async function confirmedLocalPrerequisite(
  client: Query,
  bookId: string,
  proof: { instructionId: string; receiptId: string },
) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM economy.market_funds_receipt
     WHERE book_id = $1 AND instruction_id = $2 AND receipt_id::text = $3`,
    [bookId, proof.instructionId, proof.receiptId],
  );
  return rowCount === 1;
}

async function applyFundsWork(
  client: Query,
  bookId: string,
  instruction: MarketFundsInstruction,
  trade: TradeRow | null,
  escrowId: string,
): Promise<Result<TradePhase>> {
  const ledger = createEconomyLedger({ transaction: (run) => run(client), read: (run) => run(client) }, bookId);
  switch (instruction.kind) {
    case 'prepare_funds':
      if (trade !== null) return { kind: 'out_of_order' };
      await prepareFunds(ledger, instruction);
      return ok('prepared');
    case 'fence_funds_abort':
      return trade === null || trade.phase === 'prepared' ? ok('fenced') : { kind: 'out_of_order' };
    case 'release_funds':
      if (trade?.phase !== 'fenced' || trade.decidedAt !== instruction.decision!.at.toString())
        return { kind: 'out_of_order' };
      if (!(await confirmedLocalPrerequisite(client, bookId, instruction.prerequisites[1]!)))
        return { kind: 'unproved_work' };
      if (trade.funded) await resolveFunds(ledger, instruction, null);
      return ok('released');
    case 'escrow_funds': {
      if (trade?.phase !== 'prepared' || !trade.funded) return { kind: 'out_of_order' };
      if (!(await confirmedLocalPrerequisite(client, bookId, instruction.prerequisites[1]!)))
        return { kind: 'unproved_work' };
      const escrow = requireLedger(
        await ledger.readBalance({ accountId: escrowId, assetId: instruction.money.assetId }),
      );
      if (escrow.posted !== '0') return { kind: 'conflict' };
      await resolveFunds(ledger, instruction, escrowId);
      return ok('escrowed');
    }
    case 'release_proceeds':
      if (trade?.phase !== 'escrowed' || trade.decidedAt !== instruction.decision!.at.toString())
        return { kind: 'out_of_order' };
      // The authenticated coordinator issues this only after it verifies the item owner's delivery receipt.
      await settleFunds(ledger, instruction, escrowId);
      return ok('settled');
  }
}

async function saveTrade(
  client: Query,
  work: MarketWork,
  instruction: MarketFundsInstruction,
  trade: TradeRow | null,
  escrowId: string,
  phase: TradePhase,
): Promise<void> {
  const at = instruction.decision?.at.toString() ?? null;
  if (trade) {
    await client.query(
      `UPDATE economy.market_funds_trade SET phase = $3, decided_at = $4 WHERE book_id = $1 AND trade_id = $2`,
      [work.bookId, instruction.tradeId, phase, at],
    );
    return;
  }
  await client.query(
    `INSERT INTO economy.market_funds_trade (book_id, trade_id, binding, escrow_id, funded, phase, decided_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
    [work.bookId, instruction.tradeId, binding(work, instruction), escrowId, phase === 'prepared', phase, at],
  );
}

/** Ledger owner. An authenticated coordinator lookup supplies complete immutable work by live lease locator. */
export function createMarketFunds(database: MarketStoreDatabase, bookId: string, authority: MarketFundsAuthority) {
  if (!isEconomyBookId(bookId)) throw new Error('Invalid market funds book ID');

  return {
    async execute(claim: MarketFundsClaim): Promise<Result<Receipt>> {
      if (!validMarketFundsClaim(claim, bookId)) return { kind: 'invalid_request' };
      const work = await authority.findIssuedWork(claim);
      if (!work || work.id !== claim.instructionId) return { kind: 'unproved_work' };
      const instruction = readFundsInstruction(work, bookId);
      if (!instruction) return { kind: 'unproved_work' };
      return database.transaction(async (client) => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('market-funds', $1::text, $2::text)::text, 0))`,
          [bookId, instruction.tradeId],
        );
        const prior = await readReceipt(client, work);
        if (prior) return prior.matches ? ok({ receiptId: prior.receiptId }) : { kind: 'conflict' };
        const trade = await readTrade(client, work, instruction);
        if (trade && !trade.matches) return { kind: 'conflict' };
        // The random v4 UUID has no routed account authority and stays private to this native trade.
        const escrowId = trade?.escrowId ?? crypto.randomUUID();
        if ([instruction.buyerId, instruction.sellerId, instruction.money.feeAccountId].includes(escrowId))
          return { kind: 'conflict' };
        return withLedgerEffects(client, async () => {
          const applied = await applyFundsWork(client, bookId, instruction, trade, escrowId);
          if (applied.kind !== 'ok') return applied;
          await saveTrade(client, work, instruction, trade, escrowId, applied.value);
          const receiptId = crypto.randomUUID();
          await client.query(
            `INSERT INTO economy.market_funds_receipt (book_id, instruction_id, trade_id, work, receipt_id)
             VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [bookId, work.id, instruction.tradeId, encodeMarketRecord(work), receiptId],
          );
          return ok({ receiptId });
        });
      });
    },

    async findReceipt(work: MarketWork, receiptId: string): Promise<Receipt | null> {
      if (!readFundsInstruction(work, bookId)) return null;
      const row = await database.read((client) => readReceipt(client, work));
      return row?.matches && row.receiptId === receiptId ? { receiptId } : null;
    },
  };
}
