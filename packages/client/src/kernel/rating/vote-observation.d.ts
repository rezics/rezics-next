import type { RatingQuestion } from './votes.ts';
/** The immutable Global provider supports a question-bound write; conditional providers require their held guard. */
export type VoteObservation = Readonly<{
    subjectId: string;
    question: Readonly<{
        id: string;
        revision: number;
        grain: string;
        meaning: string;
        scale: Readonly<{
            min: number;
            max: number;
            displayStep: number;
        }>;
    }>;
}>;
export declare function parseVoteObservation(value: string | undefined): VoteObservation | undefined;
export declare function requireVoteObservationProvider(questionId: string): void;
export declare function assertVoteObservation(observed: VoteObservation, question: RatingQuestion, resolvedId: string): void;
