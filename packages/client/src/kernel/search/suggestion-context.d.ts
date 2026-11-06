export type SuggestionContextLabel = Readonly<{
    value: string;
    language: string;
}>;
export type SuggestionContextDate = Readonly<{
    state: 'value';
    property: string;
    value: string;
    precision: 'year' | 'month' | 'day';
}> | Readonly<{
    state: 'unknown' | 'no_value' | 'withheld' | 'unavailable' | 'not_applicable';
    property: string;
}>;
export type SuggestionWorkContext = Readonly<{
    subjectId: string;
    status: 'available';
    creator: Readonly<{
        id: string;
        label: SuggestionContextLabel;
        property: string;
        role: SuggestionContextLabel;
    }>;
    relation?: Readonly<{
        kind: 'work' | 'release';
        id: string;
        label: SuggestionContextLabel;
        date?: SuggestionContextDate;
    }>;
    /** Disclosed producer overflow only; it supplies no destination or count. */
    overflow?: boolean;
}> | Readonly<{
    subjectId: string;
    status: 'absent' | 'not_applicable' | 'empty' | 'withheld' | 'unavailable';
}>;
export type SuggestionWorkContextSnapshot = Readonly<{
    contexts: readonly SuggestionWorkContext[];
    /** Rechecks the producer's source identity, disclosure and release after response completion. */
    isCurrent(): Promise<boolean>;
}>;
export type SuggestionWorkContextReader = (input: Readonly<{
    subjectIds: readonly string[];
    languages: readonly string[];
    deadline: number;
}>) => Promise<SuggestionWorkContextSnapshot>;
export declare const SUGGESTION_CONTEXT_LIMITS: Readonly<{
    subjects: 10;
    serializedBytes: 16384;
}>;
type SuggestionPage<T> = Readonly<{
    subjects: readonly T[];
    as_of: string;
}>;
type ContextualSubject<T> = T & Readonly<{
    workContext: SuggestionWorkContext;
}>;
type ContextualSuggestionPage<T> = Readonly<{
    subjects: ContextualSubject<T>[];
    as_of: string;
}>;
/** Compose one bounded optional context batch, complete the normal summary read, then recheck both owners. */
export declare function completeSuggestionWorkContext<T extends Readonly<{
    id: string;
}>>(page: SuggestionPage<T>, options: Readonly<{
    reader?: SuggestionWorkContextReader;
    languages: readonly string[];
    deadline: number;
    complete?: (page: ContextualSuggestionPage<T>) => Promise<void>;
    verifyCurrent?: () => Promise<boolean>;
}>): Promise<ContextualSuggestionPage<T>>;
export {};
