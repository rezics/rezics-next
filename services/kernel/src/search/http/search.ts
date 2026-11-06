import { ProblemError } from '../../http/problem.ts';
import type { Actor } from '../../request/access.ts';
import {
  searchNativeRecoveryFamily,
  searchNativeRetainOrRestart,
  type SearchNativeRecoveryFamily,
} from './native-recovery.ts';

export type SearchHttpPrincipal = 'anonymous' | `account:${string}`;

/** Current reader for Search, facets and typeahead. Authorization never borrows a previous principal. */
export function searchHttpPrincipal(actor: Actor): SearchHttpPrincipal {
  return actor.kind === 'account' ? `account:${actor.accountId}` : 'anonymous';
}

export async function searchHttpExecute<T>(authored: unknown, execute: () => Promise<T>): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof ProblemError) throw searchNativeRetainOrRestart(error, authored);
    throw error;
  }
}

export function searchHttpFamilyFromStatus(
  status: number,
  code?: string,
  cursorPointer?: boolean,
): SearchNativeRecoveryFamily {
  return searchNativeRecoveryFamily({ status, code, cursorPointer });
}
