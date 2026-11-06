import type { Pool, PoolClient } from 'pg';
import { currentOperationalResources, type OperationalTransaction } from '../../command/operational.ts';
import type { WorkExecutionOriginal } from '../../command/execution-contract.ts';
import {
  OPERATIONAL_WORK_COST,
  OPERATIONAL_WORK_RECEIVING,
  OPERATIONAL_WORK_RECHECK,
} from '../core/operational-work-budget.ts';
import { OPERATIONAL_WORK_AXES } from '../core/operational-work-axes.ts';
import {
  type OperationalWorkPhase,
  type OperationalWorkTransfer,
  OperationalWorkUnavailable,
} from '../contract/index.ts';

export { OPERATIONAL_WORK_AXES };

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
