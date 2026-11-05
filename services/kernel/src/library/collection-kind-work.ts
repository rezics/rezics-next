import { createHash } from 'node:crypto';
import { enqueueIntent, runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { workStepDeadline } from './command-support.ts';
import {
  COLLECTION_KIND_RAW_LIMIT,
  collectionKindSourceBindings,
  createCollectionKindNative,
  type CollectionKindNative,
} from './collection-kind.ts';
import retiredQuery from './collection-kind-retired.sql';
import retireCurrent from './collection-kind-retire-current.sql';
import purgeSubjects from './collection-kind-purge-subject.sql';
import purgeCounts from './collection-kind-purge-count.sql';
import purgeRetired from './collection-kind-purge-retired.sql';

export const COLLECTION_KIND_WORKFLOW = 'library.collectionKind';
export type CollectionKindWork = {
  accounts: [string];
  collectionId: string;
  audience: string | null;
  generation: string | null;
  version: string | null;
  cleanup?: number;
};
type Context = Pick<WorkContext, 'pool' | 'client' | 'clock'>;

function validate(input: CollectionKindWork) {
  if (
    (input.cleanup !== undefined && (!Number.isSafeInteger(input.cleanup) || input.cleanup < 0)) ||
    !Array.isArray(input.accounts) ||
    input.accounts.length !== 1 ||
    routeOf(input.accounts[0]) === null ||
    routeOf(input.collectionId) !== routeOf(input.accounts[0]) ||
    (input.generation !== null && routeOf(input.generation) === null) ||
    (input.version !== null && !/^(0|[1-9][0-9]*)$/.test(input.version)) ||
    (input.generation === null) !== (input.version === null) ||
    (input.audience !== null && (new TextEncoder().encode(input.audience).byteLength > 256 || !input.audience))
  )
    throw new TypeError('Invalid Collection kind work locator');
}
function transaction<T>(
  context: Context,
  input: CollectionKindWork,
  deadline: number,
  body: (tx: OperationalTransaction) => Promise<T>,
) {
  validate(input);
  return runOperationalTransaction(
    context.pool,
    {
      mode: 'work-step',
      partition: partitionOf(routeOf(input.collectionId)!),
      kind: COLLECTION_KIND_WORKFLOW,
      accounts: input.accounts,
      workClient: context.client,
      deadline,
      clock: context.clock,
    },
    body,
  );
}

/** Retained-data retirement continuation only; Collection presentation never enqueues this work. */
export async function enqueueCollectionKindRepair(tx: OperationalTransaction, input: CollectionKindWork, root: string) {
  validate(input);
  const scope = createHash('sha256')
    .update(JSON.stringify([input.collectionId, input.audience]))
    .digest('hex');
  await enqueueIntent(tx, {
    queue: 'maintenance',
    workflowName: COLLECTION_KIND_WORKFLOW,
    workflowId: `${COLLECTION_KIND_WORKFLOW}:${root}:${scope}:${input.generation ?? 'start'}:${input.version ?? 'start'}:${input.cleanup ?? 'derive'}`,
    input,
  });
}

/** Retire native custody before discarding its locator; raw100 local child cleanup is crash/replay safe. */
export async function retireCollectionKindPage(
  context: Context,
  input: CollectionKindWork,
  native: CollectionKindNative = createCollectionKindNative(collectionKindSourceBindings(context)),
) {
  validate(input);
  const route = routeOf(input.collectionId)!;
  const parameters = { route, collection_id: input.collectionId };
  const retired = await withConnection(context.pool, (client) => retiredQuery.run(client, parameters));
  if (!retired)
    return transaction(context, input, workStepDeadline(), async (tx) => {
      const moved = await retireCurrent.run(tx, parameters);
      if (moved.length === 0) return 'complete';
      await enqueueCollectionKindRepair(tx, { ...input, cleanup: (input.cleanup ?? 0) + 1 }, moved[0]!.generation);
      return 'progress';
    });
  const result = await native.retire({
    collectionId: input.collectionId,
    accountId: input.accounts[0],
    token: retired.capture,
    deadline: workStepDeadline(),
  });
  if (result.status !== 'retired') return 'unavailable';
  return transaction(context, input, workStepDeadline(), async (tx) => {
    const key = { ...parameters, audience: retired.audience, generation: retired.generation };
    const subjects = await purgeSubjects.run(tx, key);
    if (subjects.length === 0) {
      const counts = await purgeCounts.run(tx, key);
      if (counts.length < COLLECTION_KIND_RAW_LIMIT) await purgeRetired.run(tx, key);
    }
    await enqueueCollectionKindRepair(tx, { ...input, cleanup: (input.cleanup ?? 0) + 1 }, retired.generation);
    return 'progress';
  });
}
