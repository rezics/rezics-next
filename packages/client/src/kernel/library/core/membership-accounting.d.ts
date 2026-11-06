/** Ordered occurrences and complete nested admission accounting. */
import type { NestedAdmissionAccount, NestedAdmissionTerm, OccurrenceDraft, OrderedOccurrence } from '../contract/index.ts';
import type { WorkDimensions } from '../contract/work-dimensions.ts';
export declare function orderedOccurrences(rows: readonly OccurrenceDraft[]): readonly OrderedOccurrence[];
export declare function repeatedSubjectCount(occurrences: readonly OrderedOccurrence[]): number;
export declare function admissionTerm(name: string, dimensions?: Partial<WorkDimensions>): NestedAdmissionTerm;
export declare function sumAdmission(terms: readonly NestedAdmissionTerm[]): NestedAdmissionAccount;
export declare function accountDimensions(account: NestedAdmissionAccount): WorkDimensions;
