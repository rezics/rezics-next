import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import type { ClaimMediaInput } from './media.ts';
import claimCoverMediaStatement from './claim-cover-media.sql';
import { coverReferenceSource } from './cover-reference-read.ts';

export {
  checkMediaObject,
  checkMediaObjects,
  validateCoverReferenceMetadata,
  type CoverReference,
} from './cover-reference-read.ts';

/** Internal storage hook for claimMedia's semantic-reference branch. The caller supplies
 * the allocated candidate and numeric revision after current container authorization.
 * A failure must escape the referencing command so all proposal and claim writes roll back.
 */
export async function claimCoverMedia(
  tx: CommandTransaction,
  input: Extract<ClaimMediaInput, { reference: unknown }>,
): Promise<void> {
  const command = currentCommand(tx);
  const { author, reference } = input;
  const route = routeOf(input.containerId);
  const subjectRoute = routeOf(reference.subjectId);
  const candidateRoute = routeOf(reference.candidateId);
  if (
    author.kind !== 'account' ||
    !command.basis ||
    author.accountId !== command.basis.actorAccountId ||
    author.clientId !== command.basis.clientId ||
    author.requestedBy !== command.basis.requestedBy ||
    route === null ||
    partitionOf(route) !== command.partition ||
    reference.kind !== 'semantic_candidate' ||
    reference.subjectId !== input.containerId ||
    subjectRoute === null ||
    candidateRoute === null ||
    partitionOf(subjectRoute) !== command.partition ||
    partitionOf(candidateRoute) !== command.partition ||
    !Number.isSafeInteger(reference.revision) ||
    reference.revision < 1 ||
    reference.revision > 2147483647 ||
    input.mediaIds.length < 1 ||
    input.mediaIds.length > 32 ||
    new Set(input.mediaIds).size !== input.mediaIds.length ||
    input.mediaIds.some((id) => routeOf(id) !== route) ||
    (command.authorization !== null &&
      (command.authorization.mode !== 'execute' ||
        !(
          (command.authorization.resource.id === reference.subjectId &&
            command.authorization.resource.route === subjectRoute) ||
          ((command.authorization.action === 'statement:propose' ||
            command.authorization.action === 'subject:create') &&
            command.authorization.resource.id === GLOBAL_CONTEXT &&
            command.authorization.resource.route === routeOf(GLOBAL_CONTEXT))
        )))
  )
    throw new TypeError('Invalid cover reference command context');
  const rows = await claimCoverMediaStatement.run(tx, {
    route,
    media_ids: [...input.mediaIds],
    container_id: input.containerId,
    uploader_id: author.accountId,
    at: authoritativeTimeValue(command.time),
  });
  if (rows.length !== input.mediaIds.length || rows.some((row) => coverReferenceSource(row) === null))
    throw new TypeError('Cover media is unavailable for this reference');
}
