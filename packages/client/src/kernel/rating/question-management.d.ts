import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
};
type ManagementInput = {
    realmId: string;
    selectedQuestionId?: string;
    cursor?: string;
};
/** One Realm directory and one optional exact definition. This is an additive
 * read projection; create, caption and lifecycle commands retain their owners.
 * Caption history and exact revisions retain the existing native read methods. */
export declare function readQuestionManagementPage(deps: Dependencies, actor: Actor, input: ManagementInput, deadline: number): Promise<{
    viewer: {
        accountId: string;
    };
    realmId: string;
    directory: {
        ratingQuestions: {
            id: string;
            revision: number;
            label: string;
            grain: import("./question-authoring.ts").QuestionGrain;
            scale: {
                min: number;
                max: number;
                displayStep: number;
            };
            realmId: string;
            meaning: string;
            canonicalLabel: string;
            labelRevision: number;
            lifecycle: {
                state: 'active' | 'retired';
                revision: number;
            };
        }[];
        next: string | null;
    };
    actions: {
        create: {
            method: 'POST';
            href: string;
        } | null;
    };
    selected: {
        question: {
            id: string;
            revision: number;
            label: string;
            grain: import("./question-authoring.ts").QuestionGrain;
            scale: {
                min: number;
                max: number;
                displayStep: number;
            };
            realmId: string;
            meaning: string;
            canonicalLabel: string;
            labelRevision: number;
            lifecycle: {
                state: 'active' | 'retired';
                revision: number;
            };
        };
        readback: string;
        history: string;
        actions: {
            caption: {
                method: 'PUT';
                href: string;
                expectedLabelRevision: number;
            } | null;
            lifecycle: {
                method: 'POST';
                href: string;
                expectedLifecycleRevision: number;
            } | null;
        };
    } | null;
}>;
export {};
