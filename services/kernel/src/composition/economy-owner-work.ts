import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';
import { ConfigError } from '../commerce/config.ts';
import { isEconomyBookId, type ExpiredAssetProgram } from '../economy/contract.ts';
import { createMarketRepairQueue, runMarketRepairWindow } from '../economy/storage/market-repair.ts';
import { createNativeMarket } from '../economy/storage/market-runner.ts';
import type { MarketStoreDatabase } from '../economy/storage/market-store.ts';
import { createSpotStore } from '../economy/storage/spot-store.ts';
import { WORK_APPLICATION } from '../work/client.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import { createNativeEconomyDatabase, createNativeEconomyLedger } from './economy.ts';
import { createNativeEconomySpotWork } from './economy-spot.ts';
import { ECONOMY_SPOT_MATCH_WAKE, type SpotMatchWake } from './economy-spot-wake.ts';

type BookBinding = Readonly<{ bookId: string; node: string }>;
type MarketBinding = BookBinding & Readonly<{ itemHomeId: string }>;
type MatchContinuation = Readonly<{ kind: 'match-page'; root: string; after: string; book: BookBinding }>;

type CreditPage = Readonly<{
  kind: 'credit-page';
  root: string;
  book: BookBinding;
  program: ExpiredAssetProgram;
  afterAccount: string | null;
}>;

type NamedSchedule = Readonly<{ name: string; workflow: string }>;
export const ECONOMY_SPOT_OWNER_WORK = {
  name: 'economy.spot.ownerWork.every-10-seconds',
  workflow: 'economy.spot.ownerWork',
} satisfies NamedSchedule;
export const ECONOMY_MARKET_OWNER_WORK = {
  name: 'economy.market.ownerWork.every-10-seconds',
  workflow: 'economy.market.ownerWork',
} satisfies NamedSchedule;
export const ECONOMY_CREDIT_EXPIRY_WORK = {
  name: 'economy.creditExpiry.every-10-seconds',
  workflow: 'economy.creditExpiry',
} satisfies NamedSchedule;
const marketWindow = 16;
const creditWindow = 32;

function binding(env: WorkContext['env']) {
  const bookId = env.KERNEL_ECONOMY_BOOK_ID;
  const node = env.KERNEL_ECONOMY_NODE;
  const itemHomeId = env.KERNEL_ECONOMY_MARKET_ITEM_HOME_ID;
  if (bookId !== undefined && !isEconomyBookId(bookId)) throw new ConfigError('KERNEL_ECONOMY_BOOK_ID');
  if (node !== undefined && (!node.trim() || node.length > 255)) throw new ConfigError('KERNEL_ECONOMY_NODE');
  if (itemHomeId !== undefined && !isEconomyBookId(itemHomeId))
    throw new ConfigError('KERNEL_ECONOMY_MARKET_ITEM_HOME_ID');
  if (bookId === undefined || node === undefined) return {};
  const book = { bookId, node };
  return { book, market: itemHomeId === undefined ? undefined : { ...book, itemHomeId } };
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

function registerSpotMatchWake(context: WorkContext, book?: BookBinding) {
  if (!book) {
    DBOS.registerWorkflow(async () => ({ kind: 'disabled' }), { name: ECONOMY_SPOT_MATCH_WAKE });
    return;
  }
  const store = createSpotStore(createNativeEconomyDatabase(context.pool), book.bookId);
  const advance = DBOS.registerStep(
    async ({ instrumentId, sequence }: SpotMatchWake) => {
      try {
        const current = await store.readBook(instrumentId);
        if (current.kind === 'not_found') return { kind: 'stale' };
        if (current.kind !== 'ok') return { kind: 'deferred' };
        if (current.value.matchingSequence?.toString() !== sequence) return { kind: 'stale' };
        // The revision fence under the instrument lock covers concurrent sweeps and later acceptances.
        const result = await store.match(instrumentId, current.value.revision);
        return { kind: result.kind === 'ok' ? 'advanced' : 'deferred' };
      } catch {
        return { kind: 'deferred' };
      }
    },
    { name: 'economy.spot.advanceAccepted' },
  );
  DBOS.registerWorkflow(
    async (input?: unknown) => {
      if (!matchesBook(input, book)) return { kind: 'disabled' };
      if (
        !('instrumentId' in input) ||
        typeof input.instrumentId !== 'string' ||
        !('sequence' in input) ||
        typeof input.sequence !== 'string' ||
        !/^[1-9][0-9]{0,18}$/.test(input.sequence)
      )
        return { kind: 'stale' };
      return advance({ ...book, instrumentId: input.instrumentId, sequence: input.sequence });
    },
    { name: ECONOMY_SPOT_MATCH_WAKE },
  );
}

function registerMarket(context: WorkContext, target?: MarketBinding) {
  if (!target) {
    DBOS.registerWorkflow(async () => ({ kind: 'disabled' }), { name: ECONOMY_MARKET_OWNER_WORK.workflow });
    return;
  }
  const database = marketDatabase(context.pool);
  const market = createNativeMarket(database, target);
  const queue = createMarketRepairQueue(database, target);
  const sweep = DBOS.registerStep(
    async () => {
      try {
        await runMarketRepairWindow(queue, market.resumeTrade);
      } catch {
        // Unsettled requests become due when their leases expire; the ordinary sweep still runs.
      }
      return market.sweep(marketWindow);
    },
    { name: 'economy.market.advanceOwners' },
  );
  DBOS.registerWorkflow(
    async (_fire?: Date, scheduledBook?: unknown) => {
      if (!matchesMarket(scheduledBook, target)) return { kind: 'disabled' };
      return sweep();
    },
    { name: ECONOMY_MARKET_OWNER_WORK.workflow },
  );
}

function registerCreditExpiry(context: WorkContext, book?: BookBinding) {
  if (!book) {
    DBOS.registerWorkflow(async () => ({ kind: 'disabled' }), { name: ECONOMY_CREDIT_EXPIRY_WORK.workflow });
    return;
  }
  const ledger = createNativeEconomyLedger(context.pool, book.bookId);
  const nextProgram = DBOS.registerStep(ledger.nextExpiredAssetProgram, { name: 'economy.creditExpiry.nextProgram' });
  const listAccounts = DBOS.registerStep(ledger.listExpiredProgramCredits, {
    name: 'economy.creditExpiry.listAccounts',
  });
  const expire = DBOS.registerStep(
    async (assetId: string, accountId: string) => {
      try {
        return (await ledger.expireProgramCredits({ assetId, accountId })).kind === 'ok';
      } catch {
        return false;
      }
    },
    { name: 'economy.creditExpiry.expireAccount' },
  );
  const retire = DBOS.registerStep(
    async (assetId: string) => {
      try {
        return (await ledger.retireExpiredAssetProgram(assetId)).kind === 'ok';
      } catch {
        return false;
      }
    },
    { name: 'economy.creditExpiry.retireProgram' },
  );
  const enqueueNext = DBOS.registerStep(
    async (page: CreditPage) => {
      const id = createHash('sha256')
        .update(JSON.stringify([page.book, page.root, page.program, page.afterAccount]))
        .digest('hex');
      const handle = await context.client.enqueue(
        {
          workflowName: ECONOMY_CREDIT_EXPIRY_WORK.workflow,
          queueName: 'maintenance',
          workflowID: `economy:credit-expiry:page:${id}`,
          workflowIDReusePolicy: 'return-existing',
        },
        page,
      );
      return handle.workflowID;
    },
    { name: 'economy.creditExpiry.enqueuePage' },
  );

  DBOS.registerWorkflow(
    async (argument?: Date | CreditPage, scheduledBook?: unknown) => {
      const continuation =
        typeof argument === 'object' && argument !== null && 'kind' in argument && argument.kind === 'credit-page'
          ? argument
          : undefined;
      if (!matchesBook(continuation?.book ?? scheduledBook, book)) return { kind: 'disabled' };
      const selected = continuation ? { kind: 'ok' as const, value: continuation.program } : await nextProgram();
      if (selected.kind !== 'ok') return { kind: 'unavailable' };
      const program = selected.value;
      if (!program) return { kind: 'idle' };

      const after = continuation?.afterAccount;
      const page = await listAccounts({
        assetId: program.assetId,
        limit: creditWindow,
        ...(after == null ? {} : { after }),
      });
      let expired = 0;
      let deferred = 0;
      let nextAsset: ExpiredAssetProgram | null = program;
      const nextAccount = page.kind === 'ok' ? page.value.next : null;
      if (page.kind === 'ok') {
        for (const accountId of page.value.accounts) {
          if (await expire(program.assetId, accountId)) expired++;
          else deferred++;
        }
      } else deferred++;
      if (nextAccount === null) {
        // Retirement is conditional on the native wallet check. Retry earlier failures on the next sweep.
        if (!(await retire(program.assetId))) deferred++;
        const following = await nextProgram(program);
        nextAsset = following.kind === 'ok' ? following.value : null;
        if (following.kind !== 'ok') deferred++;
      }
      const next = nextAsset
        ? await enqueueNext({
            kind: 'credit-page',
            root: continuation?.root ?? DBOS.workflowID!,
            book,
            program: nextAsset,
            afterAccount: nextAccount,
          })
        : null;
      return { kind: 'advanced', expired, deferred, next };
    },
    { name: ECONOMY_CREDIT_EXPIRY_WORK.workflow },
  );
}

export const economyOwnerWorkModule: WorkModule = {
  name: 'economy',
  async register(context) {
    const { book, market } = binding(context.env);
    registerSpot(context, book);
    registerSpotMatchWake(context, book);
    registerMarket(context, market);
    registerCreditExpiry(context, book);
    await reconcileSchedule(context.client, ECONOMY_SPOT_OWNER_WORK, book);
    await reconcileSchedule(context.client, ECONOMY_MARKET_OWNER_WORK, market);
    await reconcileSchedule(context.client, ECONOMY_CREDIT_EXPIRY_WORK, book);
  },
};
