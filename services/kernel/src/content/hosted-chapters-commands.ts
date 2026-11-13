import type { Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
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
import { snapshot } from './reads.ts';
import { validateHostedChapterAttachments } from './hosted-chapters-attachments.ts';
import { insertHostedRootAppend } from './hosted-chapters-append.ts';
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
  type HostedReviseInput,
  type HostedPublishInput,
  type HostedRootAppendInput,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';

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
      // Native preparation checks owner/container state and post:revise Access.
      // Transactional authorization still consumes its proof and rechecks the
      // container before receipts; preparation alone never permits a write.
      const evidence = await base.prepare!(attempt);
      const placements =
        mutation.kind === 'publish'
          ? (
              await snapshot(deps, catalogueId, context, async (client) => {
                const selected = mutation.input;
                const revision = await hostedRevision(client, catalogueId, selected.expectedRevisionId);
                if (revision?.kind !== 'structure') throw new ContentNotFoundError();
                return selectHostedRelease(
                  await hostedReleasePlacements(client, catalogueId, revision.revision_id, selected.occurrenceIds),
                  selected.occurrenceIds,
                );
              })
            ).value
          : authored!;
      await validateHostedChapterAttachments(deps, placements, { actor, deadline: context.deadline });
      // Only complete preparation supplies this attempt's immutable selection.
      // A retry repeats admission and selection outside the write transaction.
      prepared.set(attempt.time, placements);
      return evidence;
    },
  };
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
      if (mutation.kind === 'append') {
        await insertHostedRootAppend(
          tx,
          catalogueId,
          mutation.input.expectedRevisionId,
          revisionId,
          prepared.get(time)![0] as Extract<OrderedHostedPlacement, { kind: 'chapter' }>,
        );
      } else {
        await insertHostedPlacements(tx, catalogueId, revisionId, prepared.get(time)!);
      }
      await tx.query(
        `UPDATE content.hosted_catalogue SET ${mutation.kind === 'publish' ? 'publication_id' : 'head_revision_id'}=$3
       WHERE route=$1 AND catalogue_id=$2`,
        [route, catalogueId, revisionId],
      );
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
