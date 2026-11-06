import type { Static } from 'typebox';
/** Bounds include the disclosed lookahead; no continuation or Subject URL is inferred. */
export declare const WORK_CONTEXT_LIMITS: Readonly<{
    entries: 3;
    lookahead: 4;
    qualifiers: 4;
    labelBytes: 256;
    hitBytes: 16384;
    pageBytes: 262144;
}>;
export declare const WorkContextSchema: import("typebox").TUnion<[import("typebox").TObject<{
    state: import("typebox").TLiteral<"unavailable">;
    reason: import("typebox").TUnion<[import("typebox").TLiteral<"native">, import("typebox").TLiteral<"limit">, import("typebox").TLiteral<"response_limit">]>;
}>, import("typebox").TObject<{
    state: import("typebox").TLiteral<"current">;
    subjectId: import("typebox").TString;
    type: import("typebox").TObject<{
        id: import("typebox").TString;
        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
    }>;
    kind: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"recording">]>;
    creators: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"empty">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"withheld">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unsupported">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
        reason: import("typebox").TUnion<[import("typebox").TLiteral<"native">, import("typebox").TLiteral<"limit">, import("typebox").TLiteral<"response_limit">]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        items: import("typebox").TArray<import("typebox").TObject<{
            statementId: import("typebox").TString;
            sourceId: import("typebox").TString;
            direction: import("typebox").TLiteral<"outgoing">;
            property: import("typebox").TObject<{
                id: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>;
            revision: import("typebox").TInteger;
            release: import("typebox").TString;
            rank: import("typebox").TUnion<[import("typebox").TLiteral<"normal">, import("typebox").TLiteral<"preferred">]>;
            value: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"somevalue">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"novalue">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unsupported">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"item">;
                id: import("typebox").TString;
                originalId: import("typebox").TString;
                type: import("typebox").TObject<{
                    id: import("typebox").TString;
                    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                }>;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"text">;
                text: import("typebox").TString;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"quantity">;
                amount: import("typebox").TString;
                unit: import("typebox").TString;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"time">;
                calendar: import("typebox").TLiteral<"gregorian">;
                year: import("typebox").TInteger;
                month: import("typebox").TOptional<import("typebox").TInteger>;
                day: import("typebox").TOptional<import("typebox").TInteger>;
            }>]>;
            qualifiers: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"empty">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"withheld">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unsupported">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
                reason: import("typebox").TUnion<[import("typebox").TLiteral<"native">, import("typebox").TLiteral<"limit">, import("typebox").TLiteral<"response_limit">]>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"current">;
                items: import("typebox").TArray<import("typebox").TObject<{
                    property: import("typebox").TObject<{
                        id: import("typebox").TString;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>;
                    value: import("typebox").TUnion<[import("typebox").TObject<{
                        state: import("typebox").TLiteral<"somevalue">;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"novalue">;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"unsupported">;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"item">;
                        id: import("typebox").TString;
                        originalId: import("typebox").TString;
                        type: import("typebox").TObject<{
                            id: import("typebox").TString;
                            labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                        }>;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"text">;
                        text: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"quantity">;
                        amount: import("typebox").TString;
                        unit: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"time">;
                        calendar: import("typebox").TLiteral<"gregorian">;
                        year: import("typebox").TInteger;
                        month: import("typebox").TOptional<import("typebox").TInteger>;
                        day: import("typebox").TOptional<import("typebox").TInteger>;
                    }>]>;
                }>>;
            }>]>;
        }>>;
        overflow: import("typebox").TBoolean;
    }>]>;
    relations: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"empty">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"withheld">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unsupported">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
        reason: import("typebox").TUnion<[import("typebox").TLiteral<"native">, import("typebox").TLiteral<"limit">, import("typebox").TLiteral<"response_limit">]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        items: import("typebox").TArray<import("typebox").TObject<{
            statementId: import("typebox").TString;
            sourceId: import("typebox").TString;
            direction: import("typebox").TLiteral<"outgoing">;
            property: import("typebox").TObject<{
                id: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>;
            revision: import("typebox").TInteger;
            release: import("typebox").TString;
            rank: import("typebox").TUnion<[import("typebox").TLiteral<"normal">, import("typebox").TLiteral<"preferred">]>;
            value: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"somevalue">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"novalue">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unsupported">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"item">;
                id: import("typebox").TString;
                originalId: import("typebox").TString;
                type: import("typebox").TObject<{
                    id: import("typebox").TString;
                    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                }>;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"text">;
                text: import("typebox").TString;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"quantity">;
                amount: import("typebox").TString;
                unit: import("typebox").TString;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"time">;
                calendar: import("typebox").TLiteral<"gregorian">;
                year: import("typebox").TInteger;
                month: import("typebox").TOptional<import("typebox").TInteger>;
                day: import("typebox").TOptional<import("typebox").TInteger>;
            }>]>;
            qualifiers: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"empty">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"withheld">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unsupported">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
                reason: import("typebox").TUnion<[import("typebox").TLiteral<"native">, import("typebox").TLiteral<"limit">, import("typebox").TLiteral<"response_limit">]>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"current">;
                items: import("typebox").TArray<import("typebox").TObject<{
                    property: import("typebox").TObject<{
                        id: import("typebox").TString;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>;
                    value: import("typebox").TUnion<[import("typebox").TObject<{
                        state: import("typebox").TLiteral<"somevalue">;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"novalue">;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"unsupported">;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"item">;
                        id: import("typebox").TString;
                        originalId: import("typebox").TString;
                        type: import("typebox").TObject<{
                            id: import("typebox").TString;
                            labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                        }>;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"text">;
                        text: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"quantity">;
                        amount: import("typebox").TString;
                        unit: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"time">;
                        calendar: import("typebox").TLiteral<"gregorian">;
                        year: import("typebox").TInteger;
                        month: import("typebox").TOptional<import("typebox").TInteger>;
                        day: import("typebox").TOptional<import("typebox").TInteger>;
                    }>]>;
                }>>;
            }>]>;
        }>>;
        overflow: import("typebox").TBoolean;
    }>]>;
    dates: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"empty">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"withheld">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unsupported">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
        reason: import("typebox").TUnion<[import("typebox").TLiteral<"native">, import("typebox").TLiteral<"limit">, import("typebox").TLiteral<"response_limit">]>;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        items: import("typebox").TArray<import("typebox").TObject<{
            statementId: import("typebox").TString;
            sourceId: import("typebox").TString;
            direction: import("typebox").TLiteral<"outgoing">;
            property: import("typebox").TObject<{
                id: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>;
            revision: import("typebox").TInteger;
            release: import("typebox").TString;
            rank: import("typebox").TUnion<[import("typebox").TLiteral<"normal">, import("typebox").TLiteral<"preferred">]>;
            value: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"somevalue">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"novalue">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unsupported">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"item">;
                id: import("typebox").TString;
                originalId: import("typebox").TString;
                type: import("typebox").TObject<{
                    id: import("typebox").TString;
                    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                }>;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"text">;
                text: import("typebox").TString;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"quantity">;
                amount: import("typebox").TString;
                unit: import("typebox").TString;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"value">;
                kind: import("typebox").TLiteral<"time">;
                calendar: import("typebox").TLiteral<"gregorian">;
                year: import("typebox").TInteger;
                month: import("typebox").TOptional<import("typebox").TInteger>;
                day: import("typebox").TOptional<import("typebox").TInteger>;
            }>]>;
            qualifiers: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"empty">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"withheld">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unsupported">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
                reason: import("typebox").TUnion<[import("typebox").TLiteral<"native">, import("typebox").TLiteral<"limit">, import("typebox").TLiteral<"response_limit">]>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"current">;
                items: import("typebox").TArray<import("typebox").TObject<{
                    property: import("typebox").TObject<{
                        id: import("typebox").TString;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>;
                    value: import("typebox").TUnion<[import("typebox").TObject<{
                        state: import("typebox").TLiteral<"somevalue">;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"novalue">;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"unsupported">;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"item">;
                        id: import("typebox").TString;
                        originalId: import("typebox").TString;
                        type: import("typebox").TObject<{
                            id: import("typebox").TString;
                            labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                        }>;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"text">;
                        text: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"quantity">;
                        amount: import("typebox").TString;
                        unit: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"value">;
                        kind: import("typebox").TLiteral<"time">;
                        calendar: import("typebox").TLiteral<"gregorian">;
                        year: import("typebox").TInteger;
                        month: import("typebox").TOptional<import("typebox").TInteger>;
                        day: import("typebox").TOptional<import("typebox").TInteger>;
                    }>]>;
                }>>;
            }>]>;
        }>>;
        overflow: import("typebox").TBoolean;
    }>]>;
}>]>;
export type WorkContext = Static<typeof WorkContextSchema>;
export type CurrentWorkContext = Extract<WorkContext, {
    state: 'current';
}>;
export type WorkContextSection = CurrentWorkContext['creators'];
export type WorkContextStatement = Extract<WorkContextSection, {
    state: 'current';
}>['items'][number];
export type WorkContextValue = WorkContextStatement['value'];
export type WorkContextQualifier = Extract<WorkContextStatement['qualifiers'], {
    state: 'current';
}>['items'][number];
/** Exact released Type identities and bases own this distinction. */
export declare function workContextKind(identities: readonly string[]): CurrentWorkContext['kind'];
export declare const workContextBytes: (value: unknown) => number;
/** Schema validation runs first; these checks bind qualifications, precision and aggregate bytes. */
export declare function validWorkContext(context: WorkContext, subjectId: string): boolean;
/** Every retained context is independently bounded; the page has a separate finite byte allowance. */
export declare function boundWorkContexts(contexts: readonly (WorkContext | undefined)[]): (WorkContext | undefined)[];
