import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import { type PublicIdentity } from '../access/account-data.ts';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
export declare const QUESTION_LABEL_CHANGED = "com.rezics.rating.question.label-changed.v1";
type Dependencies = {
    pool: Pool;
    access: Access;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
};
export type QuestionLabelInput = Readonly<{
    questionId: string;
    expectedLabelRevision: number;
    label: string;
}>;
export type QuestionLabel = {
    questionId: string;
    labelRevision: number;
    label: string;
    at: string | null;
    author: PublicIdentity | null;
};
export type QuestionLabelHistory = {
    labels: QuestionLabel[];
    next: string | null;
};
export declare function validateQuestionLabel(input: QuestionLabelInput): void;
/** A caption can correct presentation; its revision never becomes a measurement revision.
 * The original definition remains the only canonical wording of that measurement. */
export declare function updateQuestionLabel(deps: Dependencies, actor: Actor, input: QuestionLabelInput, context: {
    deadline: number;
    idempotencyKey: string;
}): Promise<import("../command/command.ts").CommandOutcome<{
    questionId: string;
    labelRevision: number;
    label: string;
}>>;
/** Exact captions are distinct from both creation wording and today's head. */
export declare function readQuestionLabel(deps: Dependencies, actor: Actor, questionId: string, revision: number, deadline: number): Promise<QuestionLabel | null>;
/** Bounded ascending history, with a signed initial ceiling. A continuation never
 * changes selection, viewer/session authority, page budget or captured ceiling. */
export declare function readQuestionLabelHistory(deps: Dependencies & {
    tokens: KeyRing;
}, actor: Actor, input: {
    questionId: string;
    limit: number;
    cursor?: string;
}, deadline: number): Promise<QuestionLabelHistory>;
export {};
