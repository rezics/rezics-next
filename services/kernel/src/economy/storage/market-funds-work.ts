import type { MarketTradeInstruction } from '../market/trade.ts';
import type { MarketWork } from './market-store.ts';

const key = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const instructionKey = /^market:[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const issuer = '00000000-0000-0000-0000-000000000000';
const max = (1n << 63n) - 1n;
const maxNativeDate = 253402300799999n;
const basisPoints = 10_000n;

type FundsAction = 'prepare_funds' | 'fence_funds_abort' | 'release_funds' | 'escrow_funds' | 'release_proceeds';
export type MarketFundsInstruction = MarketTradeInstruction &
  Readonly<{ kind: FundsAction; money: NonNullable<MarketTradeInstruction['money']> }>;
export type MarketFundsClaim = Readonly<{ bookId: string; instructionId: string; claimId: string }>;

const predecessors: Readonly<Record<FundsAction, readonly string[]>> = {
  prepare_funds: [],
  fence_funds_abort: [],
  release_funds: ['fence_item_abort', 'fence_funds_abort'],
  escrow_funds: ['prepare_item', 'prepare_funds'],
  release_proceeds: ['deliver_item'],
};

export function validMarketFundsClaim(claim: MarketFundsClaim, bookId: string): boolean {
  return claim.bookId === bookId && instructionKey.test(claim.instructionId) && uuid.test(claim.claimId);
}

export function readFundsInstruction(work: MarketWork, bookId: string): MarketFundsInstruction | null {
  if (
    work.kind !== 'trade' ||
    work.bookId !== bookId ||
    work.owner.kind !== 'ledger' ||
    work.owner.id !== bookId ||
    !key.test(work.listingId)
  )
    return null;
  const { instruction } = work;
  const { kind, money, decision, prerequisites, tradeId } = instruction;
  if (
    !(
      kind === 'prepare_funds' ||
      kind === 'fence_funds_abort' ||
      kind === 'release_funds' ||
      kind === 'escrow_funds' ||
      kind === 'release_proceeds'
    ) ||
    money === null ||
    instruction.item !== null ||
    instruction.ownerId !== bookId ||
    money.ledgerBookId !== bookId ||
    ![money.assetId, tradeId].every((id) => key.test(id)) ||
    work.id !== `market:${kind}:${tradeId}` ||
    instruction.id !== work.id ||
    instruction.reservationId !== `market:funds:${tradeId}` ||
    ![instruction.buyerId, instruction.sellerId, money.feeAccountId].every((id) => uuid.test(id) && id !== issuer) ||
    new Set([instruction.buyerId, instruction.sellerId, money.feeAccountId]).size !== 3 ||
    instruction.prepareUntil <= 0n ||
    instruction.prepareUntil > maxNativeDate ||
    money.units <= 0n ||
    money.units > max ||
    money.policyVersion <= 0n ||
    money.policyVersion > max ||
    money.feeBps < 0n ||
    money.feeBps > basisPoints ||
    money.feeUnits !== (money.units * money.feeBps) / basisPoints ||
    money.sellerUnits !== money.units - money.feeUnits
  )
    return null;
  const requires = predecessors[kind];
  if (
    prerequisites.length !== requires.length ||
    prerequisites.some(
      (prior, index) => prior.instructionId !== `market:${requires[index]}:${tradeId}` || !key.test(prior.receiptId),
    ) ||
    (kind === 'prepare_funds'
      ? decision !== null
      : decision === null ||
        decision.at < 0n ||
        decision.at > max ||
        (kind === 'fence_funds_abort' || kind === 'release_funds'
          ? decision.kind !== 'abort'
          : decision.kind !== 'commit' || decision.at >= instruction.prepareUntil))
  )
    return null;
  return { ...instruction, kind, money };
}
