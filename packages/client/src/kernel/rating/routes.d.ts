import type { RatingCapabilities } from './contract/capabilities.ts';
import type { Pool } from 'pg';
import { type Access } from './dependencies.ts';
import type { KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
type Dependencies = {
    pool: Pool;
    access: () => Access;
    tokens: KeyRing;
    routeKey: Uint8Array;
    capabilities?: RatingCapabilities;
    clock?: KernelClock;
    deadlineNow?: () => number;
};
/** Private account-owned vote transport. Commands remain responsible for partition ownership and current account state. */
/** HTTP registrations are data; composition inspects these before mounting handlers. */
export declare function ratingRouteDeclarations(): {
    route1: {
        method: 'GET';
        path: '/v1/me/rating-votes';
        options: {
            query: import("typebox").TObject<{
                cursor: import("typebox").TOptional<import("typebox").TString>;
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
                    viewer: import("typebox").TObject<{
                        accountId: import("typebox").TString;
                    }>;
                    votes: import("typebox").TArray<import("typebox").TObject<{
                        targetId: import("typebox").TString;
                        questionId: import("typebox").TString;
                        subject: import("typebox").TObject<{
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
                        }>;
                        subjectHref: import("typebox").TString;
                        question: import("typebox").TObject<{
                            id: import("typebox").TString;
                            revision: import("typebox").TInteger;
                            realmId: import("typebox").TOptional<import("typebox").TString>;
                            canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                            labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                            meaning: import("typebox").TOptional<import("typebox").TString>;
                            label: import("typebox").TString;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                                revision: import("typebox").TInteger;
                            }>>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
                        }>;
                        own: import("typebox").TObject<{
                            units: import("typebox").TInteger;
                            revision: import("typebox").TInteger;
                            at: import("typebox").TString;
                        }>;
                        actions: import("typebox").TUnion<[import("typebox").TObject<{
                            state: import("typebox").TLiteral<"editable">;
                            put: import("typebox").TString;
                            clear: import("typebox").TString;
                            readback: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            state: import("typebox").TLiteral<"retired">;
                            reason: import("typebox").TLiteral<"question_retired">;
                            clear: import("typebox").TString;
                            readback: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            state: import("typebox").TLiteral<"unavailable">;
                            reason: import("typebox").TUnion<[import("typebox").TLiteral<"merged_source">, import("typebox").TLiteral<"identity_pending">, import("typebox").TLiteral<"read_only">]>;
                        }>]>;
                    }>>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
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
    route2: {
        method: 'GET';
        path: '/v1/me/classification-assessments';
        options: {
            query: import("typebox").TObject<{
                cursor: import("typebox").TOptional<import("typebox").TString>;
                selectedSubjectId: import("typebox").TOptional<import("typebox").TString>;
                selectedAssociationId: import("typebox").TOptional<import("typebox").TString>;
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
                200: import("typebox").TObject<{
                    viewer: import("typebox").TObject<{
                        accountId: import("typebox").TString;
                    }>;
                    inventory: import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"current-retained">;
                        complete: import("typebox").TLiteral<false>;
                        generation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        cleanup: import("typebox").TUnion<[import("typebox").TLiteral<"not-started">, import("typebox").TLiteral<"pending">, import("typebox").TLiteral<"settled">]>;
                    }>;
                    items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                        state: import("typebox").TLiteral<"available">;
                        subjectId: import("typebox").TString;
                        associationId: import("typebox").TString;
                        subject: import("typebox").TObject<{
                            id: import("typebox").TString;
                            type: import("typebox").TString;
                            label: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            href: import("typebox").TString;
                        }>;
                        target: import("typebox").TObject<{
                            id: import("typebox").TString;
                            type: import("typebox").TString;
                            label: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            href: import("typebox").TString;
                        }>;
                        association: import("typebox").TObject<{
                            subjectId: import("typebox").TString;
                            associationId: import("typebox").TString;
                            slotId: import("typebox").TString;
                            property: import("typebox").TString;
                            targetId: import("typebox").TString;
                            contextId: import("typebox").TLiteral<"00000000-0000-8000-8000-000000000000">;
                            origin: import("typebox").TLiteral<"global">;
                            release: import("typebox").TString;
                            revision: import("typebox").TInteger;
                            bindingHash: import("typebox").TString;
                            statementDigest: import("typebox").TString;
                            qualifiersDigest: import("typebox").TString;
                        }>;
                        own: import("typebox").TObject<{
                            assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">]>;
                            falsePositive: import("typebox").TBoolean;
                            revision: import("typebox").TString;
                            pending: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"pending">, import("typebox").TLiteral<"unknown">]>;
                        }>;
                        aggregate: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TObject<{
                            associationId: import("typebox").TString;
                            pending: import("typebox").TLiteral<"unknown">;
                            state: import("typebox").TLiteral<"suppressed">;
                        }>, import("typebox").TObject<{
                            associationId: import("typebox").TString;
                            pending: import("typebox").TLiteral<"unknown">;
                            state: import("typebox").TLiteral<"published">;
                            supportCount: import("typebox").TInteger;
                            opposeCount: import("typebox").TInteger;
                            falsePositiveCount: import("typebox").TInteger;
                            supportFraction: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
                            asOf: import("typebox").TString;
                            generation: import("typebox").TString;
                        }>]>, import("typebox").TNull]>;
                        actions: import("typebox").TObject<{
                            state: import("typebox").TUnion<[import("typebox").TLiteral<"editable">, import("typebox").TLiteral<"read-only">, import("typebox").TLiteral<"withdraw-only">, import("typebox").TLiteral<"withheld">]>;
                            readback: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            set: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            clear: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"withheld">;
                        subjectId: import("typebox").TString;
                        associationId: import("typebox").TString;
                        subject: import("typebox").TNull;
                        target: import("typebox").TNull;
                        association: import("typebox").TNull;
                        own: import("typebox").TObject<{
                            assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">]>;
                            falsePositive: import("typebox").TBoolean;
                            revision: import("typebox").TString;
                            pending: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"pending">, import("typebox").TLiteral<"unknown">]>;
                        }>;
                        aggregate: import("typebox").TNull;
                        actions: import("typebox").TObject<{
                            state: import("typebox").TUnion<[import("typebox").TLiteral<"editable">, import("typebox").TLiteral<"read-only">, import("typebox").TLiteral<"withdraw-only">, import("typebox").TLiteral<"withheld">]>;
                            readback: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            set: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            clear: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>;
                    }>]>>;
                    traversal: import("typebox").TUnion<[import("typebox").TLiteral<"more">, import("typebox").TLiteral<"complete">]>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route3: {
        method: 'GET';
        path: '/v1/subjects/:id/figure';
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
                    figure: import("typebox").TRef<"PublicFigure">;
                }> & {
                    headers: {
                        readonly etag: import("typebox").TString;
                        readonly 'cache-control': import("typebox").TLiteral<"no-cache">;
                    };
                };
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
    route4: {
        method: 'GET';
        path: '/v1/subjects/:id/ratings';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                question: import("typebox").TString;
                population: import("typebox").TUnion<[import("typebox").TString, import("typebox").TArray<import("typebox").TString>]>;
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
                    question: import("typebox").TString;
                    subject: import("typebox").TString;
                    figures: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                        population: import("typebox").TString;
                        count: import("typebox").TInteger;
                        freshness: import("typebox").TObject<{
                            asOf: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            updating: import("typebox").TBoolean;
                        }>;
                        mean: import("typebox").TNumber;
                        histogram: import("typebox").TArray<import("typebox").TInteger>;
                    }>, import("typebox").TObject<{
                        population: import("typebox").TString;
                        count: import("typebox").TInteger;
                        freshness: import("typebox").TObject<{
                            asOf: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            updating: import("typebox").TBoolean;
                        }>;
                        remaining: import("typebox").TInteger;
                    }>, import("typebox").TObject<{
                        population: import("typebox").TString;
                        count: import("typebox").TInteger;
                        freshness: import("typebox").TObject<{
                            asOf: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            updating: import("typebox").TBoolean;
                        }>;
                    }>]>>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
    route5: {
        method: 'GET';
        path: '/v1/subjects/:id/ratings/populations';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                question: import("typebox").TString;
                cursor: import("typebox").TOptional<import("typebox").TString>;
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
                    populations: import("typebox").TArray<import("typebox").TObject<{
                        population: import("typebox").TString;
                        count: import("typebox").TInteger;
                    }>>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
    route6: {
        method: 'PUT';
        path: '/v1/subjects/:id/ratings/:questionId/vote';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                questionId: import("typebox").TString;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
                'x-rating-observation': import("typebox").TOptional<import("typebox").TString>;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            units: number;
                        };
                        output: {
                            units: number;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            units: number;
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
                            units: import("typebox").TInteger;
                        }>;
                        output: () => import("typebox").TObject<{
                            units: import("typebox").TInteger;
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
                    units: import("typebox").TInteger;
                    revision: import("typebox").TInteger;
                    at: import("typebox").TString;
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
    route7: {
        method: 'DELETE';
        path: '/v1/subjects/:id/ratings/:questionId/vote';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                questionId: import("typebox").TString;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
                'x-rating-observation': import("typebox").TOptional<import("typebox").TString>;
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
                204: import("typebox").TVoid & {
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
    route8: {
        method: 'GET';
        path: '/v1/subjects/:id/ratings/:questionId/vote';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                questionId: import("typebox").TString;
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
                200: import("typebox").TObject<{
                    units: import("typebox").TInteger;
                    revision: import("typebox").TInteger;
                    at: import("typebox").TString;
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
    route9: {
        method: 'PUT';
        path: '/v1/subjects/:id/classification-associations/:associationId/assessment';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                associationId: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                expectedRevision: import("typebox").TOptional<import("typebox").TString>;
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
                            assessment: "oppose" | "support";
                            falsePositive: boolean;
                        };
                        output: {
                            assessment: "oppose" | "support";
                            falsePositive: boolean;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            assessment: "oppose" | "support";
                            falsePositive: boolean;
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
                            assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">]>;
                            falsePositive: import("typebox").TBoolean;
                        }>;
                        output: () => import("typebox").TObject<{
                            assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">]>;
                            falsePositive: import("typebox").TBoolean;
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
                    associationId: import("typebox").TString;
                    revision: import("typebox").TString;
                    delivery: import("typebox").TUnion<[import("typebox").TLiteral<"enqueued">, import("typebox").TLiteral<"unchanged">]>;
                }>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route10: {
        method: 'DELETE';
        path: '/v1/subjects/:id/classification-associations/:associationId/assessment';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                associationId: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                expectedRevision: import("typebox").TOptional<import("typebox").TString>;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
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
                204: import("typebox").TVoid;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route11: {
        method: 'GET';
        path: '/v1/subjects/:id/classification-associations/:associationId/assessment';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                associationId: import("typebox").TString;
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
                200: import("typebox").TObject<{
                    associationId: import("typebox").TString;
                    hasBallot: import("typebox").TBoolean;
                    assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">, import("typebox").TNull]>;
                    falsePositive: import("typebox").TBoolean;
                    revision: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    pending: import("typebox").TBoolean;
                }>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route12: {
        method: 'GET';
        path: '/v1/subjects/:id/classification-associations/:associationId/aggregate';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                associationId: import("typebox").TString;
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
                200: import("typebox").TUnion<[import("typebox").TObject<{
                    associationId: import("typebox").TString;
                    pending: import("typebox").TLiteral<"unknown">;
                    state: import("typebox").TLiteral<"suppressed">;
                }>, import("typebox").TObject<{
                    associationId: import("typebox").TString;
                    pending: import("typebox").TLiteral<"unknown">;
                    state: import("typebox").TLiteral<"published">;
                    supportCount: import("typebox").TInteger;
                    opposeCount: import("typebox").TInteger;
                    falsePositiveCount: import("typebox").TInteger;
                    supportFraction: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
                    asOf: import("typebox").TString;
                    generation: import("typebox").TString;
                }>]>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route13: {
        method: 'GET';
        path: '/v1/realms/:realmId/rating-questions/management';
        options: {
            params: import("typebox").TObject<{
                realmId: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                selectedQuestionId: import("typebox").TOptional<import("typebox").TString>;
                cursor: import("typebox").TOptional<import("typebox").TString>;
            }>;
            transform: ({ request }: {
                request: Request;
            }) => void;
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
                    viewer: import("typebox").TObject<{
                        accountId: import("typebox").TString;
                    }>;
                    realmId: import("typebox").TString;
                    directory: import("typebox").TObject<{
                        ratingQuestions: import("typebox").TArray<import("typebox").TObject<{
                            id: import("typebox").TString;
                            revision: import("typebox").TInteger;
                            label: import("typebox").TString;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            realmId: import("typebox").TString;
                            meaning: import("typebox").TString;
                            canonicalLabel: import("typebox").TString;
                            labelRevision: import("typebox").TInteger;
                            lifecycle: import("typebox").TObject<{
                                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                                revision: import("typebox").TInteger;
                            }>;
                        }>>;
                        next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    }>;
                    actions: import("typebox").TObject<{
                        create: import("typebox").TUnion<[import("typebox").TObject<{
                            method: import("typebox").TLiteral<"POST">;
                            href: import("typebox").TString;
                        }>, import("typebox").TNull]>;
                    }>;
                    selected: import("typebox").TUnion<[import("typebox").TObject<{
                        question: import("typebox").TObject<{
                            id: import("typebox").TString;
                            revision: import("typebox").TInteger;
                            label: import("typebox").TString;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            realmId: import("typebox").TString;
                            meaning: import("typebox").TString;
                            canonicalLabel: import("typebox").TString;
                            labelRevision: import("typebox").TInteger;
                            lifecycle: import("typebox").TObject<{
                                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                                revision: import("typebox").TInteger;
                            }>;
                        }>;
                        readback: import("typebox").TString;
                        history: import("typebox").TString;
                        actions: import("typebox").TObject<{
                            caption: import("typebox").TUnion<[import("typebox").TObject<{
                                method: import("typebox").TLiteral<"PUT">;
                                href: import("typebox").TString;
                                expectedLabelRevision: import("typebox").TInteger;
                            }>, import("typebox").TNull]>;
                            lifecycle: import("typebox").TUnion<[import("typebox").TObject<{
                                method: import("typebox").TLiteral<"POST">;
                                href: import("typebox").TString;
                                expectedLifecycleRevision: import("typebox").TInteger;
                            }>, import("typebox").TNull]>;
                        }>;
                    }>, import("typebox").TNull]>;
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
                'x-resource-types': string[];
            };
        };
    };
    route14: {
        method: 'POST';
        path: '/v1/realms/:realmId/rating-questions';
        options: {
            params: import("typebox").TObject<{
                realmId: import("typebox").TString;
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
                            meaning: string;
                            label: string;
                            grain: "character" | "episode" | "release" | "work";
                            scale: {
                                min: number;
                                max: number;
                                displayStep: number;
                            };
                        };
                        output: {
                            meaning: string;
                            label: string;
                            grain: "character" | "episode" | "release" | "work";
                            scale: {
                                min: number;
                                max: number;
                                displayStep: number;
                            };
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            meaning: string;
                            label: string;
                            grain: "character" | "episode" | "release" | "work";
                            scale: {
                                min: number;
                                max: number;
                                displayStep: number;
                            };
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
                            meaning: import("typebox").TString;
                            label: import("typebox").TString;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
                        }>;
                        output: () => import("typebox").TObject<{
                            meaning: import("typebox").TString;
                            label: import("typebox").TString;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
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
                201: import("typebox").TObject<{
                    id: import("typebox").TString;
                    revision: import("typebox").TInteger;
                    realmId: import("typebox").TOptional<import("typebox").TString>;
                    canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                    labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                    meaning: import("typebox").TOptional<import("typebox").TString>;
                    label: import("typebox").TString;
                    grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                    lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                        revision: import("typebox").TInteger;
                    }>>;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                        displayStep: import("typebox").TInteger;
                    }>;
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
                'x-resource-types': string[];
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        };
    };
    route15: {
        method: 'PUT';
        path: '/v1/rating-questions/:questionId/label';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
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
                            expectedLabelRevision: number;
                            label: string;
                        };
                        output: {
                            expectedLabelRevision: number;
                            label: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedLabelRevision: number;
                            label: string;
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
                            expectedLabelRevision: import("typebox").TInteger;
                            label: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedLabelRevision: import("typebox").TInteger;
                            label: import("typebox").TString;
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
                    questionId: import("typebox").TString;
                    labelRevision: import("typebox").TInteger;
                    label: import("typebox").TString;
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
                'x-resource-types': string[];
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        };
    };
    route16: {
        method: 'POST';
        path: '/v1/rating-questions/:questionId/$retire';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
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
                            expectedLifecycleRevision: number;
                        };
                        output: {
                            expectedLifecycleRevision: number;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedLifecycleRevision: number;
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
                            expectedLifecycleRevision: import("typebox").TInteger;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedLifecycleRevision: import("typebox").TInteger;
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
                    questionId: import("typebox").TString;
                    lifecycle: import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                        revision: import("typebox").TInteger;
                    }>;
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
                'x-resource-types': string[];
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        };
    };
    route17: {
        method: 'POST';
        path: '/v1/rating-questions/:questionId/$restore';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
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
                            expectedLifecycleRevision: number;
                        };
                        output: {
                            expectedLifecycleRevision: number;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedLifecycleRevision: number;
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
                            expectedLifecycleRevision: import("typebox").TInteger;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedLifecycleRevision: import("typebox").TInteger;
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
                    questionId: import("typebox").TString;
                    lifecycle: import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                        revision: import("typebox").TInteger;
                    }>;
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
                'x-resource-types': string[];
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        };
    };
    route18: {
        method: 'GET';
        path: '/v1/rating-questions/:questionId/labels';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
                cursor: import("typebox").TOptional<import("typebox").TString>;
            }>;
            transform: ({ request }: {
                request: Request;
            }) => void;
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
                    labels: import("typebox").TArray<import("typebox").TObject<{
                        questionId: import("typebox").TString;
                        labelRevision: import("typebox").TInteger;
                        label: import("typebox").TString;
                        at: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        author: import("typebox").TUnion<[import("typebox").TObject<{
                            id: import("typebox").TString;
                            kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                            state: import("typebox").TLiteral<"deleted">;
                        }>, import("typebox").TObject<{
                            id: import("typebox").TString;
                            kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                            state: import("typebox").TLiteral<"active">;
                            handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            automated: import("typebox").TBoolean;
                            operatorId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>, import("typebox").TNull]>;
                    }>>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
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
                'x-resource-types': string[];
            };
        };
    };
    route19: {
        method: 'GET';
        path: '/v1/rating-questions/:questionId/labels/:labelRevision';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
                labelRevision: Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>;
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
                    questionId: import("typebox").TString;
                    labelRevision: import("typebox").TInteger;
                    label: import("typebox").TString;
                    at: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    author: import("typebox").TUnion<[import("typebox").TObject<{
                        id: import("typebox").TString;
                        kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                        state: import("typebox").TLiteral<"deleted">;
                    }>, import("typebox").TObject<{
                        id: import("typebox").TString;
                        kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                        state: import("typebox").TLiteral<"active">;
                        handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        automated: import("typebox").TBoolean;
                        operatorId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    }>, import("typebox").TNull]>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
    route20: {
        method: 'GET';
        path: '/v1/rating-questions';
        options: {
            query: import("typebox").TObject<{
                realm: import("typebox").TOptional<import("typebox").TString>;
                limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
                cursor: import("typebox").TOptional<import("typebox").TString>;
            }>;
            transform: ({ request }: {
                request: Request;
            }) => void;
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
                    ratingQuestions: import("typebox").TArray<import("typebox").TObject<{
                        id: import("typebox").TString;
                        revision: import("typebox").TInteger;
                        realmId: import("typebox").TOptional<import("typebox").TString>;
                        canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                        labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                        meaning: import("typebox").TOptional<import("typebox").TString>;
                        label: import("typebox").TString;
                        grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                        lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                            state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                            revision: import("typebox").TInteger;
                        }>>;
                        scale: import("typebox").TObject<{
                            min: import("typebox").TInteger;
                            max: import("typebox").TInteger;
                            displayStep: import("typebox").TInteger;
                        }>;
                    }>>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
    route21: {
        method: 'GET';
        path: '/v1/rating-questions/:questionId';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
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
                200: import("typebox").TObject<{
                    id: import("typebox").TString;
                    revision: import("typebox").TInteger;
                    realmId: import("typebox").TOptional<import("typebox").TString>;
                    canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                    labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                    meaning: import("typebox").TOptional<import("typebox").TString>;
                    label: import("typebox").TString;
                    grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                    lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                        revision: import("typebox").TInteger;
                    }>>;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                        displayStep: import("typebox").TInteger;
                    }>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
};
export declare function ratingRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies, declarations?: {
    route1: {
        method: 'GET';
        path: '/v1/me/rating-votes';
        options: {
            query: import("typebox").TObject<{
                cursor: import("typebox").TOptional<import("typebox").TString>;
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
                    viewer: import("typebox").TObject<{
                        accountId: import("typebox").TString;
                    }>;
                    votes: import("typebox").TArray<import("typebox").TObject<{
                        targetId: import("typebox").TString;
                        questionId: import("typebox").TString;
                        subject: import("typebox").TObject<{
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
                        }>;
                        subjectHref: import("typebox").TString;
                        question: import("typebox").TObject<{
                            id: import("typebox").TString;
                            revision: import("typebox").TInteger;
                            realmId: import("typebox").TOptional<import("typebox").TString>;
                            canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                            labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                            meaning: import("typebox").TOptional<import("typebox").TString>;
                            label: import("typebox").TString;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                                revision: import("typebox").TInteger;
                            }>>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
                        }>;
                        own: import("typebox").TObject<{
                            units: import("typebox").TInteger;
                            revision: import("typebox").TInteger;
                            at: import("typebox").TString;
                        }>;
                        actions: import("typebox").TUnion<[import("typebox").TObject<{
                            state: import("typebox").TLiteral<"editable">;
                            put: import("typebox").TString;
                            clear: import("typebox").TString;
                            readback: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            state: import("typebox").TLiteral<"retired">;
                            reason: import("typebox").TLiteral<"question_retired">;
                            clear: import("typebox").TString;
                            readback: import("typebox").TString;
                        }>, import("typebox").TObject<{
                            state: import("typebox").TLiteral<"unavailable">;
                            reason: import("typebox").TUnion<[import("typebox").TLiteral<"merged_source">, import("typebox").TLiteral<"identity_pending">, import("typebox").TLiteral<"read_only">]>;
                        }>]>;
                    }>>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
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
    route2: {
        method: 'GET';
        path: '/v1/me/classification-assessments';
        options: {
            query: import("typebox").TObject<{
                cursor: import("typebox").TOptional<import("typebox").TString>;
                selectedSubjectId: import("typebox").TOptional<import("typebox").TString>;
                selectedAssociationId: import("typebox").TOptional<import("typebox").TString>;
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
                200: import("typebox").TObject<{
                    viewer: import("typebox").TObject<{
                        accountId: import("typebox").TString;
                    }>;
                    inventory: import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"current-retained">;
                        complete: import("typebox").TLiteral<false>;
                        generation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        cleanup: import("typebox").TUnion<[import("typebox").TLiteral<"not-started">, import("typebox").TLiteral<"pending">, import("typebox").TLiteral<"settled">]>;
                    }>;
                    items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                        state: import("typebox").TLiteral<"available">;
                        subjectId: import("typebox").TString;
                        associationId: import("typebox").TString;
                        subject: import("typebox").TObject<{
                            id: import("typebox").TString;
                            type: import("typebox").TString;
                            label: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            href: import("typebox").TString;
                        }>;
                        target: import("typebox").TObject<{
                            id: import("typebox").TString;
                            type: import("typebox").TString;
                            label: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            href: import("typebox").TString;
                        }>;
                        association: import("typebox").TObject<{
                            subjectId: import("typebox").TString;
                            associationId: import("typebox").TString;
                            slotId: import("typebox").TString;
                            property: import("typebox").TString;
                            targetId: import("typebox").TString;
                            contextId: import("typebox").TLiteral<"00000000-0000-8000-8000-000000000000">;
                            origin: import("typebox").TLiteral<"global">;
                            release: import("typebox").TString;
                            revision: import("typebox").TInteger;
                            bindingHash: import("typebox").TString;
                            statementDigest: import("typebox").TString;
                            qualifiersDigest: import("typebox").TString;
                        }>;
                        own: import("typebox").TObject<{
                            assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">]>;
                            falsePositive: import("typebox").TBoolean;
                            revision: import("typebox").TString;
                            pending: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"pending">, import("typebox").TLiteral<"unknown">]>;
                        }>;
                        aggregate: import("typebox").TUnion<[import("typebox").TUnion<[import("typebox").TObject<{
                            associationId: import("typebox").TString;
                            pending: import("typebox").TLiteral<"unknown">;
                            state: import("typebox").TLiteral<"suppressed">;
                        }>, import("typebox").TObject<{
                            associationId: import("typebox").TString;
                            pending: import("typebox").TLiteral<"unknown">;
                            state: import("typebox").TLiteral<"published">;
                            supportCount: import("typebox").TInteger;
                            opposeCount: import("typebox").TInteger;
                            falsePositiveCount: import("typebox").TInteger;
                            supportFraction: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
                            asOf: import("typebox").TString;
                            generation: import("typebox").TString;
                        }>]>, import("typebox").TNull]>;
                        actions: import("typebox").TObject<{
                            state: import("typebox").TUnion<[import("typebox").TLiteral<"editable">, import("typebox").TLiteral<"read-only">, import("typebox").TLiteral<"withdraw-only">, import("typebox").TLiteral<"withheld">]>;
                            readback: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            set: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            clear: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"withheld">;
                        subjectId: import("typebox").TString;
                        associationId: import("typebox").TString;
                        subject: import("typebox").TNull;
                        target: import("typebox").TNull;
                        association: import("typebox").TNull;
                        own: import("typebox").TObject<{
                            assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">]>;
                            falsePositive: import("typebox").TBoolean;
                            revision: import("typebox").TString;
                            pending: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"pending">, import("typebox").TLiteral<"unknown">]>;
                        }>;
                        aggregate: import("typebox").TNull;
                        actions: import("typebox").TObject<{
                            state: import("typebox").TUnion<[import("typebox").TLiteral<"editable">, import("typebox").TLiteral<"read-only">, import("typebox").TLiteral<"withdraw-only">, import("typebox").TLiteral<"withheld">]>;
                            readback: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            set: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            clear: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>;
                    }>]>>;
                    traversal: import("typebox").TUnion<[import("typebox").TLiteral<"more">, import("typebox").TLiteral<"complete">]>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route3: {
        method: 'GET';
        path: '/v1/subjects/:id/figure';
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
                    figure: import("typebox").TRef<"PublicFigure">;
                }> & {
                    headers: {
                        readonly etag: import("typebox").TString;
                        readonly 'cache-control': import("typebox").TLiteral<"no-cache">;
                    };
                };
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
    route4: {
        method: 'GET';
        path: '/v1/subjects/:id/ratings';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                question: import("typebox").TString;
                population: import("typebox").TUnion<[import("typebox").TString, import("typebox").TArray<import("typebox").TString>]>;
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
                    question: import("typebox").TString;
                    subject: import("typebox").TString;
                    figures: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                        population: import("typebox").TString;
                        count: import("typebox").TInteger;
                        freshness: import("typebox").TObject<{
                            asOf: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            updating: import("typebox").TBoolean;
                        }>;
                        mean: import("typebox").TNumber;
                        histogram: import("typebox").TArray<import("typebox").TInteger>;
                    }>, import("typebox").TObject<{
                        population: import("typebox").TString;
                        count: import("typebox").TInteger;
                        freshness: import("typebox").TObject<{
                            asOf: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            updating: import("typebox").TBoolean;
                        }>;
                        remaining: import("typebox").TInteger;
                    }>, import("typebox").TObject<{
                        population: import("typebox").TString;
                        count: import("typebox").TInteger;
                        freshness: import("typebox").TObject<{
                            asOf: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            updating: import("typebox").TBoolean;
                        }>;
                    }>]>>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
    route5: {
        method: 'GET';
        path: '/v1/subjects/:id/ratings/populations';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                question: import("typebox").TString;
                cursor: import("typebox").TOptional<import("typebox").TString>;
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
                    populations: import("typebox").TArray<import("typebox").TObject<{
                        population: import("typebox").TString;
                        count: import("typebox").TInteger;
                    }>>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
    route6: {
        method: 'PUT';
        path: '/v1/subjects/:id/ratings/:questionId/vote';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                questionId: import("typebox").TString;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
                'x-rating-observation': import("typebox").TOptional<import("typebox").TString>;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            units: number;
                        };
                        output: {
                            units: number;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            units: number;
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
                            units: import("typebox").TInteger;
                        }>;
                        output: () => import("typebox").TObject<{
                            units: import("typebox").TInteger;
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
                    units: import("typebox").TInteger;
                    revision: import("typebox").TInteger;
                    at: import("typebox").TString;
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
    route7: {
        method: 'DELETE';
        path: '/v1/subjects/:id/ratings/:questionId/vote';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                questionId: import("typebox").TString;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
                'x-rating-observation': import("typebox").TOptional<import("typebox").TString>;
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
                204: import("typebox").TVoid & {
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
    route8: {
        method: 'GET';
        path: '/v1/subjects/:id/ratings/:questionId/vote';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                questionId: import("typebox").TString;
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
                200: import("typebox").TObject<{
                    units: import("typebox").TInteger;
                    revision: import("typebox").TInteger;
                    at: import("typebox").TString;
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
    route9: {
        method: 'PUT';
        path: '/v1/subjects/:id/classification-associations/:associationId/assessment';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                associationId: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                expectedRevision: import("typebox").TOptional<import("typebox").TString>;
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
                            assessment: "oppose" | "support";
                            falsePositive: boolean;
                        };
                        output: {
                            assessment: "oppose" | "support";
                            falsePositive: boolean;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            assessment: "oppose" | "support";
                            falsePositive: boolean;
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
                            assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">]>;
                            falsePositive: import("typebox").TBoolean;
                        }>;
                        output: () => import("typebox").TObject<{
                            assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">]>;
                            falsePositive: import("typebox").TBoolean;
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
                    associationId: import("typebox").TString;
                    revision: import("typebox").TString;
                    delivery: import("typebox").TUnion<[import("typebox").TLiteral<"enqueued">, import("typebox").TLiteral<"unchanged">]>;
                }>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route10: {
        method: 'DELETE';
        path: '/v1/subjects/:id/classification-associations/:associationId/assessment';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                associationId: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                expectedRevision: import("typebox").TOptional<import("typebox").TString>;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
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
                204: import("typebox").TVoid;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route11: {
        method: 'GET';
        path: '/v1/subjects/:id/classification-associations/:associationId/assessment';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                associationId: import("typebox").TString;
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
                200: import("typebox").TObject<{
                    associationId: import("typebox").TString;
                    hasBallot: import("typebox").TBoolean;
                    assessment: import("typebox").TUnion<[import("typebox").TLiteral<"support">, import("typebox").TLiteral<"oppose">, import("typebox").TNull]>;
                    falsePositive: import("typebox").TBoolean;
                    revision: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    pending: import("typebox").TBoolean;
                }>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route12: {
        method: 'GET';
        path: '/v1/subjects/:id/classification-associations/:associationId/aggregate';
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
                associationId: import("typebox").TString;
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
                200: import("typebox").TUnion<[import("typebox").TObject<{
                    associationId: import("typebox").TString;
                    pending: import("typebox").TLiteral<"unknown">;
                    state: import("typebox").TLiteral<"suppressed">;
                }>, import("typebox").TObject<{
                    associationId: import("typebox").TString;
                    pending: import("typebox").TLiteral<"unknown">;
                    state: import("typebox").TLiteral<"published">;
                    supportCount: import("typebox").TInteger;
                    opposeCount: import("typebox").TInteger;
                    falsePositiveCount: import("typebox").TInteger;
                    supportFraction: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
                    asOf: import("typebox").TString;
                    generation: import("typebox").TString;
                }>]>;
            };
            detail: {
                operationId: string;
                'x-action': string;
                'x-exposure': string;
                'x-resource-types': string[];
                security: ({
                    bearerAuth: never[];
                } | {
                    bearerAuth?: never;
                })[];
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route13: {
        method: 'GET';
        path: '/v1/realms/:realmId/rating-questions/management';
        options: {
            params: import("typebox").TObject<{
                realmId: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                selectedQuestionId: import("typebox").TOptional<import("typebox").TString>;
                cursor: import("typebox").TOptional<import("typebox").TString>;
            }>;
            transform: ({ request }: {
                request: Request;
            }) => void;
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
                    viewer: import("typebox").TObject<{
                        accountId: import("typebox").TString;
                    }>;
                    realmId: import("typebox").TString;
                    directory: import("typebox").TObject<{
                        ratingQuestions: import("typebox").TArray<import("typebox").TObject<{
                            id: import("typebox").TString;
                            revision: import("typebox").TInteger;
                            label: import("typebox").TString;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            realmId: import("typebox").TString;
                            meaning: import("typebox").TString;
                            canonicalLabel: import("typebox").TString;
                            labelRevision: import("typebox").TInteger;
                            lifecycle: import("typebox").TObject<{
                                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                                revision: import("typebox").TInteger;
                            }>;
                        }>>;
                        next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    }>;
                    actions: import("typebox").TObject<{
                        create: import("typebox").TUnion<[import("typebox").TObject<{
                            method: import("typebox").TLiteral<"POST">;
                            href: import("typebox").TString;
                        }>, import("typebox").TNull]>;
                    }>;
                    selected: import("typebox").TUnion<[import("typebox").TObject<{
                        question: import("typebox").TObject<{
                            id: import("typebox").TString;
                            revision: import("typebox").TInteger;
                            label: import("typebox").TString;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            realmId: import("typebox").TString;
                            meaning: import("typebox").TString;
                            canonicalLabel: import("typebox").TString;
                            labelRevision: import("typebox").TInteger;
                            lifecycle: import("typebox").TObject<{
                                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                                revision: import("typebox").TInteger;
                            }>;
                        }>;
                        readback: import("typebox").TString;
                        history: import("typebox").TString;
                        actions: import("typebox").TObject<{
                            caption: import("typebox").TUnion<[import("typebox").TObject<{
                                method: import("typebox").TLiteral<"PUT">;
                                href: import("typebox").TString;
                                expectedLabelRevision: import("typebox").TInteger;
                            }>, import("typebox").TNull]>;
                            lifecycle: import("typebox").TUnion<[import("typebox").TObject<{
                                method: import("typebox").TLiteral<"POST">;
                                href: import("typebox").TString;
                                expectedLifecycleRevision: import("typebox").TInteger;
                            }>, import("typebox").TNull]>;
                        }>;
                    }>, import("typebox").TNull]>;
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
                'x-resource-types': string[];
            };
        };
    };
    route14: {
        method: 'POST';
        path: '/v1/realms/:realmId/rating-questions';
        options: {
            params: import("typebox").TObject<{
                realmId: import("typebox").TString;
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
                            meaning: string;
                            label: string;
                            grain: "character" | "episode" | "release" | "work";
                            scale: {
                                min: number;
                                max: number;
                                displayStep: number;
                            };
                        };
                        output: {
                            meaning: string;
                            label: string;
                            grain: "character" | "episode" | "release" | "work";
                            scale: {
                                min: number;
                                max: number;
                                displayStep: number;
                            };
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            meaning: string;
                            label: string;
                            grain: "character" | "episode" | "release" | "work";
                            scale: {
                                min: number;
                                max: number;
                                displayStep: number;
                            };
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
                            meaning: import("typebox").TString;
                            label: import("typebox").TString;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
                        }>;
                        output: () => import("typebox").TObject<{
                            meaning: import("typebox").TString;
                            label: import("typebox").TString;
                            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                            scale: import("typebox").TObject<{
                                min: import("typebox").TInteger;
                                max: import("typebox").TInteger;
                                displayStep: import("typebox").TInteger;
                            }>;
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
                201: import("typebox").TObject<{
                    id: import("typebox").TString;
                    revision: import("typebox").TInteger;
                    realmId: import("typebox").TOptional<import("typebox").TString>;
                    canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                    labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                    meaning: import("typebox").TOptional<import("typebox").TString>;
                    label: import("typebox").TString;
                    grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                    lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                        revision: import("typebox").TInteger;
                    }>>;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                        displayStep: import("typebox").TInteger;
                    }>;
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
                'x-resource-types': string[];
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        };
    };
    route15: {
        method: 'PUT';
        path: '/v1/rating-questions/:questionId/label';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
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
                            expectedLabelRevision: number;
                            label: string;
                        };
                        output: {
                            expectedLabelRevision: number;
                            label: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedLabelRevision: number;
                            label: string;
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
                            expectedLabelRevision: import("typebox").TInteger;
                            label: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedLabelRevision: import("typebox").TInteger;
                            label: import("typebox").TString;
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
                    questionId: import("typebox").TString;
                    labelRevision: import("typebox").TInteger;
                    label: import("typebox").TString;
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
                'x-resource-types': string[];
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        };
    };
    route16: {
        method: 'POST';
        path: '/v1/rating-questions/:questionId/$retire';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
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
                            expectedLifecycleRevision: number;
                        };
                        output: {
                            expectedLifecycleRevision: number;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedLifecycleRevision: number;
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
                            expectedLifecycleRevision: import("typebox").TInteger;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedLifecycleRevision: import("typebox").TInteger;
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
                    questionId: import("typebox").TString;
                    lifecycle: import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                        revision: import("typebox").TInteger;
                    }>;
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
                'x-resource-types': string[];
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        };
    };
    route17: {
        method: 'POST';
        path: '/v1/rating-questions/:questionId/$restore';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
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
                            expectedLifecycleRevision: number;
                        };
                        output: {
                            expectedLifecycleRevision: number;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            expectedLifecycleRevision: number;
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
                            expectedLifecycleRevision: import("typebox").TInteger;
                        }>;
                        output: () => import("typebox").TObject<{
                            expectedLifecycleRevision: import("typebox").TInteger;
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
                    questionId: import("typebox").TString;
                    lifecycle: import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                        revision: import("typebox").TInteger;
                    }>;
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
                'x-resource-types': string[];
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        };
    };
    route18: {
        method: 'GET';
        path: '/v1/rating-questions/:questionId/labels';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
            }>;
            query: import("typebox").TObject<{
                limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
                cursor: import("typebox").TOptional<import("typebox").TString>;
            }>;
            transform: ({ request }: {
                request: Request;
            }) => void;
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
                    labels: import("typebox").TArray<import("typebox").TObject<{
                        questionId: import("typebox").TString;
                        labelRevision: import("typebox").TInteger;
                        label: import("typebox").TString;
                        at: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        author: import("typebox").TUnion<[import("typebox").TObject<{
                            id: import("typebox").TString;
                            kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                            state: import("typebox").TLiteral<"deleted">;
                        }>, import("typebox").TObject<{
                            id: import("typebox").TString;
                            kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                            state: import("typebox").TLiteral<"active">;
                            handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                            automated: import("typebox").TBoolean;
                            operatorId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        }>, import("typebox").TNull]>;
                    }>>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
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
                'x-resource-types': string[];
            };
        };
    };
    route19: {
        method: 'GET';
        path: '/v1/rating-questions/:questionId/labels/:labelRevision';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
                labelRevision: Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>;
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
                    questionId: import("typebox").TString;
                    labelRevision: import("typebox").TInteger;
                    label: import("typebox").TString;
                    at: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    author: import("typebox").TUnion<[import("typebox").TObject<{
                        id: import("typebox").TString;
                        kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                        state: import("typebox").TLiteral<"deleted">;
                    }>, import("typebox").TObject<{
                        id: import("typebox").TString;
                        kind: import("typebox").TUnion<[import("typebox").TLiteral<"actor">, import("typebox").TLiteral<"organization">]>;
                        state: import("typebox").TLiteral<"active">;
                        handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        automated: import("typebox").TBoolean;
                        operatorId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    }>, import("typebox").TNull]>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
    route20: {
        method: 'GET';
        path: '/v1/rating-questions';
        options: {
            query: import("typebox").TObject<{
                realm: import("typebox").TOptional<import("typebox").TString>;
                limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
                cursor: import("typebox").TOptional<import("typebox").TString>;
            }>;
            transform: ({ request }: {
                request: Request;
            }) => void;
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
                    ratingQuestions: import("typebox").TArray<import("typebox").TObject<{
                        id: import("typebox").TString;
                        revision: import("typebox").TInteger;
                        realmId: import("typebox").TOptional<import("typebox").TString>;
                        canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                        labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                        meaning: import("typebox").TOptional<import("typebox").TString>;
                        label: import("typebox").TString;
                        grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                        lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                            state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                            revision: import("typebox").TInteger;
                        }>>;
                        scale: import("typebox").TObject<{
                            min: import("typebox").TInteger;
                            max: import("typebox").TInteger;
                            displayStep: import("typebox").TInteger;
                        }>;
                    }>>;
                    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
    route21: {
        method: 'GET';
        path: '/v1/rating-questions/:questionId';
        options: {
            params: import("typebox").TObject<{
                questionId: import("typebox").TString;
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
                200: import("typebox").TObject<{
                    id: import("typebox").TString;
                    revision: import("typebox").TInteger;
                    realmId: import("typebox").TOptional<import("typebox").TString>;
                    canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                    labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                    meaning: import("typebox").TOptional<import("typebox").TString>;
                    label: import("typebox").TString;
                    grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                    lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                        revision: import("typebox").TInteger;
                    }>>;
                    scale: import("typebox").TObject<{
                        min: import("typebox").TInteger;
                        max: import("typebox").TInteger;
                        displayStep: import("typebox").TInteger;
                    }>;
                }>;
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
                'x-resource-types': string[];
            };
        };
    };
}, sourceDeclarations?: {
    route1: {
        method: 'POST';
        path: "/v1/subjects/:id/source-classifications/$read";
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            body: import("typebox").TObject<{
                associations: import("typebox").TArray<import("typebox").TObject<{
                    subjectId: import("typebox").TString;
                    candidateId: import("typebox").TString;
                    contextId: import("typebox").TString;
                    targetId: import("typebox").TString;
                    property: import("typebox").TString;
                    revision: import("typebox").TInteger;
                    release: import("typebox").TString;
                    qualifiersDigest: import("typebox").TString;
                }>>;
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
                200: import("typebox").TObject<{
                    items: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                        state: import("typebox").TLiteral<"available">;
                        value: import("typebox").TObject<{
                            provider: import("typebox").TLiteral<"vndb">;
                            association: import("typebox").TObject<{
                                subjectId: import("typebox").TString;
                                candidateId: import("typebox").TString;
                                contextId: import("typebox").TString;
                                targetId: import("typebox").TString;
                                property: import("typebox").TString;
                                revision: import("typebox").TInteger;
                                release: import("typebox").TString;
                                qualifiersDigest: import("typebox").TString;
                            }>;
                            observation: import("typebox").TObject<{
                                digest: import("typebox").TString;
                                sourceVersion: import("typebox").TUnion<[import("typebox").TObject<{
                                    kind: import("typebox").TLiteral<"revision">;
                                    revision: import("typebox").TString;
                                }>, import("typebox").TObject<{
                                    kind: import("typebox").TLiteral<"unversioned">;
                                    digest: import("typebox").TString;
                                }>]>;
                            }>;
                            sourceAlias: import("typebox").TString;
                            sourceRecordId: import("typebox").TString;
                            sourceAssociationId: import("typebox").TString;
                            confidence: import("typebox").TUnion<[import("typebox").TObject<{
                                state: import("typebox").TLiteral<"unavailable">;
                                reason: import("typebox").TLiteral<"not_supplied">;
                            }>, import("typebox").TObject<{
                                state: import("typebox").TLiteral<"available">;
                                value: import("typebox").TNumber;
                                unit: import("typebox").TLiteral<"vndb-tag-rating">;
                                minExclusive: import("typebox").TLiteral<0>;
                                max: import("typebox").TLiteral<3>;
                            }>]>;
                            lie: import("typebox").TUnion<[import("typebox").TObject<{
                                state: import("typebox").TLiteral<"unavailable">;
                                reason: import("typebox").TLiteral<"not_supplied">;
                            }>, import("typebox").TObject<{
                                state: import("typebox").TLiteral<"available">;
                                value: import("typebox").TBoolean;
                                unit: import("typebox").TLiteral<"boolean">;
                            }>]>;
                            confidenceCount: import("typebox").TOptional<import("typebox").TInteger>;
                            lieCount: import("typebox").TOptional<import("typebox").TInteger>;
                            asOf: import("typebox").TString;
                            ageSeconds: import("typebox").TInteger;
                            attribution: import("typebox").TString;
                            licence: import("typebox").TString;
                        }>;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TLiteral<"unavailable">;
                        reason: import("typebox").TUnion<[import("typebox").TLiteral<"not_found">, import("typebox").TLiteral<"not_observed">, import("typebox").TLiteral<"provenance_unavailable">, import("typebox").TLiteral<"authority_unavailable">, import("typebox").TLiteral<"changed">]>;
                    }>]>>;
                    actions: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TLiteral<"put">, import("typebox").TLiteral<"clear">]>>;
                }>;
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
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route2: {
        method: 'POST';
        path: "/v1/subjects/:id/source-classifications/$put";
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: import("typebox").TObject<{
                association: import("typebox").TObject<{
                    subjectId: import("typebox").TString;
                    candidateId: import("typebox").TString;
                    contextId: import("typebox").TString;
                    targetId: import("typebox").TString;
                    property: import("typebox").TString;
                    revision: import("typebox").TInteger;
                    release: import("typebox").TString;
                    qualifiersDigest: import("typebox").TString;
                }>;
                expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                value: import("typebox").TObject<{
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    sourceAssociationId: import("typebox").TString;
                    asOf: import("typebox").TString;
                    confidence: import("typebox").TOptional<import("typebox").TNumber>;
                    lie: import("typebox").TOptional<import("typebox").TBoolean>;
                    confidenceCount: import("typebox").TOptional<import("typebox").TInteger>;
                    lieCount: import("typebox").TOptional<import("typebox").TInteger>;
                    sourceVersion: import("typebox").TUnion<[import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"revision">;
                        revision: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unversioned">;
                        digest: import("typebox").TString;
                    }>]>;
                    attribution: import("typebox").TString;
                    licence: import("typebox").TString;
                }>;
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
                200: import("typebox").TObject<{
                    observationDigest: import("typebox").TString;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"published">, import("typebox").TLiteral<"cleared">]>;
                    figure: import("typebox").TObject<{
                        provider: import("typebox").TLiteral<"vndb">;
                        association: import("typebox").TObject<{
                            subjectId: import("typebox").TString;
                            candidateId: import("typebox").TString;
                            contextId: import("typebox").TString;
                            targetId: import("typebox").TString;
                            property: import("typebox").TString;
                            revision: import("typebox").TInteger;
                            release: import("typebox").TString;
                            qualifiersDigest: import("typebox").TString;
                        }>;
                        observation: import("typebox").TObject<{
                            digest: import("typebox").TString;
                            sourceVersion: import("typebox").TUnion<[import("typebox").TObject<{
                                kind: import("typebox").TLiteral<"revision">;
                                revision: import("typebox").TString;
                            }>, import("typebox").TObject<{
                                kind: import("typebox").TLiteral<"unversioned">;
                                digest: import("typebox").TString;
                            }>]>;
                        }>;
                        sourceAlias: import("typebox").TString;
                        sourceRecordId: import("typebox").TString;
                        sourceAssociationId: import("typebox").TString;
                        confidence: import("typebox").TUnion<[import("typebox").TObject<{
                            state: import("typebox").TLiteral<"unavailable">;
                            reason: import("typebox").TLiteral<"not_supplied">;
                        }>, import("typebox").TObject<{
                            state: import("typebox").TLiteral<"available">;
                            value: import("typebox").TNumber;
                            unit: import("typebox").TLiteral<"vndb-tag-rating">;
                            minExclusive: import("typebox").TLiteral<0>;
                            max: import("typebox").TLiteral<3>;
                        }>]>;
                        lie: import("typebox").TUnion<[import("typebox").TObject<{
                            state: import("typebox").TLiteral<"unavailable">;
                            reason: import("typebox").TLiteral<"not_supplied">;
                        }>, import("typebox").TObject<{
                            state: import("typebox").TLiteral<"available">;
                            value: import("typebox").TBoolean;
                            unit: import("typebox").TLiteral<"boolean">;
                        }>]>;
                        confidenceCount: import("typebox").TOptional<import("typebox").TInteger>;
                        lieCount: import("typebox").TOptional<import("typebox").TInteger>;
                        asOf: import("typebox").TString;
                        ageSeconds: import("typebox").TInteger;
                        attribution: import("typebox").TString;
                        licence: import("typebox").TString;
                    }>;
                }> & {
                    headers: {
                        "rezics-session-token": import("typebox").TOptional<import("typebox").TString>;
                    };
                };
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
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
    route3: {
        method: 'POST';
        path: "/v1/subjects/:id/source-classifications/$clear";
        options: {
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: import("typebox").TObject<{
                association: import("typebox").TObject<{
                    subjectId: import("typebox").TString;
                    candidateId: import("typebox").TString;
                    contextId: import("typebox").TString;
                    targetId: import("typebox").TString;
                    property: import("typebox").TString;
                    revision: import("typebox").TInteger;
                    release: import("typebox").TString;
                    qualifiersDigest: import("typebox").TString;
                }>;
                expectedObservation: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                value: import("typebox").TObject<{
                    sourceAlias: import("typebox").TString;
                    sourceRecordId: import("typebox").TString;
                    sourceAssociationId: import("typebox").TString;
                    asOf: import("typebox").TString;
                    cleared: import("typebox").TLiteral<true>;
                }>;
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
                200: import("typebox").TObject<{
                    observationDigest: import("typebox").TString;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"published">, import("typebox").TLiteral<"cleared">]>;
                }> & {
                    headers: {
                        "rezics-session-token": import("typebox").TOptional<import("typebox").TString>;
                    };
                };
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
                'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            };
        };
    };
}): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
    typebox: {
        PublicFigure: import("typebox").TObject<{
            questionId: import("typebox").TString;
            populationId: import("typebox").TString;
            scale: import("typebox").TObject<{
                min: import("typebox").TInteger;
                max: import("typebox").TInteger;
                displayStep: import("typebox").TInteger;
            }>;
            count: import("typebox").TInteger;
            state: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"insufficient_data">, import("typebox").TLiteral<"updating">]>;
            mean: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
            score: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
        }>;
    };
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
                "source-classifications": {
                    $read: {
                        post: {
                            body: {
                                associations: {
                                    subjectId: string;
                                    candidateId: string;
                                    contextId: string;
                                    targetId: string;
                                    property: string;
                                    revision: number;
                                    release: string;
                                    qualifiersDigest: string;
                                }[];
                            };
                            params: {
                                id: string;
                            };
                            query: unknown;
                            headers: unknown;
                            response: {
                                200: {
                                    items: ({
                                        state: "available";
                                        value: {
                                            provider: "vndb";
                                            association: {
                                                subjectId: string;
                                                candidateId: string;
                                                contextId: string;
                                                targetId: string;
                                                property: string;
                                                revision: number;
                                                release: string;
                                                qualifiersDigest: string;
                                            };
                                            observation: {
                                                digest: string;
                                                sourceVersion: {
                                                    kind: "revision";
                                                    revision: string;
                                                } | {
                                                    kind: "unversioned";
                                                    digest: string;
                                                };
                                            };
                                            sourceAlias: string;
                                            sourceRecordId: string;
                                            sourceAssociationId: string;
                                            confidence: {
                                                state: "unavailable";
                                                reason: "not_supplied";
                                            } | {
                                                state: "available";
                                                value: number;
                                                unit: "vndb-tag-rating";
                                                minExclusive: 0;
                                                max: 3;
                                            };
                                            lie: {
                                                state: "unavailable";
                                                reason: "not_supplied";
                                            } | {
                                                state: "available";
                                                value: boolean;
                                                unit: "boolean";
                                            };
                                            confidenceCount?: number;
                                            lieCount?: number;
                                            asOf: string;
                                            ageSeconds: number;
                                            attribution: string;
                                            licence: string;
                                        };
                                    } | {
                                        state: "unavailable";
                                        reason: "authority_unavailable" | "changed" | "not_found" | "not_observed" | "provenance_unavailable";
                                    })[];
                                    actions: ("clear" | "put")[];
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
                "source-classifications": {
                    $put: {
                        post: {
                            body: {
                                association: {
                                    subjectId: string;
                                    candidateId: string;
                                    contextId: string;
                                    targetId: string;
                                    property: string;
                                    revision: number;
                                    release: string;
                                    qualifiersDigest: string;
                                };
                                expectedObservation: string | null;
                                value: {
                                    sourceAlias: string;
                                    sourceRecordId: string;
                                    sourceAssociationId: string;
                                    asOf: string;
                                    confidence?: number;
                                    lie?: boolean;
                                    confidenceCount?: number;
                                    lieCount?: number;
                                    sourceVersion: {
                                        kind: "revision";
                                        revision: string;
                                    } | {
                                        kind: "unversioned";
                                        digest: string;
                                    };
                                    attribution: string;
                                    licence: string;
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
                                    observationDigest: string;
                                    state: "cleared" | "published";
                                    figure: {
                                        provider: "vndb";
                                        association: {
                                            subjectId: string;
                                            candidateId: string;
                                            contextId: string;
                                            targetId: string;
                                            property: string;
                                            revision: number;
                                            release: string;
                                            qualifiersDigest: string;
                                        };
                                        observation: {
                                            digest: string;
                                            sourceVersion: {
                                                kind: "revision";
                                                revision: string;
                                            } | {
                                                kind: "unversioned";
                                                digest: string;
                                            };
                                        };
                                        sourceAlias: string;
                                        sourceRecordId: string;
                                        sourceAssociationId: string;
                                        confidence: {
                                            state: "unavailable";
                                            reason: "not_supplied";
                                        } | {
                                            state: "available";
                                            value: number;
                                            unit: "vndb-tag-rating";
                                            minExclusive: 0;
                                            max: 3;
                                        };
                                        lie: {
                                            state: "unavailable";
                                            reason: "not_supplied";
                                        } | {
                                            state: "available";
                                            value: boolean;
                                            unit: "boolean";
                                        };
                                        confidenceCount?: number;
                                        lieCount?: number;
                                        asOf: string;
                                        ageSeconds: number;
                                        attribution: string;
                                        licence: string;
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
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                "source-classifications": {
                    $clear: {
                        post: {
                            body: {
                                association: {
                                    subjectId: string;
                                    candidateId: string;
                                    contextId: string;
                                    targetId: string;
                                    property: string;
                                    revision: number;
                                    release: string;
                                    qualifiersDigest: string;
                                };
                                expectedObservation: string | null;
                                value: {
                                    sourceAlias: string;
                                    sourceRecordId: string;
                                    sourceAssociationId: string;
                                    asOf: string;
                                    cleared: true;
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
                                    observationDigest: string;
                                    state: "cleared" | "published";
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
        me: {
            "rating-votes": {
                get: {
                    body: unknown;
                    params: {};
                    query: {
                        cursor?: string;
                    };
                    headers: unknown;
                    response: {
                        200: {
                            viewer: {
                                accountId: string;
                            };
                            votes: {
                                targetId: string;
                                questionId: string;
                                subject: {
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
                                subjectHref: string;
                                question: {
                                    id: string;
                                    revision: number;
                                    realmId?: string;
                                    canonicalLabel?: string;
                                    labelRevision?: number;
                                    meaning?: string;
                                    label: string;
                                    grain: "character" | "episode" | "release" | "work";
                                    lifecycle?: {
                                        state: "active" | "retired";
                                        revision: number;
                                    };
                                    scale: {
                                        min: number;
                                        max: number;
                                        displayStep: number;
                                    };
                                };
                                own: {
                                    units: number;
                                    revision: number;
                                    at: string;
                                };
                                actions: {
                                    state: "editable";
                                    put: string;
                                    clear: string;
                                    readback: string;
                                } | {
                                    state: "retired";
                                    reason: "question_retired";
                                    clear: string;
                                    readback: string;
                                } | {
                                    state: "unavailable";
                                    reason: "identity_pending" | "merged_source" | "read_only";
                                };
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
        me: {
            "classification-assessments": {
                get: {
                    body: unknown;
                    params: {};
                    query: {
                        cursor?: string;
                        selectedSubjectId?: string;
                        selectedAssociationId?: string;
                    };
                    headers: unknown;
                    response: {
                        200: {
                            viewer: {
                                accountId: string;
                            };
                            inventory: {
                                kind: "current-retained";
                                complete: false;
                                generation: string | null;
                                cleanup: "not-started" | "pending" | "settled";
                            };
                            items: ({
                                state: "available";
                                subjectId: string;
                                associationId: string;
                                subject: {
                                    id: string;
                                    type: string;
                                    label: string | null;
                                    href: string;
                                };
                                target: {
                                    id: string;
                                    type: string;
                                    label: string | null;
                                    href: string;
                                };
                                association: {
                                    subjectId: string;
                                    associationId: string;
                                    slotId: string;
                                    property: string;
                                    targetId: string;
                                    contextId: "00000000-0000-8000-8000-000000000000";
                                    origin: "global";
                                    release: string;
                                    revision: number;
                                    bindingHash: string;
                                    statementDigest: string;
                                    qualifiersDigest: string;
                                };
                                own: {
                                    assessment: "oppose" | "support";
                                    falsePositive: boolean;
                                    revision: string;
                                    pending: "current" | "pending" | "unknown";
                                };
                                aggregate: {
                                    associationId: string;
                                    pending: "unknown";
                                    state: "suppressed";
                                } | {
                                    associationId: string;
                                    pending: "unknown";
                                    state: "published";
                                    supportCount: number;
                                    opposeCount: number;
                                    falsePositiveCount: number;
                                    supportFraction: number | null;
                                    asOf: string;
                                    generation: string;
                                } | null;
                                actions: {
                                    state: "editable" | "read-only" | "withdraw-only" | "withheld";
                                    readback: string | null;
                                    set: string | null;
                                    clear: string | null;
                                };
                            } | {
                                state: "withheld";
                                subjectId: string;
                                associationId: string;
                                subject: null;
                                target: null;
                                association: null;
                                own: {
                                    assessment: "oppose" | "support";
                                    falsePositive: boolean;
                                    revision: string;
                                    pending: "current" | "pending" | "unknown";
                                };
                                aggregate: null;
                                actions: {
                                    state: "editable" | "read-only" | "withdraw-only" | "withheld";
                                    readback: string | null;
                                    set: string | null;
                                    clear: string | null;
                                };
                            })[];
                            traversal: "complete" | "more";
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
                figure: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                figure: {
                                    questionId: string;
                                    populationId: string;
                                    scale: {
                                        min: number;
                                        max: number;
                                        displayStep: number;
                                    };
                                    count: number;
                                    state: "insufficient_data" | "ready" | "updating";
                                    mean: number | null;
                                    score: number | null;
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
                ratings: {
                    get: {
                        body: unknown;
                        params: {
                            id: string;
                        };
                        query: {
                            question: string;
                            population: string | string[];
                        };
                        headers: unknown;
                        response: {
                            200: {
                                question: string;
                                subject: string;
                                figures: ({
                                    population: string;
                                    count: number;
                                    freshness: {
                                        asOf: string | null;
                                        updating: boolean;
                                    };
                                } | {
                                    population: string;
                                    count: number;
                                    freshness: {
                                        asOf: string | null;
                                        updating: boolean;
                                    };
                                    mean: number;
                                    histogram: number[];
                                } | {
                                    population: string;
                                    count: number;
                                    freshness: {
                                        asOf: string | null;
                                        updating: boolean;
                                    };
                                    remaining: number;
                                })[];
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
} & {
    v1: {
        subjects: {
            ":id": {
                ratings: {
                    populations: {
                        get: {
                            body: unknown;
                            params: {
                                id: string;
                            };
                            query: {
                                question: string;
                                cursor?: string;
                            };
                            headers: unknown;
                            response: {
                                200: {
                                    populations: {
                                        population: string;
                                        count: number;
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
        subjects: {
            ":id": {
                ratings: {
                    ":questionId": {
                        vote: {
                            put: {
                                body: {
                                    units: number;
                                };
                                params: {
                                    id: string;
                                    questionId: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                    'x-rating-observation'?: string;
                                };
                                response: {
                                    200: {
                                        units: number;
                                        revision: number;
                                        at: string;
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
                ratings: {
                    ":questionId": {
                        vote: {
                            delete: {
                                body: unknown;
                                params: {
                                    id: string;
                                    questionId: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                    'x-rating-observation'?: string;
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
} & {
    v1: {
        subjects: {
            ":id": {
                ratings: {
                    ":questionId": {
                        vote: {
                            get: {
                                body: unknown;
                                params: {
                                    id: string;
                                    questionId: string;
                                };
                                query: unknown;
                                headers: unknown;
                                response: {
                                    200: {
                                        units: number;
                                        revision: number;
                                        at: string;
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
                "classification-associations": {
                    ":associationId": {
                        assessment: {
                            put: {
                                body: {
                                    assessment: "oppose" | "support";
                                    falsePositive: boolean;
                                };
                                params: {
                                    id: string;
                                    associationId: string;
                                };
                                query: {
                                    expectedRevision?: string;
                                };
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        associationId: string;
                                        revision: string;
                                        delivery: "enqueued" | "unchanged";
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
                "classification-associations": {
                    ":associationId": {
                        assessment: {
                            delete: {
                                body: unknown;
                                params: {
                                    id: string;
                                    associationId: string;
                                };
                                query: {
                                    expectedRevision?: string;
                                };
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
} & {
    v1: {
        subjects: {
            ":id": {
                "classification-associations": {
                    ":associationId": {
                        assessment: {
                            get: {
                                body: unknown;
                                params: {
                                    id: string;
                                    associationId: string;
                                };
                                query: unknown;
                                headers: unknown;
                                response: {
                                    200: {
                                        associationId: string;
                                        hasBallot: boolean;
                                        assessment: "oppose" | "support" | null;
                                        falsePositive: boolean;
                                        revision: string | null;
                                        pending: boolean;
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
                "classification-associations": {
                    ":associationId": {
                        aggregate: {
                            get: {
                                body: unknown;
                                params: {
                                    id: string;
                                    associationId: string;
                                };
                                query: unknown;
                                headers: unknown;
                                response: {
                                    200: {
                                        associationId: string;
                                        pending: "unknown";
                                        state: "suppressed";
                                    } | {
                                        associationId: string;
                                        pending: "unknown";
                                        state: "published";
                                        supportCount: number;
                                        opposeCount: number;
                                        falsePositiveCount: number;
                                        supportFraction: number | null;
                                        asOf: string;
                                        generation: string;
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
    };
} & {
    v1: {
        realms: {
            ":realmId": {
                "rating-questions": {
                    management: {
                        get: {
                            body: unknown;
                            params: {
                                realmId: string;
                            };
                            query: {
                                selectedQuestionId?: string;
                                cursor?: string;
                            };
                            headers: unknown;
                            response: {
                                200: {
                                    viewer: {
                                        accountId: string;
                                    };
                                    realmId: string;
                                    directory: {
                                        ratingQuestions: {
                                            id: string;
                                            revision: number;
                                            label: string;
                                            scale: {
                                                min: number;
                                                max: number;
                                                displayStep: number;
                                            };
                                            grain: "character" | "episode" | "release" | "work";
                                            realmId: string;
                                            meaning: string;
                                            canonicalLabel: string;
                                            labelRevision: number;
                                            lifecycle: {
                                                state: "active" | "retired";
                                                revision: number;
                                            };
                                        }[];
                                        next: string | null;
                                    };
                                    actions: {
                                        create: {
                                            method: "POST";
                                            href: string;
                                        } | null;
                                    };
                                    selected: {
                                        question: {
                                            id: string;
                                            revision: number;
                                            label: string;
                                            scale: {
                                                min: number;
                                                max: number;
                                                displayStep: number;
                                            };
                                            grain: "character" | "episode" | "release" | "work";
                                            realmId: string;
                                            meaning: string;
                                            canonicalLabel: string;
                                            labelRevision: number;
                                            lifecycle: {
                                                state: "active" | "retired";
                                                revision: number;
                                            };
                                        };
                                        readback: string;
                                        history: string;
                                        actions: {
                                            caption: {
                                                method: "PUT";
                                                href: string;
                                                expectedLabelRevision: number;
                                            } | null;
                                            lifecycle: {
                                                method: "POST";
                                                href: string;
                                                expectedLifecycleRevision: number;
                                            } | null;
                                        };
                                    } | null;
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
        };
    };
} & {
    v1: {
        realms: {
            ":realmId": {
                "rating-questions": {
                    post: {
                        body: {
                            meaning: string;
                            label: string;
                            grain: "character" | "episode" | "release" | "work";
                            scale: {
                                min: number;
                                max: number;
                                displayStep: number;
                            };
                        };
                        params: {
                            realmId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                id: string;
                                realmId: string;
                                meaning: string;
                                revision: number;
                                lifecycle: {
                                    state: string;
                                    revision: number;
                                };
                                label: string;
                                canonicalLabel: string;
                                labelRevision: number;
                                grain: import("./question-authoring.ts").QuestionGrain;
                                scale: {
                                    min: number;
                                    max: number;
                                    displayStep: number;
                                };
                            };
                            201: {
                                id: string;
                                revision: number;
                                realmId?: string;
                                canonicalLabel?: string;
                                labelRevision?: number;
                                meaning?: string;
                                label: string;
                                grain: "character" | "episode" | "release" | "work";
                                lifecycle?: {
                                    state: "active" | "retired";
                                    revision: number;
                                };
                                scale: {
                                    min: number;
                                    max: number;
                                    displayStep: number;
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
    };
} & {
    v1: {
        "rating-questions": {
            ":questionId": {
                label: {
                    put: {
                        body: {
                            expectedLabelRevision: number;
                            label: string;
                        };
                        params: {
                            questionId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                questionId: string;
                                labelRevision: number;
                                label: string;
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
        "rating-questions": {
            ":questionId": {
                $retire: {
                    post: {
                        body: {
                            expectedLifecycleRevision: number;
                        };
                        params: {
                            questionId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                questionId: string;
                                lifecycle: {
                                    state: "active" | "retired";
                                    revision: number;
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
    };
} & {
    v1: {
        "rating-questions": {
            ":questionId": {
                $restore: {
                    post: {
                        body: {
                            expectedLifecycleRevision: number;
                        };
                        params: {
                            questionId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                questionId: string;
                                lifecycle: {
                                    state: "active" | "retired";
                                    revision: number;
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
    };
} & {
    v1: {
        "rating-questions": {
            ":questionId": {
                labels: {
                    get: {
                        body: unknown;
                        params: {
                            questionId: string;
                        };
                        query: {
                            limit?: string | number;
                            cursor?: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                labels: {
                                    questionId: string;
                                    labelRevision: number;
                                    label: string;
                                    at: string | null;
                                    author: {
                                        id: string;
                                        kind: "actor" | "organization";
                                        state: "deleted";
                                    } | {
                                        id: string;
                                        kind: "actor" | "organization";
                                        state: "active";
                                        handle: string | null;
                                        displayName: string | null;
                                        automated: boolean;
                                        operatorId: string | null;
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
    };
} & {
    v1: {
        "rating-questions": {
            ":questionId": {
                labels: {
                    ":labelRevision": {
                        get: {
                            body: unknown;
                            params: {
                                questionId: string;
                                labelRevision: number;
                            };
                            query: unknown;
                            headers: unknown;
                            response: {
                                200: {
                                    questionId: string;
                                    labelRevision: number;
                                    label: string;
                                    at: string | null;
                                    author: {
                                        id: string;
                                        kind: "actor" | "organization";
                                        state: "deleted";
                                    } | {
                                        id: string;
                                        kind: "actor" | "organization";
                                        state: "active";
                                        handle: string | null;
                                        displayName: string | null;
                                        automated: boolean;
                                        operatorId: string | null;
                                    } | null;
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
        "rating-questions": {
            get: {
                body: unknown;
                params: {};
                query: {
                    realm?: string;
                    limit?: string | number;
                    cursor?: string;
                };
                headers: unknown;
                response: {
                    200: {
                        ratingQuestions: {
                            id: string;
                            revision: number;
                            realmId?: string;
                            canonicalLabel?: string;
                            labelRevision?: number;
                            meaning?: string;
                            label: string;
                            grain: "character" | "episode" | "release" | "work";
                            lifecycle?: {
                                state: "active" | "retired";
                                revision: number;
                            };
                            scale: {
                                min: number;
                                max: number;
                                displayStep: number;
                            };
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
}, "get", "/v1/rating-questions/:questionId", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        questionId: import("typebox").TString;
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
        200: import("typebox").TObject<{
            id: import("typebox").TString;
            revision: import("typebox").TInteger;
            realmId: import("typebox").TOptional<import("typebox").TString>;
            canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
            labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
            meaning: import("typebox").TOptional<import("typebox").TString>;
            label: import("typebox").TString;
            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
            lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                revision: import("typebox").TInteger;
            }>>;
            scale: import("typebox").TObject<{
                min: import("typebox").TInteger;
                max: import("typebox").TInteger;
                displayStep: import("typebox").TInteger;
            }>;
        }>;
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
        'x-resource-types': string[];
    };
}, {
    PublicFigure: import("typebox").TObject<{
        questionId: import("typebox").TString;
        populationId: import("typebox").TString;
        scale: import("typebox").TObject<{
            min: import("typebox").TInteger;
            max: import("typebox").TInteger;
            displayStep: import("typebox").TInteger;
        }>;
        count: import("typebox").TInteger;
        state: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"insufficient_data">, import("typebox").TLiteral<"updating">]>;
        mean: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
        score: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
    }>;
}, "/v1/rating-questions/:questionId">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ actor, params, admission, job }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
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
        200: {
            id: string;
            revision: number;
            realmId?: string;
            canonicalLabel?: string;
            labelRevision?: number;
            meaning?: string;
            label: string;
            grain: "character" | "episode" | "release" | "work";
            lifecycle?: {
                state: "active" | "retired";
                revision: number;
            };
            scale: {
                min: number;
                max: number;
                displayStep: number;
            };
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
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
        200: {
            id: string;
            revision: number;
            realmId?: string;
            canonicalLabel?: string;
            labelRevision?: number;
            meaning?: string;
            label: string;
            grain: "character" | "episode" | "release" | "work";
            lifecycle?: {
                state: "active" | "retired";
                revision: number;
            };
            scale: {
                min: number;
                max: number;
                displayStep: number;
            };
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            questionId: import("typebox").TString;
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
            200: import("typebox").TObject<{
                id: import("typebox").TString;
                revision: import("typebox").TInteger;
                realmId: import("typebox").TOptional<import("typebox").TString>;
                canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
                labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
                meaning: import("typebox").TOptional<import("typebox").TString>;
                label: import("typebox").TString;
                grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
                lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                    revision: import("typebox").TInteger;
                }>>;
                scale: import("typebox").TObject<{
                    min: import("typebox").TInteger;
                    max: import("typebox").TInteger;
                    displayStep: import("typebox").TInteger;
                }>;
            }>;
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
            'x-resource-types': string[];
        };
    }, {
        PublicFigure: import("typebox").TObject<{
            questionId: import("typebox").TString;
            populationId: import("typebox").TString;
            scale: import("typebox").TObject<{
                min: import("typebox").TInteger;
                max: import("typebox").TInteger;
                displayStep: import("typebox").TInteger;
            }>;
            count: import("typebox").TInteger;
            state: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"insufficient_data">, import("typebox").TLiteral<"updating">]>;
            mean: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
            score: import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TNull]>;
        }>;
    }, "/v1/rating-questions/:questionId">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
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
    query: Record<string, string | undefined>;
    params: {
        questionId: string;
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
}) => Promise<import("./question-directory.ts").RatingQuestionView>, {
    params: import("typebox").TObject<{
        questionId: import("typebox").TString;
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
        200: import("typebox").TObject<{
            id: import("typebox").TString;
            revision: import("typebox").TInteger;
            realmId: import("typebox").TOptional<import("typebox").TString>;
            canonicalLabel: import("typebox").TOptional<import("typebox").TString>;
            labelRevision: import("typebox").TOptional<import("typebox").TInteger>;
            meaning: import("typebox").TOptional<import("typebox").TString>;
            label: import("typebox").TString;
            grain: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">, import("typebox").TLiteral<"episode">, import("typebox").TLiteral<"character">]>;
            lifecycle: import("typebox").TOptional<import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"active">, import("typebox").TLiteral<"retired">]>;
                revision: import("typebox").TInteger;
            }>>;
            scale: import("typebox").TObject<{
                min: import("typebox").TInteger;
                max: import("typebox").TInteger;
                displayStep: import("typebox").TInteger;
            }>;
        }>;
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
        'x-resource-types': string[];
    };
}>;
export {};
