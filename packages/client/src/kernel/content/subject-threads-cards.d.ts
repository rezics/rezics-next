import type { FeedAuthor } from './feed-contract.ts';
import type { AnchoredPosition, FeedParentContext, FeedReviewContext, ReadContext } from './model.ts';
import { type DocumentImagePresentation } from './media-presentation.ts';
import type { MediaDependencies } from './media.ts';
import { type ReadingPageDependencies, type SelectedReadingCardBatchResult } from './reading-page.ts';
import type { ReactionCountFreshness } from './reads.ts';
import type { SubjectThreadWithReactions } from './subject-threads-reactions.ts';
export type SubjectThreadCardDependencies = ReadingPageDependencies & MediaDependencies;
type CardAuthor = Readonly<{
    state: 'current';
    identity: FeedAuthor;
}> | Readonly<{
    state: 'unavailable';
}> | Readonly<{
    state: 'withheld';
}>;
type CardMedia = Readonly<{
    state: 'none' | 'available' | 'unavailable' | 'withheld';
    images: readonly DocumentImagePresentation[];
}>;
type CardComments = Readonly<{
    state: 'current';
    cohort: 'public';
    count: Readonly<{
        kind: 'exact' | 'lower-bound';
        value: number;
    }>;
    lastActivityAt: string | null;
    source: Readonly<{
        epoch: number;
        position: string;
    }>;
}> | Readonly<{
    state: 'unavailable' | 'withheld';
}>;
export type SubjectThreadCard = Readonly<{
    state: 'current' | 'erased';
    authors: Readonly<{
        thread: CardAuthor;
        openingPost: CardAuthor;
    }>;
    presentation: Readonly<{
        state: 'current';
        language: string | null;
        spoiler: boolean;
    }> | Readonly<{
        state: 'withheld';
    }>;
    media: CardMedia;
    comments: CardComments;
    actions: Readonly<{
        state: 'current' | 'unavailable' | 'not_applicable';
        retryable: boolean;
        references: SelectedReadingCardBatchResult['actions']['references'];
    }>;
    reply: Readonly<{
        state: 'available' | 'sign_in_required' | 'denied' | 'withheld' | 'unavailable';
    }>;
    watch: Readonly<{
        state: 'current';
        watching: boolean;
    }> | Readonly<{
        state: 'sign_in_required';
    }> | Readonly<{
        state: 'unavailable';
        retryable: true;
    }> | Readonly<{
        state: 'withheld';
    }>;
    parentContext?: FeedParentContext;
    currentness: Readonly<{
        source: 'current';
        place: 'current';
        authors: 'current' | 'unavailable' | 'not_applicable';
        reactions: 'current' | 'unavailable' | 'not_applicable';
        actions: 'current' | 'unavailable' | 'not_applicable';
        watch: 'current' | 'sign_in_required' | 'unavailable' | 'not_applicable';
        media: 'current' | 'unavailable' | 'not_applicable';
        comments: 'current' | 'unavailable' | 'not_applicable';
    }>;
}>;
export type SubjectThreadCardEntry = Omit<SubjectThreadWithReactions, 'reactions' | 'viewerReaction'> & Partial<Pick<SubjectThreadWithReactions, 'reactions' | 'viewerReaction'>> & Readonly<{
    card: SubjectThreadCard;
    reviewContext?: FeedReviewContext;
}>;
export type SubjectThreadCardProjection = Readonly<{
    entries: readonly SubjectThreadCardEntry[];
    anchors: readonly AnchoredPosition[];
    reactionsAsOf: ReactionCountFreshness | null;
}>;
/** Adds bounded card fields around Subject's selected native threads and retains every final source check. */
export declare function projectSubjectThreadCards(dependencies: SubjectThreadCardDependencies, subjectId: string, placeId: string, selected: readonly SubjectThreadWithReactions[], context: ReadContext, reactionsAsOf: SubjectThreadCardProjection['reactionsAsOf']): Promise<SubjectThreadCardProjection>;
export {};
