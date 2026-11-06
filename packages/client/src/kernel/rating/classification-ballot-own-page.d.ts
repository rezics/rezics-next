import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { classificationAggregateView, type Assessment } from './classification-ballot.ts';
export declare const CLASSIFICATION_BALLOT_OWN_PAGE_SIZE = 20;
export declare const CLASSIFICATION_BALLOT_OWN_PAGE_MAX_SELECTED: number;
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    routeKey: Uint8Array;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
};
type Key = {
    subjectId: string;
    associationId: string;
};
type PageItemCommon = {
    subjectId: string;
    associationId: string;
    own: {
        assessment: Assessment;
        falsePositive: boolean;
        revision: string;
        pending: 'current' | 'pending' | 'unknown';
    };
    actions: {
        state: 'editable' | 'read-only' | 'withdraw-only' | 'withheld';
        readback: string | null;
        set: string | null;
        clear: string | null;
    };
};
type PageItem = PageItemCommon & ({
    state: 'available';
    subject: {
        id: string;
        type: string;
        label: string | null;
        href: string;
    };
    target: {
        id: string;
        type: string;
        label: string | null;
        href: string;
    };
    association: {
        subjectId: string;
        associationId: string;
        slotId: string;
        property: string;
        targetId: string;
        contextId: typeof GLOBAL_CONTEXT;
        origin: 'global';
        release: string;
        revision: number;
        bindingHash: string;
        statementDigest: string;
        qualifiersDigest: string;
    };
    aggregate: ReturnType<typeof classificationAggregateView> | null;
} | {
    state: 'withheld';
    subject: null;
    target: null;
    association: null;
    aggregate: null;
});
export type ClassificationBallotOwnPage = {
    viewer: {
        accountId: string;
    };
    inventory: {
        kind: 'current-retained';
        complete: false;
        generation: string | null;
        cleanup: 'not-started' | 'pending' | 'settled';
    };
    items: PageItem[];
    traversal: 'more' | 'complete';
    next: string | null;
};
/** One private page over the account-home retained-slot index. Hidden associations never hydrate old labels. */
export declare function createClassificationBallotOwnPageReader(deps: Dependencies): {
    page(actor: Actor, input: {
        cursor?: string;
        selected?: Key;
    }, deadline: number): Promise<ClassificationBallotOwnPage>;
};
export {};
