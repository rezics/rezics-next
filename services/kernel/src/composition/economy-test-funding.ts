import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { lockNativeEconomyAdmission } from '../access/index.ts';
import { ConfigError } from '../commerce/config.ts';
import { withBoundedCommandConnection, withBoundedReadConnection } from '../database/pool.ts';
import { isEconomyBookId } from '../economy/contract.ts';
import { createEconomyLedger, type EconomyDatabase } from '../economy/ledger.ts';
import type { FundingIntent, ProviderBinding } from '../economy/settlement/funding.ts';
import { createFundingLedgerBinder } from '../economy/storage/funding-ledger.ts';
import { createFundingStore, type FundingLedgerBinder } from '../economy/storage/funding-store.ts';
import {
  createDeterministicFundingRail,
  runDeterministicFundingDispatch,
} from '../economy/storage/funding-test-rail.ts';
import type { EconomyTestFundingPort } from '../economy/test-funding-routes.ts';
import { ProblemError } from '../http/problem-error.ts';

type TestFundingConfig = Readonly<{ namespace: string; assetId: string; mode: 'test' }>;
const workBudget = 2_000;

export function readEconomyTestFundingConfig(env: NodeJS.ProcessEnv): TestFundingConfig | undefined {
  if (env.NODE_ENV === 'production') return;
  const assetId = env.KERNEL_ECONOMY_TEST_FUNDING_ASSET_ID;
  const namespace = env.KERNEL_ECONOMY_TEST_FUNDING_NAMESPACE;
  const mode = env.KERNEL_ECONOMY_TEST_FUNDING_MODE;
  if (assetId === undefined && namespace === undefined && mode === undefined) return;
  if (mode !== 'test') throw new ConfigError('KERNEL_ECONOMY_TEST_FUNDING_MODE');
  if (assetId === undefined || !isEconomyBookId(assetId)) throw new ConfigError('KERNEL_ECONOMY_TEST_FUNDING_ASSET_ID');
  if (namespace === undefined || !isEconomyBookId(namespace))
    throw new ConfigError('KERNEL_ECONOMY_TEST_FUNDING_NAMESPACE');
  return { assetId, namespace, mode };
}

function transaction<Value>(pool: Pool, deadline: number, work: (client: PoolClient) => Promise<Value>) {
  return withBoundedCommandConnection(pool, deadline, async (client) => {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  });
}

function scopedId(parts: readonly string[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function requireResult<Value>(outcome: { kind: 'ok'; value: Value } | { kind: string }): Value {
  if (outcome.kind === 'ok' && 'value' in outcome) return outcome.value;
  if (outcome.kind === 'asset_missing') throw new ProblemError('not_found');
  throw new ProblemError('dependency_unavailable');
}

/** Synthetic test deposits and withdrawals. The request path queues work and keeps actor locks until commit. */
export function createNativeEconomyTestFunding(
  pool: Pool,
  config: TestFundingConfig & { bookId: string; node: string },
) {
  const { assetId, bookId, namespace, node } = config;
  if (
    process.env.NODE_ENV === 'production' ||
    config.mode !== 'test' ||
    ![assetId, bookId, namespace].every(isEconomyBookId) ||
    !node.trim() ||
    node.length > 255
  )
    throw new TypeError('Invalid Economy test funding bindings');

  function provider(walletId: string): ProviderBinding {
    return {
      namespace,
      mode: 'test',
      destinationRef: scopedId(['test-funding-destination', bookId, namespace, walletId]),
    };
  }

  function admits(intent: FundingIntent): boolean {
    return (
      intent.bookId === bookId &&
      intent.assetId === assetId &&
      intent.provider.mode === 'test' &&
      intent.provider.namespace === namespace &&
      intent.provider.destinationRef === provider(intent.walletId).destinationRef
    );
  }

  const binder = createFundingLedgerBinder(bookId);
  const requestBinder: FundingLedgerBinder = {
    ...binder,
    async reserve(client, reservation) {
      const ledger = createEconomyLedger({ transaction: (work) => work(client), read: (work) => work(client) }, bookId);
      const available = requireResult(
        await ledger.lockRecoverableFundingWallet({
          assetId: reservation.assetId,
          accountId: reservation.walletId,
          provider: provider(reservation.walletId),
        }),
      );
      if (BigInt(available) < BigInt(reservation.units)) throw new ProblemError('conflict');
      return binder.reserve(client, reservation);
    },
  };
  const ownerStore = createFundingStore(
    {
      transaction: (work) => transaction(pool, Date.now() + workBudget, work),
      read: (work) => withBoundedReadConnection(pool, Date.now() + workBudget, work),
    },
    bookId,
    binder,
  );
  const rail = { ...createDeterministicFundingRail(namespace, () => 'confirmed'), admits };

  function request<Value>(
    input: Readonly<{ accountId: string; deadline: number }>,
    work: (store: ReturnType<typeof createFundingStore>, accountId: string) => Promise<Value>,
  ) {
    const accountId = input.accountId.toLowerCase();
    return transaction(pool, input.deadline, async (client) => {
      const admission = await lockNativeEconomyAdmission(client, { node, accountId });
      if (admission === 'source_denied') throw new ProblemError('platform_closed');
      if (admission !== 'allowed') throw new ProblemError('dependency_unavailable');
      const database: EconomyDatabase = { transaction: (run) => run(client), read: (run) => run(client) };
      return work(createFundingStore(database, bookId, requestBinder), accountId);
    });
  }

  const port: EconomyTestFundingPort = {
    begin: (input) =>
      request(input, async (store, accountId) => {
        const intentId = scopedId(['test-funding-intent', bookId, accountId, input.operationId]);
        const outcome = requireResult(
          await store.begin({
            intentId,
            bookId,
            assetId,
            walletId: accountId,
            direction: input.direction,
            units: input.amount,
            provider: provider(accountId),
          }),
        );
        if (outcome.kind === 'invalid') throw new ProblemError('invalid_request');
        if (outcome.kind === 'not_found') throw new ProblemError('not_found');
        if (outcome.kind === 'conflict') throw new ProblemError('idempotency_conflict');
        const dispatch = requireResult(await store.prepare(intentId));
        if (dispatch.kind !== 'queued' && dispatch.kind !== 'complete')
          throw new ProblemError('dependency_unavailable');
        return { intentId };
      }),
    read: (input) =>
      request(input, async (store, accountId) => {
        const state = requireResult(await store.read(input.intentId));
        if (!state || state.intent.walletId !== accountId || !admits(state.intent)) throw new ProblemError('not_found');
        const { intentId, direction, units } = state.intent;
        return { intentId, assetId, direction, amount: units, phase: state.phase, reversedAmount: state.reversedUnits };
      }),
  };

  return {
    port,
    /** An internal owner run, never an HTTP action. The runner proves the exact synthetic binding before claiming. */
    dispatch: (intentId: string) => runDeterministicFundingDispatch(ownerStore, rail, intentId, crypto.randomUUID()),
  };
}
