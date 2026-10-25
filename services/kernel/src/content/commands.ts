import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { Access, Actor, Resource } from '../request/access.ts';
import type { ContentCommandValue, PostInput, RequestContext, RevisionInput, ThreadInput } from './model.ts';
import { unfinishedPort } from './model.ts';

export type ContentCommandDependencies = Readonly<{
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  clock?: () => Date;
}>;
export type ThreadTarget = Resource;
export function threadTarget(_routeKey: Uint8Array, _accountId: string, _idempotencyKey: string): Resource {
  throw unfinishedPort('threadTarget');
}
export function createThread(
  _dependencies: ContentCommandDependencies,
  _actor: Actor,
  _input: ThreadInput,
  _context: RequestContext,
): Promise<CommandOutcome<ContentCommandValue>> {
  throw unfinishedPort('createThread');
}
export function createPost(
  _dependencies: ContentCommandDependencies,
  _actor: Actor,
  _input: PostInput,
  _context: RequestContext,
): Promise<CommandOutcome<ContentCommandValue>> {
  throw unfinishedPort('createPost');
}
export function revisePost(
  _dependencies: ContentCommandDependencies,
  _actor: Actor,
  _input: RevisionInput,
  _context: RequestContext,
): Promise<CommandOutcome<ContentCommandValue>> {
  throw unfinishedPort('revisePost');
}
