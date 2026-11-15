import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { InvalidMediaClaimError, MediaUnavailableError } from './media.ts';
import claim from './claim-knowledge-media.sql';

/** Claim the exact stored revision after its document head and placement exist.
 * The document container fixes ownership; subsequent own revisions can retain the
 * same image without replacing its first claim or using a Post identity.
 */
export async function claimKnowledgeMedia(
  tx: CommandTransaction,
  input: Readonly<{ mediaIds: readonly string[]; documentId: string; revisionId: string; author: Actor }>,
): Promise<void> {
  const command = currentCommand(tx);
  const route = routeOf(input.documentId);
  if (
    route === null ||
    input.author.kind !== 'account' ||
    routeOf(input.author.accountId) !== route ||
    command.partition !== partitionOf(route) ||
    command.basis?.actorAccountId !== input.author.accountId ||
    command.basis.clientId !== input.author.clientId ||
    command.basis.requestedBy !== input.author.requestedBy ||
    command.authorization?.mode !== 'execute' ||
    command.authorization.action !== 'account:update' ||
    command.authorization.resource.route !== route ||
    command.authorization.resource.id !== input.author.accountId
  )
    throw new GrantDeniedError();
  if (!Array.isArray(input.mediaIds) || input.mediaIds.length > 32 ||
    new Set(input.mediaIds).size !== input.mediaIds.length) throw new InvalidMediaClaimError();
  if (routeOf(input.revisionId) !== route || input.mediaIds.some((id) => routeOf(id) !== route))
    throw new MediaUnavailableError();
  const result = await claim.run(tx, {
    route,
    document_id: input.documentId,
    revision_id: input.revisionId,
    uploader_id: input.author.accountId,
    media_ids: [...input.mediaIds].sort(),
    at: authoritativeTimeValue(command.time),
  });
  if (!result?.eligible || result.claimedCount !== input.mediaIds.length) throw new MediaUnavailableError();
}
