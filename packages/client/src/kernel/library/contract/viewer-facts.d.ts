/** Serializable operands and values used by Library's viewer-facts readers. */
export type ViewerFactInput = Readonly<{
    rowKey: string;
    subjectId: string;
}>;
export type ViewerQuestion = Readonly<{
    id: string;
    revision: number;
    grain: string;
    scale: Readonly<{
        min: number;
        max: number;
        displayStep: number;
    }>;
    meaning: string;
}>;
export type ViewerEntryFact = Readonly<{
    state: 'present';
    incarnationId: string | null;
    entryState: string | null;
    revision: number;
}> | Readonly<{
    state: 'absent';
}> | Readonly<{
    state: 'unavailable';
    reason: 'scope';
}>;
export type ViewerVoteFact = Readonly<{
    state: 'present';
    questionId: string;
    questionRevision: number;
    units: number;
    revision: number;
}> | Readonly<{
    state: 'absent';
    questionId: string;
    questionRevision: number;
}> | Readonly<{
    state: 'unavailable';
    reason: 'scope' | 'question';
}>;
export type ViewerFact = Readonly<{
    rowKey: string;
    subjectId: string;
    entry: ViewerEntryFact;
    vote: ViewerVoteFact;
}>;
export type ViewerFactsPage = Readonly<{
    state: 'current';
    question: ViewerQuestion | null;
    rows: readonly ViewerFact[];
}> | Readonly<{
    state: 'unavailable';
    reason: 'identity' | 'currentness' | 'response_limit';
    retryable: boolean;
}>;
