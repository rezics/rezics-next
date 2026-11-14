import type { Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  preflightCommandReceipt,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import {
  ContentNotFoundError,
  RevisionPreconditionError,
  hostedPostAuthorization,
  type ContentCommandDependencies,
} from './commands.ts';
import { prepareHostedPublicationPoint, type HostedPublicationPointPreparation } from './hosted-publication-point.ts';
import type { HostedPointSelectionReads, HostedPublicationPointInput } from './hosted-publication-point-selection.ts';
import { commitHostedVersionPublicationPoint } from './hosted-version-publication-write.ts';
import { HostedVersionPublicationWriteError } from './hosted-version-publication-write-model.ts';
import { completedHostedLegacyPublicBaseline } from './hosted-legacy-public-baseline.ts';
import { snapshot } from './reads.ts';
import { validateHostedChapterAttachments } from './hosted-chapters-attachments.ts';
import { insertHostedRootAppend } from './hosted-chapters-append.ts';
import { appendHostedOrderedRootChapter, hostedOrderedReleasePlacements } from './hosted-ordered-compatibility.ts';
import { orderHostedPlacements, selectHostedRelease } from './hosted-chapters-tree.ts';
import {
  hostedCatalogue,
  hostedRevision,
  hostedReleasePlacements,
  insertHostedPlacements,
} from './hosted-chapters-store.ts';
import {
  InvalidHostedStructureError,
  type HostedCommandContext,
  type HostedCommandValue,
  type HostedCreateInput,
  type HostedDependencies,
  type HostedDraftPointInsertInput,
  type HostedDraftPointRemoveInput,
  type HostedReviseInput,
  type HostedPublishInput,
  type HostedRootAppendInput,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';
import { commitHostedDraftPointWrite, type HostedDraftPointMutation } from './hosted-version-draft-write.ts';

export type HostedCommandDependencies = HostedDependencies & ContentCommandDependencies;
type Mutation =
  | { kind: 'create'; input: HostedCreateInput }
  | { kind: 'revise'; input: HostedReviseInput }
  | { kind: 'append'; input: HostedRootAppendInput }
  | { kind: 'publish'; input: HostedPublishInput };

export function createHostedCatalogue(
  deps: HostedCommandDependencies,
  actor: Actor,
  input: HostedCreateInput,
  context: HostedCommandContext,
) {
  return mutate(deps, actor, input.postId, { kind: 'create', input }, context);
}
export function reviseHostedCatalogue(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedReviseInput,
  context: HostedCommandContext,
) {
  return mutate(deps, actor, catalogueId, { kind: 'revise', input }, context);
}
export function publishHostedCatalogue(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedPublishInput,
  context: HostedCommandContext,
) {
  return mutate(deps, actor, catalogueId, { kind: 'publish', input }, context);
}

/** Appends one root chapter to an exact draft head. Shares native edit authority,
 * deadlines, receipt replay, transaction retries and final container checks. */
export function appendHostedRootChapter(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedRootAppendInput,
  context: HostedCommandContext,
) {
  return mutate(deps, actor, catalogueId, { kind: 'append', input }, context);
}

/** Insert one occurrence at a parent/before anchor on the expected versioned draft. */
export function insertHostedDraftPoint(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedDraftPointInsertInput,
  context: HostedCommandContext,
) {
  return mutatePoint(deps, actor, catalogueId, { operation: 'insert', ...input }, context);
}

/** Remove one occurrence and its stored subtree from the expected versioned draft. */
export function removeHostedDraftPoint(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedDraftPointRemoveInput,
  context: HostedCommandContext,
) {
  return mutatePoint(deps, actor, catalogueId, { operation: 'remove', ...input }, context);
}

/** Build the native admission and receipt binding for a point operation. The
 * storage owner supplies reads pinned to the request's expected Book versions;
 * the returned preparation is consumed by its transaction writer. */
export async function prepareHostedPublicationPointCommand(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  operation: HostedPublicationPointInput,
  reads: HostedPointSelectionReads,
  context: HostedCommandContext,
) {
  const route = routeOf(catalogueId);
  if (route === null || actor.kind !== 'account') throw new ContentNotFoundError();
  const initial = (await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId))).value;
  if (!initial) throw new ContentNotFoundError();

  const kind = `content.hosted-catalogue.${operation.kind}`;
  const receipt = {
    kind,
    key: context.idempotencyKey,
    digest: requestDigest(kind, actor, { catalogueId, input: operation.input }),
  };
  const base = hostedPostAuthorization(deps, actor, initial.thread_id, catalogueId, context, receipt);
  const preparedByTime = new WeakMap<AuthoritativeTime, HostedPublicationPointPreparation>();
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      const evidence = await base.prepare!(attempt);
      preparedByTime.set(
        attempt.time,
        await prepareHostedPublicationPoint(deps, catalogueId, operation, reads, {
          actor,
          deadline: context.deadline,
        }),
      );
      return evidence;
    },
    async authorize(tx, attempt, evidence) {
      return base.authorize(tx, attempt, evidence);
    },
    async finalize(tx, attempt, evidence) {
      await base.finalize?.(tx, attempt, evidence);
      const prepared = preparedByTime.get(attempt.time);
      if (!prepared) throw new Error('Hosted point command reached finalization without preparation');
      await prepared.final(tx);
    },
  };

  return {
    catalogueId,
    threadId: initial.thread_id,
    partition: partitionOf(route),
    receipt,
    receiptAuthorization: base,
    authorization,
    prepared(time: AuthoritativeTime) {
      const result = preparedByTime.get(time);
      if (!result) throw new Error('Hosted point command has no preparation for this attempt');
      return result;
    },
  };
}

/** Publish one selected draft point after current admission and receipt preflight.
 * The exact selection is read only after a missing receipt, then all index and
 * pointer changes commit on the ordinary Content command transaction. */
export async function publishHostedPublicationPoint(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  operation: HostedPublicationPointInput,
  reads: HostedPointSelectionReads,
  context: HostedCommandContext,
) {
  const command = await prepareHostedPublicationPointCommand(deps, actor, catalogueId, operation, reads, context);
  const commandOptions = {
    ...principalCommandIdentity(actor),
    partition: command.partition,
    deadline: context.deadline,
    clock: deps.clock,
    receipt: command.receipt,
  };
  const replay = await preflightCommandReceipt<HostedCommandValue>(deps.pool, {
    ...commandOptions,
    authorization: command.receiptAuthorization,
  });
  if (replay) return replay;

  const revisionId = newId(routeOf(catalogueId)!);
  return runCommand<HostedCommandValue>(
    deps.pool,
    { ...commandOptions, authorization: command.authorization },
    async (tx, { transactionId, time }) => {
      const current = await hostedCatalogue(tx, catalogueId, true);
      if (!current || current.thread_id !== command.threadId) throw new ContentNotFoundError();
      if (
        current.head_revision_id !== operation.input.expectedRevisionId ||
        current.publication_id !== operation.input.expectedPublicationId
      )
        throw new RevisionPreconditionError();

      try {
        const preparedBaseline = await completedHostedLegacyPublicBaseline(
          tx,
          actor,
          catalogueId,
          operation.input.expectedPublicationId,
        );
        await commitHostedVersionPublicationPoint(tx, {
          catalogueId,
          revisionId,
          recordedTransactionId: transactionId,
          recordedAt: authoritativeTimeValue(time),
          selection: command.prepared(time).selection,
          preparedBaseline,
        });
      } catch (error) {
        if (error instanceof HostedVersionPublicationWriteError) throw new RevisionPreconditionError();
        throw error;
      }

      const value = { catalogueId, revisionId };
      return {
        value,
        events: [
          {
            type: 'com.rezics.content.hosted-catalogue.publish.v1',
            subject: catalogueId,
            data: value,
          },
        ],
      };
    },
  );
}

async function mutate(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  mutation: Mutation,
  context: HostedCommandContext,
) {
  mutation = structuredClone(mutation);
  const route = routeOf(catalogueId);
  if (route === null || actor.kind !== 'account') throw new ContentNotFoundError();
  if (mutation.kind !== 'create' && routeOf(mutation.input.expectedRevisionId) !== route)
    throw new InvalidHostedStructureError('Invalid expected structure revision');
  if (
    mutation.kind === 'publish' &&
    mutation.input.expectedPublicationId !== null &&
    routeOf(mutation.input.expectedPublicationId) !== route
  )
    throw new InvalidHostedStructureError('Invalid expected publication');
  const initial = (await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId))).value;
  const threadId = mutation.kind === 'create' ? mutation.input.threadId : initial?.thread_id;
  if (!threadId || routeOf(threadId) !== route) throw new ContentNotFoundError();
  const authored =
    mutation.kind === 'publish'
      ? null
      : orderHostedPlacements(
          route,
          mutation.kind === 'append'
            ? [
                {
                  occurrenceId: mutation.input.occurrenceId,
                  parentId: null,
                  position: 0,
                  title: mutation.input.title,
                  kind: 'chapter',
                  target: mutation.input.target,
                },
              ]
            : mutation.input.placements,
        );
  const kind = `content.hosted-catalogue.${mutation.kind}`;
  const receipt = {
    kind,
    key: context.idempotencyKey,
    digest: requestDigest(kind, actor, { catalogueId, input: mutation.input }),
  };
  const base = hostedPostAuthorization(deps, actor, threadId, catalogueId, context, receipt);
  const prepared = new WeakMap<AuthoritativeTime, readonly OrderedHostedPlacement[]>();
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      const placements =
        mutation.kind === 'publish'
          ? (
              await snapshot(deps, catalogueId, context, async (client) => {
                const selected = mutation.input;
                const revision = await hostedRevision(client, catalogueId, selected.expectedRevisionId);
                if (revision?.kind !== 'structure') throw new ContentNotFoundError();
                const ordered = await hostedOrderedReleasePlacements(
                  client,
                  catalogueId,
                  revision.revision_id,
                  selected.occurrenceIds,
                );
                return selectHostedRelease(
                  ordered ??
                    (await hostedReleasePlacements(client, catalogueId, revision.revision_id, selected.occurrenceIds)),
                  selected.occurrenceIds,
                );
              })
            ).value
          : authored!;
      await validateHostedChapterAttachments(deps, placements, { actor, deadline: context.deadline });
      // Attachment currentness can outlast Access evidence. Mint the write
      // proof afterward; transactional authorization still rechecks authority.
      const evidence = await base.prepare!(attempt);
      // Only complete preparation supplies this attempt's immutable selection.
      // A retry repeats admission and selection outside the write transaction.
      prepared.set(attempt.time, placements);
      return evidence;
    },
  };
  const commandOptions = {
    ...principalCommandIdentity(actor),
    partition: partitionOf(route),
    deadline: context.deadline,
    clock: deps.clock,
    receipt,
  };
  const replay = await preflightCommandReceipt<HostedCommandValue>(deps.pool, {
    ...commandOptions,
    authorization: base,
  });
  if (replay) return replay;

  const revisionId = newId(route);
  return runCommand<HostedCommandValue>(
    deps.pool,
    { ...commandOptions, authorization },
    async (tx, { transactionId, time }) => {
      const current = await hostedCatalogue(tx, catalogueId, true);
      // Preconditions belong after the receipt seam: a committed exact retry survives later edits.
      if (mutation.kind === 'create') {
        if (current) throw new RevisionPreconditionError();
        const inserted = await tx.query(
          `INSERT INTO content.hosted_catalogue(route,catalogue_id,thread_id,head_revision_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT (route,catalogue_id) DO NOTHING RETURNING catalogue_id`,
          [route, catalogueId, threadId, revisionId],
        );
        if (!inserted.rows.length) throw new RevisionPreconditionError();
      } else {
        if (!current || current.thread_id !== threadId) throw new ContentNotFoundError();
        if (
          current.head_revision_id !== mutation.input.expectedRevisionId ||
          (mutation.kind === 'publish' && current.publication_id !== mutation.input.expectedPublicationId)
        )
          throw new RevisionPreconditionError();
      }
      const orderedAppend =
        mutation.kind === 'append'
          ? await appendHostedOrderedRootChapter(
              tx,
              catalogueId,
              mutation.input.expectedRevisionId,
              {
                revisionId,
                recordedTransactionId: transactionId,
                recordedAt: authoritativeTimeValue(time),
              },
              prepared.get(time)![0] as Extract<OrderedHostedPlacement, { kind: 'chapter' }>,
            )
          : false;
      if (!orderedAppend) {
        await tx.query(
          `INSERT INTO content.hosted_structure_revision
       (route,catalogue_id,revision_id,kind,source_revision_id,recorded_transaction_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            route,
            catalogueId,
            revisionId,
            mutation.kind === 'publish' ? 'publication' : 'structure',
            mutation.kind === 'publish' ? mutation.input.expectedRevisionId : null,
            transactionId,
            authoritativeTimeValue(time),
          ],
        );
      }
      if (mutation.kind === 'append') {
        if (!orderedAppend) {
          await insertHostedRootAppend(
            tx,
            catalogueId,
            mutation.input.expectedRevisionId,
            revisionId,
            prepared.get(time)![0] as Extract<OrderedHostedPlacement, { kind: 'chapter' }>,
          );
        }
      } else {
        await insertHostedPlacements(tx, catalogueId, revisionId, prepared.get(time)!);
      }
      if (!orderedAppend) {
        await tx.query(
          `UPDATE content.hosted_catalogue SET ${mutation.kind === 'publish' ? 'publication_id' : 'head_revision_id'}=$3
       WHERE route=$1 AND catalogue_id=$2`,
          [route, catalogueId, revisionId],
        );
      }
      const value = { catalogueId, revisionId };
      return {
        value,
        events: [
          {
            type: `com.rezics.content.hosted-catalogue.${mutation.kind === 'append' ? 'revise' : mutation.kind}.v1`,
            subject: catalogueId,
            data: value,
          },
        ],
      };
    },
  );
}

function pointAttachments(input: HostedDraftPointMutation): OrderedHostedPlacement[] {
  if (input.operation !== 'insert' || input.placement.kind !== 'chapter') return [];
  return [
    {
      occurrenceId: input.occurrenceId,
      parentId: input.parentId,
      position: 0,
      ordinal: 0,
      title: input.title,
      kind: 'chapter',
      target: input.placement.target,
    },
  ];
}

function assertPointRoutes(route: number, input: HostedDraftPointMutation) {
  if (routeOf(input.expectedRevisionId) !== route)
    throw new InvalidHostedStructureError('Invalid expected structure revision');
  if (routeOf(input.occurrenceId) !== route) throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
  if (input.operation === 'insert') {
    if (input.parentId !== null && routeOf(input.parentId) !== route)
      throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
    if (input.beforeOccurrenceId !== null && routeOf(input.beforeOccurrenceId) !== route)
      throw new InvalidHostedStructureError('Invalid hosted draft point anchor');
  }
}

async function mutatePoint(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedDraftPointMutation,
  context: HostedCommandContext,
) {
  input = structuredClone(input);
  const route = routeOf(catalogueId);
  if (route === null || actor.kind !== 'account') throw new ContentNotFoundError();
  assertPointRoutes(route, input);
  const initial = (await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId))).value;
  const threadId = initial?.thread_id;
  if (!threadId || routeOf(threadId) !== route) throw new ContentNotFoundError();
  const kind = `content.hosted-catalogue.${input.operation === 'insert' ? 'insert-draft-point' : 'remove-draft-point'}`;
  const receipt = {
    kind,
    key: context.idempotencyKey,
    digest: requestDigest(kind, actor, { catalogueId, input }),
  };
  const base = hostedPostAuthorization(deps, actor, threadId, catalogueId, context, receipt);
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      await validateHostedChapterAttachments(deps, pointAttachments(input), { actor, deadline: context.deadline });
      // Mint short-lived Access evidence only after exact attachment admission.
      return base.prepare!(attempt);
    },
  };
  if (input.operation === 'insert') {
    const replay = await preflightCommandReceipt<HostedCommandValue>(deps.pool, {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt,
      authorization: base,
    });
    if (replay) return replay;
  }
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
    async (tx, { transactionId, time }) => {
      const current = await hostedCatalogue(tx, catalogueId, true);
      if (!current || current.thread_id !== threadId) throw new ContentNotFoundError();
      if (current.head_revision_id !== input.expectedRevisionId) throw new RevisionPreconditionError();
      await commitHostedDraftPointWrite(
        tx,
        catalogueId,
        {
          revisionId,
          recordedTransactionId: transactionId,
          recordedAt: authoritativeTimeValue(time),
        },
        input,
      );
      const value = { catalogueId, revisionId };
      return {
        value,
        events: [
          {
            type: 'com.rezics.content.hosted-catalogue.revise.v1',
            subject: catalogueId,
            data: value,
          },
        ],
      };
    },
  );
}
