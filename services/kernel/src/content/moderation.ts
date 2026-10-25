import type { Pool } from 'pg';
import type { CommandOutcome } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { MediaId, PostId, RequestContext, ThreadId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type ModerationDependencies = Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array; clock?: () => Date }>;
export type TakedownTarget =
  | Readonly<{ kind: 'board'; id: string }>
  | Readonly<{ kind: 'thread'; id: ThreadId }>
  | Readonly<{ kind: 'post'; id: PostId }>;
export type TakedownInput = Readonly<{ target: TakedownTarget; reason: string }>;
export type EraseAuthorScopeInput = Readonly<{
  scope: Readonly<{ kind: 'thread'; id: ThreadId }>;
  reason: string;
}>;
export type EraseStandaloneMediaInput = Readonly<{ mediaId: MediaId; reason: string }>;
export type ModerationValue = Readonly<{ targetId: string; securityRevision: string }>;
export function takedown(
  _dependencies: ModerationDependencies,
  _actor: Actor,
  _input: TakedownInput,
  _context: RequestContext,
): Promise<CommandOutcome<ModerationValue>> {
  throw unfinishedPort('takedown');
}
export function eraseAuthorScope(
  _dependencies: ModerationDependencies,
  _actor: Actor,
  _input: EraseAuthorScopeInput,
  _context: RequestContext,
): Promise<CommandOutcome<ModerationValue>> {
  throw unfinishedPort('eraseAuthorScope');
}
export function eraseStandaloneMedia(
  _dependencies: ModerationDependencies,
  _actor: Actor,
  _input: EraseStandaloneMediaInput,
  _context: RequestContext,
): Promise<CommandOutcome<ModerationValue>> {
  throw unfinishedPort('eraseStandaloneMedia');
}
