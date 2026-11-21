import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';
import { ConfigError } from '../commerce/config.ts';
import { isEconomyBookId } from '../economy/contract.ts';
import { createNativeMarket } from '../economy/storage/market-runner.ts';
import type { MarketStoreDatabase } from '../economy/storage/market-store.ts';
import { WORK_APPLICATION } from '../work/client.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import { createNativeEconomyDatabase } from './economy.ts';
import { createNativeEconomySpotWork } from './economy-spot.ts';

type BookBinding = Readonly<{ bookId: string; node: string }>;
type MarketBinding = BookBinding & Readonly<{ itemHomeId: string }>;
type MatchContinuation = Readonly<{ kind: 'match-page'; root: string; after: string; book: BookBinding }>;

type NamedSchedule = Readonly<{ name: string; workflow: string }>;
export const ECONOMY_SPOT_OWNER_WORK = {
  name: 'economy.spot.ownerWork.every-10-seconds',
  workflow: 'economy.spot.ownerWork',
} satisfies NamedSchedule;
export const ECONOMY_MARKET_OWNER_WORK = {
  name: 'economy.market.ownerWork.every-10-seconds',
  workflow: 'economy.market.ownerWork',
} satisfies NamedSchedule;
const marketWindow = 16;

function binding(env: WorkContext['env']) {
  const bookId = env.KERNEL_ECONOMY_BOOK_ID;
  const node = env.KERNEL_ECONOMY_NODE;
  const itemHomeId = env.KERNEL_ECONOMY_MARKET_ITEM_HOME_ID;
  if (bookId !== undefined && !isEconomyBookId(bookId)) throw new ConfigError('KERNEL_ECONOMY_BOOK_ID');
  if (node !== undefined && (!node.trim() || node.length > 255)) throw new ConfigError('KERNEL_ECONOMY_NODE');
  if (itemHomeId !== undefined && !isEconomyBookId(itemHomeId))
    throw new ConfigError('KERNEL_ECONOMY_MARKET_ITEM_HOME_ID');
  if (bookId === undefined || node === undefined) return {};
  const spot = { bookId, node };
  return { spot, market: itemHomeId === undefined ? undefined : { ...spot, itemHomeId } };
}

function matchesBook(value: unknown, expected: BookBinding): value is BookBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    'bookId' in value &&
    'node' in value &&
    value.bookId === expected.bookId &&
    value.node === expected.node
  );
}

function matchesMarket(value: unknown, expected: MarketBinding): boolean {
  return matchesBook(value, expected) && 'itemHomeId' in value && value.itemHomeId === expected.itemHomeId;
}

async function reconcileSchedule(client: WorkContext['client'], schedule: NamedSchedule, target?: BookBinding) {
  const prior = await client.getSchedule(schedule.name);
  if (prior && (prior.workflowName !== schedule.workflow || prior.applicationName !== WORK_APPLICATION))
    throw new Error(`Unexpected owner of Economy schedule ${schedule.name}`);
  if (!target) {
    if (prior) await client.deleteSchedule(schedule.name);
    return;
  }
  await client.applySchedules([
    {
      scheduleName: schedule.name,
      workflowName: schedule.workflow,
      schedule: '*/10 * * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
      context: target,
    },
  ]);
}

function marketDatabase(pool: Pool): MarketStoreDatabase {
  const database = createNativeEconomyDatabase(pool);
  async function native<Value>(
    lane: 'read' | 'transaction',
    work: (client: Pick<PoolClient, 'query'>) => Promise<Value>,
  ) {
    const result = await database[lane](async (client) => ({ kind: 'ok', value: await work(client) }));
    if (result.kind !== 'ok') throw new Error('Economy market native store unavailable');
    return result.value;
  }
  return {
    read: (work) => native('read', work),
    transaction: (work) => native('transaction', work),
  };
}

function registerSpot(context: WorkContext, book?: BookBinding) {
  if (!book) {
    DBOS.registerWorkflow(async () => ({ kind: 'disabled' }), { name: ECONOMY_SPOT_OWNER_WORK.workflow });
    return;
  }
  const work = createNativeEconomySpotWork(context.pool, book);
  const scan = DBOS.registerStep(
    async (after?: string) => {
      try {
        const result = await work.readyMatches(after);
        if (result.kind !== 'ok') return null;
        return result.value.map(({ instrumentId, revision }) => ({ instrumentId, revision: revision.toString() }));
      } catch {
        return null;
      }
    },
    { name: 'economy.spot.scanMatches' },
  );
  const match = DBOS.registerStep(
    async (instrumentId: string, revision: string) => {
      try {
        return (await work.match(instrumentId, BigInt(revision))).kind === 'ok';
      } catch {
        return false;
      }
    },
    { name: 'economy.spot.advanceMatch' },
  );
  const readyFills = DBOS.registerStep(
    async () => {
      try {
        const result = await work.readyFills();
        return result.kind === 'ok' ? result.value : null;
      } catch {
        return null;
      }
    },
    { name: 'economy.spot.scanFills' },
  );
  const settle = DBOS.registerStep(
    async (fillId: string) => {
      try {
        const claim = await work.claimFill(fillId);
        return claim.kind === 'ok' && (await work.settleFill(fillId, claim.value.token)).kind === 'ok';
      } catch {
        return false;
      }
    },
    { name: 'economy.spot.advanceFill' },
  );
  const continueScan = DBOS.registerStep(
    async (input: MatchContinuation) => {
      const id = createHash('sha256')
        .update(JSON.stringify([input.book, input.root, input.after]))
        .digest('hex');
      await context.client.enqueue(
        {
          workflowName: ECONOMY_SPOT_OWNER_WORK.workflow,
          queueName: 'maintenance',
          workflowID: `economy:spot:page:${id}`,
          workflowIDReusePolicy: 'return-existing',
        },
        input,
      );
    },
    { name: 'economy.spot.continueScan' },
  );

  DBOS.registerWorkflow(
    async (argument?: Date | MatchContinuation, scheduledBook?: unknown) => {
      const continuation =
        typeof argument === 'object' && argument !== null && 'kind' in argument && argument.kind === 'match-page'
          ? argument
          : undefined;
      if (!matchesBook(continuation?.book ?? scheduledBook, book)) return { kind: 'disabled' };
      let matched = 0;
      let settled = 0;
      let deferred = 0;
      const page = await scan(continuation?.after);
      // An individual match or a failed scan leaves accepted work in the native book.
      // Later entries still advance, once each, on the same scheduled pass.
      if (!page) deferred++;
      for (const candidate of page ?? []) {
        if (await match(candidate.instrumentId, candidate.revision)) matched++;
        else deferred++;
      }
      if (!continuation) {
        const fills = await readyFills();
        if (!fills) deferred++;
        for (const fillId of fills ?? []) {
          if (await settle(fillId)) settled++;
          else deferred++;
        }
      }
      const after = page?.at(-1)?.instrumentId;
      if (after !== undefined) {
        const next = await scan(after);
        if (next?.length)
          await continueScan({ kind: 'match-page', root: continuation?.root ?? DBOS.workflowID!, after, book });
        else if (!next) deferred++;
      }
      return { kind: 'advanced', matched, settled, deferred };
    },
    { name: ECONOMY_SPOT_OWNER_WORK.workflow },
  );
}

function registerMarket(context: WorkContext, target?: MarketBinding) {
  if (!target) {
    DBOS.registerWorkflow(async () => ({ kind: 'disabled' }), { name: ECONOMY_MARKET_OWNER_WORK.workflow });
    return;
  }
  const market = createNativeMarket(marketDatabase(context.pool), target);
  const sweep = DBOS.registerStep(() => market.sweep(marketWindow), { name: 'economy.market.advanceOwners' });
  DBOS.registerWorkflow(
    async (_fire?: Date, scheduledBook?: unknown) => {
      if (!matchesMarket(scheduledBook, target)) return { kind: 'disabled' };
      return sweep();
    },
    { name: ECONOMY_MARKET_OWNER_WORK.workflow },
  );
}

export const economyOwnerWorkModule: WorkModule = {
  name: 'economy',
  async register(context) {
    const { spot, market } = binding(context.env);
    registerSpot(context, spot);
    registerMarket(context, market);
    await reconcileSchedule(context.client, ECONOMY_SPOT_OWNER_WORK, spot);
    await reconcileSchedule(context.client, ECONOMY_MARKET_OWNER_WORK, market);
  },
};
