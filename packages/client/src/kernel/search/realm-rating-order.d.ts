import { type FilterDocument, type FilterRelease } from '@rezics/filter';
import type { KeyRing } from '../tokens/seal.ts';
import type { Access, Actor } from '../request/access.ts';
import type { SearchCursorBinding } from './cursor.ts';
import type { SearchHit } from './query.ts';
import { type RatingCursorContext, type RatingPhase } from './rating-cursor.ts';
import type { PublicRatingFigure } from './rating-source.ts';
import { type SubjectSource } from './source.ts';
import type { parseText } from './text.ts';
import { type SearchFrontier } from './useful-page.ts';
export type RealmRatingContext = RatingCursorContext & {
    realm: {
        authority: string;
        revision: string;
    };
    generation: number;
    asOf: string;
};
export type RealmRatingQuery = {
    principal: string;
    populationId: string;
    release: FilterRelease | undefined;
    meaningDigest: string | undefined;
    text: ReturnType<typeof parseText> | undefined;
    filter: FilterDocument | undefined;
    deadline: number;
    /** Live HTTP token/actor authority, not recovered from the principal or cursor. */
    authority?: {
        access: Access;
        actor: Actor;
    };
};
export type RealmRatingHit = SearchHit & {
    ratingPhase: RatingPhase;
    /** Same subject-home snapshot as the figure, including a proven absent figure. */
    position: bigint;
    threshold: 5 | 10;
    figure: PublicRatingFigure | null;
};
/** Content-owned native seam. No default provider is fabricated from Global/indexed figures.
 * observe checks current Context read AND ban authority for this principal, even for empty queries.
 * HTTP supplies the live Access/Actor; standalone compositions own equivalent native authority.
 * A provider unable to evaluate that authority rejects instead of inferring a grant from the principal.
 * authority changes on every relevant access transition, revision on every canonical population,
 * figure revision, prior eligibility or meaning change (including null -> eligible -> null).
 * read seeks the COMPLETE canonical predicate in native scored-descending/unscored order, with
 * name_sort missing-last and ID ties. It must preserve catalogue text/analyzer/Boolean semantics,
 * not filter or sort a fetched prefix. Both phases use the same frozen same-population prior.
 * Each read owns one bounded native seek; absent/denied/partial evidence rejects, never empty EOF.
 */
export interface RealmRatingSource {
    observe(query: RealmRatingQuery): Promise<RealmRatingContext>;
    read(query: RealmRatingQuery, context: RealmRatingContext, request: SearchFrontier & {
        size: number;
    }): Promise<{
        context: RealmRatingContext;
        hits: RealmRatingHit[];
    }>;
}
/** Separately bound native adapter: never relax or route Realm figures through the Global validator. */
export declare function normalizeRealmRatingHit(hit: RealmRatingHit, context: RealmRatingContext): void;
export declare function readRealmRatingOrder(options: {
    ratings: RealmRatingSource | undefined;
    source: SubjectSource;
    query: RealmRatingQuery;
    cursors: KeyRing;
    binding: SearchCursorBinding;
    cursor?: string;
    limit: number;
    now: number;
}): Promise<{
    subjects: readonly import("./source.ts").IndexedSubject[];
    next: string | null;
    as_of: string;
    finalize(): Promise<void>;
}>;
