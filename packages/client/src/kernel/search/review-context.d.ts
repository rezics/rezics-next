import { type ContentReadDependencies } from '../content/reads.ts';
import type { ReviewVoteCitation } from '../content/model.ts';
import { type SubjectSummary } from '../semantic/summaries.ts';
import type { DiscoveryPage, DiscoveryReadContext } from './discovery.ts';
export declare const REVIEW_CONTEXT_LIMITS: Readonly<{
    selected: 100;
    rowBytes: 8192;
    pageBytes: number;
    nodes: 4096;
    depth: 64;
}>;
export type ReviewContextSource = Readonly<{
    openingRevisionId: string;
    sourceVersion: string;
}>;
export type SearchReviewCitation = Readonly<{
    state: 'available';
    recorded: ReviewVoteCitation;
    /** Content has no reusable historical question/label reader yet. A current
     * question is not a substitute for the presentation when this was cited. */
    historicalQuestion: Readonly<{
        state: 'unavailable';
    }>;
}> | Readonly<{
    state: 'absent' | 'unsupported' | 'unavailable' | 'withdrawn' | 'erased' | 'withheld';
}>;
export type SearchReviewContext = Readonly<{
    state: 'unavailable';
}> | Readonly<{
    state: 'available';
    openingPostId: string;
    target: Readonly<{
        state: 'available';
        subject: SubjectSummary;
    }> | Readonly<{
        state: 'withheld' | 'unavailable';
    }>;
    citation: SearchReviewCitation;
    language: string | null;
    spoiler: boolean;
}>;
type Dependencies = ContentReadDependencies & {
    routeKey: Uint8Array;
};
/** Selected page only. Native Content retains all lifecycle/count/cursor authority;
 * this projection has no SQL, current-vote read, refill, command, or browser work. */
export declare function prepareSearchReviewContexts(dependencies: Dependencies, page: DiscoveryPage, context: DiscoveryReadContext): Promise<Readonly<{
    finish(page: DiscoveryPage): Promise<DiscoveryPage>;
}>>;
export {};
