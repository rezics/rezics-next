import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { MediaId, PostId, RequestContext, ThreadId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type ModerationDependencies = Readonly<{ pool: Pool; access: Access }>;
export type TakedownInput = Readonly<{ targetId: ThreadId | PostId | MediaId; reason: string }>;
export type EraseAuthorScopeInput = Readonly<{ authorId: string; scopeId: ThreadId | null; reason: string }>;
export type EraseStandaloneMediaInput = Readonly<{ mediaId: MediaId; reason: string }>;
export type ModerationReceipt = Readonly<{ receiptId: string; targetId: string; securityRevision: number }>;

export async function takedown(
  _dependencies: ModerationDependencies,
  _actor: Actor,
  _input: TakedownInput,
  _context: RequestContext,
): Promise<ModerationReceipt> {
  throw unfinishedPort('takedown');
}

export async function eraseAuthorScope(
  _dependencies: ModerationDependencies,
  _actor: Actor,
  _input: EraseAuthorScopeInput,
  _context: RequestContext,
): Promise<ModerationReceipt> {
  throw unfinishedPort('eraseAuthorScope');
}

export async function eraseStandaloneMedia(
  _dependencies: ModerationDependencies,
  _actor: Actor,
  _input: EraseStandaloneMediaInput,
  _context: RequestContext,
): Promise<ModerationReceipt> {
  throw unfinishedPort('eraseStandaloneMedia');
}
