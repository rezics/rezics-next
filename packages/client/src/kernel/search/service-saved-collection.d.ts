import type { FilterDocument, FilterRelease } from '@rezics/filter';
import type { AccountActor } from '../request/access.ts';
import type { SearchService } from './service-scope.ts';
import type { PublicSearchPage, PublicSearchReadContext } from './service.ts';
/** One saved Collection members page. The Library caller owns the members cursor and its stale response. */
export type SavedCatalogueMembersInput = Readonly<{
    actor: AccountActor;
    collection: NonNullable<PublicSearchReadContext['savedCollection']>;
    filter: FilterDocument;
    release: {
        digest: string;
        release: FilterRelease;
    };
    limit: number;
    cursor?: string | null;
    scope: NonNullable<PublicSearchReadContext['scope']>;
    revalidate: () => Promise<void>;
}>;
export type SavedCatalogueMembersPage = Readonly<{
    members: readonly Readonly<{
        kind: 'dynamic';
        subjectId: string;
    }>[];
    next: PublicSearchPage['next'];
}>;
/** The Search service's saved-membership entry, reached by Library through its injected Search service. */
export type SavedCatalogueMembers = (input: SavedCatalogueMembersInput) => Promise<SavedCatalogueMembersPage>;
/** The ordinary complete public Search consumer supplies catalogue membership, including preparation,
 * canonical DISTINCT, current disclosure, native recovery and retained continuation. Library supplies
 * the saved identity/meaning and current private authority; no Library presence is added to the query.
 * A restart from a superseded cursor is passed through unchanged for the Library caller to answer.
 */
export declare function readSavedCatalogueMembers(search: Pick<SearchService, 'search'>, input: SavedCatalogueMembersInput): Promise<SavedCatalogueMembersPage>;
