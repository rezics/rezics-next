import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { MediaUnavailableError } from './media.ts';
import publish from './publish-knowledge-media.sql';

/** Record exact public-selection retention within the owner's publication command.
 * This marker never grants a read, and a later document generation invalidates it.
 */
export async function publishKnowledgeMedia(
  tx: CommandTransaction,
  input: Readonly<{ documentId: string; revisionId: string; publicationId: string; author: Actor }>,
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
  if (routeOf(input.revisionId) !== route || routeOf(input.publicationId) !== route)
    throw new MediaUnavailableError();
  const [result] = await publish.run(tx, {
    route,
    document_id: input.documentId,
    revision_id: input.revisionId,
    publication_id: input.publicationId,
    uploader_id: input.author.accountId,
  });
  if (!result?.eligible || result.retainedCount !== result.mediaCount) throw new MediaUnavailableError();
}
