import type { Pool } from 'pg';
import { runOperationalTransaction, type OperationalTransaction } from '../../command/operational.ts';
import { currentCommandWorkAssociation } from '../../command/work-context.ts';
import { deadlineFor } from '../../request/deadline.ts';
import { partitionOf, routeOf } from '../../route/route.ts';
import type { WorkClient } from '../../work/client.ts';
import { WORK_STEP_DEADLINE_MS } from '../work-step-deadline.ts';
import { requireLibraryDomain } from '../domain-binding.ts';
import type { FollowCountRuntime } from '../contract/index.ts';

export function followCountRuntime(): FollowCountRuntime {
  const runtime = requireLibraryDomain().followCounts;
  if (!runtime) throw new TypeError('Library Follow counts are not composed');
  return runtime;
}
export function workStepDeadline(): number {
  return currentCommandWorkAssociation()?.deadline ?? deadlineFor(WORK_STEP_DEADLINE_MS);
}
export type CountRuntime = { pool: Pool; client: WorkClient };
export const ZERO_COUNT_KEY = '00000000-0000-0000-0000-000000000000';

export function countRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new TypeError('Follow count locator requires a routed ID');
  return route;
}
export function countTransaction<T>(
  deps: CountRuntime,
  route: number,
  kind: string,
  body: (tx: OperationalTransaction) => Promise<T>,
) {
  return runOperationalTransaction(
    deps.pool,
    {
      partition: partitionOf(route),
      kind,
      mode: 'work-step',
      accounts: [],
      workClient: deps.client,
      deadline: workStepDeadline(),
    },
    body,
  );
}
