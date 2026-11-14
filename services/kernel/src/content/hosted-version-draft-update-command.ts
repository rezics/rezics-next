import type { Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  preflightCommandReceipt,
  runCommand,
  type CommandAuthorization,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, hostedPostAuthorization, type ContentCommandDependencies } from './commands.ts';
import { validateHostedChapterAttachments } from './hosted-chapters-attachments.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import {
  InvalidHostedStructureError,
  type HostedCommandContext,
  type HostedCommandValue,
  type HostedDependencies,
  type HostedDraftPointUpdateInput,
  type OrderedHostedPlacement,
} from './hosted-chapters-model.ts';
import { snapshot } from './reads.ts';
import { commitHostedVersionDraftUpdate } from './hosted-version-draft-update.ts';

export type HostedVersionDraftUpdateCommandDependencies = HostedDependencies & ContentCommandDependencies;

function attachment(input: HostedDraftPointUpdateInput): OrderedHostedPlacement[] {
  if (input.target === null) return [];
  return [
    {
      occurrenceId: input.occurrenceId,
      parentId: null,
      position: 0,
      ordinal: 0,
      title: input.title,
      kind: 'chapter',
      target: input.target,
    },
  ];
}

/** Rename one existing occurrence or pin a chapter to another exact revision of its bound Post. */
export async function updateHostedDraftPoint(
  deps: HostedVersionDraftUpdateCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedDraftPointUpdateInput,
  context: HostedCommandContext,
) {
  input = structuredClone(input);
  const route = routeOf(catalogueId);
  if (route === null || actor.kind !== 'account') throw new ContentNotFoundError();
  if (routeOf(input.expectedRevisionId) !== route)
    throw new InvalidHostedStructureError('Invalid expected structure revision');
  if (routeOf(input.occurrenceId) !== route) throw new InvalidHostedStructureError('Invalid hosted draft point anchor');

  const initial = (await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId))).value;
  if (!initial) throw new ContentNotFoundError();

  const kind = 'content.hosted-catalogue.update-draft-point';
  const receipt = {
    kind,
    key: context.idempotencyKey,
    digest: requestDigest(kind, actor, { catalogueId, input }),
  };
  const base = hostedPostAuthorization(deps, actor, initial.thread_id, catalogueId, context, receipt);
  const authorization: CommandAuthorization = {
    ...base,
    async prepare(attempt) {
      const evidence = await base.prepare!(attempt);
      await validateHostedChapterAttachments(deps, attachment(input), { actor, deadline: context.deadline });
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
      await commitHostedVersionDraftUpdate(tx, catalogueId, {
        revisionId,
        expectedRevisionId: input.expectedRevisionId,
        occurrenceId: input.occurrenceId,
        title: input.title,
        target: input.target,
        transactionId,
        recordedAt: authoritativeTimeValue(time),
      });
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
