import type { Pool } from 'pg';
import { lockNativeEconomyAdmission } from '../access/index.ts';
import type { SpotAccessPort, SpotAccessResult } from '../economy/spot-routes.ts';
import { createSpotStore } from '../economy/storage/spot-store.ts';
import { ProblemError } from '../http/problem-error.ts';
import { createNativeEconomyDatabase } from './economy.ts';

type ConfiguredBook = Readonly<{ bookId: string; node: string }>;
type SpotStore = ReturnType<typeof createSpotStore>;

export function createNativeEconomySpot(pool: Pool, { bookId, node }: ConfiguredBook): SpotAccessPort {
  async function withOwner<T>(
    input: Readonly<{ accountId: string; deadline: number }>,
    run: (store: SpotStore) => Promise<SpotAccessResult<T>>,
  ): Promise<SpotAccessResult<T>> {
    const database = createNativeEconomyDatabase(pool, input.deadline);
    const result = await database.transaction<SpotAccessResult<T>>(async (client) => {
      const allowed = await lockNativeEconomyAdmission(client, { accountId: input.accountId, node });
      if (allowed === 'unavailable') return { kind: 'unavailable' };
      if (allowed !== 'allowed') throw new ProblemError('platform_closed');
      const store = createSpotStore({ read: (work) => work(client), transaction: (work) => work(client) }, bookId);
      return { kind: 'ok', value: await run(store) };
    });
    return result.kind === 'ok' ? result.value : result;
  }
  return {
    bookId,
    listInstruments: (input) => withOwner(input, (store) => store.listInstruments(input.limit, input.after)),
    readInstrument: (input) => withOwner(input, (store) => store.readBook(input.instrumentId)),
    readQuote: (input) => withOwner(input, (store) => store.readQuote(input.instrumentId)),
    readTrades: (input) => withOwner(input, (store) => store.readTrades(input.instrumentId, input.limit, input.after)),
    listOwnOrders: (input) =>
      withOwner(input, (store) => store.listOwnOrders(input.instrumentId, input.accountId, input.limit, input.after)),
    readOrder: (input) =>
      withOwner(input, (store) => store.readOwnOrder(input.instrumentId, input.orderId, input.accountId)),
    readOrderFills: (input) =>
      withOwner(input, (store) =>
        store.readOrderFills(input.instrumentId, input.orderId, input.accountId, input.limit, input.after),
      ),
    place: (input) => withOwner(input, (store) => store.place(input.instrumentId, input)),
    cancel: (input) => withOwner(input, (store) => store.cancel(input.instrumentId, input.orderId, input.accountId)),
  };
}

/** Trusted work source. Each named advance takes its own bounded native transaction. */
export function createNativeEconomySpotWork(pool: Pool, { bookId }: ConfiguredBook) {
  const { provision, readyMatches, match, readyFills, claimFill, settleFill } = createSpotStore(
    createNativeEconomyDatabase(pool),
    bookId,
  );
  return { provision, readyMatches, match, readyFills, claimFill, settleFill };
}
