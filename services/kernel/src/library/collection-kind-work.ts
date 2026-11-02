import type { ResolveKindAudienceInput } from '../access/kind-audience.ts';
import { createHash } from 'node:crypto';
import { enqueueIntent, runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { workStepDeadline } from './command-support.ts';
import {
  COLLECTION_KIND_BYTE_LIMIT,
  COLLECTION_KIND_RAW_LIMIT,
  collectionKindSourceBindings,
  createCollectionKindNative,
  validateCollectionKindPage,
  type CollectionKindNative,
} from './collection-kind.ts';
import parentQuery from './collection-kind-parent.sql';
import readQuery from './collection-kind-read.sql';
import seedQuery from './collection-kind-seed.sql';
import lockQuery from './collection-kind-lock.sql';
import applyQuery from './collection-kind-apply.sql';
import checkpointQuery from './collection-kind-checkpoint.sql';
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

/** Only native mutations/admitted member preparation/repair call this; metadata reads do not enqueue work. */
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

/** One finite native step followed by one same-home CAS; all foreign homes release before local adoption. */
export async function stepCollectionKind(
  context: Context,
  input: CollectionKindWork,
  native: CollectionKindNative = createCollectionKindNative(collectionKindSourceBindings(context)),
  original?: ResolveKindAudienceInput,
) {
  validate(input);
  if (original) {
    // Original request callers enter on their actual admitted Source transaction.
    // Returning lets that caller commit the raw interval and RELEASE this home
    // before any detached Type/Access phase; DBOS locators never contain it.
    const locator = original.work.locator;
    if (
      locator.collectionId !== input.collectionId ||
      locator.ownerAccountId !== input.accounts[0] ||
      locator.preparationId !== input.generation ||
      !native.prepareInput ||
      native.prepareInput.bound(original) === undefined
    )
      throw new ProblemError('semantic_not_ready');
    return native.prepareInput.run(original);
  }
  const route = routeOf(input.collectionId)!;
  const accountId = input.accounts[0];
  const deadline = workStepDeadline();
  const parameters = { route, collection_id: input.collectionId };
  const prepared = await native.prepare({
    collectionId: input.collectionId,
    accountId,
    audience: input.audience,
    deadline,
  });
  if (prepared.status !== 'prepared') return 'unavailable';
  const capture = prepared.capture;
  if (
    capture.collectionId !== input.collectionId ||
    capture.accountId !== accountId ||
    (input.audience !== null && capture.audience !== input.audience) ||
    !capture.audience ||
    new TextEncoder().encode(capture.audience).byteLength > 256 ||
    !capture.token ||
    new TextEncoder().encode(capture.token).byteLength > COLLECTION_KIND_BYTE_LIMIT ||
    !/^(0|[1-9][0-9]*)$/.test(capture.sourceGeneration)
  )
    throw new ProblemError('dependency_unavailable');
  const selected = { ...parameters, audience: capture.audience };
  if (input.generation === null) {
    return transaction(context, input, deadline, async (tx) => {
      const parent = await parentQuery.run(tx, parameters);
      if (
        !parent ||
        parent.state !== 'active' ||
        parent.accountId !== accountId ||
        parent.sourceGeneration !== capture.sourceGeneration ||
        parent.presentationKind !== null
      )
        return 'stale';
      const adoption = await native.adopt({ capture, tx, deadline });
      if (adoption.status !== 'adopted') return adoption.status;
      await seedQuery.run(tx, {
        ...selected,
        account_id: accountId,
        capture: capture.token,
        source_generation: capture.sourceGeneration,
        generation: crypto.randomUUID(),
      });
      const state = await readQuery.run(tx, selected);
      if (!state) throw new Error('Missing adopted Collection kind observation');
      if (!state.complete)
        await enqueueCollectionKindRepair(
          tx,
          {
            ...input,
            audience: capture.audience,
            generation: state.generation,
            version: state.version,
          },
          state.generation,
        );
      return state.complete ? 'complete' : 'progress';
    });
  }
  const state = await withConnection(context.pool, (client) => readQuery.run(client, selected));
  if (
    !state ||
    state.generation !== input.generation ||
    state.version !== input.version ||
    state.complete ||
    state.capture !== capture.token ||
    state.sourceGeneration !== capture.sourceGeneration
  )
    return 'stale';
  const page = await native.page({
    capture,
    afterSubject: state.afterSubject,
    frontier: state.frontier,
    inputLimit: COLLECTION_KIND_RAW_LIMIT,
    byteLimit: COLLECTION_KIND_BYTE_LIMIT,
    deadline,
  });
  if (page.status === 'unavailable') return 'unavailable';
  validateCollectionKindPage(page, state.afterSubject, state.frontier);
  const current = await native.revalidate({ capture, deadline });
  if (current.status !== 'current') return current.status;
  return transaction(context, input, deadline, async (tx) => {
    const parent = await parentQuery.run(tx, parameters);
    if (
      !parent ||
      parent.state !== 'active' ||
      parent.accountId !== accountId ||
      parent.sourceGeneration !== capture.sourceGeneration ||
      parent.presentationKind !== null
    )
      return 'stale';
    const locked = await lockQuery.run(tx, selected);
    if (
      !locked ||
      locked.generation !== input.generation ||
      locked.version !== input.version ||
      locked.capture !== capture.token ||
      locked.complete
    )
      return 'stale';
    const adoption = await native.adopt({ capture, tx, deadline });
    if (adoption.status !== 'adopted') return adoption.status;
    await applyQuery.run(tx, {
      ...selected,
      account_id: accountId,
      generation: state.generation,
      votes: page.votes.map((vote) => ({ subject_id: vote.subjectId, type_id: vote.typeId })),
    });
    const next = await checkpointQuery.run(tx, {
      ...selected,
      generation: state.generation,
      version: state.version,
      after_subject: page.afterSubject,
      frontier: page.frontier,
      complete: page.status === 'complete',
    });
    if (!next) throw new Error('Collection kind checkpoint lost its locked generation');
    if (page.status !== 'complete')
      await enqueueCollectionKindRepair(
        tx,
        {
          ...input,
          version: next.version,
        },
        state.generation,
      );
    return page.status === 'complete' ? 'complete' : 'progress';
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
