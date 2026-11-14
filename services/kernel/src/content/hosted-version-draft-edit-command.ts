import type { Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type CommandResult,
  type CommandTransaction,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import {
  ContentNotFoundError,
  hostedPostAuthorization,
  RevisionPreconditionError,
  type ContentCommandDependencies,
} from './commands.ts';
import { prepareHostedVersionDraftMovePlan } from './hosted-version-draft-edit.ts';
import type {
  HostedVersionDraftMoveInput,
  HostedVersionDraftMoveNativeAdapter,
  HostedVersionDraftMoveNativeWrite,
  HostedVersionDraftMovePlan,
} from './hosted-version-draft-edit-model.ts';
import { HostedVersionDraftMoveError } from './hosted-version-draft-edit-model.ts';
import { resolveHostedVersionRevision } from './hosted-version-revision.ts';
import {
  InvalidHostedStructureError,
  type HostedCommandContext,
  type HostedCommandValue,
  type HostedDependencies,
} from './hosted-chapters-model.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import { snapshot } from './reads.ts';

export type HostedVersionDraftMoveCommandDependencies = HostedDependencies &
  ContentCommandDependencies &
  Readonly<{
    /** Implemented by the native version adapter; the legacy placement store is not a move backend. */
    versionAdapter: HostedVersionDraftMoveNativeAdapter<CommandTransaction>;
  }>;

/** Execute Part or root movement and its native owner write in runCommand's live transaction. */
export async function commitHostedVersionDraftMoveInTransaction(
  adapter: HostedVersionDraftMoveNativeAdapter<CommandTransaction>,
  tx: CommandTransaction,
  write: Omit<HostedVersionDraftMoveNativeWrite, 'snapshot' | 'plan'>,
): Promise<CommandResult<HostedCommandValue>> {
  let selected: Awaited<ReturnType<typeof adapter.selectExpectedSnapshot>>;
  let plan: HostedVersionDraftMovePlan;
  try {
    const revision = await resolveHostedVersionRevision(tx, write.catalogueId, write.input.expectedRevisionId);
    if (
      revision.kind !== 'ordered' ||
      revision.revisionKind !== 'structure' ||
      revision.snapshot.generationKind !== 'draft'
    ) {
      throw new HostedVersionDraftMoveError('stale-head');
    }
    selected = await adapter.selectExpectedSnapshot(tx, write.catalogueId, write.input, revision);
    plan = await prepareHostedVersionDraftMovePlan(write.input, selected.selection, selected.indexes);
  } catch (error) {
    if (error instanceof HostedVersionDraftMoveError) {
      if (error.code === 'stale-head') throw new RevisionPreconditionError();
      throw new InvalidHostedStructureError();
    }
    throw error;
  }
  if (plan.result === 'no-op') {
    return noEffect({ catalogueId: write.catalogueId, revisionId: write.input.expectedRevisionId });
  }

  if (
    !(await adapter.commitMove(tx, {
      ...write,
      snapshot: selected,
      plan,
    }))
  ) {
    throw new RevisionPreconditionError();
  }

  const value = { catalogueId: write.catalogueId, revisionId: write.revisionId };
  return {
    value,
    events: [
      {
        type: 'com.rezics.content.hosted-catalogue.revise.v1',
        subject: write.catalogueId,
        data: value,
      },
    ],
  };
}

/** Admit the catalogue author, then bind the pure planner to one native
 * expected-snapshot workspace and atomic owner write. */
export async function moveHostedVersionDraftOccurrence(
  deps: HostedVersionDraftMoveCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedVersionDraftMoveInput,
  context: HostedCommandContext,
) {
  const route = routeOf(catalogueId);
  if (route === null || actor.kind !== 'account') throw new ContentNotFoundError();
  const initial = (await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId))).value;
  if (!initial) throw new ContentNotFoundError();

  const kind = 'content.hosted-catalogue.move';
  const receipt = {
    kind,
    key: context.idempotencyKey,
    digest: requestDigest(kind, actor, { catalogueId, input }),
  };
  const authorization = hostedPostAuthorization(deps, actor, initial.thread_id, catalogueId, context, receipt);
  const revisionId = newId(route);

  return runCommand<HostedCommandValue>(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt,
      authorization,
    },
    (tx, { transactionId, time }) =>
      commitHostedVersionDraftMoveInTransaction(deps.versionAdapter, tx, {
        catalogueId,
        input,
        revisionId,
        transactionId,
        recordedAt: authoritativeTimeValue(time),
      }),
  );
}
