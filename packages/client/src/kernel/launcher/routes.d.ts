import type { Pool } from 'pg';
import type { createApp } from '../http/app.ts';
import type { KeyRing } from '../tokens/seal.ts';
export declare function launcherDistributionRoutes(app: ReturnType<typeof createApp>, config: {
    pool: Pool;
    clock: () => Date;
    tokens: KeyRing;
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
        launcher: {
            packages: {
                get: {
                    body: unknown;
                    params: {};
                    query: {
                        kind: "minecraft-mod" | "overlay-panel";
                        q?: string;
                        cursor?: string;
                    };
                    headers: unknown;
                    response: {
                        200: {
                            items: {
                                id: string;
                                kind: "minecraft-mod" | "overlay-panel";
                                publisher: string;
                                title: string;
                                summary: string;
                                subjectId?: string;
                            }[];
                            nextCursor: string | null;
                        };
                        400: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
        launcher: {
            packages: {
                ":packageId": {
                    get: {
                        body: unknown;
                        params: {
                            packageId: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                id: string;
                                kind: "minecraft-mod" | "overlay-panel";
                                publisher: string;
                                title: string;
                                summary: string;
                                subjectId?: string;
                            };
                            400: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
        launcher: {
            packages: {
                ":packageId": {
                    releases: {
                        get: {
                            body: unknown;
                            params: {
                                packageId: string;
                            };
                            query: {
                                cursor?: string;
                            };
                            headers: unknown;
                            response: {
                                200: {
                                    items: {
                                        packageId: string;
                                        id: string;
                                        version: string;
                                        compatibility: {
                                            kind: "overlay-panel";
                                            launcherRange: string;
                                        } | {
                                            kind: "minecraft-mod";
                                            gameVersion: string;
                                            loader: "fabric";
                                        };
                                        artifact: {
                                            url: string;
                                            size: number;
                                            sha256: string;
                                        };
                                        requires: {
                                            packageId: string;
                                            releaseId: string;
                                        }[];
                                    }[];
                                    nextCursor: string | null;
                                };
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
        launcher: {
            packages: {
                ":packageId": {
                    releases: {
                        ":releaseId": {
                            get: {
                                body: unknown;
                                params: {
                                    packageId: string;
                                    releaseId: string;
                                };
                                query: unknown;
                                headers: unknown;
                                response: {
                                    200: {
                                        packageId: string;
                                        id: string;
                                        version: string;
                                        compatibility: {
                                            kind: "overlay-panel";
                                            launcherRange: string;
                                        } | {
                                            kind: "minecraft-mod";
                                            gameVersion: string;
                                            loader: "fabric";
                                        };
                                        artifact: {
                                            url: string;
                                            size: number;
                                            sha256: string;
                                        };
                                        requires: {
                                            packageId: string;
                                            releaseId: string;
                                        }[];
                                    };
                                    400: Response | {
                                        type: unknown;
                                        title: unknown;
                                        status: number;
                                        code: unknown;
                                        retryable: unknown;
                                        effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                        effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                        effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                        effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
        launcher: {
            packages: {
                ":packageId": {
                    releases: {
                        post: {
                            body: {
                                package: {
                                    id: string;
                                    kind: "minecraft-mod" | "overlay-panel";
                                    publisher: string;
                                    title: string;
                                    summary: string;
                                    subjectId?: string;
                                };
                                release: {
                                    packageId: string;
                                    id: string;
                                    version: string;
                                    compatibility: {
                                        kind: "overlay-panel";
                                        launcherRange: string;
                                    } | {
                                        kind: "minecraft-mod";
                                        gameVersion: string;
                                        loader: "fabric";
                                    };
                                    artifact: {
                                        url: string;
                                        size: number;
                                        sha256: string;
                                    };
                                    requires: {
                                        packageId: string;
                                        releaseId: string;
                                    }[];
                                };
                            };
                            params: {
                                packageId: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    packageId: string;
                                    id: string;
                                    version: string;
                                    compatibility: {
                                        kind: "overlay-panel";
                                        launcherRange: string;
                                    } | {
                                        kind: "minecraft-mod";
                                        gameVersion: string;
                                        loader: "fabric";
                                    };
                                    artifact: {
                                        url: string;
                                        size: number;
                                        sha256: string;
                                    };
                                    requires: {
                                        packageId: string;
                                        releaseId: string;
                                    }[];
                                };
                                201: {
                                    packageId: string;
                                    id: string;
                                    version: string;
                                    compatibility: {
                                        kind: "overlay-panel";
                                        launcherRange: string;
                                    } | {
                                        kind: "minecraft-mod";
                                        gameVersion: string;
                                        loader: "fabric";
                                    };
                                    artifact: {
                                        url: string;
                                        size: number;
                                        sha256: string;
                                    };
                                    requires: {
                                        packageId: string;
                                        releaseId: string;
                                    }[];
                                };
                                400: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                413: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
                                    request_id: string;
                                    detail: unknown;
                                    errors: unknown;
                                };
                                429: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
                                    effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
        readonly authorize: (resource: import("../request/access.ts").Resource, permit?: import("../http/admission.ts").AdmissionYield) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "post", "/v1/launcher/packages/:packageId/releases/:releaseId/$withdraw", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    params: import("typebox").TObject<{
        packageId: import("typebox").TString;
        releaseId: import("typebox").TString;
    }>;
    response: {
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        413: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        429: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            withdrawn: import("typebox").TLiteral<true>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        'x-exposure': string;
        'x-authority-resource-types': string[];
        'x-authority-resource-id': "00000000-0000-8000-8000-000000000000";
        'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        security: {
            bearerAuth: never[];
        }[];
    };
}, {}, "/v1/launcher/packages/:packageId/releases/:releaseId/$withdraw">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ actor, headers, params, job, session, admission, authorizeCommand }: {
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        413: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        429: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        200: {
            withdrawn: true;
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        413: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        429: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
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
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        200: {
            withdrawn: true;
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        headers: import("typebox").TObject<{
            "idempotency-key": import("typebox").TString;
        }>;
        params: import("typebox").TObject<{
            packageId: import("typebox").TString;
            releaseId: import("typebox").TString;
        }>;
        response: {
            400: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            413: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            429: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            200: import("typebox").TObject<{
                withdrawn: import("typebox").TLiteral<true>;
            }>;
        };
        detail: {
            operationId: string;
            'x-action': string;
            'x-exposure': string;
            'x-authority-resource-types': string[];
            'x-authority-resource-id': "00000000-0000-8000-8000-000000000000";
            'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            security: {
                bearerAuth: never[];
            }[];
        };
    }, {}, "/v1/launcher/packages/:packageId/releases/:releaseId/$withdraw">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
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
            readonly authorize: (resource: import("../request/access.ts").Resource, permit?: import("../http/admission.ts").AdmissionYield) => Promise<import("../request/access.ts").AccessCheck>;
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
        packageId: string;
        releaseId: string;
    };
    headers: {
        "idempotency-key": string;
    };
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
    readonly authorize: (resource: import("../request/access.ts").Resource, permit?: import("../http/admission.ts").AdmissionYield) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    withdrawn: true;
}>, {
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    params: import("typebox").TObject<{
        packageId: import("typebox").TString;
        releaseId: import("typebox").TString;
    }>;
    response: {
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        413: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        429: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
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
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            withdrawn: import("typebox").TLiteral<true>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        'x-exposure': string;
        'x-authority-resource-types': string[];
        'x-authority-resource-id': "00000000-0000-8000-8000-000000000000";
        'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        security: {
            bearerAuth: never[];
        }[];
    };
}>;
