import type { Pool } from 'pg';
import type { Static, TSchema } from 'typebox';
import type { KernelClock } from '../clock.ts';
import { type Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { SearchService } from '../search/service-scope.ts';
type Dependencies = {
    pool: Pool;
    access: () => Access;
    tokens: KeyRing;
    clock: KernelClock;
    routeKey: Uint8Array;
    search?: SearchService;
    workClient?: () => Promise<WorkClient>;
};
export declare const collectionSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    membershipKind: import("typebox").TLiteral<"curated">;
    curatorAccountId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    title: import("typebox").TString;
    description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    visibility: import("typebox").TUnion<[import("typebox").TLiteral<"private">, import("typebox").TLiteral<"unlisted">, import("typebox").TLiteral<"public">]>;
    presentationKind: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    presentationKindSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"mixed">]>;
    cover: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
    }>, import("typebox").TNull]>>;
    coverSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"member">, import("typebox").TLiteral<"none">, import("typebox").TLiteral<"pending">]>;
    coverMediaId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
    revision: import("typebox").TInteger;
    memberCount: import("typebox").TInteger;
    orderEpoch: import("typebox").TInteger;
    createdAt: import("typebox").TString;
    updatedAt: import("typebox").TString;
}>;
export declare const collectionReadSchema: import("typebox").TUnion<[import("typebox").TObject<{
    id: import("typebox").TString;
    membershipKind: import("typebox").TLiteral<"curated">;
    curatorAccountId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    title: import("typebox").TString;
    description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    visibility: import("typebox").TUnion<[import("typebox").TLiteral<"private">, import("typebox").TLiteral<"unlisted">, import("typebox").TLiteral<"public">]>;
    presentationKind: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    presentationKindSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"mixed">]>;
    cover: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
    }>, import("typebox").TNull]>>;
    coverSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"member">, import("typebox").TLiteral<"none">, import("typebox").TLiteral<"pending">]>;
    coverMediaId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
    revision: import("typebox").TInteger;
    memberCount: import("typebox").TInteger;
    orderEpoch: import("typebox").TInteger;
    createdAt: import("typebox").TString;
    updatedAt: import("typebox").TString;
} & {
    curator: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>, import("typebox").TNull]>>;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    curatorAccountId: import("typebox").TString;
    membershipKind: import("typebox").TLiteral<"dynamic">;
    builtinKind: import("typebox").TUnion<[import("typebox").TLiteral<"everything">, import("typebox").TLiteral<"state">, import("typebox").TLiteral<"liked">]>;
    builtin: import("typebox").TUnion<[import("typebox").TObject<{
        kind: import("typebox").TLiteral<"everything">;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"liked">;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"state">;
        profileId: import("typebox").TString;
        stateSetId: import("typebox").TString;
        stateId: import("typebox").TString;
    }>]>;
    builtinLabels: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
    title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    visibility: import("typebox").TLiteral<"private">;
    revision: import("typebox").TInteger;
    presentationKind: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    presentationKindSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"mixed">]>;
    cover: import("typebox").TNull;
    coverSource: import("typebox").TLiteral<"none">;
} & {
    curator: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
        id: import("typebox").TString;
        handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>, import("typebox").TNull]>>;
}>]>;
export declare const savedDynamicCollectionSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    curatorAccountId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    title: import("typebox").TString;
    description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    visibility: import("typebox").TUnion<[import("typebox").TLiteral<"private">, import("typebox").TLiteral<"unlisted">, import("typebox").TLiteral<"public">]>;
    presentationKind: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    presentationKindSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"mixed">]>;
    cover: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
    }>, import("typebox").TNull]>>;
    coverSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"member">, import("typebox").TLiteral<"none">, import("typebox").TLiteral<"pending">]>;
    coverMediaId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
    revision: import("typebox").TInteger;
    membershipKind: import("typebox").TLiteral<"dynamic">;
}>;
export declare const collectionPublicationSchema: import("typebox").TObject<{
    generation: import("typebox").TString;
    state: import("typebox").TLiteral<"complete">;
    itemCount: import("typebox").TInteger;
}>;
export declare const collectionPublicationRequestSchema: import("typebox").TObject<{
    revision: import("typebox").TInteger;
    subjectIds: import("typebox").TArray<import("typebox").TString>;
}>;
export declare const collectionResourceSchema: import("typebox").TUnion<[import("typebox").TObject<{
    id: import("typebox").TString;
    membershipKind: import("typebox").TLiteral<"curated">;
    curatorAccountId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    title: import("typebox").TString;
    description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    visibility: import("typebox").TUnion<[import("typebox").TLiteral<"private">, import("typebox").TLiteral<"unlisted">, import("typebox").TLiteral<"public">]>;
    presentationKind: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    presentationKindSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"mixed">]>;
    cover: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
    }>, import("typebox").TNull]>>;
    coverSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"member">, import("typebox").TLiteral<"none">, import("typebox").TLiteral<"pending">]>;
    coverMediaId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
    revision: import("typebox").TInteger;
    memberCount: import("typebox").TInteger;
    orderEpoch: import("typebox").TInteger;
    createdAt: import("typebox").TString;
    updatedAt: import("typebox").TString;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    curatorAccountId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    title: import("typebox").TString;
    description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    visibility: import("typebox").TUnion<[import("typebox").TLiteral<"private">, import("typebox").TLiteral<"unlisted">, import("typebox").TLiteral<"public">]>;
    presentationKind: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    presentationKindSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"mixed">]>;
    cover: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
    }>, import("typebox").TNull]>>;
    coverSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"member">, import("typebox").TLiteral<"none">, import("typebox").TLiteral<"pending">]>;
    coverMediaId: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>>;
    revision: import("typebox").TInteger;
    membershipKind: import("typebox").TLiteral<"dynamic">;
}>, import("typebox").TObject<{
    id: import("typebox").TString;
    curatorAccountId: import("typebox").TString;
    membershipKind: import("typebox").TLiteral<"dynamic">;
    builtinKind: import("typebox").TUnion<[import("typebox").TLiteral<"everything">, import("typebox").TLiteral<"state">, import("typebox").TLiteral<"liked">]>;
    builtin: import("typebox").TUnion<[import("typebox").TObject<{
        kind: import("typebox").TLiteral<"everything">;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"liked">;
    }>, import("typebox").TObject<{
        kind: import("typebox").TLiteral<"state">;
        profileId: import("typebox").TString;
        stateSetId: import("typebox").TString;
        stateId: import("typebox").TString;
    }>]>;
    builtinLabels: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
    title: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    description: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    visibility: import("typebox").TLiteral<"private">;
    revision: import("typebox").TInteger;
    presentationKind: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    presentationKindSource: import("typebox").TUnion<[import("typebox").TLiteral<"owner">, import("typebox").TLiteral<"mixed">]>;
    cover: import("typebox").TNull;
    coverSource: import("typebox").TLiteral<"none">;
}>]>;
/** Validate original JSON without Elysia's removal of undeclared body properties. */
export declare function strict<S extends TSchema>(schema: S): {
    '~standard': {
        version: 1;
        vendor: string;
        types: {
            input: Static<S>;
            output: Static<S>;
        } | undefined;
        validate(value: unknown): {
            value: Static<S>;
            issues?: never;
        } | {
            value?: never;
            issues: {
                message: string;
            }[];
        };
        jsonSchema: {
            input: () => S;
            output: () => S;
        };
    };
};
/** Transport only: the merged commands and reads own authorization, privacy and ordering. */
export declare function collectionRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
                    };
                    params: {};
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            survivor: string;
                            redirected: string;
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
                        };
                        308: {
                            redirect: {
                                from: string;
                                to: string;
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
                                        rank: "normal" | "preferred";
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
                                    decision: "accepted" | "rejected" | null;
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
                                            rank: "normal" | "preferred";
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
        collections: {
            ":collectionId": {
                $publish: {
                    post: {
                        body: {
                            revision: number;
                            visibility: "public" | "unlisted";
                        };
                        params: {
                            collectionId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                id: string;
                                collectionId: string;
                                visibility: "public" | "unlisted";
                                phase: "awaiting_activation" | "refused" | "staging";
                            } | {
                                id: string;
                                collectionId: string;
                                visibility: "public" | "unlisted";
                                phase: "complete";
                                publication: {
                                    generation: string;
                                };
                            };
                            202: {
                                id: string;
                                collectionId: string;
                                visibility: "public" | "unlisted";
                                phase: "awaiting_activation" | "refused" | "staging";
                            } | {
                                id: string;
                                collectionId: string;
                                visibility: "public" | "unlisted";
                                phase: "complete";
                                publication: {
                                    generation: string;
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
        collectionPublications: {
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
                            id: string;
                            collectionId: string;
                            visibility: "public" | "unlisted";
                            phase: "awaiting_activation" | "refused" | "staging";
                        } | {
                            id: string;
                            collectionId: string;
                            visibility: "public" | "unlisted";
                            phase: "complete";
                            publication: {
                                generation: string;
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
        collections: {
            ":collectionId": {
                $publishSelected: {
                    post: {
                        body: {
                            revision: number;
                            subjectIds: string[];
                        };
                        params: {
                            collectionId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                collection: {
                                    id: string;
                                    curatorAccountId: string | null;
                                    title: string;
                                    description: string | null;
                                    visibility: "private" | "public" | "unlisted";
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
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
                                    coverSource: "member" | "none" | "owner" | "pending";
                                    coverMediaId?: string | null;
                                    revision: number;
                                    membershipKind: "dynamic";
                                };
                                publication: {
                                    generation: string;
                                    state: "complete";
                                    itemCount: number;
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
        sitemap: {
            collections: {
                get: {
                    body: unknown;
                    params: {};
                    query: {
                        cursor?: string;
                        limit?: string | number;
                    };
                    headers: unknown;
                    response: {
                        200: {
                            items: {
                                id: string;
                                lastModified: string;
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
                            type: unknown;
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
        collections: {
            post: {
                body: {
                    title: string;
                    description?: string | null;
                    visibility: "private" | "public" | "unlisted";
                    presentationKind?: string | null;
                    coverMediaId?: string | null;
                } | {
                    title: string;
                    description?: string | null;
                    visibility: "private" | "public" | "unlisted";
                    presentationKind?: string | null;
                    coverMediaId?: string | null;
                    membershipKind: "dynamic";
                    rule: {
                        filter: unknown;
                        sort?: string;
                    };
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        collection: {
                            presentationKind: import("./collection-kind.ts").CollectionKind['presentationKind'];
                            presentationKindSource: import("./collection-kind.ts").CollectionKind['presentationKindSource'];
                            cover: import("../semantic/summaries.ts").CoverSummary | null;
                            coverSource: 'owner' | 'member' | 'none' | 'pending';
                            id: string;
                            curatorAccountId: string | null;
                            title: string;
                            description: string | null;
                            visibility: import("./collection-model.ts").CollectionVisibility;
                            revision: number;
                            membershipKind: 'dynamic';
                        } | {
                            presentationKind: import("./collection-kind.ts").CollectionKind['presentationKind'];
                            presentationKindSource: import("./collection-kind.ts").CollectionKind['presentationKindSource'];
                            cover: import("../semantic/summaries.ts").CoverSummary | null;
                            coverSource: 'owner' | 'member' | 'none' | 'pending';
                            id: string;
                            curatorAccountId: string | null;
                            title: string;
                            description: string | null;
                            visibility: import("./collection-model.ts").CollectionVisibility;
                            membershipKind: 'curated';
                            revision: number;
                            memberCount: number;
                            orderEpoch: number;
                            createdAt: string;
                            updatedAt: string;
                        } | {
                            presentationKind: import("./collection-kind.ts").CollectionKind['presentationKind'];
                            presentationKindSource: import("./collection-kind.ts").CollectionKind['presentationKindSource'];
                            cover: import("../semantic/summaries.ts").CoverSummary | null;
                            coverSource: 'owner' | 'member' | 'none' | 'pending';
                            id: string;
                            curatorAccountId: string | null;
                            title: string;
                            description: string | null;
                            visibility: import("./collection-model.ts").CollectionVisibility;
                            revision: number;
                            membershipKind: 'dynamic';
                            coverMediaId: string;
                        } | {
                            presentationKind: import("./collection-kind.ts").CollectionKind['presentationKind'];
                            presentationKindSource: import("./collection-kind.ts").CollectionKind['presentationKindSource'];
                            cover: import("../semantic/summaries.ts").CoverSummary | null;
                            coverSource: 'owner' | 'member' | 'none' | 'pending';
                            id: string;
                            curatorAccountId: string | null;
                            title: string;
                            description: string | null;
                            visibility: import("./collection-model.ts").CollectionVisibility;
                            membershipKind: 'curated';
                            revision: number;
                            memberCount: number;
                            orderEpoch: number;
                            createdAt: string;
                            updatedAt: string;
                            coverMediaId: string;
                        };
                    };
                    201: {
                        collection: {
                            id: string;
                            membershipKind: "curated";
                            curatorAccountId: string | null;
                            title: string;
                            description: string | null;
                            visibility: "private" | "public" | "unlisted";
                            presentationKind: string | null;
                            presentationKindSource: "mixed" | "owner";
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
                            coverSource: "member" | "none" | "owner" | "pending";
                            coverMediaId?: string | null;
                            revision: number;
                            memberCount: number;
                            orderEpoch: number;
                            createdAt: string;
                            updatedAt: string;
                        } | {
                            id: string;
                            curatorAccountId: string;
                            membershipKind: "dynamic";
                            builtinKind: "everything" | "liked" | "state";
                            builtin: {
                                kind: "everything";
                            } | {
                                kind: "liked";
                            } | {
                                kind: "state";
                                profileId: string;
                                stateSetId: string;
                                stateId: string;
                            };
                            builtinLabels?: Record<string, string>;
                            title: string | null;
                            description: string | null;
                            visibility: "private";
                            revision: number;
                            presentationKind: string | null;
                            presentationKindSource: "mixed" | "owner";
                            cover: null;
                            coverSource: "none";
                        } | {
                            id: string;
                            curatorAccountId: string | null;
                            title: string;
                            description: string | null;
                            visibility: "private" | "public" | "unlisted";
                            presentationKind: string | null;
                            presentationKindSource: "mixed" | "owner";
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
                            coverSource: "member" | "none" | "owner" | "pending";
                            coverMediaId?: string | null;
                            revision: number;
                            membershipKind: "dynamic";
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
} & {
    v1: {
        collections: {
            get: {
                body: unknown;
                params: {};
                query: {
                    view?: "BASIC" | "FULL";
                    cursor?: string;
                    limit?: string | number;
                    curatorAccountId: string | null;
                    preview?: string | number;
                };
                headers: unknown;
                response: {
                    200: {
                        collections: ({
                            curator?: {
                                id: string;
                                handle: string | null;
                                displayName: string | null;
                            } | null;
                            id: string;
                            membershipKind: "curated";
                            curatorAccountId: string | null;
                            title: string;
                            description: string | null;
                            visibility: "private" | "public" | "unlisted";
                            presentationKind: string | null;
                            presentationKindSource: "mixed" | "owner";
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
                            coverSource: "member" | "none" | "owner" | "pending";
                            coverMediaId?: string | null;
                            revision: number;
                            memberCount: number;
                            orderEpoch: number;
                            createdAt: string;
                            updatedAt: string;
                            previewMembers?: {
                                subjectId: string;
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
                            }[];
                            previewStatus?: "pending" | "ready";
                        } | {
                            curator?: {
                                id: string;
                                handle: string | null;
                                displayName: string | null;
                            } | null;
                            id: string;
                            curatorAccountId: string;
                            membershipKind: "dynamic";
                            builtinKind: "everything" | "liked" | "state";
                            builtin: {
                                kind: "everything";
                            } | {
                                kind: "liked";
                            } | {
                                kind: "state";
                                profileId: string;
                                stateSetId: string;
                                stateId: string;
                            };
                            builtinLabels?: Record<string, string>;
                            title: string | null;
                            description: string | null;
                            visibility: "private";
                            revision: number;
                            presentationKind: string | null;
                            presentationKindSource: "mixed" | "owner";
                            cover: null;
                            coverSource: "none";
                            previewMembers?: {
                                subjectId: string;
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
                            }[];
                            previewStatus?: "pending" | "ready";
                        } | {
                            curator?: {
                                id: string;
                                handle: string | null;
                                displayName: string | null;
                            } | null;
                            id: string;
                            curatorAccountId: string | null;
                            title: string;
                            description: string | null;
                            visibility: "private" | "public" | "unlisted";
                            presentationKind: string | null;
                            presentationKindSource: "mixed" | "owner";
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
                            coverSource: "member" | "none" | "owner" | "pending";
                            coverMediaId?: string | null;
                            revision: number;
                            previewMembers?: {
                                subjectId: string;
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
                            }[];
                            previewStatus?: "pending" | "ready";
                            membershipKind: "dynamic";
                        })[];
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
                        type: unknown;
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
        accounts: {
            ":accountId": {
                collections: {
                    get: {
                        body: unknown;
                        params: {
                            accountId: string;
                        };
                        query: {
                            view?: "BASIC" | "FULL";
                            cursor?: string;
                            limit?: string | number;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                collections: ({
                                    curator?: {
                                        id: string;
                                        handle: string | null;
                                        displayName: string | null;
                                    } | null;
                                    id: string;
                                    membershipKind: "curated";
                                    curatorAccountId: string | null;
                                    title: string;
                                    description: string | null;
                                    visibility: "private" | "public" | "unlisted";
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
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
                                    coverSource: "member" | "none" | "owner" | "pending";
                                    coverMediaId?: string | null;
                                    revision: number;
                                    memberCount: number;
                                    orderEpoch: number;
                                    createdAt: string;
                                    updatedAt: string;
                                } | {
                                    curator?: {
                                        id: string;
                                        handle: string | null;
                                        displayName: string | null;
                                    } | null;
                                    id: string;
                                    curatorAccountId: string;
                                    membershipKind: "dynamic";
                                    builtinKind: "everything" | "liked" | "state";
                                    builtin: {
                                        kind: "everything";
                                    } | {
                                        kind: "liked";
                                    } | {
                                        kind: "state";
                                        profileId: string;
                                        stateSetId: string;
                                        stateId: string;
                                    };
                                    builtinLabels?: Record<string, string>;
                                    title: string | null;
                                    description: string | null;
                                    visibility: "private";
                                    revision: number;
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
                                    cover: null;
                                    coverSource: "none";
                                } | {
                                    curator?: {
                                        id: string;
                                        handle: string | null;
                                        displayName: string | null;
                                    } | null;
                                    id: string;
                                    curatorAccountId: string | null;
                                    title: string;
                                    description: string | null;
                                    visibility: "private" | "public" | "unlisted";
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
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
                                    coverSource: "member" | "none" | "owner" | "pending";
                                    coverMediaId?: string | null;
                                    revision: number;
                                    membershipKind: "dynamic";
                                })[];
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
                                type: unknown;
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
        collections: {
            ":collectionId": {
                get: {
                    body: unknown;
                    params: {
                        collectionId: string;
                    };
                    query: {
                        view?: "BASIC" | "FULL";
                    };
                    headers: unknown;
                    response: {
                        200: {
                            collection: {
                                curator?: {
                                    id: string;
                                    handle: string | null;
                                    displayName: string | null;
                                } | null;
                                id: string;
                                membershipKind: "curated";
                                curatorAccountId: string | null;
                                title: string;
                                description: string | null;
                                visibility: "private" | "public" | "unlisted";
                                presentationKind: string | null;
                                presentationKindSource: "mixed" | "owner";
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
                                coverSource: "member" | "none" | "owner" | "pending";
                                coverMediaId?: string | null;
                                revision: number;
                                memberCount: number;
                                orderEpoch: number;
                                createdAt: string;
                                updatedAt: string;
                            } | {
                                curator?: {
                                    id: string;
                                    handle: string | null;
                                    displayName: string | null;
                                } | null;
                                id: string;
                                curatorAccountId: string;
                                membershipKind: "dynamic";
                                builtinKind: "everything" | "liked" | "state";
                                builtin: {
                                    kind: "everything";
                                } | {
                                    kind: "liked";
                                } | {
                                    kind: "state";
                                    profileId: string;
                                    stateSetId: string;
                                    stateId: string;
                                };
                                builtinLabels?: Record<string, string>;
                                title: string | null;
                                description: string | null;
                                visibility: "private";
                                revision: number;
                                presentationKind: string | null;
                                presentationKindSource: "mixed" | "owner";
                                cover: null;
                                coverSource: "none";
                            } | {
                                curator?: {
                                    id: string;
                                    handle: string | null;
                                    displayName: string | null;
                                } | null;
                                id: string;
                                curatorAccountId: string | null;
                                title: string;
                                description: string | null;
                                visibility: "private" | "public" | "unlisted";
                                presentationKind: string | null;
                                presentationKindSource: "mixed" | "owner";
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
                                coverSource: "member" | "none" | "owner" | "pending";
                                coverMediaId?: string | null;
                                revision: number;
                                membershipKind: "dynamic";
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
        collections: {
            ":collectionId": {
                rule: {
                    get: {
                        body: unknown;
                        params: {
                            collectionId: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                rule: {
                                    filter: unknown;
                                    sort: "id";
                                    releaseDigest: string;
                                    revision: number;
                                    collectionRevision: number;
                                    sourceGeneration: string;
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
        collections: {
            ":collectionId": {
                rule: {
                    put: {
                        body: {
                            filter: unknown;
                            sort?: string;
                            revision: number;
                        };
                        params: {
                            collectionId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                collection: {
                                    id: string;
                                    membershipKind: "curated";
                                    curatorAccountId: string | null;
                                    title: string;
                                    description: string | null;
                                    visibility: "private" | "public" | "unlisted";
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
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
                                    coverSource: "member" | "none" | "owner" | "pending";
                                    coverMediaId?: string | null;
                                    revision: number;
                                    memberCount: number;
                                    orderEpoch: number;
                                    createdAt: string;
                                    updatedAt: string;
                                } | {
                                    id: string;
                                    curatorAccountId: string;
                                    membershipKind: "dynamic";
                                    builtinKind: "everything" | "liked" | "state";
                                    builtin: {
                                        kind: "everything";
                                    } | {
                                        kind: "liked";
                                    } | {
                                        kind: "state";
                                        profileId: string;
                                        stateSetId: string;
                                        stateId: string;
                                    };
                                    builtinLabels?: Record<string, string>;
                                    title: string | null;
                                    description: string | null;
                                    visibility: "private";
                                    revision: number;
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
                                    cover: null;
                                    coverSource: "none";
                                } | {
                                    id: string;
                                    curatorAccountId: string | null;
                                    title: string;
                                    description: string | null;
                                    visibility: "private" | "public" | "unlisted";
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
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
                                    coverSource: "member" | "none" | "owner" | "pending";
                                    coverMediaId?: string | null;
                                    revision: number;
                                    membershipKind: "dynamic";
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
        collections: {
            ":collectionId": {
                patch: {
                    body: {
                        revision: number;
                        title?: string;
                        description?: string | null;
                        visibility?: "private" | "public" | "unlisted";
                        presentationKind?: string | null;
                        coverMediaId?: string | null;
                    };
                    params: {
                        collectionId: string;
                    };
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            collection: {
                                id: string;
                                membershipKind: "curated";
                                curatorAccountId: string | null;
                                title: string;
                                description: string | null;
                                visibility: "private" | "public" | "unlisted";
                                presentationKind: string | null;
                                presentationKindSource: "mixed" | "owner";
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
                                coverSource: "member" | "none" | "owner" | "pending";
                                coverMediaId?: string | null;
                                revision: number;
                                memberCount: number;
                                orderEpoch: number;
                                createdAt: string;
                                updatedAt: string;
                            } | {
                                id: string;
                                curatorAccountId: string;
                                membershipKind: "dynamic";
                                builtinKind: "everything" | "liked" | "state";
                                builtin: {
                                    kind: "everything";
                                } | {
                                    kind: "liked";
                                } | {
                                    kind: "state";
                                    profileId: string;
                                    stateSetId: string;
                                    stateId: string;
                                };
                                builtinLabels?: Record<string, string>;
                                title: string | null;
                                description: string | null;
                                visibility: "private";
                                revision: number;
                                presentationKind: string | null;
                                presentationKindSource: "mixed" | "owner";
                                cover: null;
                                coverSource: "none";
                            } | {
                                id: string;
                                curatorAccountId: string | null;
                                title: string;
                                description: string | null;
                                visibility: "private" | "public" | "unlisted";
                                presentationKind: string | null;
                                presentationKindSource: "mixed" | "owner";
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
                                coverSource: "member" | "none" | "owner" | "pending";
                                coverMediaId?: string | null;
                                revision: number;
                                membershipKind: "dynamic";
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
        collections: {
            ":collectionId": {
                delete: {
                    body: unknown;
                    params: {
                        collectionId: string;
                    };
                    query: {
                        revision: string | number;
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
} & {
    v1: {
        collections: {
            ":collectionId": {
                $restore: {
                    post: {
                        body: {
                            deletionId: string;
                            revision: number;
                        };
                        params: {
                            collectionId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                collection: {
                                    id: string;
                                    membershipKind: "curated";
                                    curatorAccountId: string | null;
                                    title: string;
                                    description: string | null;
                                    visibility: "private" | "public" | "unlisted";
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
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
                                    coverSource: "member" | "none" | "owner" | "pending";
                                    coverMediaId?: string | null;
                                    revision: number;
                                    memberCount: number;
                                    orderEpoch: number;
                                    createdAt: string;
                                    updatedAt: string;
                                } | {
                                    id: string;
                                    curatorAccountId: string;
                                    membershipKind: "dynamic";
                                    builtinKind: "everything" | "liked" | "state";
                                    builtin: {
                                        kind: "everything";
                                    } | {
                                        kind: "liked";
                                    } | {
                                        kind: "state";
                                        profileId: string;
                                        stateSetId: string;
                                        stateId: string;
                                    };
                                    builtinLabels?: Record<string, string>;
                                    title: string | null;
                                    description: string | null;
                                    visibility: "private";
                                    revision: number;
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
                                    cover: null;
                                    coverSource: "none";
                                } | {
                                    id: string;
                                    curatorAccountId: string | null;
                                    title: string;
                                    description: string | null;
                                    visibility: "private" | "public" | "unlisted";
                                    presentationKind: string | null;
                                    presentationKindSource: "mixed" | "owner";
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
                                    coverSource: "member" | "none" | "owner" | "pending";
                                    coverMediaId?: string | null;
                                    revision: number;
                                    membershipKind: "dynamic";
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
        collections: {
            ":collectionId": {
                members: {
                    get: {
                        body: unknown;
                        params: {
                            collectionId: string;
                        };
                        query: {
                            view?: "BASIC" | "FULL";
                            cursor?: string;
                            limit?: string | number;
                            filter?: string;
                            sort?: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                members: ({
                                    subject?: {
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
                                    } | {
                                        id: string;
                                        type: string;
                                        label: string;
                                    } | null;
                                    kind: "dynamic";
                                    subjectId: string;
                                    facts?: Record<string, ({
                                        kind: "item";
                                        id: string;
                                        labels: Record<string, string>;
                                    } | {
                                        kind: "time";
                                        year: number;
                                    } | {
                                        kind: "quantity";
                                        amount: number;
                                        unit: string;
                                    } | {
                                        kind: "code";
                                        value: string;
                                    })[]>;
                                } | {
                                    subject?: {
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
                                    } | {
                                        id: string;
                                        type: string;
                                        label: string;
                                    } | null;
                                    id: string;
                                    subjectId: string;
                                    note: string | null;
                                    addedAt: string;
                                    facts?: Record<string, ({
                                        kind: "item";
                                        id: string;
                                        labels: Record<string, string>;
                                    } | {
                                        kind: "time";
                                        year: number;
                                    } | {
                                        kind: "quantity";
                                        amount: number;
                                        unit: string;
                                    } | {
                                        kind: "code";
                                        value: string;
                                    })[]>;
                                })[];
                                next: string | null;
                            };
                            202: {
                                preparing: true;
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
        collections: {
            ":collectionId": {
                members: {
                    post: {
                        body: {
                            subjectId: string;
                            note?: string | null;
                            after?: string | null;
                        };
                        params: {
                            collectionId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                member: {
                                    id: string;
                                    subjectId: string;
                                    note: string | null;
                                    addedAt: string;
                                };
                            };
                            201: {
                                member: {
                                    id: string;
                                    subjectId: string;
                                    note: string | null;
                                    addedAt: string;
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
        collections: {
            ":collectionId": {
                members: {
                    $batchRemove: {
                        post: {
                            body: {
                                revision: number;
                                memberIds: string[];
                            };
                            params: {
                                collectionId: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    collection: {
                                        id: string;
                                        membershipKind: "curated";
                                        curatorAccountId: string | null;
                                        title: string;
                                        description: string | null;
                                        visibility: "private" | "public" | "unlisted";
                                        presentationKind: string | null;
                                        presentationKindSource: "mixed" | "owner";
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
                                        coverSource: "member" | "none" | "owner" | "pending";
                                        coverMediaId?: string | null;
                                        revision: number;
                                        memberCount: number;
                                        orderEpoch: number;
                                        createdAt: string;
                                        updatedAt: string;
                                    };
                                    removed: {
                                        memberId: string;
                                        deletionId: string;
                                        revision: number;
                                    }[];
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
        collections: {
            ":collectionId": {
                members: {
                    $move: {
                        post: {
                            body: {
                                revision: number;
                                memberIds: string[];
                                destinationCollectionId: string;
                                destinationRevision: number;
                                after: string | null;
                            };
                            params: {
                                collectionId: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    source: {
                                        id: string;
                                        membershipKind: "curated";
                                        curatorAccountId: string | null;
                                        title: string;
                                        description: string | null;
                                        visibility: "private" | "public" | "unlisted";
                                        presentationKind: string | null;
                                        presentationKindSource: "mixed" | "owner";
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
                                        coverSource: "member" | "none" | "owner" | "pending";
                                        coverMediaId?: string | null;
                                        revision: number;
                                        memberCount: number;
                                        orderEpoch: number;
                                        createdAt: string;
                                        updatedAt: string;
                                    };
                                    destination: {
                                        id: string;
                                        membershipKind: "curated";
                                        curatorAccountId: string | null;
                                        title: string;
                                        description: string | null;
                                        visibility: "private" | "public" | "unlisted";
                                        presentationKind: string | null;
                                        presentationKindSource: "mixed" | "owner";
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
                                        coverSource: "member" | "none" | "owner" | "pending";
                                        coverMediaId?: string | null;
                                        revision: number;
                                        memberCount: number;
                                        orderEpoch: number;
                                        createdAt: string;
                                        updatedAt: string;
                                    };
                                    members: {
                                        id: string;
                                        subjectId: string;
                                        note: string | null;
                                        addedAt: string;
                                    }[];
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
        collections: {
            ":collectionId": {
                members: {
                    ":memberId": {
                        patch: {
                            body: {
                                note: string | null;
                            };
                            params: {
                                collectionId: string;
                                memberId: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    member: {
                                        id: string;
                                        subjectId: string;
                                        note: string | null;
                                        addedAt: string;
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
        collections: {
            ":collectionId": {
                members: {
                    ":memberId": {
                        delete: {
                            body: unknown;
                            params: {
                                collectionId: string;
                                memberId: string;
                            };
                            query: {
                                revision: number;
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
} & {
    v1: {
        collections: {
            ":collectionId": {
                members: {
                    ":memberId": {
                        $restore: {
                            post: {
                                body: {
                                    deletionId: string;
                                    revision: number;
                                };
                                params: {
                                    collectionId: string;
                                    memberId: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        member: {
                                            id: string;
                                            subjectId: string;
                                            note: string | null;
                                            addedAt: string;
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
    };
} & {
    v1: {
        collections: {
            ":collectionId": {
                members: {
                    ":memberId": {
                        $move: {
                            post: {
                                body: {
                                    after?: string | null;
                                };
                                params: {
                                    collectionId: string;
                                    memberId: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        member: {
                                            id: string;
                                            subjectId: string;
                                            note: string | null;
                                            addedAt: string;
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
}, "get", "/v1/subjects/:id/collections", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    query: import("typebox").TObject<{
        view: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"BASIC">, import("typebox").TLiteral<"FULL">]>>;
        cursor: import("typebox").TOptional<import("typebox").TString>;
        limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
    }>;
    response: {
        400: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        403: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        409: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        422: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            count: import("typebox").TObject<{
                value: import("typebox").TInteger;
                exact: import("typebox").TLiteral<true>;
            }>;
            next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            collections: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                curatorAccountId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                title: import("typebox").TString;
                multiplicity: import("typebox").TInteger;
            } & {
                curator: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                    id: import("typebox").TString;
                    handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>, import("typebox").TNull]>>;
            }>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        'x-authority-resource-types': string[];
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
        'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
    } | {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        'x-resource-types': string[];
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
        'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
    };
}, {}, "/v1/subjects/:id/collections">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ params, query, actor, admission, job }: {
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
            count: {
                value: number;
                exact: true;
            };
            next: string | null;
            collections: {
                curator?: {
                    id: string;
                    handle: string | null;
                    displayName: string | null;
                } | null;
                id: string;
                curatorAccountId: string | null;
                title: string;
                multiplicity: number;
            }[];
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
            count: {
                value: number;
                exact: true;
            };
            next: string | null;
            collections: {
                curator?: {
                    id: string;
                    handle: string | null;
                    displayName: string | null;
                } | null;
                id: string;
                curatorAccountId: string | null;
                title: string;
                multiplicity: number;
            }[];
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            id: import("typebox").TString;
        }>;
        query: import("typebox").TObject<{
            view: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"BASIC">, import("typebox").TLiteral<"FULL">]>>;
            cursor: import("typebox").TOptional<import("typebox").TString>;
            limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
        }>;
        response: {
            400: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            401: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            403: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            404: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            409: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            422: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            200: import("typebox").TObject<{
                count: import("typebox").TObject<{
                    value: import("typebox").TInteger;
                    exact: import("typebox").TLiteral<true>;
                }>;
                next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                collections: import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TString;
                    curatorAccountId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    title: import("typebox").TString;
                    multiplicity: import("typebox").TInteger;
                } & {
                    curator: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                        id: import("typebox").TString;
                        handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    }>, import("typebox").TNull]>>;
                }>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-exposure': string;
            'x-action': string;
            'x-authority-resource-types': string[];
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
            'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        } | {
            operationId: string;
            'x-exposure': string;
            'x-action': string;
            'x-resource-types': string[];
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
            'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        };
    }, {}, "/v1/subjects/:id/collections">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
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
        view?: "BASIC" | "FULL";
        cursor?: string;
        limit?: number;
    };
    params: {
        id: string;
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
    collections: ({
        id: string;
        curatorAccountId: string | null;
        title: string;
        multiplicity: number;
    } & object)[];
    count: {
        value: number;
        exact: true;
    } & object;
    next: string | null;
} & object>, {
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    query: import("typebox").TObject<{
        view: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"BASIC">, import("typebox").TLiteral<"FULL">]>>;
        cursor: import("typebox").TOptional<import("typebox").TString>;
        limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TNumber, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
    }>;
    response: {
        400: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        403: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        409: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        422: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            count: import("typebox").TObject<{
                value: import("typebox").TInteger;
                exact: import("typebox").TLiteral<true>;
            }>;
            next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            collections: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                curatorAccountId: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                title: import("typebox").TString;
                multiplicity: import("typebox").TInteger;
            } & {
                curator: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                    id: import("typebox").TString;
                    handle: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    displayName: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>, import("typebox").TNull]>>;
            }>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        'x-authority-resource-types': string[];
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
        'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
    } | {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        'x-resource-types': string[];
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
        'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
    };
}>;
export {};
