import type { IndexedSubject, RelationFacetMatch } from './source.ts';
import type { TextNode } from './text.ts';
export type ReleaseSearchTextMatcher = Readonly<{
    matchesText(subject: IndexedSubject, query: TextNode): Promise<RelationFacetMatch>;
}>;
/** A text check for one request, already bound to its admitted query and physical analyzer. */
export type ReleaseSearchCurrentText = (subject: IndexedSubject) => Promise<boolean>;
/** Preserve Search's readiness outcome when current native text cannot decide the query. */
export declare function bindReleaseSearchText(matcher: ReleaseSearchTextMatcher | undefined, query: TextNode | undefined, notProven: () => never): ReleaseSearchCurrentText | undefined;
export type ReleaseSearchGroupCandidate = Readonly<{
    kind: 'work' | 'release';
    id: string;
}>;
export type ReleaseSearchGroupPage = Readonly<{
    keys: ReleaseSearchGroupCandidate[];
    after: string;
    exhausted: boolean;
}>;
/** Name order is established by native current-name traversal, then checked against current work text. */
export declare function filterReleaseSearchNameGroups(page: ReleaseSearchGroupPage, readCurrent: (ids: readonly string[]) => Promise<ReadonlyMap<string, IndexedSubject>>, workTypes: ReadonlySet<string>, matchesText: ReleaseSearchCurrentText): Promise<ReleaseSearchGroupPage>;
