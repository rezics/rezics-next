import { Type as t, type TSchema } from 'typebox';
/** Stable Library wire contract, kept outside route handlers for Continue and Feed composition. */
export declare const progressPresentationSchema: t.TUnsafe<Readonly<{
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
    recording: import("./continue.ts").ContinueProgressRecording;
}>>;
export declare function sessionSchema(): t.TObject<{
    id: t.TString;
    subjectId: t.TString;
    versionSubjectId: t.TUnion<[t.TString, t.TNull]>;
    mode: t.TUnion<[t.TLiteral<"scalar_amount">, t.TLiteral<"cursor_position">, t.TLiteral<"completed_units">]>;
    unit: t.TString;
    total: t.TUnion<[t.TString, t.TNull]>;
    amount: t.TUnion<[t.TString, t.TNull]>;
    locator: t.TUnion<[t.TString, t.TNull]>;
    position: t.TUnion<[t.TString, t.TNull]>;
    completedUnitCount: t.TInteger;
    state: t.TUnion<[t.TUnion<[t.TLiteral<"active">, t.TLiteral<"completed">, t.TLiteral<"abandoned">]>, t.TLiteral<"retired">]>;
    revision: t.TInteger;
    startedAt: t.TString;
    completedAt: t.TUnion<[t.TString, t.TNull]>;
    measures: t.TOptional<t.TArray<t.TObject<{
        unit: t.TString;
        amount: t.TUnion<[t.TString, t.TNull]>;
        total: t.TUnion<[t.TString, t.TNull]>;
        presentation: t.TOptional<t.TUnsafe<Readonly<{
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
            recording: import("./continue.ts").ContinueProgressRecording;
        }>>>;
    }>>>;
}>;
/** Library owns the page/session shape; the caller supplies its disclosed Subject schema. */
export declare function continuePageSchema<Summary extends TSchema>(summary: Summary): t.TObject<{
    subjects: t.TArray<t.TObject<{
        subjectId: t.TString;
        state: t.TUnion<[t.TString, t.TNull]>;
        lastActivityAt: t.TString;
        activeProgressSession: t.TUnion<[t.TObject<{
            id: t.TString;
            subjectId: t.TString;
            versionSubjectId: t.TUnion<[t.TString, t.TNull]>;
            mode: t.TUnion<[t.TLiteral<"scalar_amount">, t.TLiteral<"cursor_position">, t.TLiteral<"completed_units">]>;
            unit: t.TString;
            total: t.TUnion<[t.TString, t.TNull]>;
            amount: t.TUnion<[t.TString, t.TNull]>;
            locator: t.TUnion<[t.TString, t.TNull]>;
            position: t.TUnion<[t.TString, t.TNull]>;
            completedUnitCount: t.TInteger;
            state: t.TUnion<[t.TUnion<[t.TLiteral<"active">, t.TLiteral<"completed">, t.TLiteral<"abandoned">]>, t.TLiteral<"retired">]>;
            revision: t.TInteger;
            startedAt: t.TString;
            completedAt: t.TUnion<[t.TString, t.TNull]>;
            measures: t.TOptional<t.TArray<t.TObject<{
                unit: t.TString;
                amount: t.TUnion<[t.TString, t.TNull]>;
                total: t.TUnion<[t.TString, t.TNull]>;
                presentation: t.TOptional<t.TUnsafe<Readonly<{
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
                    recording: import("./continue.ts").ContinueProgressRecording;
                }>>>;
            }>>>;
        }>, t.TNull]>;
        subject: t.TOptional<t.TUnion<[Summary, t.TNull]>>;
    }>>;
    next: t.TUnion<[t.TString, t.TNull]>;
}>;
