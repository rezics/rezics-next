import type { Actor } from '../request/access.ts';
import type {
  AuthorErasureDependencies,
  AuthorErasureInput,
  CommandRequestContext,
  Operation,
  RequestContext,
} from './operation-contract.ts';
import type { CommandOutcome } from '../command/command.ts';

/** Initiates native author-erasure work. The port remains closed until its
 * authorization and workflow integration are implemented.
 */
export async function beginAuthorErasure(
  _deps: AuthorErasureDependencies,
  _actor: Actor,
  _input: AuthorErasureInput,
  _context: CommandRequestContext,
): Promise<CommandOutcome<{ operationId: string }>> {
  throw new Error('Author erasure initiation is not implemented');
}

/** Reads a native-backed AIP-151 operation. The port remains closed until its
 * anchored self-read integration is implemented.
 */
export async function readOperation(
  _deps: AuthorErasureDependencies,
  _actor: Actor,
  _operationId: string,
  _context: RequestContext,
): Promise<Operation | null> {
  throw new Error('Operation reads are not implemented');
}
