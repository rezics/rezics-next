import { createItemCustody } from './item-custody.ts';
import { createMarketFunds } from './market-funds.ts';
import { createMarketStore, type MarketStoreDatabase } from './market-store.ts';

type Sweep = {
  decisions: { tradeId: string; kind: 'abort' | 'commit' }[];
  acknowledged: string[];
  retry: { id: string; reason: string }[];
};

/** One internal book and its configured item home. The owners resolve only coordinator-issued live leases. */
export function createNativeMarket(database: MarketStoreDatabase, config: { bookId: string; itemHomeId: string }) {
  const { bookId, itemHomeId } = config;
  const itemOwner = { kind: 'item', id: itemHomeId } as const;
  const moneyOwner = { kind: 'ledger', id: bookId } as const;
  let market: ReturnType<typeof createMarketStore>;
  const item = createItemCustody(database, itemHomeId, {
    findIssuedWork: (claim) =>
      claim.bookId === bookId && claim.homeId === itemHomeId
        ? market.findIssuedWork(itemOwner, claim.instructionId, claim.claimId)
        : Promise.resolve(null),
  });
  const funds = createMarketFunds(database, bookId, {
    findIssuedWork: (claim) => market.findIssuedWork(moneyOwner, claim.instructionId, claim.claimId),
  });
  market = createMarketStore(database, bookId, {
    findListingProof: item.findListingProof,
    findReceipt: (work, receiptId) =>
      work.owner.kind === 'item' ? item.findReceipt(work, receiptId) : funds.findReceipt(work, receiptId),
  });

  return {
    item,
    funds,
    market,
    /** Four independently bounded indexed windows. A failed attempt stays leased for the next sweep. */
    async sweep(limit: number): Promise<Sweep> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid market sweep limit');
      const result: Sweep = { decisions: [], acknowledged: [], retry: [] };
      for (const kind of ['abort', 'commit'] as const) {
        const candidates = await market.listDecisionCandidates(kind, limit);
        if (candidates.kind !== 'ok') continue;
        for (const { tradeId, revision } of candidates.value) {
          try {
            const decision = await market.decide(tradeId, revision, kind);
            if (decision.kind === 'ok') result.decisions.push({ tradeId, kind });
            else result.retry.push({ id: tradeId, reason: decision.kind });
          } catch {
            result.retry.push({ id: tradeId, reason: 'decision_unavailable' });
          }
        }
      }
      for (const [owner, handler] of [
        [itemOwner, item],
        [moneyOwner, funds],
      ] as const) {
        const pending = await market.listReady(owner, limit);
        if (pending.kind !== 'ok') continue;
        for (const { id } of pending.value) {
          try {
            const claimId = crypto.randomUUID();
            const claimed = await market.claim(owner, id, claimId);
            if (claimed.kind !== 'ok') continue;
            const receipt = await handler.execute({ bookId, instructionId: id, claimId });
            if (receipt.kind !== 'ok') {
              result.retry.push({ id, reason: receipt.kind });
              continue;
            }
            const ack = await market.acknowledge(owner, id, claimId, receipt.value.receiptId);
            if (ack.kind === 'ok') result.acknowledged.push(id);
            else result.retry.push({ id, reason: ack.kind });
          } catch {
            result.retry.push({ id, reason: 'work_unavailable' });
          }
        }
      }
      return result;
    },
  };
}
