import { isEconomyBookId } from '../contract.ts';
import type { MarketTradeInstruction } from '../market/trade.ts';
import type { MarketWork } from './market-store.ts';

export const custodyKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const instructionKey = /^market:[a-z_]+:[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const claimKey = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const maxItemGeneration = (1n << 63n) - 1n;

type ItemClaim = NonNullable<MarketTradeInstruction['item']>;
type ItemAction = 'prepare_item' | 'fence_item_abort' | 'release_item' | 'deliver_item';

export type ItemWorkClaim = Readonly<{ bookId: string; instructionId: string; claimId: string }>;
export type ItemTradeInstruction = MarketTradeInstruction & Readonly<{ kind: ItemAction; item: ItemClaim }>;
export type BoundItemWork =
  | Readonly<{ kind: 'cancel'; item: ItemClaim }>
  | Readonly<{ kind: 'trade'; item: ItemClaim; instruction: ItemTradeInstruction }>;

export function validItemWorkClaim(claim: ItemWorkClaim): boolean {
  return isEconomyBookId(claim.bookId) && instructionKey.test(claim.instructionId) && claimKey.test(claim.claimId);
}

function validItemClaim(claim: ItemClaim, homeId: string): boolean {
  return (
    claim.homeId === homeId &&
    [claim.itemId, claim.holderId, claim.reservationId].every((id) => custodyKey.test(id)) &&
    claim.generation > 0n &&
    claim.generation < maxItemGeneration
  );
}

export function readBoundItemWork(work: MarketWork, homeId: string): BoundItemWork | null {
  if (
    work.owner.kind !== 'item' ||
    work.owner.id !== homeId ||
    !isEconomyBookId(work.bookId) ||
    !custodyKey.test(work.listingId)
  )
    return null;
  if (work.kind === 'cancel_listing') {
    return work.id === `market:cancel:${work.listingId}` && validItemClaim(work.reservation, homeId)
      ? { kind: 'cancel', item: work.reservation }
      : null;
  }
  const { instruction } = work;
  const { kind, item, tradeId, decision, prerequisites } = instruction;
  if (
    !(kind === 'prepare_item' || kind === 'fence_item_abort' || kind === 'release_item' || kind === 'deliver_item') ||
    item === null ||
    !validItemClaim(item, homeId) ||
    instruction.money !== null ||
    ![tradeId, instruction.buyerId].every((id) => custodyKey.test(id)) ||
    work.id !== `market:${kind}:${tradeId}` ||
    instruction.id !== work.id ||
    instruction.ownerId !== homeId ||
    instruction.reservationId !== item.reservationId ||
    instruction.sellerId !== item.holderId ||
    instruction.buyerId === item.holderId ||
    instruction.prepareUntil <= 0n ||
    instruction.prepareUntil > maxItemGeneration
  )
    return null;
  const required =
    kind === 'deliver_item'
      ? ['escrow_funds']
      : kind === 'release_item'
        ? ['fence_item_abort', 'fence_funds_abort']
        : [];
  if (
    prerequisites.length !== required.length ||
    prerequisites.some(
      (prior, index) =>
        prior.instructionId !== `market:${required[index]}:${tradeId}` || !custodyKey.test(prior.receiptId),
    ) ||
    (kind === 'prepare_item'
      ? decision !== null
      : decision === null ||
        decision.kind !== (kind === 'deliver_item' ? 'commit' : 'abort') ||
        decision.at < 0n ||
        decision.at > maxItemGeneration ||
        (kind === 'deliver_item' && decision.at >= instruction.prepareUntil))
  )
    return null;
  return { kind: 'trade', item, instruction: { ...instruction, kind, item } };
}
