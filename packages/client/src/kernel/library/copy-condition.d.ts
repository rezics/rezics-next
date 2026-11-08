import type { LibraryCopyKindDescriptor, LibraryProfilePin } from './profile.ts';
import { COPY_CONDITION_CHOICES, COPY_CONDITION_VOCABULARY } from './contract/index.ts';
import type { CopyConditionValue, CopyConditionPatch } from './contract/index.ts';
export { COPY_CONDITION_CHOICES, COPY_CONDITION_VOCABULARY } from './contract/index.ts';
export type { CopyConditionValue, CopyConditionField, CopyConditionPatch } from './contract/index.ts';
export { parseCopyConditionFields, isCopyConditionValue, CopyConditionInvalidError } from './core/index.ts';
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
export type { CopyConditionDisplay } from './contract/index.ts';
import type { CopyConditionDisplay } from './contract/index.ts';
/** The caller resolves each observation's actual accepting pin, with deduplicated exact-release reads.
 * Current retirement cannot erase accepted display meaning. A missing exact release cannot supply a grade.
 */
export declare function presentCopyCondition(observation: CopyConditionObservation | undefined, acceptedKind: LibraryCopyKindDescriptor | null): CopyConditionDisplay;
