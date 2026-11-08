/** Library vocabulary, independent of catalogue labels, sellers and valuations. */
export declare const COPY_CONDITION_VOCABULARY = "physical-v1";
export declare const COPY_CONDITION_CHOICES: readonly [Readonly<{
    id: "unknown";
    label: "Unknown";
    description: "Assessed without a known grade.";
}>, Readonly<{
    id: "mint";
    label: "Mint";
    description: "No observable wear or defects.";
}>, Readonly<{
    id: "near_mint";
    label: "Near mint";
    description: "Almost no observable wear.";
}>, Readonly<{
    id: "very_good_plus";
    label: "Very good plus";
    description: "Minor observable wear.";
}>, Readonly<{
    id: "very_good";
    label: "Very good";
    description: "Noticeable wear, still fully usable.";
}>, Readonly<{
    id: "good";
    label: "Good";
    description: "Substantial wear, still usable.";
}>, Readonly<{
    id: "fair";
    label: "Fair";
    description: "Damage limits ordinary use.";
}>, Readonly<{
    id: "poor";
    label: "Poor";
    description: "Severe damage prevents ordinary use.";
}>];
export type CopyConditionValue = (typeof COPY_CONDITION_CHOICES)[number]['id'];
export type CopyConditionField = 'mediaCondition' | 'packagingCondition';
export type CopyConditionPatch = Readonly<{
    mediaCondition?: CopyConditionValue | null;
    packagingCondition?: CopyConditionValue | null;
}>;
export declare const MAX_COPY_FILTER_OPTIONS = 64;
export declare const COPY_FILTER_OPTION_QUERY_LIMIT = 65;
export declare const MAX_COPY_FILTER_OPTIONS_BYTES = 65536;
export declare const COPY_DEFAULT_LIMIT = 20;
export declare const COPY_MAX_LIMIT = 100;
export type CopyPageOptions = {
    cursor?: string;
    limit?: number;
    subjectId?: string;
    kind?: string;
    status?: string;
};
export type CopyFields = {
    status: string;
    location: string | null;
    source: string | null;
    acquiredOn: string | null;
    disposedOn: string | null;
    note: string | null;
};
export type CopyInput = Omit<CopyFields, 'status'> & CopyConditionPatch & {
    subjectId: string;
    kind?: string;
    status?: string;
};
export type CopyPatch = {
    revision: number;
} & Partial<CopyFields> & CopyConditionPatch;
export declare class CopyInvalidError extends Error {
    readonly field: string;
    constructor(field: string);
}
export declare class CopyConflictError extends Error {
    constructor();
}
export type CopyConditionDisplay = Readonly<{
    state: 'not_recorded';
} | {
    state: 'unavailable';
} | {
    state: 'cleared';
} | {
    state: 'recorded';
    id: CopyConditionValue;
    label: string;
}>;
export type CopyConditionEditing = Readonly<{
    state: 'supported';
    currentness: 'current';
    choices: readonly Readonly<{
        id: CopyConditionValue;
        label: string;
        description: string;
    }>[];
} | {
    state: 'unavailable';
    currentness: 'current' | 'retired' | 'unavailable';
    reason: 'unsupported' | 'unrecognized_vocabulary' | 'retired' | 'current_source_unavailable';
}>;
/** Opt-in private owner detail. Accepting identities and pins never enter this DTO. */
export type CopyPresentation = Readonly<{
    meaning: 'known' | 'unknown' | 'unavailable';
    kindLabel?: string;
    kindLabelLanguage?: string;
    statusLabel?: string;
    statusLabelLanguage?: string;
    statusEditing: Readonly<{
        state: 'supported';
        statuses: readonly Readonly<{
            id: string;
            label: string;
            labelLanguage: string;
        }>[];
    } | {
        state: 'unsupported' | 'unavailable';
    }>;
    mediaCondition: CopyConditionDisplay;
    packagingCondition: CopyConditionDisplay;
    conditionEditing: CopyConditionEditing;
}>;
export type CopyInventoryChoice = Readonly<{
    id: string;
    label: string;
    labelLanguage?: string;
    meaning: 'available' | 'unsupported' | 'unavailable';
}>;
export type CopyInventoryFacet = Readonly<{
    state: 'available' | 'unavailable';
    choices: readonly CopyInventoryChoice[];
}>;
export type CopyInventory = Readonly<{
    kinds: CopyInventoryFacet;
    statuses: CopyInventoryFacet;
}>;
export type CopyInventoryValue = Readonly<{
    dimension: 'kind' | 'status';
    id: string;
    copyId: string;
    copyKind: string | null;
    profilePin: unknown;
}>;
