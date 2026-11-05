import type { FilterDocument, FilterRelease } from '@rezics/filter';
import { ProblemError } from '../http/problem.ts';
import type { AccountActor } from '../request/access.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { SearchService } from './service-scope.ts';
import type { PublicSearchReadContext } from './service.ts';

/** The ordinary complete public Search consumer supplies catalogue membership, including preparation,
 * canonical DISTINCT, current disclosure, native recovery and retained continuation. Library supplies
 * the saved identity/meaning and current private authority; no Library presence is added to the query.
 */
export async function readSavedCatalogueMembers(
  search: Pick<SearchService, 'search'>,
  input: Readonly<{
    actor: AccountActor;
    collection: NonNullable<PublicSearchReadContext['savedCollection']>;
    filter: FilterDocument;
    release: { digest: string; release: FilterRelease };
    limit: number;
    cursor?: string | null;
    scope: LeafOptions;
    revalidate: () => Promise<void>;
  }>,
) {
  try {
    const page = await search.search(
      `account:${input.actor.accountId}`,
      {
        filter: input.filter,
        sort: 'id',
        limit: input.limit,
        ...(input.cursor == null ? {} : { cursor: input.cursor }),
      },
      undefined,
      input.release,
      {
        deadline: input.scope.deadline,
        scope: input.scope,
        savedCollection: input.collection,
        complete: input.revalidate,
      },
    );
    return {
      members: page.subjects.map(({ id }) => ({ kind: 'dynamic' as const, subjectId: id })),
      next: page.next,
    };
  } catch (error) {
    if (input.cursor != null && error instanceof ProblemError && error.code === 'search_restart_required')
      throw new ProblemError('stale_cursor');
    throw error;
  }
}
