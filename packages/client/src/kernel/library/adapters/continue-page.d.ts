import { type SubjectSummary } from '../../semantic/contract/index.ts';
import { createContinueReads } from '../continue-reads.ts';
import type { ContinuePage, ContinueReads, ContinueSubject } from '../contract/index.ts';
export type { ContinuePage, ContinueReads, ContinueSession, ContinueSubject } from '../contract/index.ts';
export type DisclosedContinueSubject = ContinueSubject<SubjectSummary>;
export type DisclosedContinuePage = ContinuePage<SubjectSummary>;
/** Native transport compatibility: composition of the two owners' pure schemas. */
export declare function continuePageSchema(): import("typebox").TObject<{
    subjects: import("typebox").TArray<import("typebox").TObject<{
        subjectId: import("typebox").TString;
        state: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        lastActivityAt: import("typebox").TString;
        activeProgressSession: import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            subjectId: import("typebox").TString;
            versionSubjectId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            mode: import("typebox").TUnion<[import("typebox").TLiteral<"scalar_amount">, import("typebox").TLiteral<"cursor_position">, import("typebox").TLiteral<"completed_units">]>;
            unit: import("typebox").TString;
            total: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            amount: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            locator: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            position: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            completedUnitCount: import("typebox").TInteger;
            state: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"abandoned">]>, import("typebox").TLiteral<"retired">]>;
            revision: import("typebox").TInteger;
            startedAt: import("typebox").TString;
            completedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            measures: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                unit: import("typebox").TString;
                amount: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                total: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                presentation: import("typebox").TOptional<import("typebox").TUnsafe<Readonly<{
                    meaning: 'known' | 'unknown' | 'unavailable';
                    unitLabel?: string;
                    unitLabelLanguage?: string;
                    unitCountForms?: Readonly<{
                        other: string;
                        zero?: string;
                        one?: string;
                        two?: string;
                        few?: string;
                        many?: string;
                    }>;
                    dimension?: string;
                    structure: 'unverified';
                    recording: import("../contract/continue.ts").ContinueProgressRecording;
                }>>>;
            }>>>;
        }>, import("typebox").TNull]>;
        subject: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TString;
            types: import("typebox").TArray<import("typebox").TString>;
            label: import("typebox").TUnion<[import("typebox").TObject<{
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>, import("typebox").TNull]>;
            creativeWork: import("typebox").TBoolean;
            cover: import("typebox").TUnion<[import("typebox").TObject<{
                media: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                placeholder: import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: import("typebox").TUnion<[import("typebox").TLiteral<"avif">, import("typebox").TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                }>>;
                focalPoint: import("typebox").TUnion<[import("typebox").TObject<{
                    x: import("typebox").TNumber;
                    y: import("typebox").TNumber;
                }>, import("typebox").TNull]>;
                credit: import("typebox").TObject<{
                    rightsHolder: import("typebox").TString;
                    via: import("typebox").TObject<{
                        name: import("typebox").TString;
                        url: import("typebox").TString;
                    }>;
                    license: import("typebox").TString;
                    obligations: import("typebox").TArray<import("typebox").TString>;
                }>;
            }>, import("typebox").TNull]>;
        }>, import("typebox").TNull]>>;
    }>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
/** Native Continue producer. Composition binds this; Content consumes the page, not Library storage. */
export declare function createContinuePageAdapter(...args: Parameters<typeof createContinueReads>): ContinueReads<SubjectSummary>;
