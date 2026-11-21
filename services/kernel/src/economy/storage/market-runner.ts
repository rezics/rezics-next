import { createItemCustody } from './item-custody.ts';
import { createMarketFunds } from './market-funds.ts';
import { createMarketStore, type MarketStoreDatabase, type MarketWorkOwner } from './market-store.ts';

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

  async function executeReady(result: Sweep, owner: MarketWorkOwner, id: string, tradeId?: string): Promise<void> {
    try {
      const claimId = crypto.randomUUID();
      const claimed = await market.claim(owner, id, claimId, tradeId);
      if (claimed.kind !== 'ok') return;
      const handler = owner.kind === 'item' ? item : funds;
      const receipt = await handler.execute({ bookId, instructionId: id, claimId });
      if (receipt.kind !== 'ok') {
        result.retry.push({ id, reason: receipt.kind });
        return;
      }
      const ack = await market.acknowledge(owner, id, claimId, receipt.value.receiptId);
      if (ack.kind === 'ok') result.acknowledged.push(id);
      else result.retry.push({ id, reason: ack.kind });
    } catch {
      result.retry.push({ id, reason: 'work_unavailable' });
    }
  }

  return {
    item,
    funds,
    market,
    /** Resume one retained trade. A later call can handle work newly issued by this page's acknowledgments. */
    async resumeTrade(tradeId: string) {
      const decision = await market.decideReadyTrade(tradeId, itemHomeId);
      if (decision.kind !== 'ok') return decision;
      const result: Sweep = { decisions: [], acknowledged: [], retry: [] };
      if (decision.value !== null) result.decisions.push({ tradeId, kind: decision.value.kind });
      for (const { id, owner } of await market.listReadyForTrade(tradeId, itemHomeId))
        await executeReady(result, owner, id, tradeId);
      return { kind: 'ok' as const, value: result };
    },
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
      for (const owner of [itemOwner, moneyOwner]) {
        const pending = await market.listReady(owner, limit);
        if (pending.kind !== 'ok') continue;
        for (const { id } of pending.value) await executeReady(result, owner, id);
      }
      return result;
    },
  };
}
