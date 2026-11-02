import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import type { CommandTransaction } from '../command/command.ts';
import type { NativeStepWork } from '../semantic/identity-epoch-contract.ts';
import type { HistoryReceivingContext } from './receiving.ts';
import type { IdentitySourceConsumerMaintenanceContext } from '../semantic/identity-source-consumer-maintenance.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { COMMAND_DISPATCH_ALLOWANCE } from '../command/dispatch-lifetime.ts';

const declarations = new WeakMap<NativeStepWork, WorkDimensions>();
const missingTerms = new WeakMap<NativeStepWork, string>();

export function unpricedIdentityHistoryWork(term: string, amount: NativeStepWork): NativeStepWork {
  missingTerms.set(amount, term);
  return amount;
}

/** Accounts SQL does not enumerate Library candidates, run Semantic's identity
 * metadata sweeps, or expand Library witnesses. Those three axes are proven zero
 * for these local bodies. Empty index seeks are declared separately at each site;
 * neither a five-field bound nor result.rowCount proves that axis. */
export function accountHistoryWork(
  rows: number,
  points: number,
  statements: number,
  bytes: number,
  emptySeeks: number,
): NativeStepWork {
  const amount = nativeWork(rows, points, statements, bytes);
  const work: WorkDimensions = Object.freeze({
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: 0,
    nativePoints: points,
    witnessKeys: 0,
    statements,
    bytes,
    emptySeeks,
  });
  if (Object.values(work).some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new TypeError('Invalid Accounts History declaration');
  declarations.set(amount, work);
  return amount;
}

/** This returns a price, never authority. Copied/foreign five-field amounts have
 * no declaration, even when all their visible numbers happen to match. */
export function accountHistoryWorkDeclaration(amount: NativeStepWork): WorkDimensions | undefined {
  return declarations.get(amount);
}

export class IdentityHistoryWorkUnavailable extends Error {
  constructor() {
    super('identity-history-native-funding-unavailable');
  }
}

export const nativeWork = (rows: number, points: number, statements: number, bytes: number): NativeStepWork =>
  Object.freeze({ rows, points, statements, bytes, engineRequests: 0 });

/** Existing Source balance only. Failure and rollback never refund a reservation.
 * Outside that frame the installed History/Work owner remains responsible for its own
 * allocation. An explicit Source token or an active Source frame may never silently skip. */
export async function reserveIdentityHistoryWork(
  pool: Pool,
  amount: NativeStepWork,
  invocation?:
    | Pick<HistoryReceivingContext, 'deadline' | 'identityConsumerWork'>
    | IdentitySourceConsumerMaintenanceContext,
): Promise<void> {
  const history = await import('./agent-identity-retirement.ts');
  history.assertAgentIdentityHistoryUnit(pool, invocation);
  const unit = history.currentAgentIdentityHistoryUnit();
  const owner = await import('../semantic/identity-source-consumer-maintenance.ts');
  history.assertAgentIdentityHistoryUnit(pool, invocation);
  if (invocation !== undefined && (!invocation || typeof invocation !== 'object'))
    throw new IdentityHistoryWorkUnavailable();
  const explicitSourceAuthority = invocation !== undefined && 'identityConsumerWork' in invocation;
  const active = explicitSourceAuthority
    ? (invocation as IdentitySourceConsumerMaintenanceContext)
    : owner.activeIdentitySourceConsumerMaintenance(pool);
  if (!active) {
    if (unit?.prepaid) throw new IdentityHistoryWorkUnavailable();
    return;
  }
  const deadline = invocation === undefined ? active.deadline : invocation.deadline;
  if (
    !Number.isFinite(deadline) ||
    deadline <= Date.now() ||
    !owner.isLiveIdentitySourceConsumerMaintenance(pool, active.identityConsumerWork, deadline)
  )
    throw new IdentityHistoryWorkUnavailable();
  if (unit?.prepaid) {
    // Resolve actual SDK dispatch identities only at the operation boundary. Eager
    // imports here would cycle through the command executor's History hooks.
    const { SDK_MAINTENANCE_DISPATCH } = await import('../work/sdk-retirement-fence.ts');
    history.assertAgentIdentityHistoryUnit(pool, invocation);
    for (const [name, actual] of Object.entries(SDK_MAINTENANCE_DISPATCH)) {
      if (actual !== amount) continue;
      declarations.delete(actual);
      const known = sdkWork[name as keyof typeof sdkWork];
      if (
        known &&
        Object.keys(known).every(
          (field) => actual[field as keyof NativeStepWork] === known[field as keyof NativeStepWork],
        )
      )
        declarations.set(actual, declarations.get(known)!);
    }
    const { IdentityOriginalUnavailable, reserveIdentityOriginalSourceWork } =
      await import('../access/identity-original-admission.ts');
    history.assertAgentIdentityHistoryUnit(pool, invocation);
    const work = declarations.get(amount);
    if (!work || amount.engineRequests !== 0)
      throw new IdentityOriginalUnavailable(
        `identity-history-native-eight-axis-term-unavailable:${missingTerms.get(amount) ?? 'undeclared-native-sql'}`,
      );
    // Do not debit the Source adapter's old five-axis counter as a second charge.
    // This is the actual immutable original Source partition, never local controls.
    reserveIdentityOriginalSourceWork(unit.prepaid.deps, unit.prepaid.parent.original, unit.prepaid.parent.jobId, work);
    history.assertAgentIdentityHistoryUnit(pool, invocation);
    return;
  }
  if (!owner.reserveIdentitySourceConsumerNativeWork(pool, active.identityConsumerWork, amount))
    throw new IdentityHistoryWorkUnavailable();
}

// Retained independent-maintenance envelope. The selected original uses Core's
// actual executable quote below instead, never both charges for the same command.
export const IDENTITY_HISTORY_COMMAND_CONTROL = accountHistoryWork(3, 1, 8, 256, 1);
// Compatibility diagnostic for the stopped, body-only implementation. Core now
// supplies this lifetime; it is no longer a missing selected-command operand.
export const IDENTITY_HISTORY_COMMAND_LIFETIME_UNAVAILABLE =
  'identity-history-native-command-dispatch-lifetime-unavailable';

/** Literal local call bodies. A range seek is ONE empty seek even when its LIMIT+1
 * result bound is 65. Joined point relations each contribute a seek. Controls and
 * scalar native returns have no index seek. These are prices, never grants. */
export const IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK = Object.freeze({
  command: IDENTITY_HISTORY_COMMAND_CONTROL,
  snapshot: accountHistoryWork(1, 0, 4, 128, 0), // BEGIN, setting, COMMIT, failure ROLLBACK
  physicalInspection: accountHistoryWork(148, 8, 12, 11888, 8), // snapshot + eight LIMIT+1 probes
  mapping: accountHistoryWork(4, 4, 3, 16384, 4), // m/w, receiver, domain
  receivingBinding: accountHistoryWork(72, 72, 6, 32768, 8), // mapping + m/w + roles + barrier
  readiness: accountHistoryWork(74, 74, 7, 49152, 10), // binding + m/w receipt
  sdkReceiving: accountHistoryWork(160, 80, 6, 131072, 8), // two bounded binding/authority halves
  nativeWorkRead: accountHistoryWork(1, 1, 1, 64, 1),
  nativeWrite: accountHistoryWork(1, 1, 1, 0, 1),
  nativePairWrite: accountHistoryWork(2, 2, 2, 0, 2),
  nativeAuthoritySeal: accountHistoryWork(3, 3, 2, 0, 3),
  nativeLocatorWrite: accountHistoryWork(4, 4, 4, 0, 4),
  nativeGuardProbe: accountHistoryWork(1, 0, 1, 256, 0),
  durableReceiving: accountHistoryWork(76, 75, 13, 131872, 10),
  releasedDurableReceiving: accountHistoryWork(76, 75, 17, 132000, 10),
  receivingInsert: accountHistoryWork(72, 71, 7, 0, 7),
  roleScope: accountHistoryWork(65, 65, 1, 8192, 1),
  selectedJob: accountHistoryWork(1, 1, 1, 4096, 1),
  selectedBarrier: accountHistoryWork(1, 1, 1, 128, 1),
  selectedProgress: accountHistoryWork(1, 1, 1, 0, 1),
  sdkWriterObservation: accountHistoryWork(3, 2, 1, 8192, 2), // fence and restore domain
  sdkFenceObservation: accountHistoryWork(1, 1, 1, 8192, 1),
  sdkWriterLock: accountHistoryWork(4, 2, 4, 8192, 2), // outer call, domain/fence locks, return
  nativeInventory: accountHistoryWork(202, 202, 5, 65536, 7), // i/p/domain + copy range + 3 role ranges
  recoveryInventory: accountHistoryWork(135, 135, 6, 32768, 10), // i/p/domain/a/r + copy + 2 roles + receipt/event
  recoveryAssociation: accountHistoryWork(2, 2, 1, 512, 3), // copy -> inventory -> recovery
  recoveryReceiving: accountHistoryWork(100, 100, 36, 24576, 3), // event, effects, consumer, enrollment and copy recheck
  seal: accountHistoryWork(16, 16, 7, 64, 7), // erasure, upsert/FKs, family touch
  nativeGuardLocal: accountHistoryWork(71, 70, 5, 40960, 6), // m, partition/domain, work, roles, barrier; excludes Source/SDK
  nativeAbsence: accountHistoryWork(9, 9, 9, 0, 9), // m and eight independent SDK physical keys
  recordedAuthority: accountHistoryWork(1, 1, 1, 122880, 1),
  previousReadiness: accountHistoryWork(1, 1, 1, 106496, 1),
  durableReadiness: accountHistoryWork(1, 1, 1, 65536, 1),
  sourceMappingSnapshot: accountHistoryWork(6, 5, 8, 16640, 5), // envelope + source key + mapping
  retirementSnapshot: accountHistoryWork(7, 6, 8, 33024, 6), // envelope + m/w by original source + mapping
  inventoryReceivingCopy: accountHistoryWork(4, 4, 3, 1024, 4), // receiving/seal/locator + physical row
  sdkObligation: accountHistoryWork(1, 1, 1, 1024, 1),
  familyTouch: accountHistoryWork(12, 12, 4, 0, 4), // erasure + fence upsert/FK + nine-family range
  workInvalidation: accountHistoryWork(846, 846, 261, 0, 326), // watch/65 locators/65 touches
  workWake: accountHistoryWork(128, 65, 65, 0, 65), // role range, 64 pending-job updates
  locatorInvalidation: accountHistoryWork(1678, 1678, 518, 0, 518), // own touch + old/new artifact ranges/touches
  receivingInvalidation: accountHistoryWork(845, 845, 261, 0, 261), // own touch + artifact range/touches
});

// Exact dispatch identities from the installed SDK's single-attempt body. Native
// lock/retire SQL is read in workflow_writer_fence.js, including the writer trigger.
// Each delete's points are its keyed table plus the status FK cascades. Rollback is
// admitted separately BEFORE BEGIN, and remains spent on failure/COMMIT ambiguity.
const sdkWork = Object.freeze({
  rollback: accountHistoryWork(0, 0, 1, 0, 0),
  begin: accountHistoryWork(0, 0, 1, 0, 0),
  settings: accountHistoryWork(1, 0, 1, 128, 0),
  lock: accountHistoryWork(4, 2, 4, 8192, 2),
  retire: accountHistoryWork(8, 5, 9, 32768, 5),
  commit: accountHistoryWork(0, 0, 1, 0, 0),
  'delete-workflow_input': accountHistoryWork(1, 1, 1, 0, 1),
  'delete-workflow_output': accountHistoryWork(1, 1, 1, 0, 1),
  'delete-operation_outputs': accountHistoryWork(64, 1, 1, 0, 1),
  'delete-workflow_status': accountHistoryWork(73, 5, 5, 0, 5),
});

/** The Accounts subdeclaration is deliberately separate from Semantic's complete
 * original declaration. Its missing operands cannot be added as zero or as null
 * totals. Per-call terms below compose cumulatively in the ONE original ledger. */
export const IDENTITY_HISTORY_ACCOUNTS_DECLARATION = Object.freeze({
  version: 1,
  interface: 'withPrepaidAgentIdentityHistoryUnit',
  sourceReceiver: 'withPrepaidIdentitySourceConsumerMaintenance',
  axes: Object.freeze([
    'candidateKeys',
    'nativeRows',
    'identityMetadataRows',
    'nativePoints',
    'witnessKeys',
    'statements',
    'bytes',
    'emptySeeks',
  ] as const),
  engineRequests: 0,
  selectedCommand: COMMAND_DISPATCH_ALLOWANCE,
  // Per invocation of the owning local body; early returns reduce reached sites.
  // Source's complete schedule/repeats remain a separate missing composition term.
  selectedCommandCalls: Object.freeze({
    retirement: 8,
    physicalMinimization: 3,
    physicalFenceReceiving: 4, // two fence observations, before/after each
    selectedContinuation: 1, // pending scheduler update OR final cursor/receiving
  }),
  local: Object.freeze(
    Object.fromEntries(
      Object.entries(IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK).map(([name, amount]) => [name, declarations.get(amount)!]),
    ),
  ),
  sdk: Object.freeze(
    Object.fromEntries(Object.entries(sdkWork).map(([name, amount]) => [name, declarations.get(amount)!])),
  ),
  multiplicities: Object.freeze({
    mapping: 'one initial lookup; every receiving binding repeats its own mapping',
    receivingBinding: 'one initial; one per retirement receiver; two per released fence observation',
    readiness: 'one per registered identity owner readiness call',
    nativeInventory:
      'one initial and one per final current-cut recheck; at most three copies, 64 roles each plus sentinel',
    recoveryInventory: 'one per initial/repeated recovery cut; exactly two copies, 64 roles each plus sentinel',
    sdkWriterObservation: 'two retirement observations; one before physical deletion',
    sdkRetire: 'at most one single attempt; rollback+begin+settings+lock+retire+commit',
    sdkDelete: 'at most one single attempt; rollback+begin+settings+lock+four deletes+commit',
    physical: 'two inspections; eight LIMIT+1 probes per inspection; limits 1,1,1,64,8,64,0,0',
    commands:
      'one selectedCommand.total per reached selected noEffect command, atomically including disjoint cleanup before checkout; independent commands use local.command instead',
    progress: 'one held selected job/barrier and cursor update, followed by original producer progress control',
  }),
  missingTerms: Object.freeze([
    'SourceHistoryNativeAllReachedCalls: original source, accepted recovery, custody, native handoff and final verification',
    'LibraryAllReachedCalls: successful page/current/locked-plan/seal/fence and cleanup on the exact original ledger',
    'SourceHistoryNativeGuard: core.check_agent_identity_history nested Source native function',
    'RecoveryFinalReceiving: disjoint local/Source composition of the two serializer current receiving verifiers',
    'RecoveryReceivingEnrollment: released Search owner enrollment and same-home current verification',
    'SDKPhysicalWriterClosure: independent homes and non-FK physical participants',
  ]),
});

/** Preserve the executor's exact transaction object and its private resource
 * association. Only its query closure changes; no cast creates native authority.
 * Rollback is cleanup from the already prepaid, separate control slot. */
export async function guardIdentityHistoryTransaction(
  pool: Pool,
  context: HistoryReceivingContext,
  tx: CommandTransaction,
): Promise<() => void> {
  const history = await import('./agent-identity-retirement.ts');
  const { IdentityOriginalUnavailable } = await import('../access/identity-original-admission.ts');
  history.assertAgentIdentityHistoryUnit(pool, context);
  if (!history.currentAgentIdentityHistoryUnit()?.prepaid) return () => {};
  let active = true;
  const query = tx.query.bind(tx);
  tx.query = (async (...args: unknown[]) => {
    if (!active) throw new IdentityOriginalUnavailable('identity-history-transaction-ended');
    const rollback = args.length === 1 && args[0] === 'ROLLBACK';
    if (!rollback) history.assertAgentIdentityHistoryUnit(pool, context);
    const value = await Reflect.apply(query, tx, args);
    if (!active) throw new IdentityOriginalUnavailable('identity-history-transaction-ended');
    if (!rollback) history.assertAgentIdentityHistoryUnit(pool, context);
    return value;
  }) as CommandTransaction['query'];
  return () => {
    active = false;
  };
}

/** Released read checkout. A query-only facade has no CommandTransaction resources;
 * it cannot be used to make a foreign read into a same-home native command. */
export async function identityHistoryConnection<T>(
  pool: Pool,
  context: HistoryReceivingContext,
  body: (tx: Pick<PoolClient, 'query'>) => Promise<T>,
): Promise<T> {
  const history = await import('./agent-identity-retirement.ts');
  history.assertAgentIdentityHistoryUnit(pool, context);
  const answer = await withConnection(pool, async (client) => {
    history.assertAgentIdentityHistoryUnit(pool, context);
    const tx = { query: client.query.bind(client) };
    const close = await guardIdentityHistoryTransaction(pool, context, tx);
    try {
      return await body(tx);
    } finally {
      close();
    }
  });
  history.assertAgentIdentityHistoryUnit(pool, context);
  return answer;
}

/** One native attempt. Source and SDK locks belong to the real command transaction.
 * Domain writes here are internal History control state, never a public command receipt. */
export async function identityHistoryCommand<T>(
  pool: Pool,
  context: HistoryReceivingContext,
  body: (tx: CommandTransaction) => Promise<T>,
  partition = 0,
): Promise<T> {
  const history = await import('./agent-identity-retirement.ts');
  history.assertAgentIdentityHistoryUnit(pool, context);
  const unit = history.currentAgentIdentityHistoryUnit();
  const { noEffect, runCommand, withSingleCommandAttempt } = await import('../command/command.ts');
  history.assertAgentIdentityHistoryUnit(pool, context);
  if (unit?.prepaid) {
    const prepaid = unit.prepaid;
    const parent = prepaid.parent;
    const original = parent.original;
    const deadline = parent.deadline;
    const funded = unit.context;
    const client = unit.client;
    const deps = prepaid.deps;
    const registry = deps.registry;
    const { withCommandDispatchLifetime } = await import('../command/dispatch-lifetime.ts');
    history.assertAgentIdentityHistoryUnit(pool, context, client);
    const { IdentityOriginalUnavailable, reserveIdentityOriginalSourceWork } =
      await import('../access/identity-original-admission.ts');
    // Core calls this synchronously immediately around every effect/control await,
    // including its real native COMMIT. Private producer accessors, rather than the
    // captured references alone, authenticate the same grant on every invocation.
    const validate = (): void => {
      history.assertAgentIdentityHistoryUnit(pool, context, client);
      if (
        history.currentAgentIdentityHistoryUnit() !== unit ||
        unit.prepaid !== prepaid ||
        unit.context !== funded ||
        unit.client !== client ||
        prepaid.deps !== deps ||
        deps.pool !== pool ||
        deps.client !== client ||
        deps.registry !== registry ||
        prepaid.parent !== parent ||
        parent.original !== original ||
        parent.deadline !== deadline ||
        context.deadline !== deadline
      )
        throw new IdentityOriginalUnavailable('identity-history-native-command-context-changed');
    };
    validate();
    return withCommandDispatchLifetime(
      pool,
      deadline,
      {
        original,
        validate,
        reserve(allowance) {
          validate();
          if (allowance !== COMMAND_DISPATCH_ALLOWANCE)
            throw new IdentityOriginalUnavailable('identity-history-native-command-allowance-changed');
          // ONE atomic debit holds both effect and cleanup in the original Source
          // partition before checkout. No legacy Source/local charge, refund or
          // post-revocation cleanup reservation. Core owns its same-client ROLLBACK.
          reserveIdentityOriginalSourceWork(deps, original, parent.jobId, allowance.total.work);
          validate();
        },
      },
      () =>
        withSingleCommandAttempt(
          async () =>
            (
              await runCommand(pool, { partition, deadline }, async (tx) => {
                validate();
                const answer = await body(tx);
                validate();
                return noEffect(answer);
              })
            ).value,
        ),
    );
  }
  await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_COMMAND_CONTROL, context);
  const answer = await withSingleCommandAttempt(
    async () =>
      (
        await runCommand(pool, { partition, deadline: context.deadline }, async (tx) => {
          const close = await guardIdentityHistoryTransaction(pool, context, tx);
          try {
            const answer = await body(tx);
            const history = await import('./agent-identity-retirement.ts');
            history.assertAgentIdentityHistoryUnit(pool, context);
            return noEffect(answer);
          } finally {
            close();
          }
        })
      ).value,
  );
  history.assertAgentIdentityHistoryUnit(pool, context);
  return answer;
}

// Closed native child bounds. Each touch has one erasure point, one fence upsert and its erasure FK,
// and at most nine coverage rows (the native definition CHECK has nine families).
export const HISTORY_FAMILY_TOUCH = IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.familyTouch;
export const HISTORY_WORK_INVALIDATION = IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.workInvalidation;
export const HISTORY_WORK_WAKE = IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.workWake;
export const HISTORY_LOCATOR_INVALIDATION = IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.locatorInvalidation;
export const HISTORY_RECEIVING_INVALIDATION = IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.receivingInvalidation;

export function addNativeWork(...parts: readonly NativeStepWork[]): NativeStepWork {
  const amount = parts.reduce(
    (a, b) => nativeWork(a.rows + b.rows, a.points + b.points, a.statements + b.statements, a.bytes + b.bytes),
    nativeWork(0, 0, 0, 0),
  );
  const costs = parts.map((part) => declarations.get(part));
  if (costs.every((cost) => cost !== undefined)) {
    const result = accountHistoryWork(
      amount.rows,
      amount.points,
      amount.statements,
      amount.bytes,
      costs.reduce((sum, cost) => sum + cost.emptySeeks, 0),
    );
    return result;
  }
  const missing = parts
    .filter((part) => !declarations.has(part))
    .map((part) => missingTerms.get(part) ?? 'undeclared-native-sql');
  return unpricedIdentityHistoryWork([...new Set(missing)].join(','), amount);
}
