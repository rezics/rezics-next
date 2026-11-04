import type { Pool, PoolClient } from 'pg';
import { declareBound, sumBounds, type Bound } from '@rezics/bounds';
import { currentOperationalResources, type OperationalTransaction } from '../command/operational.ts';
import type { WorkExecutionOriginal } from '../command/execution-contract.ts';
import { OPERATIONAL_WORK_AXES } from './operational-work-axes.ts';

/** Complete native dimensions used by the operational History producer. */
export { OPERATIONAL_WORK_AXES };
export type OperationalWorkCost = Bound;
const cost = (nativeRows: number, nativePoints: number, statements: number, bytes: number): OperationalWorkCost =>
  declareBound({
    candidateKeys: 0,
    nativeRows,
    identityMetadataRows: 0,
    emptySeeks: nativePoints,
    nativePoints,
    witnessKeys: 0,
    statements,
    bytes,
    engineRequests: 0,
  });
export const sumOperationalWork = sumBounds;
const times = (n: number, part: OperationalWorkCost) => sumOperationalWork(...Array.from({ length: n }, () => part));

// Each family touch: erasure, fence including its FK, and up to nine coverage rows.
// Each locator INSERT additionally touches its (at most eight) exact role associations.
// This producer preserves all Access identity roles; it never reduces them to payload accounts.
const touch = cost(12, 12, 4, 0);
// Base: INSERT/FK, existing native identity-enrollment empty association probe, seal
// INSERT/read guard, operational scope's two full-key probes, and eight artifact role keys.
const locator = sumOperationalWork(cost(16, 16, 8, 8192), times(9, touch));
export const OPERATIONAL_WORK_COST = Object.freeze({
  // Time transaction: BEGIN/settings/time/COMMIT/ROLLBACK. Source transaction:
  // BEGIN/two settings/operational fence/final setting/COMMIT/ROLLBACK; two Account locks.
  attempt: cost(7, 3, 14, 768),
  originalLookup: cost(1, 1, 1, 1280),
  sourceDomain: cost(1, 1, 1, 128),
  // Allocator SELECT partition (1), head insert/conflict update (2), both BEFORE triggers'
  // partition/domain reads (4), partition FK (1), deferred head->original exact probe (1).
  // Four further head PK insert/conflict/update index touches; no sequence or free control I/O.
  // Params/RETURNING include UUIDs, digest, workflow, deadline and the complete stamp (<=256).
  positionAllocate: cost(9, 13, 7, 2048),
  // Original insert binds every position operand against the locked head (1 point/statement).
  positionBinding: cost(1, 1, 1, 512),
  // Three original unique keys + PK + new partial position index, sixteen episode PKs;
  // final original UPDATE maintains its five indexes (source_epoch/sealed change).
  originalIndexes: cost(0, 26, 0, 1024),
  // Eight physical LIMIT 1 probes. SDK status upsert: INSERT and conflict UPDATE guards;
  // input INSERT guard; exact input readback. Each guard locks the native writer.
  sdkProbe: cost(8, 8, 8, 256),
  sdkDomain: cost(1, 1, 1, 128), // source restore-domain SHARE precedes every SDK writer lock
  sdkProjectionGuard: cost(2, 2, 1, 128),
  // 4096-byte returned status + 8192-byte input callback + 4096-byte original input,
  // with 2048 bytes for fixed SDK status/queue/UUID/serialization arguments.
  sdkEnqueue: cost(10, 10, 9, 18432),
  // 4096-byte bounded older creator projection + 8192-byte input + 512 fence scalars.
  sdkWriter: cost(4, 4, 1, 12800),
  // Bound original JSON columns, episode reservation argument, sixteen UUID associations and
  // scalar keys separately. A zero-byte INSERT would omit the actual producer serialization.
  originalInsert: cost(34, 34, 19, 262144 + 8192 + 4096 + 1024 + 196608 + 16 * 128 + 4096),
  originalFinalize: cost(6, 6, 5, 2048), // UPDATE partition/association + deferred original/partition/domain/head reads and deadline
  seal: sumOperationalWork(cost(3, 3, 3, 128), touch),
  workInsert: cost(2, 2, 2, 8192 + 4096 + 512), // work and partition FK; INSERT has no physical-change trigger
  locator,
  // Held partition/domain/head/original (4), BEGIN/two settings/COMMIT/ROLLBACK (5).
  // Bounded original projection + scalar keys + stamp JSON and comparison serialization.
  resolve: cost(4, 4, 9, 291328),
  // Receiving BEGIN/settings/partition/domain/COMMIT/ROLLBACK. Mapping insert has its
  // partition FK. Mapping readback, work readback and all eight locator role keys follow.
  receivingControl: cost(4, 2, 8, 640),
  // Native mapping row/FK, PK/workflow/partial-position index operations (3),
  // pure mapping-stamp trigger (no SQL) and <=256-byte discriminated stamp projection.
  mappingInsert: cost(2, 5, 2, 278528 + 1024 + 1024 + 512),
  mappingRead: cost(11, 11, 3, 299520),
  sdkReadback: cost(2, 2, 2, 9216),
  // Actual SDK check_workflow_writer_state: SELECT, domain lock, writer lock, return.
  writerBarrier: cost(4, 2, 4, 8192),
  replaySeals: cost(8, 8, 8, 1024),
});

export const OPERATIONAL_WORK_REGISTRATION = sumOperationalWork(
  OPERATIONAL_WORK_COST.originalLookup,
  OPERATIONAL_WORK_COST.sourceDomain,
  OPERATIONAL_WORK_COST.positionAllocate,
  OPERATIONAL_WORK_COST.positionBinding,
  OPERATIONAL_WORK_COST.originalIndexes,
  OPERATIONAL_WORK_COST.sdkDomain,
  OPERATIONAL_WORK_COST.sdkProbe,
  OPERATIONAL_WORK_COST.sdkEnqueue,
  OPERATIONAL_WORK_COST.sdkWriter,
  OPERATIONAL_WORK_COST.sdkProjectionGuard,
  OPERATIONAL_WORK_COST.originalInsert,
  OPERATIONAL_WORK_COST.originalFinalize,
  times(8, OPERATIONAL_WORK_COST.seal),
  OPERATIONAL_WORK_COST.workInsert,
  times(8, locator),
);
export const OPERATIONAL_WORK_RECEIVING = sumOperationalWork(
  OPERATIONAL_WORK_COST.receivingControl,
  OPERATIONAL_WORK_COST.mappingInsert,
  OPERATIONAL_WORK_COST.mappingRead,
  OPERATIONAL_WORK_COST.writerBarrier,
  OPERATIONAL_WORK_COST.sdkReadback,
  times(8, OPERATIONAL_WORK_COST.seal),
  OPERATIONAL_WORK_COST.workInsert,
  times(8, locator),
);
export const OPERATIONAL_WORK_RECHECK = sumOperationalWork(
  OPERATIONAL_WORK_COST.receivingControl,
  OPERATIONAL_WORK_COST.mappingRead,
  OPERATIONAL_WORK_COST.writerBarrier,
  OPERATIONAL_WORK_COST.sdkReadback,
  OPERATIONAL_WORK_COST.replaySeals,
);
export const OPERATIONAL_WORK_TRANSFER_COST = Object.freeze({
  resolve: OPERATIONAL_WORK_COST.resolve,
  verify: OPERATIONAL_WORK_COST.resolve,
  receive: OPERATIONAL_WORK_RECEIVING,
  replay: OPERATIONAL_WORK_RECHECK,
  retirement: OPERATIONAL_WORK_RECHECK,
});
export type OperationalWorkPhase = keyof typeof OPERATIONAL_WORK_TRANSFER_COST;
/** Documented static ceiling for three complete attempts including every child. This is a
 * descriptive bound, not a prepaid ledger: callers do not buy dispatch from it. */
export const OPERATIONAL_WORK_LOCAL_DECLARATION = sumOperationalWork(
  times(
    3,
    sumOperationalWork(
      OPERATIONAL_WORK_COST.attempt,
      OPERATIONAL_WORK_REGISTRATION,
      ...Object.values(OPERATIONAL_WORK_TRANSFER_COST),
    ),
  ),
);
export class OperationalWorkUnavailable extends Error {
  constructor(readonly gap: string) {
    super(gap);
  }
}

/** Validate Work-owned original authority through the service contract, not a concrete Work implementation. */
export function assertOperationalWorkOriginal(tx: OperationalTransaction, original: WorkExecutionOriginal): void {
  const port = currentOperationalResources(tx).workClient.executionContract?.work;
  if (!port) throw new OperationalWorkUnavailable('operational-work-original-not-opted-in');
  port.assertOriginal(tx, original);
}
/** Query adapter over the SAME checked-out client. A wait for a connection/lock never
 * extends the original deadline. Cleanup uses the raw client so expiry cannot prevent rollback. */
export function operationalWorkDeadlineClient(client: PoolClient, deadline: number): Pick<PoolClient, 'query'> {
  return {
    query: new Proxy(client.query, {
      apply(target, _receiver, args) {
        if (Date.now() >= deadline) throw new OperationalWorkUnavailable('operational-work-deadline');
        return Reflect.apply(target, client, args);
      },
    }),
  };
}
declare const transfer: unique symbol;
export type OperationalWorkTransfer = { readonly [transfer]: true };
type Transfer = {
  original: WorkExecutionOriginal;
  pool: Pool;
  deadline: number;
  phase: OperationalWorkPhase;
  custodyId: string;
  state: 'live' | 'committed' | 'invalid';
  used: boolean;
};
const transfers = new WeakMap<OperationalWorkTransfer, Transfer>();
const byTransaction = new WeakMap<OperationalTransaction, Set<OperationalWorkTransfer>>();
/** Executor/producer internal. Public issuance verifies the genuine live transaction first. */
export function issueOperationalWorkTransfer(
  tx: OperationalTransaction,
  original: WorkExecutionOriginal,
  phase: OperationalWorkPhase,
  custodyId: string,
): OperationalWorkTransfer {
  const resources = currentOperationalResources(tx);
  if (resources.deadline <= Date.now())
    throw new OperationalWorkUnavailable('operational-work-native-transfer-unavailable');
  assertOperationalWorkOriginal(tx, original);
  const issued = byTransaction.get(tx) ?? new Set<OperationalWorkTransfer>();
  if ([...issued].some((token) => transfers.get(token)?.phase === phase))
    throw new TypeError('Operational work phase already transferred');
  const token = Object.freeze({}) as OperationalWorkTransfer;
  transfers.set(token, {
    original,
    pool: resources.pool,
    deadline: resources.deadline,
    phase,
    custodyId,
    state: 'live',
    used: false,
  });
  issued.add(token);
  byTransaction.set(tx, issued);
  return token;
}
export function finishOperationalWorkTransfers(tx: OperationalTransaction, committed: boolean): void {
  for (const token of byTransaction.get(tx) ?? []) {
    const binding = transfers.get(token)!;
    binding.state = committed ? 'committed' : 'invalid';
  }
  byTransaction.delete(tx);
}
export function consumeOperationalWorkTransfer(
  pool: Pool,
  token: OperationalWorkTransfer,
  phase: OperationalWorkPhase,
  custodyId: string,
): Readonly<{ deadline: number }> {
  const bound = transfers.get(token);
  if (
    !bound ||
    bound.used ||
    bound.phase !== phase ||
    bound.custodyId !== custodyId ||
    bound.state !== 'committed' ||
    bound.pool !== pool ||
    Date.now() >= bound.deadline
  )
    throw new OperationalWorkUnavailable('operational-work-native-transfer-unavailable');
  bound.used = true;
  return Object.freeze({ deadline: bound.deadline });
}
