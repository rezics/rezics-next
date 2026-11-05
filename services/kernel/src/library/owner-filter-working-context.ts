import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import type { AuthoritativeTime, CommandAttempt } from '../command/command.ts';
import type { Actor } from '../request/access.ts';
import type { CollectionMemberAdmission } from './owner-filter.ts';
import type { NativeCollectionWork } from './collection-source-work.ts';

export type Context = Readonly<{
  pool: Pool;
  actor: Actor;
  collectionId: string;
  admission: CollectionMemberAdmission;
  at: AuthoritativeTime;
  deadline: number;
  work: NativeCollectionWork;
  attempt?: CommandAttempt;
}>;
export const contexts = new AsyncLocalStorage<Context>();
