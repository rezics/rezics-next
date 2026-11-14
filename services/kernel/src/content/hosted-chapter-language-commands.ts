import type { Actor } from '../request/access.ts';
import { canonicalLanguageKey } from '@rezics/definitions/language';
import {
  principalCommandIdentity,
  preflightCommandReceipt,
  runCommand,
  authoritativeTimeValue,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, RevisionPreconditionError, hostedPostAuthorization } from './commands.ts';
import type { HostedCommandDependencies } from './hosted-chapters-commands.ts';
import {
  InvalidHostedStructureError,
  type HostedChapterTarget,
  type HostedCommandContext,
  type HostedCommandValue,
} from './hosted-chapters-model.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import { readHostedOccurrenceSelection } from './hosted-chapters-reads.ts';
import { validateHostedChapterAttachments } from './hosted-chapters-attachments.ts';
import { orderHostedPlacements } from './hosted-chapters-tree.ts';
import { commitHostedVersionDraftUpdate } from './hosted-version-draft-update.ts';
import { writeHostedLanguageBinding } from './hosted-chapter-language-store.ts';
import { snapshot } from './reads.ts';
import { readHostedDraftPointSnapshot } from './hosted-version-draft-write.ts';

export type HostedChapterLanguageInput = Readonly<{
  expectedRevisionId: string;
  language: string;
  title: string;
  target: HostedChapterTarget | null;
  makeDefault?: boolean;
}>;

function sameTarget(a: HostedChapterTarget, b: HostedChapterTarget) {
  return a.threadId === b.threadId && a.postId === b.postId && a.revisionId === b.revisionId && a.sha256 === b.sha256;
}

/** One exact association, one draft occurrence update, native receipt and owner CAS. */
export async function bindHostedChapterLanguage(
  deps: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  occurrenceId: string,
  input: HostedChapterLanguageInput,
  context: HostedCommandContext,
) {
  input = structuredClone(input);
  const route = routeOf(catalogueId);
  if (route === null || actor.kind !== 'account') throw new ContentNotFoundError();
  if (
    canonicalLanguageKey(input.language) !== input.language ||
    routeOf(occurrenceId) !== route ||
    routeOf(input.expectedRevisionId) !== route
  )
    throw new InvalidHostedStructureError('Invalid chapter language association');
  if (input.target === null && input.makeDefault)
    throw new InvalidHostedStructureError('The canonical default cannot be removed');
  const attachments =
    input.target === null
      ? []
      : orderHostedPlacements(route, [
          {
            occurrenceId,
            parentId: null,
            position: 0,
            kind: 'chapter',
            title: input.title,
            target: input.target,
          },
        ]);
  const initial = (await snapshot(deps, catalogueId, context, (tx) => hostedCatalogue(tx, catalogueId))).value;
  if (!initial) throw new ContentNotFoundError();
  const kind = 'content.hosted-catalogue.bind-chapter-language';
  const receipt = {
    kind,
    key: context.idempotencyKey,
    digest: requestDigest(kind, actor, { catalogueId, occurrenceId, input }),
  };
  const base = hostedPostAuthorization(deps, actor, initial.thread_id, catalogueId, context, receipt);
  const options = {
    ...principalCommandIdentity(actor),
    partition: partitionOf(route),
    deadline: context.deadline,
    clock: deps.clock,
    receipt,
  };
  const replay = await preflightCommandReceipt<HostedCommandValue>(deps.pool, { ...options, authorization: base });
  if (replay) return replay;
  const admitted = await readHostedOccurrenceSelection(
    deps,
    catalogueId,
    occurrenceId,
    {
      kind: 'structure',
      revisionId: input.expectedRevisionId,
    },
    { actor, deadline: context.deadline },
  );
  const chapter = admitted.placement;
  if (chapter.kind !== 'chapter')
    throw new InvalidHostedStructureError('A language body requires a chapter occurrence');
  if (
    !(
      await snapshot(deps, catalogueId, context, (tx) =>
        readHostedDraftPointSnapshot(tx, catalogueId, input.expectedRevisionId),
      )
    ).value
  )
    throw new InvalidHostedStructureError('The chapter has no canonical ordered draft');
  const isDefault = input.makeDefault || input.language === chapter.bodyLanguages?.defaultLanguage;
  if (isDefault && input.target !== null && !sameTarget(input.target, chapter.target))
    throw new InvalidHostedStructureError('The canonical default target must remain unchanged');
  const revisionId = newId(route);
  return runCommand<HostedCommandValue>(
    deps.pool,
    {
      ...options,
      authorization: {
        ...base,
        async prepare(attempt) {
          await validateHostedChapterAttachments(deps, attachments, { actor, deadline: context.deadline });
          return base.prepare!(attempt);
        },
      },
    },
    async (tx, { transactionId, time }) => {
      const current = await hostedCatalogue(tx, catalogueId, true);
      if (!current || current.head_revision_id !== input.expectedRevisionId) throw new RevisionPreconditionError();
      const version = await writeHostedLanguageBinding(
        tx,
        catalogueId,
        occurrenceId,
        input.language,
        input.target === null ? null : input.title,
        input.target,
      );
      const defaultLanguage = input.makeDefault
        ? input.language
        : input.target === null && isDefault
          ? null
          : (chapter.bodyLanguages?.defaultLanguage ?? null);
      await commitHostedVersionDraftUpdate(tx, catalogueId, {
        revisionId,
        expectedRevisionId: input.expectedRevisionId,
        occurrenceId,
        title: input.makeDefault ? input.title : chapter.title,
        target: chapter.target,
        bodyLanguages: { version, defaultLanguage },
        transactionId,
        recordedAt: authoritativeTimeValue(time),
      });
      const value = { catalogueId, revisionId };
      return {
        value,
        events: [{ type: 'com.rezics.content.hosted-catalogue.revise.v1', subject: catalogueId, data: value }],
      };
    },
  );
}
