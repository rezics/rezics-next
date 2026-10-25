import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type {
  Anchored,
  BoardId,
  BoardView,
  ItemView,
  Page,
  PostId,
  ReadContext,
  RevisionId,
  RevisionView,
  ThreadId,
  ThreadView,
} from './model.ts';
import { unfinishedPort } from './model.ts';

export type ContentReadDependencies = Readonly<{ pool: Pool; access: Access; tokens: KeyRing }>;
export function readBoard(
  _dependencies: ContentReadDependencies,
  _boardId: BoardId,
  _context: ReadContext,
): Promise<Anchored<BoardView | null>> {
  throw unfinishedPort('readBoard');
}
export function readThread(
  _dependencies: ContentReadDependencies,
  _threadId: ThreadId,
  _context: ReadContext,
): Promise<Anchored<ThreadView | null>> {
  throw unfinishedPort('readThread');
}
export function readPost(
  _dependencies: ContentReadDependencies,
  _threadId: ThreadId,
  _postId: PostId,
  _context: ReadContext,
  _revisionId?: RevisionId,
): Promise<Anchored<ItemView | null>> {
  throw unfinishedPort('readPost');
}
export function listThreadPosts(
  _dependencies: ContentReadDependencies,
  _threadId: ThreadId,
  _context: ReadContext,
  _cursor?: string,
  _limit?: number,
): Promise<Page<ItemView>> {
  throw unfinishedPort('listThreadPosts');
}
export function listPostRevisions(
  _dependencies: ContentReadDependencies,
  _threadId: ThreadId,
  _postId: PostId,
  _context: ReadContext,
  _cursor?: string,
  _limit?: number,
): Promise<Page<RevisionView>> {
  throw unfinishedPort('listPostRevisions');
}
export function discloseThreads(
  _dependencies: ContentReadDependencies,
  _threadIds: readonly ThreadId[],
  _context: ReadContext,
): Promise<readonly Anchored<ThreadView | null>[]> {
  throw unfinishedPort('discloseThreads');
}
export type { Actor };
