import type { PublicSearchPage, SavedCatalogueMembersInput, SearchServiceContract } from './service-contract.ts';
import type { SavedCatalogueMembersPage } from './service-contract.ts';

export type {
  SavedCatalogueMembers,
  SavedCatalogueMembersInput,
  SavedCatalogueMembersPage,
} from './service-contract.ts';
/** The ordinary complete public Search consumer supplies catalogue membership, including preparation,
 * canonical DISTINCT, current disclosure, native recovery and retained continuation. Library supplies
 * the saved identity/meaning and current private authority; no Library presence is added to the query.
 * The accepted release digest is the selected catalogue meaning: a later working B does not replace it.
 * A restart from a superseded cursor is passed through unchanged for the Library caller to answer.
 */
export async function readSavedCatalogueMembers(
  search: Pick<SearchServiceContract, 'search'>,
  input: SavedCatalogueMembersInput,
): Promise<SavedCatalogueMembersPage> {
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
}
