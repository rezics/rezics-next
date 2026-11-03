import type { KeyRing } from '../tokens/seal.ts';
import type { Anchored, AnchoredPosition, Page, ReadContext } from './model.ts';
import type { ItemView, PostEntry, RevisionView } from './reads.ts';
type RevisionKey = Readonly<{
    at: string;
    id: string;
}>;
/** A native disclosure retains its original observations and prepared Access
 * checks. Revalidation must not adopt newly changed source rows as a baseline.
 */
export type HistoryPostObservation = Readonly<{
    initial: Anchored<PostEntry | null>;
    current(): Promise<Anchored<PostEntry | null>>;
}>;
export type NativePostRevisionPage = Page<RevisionView> & Readonly<{
    /** Exact native posts, in the same order as entries; no second hydration. */
    posts: readonly ItemView[];
    /** The initially observed current head, kept distinct from every selected revision. */
    currentHead: PostEntry;
    anchors: readonly AnchoredPosition[];
    /** Recheck the retained source and exact selected reads after page enrichment. */
    revalidate(): Promise<boolean>;
}>;
type Dependencies = Readonly<{
    tokens: KeyRing;
    now(): number;
    observe(revisionId?: string): Promise<HistoryPostObservation>;
    select(after: RevisionKey | null, limit: number): Promise<Anchored<Readonly<{
        candidates: readonly RevisionKey[];
        nextKey: RevisionKey | null;
    }>>>;
    unavailable(): never;
}>;
/** One raw native page. Candidate keys never grant disclosure, and a sparse
 * page never causes a refill or moves the cursor beyond the admitted frontier.
 * All callbacks are bound by reads.ts to the ordinary native source authority.
 */
export declare function readNativePostRevisionPage(dependencies: Dependencies, input: Readonly<{
    threadId: string;
    postId: string;
    context: ReadContext;
    cursor?: string;
    limit: number;
}>): Promise<NativePostRevisionPage>;
export {};
