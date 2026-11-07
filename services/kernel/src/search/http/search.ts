import { searchOperationProblem } from './operation-problems.ts';
import { ProblemError } from '../../http/problem-error.ts';
import type { Actor } from '../../request/access.ts';
import {
  searchNativeRecoveryFamily,
  searchNativeRecoveryInput,
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
    const problem = searchOperationProblem(error);
    if (problem instanceof ProblemError) throw searchNativeRetainOrRestart(problem, authored);
    throw problem;
  }
}

export function searchHttpFamilyFromStatus(
  status: number,
  code?: string,
  cursorPointer?: boolean,
): SearchNativeRecoveryFamily {
  return searchNativeRecoveryFamily(searchNativeRecoveryInput(status, code, cursorPointer));
}
