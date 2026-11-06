import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import type { CommandAuthorization, CommandOutcome } from '../command/command.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type SourceFigures } from './source-figures.ts';
import { type SourceProvider } from './source-provider.ts';
export declare const SOURCE_STATISTIC_WRITE_ACTION = "source_statistic:write";
export type SourceStatistic = {
    source: SourceProvider;
    sourceAlias?: string;
    sourceRecordId: string;
    scale: {
        min: number;
        max: number;
    };
    mean: number;
    figures?: SourceFigures;
    count: number;
    asOf: string;
    licence: string;
    attribution: string;
    observation?: {
        kind: 'unversioned';
        digest: string;
    };
};
type Input = Omit<SourceStatistic, 'source' | 'observation'> & {
    expectedObservation?: string | null;
};
type ClearInput = Readonly<{
    sourceAlias?: string;
    sourceRecordId: string;
    count: 0;
    asOf: string;
    expectedObservation?: string | null;
}>;
type Dependencies = {
    pool: Pool;
    access: () => Access;
    routeKey: Uint8Array;
    tokens: KeyRing;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
};
type CommandDependencies = {
    pool: Pool;
    routeKey: Uint8Array;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
};
type WriteInput = {
    actor: Actor;
    subjectId: string;
    source: string;
    value: Input;
    idempotencyKey: string;
    authorization: CommandAuthorization;
    deadline: number;
    subjectAvailable?: boolean;
};
type ClearInputCommand = {
    actor: Actor;
    subjectId: string;
    source: string;
    value: ClearInput;
    idempotencyKey: string;
    authorization: CommandAuthorization;
    deadline: number;
    subjectAvailable?: boolean;
};
type ExpectedFenceRevision = Readonly<{
    source: string;
    external_id: string;
    securityRevision: string | null;
}>;
type WriteCommandOutcome = CommandOutcome<SourceStatistic> & Readonly<{
    preparedFenceRevision: string | null;
}>;
export declare class SourceStatisticInvalidError extends Error {
    readonly field: string;
    constructor(field: string);
}
export declare class SourceStatisticNotFoundError extends Error {
    constructor();
}
/** Stores source scores by subject and source. The authorization is always on Global Context. */
export declare function createSourceStatisticCommands(config: CommandDependencies): {
    write: (input: WriteInput) => Promise<SourceStatistic>;
    writeCommand: (input: WriteInput) => Promise<WriteCommandOutcome>;
    clear: (input: ClearInputCommand) => Promise<CommandOutcome<{
        removed: boolean;
    }>>;
    read: (subjectId: string, deadline?: number, expectedFence?: ExpectedFenceRevision) => Promise<SourceStatistic[]>;
};
/** Source statistics have their own read/write routes and never enter native vote storage. */
/** HTTP registrations are data; composition inspects these before mounting handlers. */
export declare function sourceStatisticRouteDeclarations(): {
    route1: {
        method: 'GET';
        path: '/v1/subjects/:id/source-statistics';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            response: {
                400: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                401: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                403: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                404: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                409: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                422: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                503: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                200: import("typebox").TArray<import("typebox").TObject<{
                    source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
                    observation: import("typebox").TOptional<import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>>;
                    sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                    sourceRecordId: import("typebox").TString;
                    figures: import("typebox").TOptional<import("typebox").TObject<{
                        schemaVersion: import("typebox").TLiteral<1>;
                        distribution: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"ratings">;
                            completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                            bins: import("typebox").TArray<import("typebox").TObject<{
                                score: import("typebox").TInteger;
                                count: import("typebox").TInteger;
                            }>>;
                        }>>;
                        rank: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"subjects">;
                            position: import("typebox").TInteger;
                            population: import("typebox").TOptional<import("typebox").TInteger>;
                        }>>;
                    }>>;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                    }>;
                    mean: import("typebox").TNumber;
                    count: import("typebox").TInteger;
                    asOf: import("typebox").TString;
                    licence: import("typebox").TString;
                    attribution: import("typebox").TString;
                }>>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
            };
        };
    };
    route2: {
        method: 'PUT';
        path: '/v1/subjects/:id/source-statistics/:source';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            figures?: {
                                schemaVersion: 1;
                                distribution?: {
                                    unit: "ratings";
                                    completeness: "complete" | "partial";
                                    bins: {
                                        score: number;
                                        count: number;
                                    }[];
                                };
                                rank?: {
                                    unit: "subjects";
                                    position: number;
                                    population?: number;
                                };
                            };
                            scale: {
                                min: number;
                                max: number;
                            };
                            mean: number;
                            count: number;
                            asOf: string;
                            licence: string;
                            attribution: string;
                        };
                        output: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            figures?: {
                                schemaVersion: 1;
                                distribution?: {
                                    unit: "ratings";
                                    completeness: "complete" | "partial";
                                    bins: {
                                        score: number;
                                        count: number;
                                    }[];
                                };
                                rank?: {
                                    unit: "subjects";
                                    position: number;
                                    population?: number;
                                };
                            };
                            scale: {
                                min: number;
                                max: number;
                            };
                            mean: number;
                            count: number;
                            asOf: string;
                            licence: string;
                            attribution: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            figures?: {
                                schemaVersion: 1;
                                distribution?: {
                                    unit: "ratings";
                                    completeness: "complete" | "partial";
                                    bins: {
                                        score: number;
                                        count: number;
                                    }[];
                                };
                                rank?: {
                                    unit: "subjects";
                                    position: number;
                                    population?: number;
                                };
                            };
                            scale: {
                                min: number;
                                max: number;
                            };
                            mean: number;
                            count: number;
                            asOf: string;
                            licence: string;
                            attribution: string;
                        };
                        issues?: never;
                    } | {
                        value?: never;
                        issues: {
                            message: string;
                        }[];
                    };
                    jsonSchema: {
                        input: () => import("typebox").TObject<{
                            expectedObservation: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
                            sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                            sourceRecordId: import("typebox").TString;
                            figures: import("typebox").TOptional<import("typebox").TObject<{
                                schemaVersion: import("typebox").TLiteral<1>;
                                distribution: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"ratings">;
                                    completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                    bins: import("typebox").TArray<import("typebox").TObject<{
                                        score: import("typebox").TInteger;
                                        count: import("typebox").TInteger;
                                    }>>;
                                }>>;
                                rank: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"subjects">;
                                    position: import("typebox").TInteger;
                                    population: import("typebox").TOptional<import("typebox").TInteger>;
                                }>>;
                            }>>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                            }>;
                            mean: import("typebox").TNumber;
                            count: import("typebox").TInteger;
                            asOf: import("typebox").TString;
                            licence: import("typebox").TString;
                            attribution: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedObservation: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
                            sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                            sourceRecordId: import("typebox").TString;
                            figures: import("typebox").TOptional<import("typebox").TObject<{
                                schemaVersion: import("typebox").TLiteral<1>;
                                distribution: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"ratings">;
                                    completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                    bins: import("typebox").TArray<import("typebox").TObject<{
                                        score: import("typebox").TInteger;
                                        count: import("typebox").TInteger;
                                    }>>;
                                }>>;
                                rank: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"subjects">;
                                    position: import("typebox").TInteger;
                                    population: import("typebox").TOptional<import("typebox").TInteger>;
                                }>>;
                            }>>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                            }>;
                            mean: import("typebox").TNumber;
                            count: import("typebox").TInteger;
                            asOf: import("typebox").TString;
                            licence: import("typebox").TString;
                            attribution: import("typebox").TString;
                        }>;
                    };
                };
            };
            response: {
                400: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                401: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                403: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                404: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                409: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                422: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                503: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                200: import("typebox").TObject<{
                    source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
                    observation: import("typebox").TOptional<import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>>;
                    sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                    sourceRecordId: import("typebox").TString;
                    figures: import("typebox").TOptional<import("typebox").TObject<{
                        schemaVersion: import("typebox").TLiteral<1>;
                        distribution: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"ratings">;
                            completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                            bins: import("typebox").TArray<import("typebox").TObject<{
                                score: import("typebox").TInteger;
                                count: import("typebox").TInteger;
                            }>>;
                        }>>;
                        rank: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"subjects">;
                            position: import("typebox").TInteger;
                            population: import("typebox").TOptional<import("typebox").TInteger>;
                        }>>;
                    }>>;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                    }>;
                    mean: import("typebox").TNumber;
                    count: import("typebox").TInteger;
                    asOf: import("typebox").TString;
                    licence: import("typebox").TString;
                    attribution: import("typebox").TString;
                }> & {
                    headers: {
                        readonly "rezics-session-token": import("typebox").TOptional<import("typebox").TString>;
                    };
                };
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                security: {
                    bearerAuth: never[];
                }[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route3: {
        method: 'POST';
        path: "/v1/subjects/:id/source-statistics/:source/$clear";
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            count: 0;
                            asOf: string;
                        };
                        output: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            count: 0;
                            asOf: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            count: 0;
                            asOf: string;
                        };
                        issues?: never;
                    } | {
                        value?: never;
                        issues: {
                            message: string;
                        }[];
                    };
                    jsonSchema: {
                        input: () => import("typebox").TObject<{
                            expectedObservation: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
                            sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                            sourceRecordId: import("typebox").TString;
                            count: import("typebox").TLiteral<0>;
                            asOf: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedObservation: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
                            sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                            sourceRecordId: import("typebox").TString;
                            count: import("typebox").TLiteral<0>;
                            asOf: import("typebox").TString;
                        }>;
                    };
                };
            };
            response: {
                400: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                401: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                403: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                404: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                409: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                422: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                503: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                204: import("typebox").TVoid & {
                    headers: {
                        readonly "rezics-session-token": import("typebox").TString;
                    };
                };
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                security: {
                    bearerAuth: never[];
                }[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route4: {
        method: 'GET';
        path: '/v1/subjects/:id/source-statistics/:source/observations';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
            }>;
            query: import("typebox").TObject<{
                digest: import("typebox").TOptional<import("typebox").TString>;
                cursor: import("typebox").TOptional<import("typebox").TString>;
                history: import("typebox").TOptional<import("typebox").TLiteral<"true">>;
            }>;
            response: {
                401: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                403: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                404: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                409: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                422: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                503: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                400: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                200: import("typebox").TObject<{
                    source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
                    head: import("typebox").TObject<{
                        digest: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"empty">, import("typebox").TLiteral<"published">, import("typebox").TLiteral<"cleared">]>;
                        observation: import("typebox").TUnion<[import("typebox").TObject<{
                            digest: import("typebox").TString;
                            payloadVersion: import("typebox").TLiteral<1>;
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            asOf: import("typebox").TString;
                            nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            legacy: import("typebox").TBoolean;
                            provenance: import("typebox").TObject<{
                                kind: import("typebox").TLiteral<"unversioned">;
                                digest: import("typebox").TString;
                            }>;
                            payload: import("typebox").TUnion<[import("typebox").TObject<{
                                sourceAlias: import("typebox").TString;
                                sourceRecordId: import("typebox").TString;
                                scale: import("typebox").TObject<{
                                    min: import("typebox").TInteger;
                                    max: import("typebox").TInteger;
                                }>;
                                mean: import("typebox").TNumber;
                                figures: import("typebox").TOptional<import("typebox").TObject<{
                                    schemaVersion: import("typebox").TLiteral<1>;
                                    distribution: import("typebox").TOptional<import("typebox").TObject<{
                                        unit: import("typebox").TLiteral<"ratings">;
                                        completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                        bins: import("typebox").TArray<import("typebox").TObject<{
                                            score: import("typebox").TInteger;
                                            count: import("typebox").TInteger;
                                        }>>;
                                    }>>;
                                    rank: import("typebox").TOptional<import("typebox").TObject<{
                                        unit: import("typebox").TLiteral<"subjects">;
                                        position: import("typebox").TInteger;
                                        population: import("typebox").TOptional<import("typebox").TInteger>;
                                    }>>;
                                }>>;
                                count: import("typebox").TInteger;
                                asOf: import("typebox").TString;
                                licence: import("typebox").TString;
                                attribution: import("typebox").TString;
                            }>, import("typebox").TObject<{
                                sourceAlias: import("typebox").TString;
                                sourceRecordId: import("typebox").TString;
                                count: import("typebox").TLiteral<0>;
                                asOf: import("typebox").TString;
                            }>]>;
                        }>, import("typebox").TNull]>;
                    }>;
                    resolution: import("typebox").TObject<{
                        put: import("typebox").TObject<{
                            expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>;
                        clear: import("typebox").TObject<{
                            expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>;
                    }>;
                    selectedObservation: import("typebox").TOptional<import("typebox").TObject<{
                        digest: import("typebox").TString;
                        payloadVersion: import("typebox").TLiteral<1>;
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        asOf: import("typebox").TString;
                        nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        legacy: import("typebox").TBoolean;
                        provenance: import("typebox").TObject<{
                            kind: import("typebox").TLiteral<"unversioned">;
                            digest: import("typebox").TString;
                        }>;
                        payload: import("typebox").TUnion<[import("typebox").TObject<{
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                            }>;
                            mean: import("typebox").TNumber;
                            figures: import("typebox").TOptional<import("typebox").TObject<{
                                schemaVersion: import("typebox").TLiteral<1>;
                                distribution: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"ratings">;
                                    completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                    bins: import("typebox").TArray<import("typebox").TObject<{
                                        score: import("typebox").TInteger;
                                        count: import("typebox").TInteger;
                                    }>>;
                                }>>;
                                rank: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"subjects">;
                                    position: import("typebox").TInteger;
                                    population: import("typebox").TOptional<import("typebox").TInteger>;
                                }>>;
                            }>>;
                            count: import("typebox").TInteger;
                            asOf: import("typebox").TString;
                            licence: import("typebox").TString;
                            attribution: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            count: import("typebox").TLiteral<0>;
                            asOf: import("typebox").TString;
                        }>]>;
                    }>>;
                    history: import("typebox").TOptional<import("typebox").TObject<{
                        items: import("typebox").TArray<import("typebox").TObject<{
                            digest: import("typebox").TString;
                            payloadVersion: import("typebox").TLiteral<1>;
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            asOf: import("typebox").TString;
                            nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            legacy: import("typebox").TBoolean;
                            provenance: import("typebox").TObject<{
                                kind: import("typebox").TLiteral<"unversioned">;
                                digest: import("typebox").TString;
                            }>;
                            payload: import("typebox").TUnion<[import("typebox").TObject<{
                                sourceAlias: import("typebox").TString;
                                sourceRecordId: import("typebox").TString;
                                scale: import("typebox").TObject<{
                                    min: import("typebox").TInteger;
                                    max: import("typebox").TInteger;
                                }>;
                                mean: import("typebox").TNumber;
                                figures: import("typebox").TOptional<import("typebox").TObject<{
                                    schemaVersion: import("typebox").TLiteral<1>;
                                    distribution: import("typebox").TOptional<import("typebox").TObject<{
                                        unit: import("typebox").TLiteral<"ratings">;
                                        completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                        bins: import("typebox").TArray<import("typebox").TObject<{
                                            score: import("typebox").TInteger;
                                            count: import("typebox").TInteger;
                                        }>>;
                                    }>>;
                                    rank: import("typebox").TOptional<import("typebox").TObject<{
                                        unit: import("typebox").TLiteral<"subjects">;
                                        position: import("typebox").TInteger;
                                        population: import("typebox").TOptional<import("typebox").TInteger>;
                                    }>>;
                                }>>;
                                count: import("typebox").TInteger;
                                asOf: import("typebox").TString;
                                licence: import("typebox").TString;
                                attribution: import("typebox").TString;
                            }>, import("typebox").TObject<{
                                sourceAlias: import("typebox").TString;
                                sourceRecordId: import("typebox").TString;
                                count: import("typebox").TLiteral<0>;
                                asOf: import("typebox").TString;
                            }>]>;
                        }>>;
                        nextCursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    }>>;
                }>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                security: {
                    bearerAuth: never[];
                }[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
};
export declare function sourceStatisticRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies, declarations?: {
    route1: {
        method: 'GET';
        path: '/v1/subjects/:id/source-statistics';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            response: {
                400: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                401: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                403: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                404: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                409: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                422: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                503: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                200: import("typebox").TArray<import("typebox").TObject<{
                    source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
                    observation: import("typebox").TOptional<import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>>;
                    sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                    sourceRecordId: import("typebox").TString;
                    figures: import("typebox").TOptional<import("typebox").TObject<{
                        schemaVersion: import("typebox").TLiteral<1>;
                        distribution: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"ratings">;
                            completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                            bins: import("typebox").TArray<import("typebox").TObject<{
                                score: import("typebox").TInteger;
                                count: import("typebox").TInteger;
                            }>>;
                        }>>;
                        rank: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"subjects">;
                            position: import("typebox").TInteger;
                            population: import("typebox").TOptional<import("typebox").TInteger>;
                        }>>;
                    }>>;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                    }>;
                    mean: import("typebox").TNumber;
                    count: import("typebox").TInteger;
                    asOf: import("typebox").TString;
                    licence: import("typebox").TString;
                    attribution: import("typebox").TString;
                }>>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
            };
        };
    };
    route2: {
        method: 'PUT';
        path: '/v1/subjects/:id/source-statistics/:source';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            figures?: {
                                schemaVersion: 1;
                                distribution?: {
                                    unit: "ratings";
                                    completeness: "complete" | "partial";
                                    bins: {
                                        score: number;
                                        count: number;
                                    }[];
                                };
                                rank?: {
                                    unit: "subjects";
                                    position: number;
                                    population?: number;
                                };
                            };
                            scale: {
                                min: number;
                                max: number;
                            };
                            mean: number;
                            count: number;
                            asOf: string;
                            licence: string;
                            attribution: string;
                        };
                        output: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            figures?: {
                                schemaVersion: 1;
                                distribution?: {
                                    unit: "ratings";
                                    completeness: "complete" | "partial";
                                    bins: {
                                        score: number;
                                        count: number;
                                    }[];
                                };
                                rank?: {
                                    unit: "subjects";
                                    position: number;
                                    population?: number;
                                };
                            };
                            scale: {
                                min: number;
                                max: number;
                            };
                            mean: number;
                            count: number;
                            asOf: string;
                            licence: string;
                            attribution: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            figures?: {
                                schemaVersion: 1;
                                distribution?: {
                                    unit: "ratings";
                                    completeness: "complete" | "partial";
                                    bins: {
                                        score: number;
                                        count: number;
                                    }[];
                                };
                                rank?: {
                                    unit: "subjects";
                                    position: number;
                                    population?: number;
                                };
                            };
                            scale: {
                                min: number;
                                max: number;
                            };
                            mean: number;
                            count: number;
                            asOf: string;
                            licence: string;
                            attribution: string;
                        };
                        issues?: never;
                    } | {
                        value?: never;
                        issues: {
                            message: string;
                        }[];
                    };
                    jsonSchema: {
                        input: () => import("typebox").TObject<{
                            expectedObservation: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
                            sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                            sourceRecordId: import("typebox").TString;
                            figures: import("typebox").TOptional<import("typebox").TObject<{
                                schemaVersion: import("typebox").TLiteral<1>;
                                distribution: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"ratings">;
                                    completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                    bins: import("typebox").TArray<import("typebox").TObject<{
                                        score: import("typebox").TInteger;
                                        count: import("typebox").TInteger;
                                    }>>;
                                }>>;
                                rank: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"subjects">;
                                    position: import("typebox").TInteger;
                                    population: import("typebox").TOptional<import("typebox").TInteger>;
                                }>>;
                            }>>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                            }>;
                            mean: import("typebox").TNumber;
                            count: import("typebox").TInteger;
                            asOf: import("typebox").TString;
                            licence: import("typebox").TString;
                            attribution: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedObservation: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
                            sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                            sourceRecordId: import("typebox").TString;
                            figures: import("typebox").TOptional<import("typebox").TObject<{
                                schemaVersion: import("typebox").TLiteral<1>;
                                distribution: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"ratings">;
                                    completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                    bins: import("typebox").TArray<import("typebox").TObject<{
                                        score: import("typebox").TInteger;
                                        count: import("typebox").TInteger;
                                    }>>;
                                }>>;
                                rank: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"subjects">;
                                    position: import("typebox").TInteger;
                                    population: import("typebox").TOptional<import("typebox").TInteger>;
                                }>>;
                            }>>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                            }>;
                            mean: import("typebox").TNumber;
                            count: import("typebox").TInteger;
                            asOf: import("typebox").TString;
                            licence: import("typebox").TString;
                            attribution: import("typebox").TString;
                        }>;
                    };
                };
            };
            response: {
                400: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                401: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                403: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                404: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                409: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                422: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                503: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                200: import("typebox").TObject<{
                    source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
                    observation: import("typebox").TOptional<import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>>;
                    sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                    sourceRecordId: import("typebox").TString;
                    figures: import("typebox").TOptional<import("typebox").TObject<{
                        schemaVersion: import("typebox").TLiteral<1>;
                        distribution: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"ratings">;
                            completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                            bins: import("typebox").TArray<import("typebox").TObject<{
                                score: import("typebox").TInteger;
                                count: import("typebox").TInteger;
                            }>>;
                        }>>;
                        rank: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"subjects">;
                            position: import("typebox").TInteger;
                            population: import("typebox").TOptional<import("typebox").TInteger>;
                        }>>;
                    }>>;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                    }>;
                    mean: import("typebox").TNumber;
                    count: import("typebox").TInteger;
                    asOf: import("typebox").TString;
                    licence: import("typebox").TString;
                    attribution: import("typebox").TString;
                }> & {
                    headers: {
                        readonly "rezics-session-token": import("typebox").TOptional<import("typebox").TString>;
                    };
                };
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                security: {
                    bearerAuth: never[];
                }[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route3: {
        method: 'POST';
        path: "/v1/subjects/:id/source-statistics/:source/$clear";
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            count: 0;
                            asOf: string;
                        };
                        output: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            count: 0;
                            asOf: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedObservation?: string | null;
                            sourceAlias?: string;
                            sourceRecordId: string;
                            count: 0;
                            asOf: string;
                        };
                        issues?: never;
                    } | {
                        value?: never;
                        issues: {
                            message: string;
                        }[];
                    };
                    jsonSchema: {
                        input: () => import("typebox").TObject<{
                            expectedObservation: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
                            sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                            sourceRecordId: import("typebox").TString;
                            count: import("typebox").TLiteral<0>;
                            asOf: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedObservation: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
                            sourceAlias: import("typebox").TOptional<import("typebox").TString>;
                            sourceRecordId: import("typebox").TString;
                            count: import("typebox").TLiteral<0>;
                            asOf: import("typebox").TString;
                        }>;
                    };
                };
            };
            response: {
                400: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                401: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                403: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                404: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                409: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                422: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                503: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                204: import("typebox").TVoid & {
                    headers: {
                        readonly "rezics-session-token": import("typebox").TString;
                    };
                };
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                security: {
                    bearerAuth: never[];
                }[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route4: {
        method: 'GET';
        path: '/v1/subjects/:id/source-statistics/:source/observations';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
            }>;
            query: import("typebox").TObject<{
                digest: import("typebox").TOptional<import("typebox").TString>;
                cursor: import("typebox").TOptional<import("typebox").TString>;
                history: import("typebox").TOptional<import("typebox").TLiteral<"true">>;
            }>;
            response: {
                401: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                403: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                404: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                409: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                422: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                503: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                400: import("typebox").TObject<{
                    type: import("typebox").TSchema;
                    title: import("typebox").TSchema;
                    status: import("typebox").TLiteral<number>;
                    code: import("typebox").TSchema;
                    retryable: import("typebox").TSchema;
                    effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                    request_id: import("typebox").TString;
                    detail?: import("typebox").TOptional<import("typebox").TString>;
                    errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                        pointer: import("typebox").TString;
                        code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                    }>>>;
                }>;
                200: import("typebox").TObject<{
                    source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
                    head: import("typebox").TObject<{
                        digest: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"empty">, import("typebox").TLiteral<"published">, import("typebox").TLiteral<"cleared">]>;
                        observation: import("typebox").TUnion<[import("typebox").TObject<{
                            digest: import("typebox").TString;
                            payloadVersion: import("typebox").TLiteral<1>;
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            asOf: import("typebox").TString;
                            nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            legacy: import("typebox").TBoolean;
                            provenance: import("typebox").TObject<{
                                kind: import("typebox").TLiteral<"unversioned">;
                                digest: import("typebox").TString;
                            }>;
                            payload: import("typebox").TUnion<[import("typebox").TObject<{
                                sourceAlias: import("typebox").TString;
                                sourceRecordId: import("typebox").TString;
                                scale: import("typebox").TObject<{
                                    min: import("typebox").TInteger;
                                    max: import("typebox").TInteger;
                                }>;
                                mean: import("typebox").TNumber;
                                figures: import("typebox").TOptional<import("typebox").TObject<{
                                    schemaVersion: import("typebox").TLiteral<1>;
                                    distribution: import("typebox").TOptional<import("typebox").TObject<{
                                        unit: import("typebox").TLiteral<"ratings">;
                                        completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                        bins: import("typebox").TArray<import("typebox").TObject<{
                                            score: import("typebox").TInteger;
                                            count: import("typebox").TInteger;
                                        }>>;
                                    }>>;
                                    rank: import("typebox").TOptional<import("typebox").TObject<{
                                        unit: import("typebox").TLiteral<"subjects">;
                                        position: import("typebox").TInteger;
                                        population: import("typebox").TOptional<import("typebox").TInteger>;
                                    }>>;
                                }>>;
                                count: import("typebox").TInteger;
                                asOf: import("typebox").TString;
                                licence: import("typebox").TString;
                                attribution: import("typebox").TString;
                            }>, import("typebox").TObject<{
                                sourceAlias: import("typebox").TString;
                                sourceRecordId: import("typebox").TString;
                                count: import("typebox").TLiteral<0>;
                                asOf: import("typebox").TString;
                            }>]>;
                        }>, import("typebox").TNull]>;
                    }>;
                    resolution: import("typebox").TObject<{
                        put: import("typebox").TObject<{
                            expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>;
                        clear: import("typebox").TObject<{
                            expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>;
                    }>;
                    selectedObservation: import("typebox").TOptional<import("typebox").TObject<{
                        digest: import("typebox").TString;
                        payloadVersion: import("typebox").TLiteral<1>;
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        asOf: import("typebox").TString;
                        nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        legacy: import("typebox").TBoolean;
                        provenance: import("typebox").TObject<{
                            kind: import("typebox").TLiteral<"unversioned">;
                            digest: import("typebox").TString;
                        }>;
                        payload: import("typebox").TUnion<[import("typebox").TObject<{
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                            }>;
                            mean: import("typebox").TNumber;
                            figures: import("typebox").TOptional<import("typebox").TObject<{
                                schemaVersion: import("typebox").TLiteral<1>;
                                distribution: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"ratings">;
                                    completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                    bins: import("typebox").TArray<import("typebox").TObject<{
                                        score: import("typebox").TInteger;
                                        count: import("typebox").TInteger;
                                    }>>;
                                }>>;
                                rank: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"subjects">;
                                    position: import("typebox").TInteger;
                                    population: import("typebox").TOptional<import("typebox").TInteger>;
                                }>>;
                            }>>;
                            count: import("typebox").TInteger;
                            asOf: import("typebox").TString;
                            licence: import("typebox").TString;
                            attribution: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            count: import("typebox").TLiteral<0>;
                            asOf: import("typebox").TString;
                        }>]>;
                    }>>;
                    history: import("typebox").TOptional<import("typebox").TObject<{
                        items: import("typebox").TArray<import("typebox").TObject<{
                            digest: import("typebox").TString;
                            payloadVersion: import("typebox").TLiteral<1>;
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            asOf: import("typebox").TString;
                            nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            legacy: import("typebox").TBoolean;
                            provenance: import("typebox").TObject<{
                                kind: import("typebox").TLiteral<"unversioned">;
                                digest: import("typebox").TString;
                            }>;
                            payload: import("typebox").TUnion<[import("typebox").TObject<{
                                sourceAlias: import("typebox").TString;
                                sourceRecordId: import("typebox").TString;
                                scale: import("typebox").TObject<{
                                    min: import("typebox").TInteger;
                                    max: import("typebox").TInteger;
                                }>;
                                mean: import("typebox").TNumber;
                                figures: import("typebox").TOptional<import("typebox").TObject<{
                                    schemaVersion: import("typebox").TLiteral<1>;
                                    distribution: import("typebox").TOptional<import("typebox").TObject<{
                                        unit: import("typebox").TLiteral<"ratings">;
                                        completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                        bins: import("typebox").TArray<import("typebox").TObject<{
                                            score: import("typebox").TInteger;
                                            count: import("typebox").TInteger;
                                        }>>;
                                    }>>;
                                    rank: import("typebox").TOptional<import("typebox").TObject<{
                                        unit: import("typebox").TLiteral<"subjects">;
                                        position: import("typebox").TInteger;
                                        population: import("typebox").TOptional<import("typebox").TInteger>;
                                    }>>;
                                }>>;
                                count: import("typebox").TInteger;
                                asOf: import("typebox").TString;
                                licence: import("typebox").TString;
                                attribution: import("typebox").TString;
                            }>, import("typebox").TObject<{
                                sourceAlias: import("typebox").TString;
                                sourceRecordId: import("typebox").TString;
                                count: import("typebox").TLiteral<0>;
                                asOf: import("typebox").TString;
                            }>]>;
                        }>>;
                        nextCursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    }>>;
                }>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                security: {
                    bearerAuth: never[];
                }[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
}): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
    typebox: {};
    error: [{
        error: Error;
        response: {};
        passes: false;
        '~return': Response;
        '~catchAll': true;
    }];
}, {
    schema: {};
    schemas: {};
    macro: {};
    macroFn: {};
    parser: {};
    response: {};
}, {
    health: {
        get: {
            body: unknown;
            params: {};
            query: unknown;
            headers: unknown;
            response: {
                200: {
                    status: 'ok';
                };
            };
            error: never;
        };
    };
} & {
    v1: {
        subjects: {
            post: {
                body: {
                    type: string;
                    labels: Record<string, any>;
                    descriptions?: Record<string, any>;
                    aliases?: Record<string, any>;
                    statements?: Record<string, any>;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        subject: import("../semantic/item.ts").Item;
                    };
                    201: {
                        subject: {
                            id: string;
                            type: string;
                            revision: number;
                            release: string;
                            context: string;
                            resolution: Record<string, any>;
                            relationCounts: Record<string, number>;
                            labels: Record<string, string>;
                            descriptions: Record<string, string>;
                            aliases: Record<string, string[]>;
                            statements: Record<string, {
                                id: string;
                                rank: "deprecated" | "normal" | "preferred";
                                property: {
                                    id: string;
                                    data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                };
                                value: {
                                    type: "value";
                                    content: any;
                                } | {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                                qualifiers: {
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                }[];
                                references: {
                                    parts: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    hash: string;
                                }[];
                                rezics: {
                                    release: string;
                                    revision: number;
                                };
                            }[]>;
                            sourceRecords: {
                                name: string;
                                url: string;
                                licence?: {
                                    id: string;
                                    url?: string;
                                };
                                attribution?: string;
                            }[];
                        };
                    };
                    400: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                    401: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                    403: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                    503: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                terms: {
                    patch: {
                        body: {
                            labels?: Record<string, string | null>;
                            descriptions?: Record<string, string | null>;
                            aliases?: Record<string, string[] | null>;
                        };
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                            'if-match': string;
                        };
                        response: {
                            200: {
                                subject: string;
                                revision: number;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            412: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            $merge: {
                post: {
                    body: {
                        subjects: string[];
                        expectedIdentity?: {
                            endpoints: [{
                                subject: string;
                                revision: number;
                                securityRevision: string;
                                source: "bangumi" | "bangumi_cross_media" | "vndb" | "vndb_cross_media";
                                externalId: string;
                                claimTransactionId: string;
                                property: "wdt:P3180" | "wdt:P6298";
                                value: string;
                            }, {
                                subject: string;
                                revision: number;
                                securityRevision: string;
                                source: "bangumi" | "bangumi_cross_media" | "vndb" | "vndb_cross_media";
                                externalId: string;
                                claimTransactionId: string;
                                property: "wdt:P3180" | "wdt:P6298";
                                value: string;
                            }];
                        };
                    };
                    params: {};
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            operation: {
                                id: string;
                            };
                        };
                        202: {
                            operation: {
                                id: string;
                            };
                        };
                        400: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        401: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        403: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        404: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        409: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        422: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        503: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        subjectIdentityOperations: {
            ":id": {
                get: {
                    body: unknown;
                    params: {
                        id: string;
                    };
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            operation: {
                                id: string;
                                done: false;
                            } | {
                                id: string;
                                done: true;
                                result: {
                                    survivor: string;
                                    redirected: string;
                                    revision: number;
                                };
                            };
                        };
                        401: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        404: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        422: Response | {
                            type: 'validation';
                            code: 'validation';
                            title: 'Validation Error';
                            status: 422;
                            detail?: string;
                            on: string;
                            found?: unknown;
                            property?: string;
                            expected?: unknown;
                            errors?: {
                                message?: string;
                                [key: string]: unknown;
                            }[];
                        };
                        503: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                get: {
                    body: unknown;
                    params: {
                        id: string;
                    };
                    query: {
                        context?: string;
                        language?: string;
                        includeViewerActions?: boolean;
                        includeDocuments?: boolean;
                        selectedSynopsis?: string;
                        reviewIdentitySource?: "bangumi" | "bangumi_cross_media" | "vndb" | "vndb_cross_media";
                        reviewIdentityExternalId?: string;
                    };
                    headers: unknown;
                    response: {
                        200: {
                            subject: {
                                id: string;
                                type: string;
                                revision: number;
                                release: string;
                                context: string;
                                resolution: Record<string, any>;
                                relationCounts: Record<string, number>;
                                labels: Record<string, string>;
                                descriptions: Record<string, string>;
                                aliases: Record<string, string[]>;
                                statements: Record<string, {
                                    id: string;
                                    rank: "deprecated" | "normal" | "preferred";
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                    qualifiers: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    references: {
                                        parts: {
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                        }[];
                                        hash: string;
                                    }[];
                                    rezics: {
                                        release: string;
                                        revision: number;
                                    };
                                }[]>;
                                sourceRecords: {
                                    name: string;
                                    url: string;
                                    licence?: {
                                        id: string;
                                        url?: string;
                                    };
                                    attribution?: string;
                                }[];
                            };
                            selectedSynopsis?: {
                                kind: "matched";
                                fact: {
                                    id: string;
                                    rank: "deprecated" | "normal" | "preferred";
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                    qualifiers: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    references: {
                                        parts: {
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                        }[];
                                        hash: string;
                                    }[];
                                };
                                context: string;
                                release: string;
                            } | {
                                kind: "changed";
                            } | {
                                kind: "missing";
                            } | {
                                kind: "unsupported";
                            } | {
                                kind: "unavailable";
                            };
                            reviewedIdentity?: {
                                subject: string;
                                revision: number;
                                securityRevision: string;
                                source: "bangumi" | "bangumi_cross_media" | "vndb" | "vndb_cross_media";
                                externalId: string;
                                claimTransactionId: string;
                                property: "wdt:P3180" | "wdt:P6298";
                                value: string;
                            } | null;
                            account: {
                                id: string;
                            } | null;
                            summary: {
                                id: string;
                                type: string;
                                types: string[];
                                label: {
                                    value: string;
                                    language: string;
                                } | null;
                                creativeWork: boolean;
                                cover: {
                                    media: string;
                                    width: number;
                                    height: number;
                                    placeholder: {
                                        thumbhash: string;
                                        color: string;
                                    };
                                    variants: {
                                        format: "avif" | "webp";
                                        width: number;
                                    }[];
                                    focalPoint: {
                                        x: number;
                                        y: number;
                                    } | null;
                                    credit: {
                                        rightsHolder: string;
                                        via: {
                                            name: string;
                                            url: string;
                                        };
                                        license: string;
                                        obligations: string[];
                                    };
                                } | null;
                            } | null;
                            related: Record<string, {
                                labels: Record<string, string>;
                                redirect?: string;
                                type?: string;
                                types?: string[];
                                cover?: {
                                    media: string;
                                    width: number;
                                    height: number;
                                    placeholder: {
                                        thumbhash: string;
                                        color: string;
                                    };
                                    variants: {
                                        format: "avif" | "webp";
                                        width: number;
                                    }[];
                                    focalPoint: {
                                        x: number;
                                        y: number;
                                    } | null;
                                    credit: {
                                        rightsHolder: string;
                                        via: {
                                            name: string;
                                            url: string;
                                        };
                                        license: string;
                                        obligations: string[];
                                    };
                                } | null;
                            }>;
                            documents?: Record<string, import("../content/document-public.ts").PublicDocumentView>;
                            viewerActions?: {
                                state: "available";
                                actions: {
                                    action: string;
                                    operations: string[];
                                }[];
                            } | {
                                state: "unavailable";
                            };
                        };
                        308: {
                            redirect: {
                                from: string;
                                to: string;
                            };
                        };
                        400: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        401: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        403: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        404: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        409: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        422: Response | {
                            type: 'validation';
                            code: 'validation';
                            title: 'Validation Error';
                            status: 422;
                            detail?: string;
                            on: string;
                            found?: unknown;
                            property?: string;
                            expected?: unknown;
                            errors?: {
                                message?: string;
                                [key: string]: unknown;
                            }[];
                        };
                        503: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                $hide: {
                    post: {
                        body: {
                            reason: string;
                        };
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                subject: string;
                                visibility: "hidden" | "taken_down" | "visible";
                                security_revision: number;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            409: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                $takedown: {
                    post: {
                        body: {
                            notice: {
                                complaint: string;
                                received_at: string;
                                scope?: string;
                            };
                        };
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                subject: string;
                                visibility: "hidden" | "taken_down" | "visible";
                                security_revision: number;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            409: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                $restore: {
                    post: {
                        body: {
                            reason: string;
                        };
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                subject: string;
                                visibility: "hidden" | "taken_down" | "visible";
                                security_revision: number;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            409: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    post: {
                        body: {
                            statement: any;
                        };
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                candidate: string;
                                revision: number;
                            };
                            201: {
                                candidate: string;
                                revision: number;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    ":candidate": {
                        lifecycle: {
                            get: {
                                body: unknown;
                                params: {
                                    id: string;
                                    candidate: string;
                                };
                                query: {
                                    property: string;
                                };
                                headers: unknown;
                                response: {
                                    200: {
                                        subject: string;
                                        candidate: string;
                                        property: string;
                                        viewer: "account" | "anonymous";
                                        state: "available" | "deleted";
                                        selected: boolean;
                                        actions: {
                                            state: "available";
                                            operations: ("delete" | "restore")[];
                                        } | {
                                            state: "unavailable";
                                        };
                                    };
                                    400: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: 'validation';
                                        code: 'validation';
                                        title: 'Validation Error';
                                        status: 422;
                                        detail?: string;
                                        on: string;
                                        found?: unknown;
                                        property?: string;
                                        expected?: unknown;
                                        errors?: {
                                            message?: string;
                                            [key: string]: unknown;
                                        }[];
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    ":candidate": {
                        delete: {
                            body: object | null | undefined;
                            params: {
                                id: string;
                                candidate: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    subject: string;
                                    candidate: string;
                                    deleted: boolean;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                403: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                409: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    ":candidate": {
                        $restoreDeleted: {
                            post: {
                                body: object;
                                params: {
                                    id: string;
                                    candidate: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        subject: string;
                                        candidate: string;
                                        deleted: boolean;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    403: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    409: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    ":candidate": {
                        $accept: {
                            post: {
                                body: {
                                    context: string;
                                    expected_head: number | null;
                                };
                                params: {
                                    id: string;
                                    candidate: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        acceptance: {
                                            context: string;
                                            candidate: string;
                                            decision: "accept" | "reject";
                                            head: number;
                                        };
                                        revision: number;
                                    };
                                    400: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    403: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    409: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    ":candidate": {
                        $reject: {
                            post: {
                                body: {
                                    context: string;
                                    expected_head: number | null;
                                };
                                params: {
                                    id: string;
                                    candidate: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        acceptance: {
                                            context: string;
                                            candidate: string;
                                            decision: "accept" | "reject";
                                            head: number;
                                        };
                                        revision: number;
                                    };
                                    400: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    403: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    409: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    ":candidate": {
                        $hide: {
                            post: {
                                body: {
                                    reason: string;
                                };
                                params: {
                                    id: string;
                                    candidate: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        subject: string;
                                        candidate: string;
                                        visibility: "hidden" | "taken_down" | "visible";
                                        security_revision: number;
                                    };
                                    400: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    403: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    409: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    ":candidate": {
                        $takedown: {
                            post: {
                                body: {
                                    notice: {
                                        complaint: string;
                                        received_at: string;
                                        scope?: string;
                                    };
                                };
                                params: {
                                    id: string;
                                    candidate: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        subject: string;
                                        candidate: string;
                                        visibility: "hidden" | "taken_down" | "visible";
                                        security_revision: number;
                                    };
                                    400: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    403: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    409: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    ":candidate": {
                        $restore: {
                            post: {
                                body: {
                                    reason: string;
                                };
                                params: {
                                    id: string;
                                    candidate: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        subject: string;
                                        candidate: string;
                                        visibility: "hidden" | "taken_down" | "visible";
                                        security_revision: number;
                                    };
                                    400: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    403: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    409: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                $adopt: {
                    post: {
                        body: {
                            context: string;
                            property: string;
                            target?: string;
                            sameAs?: string;
                            key?: string;
                            mode: "inherit" | "replace" | "suppress";
                            selection: {
                                candidate: string;
                                rank: "deprecated" | "normal" | "preferred";
                            }[];
                            expected_head: number | null;
                        };
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                adoption: {
                                    context: string;
                                    property: string;
                                    mode: "inherit" | "replace" | "suppress";
                                    selection: {
                                        candidate: string;
                                        rank: "deprecated" | "normal" | "preferred";
                                    }[];
                                    head: number;
                                };
                                revision: number;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            409: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                candidates: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            limit?: string | number;
                            cursor?: string;
                            property: string;
                            context?: string;
                            target?: string;
                            sameAs?: string;
                            key?: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                candidates: ({
                                    id: string;
                                    deleted: true;
                                } | {
                                    id: string;
                                    source: {
                                        source: string;
                                        external_id: string;
                                        record_revision: string;
                                        digest: string;
                                        converter_revision: string;
                                        field_group: "cover" | "facts" | "summary";
                                    } | {
                                        kind: "agent";
                                        subject: string;
                                    } | null;
                                    retracted: number | null;
                                    retraction: {
                                        source: {
                                            source: string;
                                            external_id: string;
                                            record_revision: string;
                                            digest: string;
                                            converter_revision: string;
                                            field_group: "cover" | "facts" | "summary";
                                        } | {
                                            kind: "agent";
                                            subject: string;
                                        };
                                        references: {
                                            parts: ({
                                                property: {
                                                    id: string;
                                                };
                                                value: {
                                                    type: "value";
                                                    content: unknown;
                                                };
                                            } | {
                                                property: {
                                                    id: string;
                                                };
                                                value: {
                                                    type: "somevalue";
                                                } | {
                                                    type: "novalue";
                                                };
                                            })[];
                                        }[];
                                    } | null;
                                    consentIdentity?: {
                                        subject: {
                                            id: string;
                                            labels: Record<string, string>;
                                        } | null;
                                        target: {
                                            id: string;
                                            labels: Record<string, string>;
                                            redirect?: string;
                                        } | null;
                                    };
                                    statement: {
                                        id: string;
                                        rank: "deprecated" | "normal" | "preferred";
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                        qualifiers: {
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                        }[];
                                        references: {
                                            parts: {
                                                property: {
                                                    id: string;
                                                    data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                };
                                                value: {
                                                    type: "value";
                                                    content: any;
                                                } | {
                                                    type: "somevalue";
                                                } | {
                                                    type: "novalue";
                                                };
                                            }[];
                                            hash: string;
                                        }[];
                                        rezics: {
                                            release: string;
                                            revision: number;
                                        };
                                    };
                                    release: string;
                                    revision: number;
                                    decision: "abstained" | "accepted" | "rejected" | null;
                                    head: number | null;
                                    rank: "deprecated" | "normal" | "preferred" | null;
                                })[];
                                adoption: {
                                    mode: "inherit" | "replace" | "suppress";
                                    head: number;
                                } | null;
                                next: string | null;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: unknown;
                                errors?: {
                                    message?: string;
                                    [key: string]: unknown;
                                }[];
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                revisions: {
                    ":revision": {
                        get: {
                            body: unknown;
                            params: {
                                id: string;
                                revision: number;
                            };
                            query: unknown;
                            headers: unknown;
                            response: {
                                200: {
                                    subject: string;
                                    revision: {
                                        revision: number;
                                        kind: string;
                                        release: string;
                                    };
                                    change: {
                                        kind: "record";
                                    } | {
                                        kind: "terms";
                                        fields: {
                                            field: "aliases" | "descriptions" | "labels";
                                            languages: string[];
                                        }[];
                                    } | {
                                        candidate: string;
                                        property: string;
                                        context: string;
                                        reading: {
                                            decision: {
                                                head: number;
                                                verdict: "abstain" | "accept" | "reject";
                                                revision: number;
                                            } | null;
                                            selected: boolean;
                                            rank: "deprecated" | "normal" | "preferred" | null;
                                        };
                                        kind: "candidate";
                                    } | {
                                        candidate: string;
                                        property: string;
                                        context: string;
                                        reading: {
                                            decision: {
                                                head: number;
                                                verdict: "abstain" | "accept" | "reject";
                                                revision: number;
                                            } | null;
                                            selected: boolean;
                                            rank: "deprecated" | "normal" | "preferred" | null;
                                        };
                                        kind: "decision";
                                        head: number;
                                        verdict: "abstain" | "accept" | "reject";
                                    } | {
                                        kind: "adoption";
                                        property: string;
                                        context: string;
                                        head: number;
                                        mode: "inherit" | "replace" | "suppress";
                                        selection: {
                                            candidate: string;
                                            rank: "deprecated" | "normal" | "preferred";
                                        }[];
                                    };
                                };
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: 'validation';
                                    code: 'validation';
                                    title: 'Validation Error';
                                    status: 422;
                                    detail?: string;
                                    on: string;
                                    found?: unknown;
                                    property?: string;
                                    expected?: unknown;
                                    errors?: {
                                        message?: string;
                                        [key: string]: unknown;
                                    }[];
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                revisions: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            limit?: string | number;
                            cursor?: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                revisions: {
                                    revision: number;
                                    kind: string;
                                    release: string;
                                    source: {
                                        source: string;
                                        external_id: string;
                                        record_revision: string;
                                        digest: string;
                                        converter_revision: string;
                                        field_group: "cover" | "facts" | "summary";
                                    } | {
                                        kind: "agent";
                                        subject: string;
                                    } | null;
                                }[];
                                next: string | null;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: unknown;
                                errors?: {
                                    message?: string;
                                    [key: string]: unknown;
                                }[];
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            graph: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        400: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                graph: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            property: string[];
                            direction: "both" | "in" | "out";
                            depth: string | number;
                            limit?: string | number;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                nodes: {
                                    id: string;
                                    type: string;
                                    label: string;
                                    summary: {
                                        id: string;
                                        type: string;
                                        types: string[];
                                        label: {
                                            value: string;
                                            language: string;
                                        } | null;
                                        creativeWork: boolean;
                                        cover: {
                                            media: string;
                                            width: number;
                                            height: number;
                                            placeholder: {
                                                thumbhash: string;
                                                color: string;
                                            };
                                            variants: {
                                                format: "avif" | "webp";
                                                width: number;
                                            }[];
                                            focalPoint: {
                                                x: number;
                                                y: number;
                                            } | null;
                                            credit: {
                                                rightsHolder: string;
                                                via: {
                                                    name: string;
                                                    url: string;
                                                };
                                                license: string;
                                                obligations: string[];
                                            };
                                        } | null;
                                    };
                                }[];
                                edges: {
                                    from: string;
                                    property: string;
                                    to: string;
                                    statement: string;
                                }[];
                                truncated: {
                                    node: string;
                                    property: string;
                                    direction: "in" | "out";
                                    count?: number;
                                    cursor: string;
                                }[];
                            };
                            308: {
                                redirect: {
                                    from: string;
                                    to: string;
                                };
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: unknown;
                                errors?: {
                                    message?: string;
                                    [key: string]: unknown;
                                }[];
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                counts: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: import("../semantic/counts.ts").SubjectRelationCountResponse;
                            308: {
                                redirect: {
                                    from: string;
                                    to: string;
                                };
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: unknown;
                                errors?: {
                                    message?: string;
                                    [key: string]: unknown;
                                }[];
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                links: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            limit?: string | number;
                            cursor?: string;
                            context?: string;
                            property?: string;
                            filter?: string;
                            qualifier?: string;
                            type?: string;
                            language?: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                links: {
                                    subject: string;
                                    property: string;
                                    statement: string;
                                    assertion?: {
                                        id: string;
                                        rank: "deprecated" | "normal" | "preferred";
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                        qualifiers: {
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                        }[];
                                        references: {
                                            parts: {
                                                property: {
                                                    id: string;
                                                    data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                };
                                                value: {
                                                    type: "value";
                                                    content: any;
                                                } | {
                                                    type: "somevalue";
                                                } | {
                                                    type: "novalue";
                                                };
                                            }[];
                                            hash: string;
                                        }[];
                                        rezics: {
                                            release: string;
                                            revision: number;
                                        };
                                    };
                                    creditSlot?: {
                                        property: string;
                                        target: string;
                                        key?: string;
                                    };
                                    related?: Record<string, {
                                        id: string;
                                        type: string;
                                        types: string[];
                                        label: {
                                            value: string;
                                            language: string;
                                        } | null;
                                        creativeWork: boolean;
                                        cover: {
                                            media: string;
                                            width: number;
                                            height: number;
                                            placeholder: {
                                                thumbhash: string;
                                                color: string;
                                            };
                                            variants: {
                                                format: "avif" | "webp";
                                                width: number;
                                            }[];
                                            focalPoint: {
                                                x: number;
                                                y: number;
                                            } | null;
                                            credit: {
                                                rightsHolder: string;
                                                via: {
                                                    name: string;
                                                    url: string;
                                                };
                                                license: string;
                                                obligations: string[];
                                            };
                                        } | null;
                                        redirect?: string;
                                    }>;
                                    type: string;
                                    label: string;
                                    summary: {
                                        id: string;
                                        type: string;
                                        types: string[];
                                        label: {
                                            value: string;
                                            language: string;
                                        } | null;
                                        creativeWork: boolean;
                                        cover: {
                                            media: string;
                                            width: number;
                                            height: number;
                                            placeholder: {
                                                thumbhash: string;
                                                color: string;
                                            };
                                            variants: {
                                                format: "avif" | "webp";
                                                width: number;
                                            }[];
                                            focalPoint: {
                                                x: number;
                                                y: number;
                                            } | null;
                                            credit: {
                                                rightsHolder: string;
                                                via: {
                                                    name: string;
                                                    url: string;
                                                };
                                                license: string;
                                                obligations: string[];
                                            };
                                        } | null;
                                    };
                                }[];
                                workReleaseCards?: {
                                    state: "unavailable";
                                } | {
                                    state: "available";
                                    cards: {
                                        subject: string;
                                        type: string;
                                        summary: {
                                            id: string;
                                            type: string;
                                            types: string[];
                                            label: {
                                                value: string;
                                                language: string;
                                            } | null;
                                            creativeWork: boolean;
                                            cover: {
                                                media: string;
                                                width: number;
                                                height: number;
                                                placeholder: {
                                                    thumbhash: string;
                                                    color: string;
                                                };
                                                variants: {
                                                    format: "avif" | "webp";
                                                    width: number;
                                                }[];
                                                focalPoint: {
                                                    x: number;
                                                    y: number;
                                                } | null;
                                                credit: {
                                                    rightsHolder: string;
                                                    via: {
                                                        name: string;
                                                        url: string;
                                                    };
                                                    license: string;
                                                    obligations: string[];
                                                };
                                            } | null;
                                        };
                                        membership: {
                                            id: string;
                                            rank: "deprecated" | "normal" | "preferred";
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                            qualifiers: {
                                                property: {
                                                    id: string;
                                                    data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                };
                                                value: {
                                                    type: "value";
                                                    content: any;
                                                } | {
                                                    type: "somevalue";
                                                } | {
                                                    type: "novalue";
                                                };
                                            }[];
                                            references: {
                                                parts: {
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                }[];
                                                hash: string;
                                            }[];
                                            rezics: {
                                                release: string;
                                                revision: number;
                                            };
                                        };
                                        related: Record<string, {
                                            id: string;
                                            type: string;
                                            types: string[];
                                            label: {
                                                value: string;
                                                language: string;
                                            } | null;
                                            creativeWork: boolean;
                                            cover: {
                                                media: string;
                                                width: number;
                                                height: number;
                                                placeholder: {
                                                    thumbhash: string;
                                                    color: string;
                                                };
                                                variants: {
                                                    format: "avif" | "webp";
                                                    width: number;
                                                }[];
                                                focalPoint: {
                                                    x: number;
                                                    y: number;
                                                } | null;
                                                credit: {
                                                    rightsHolder: string;
                                                    via: {
                                                        name: string;
                                                        url: string;
                                                    };
                                                    license: string;
                                                    obligations: string[];
                                                };
                                            } | null;
                                        }>;
                                        fields: {
                                            'schema:gamePlatform': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'schema:inLanguage': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'schema:datePublished': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'schema:creativeWorkStatus': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'wdt:P5804': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'rezics:releaseStatus': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'schema:contentRating': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'schema:publisher': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'schema:producer': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'wdt:P178': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'wdt:P162': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                            'wdt:P2899': {
                                                state: "unsupported";
                                            } | {
                                                state: "withheld";
                                            } | {
                                                state: "missing";
                                            } | {
                                                state: "unavailable";
                                            } | {
                                                state: "available";
                                                statements: {
                                                    id: string;
                                                    rank: "deprecated" | "normal" | "preferred";
                                                    property: {
                                                        id: string;
                                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                    };
                                                    value: {
                                                        type: "value";
                                                        content: any;
                                                    } | {
                                                        type: "somevalue";
                                                    } | {
                                                        type: "novalue";
                                                    };
                                                    qualifiers: {
                                                        property: {
                                                            id: string;
                                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                        };
                                                        value: {
                                                            type: "value";
                                                            content: any;
                                                        } | {
                                                            type: "somevalue";
                                                        } | {
                                                            type: "novalue";
                                                        };
                                                    }[];
                                                    references: {
                                                        parts: {
                                                            property: {
                                                                id: string;
                                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                            };
                                                            value: {
                                                                type: "value";
                                                                content: any;
                                                            } | {
                                                                type: "somevalue";
                                                            } | {
                                                                type: "novalue";
                                                            };
                                                        }[];
                                                        hash: string;
                                                    }[];
                                                    rezics: {
                                                        release: string;
                                                        revision: number;
                                                    };
                                                }[];
                                                related: Record<string, {
                                                    id: string;
                                                    type: string;
                                                    types: string[];
                                                    label: {
                                                        value: string;
                                                        language: string;
                                                    } | null;
                                                    creativeWork: boolean;
                                                    cover: {
                                                        media: string;
                                                        width: number;
                                                        height: number;
                                                        placeholder: {
                                                            thumbhash: string;
                                                            color: string;
                                                        };
                                                        variants: {
                                                            format: "avif" | "webp";
                                                            width: number;
                                                        }[];
                                                        focalPoint: {
                                                            x: number;
                                                            y: number;
                                                        } | null;
                                                        credit: {
                                                            rightsHolder: string;
                                                            via: {
                                                                name: string;
                                                                url: string;
                                                            };
                                                            license: string;
                                                            obligations: string[];
                                                        };
                                                    } | null;
                                                }>;
                                            };
                                        };
                                    }[];
                                };
                                count?: {
                                    value: number;
                                    exact: boolean;
                                };
                                freshness: {
                                    consistency: "eventual";
                                    target_seconds: 10;
                                    caught_up: boolean;
                                };
                                partial?: boolean;
                                next: string | null;
                            };
                            308: {
                                redirect: {
                                    from: string;
                                    to: string;
                                };
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: unknown;
                                errors?: {
                                    message?: string;
                                    [key: string]: unknown;
                                }[];
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                relations: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            cursor?: string;
                            limit?: string | number;
                            property: string;
                            filter?: string;
                            type?: string;
                            context?: string;
                            language?: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                relations: {
                                    statement: {
                                        id: string;
                                        rank: "deprecated" | "normal" | "preferred";
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                        qualifiers: {
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                        }[];
                                        references: {
                                            parts: {
                                                property: {
                                                    id: string;
                                                    data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                                };
                                                value: {
                                                    type: "value";
                                                    content: any;
                                                } | {
                                                    type: "somevalue";
                                                } | {
                                                    type: "novalue";
                                                };
                                            }[];
                                            hash: string;
                                        }[];
                                        rezics: {
                                            release: string;
                                            revision: number;
                                        };
                                    };
                                    related?: Record<string, {
                                        id: string;
                                        type: string;
                                        types: string[];
                                        label: {
                                            value: string;
                                            language: string;
                                        } | null;
                                        creativeWork: boolean;
                                        cover: {
                                            media: string;
                                            width: number;
                                            height: number;
                                            placeholder: {
                                                thumbhash: string;
                                                color: string;
                                            };
                                            variants: {
                                                format: "avif" | "webp";
                                                width: number;
                                            }[];
                                            focalPoint: {
                                                x: number;
                                                y: number;
                                            } | null;
                                            credit: {
                                                rightsHolder: string;
                                                via: {
                                                    name: string;
                                                    url: string;
                                                };
                                                license: string;
                                                obligations: string[];
                                            };
                                        } | null;
                                        redirect?: string;
                                    }>;
                                    target: string | null;
                                    external: string | null;
                                    type?: string;
                                    label?: string;
                                    summary: {
                                        id: string;
                                        type: string;
                                        types: string[];
                                        label: {
                                            value: string;
                                            language: string;
                                        } | null;
                                        creativeWork: boolean;
                                        cover: {
                                            media: string;
                                            width: number;
                                            height: number;
                                            placeholder: {
                                                thumbhash: string;
                                                color: string;
                                            };
                                            variants: {
                                                format: "avif" | "webp";
                                                width: number;
                                            }[];
                                            focalPoint: {
                                                x: number;
                                                y: number;
                                            } | null;
                                            credit: {
                                                rightsHolder: string;
                                                via: {
                                                    name: string;
                                                    url: string;
                                                };
                                                license: string;
                                                obligations: string[];
                                            };
                                        } | null;
                                    } | null;
                                }[];
                                count?: {
                                    value: number;
                                    exact: boolean;
                                };
                                freshness: {
                                    consistency: "eventual";
                                    target_seconds: 10;
                                    caught_up: boolean;
                                };
                                next: string | null;
                            };
                            308: {
                                redirect: {
                                    from: string;
                                    to: string;
                                };
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: unknown;
                                errors?: {
                                    message?: string;
                                    [key: string]: unknown;
                                }[];
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        statements: {
            ":id": {
                disclose: {
                    post: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                candidate: string;
                                disclosed: true;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            409: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        statements: {
            ":id": {
                retract: {
                    post: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                candidate: string;
                                retracted: true;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            409: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                reactions: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                counts: {
                                    kind: "downvote" | "insightful" | "laugh" | "like" | "love" | "sad" | "upvote";
                                    count: number;
                                }[];
                                watermark: {
                                    epoch: number;
                                    position: string;
                                } | null;
                            };
                            308: {
                                redirect: {
                                    from: string;
                                    to: string;
                                };
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: unknown;
                                errors?: {
                                    message?: string;
                                    [key: string]: unknown;
                                }[];
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitionTypes: {
            get: {
                body: unknown;
                params: {};
                query: {
                    query?: string;
                    typeId?: string;
                    locale?: never;
                    limit?: number;
                    cursor?: string;
                };
                headers: unknown;
                response: {
                    200: {
                        types: {
                            typeId: string;
                            releaseDigest: string;
                            label: string;
                            language: string | null;
                            parents: string[];
                            description: string | null;
                            descriptionLanguage: string | null;
                        }[];
                        next: string | null;
                    };
                    400: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                    401: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                    404: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                    409: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                    422: Response | {
                        type: 'validation';
                        code: 'validation';
                        title: 'Validation Error';
                        status: 422;
                        detail?: string;
                        on: string;
                        found?: unknown;
                        property?: string;
                        expected?: unknown;
                        errors?: {
                            message?: string;
                            [key: string]: unknown;
                        }[];
                    };
                    503: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail: unknown;
                        errors: unknown;
                    };
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        definitionTypes: {
            ":typeId": {
                get: {
                    body: unknown;
                    params: {
                        typeId: string;
                    };
                    query: {
                        locale?: never;
                    };
                    headers: unknown;
                    response: {
                        200: {
                            typeId: string;
                            releaseDigest: string;
                            label: string;
                            language: string | null;
                            parents: string[];
                            description: string | null;
                            descriptionLanguage: string | null;
                            definition: Record<string, any>;
                            properties: Record<string, Record<string, any>>;
                        };
                        400: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        401: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        404: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        409: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        422: Response | {
                            type: 'validation';
                            code: 'validation';
                            title: 'Validation Error';
                            status: 422;
                            detail?: string;
                            on: string;
                            found?: unknown;
                            property?: string;
                            expected?: unknown;
                            errors?: {
                                message?: string;
                                [key: string]: unknown;
                            }[];
                        };
                        503: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            catalogue: {
                artifacts: {
                    post: {
                        body: {
                            kind: "declaration" | "node" | "release" | "root";
                            artifact: Record<string, any>;
                        };
                        params: {};
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                digest: string;
                            };
                            201: {
                                digest: string;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            409: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            catalogues: {
                post: {
                    body: {
                        pin: {
                            format: "https://rezics.com/definitions/catalogue/2";
                            rootDigest: string;
                            kindSpec: "https://rezics.com/definitions/kind/1";
                            reduction: "https://rezics.com/definitions/kind-reduction/1";
                        };
                    };
                    params: {};
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            pin: {
                                format: "https://rezics.com/definitions/catalogue/2";
                                rootDigest: string;
                                kindSpec: "https://rezics.com/definitions/kind/1";
                                reduction: "https://rezics.com/definitions/kind-reduction/1";
                            };
                            state: "building" | "incomplete" | "ready" | "refused";
                            phase: "declaration" | "node" | "release";
                            steps: string;
                            nodes: string;
                            releases: string;
                            declarations: string;
                            indexed_rows: string;
                            examined_bytes: string;
                            missing_digest: string | null;
                            error: string | null;
                        };
                        400: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        401: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        403: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        404: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        409: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        422: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        503: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            catalogues: {
                ":root": {
                    $step: {
                        post: {
                            body: object;
                            params: {
                                root: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    pin: {
                                        format: "https://rezics.com/definitions/catalogue/2";
                                        rootDigest: string;
                                        kindSpec: "https://rezics.com/definitions/kind/1";
                                        reduction: "https://rezics.com/definitions/kind-reduction/1";
                                    };
                                    state: "building" | "incomplete" | "ready" | "refused";
                                    phase: "declaration" | "node" | "release";
                                    steps: string;
                                    nodes: string;
                                    releases: string;
                                    declarations: string;
                                    indexed_rows: string;
                                    examined_bytes: string;
                                    missing_digest: string | null;
                                    error: string | null;
                                };
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                403: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                409: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            catalogues: {
                ":root": {
                    $activate: {
                        post: {
                            body: {
                                expected_head: number | null;
                            };
                            params: {
                                root: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    pin: {
                                        format: "https://rezics.com/definitions/catalogue/2";
                                        rootDigest: string;
                                        kindSpec: "https://rezics.com/definitions/kind/1";
                                        reduction: "https://rezics.com/definitions/kind-reduction/1";
                                    };
                                    head: number;
                                };
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                403: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                409: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            catalogue: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            pin: {
                                format: "https://rezics.com/definitions/catalogue/2";
                                rootDigest: string;
                                kindSpec: "https://rezics.com/definitions/kind/1";
                                reduction: "https://rezics.com/definitions/kind-reduction/1";
                            };
                            head: number;
                        } | null;
                        400: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        401: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        403: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        404: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        503: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            catalogues: {
                ":root": {
                    build: {
                        get: {
                            body: unknown;
                            params: {
                                root: string;
                            };
                            query: unknown;
                            headers: unknown;
                            response: {
                                200: {
                                    pin: {
                                        format: "https://rezics.com/definitions/catalogue/2";
                                        rootDigest: string;
                                        kindSpec: "https://rezics.com/definitions/kind/1";
                                        reduction: "https://rezics.com/definitions/kind-reduction/1";
                                    };
                                    state: "building" | "incomplete" | "ready" | "refused";
                                    phase: "declaration" | "node" | "release";
                                    steps: string;
                                    nodes: string;
                                    releases: string;
                                    declarations: string;
                                    indexed_rows: string;
                                    examined_bytes: string;
                                    missing_digest: string | null;
                                    error: string | null;
                                };
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                403: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: 'validation';
                                    code: 'validation';
                                    title: 'Validation Error';
                                    status: 422;
                                    detail?: string;
                                    on: string;
                                    found?: unknown;
                                    property?: string;
                                    expected?: unknown;
                                    errors?: {
                                        message?: string;
                                        [key: string]: unknown;
                                    }[];
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            catalogues: {
                ":root": {
                    kinds: {
                        $resolve: {
                            post: {
                                body: {
                                    ids: string[];
                                };
                                params: {
                                    root: string;
                                };
                                query: unknown;
                                headers: unknown;
                                response: {
                                    200: readonly Readonly<{
                                        id: string;
                                        value: import("@rezics/definitions").PinnedKindDeclaration | null;
                                    }>[];
                                    400: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    403: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: 'validation';
                                        code: 'validation';
                                        title: 'Validation Error';
                                        status: 422;
                                        detail?: string;
                                        on: string;
                                        found?: unknown;
                                        property?: string;
                                        expected?: unknown;
                                        errors?: {
                                            message?: string;
                                            [key: string]: unknown;
                                        }[];
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            catalogues: {
                ":root": {
                    kinds: {
                        get: {
                            body: unknown;
                            params: {
                                root: string;
                            };
                            query: {
                                query?: string;
                                language?: string;
                                limit?: string | number;
                                cursor?: string;
                            };
                            headers: unknown;
                            response: {
                                200: Readonly<{
                                    kinds: readonly import("@rezics/definitions").PinnedKindDeclaration[];
                                    next: string | null;
                                }>;
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                403: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: 'validation';
                                    code: 'validation';
                                    title: 'Validation Error';
                                    status: 422;
                                    detail?: string;
                                    on: string;
                                    found?: unknown;
                                    property?: string;
                                    expected?: unknown;
                                    errors?: {
                                        message?: string;
                                        [key: string]: unknown;
                                    }[];
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            catalogues: {
                ":root": {
                    candidates: {
                        get: {
                            body: unknown;
                            params: {
                                root: string;
                            };
                            query: {
                                exact_type_id: string;
                                limit?: string | number;
                                cursor?: string;
                            };
                            headers: unknown;
                            response: {
                                200: Readonly<{
                                    candidates: readonly import("@rezics/definitions").PinnedKindDeclaration[];
                                    next: string | null;
                                }>;
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                403: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: 'validation';
                                    code: 'validation';
                                    title: 'Validation Error';
                                    status: 422;
                                    detail?: string;
                                    on: string;
                                    found?: unknown;
                                    property?: string;
                                    expected?: unknown;
                                    errors?: {
                                        message?: string;
                                        [key: string]: unknown;
                                    }[];
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            imports: {
                post: {
                    body: import("../semantic/definition-import.ts").DefinitionImportRequest;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: import("../semantic/definition-import.ts").ImportedPreview;
                        400: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        401: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        403: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        404: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        422: Response | {
                            type: 'validation';
                            code: 'validation';
                            title: 'Validation Error';
                            status: 422;
                            detail?: string;
                            on: string;
                            found?: unknown;
                            property?: string;
                            expected?: unknown;
                            errors?: {
                                message?: string;
                                [key: string]: unknown;
                            }[];
                        };
                        503: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                post: {
                    body: {
                        release: Record<string, any>;
                    };
                    params: {};
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            digest: string;
                        };
                        201: {
                            digest: string;
                        };
                        400: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        401: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        403: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        422: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        503: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    get: {
                        body: unknown;
                        params: {
                            digest: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                digest: string;
                                release: Record<string, any>;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: unknown;
                                errors?: {
                                    message?: string;
                                    [key: string]: unknown;
                                }[];
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            active: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            digest: string;
                            head: number;
                        };
                        401: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        404: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                        503: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail: unknown;
                            errors: unknown;
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    $activate: {
                        post: {
                            body: {
                                expected_head: number | null;
                            };
                            params: {
                                digest: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    digest: string;
                                    head: number;
                                };
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                403: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                409: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        contexts: {
            ":id": {
                definitions: {
                    extensions: {
                        post: {
                            body: {
                                extension: Record<string, any>;
                            };
                            params: {
                                id: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    digest: string;
                                };
                                201: {
                                    digest: string;
                                };
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                403: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        contexts: {
            ":id": {
                definitions: {
                    extensions: {
                        ":digest": {
                            $activate: {
                                post: {
                                    body: {
                                        expected_head: number | null;
                                    };
                                    params: {
                                        id: string;
                                        digest: string;
                                    };
                                    query: unknown;
                                    headers: {
                                        "idempotency-key": string;
                                    };
                                    response: {
                                        200: {
                                            digest: string;
                                            head: number;
                                        };
                                        400: Response | {
                                            type: unknown;
                                            title: unknown;
                                            status: number;
                                            code: unknown;
                                            retryable: unknown;
                                            effect_status: "not_applicable" | "not_applied";
                                            request_id: string;
                                            detail: unknown;
                                            errors: unknown;
                                        };
                                        401: Response | {
                                            type: unknown;
                                            title: unknown;
                                            status: number;
                                            code: unknown;
                                            retryable: unknown;
                                            effect_status: "not_applicable" | "not_applied";
                                            request_id: string;
                                            detail: unknown;
                                            errors: unknown;
                                        };
                                        403: Response | {
                                            type: unknown;
                                            title: unknown;
                                            status: number;
                                            code: unknown;
                                            retryable: unknown;
                                            effect_status: "not_applicable" | "not_applied";
                                            request_id: string;
                                            detail: unknown;
                                            errors: unknown;
                                        };
                                        404: Response | {
                                            type: unknown;
                                            title: unknown;
                                            status: number;
                                            code: unknown;
                                            retryable: unknown;
                                            effect_status: "not_applicable" | "not_applied";
                                            request_id: string;
                                            detail: unknown;
                                            errors: unknown;
                                        };
                                        409: Response | {
                                            type: unknown;
                                            title: unknown;
                                            status: number;
                                            code: unknown;
                                            retryable: unknown;
                                            effect_status: "not_applicable" | "not_applied";
                                            request_id: string;
                                            detail: unknown;
                                            errors: unknown;
                                        };
                                        422: Response | {
                                            type: unknown;
                                            title: unknown;
                                            status: number;
                                            code: unknown;
                                            retryable: unknown;
                                            effect_status: "not_applicable" | "not_applied";
                                            request_id: string;
                                            detail: unknown;
                                            errors: unknown;
                                        };
                                        503: Response | {
                                            type: unknown;
                                            title: unknown;
                                            status: number;
                                            code: unknown;
                                            retryable: unknown;
                                            effect_status: "not_applicable" | "not_applied";
                                            request_id: string;
                                            detail: unknown;
                                            errors: unknown;
                                        };
                                    };
                                    error: never;
                                };
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        contexts: {
            ":id": {
                definitions: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                context: string;
                                digest: string | null;
                                head: number;
                                extension: Record<string, any> | null;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: unknown;
                                errors?: {
                                    message?: string;
                                    [key: string]: unknown;
                                }[];
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        contexts: {
            ":id": {
                definitions: {
                    extensions: {
                        ":digest": {
                            get: {
                                body: unknown;
                                params: {
                                    id: string;
                                    digest: string;
                                };
                                query: unknown;
                                headers: unknown;
                                response: {
                                    200: {
                                        digest: string;
                                        extension: Record<string, any>;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: 'validation';
                                        code: 'validation';
                                        title: 'Validation Error';
                                        status: 422;
                                        detail?: string;
                                        on: string;
                                        found?: unknown;
                                        property?: string;
                                        expected?: unknown;
                                        errors?: {
                                            message?: string;
                                            [key: string]: unknown;
                                        }[];
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                "source-statistics": {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                source: "bangumi" | "vndb";
                                observation?: {
                                    kind: "unversioned";
                                    digest: string;
                                };
                                sourceAlias?: string;
                                sourceRecordId: string;
                                figures?: {
                                    schemaVersion: 1;
                                    distribution?: {
                                        unit: "ratings";
                                        completeness: "complete" | "partial";
                                        bins: {
                                            score: number;
                                            count: number;
                                        }[];
                                    };
                                    rank?: {
                                        unit: "subjects";
                                        position: number;
                                        population?: number;
                                    };
                                };
                                scale: {
                                    min: number;
                                    max: number;
                                };
                                mean: number;
                                count: number;
                                asOf: string;
                                licence: string;
                                attribution: string;
                            }[];
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            401: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            403: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            404: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            409: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                            503: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail: unknown;
                                errors: unknown;
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                "source-statistics": {
                    ":source": {
                        put: {
                            body: {
                                expectedObservation?: string | null;
                                sourceAlias?: string;
                                sourceRecordId: string;
                                figures?: {
                                    schemaVersion: 1;
                                    distribution?: {
                                        unit: "ratings";
                                        completeness: "complete" | "partial";
                                        bins: {
                                            score: number;
                                            count: number;
                                        }[];
                                    };
                                    rank?: {
                                        unit: "subjects";
                                        position: number;
                                        population?: number;
                                    };
                                };
                                scale: {
                                    min: number;
                                    max: number;
                                };
                                mean: number;
                                count: number;
                                asOf: string;
                                licence: string;
                                attribution: string;
                            };
                            params: {
                                id: string;
                                source: "bangumi" | "vndb";
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    source: "bangumi" | "vndb";
                                    observation?: {
                                        kind: "unversioned";
                                        digest: string;
                                    };
                                    sourceAlias?: string;
                                    sourceRecordId: string;
                                    figures?: {
                                        schemaVersion: 1;
                                        distribution?: {
                                            unit: "ratings";
                                            completeness: "complete" | "partial";
                                            bins: {
                                                score: number;
                                                count: number;
                                            }[];
                                        };
                                        rank?: {
                                            unit: "subjects";
                                            position: number;
                                            population?: number;
                                        };
                                    };
                                    scale: {
                                        min: number;
                                        max: number;
                                    };
                                    mean: number;
                                    count: number;
                                    asOf: string;
                                    licence: string;
                                    attribution: string;
                                };
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                401: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                403: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                404: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                409: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                503: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                "source-statistics": {
                    ":source": {
                        $clear: {
                            post: {
                                body: {
                                    expectedObservation?: string | null;
                                    sourceAlias?: string;
                                    sourceRecordId: string;
                                    count: 0;
                                    asOf: string;
                                };
                                params: {
                                    id: string;
                                    source: "bangumi" | "vndb";
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    204: void;
                                    400: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    401: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    403: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    404: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    409: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    422: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                    503: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "not_applicable" | "not_applied";
                                        request_id: string;
                                        detail: unknown;
                                        errors: unknown;
                                    };
                                };
                                error: never;
                            };
                        };
                    };
                };
            };
        };
    };
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").AccountActor | {
            kind: 'anonymous';
        };
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "get", "/v1/subjects/:id/source-statistics/:source/observations", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        id: import("typebox").TString;
        source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
    }>;
    query: import("typebox").TObject<{
        digest: import("typebox").TOptional<import("typebox").TString>;
        cursor: import("typebox").TOptional<import("typebox").TString>;
        history: import("typebox").TOptional<import("typebox").TLiteral<"true">>;
    }>;
    response: {
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        403: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        409: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        422: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
            head: import("typebox").TObject<{
                digest: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"empty">, import("typebox").TLiteral<"published">, import("typebox").TLiteral<"cleared">]>;
                observation: import("typebox").TUnion<[import("typebox").TObject<{
                    digest: import("typebox").TString;
                    payloadVersion: import("typebox").TLiteral<1>;
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    asOf: import("typebox").TString;
                    nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    legacy: import("typebox").TBoolean;
                    provenance: import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>;
                    payload: import("typebox").TUnion<[import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        scale: import("typebox").TObject<{
                            min: import("typebox").TInteger;
                            max: import("typebox").TInteger;
                        }>;
                        mean: import("typebox").TNumber;
                        figures: import("typebox").TOptional<import("typebox").TObject<{
                            schemaVersion: import("typebox").TLiteral<1>;
                            distribution: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"ratings">;
                                completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                bins: import("typebox").TArray<import("typebox").TObject<{
                                    score: import("typebox").TInteger;
                                    count: import("typebox").TInteger;
                                }>>;
                            }>>;
                            rank: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"subjects">;
                                position: import("typebox").TInteger;
                                population: import("typebox").TOptional<import("typebox").TInteger>;
                            }>>;
                        }>>;
                        count: import("typebox").TInteger;
                        asOf: import("typebox").TString;
                        licence: import("typebox").TString;
                        attribution: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        count: import("typebox").TLiteral<0>;
                        asOf: import("typebox").TString;
                    }>]>;
                }>, import("typebox").TNull]>;
            }>;
            resolution: import("typebox").TObject<{
                put: import("typebox").TObject<{
                    expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
                clear: import("typebox").TObject<{
                    expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
            }>;
            selectedObservation: import("typebox").TOptional<import("typebox").TObject<{
                digest: import("typebox").TString;
                payloadVersion: import("typebox").TLiteral<1>;
                sourceAlias: import("typebox").TString;
                sourceRecordId: import("typebox").TString;
                asOf: import("typebox").TString;
                nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                legacy: import("typebox").TBoolean;
                provenance: import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"unversioned">;
                    digest: import("typebox").TString;
                }>;
                payload: import("typebox").TUnion<[import("typebox").TObject<{
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                    }>;
                    mean: import("typebox").TNumber;
                    figures: import("typebox").TOptional<import("typebox").TObject<{
                        schemaVersion: import("typebox").TLiteral<1>;
                        distribution: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"ratings">;
                            completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                            bins: import("typebox").TArray<import("typebox").TObject<{
                                score: import("typebox").TInteger;
                                count: import("typebox").TInteger;
                            }>>;
                        }>>;
                        rank: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"subjects">;
                            position: import("typebox").TInteger;
                            population: import("typebox").TOptional<import("typebox").TInteger>;
                        }>>;
                    }>>;
                    count: import("typebox").TInteger;
                    asOf: import("typebox").TString;
                    licence: import("typebox").TString;
                    attribution: import("typebox").TString;
                }>, import("typebox").TObject<{
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    count: import("typebox").TLiteral<0>;
                    asOf: import("typebox").TString;
                }>]>;
            }>>;
            history: import("typebox").TOptional<import("typebox").TObject<{
                items: import("typebox").TArray<import("typebox").TObject<{
                    digest: import("typebox").TString;
                    payloadVersion: import("typebox").TLiteral<1>;
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    asOf: import("typebox").TString;
                    nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    legacy: import("typebox").TBoolean;
                    provenance: import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>;
                    payload: import("typebox").TUnion<[import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        scale: import("typebox").TObject<{
                            min: import("typebox").TInteger;
                            max: import("typebox").TInteger;
                        }>;
                        mean: import("typebox").TNumber;
                        figures: import("typebox").TOptional<import("typebox").TObject<{
                            schemaVersion: import("typebox").TLiteral<1>;
                            distribution: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"ratings">;
                                completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                bins: import("typebox").TArray<import("typebox").TObject<{
                                    score: import("typebox").TInteger;
                                    count: import("typebox").TInteger;
                                }>>;
                            }>>;
                            rank: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"subjects">;
                                position: import("typebox").TInteger;
                                population: import("typebox").TOptional<import("typebox").TInteger>;
                            }>>;
                        }>>;
                        count: import("typebox").TInteger;
                        asOf: import("typebox").TString;
                        licence: import("typebox").TString;
                        attribution: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        count: import("typebox").TLiteral<0>;
                        asOf: import("typebox").TString;
                    }>]>;
                }>>;
                nextCursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        'x-exposure': string;
        security: {
            bearerAuth: never[];
        }[];
        'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
    };
}, {}, "/v1/subjects/:id/source-statistics/:source/observations">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ actor, params, query, authorizeCommand, admission, job }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        403: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        409: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        422: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        200: {
            source: "bangumi" | "vndb";
            head: {
                digest: string | null;
                state: "cleared" | "empty" | "published";
                observation: {
                    digest: string;
                    payloadVersion: 1;
                    sourceAlias: string;
                    sourceRecordId: string;
                    asOf: string;
                    nativeOrder: string | null;
                    legacy: boolean;
                    provenance: {
                        kind: "unversioned";
                        digest: string;
                    };
                    payload: {
                        sourceAlias: string;
                        sourceRecordId: string;
                        scale: {
                            min: number;
                            max: number;
                        };
                        mean: number;
                        figures?: {
                            schemaVersion: 1;
                            distribution?: {
                                unit: "ratings";
                                completeness: "complete" | "partial";
                                bins: {
                                    score: number;
                                    count: number;
                                }[];
                            };
                            rank?: {
                                unit: "subjects";
                                position: number;
                                population?: number;
                            };
                        };
                        count: number;
                        asOf: string;
                        licence: string;
                        attribution: string;
                    } | {
                        sourceAlias: string;
                        sourceRecordId: string;
                        count: 0;
                        asOf: string;
                    };
                } | null;
            };
            resolution: {
                put: {
                    expectedObservation: string | null;
                };
                clear: {
                    expectedObservation: string | null;
                };
            };
            selectedObservation?: {
                digest: string;
                payloadVersion: 1;
                sourceAlias: string;
                sourceRecordId: string;
                asOf: string;
                nativeOrder: string | null;
                legacy: boolean;
                provenance: {
                    kind: "unversioned";
                    digest: string;
                };
                payload: {
                    sourceAlias: string;
                    sourceRecordId: string;
                    scale: {
                        min: number;
                        max: number;
                    };
                    mean: number;
                    figures?: {
                        schemaVersion: 1;
                        distribution?: {
                            unit: "ratings";
                            completeness: "complete" | "partial";
                            bins: {
                                score: number;
                                count: number;
                            }[];
                        };
                        rank?: {
                            unit: "subjects";
                            position: number;
                            population?: number;
                        };
                    };
                    count: number;
                    asOf: string;
                    licence: string;
                    attribution: string;
                } | {
                    sourceAlias: string;
                    sourceRecordId: string;
                    count: 0;
                    asOf: string;
                };
            };
            history?: {
                items: {
                    digest: string;
                    payloadVersion: 1;
                    sourceAlias: string;
                    sourceRecordId: string;
                    asOf: string;
                    nativeOrder: string | null;
                    legacy: boolean;
                    provenance: {
                        kind: "unversioned";
                        digest: string;
                    };
                    payload: {
                        sourceAlias: string;
                        sourceRecordId: string;
                        scale: {
                            min: number;
                            max: number;
                        };
                        mean: number;
                        figures?: {
                            schemaVersion: 1;
                            distribution?: {
                                unit: "ratings";
                                completeness: "complete" | "partial";
                                bins: {
                                    score: number;
                                    count: number;
                                }[];
                            };
                            rank?: {
                                unit: "subjects";
                                position: number;
                                population?: number;
                            };
                        };
                        count: number;
                        asOf: string;
                        licence: string;
                        attribution: string;
                    } | {
                        sourceAlias: string;
                        sourceRecordId: string;
                        count: 0;
                        asOf: string;
                    };
                }[];
                nextCursor: string | null;
            };
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        403: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        409: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        422: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        200: {
            source: "bangumi" | "vndb";
            head: {
                digest: string | null;
                state: "cleared" | "empty" | "published";
                observation: {
                    digest: string;
                    payloadVersion: 1;
                    sourceAlias: string;
                    sourceRecordId: string;
                    asOf: string;
                    nativeOrder: string | null;
                    legacy: boolean;
                    provenance: {
                        kind: "unversioned";
                        digest: string;
                    };
                    payload: {
                        sourceAlias: string;
                        sourceRecordId: string;
                        scale: {
                            min: number;
                            max: number;
                        };
                        mean: number;
                        figures?: {
                            schemaVersion: 1;
                            distribution?: {
                                unit: "ratings";
                                completeness: "complete" | "partial";
                                bins: {
                                    score: number;
                                    count: number;
                                }[];
                            };
                            rank?: {
                                unit: "subjects";
                                position: number;
                                population?: number;
                            };
                        };
                        count: number;
                        asOf: string;
                        licence: string;
                        attribution: string;
                    } | {
                        sourceAlias: string;
                        sourceRecordId: string;
                        count: 0;
                        asOf: string;
                    };
                } | null;
            };
            resolution: {
                put: {
                    expectedObservation: string | null;
                };
                clear: {
                    expectedObservation: string | null;
                };
            };
            selectedObservation?: {
                digest: string;
                payloadVersion: 1;
                sourceAlias: string;
                sourceRecordId: string;
                asOf: string;
                nativeOrder: string | null;
                legacy: boolean;
                provenance: {
                    kind: "unversioned";
                    digest: string;
                };
                payload: {
                    sourceAlias: string;
                    sourceRecordId: string;
                    scale: {
                        min: number;
                        max: number;
                    };
                    mean: number;
                    figures?: {
                        schemaVersion: 1;
                        distribution?: {
                            unit: "ratings";
                            completeness: "complete" | "partial";
                            bins: {
                                score: number;
                                count: number;
                            }[];
                        };
                        rank?: {
                            unit: "subjects";
                            position: number;
                            population?: number;
                        };
                    };
                    count: number;
                    asOf: string;
                    licence: string;
                    attribution: string;
                } | {
                    sourceAlias: string;
                    sourceRecordId: string;
                    count: 0;
                    asOf: string;
                };
            };
            history?: {
                items: {
                    digest: string;
                    payloadVersion: 1;
                    sourceAlias: string;
                    sourceRecordId: string;
                    asOf: string;
                    nativeOrder: string | null;
                    legacy: boolean;
                    provenance: {
                        kind: "unversioned";
                        digest: string;
                    };
                    payload: {
                        sourceAlias: string;
                        sourceRecordId: string;
                        scale: {
                            min: number;
                            max: number;
                        };
                        mean: number;
                        figures?: {
                            schemaVersion: 1;
                            distribution?: {
                                unit: "ratings";
                                completeness: "complete" | "partial";
                                bins: {
                                    score: number;
                                    count: number;
                                }[];
                            };
                            rank?: {
                                unit: "subjects";
                                position: number;
                                population?: number;
                            };
                        };
                        count: number;
                        asOf: string;
                        licence: string;
                        attribution: string;
                    } | {
                        sourceAlias: string;
                        sourceRecordId: string;
                        count: 0;
                        asOf: string;
                    };
                }[];
                nextCursor: string | null;
            };
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            id: import("typebox").TString;
            source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
        }>;
        query: import("typebox").TObject<{
            digest: import("typebox").TOptional<import("typebox").TString>;
            cursor: import("typebox").TOptional<import("typebox").TString>;
            history: import("typebox").TOptional<import("typebox").TLiteral<"true">>;
        }>;
        response: {
            401: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            403: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            404: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            409: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            422: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            400: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            200: import("typebox").TObject<{
                source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
                head: import("typebox").TObject<{
                    digest: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"empty">, import("typebox").TLiteral<"published">, import("typebox").TLiteral<"cleared">]>;
                    observation: import("typebox").TUnion<[import("typebox").TObject<{
                        digest: import("typebox").TString;
                        payloadVersion: import("typebox").TLiteral<1>;
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        asOf: import("typebox").TString;
                        nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        legacy: import("typebox").TBoolean;
                        provenance: import("typebox").TObject<{
                            kind: import("typebox").TLiteral<"unversioned">;
                            digest: import("typebox").TString;
                        }>;
                        payload: import("typebox").TUnion<[import("typebox").TObject<{
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                            }>;
                            mean: import("typebox").TNumber;
                            figures: import("typebox").TOptional<import("typebox").TObject<{
                                schemaVersion: import("typebox").TLiteral<1>;
                                distribution: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"ratings">;
                                    completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                    bins: import("typebox").TArray<import("typebox").TObject<{
                                        score: import("typebox").TInteger;
                                        count: import("typebox").TInteger;
                                    }>>;
                                }>>;
                                rank: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"subjects">;
                                    position: import("typebox").TInteger;
                                    population: import("typebox").TOptional<import("typebox").TInteger>;
                                }>>;
                            }>>;
                            count: import("typebox").TInteger;
                            asOf: import("typebox").TString;
                            licence: import("typebox").TString;
                            attribution: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            count: import("typebox").TLiteral<0>;
                            asOf: import("typebox").TString;
                        }>]>;
                    }>, import("typebox").TNull]>;
                }>;
                resolution: import("typebox").TObject<{
                    put: import("typebox").TObject<{
                        expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    }>;
                    clear: import("typebox").TObject<{
                        expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    }>;
                }>;
                selectedObservation: import("typebox").TOptional<import("typebox").TObject<{
                    digest: import("typebox").TString;
                    payloadVersion: import("typebox").TLiteral<1>;
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    asOf: import("typebox").TString;
                    nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    legacy: import("typebox").TBoolean;
                    provenance: import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>;
                    payload: import("typebox").TUnion<[import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        scale: import("typebox").TObject<{
                            min: import("typebox").TInteger;
                            max: import("typebox").TInteger;
                        }>;
                        mean: import("typebox").TNumber;
                        figures: import("typebox").TOptional<import("typebox").TObject<{
                            schemaVersion: import("typebox").TLiteral<1>;
                            distribution: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"ratings">;
                                completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                bins: import("typebox").TArray<import("typebox").TObject<{
                                    score: import("typebox").TInteger;
                                    count: import("typebox").TInteger;
                                }>>;
                            }>>;
                            rank: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"subjects">;
                                position: import("typebox").TInteger;
                                population: import("typebox").TOptional<import("typebox").TInteger>;
                            }>>;
                        }>>;
                        count: import("typebox").TInteger;
                        asOf: import("typebox").TString;
                        licence: import("typebox").TString;
                        attribution: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        count: import("typebox").TLiteral<0>;
                        asOf: import("typebox").TString;
                    }>]>;
                }>>;
                history: import("typebox").TOptional<import("typebox").TObject<{
                    items: import("typebox").TArray<import("typebox").TObject<{
                        digest: import("typebox").TString;
                        payloadVersion: import("typebox").TLiteral<1>;
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        asOf: import("typebox").TString;
                        nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        legacy: import("typebox").TBoolean;
                        provenance: import("typebox").TObject<{
                            kind: import("typebox").TLiteral<"unversioned">;
                            digest: import("typebox").TString;
                        }>;
                        payload: import("typebox").TUnion<[import("typebox").TObject<{
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                            }>;
                            mean: import("typebox").TNumber;
                            figures: import("typebox").TOptional<import("typebox").TObject<{
                                schemaVersion: import("typebox").TLiteral<1>;
                                distribution: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"ratings">;
                                    completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                    bins: import("typebox").TArray<import("typebox").TObject<{
                                        score: import("typebox").TInteger;
                                        count: import("typebox").TInteger;
                                    }>>;
                                }>>;
                                rank: import("typebox").TOptional<import("typebox").TObject<{
                                    unit: import("typebox").TLiteral<"subjects">;
                                    position: import("typebox").TInteger;
                                    population: import("typebox").TOptional<import("typebox").TInteger>;
                                }>>;
                            }>>;
                            count: import("typebox").TInteger;
                            asOf: import("typebox").TString;
                            licence: import("typebox").TString;
                            attribution: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            count: import("typebox").TLiteral<0>;
                            asOf: import("typebox").TString;
                        }>]>;
                    }>>;
                    nextCursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-action': string;
            'x-exposure': string;
            security: {
                bearerAuth: never[];
            }[];
            'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        };
    }, {}, "/v1/subjects/:id/source-statistics/:source/observations">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("../http/admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").AccountActor | {
                kind: 'anonymous';
            };
            readonly session: {
                readonly components: import("../tokens/session.ts").SessionComponent[];
                record(component: import("../tokens/session.ts").SessionComponent): void;
            };
            readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: {
        digest?: string;
        cursor?: string;
        history?: "true";
    };
    params: {
        id: string;
        source: "bangumi" | "vndb";
    };
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("../http/admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").AccountActor | {
        kind: 'anonymous';
    };
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    source: "bangumi" | "vndb";
    head: {
        digest: string | null;
        state: "cleared" | "empty" | "published";
        observation: {
            digest: string;
            payloadVersion: 1;
            sourceAlias: string;
            sourceRecordId: string;
            asOf: string;
            nativeOrder: string | null;
            legacy: boolean;
            provenance: {
                kind: "unversioned";
                digest: string;
            };
            payload: {
                sourceAlias: string;
                sourceRecordId: string;
                scale: {
                    min: number;
                    max: number;
                };
                mean: number;
                figures?: {
                    schemaVersion: 1;
                    distribution?: {
                        unit: "ratings";
                        completeness: "complete" | "partial";
                        bins: {
                            score: number;
                            count: number;
                        }[];
                    };
                    rank?: {
                        unit: "subjects";
                        position: number;
                        population?: number;
                    };
                };
                count: number;
                asOf: string;
                licence: string;
                attribution: string;
            } | {
                sourceAlias: string;
                sourceRecordId: string;
                count: 0;
                asOf: string;
            };
        } | null;
    };
    resolution: {
        put: {
            expectedObservation: string | null;
        };
        clear: {
            expectedObservation: string | null;
        };
    };
    selectedObservation?: {
        digest: string;
        payloadVersion: 1;
        sourceAlias: string;
        sourceRecordId: string;
        asOf: string;
        nativeOrder: string | null;
        legacy: boolean;
        provenance: {
            kind: "unversioned";
            digest: string;
        };
        payload: {
            sourceAlias: string;
            sourceRecordId: string;
            scale: {
                min: number;
                max: number;
            };
            mean: number;
            figures?: {
                schemaVersion: 1;
                distribution?: {
                    unit: "ratings";
                    completeness: "complete" | "partial";
                    bins: {
                        score: number;
                        count: number;
                    }[];
                };
                rank?: {
                    unit: "subjects";
                    position: number;
                    population?: number;
                };
            };
            count: number;
            asOf: string;
            licence: string;
            attribution: string;
        } | {
            sourceAlias: string;
            sourceRecordId: string;
            count: 0;
            asOf: string;
        };
    };
    history?: {
        items: {
            digest: string;
            payloadVersion: 1;
            sourceAlias: string;
            sourceRecordId: string;
            asOf: string;
            nativeOrder: string | null;
            legacy: boolean;
            provenance: {
                kind: "unversioned";
                digest: string;
            };
            payload: {
                sourceAlias: string;
                sourceRecordId: string;
                scale: {
                    min: number;
                    max: number;
                };
                mean: number;
                figures?: {
                    schemaVersion: 1;
                    distribution?: {
                        unit: "ratings";
                        completeness: "complete" | "partial";
                        bins: {
                            score: number;
                            count: number;
                        }[];
                    };
                    rank?: {
                        unit: "subjects";
                        position: number;
                        population?: number;
                    };
                };
                count: number;
                asOf: string;
                licence: string;
                attribution: string;
            } | {
                sourceAlias: string;
                sourceRecordId: string;
                count: 0;
                asOf: string;
            };
        }[];
        nextCursor: string | null;
    };
}>, {
    params: import("typebox").TObject<{
        id: import("typebox").TString;
        source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
    }>;
    query: import("typebox").TObject<{
        digest: import("typebox").TOptional<import("typebox").TString>;
        cursor: import("typebox").TOptional<import("typebox").TString>;
        history: import("typebox").TOptional<import("typebox").TLiteral<"true">>;
    }>;
    response: {
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        403: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        409: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        422: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            source: import("typebox").TUnion<[import("typebox").TLiteral<"vndb">, import("typebox").TLiteral<"bangumi">]>;
            head: import("typebox").TObject<{
                digest: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"empty">, import("typebox").TLiteral<"published">, import("typebox").TLiteral<"cleared">]>;
                observation: import("typebox").TUnion<[import("typebox").TObject<{
                    digest: import("typebox").TString;
                    payloadVersion: import("typebox").TLiteral<1>;
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    asOf: import("typebox").TString;
                    nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    legacy: import("typebox").TBoolean;
                    provenance: import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>;
                    payload: import("typebox").TUnion<[import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        scale: import("typebox").TObject<{
                            min: import("typebox").TInteger;
                            max: import("typebox").TInteger;
                        }>;
                        mean: import("typebox").TNumber;
                        figures: import("typebox").TOptional<import("typebox").TObject<{
                            schemaVersion: import("typebox").TLiteral<1>;
                            distribution: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"ratings">;
                                completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                bins: import("typebox").TArray<import("typebox").TObject<{
                                    score: import("typebox").TInteger;
                                    count: import("typebox").TInteger;
                                }>>;
                            }>>;
                            rank: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"subjects">;
                                position: import("typebox").TInteger;
                                population: import("typebox").TOptional<import("typebox").TInteger>;
                            }>>;
                        }>>;
                        count: import("typebox").TInteger;
                        asOf: import("typebox").TString;
                        licence: import("typebox").TString;
                        attribution: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        count: import("typebox").TLiteral<0>;
                        asOf: import("typebox").TString;
                    }>]>;
                }>, import("typebox").TNull]>;
            }>;
            resolution: import("typebox").TObject<{
                put: import("typebox").TObject<{
                    expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
                clear: import("typebox").TObject<{
                    expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
            }>;
            selectedObservation: import("typebox").TOptional<import("typebox").TObject<{
                digest: import("typebox").TString;
                payloadVersion: import("typebox").TLiteral<1>;
                sourceAlias: import("typebox").TString;
                sourceRecordId: import("typebox").TString;
                asOf: import("typebox").TString;
                nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                legacy: import("typebox").TBoolean;
                provenance: import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"unversioned">;
                    digest: import("typebox").TString;
                }>;
                payload: import("typebox").TUnion<[import("typebox").TObject<{
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                    }>;
                    mean: import("typebox").TNumber;
                    figures: import("typebox").TOptional<import("typebox").TObject<{
                        schemaVersion: import("typebox").TLiteral<1>;
                        distribution: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"ratings">;
                            completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                            bins: import("typebox").TArray<import("typebox").TObject<{
                                score: import("typebox").TInteger;
                                count: import("typebox").TInteger;
                            }>>;
                        }>>;
                        rank: import("typebox").TOptional<import("typebox").TObject<{
                            unit: import("typebox").TLiteral<"subjects">;
                            position: import("typebox").TInteger;
                            population: import("typebox").TOptional<import("typebox").TInteger>;
                        }>>;
                    }>>;
                    count: import("typebox").TInteger;
                    asOf: import("typebox").TString;
                    licence: import("typebox").TString;
                    attribution: import("typebox").TString;
                }>, import("typebox").TObject<{
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    count: import("typebox").TLiteral<0>;
                    asOf: import("typebox").TString;
                }>]>;
            }>>;
            history: import("typebox").TOptional<import("typebox").TObject<{
                items: import("typebox").TArray<import("typebox").TObject<{
                    digest: import("typebox").TString;
                    payloadVersion: import("typebox").TLiteral<1>;
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    asOf: import("typebox").TString;
                    nativeOrder: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    legacy: import("typebox").TBoolean;
                    provenance: import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>;
                    payload: import("typebox").TUnion<[import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        scale: import("typebox").TObject<{
                            min: import("typebox").TInteger;
                            max: import("typebox").TInteger;
                        }>;
                        mean: import("typebox").TNumber;
                        figures: import("typebox").TOptional<import("typebox").TObject<{
                            schemaVersion: import("typebox").TLiteral<1>;
                            distribution: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"ratings">;
                                completeness: import("typebox").TUnion<[import("typebox").TLiteral<"complete">, import("typebox").TLiteral<"partial">]>;
                                bins: import("typebox").TArray<import("typebox").TObject<{
                                    score: import("typebox").TInteger;
                                    count: import("typebox").TInteger;
                                }>>;
                            }>>;
                            rank: import("typebox").TOptional<import("typebox").TObject<{
                                unit: import("typebox").TLiteral<"subjects">;
                                position: import("typebox").TInteger;
                                population: import("typebox").TOptional<import("typebox").TInteger>;
                            }>>;
                        }>>;
                        count: import("typebox").TInteger;
                        asOf: import("typebox").TString;
                        licence: import("typebox").TString;
                        attribution: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        count: import("typebox").TLiteral<0>;
                        asOf: import("typebox").TString;
                    }>]>;
                }>>;
                nextCursor: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        'x-exposure': string;
        security: {
            bearerAuth: never[];
        }[];
        'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
    };
}>;
export {};
