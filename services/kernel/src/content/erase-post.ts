import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';

export type ErasePostDependencies = Readonly<{
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  clock?: () => Date;
}>;

export type ErasePostContext = Readonly<{
  deadline: number;
  idempotencyKey: string;
  requestId: string;
}>;

export type ErasePostInput = Readonly<{ postId: string; reason: string }>;

/** Logical erasure of one post. Storage and authorization wiring is not implemented yet. */
export async function erasePostLogical(
  _deps: ErasePostDependencies,
  _actor: Actor,
  _input: ErasePostInput,
  _context: ErasePostContext,
): Promise<CommandOutcome<{ postId: string; securityRevision: string }>> {
  throw new Error('Logical post erasure is not implemented');
}
