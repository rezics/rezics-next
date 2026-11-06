import type { LibraryCopyKindDescriptor, LibraryProfilePin } from './profile.ts';
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
/** An absent observation predates assessment; null is an intentional clear. */
export type CopyConditionObservation = Readonly<{
    value: CopyConditionValue | null;
    pin: LibraryProfilePin;
    kindId: string;
}>;
export type CopyConditionFacts = Readonly<{
    mediaCondition?: CopyConditionObservation;
    packagingCondition?: CopyConditionObservation;
}>;
/** Decode only the private row representation; absent observations remain absent. */
export declare function decodeCopyConditionFacts(mediaCondition: unknown, packagingCondition: unknown): CopyConditionFacts | undefined;
export declare class CopyConditionInvalidError extends Error {
    readonly field: CopyConditionField;
    constructor(field: CopyConditionField);
}
export declare function isCopyConditionValue(value: unknown): value is CopyConditionValue;
/** Merge this result into the existing complete command input before hashing it.
 * Missing fields stay missing, so old receipts retain their original operands.
 */
export declare function parseCopyConditionFields(input: Readonly<Record<string, unknown>>): CopyConditionPatch;
export type CopyConditionAdmission = Readonly<{
    state: 'supported';
    vocabulary: typeof COPY_CONDITION_VOCABULARY;
    choices: typeof COPY_CONDITION_CHOICES;
} | {
    state: 'unavailable';
    reason: 'unsupported' | 'unrecognized_vocabulary';
}>;
/** Only an explicit released kind capability admits condition. Never infer physicality from an ID or label.
 * The retained Definitions publisher must add `condition?: 'physical-v1'` to its closed kind contract.
 * Until then existing published kinds remain unavailable, including kinds named "physical".
 */
export declare function copyConditionAdmission(kind: LibraryCopyKindDescriptor | null): CopyConditionAdmission;
export type CopyConditionAcceptance = Readonly<{
    kind: LibraryCopyKindDescriptor;
    pin: LibraryProfilePin;
}>;
/** Pure field merge for createCopy/updateCopy, never an independent command or revision authority.
 * Call only after the existing writer's whole-copy revision and current-source checks.
 */
export declare function mergeCopyConditionFields(current: CopyConditionFacts, patch: CopyConditionPatch, acceptance: CopyConditionAcceptance): CopyConditionFacts;
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
/** The caller resolves each observation's actual accepting pin, with deduplicated exact-release reads.
 * Current retirement cannot erase accepted display meaning. A missing exact release cannot supply a grade.
 */
export declare function presentCopyCondition(observation: CopyConditionObservation | undefined, acceptedKind: LibraryCopyKindDescriptor | null): CopyConditionDisplay;
