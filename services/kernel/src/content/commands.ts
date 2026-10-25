import type { Pool } from 'pg';
import type { Access, Actor, Resource } from '../request/access.ts';
import type {
  CommandReceipt,
  ItemView,
  PostInput,
  RequestContext,
  RevisionInput,
  ThreadId,
  ThreadInput,
  ThreadView,
} from './model.ts';
import { unfinishedPort } from './model.ts';

export type ContentCommandDependencies = Readonly<{ pool: Pool; access: Access }>;
export type ThreadTarget = Readonly<{ id: ThreadId; route: number }>;

export function threadTarget(_threadId: ThreadId): Resource {
  throw unfinishedPort('threadTarget');
}

export async function createThread(
  _dependencies: ContentCommandDependencies,
  _actor: Actor,
  _input: ThreadInput,
  _context: RequestContext,
): Promise<Readonly<{ receipt: CommandReceipt<ThreadId>; threadId: ThreadId; firstPostId: string }>> {
  throw unfinishedPort('createThread');
}

export async function createPost(
  _dependencies: ContentCommandDependencies,
  _actor: Actor,
  _input: PostInput,
  _context: RequestContext,
): Promise<Readonly<{ receipt: CommandReceipt; postId: string }>> {
  throw unfinishedPort('createPost');
}

export async function revisePost(
  _dependencies: ContentCommandDependencies,
  _actor: Actor,
  _input: RevisionInput,
  _context: RequestContext,
): Promise<Readonly<{ receipt: CommandReceipt; itemId: string; revisionId: string }>> {
  throw unfinishedPort('revisePost');
}

export type { ItemView, ThreadView };
