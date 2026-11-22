import type { Pool } from 'pg';
import type { createApp } from '../http/app.ts';
import { type Admission } from '../http/request.ts';
import { type AccessCheck, type Resource } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
type Request = Readonly<{
    accountId: string;
    deadline: number;
}>;
type Command = Request & Readonly<{
    operationId: string;
}>;
type PrivateListing = Readonly<{
    listingId: string;
    itemId: string;
    generation: string;
    assetId: string;
    amount: string;
    expiresAt: string;
    revision: string;
    status: 'open' | 'cancelled' | 'purchased';
}>;
type PrivateTrade = Readonly<{
    tradeId: string;
    listingId: string;
    status: 'preparing' | 'committing' | 'aborting' | 'completed' | 'aborted';
    assetId: string;
    amount: string;
    fee: string;
    sellerNet: string;
}>;
type MarketPagePosition = readonly [time: string, id: string];
type PageRequest = Request & {
    limit: number;
    after: MarketPagePosition | null;
};
type ListedTrade = PrivateTrade & Readonly<{
    startedAt: string;
}>;
/** The mounted transport accepts a caller identity. The native port proves it again before each owner operation. */
export interface EconomyMarketPort {
    readonly bookId: string;
    readonly itemHomeId: string;
    readListing(input: Request & {
        listingId: string;
    }): Promise<PrivateListing>;
    listListings(input: PageRequest): Promise<{
        listings: PrivateListing[];
        after: MarketPagePosition | null;
    }>;
    readTrade(input: Request & {
        tradeId: string;
    }): Promise<PrivateTrade>;
    listTrades(input: PageRequest): Promise<{
        trades: ListedTrade[];
        after: MarketPagePosition | null;
    }>;
    createListing(input: Command & {
        itemId: string;
        generation: string;
        assetId: string;
        amount: string;
    }): Promise<{
        listingId: string;
    }>;
    buy(input: Command & {
        listingId: string;
        revision: string;
    }): Promise<{
        tradeId: string;
    }>;
    cancel(input: Command & {
        listingId: string;
        revision: string;
    }): Promise<{
        listingId: string;
    }>;
}
export declare function economyMarketRoutes(app: ReturnType<typeof createApp>, deps: {
    pool: Pool;
    cursorKeys: KeyRing;
    clock: () => Date;
    market?: EconomyMarketPort;
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
        economy: {
            market: {
                listings: {
                    post: {
                        body: {
                            itemId: string;
                            generation: string;
                            assetId: string;
                            amount: string;
                        };
                        params: {};
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                listingId: string;
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
} & {
    v1: {
        economy: {
            market: {
                listings: {
                    get: {
                        body: unknown;
                        params: {};
                        query: {
                            limit?: string | number;
                            cursor?: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                listings: {
                                    listingId: string;
                                    itemId: string;
                                    generation: string;
                                    assetId: string;
                                    amount: string;
                                    expiresAt: string;
                                    revision: string;
                                    status: "cancelled" | "open" | "purchased";
                                }[];
                                next: string | null;
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
} & {
    v1: {
        economy: {
            market: {
                listings: {
                    ":listingId": {
                        get: {
                            body: unknown;
                            params: {
                                listingId: string;
                            };
                            query: unknown;
                            headers: unknown;
                            response: {
                                200: {
                                    listingId: string;
                                    itemId: string;
                                    generation: string;
                                    assetId: string;
                                    amount: string;
                                    expiresAt: string;
                                    revision: string;
                                    status: "cancelled" | "open" | "purchased";
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
} & {
    v1: {
        economy: {
            market: {
                listings: {
                    ":listingId": {
                        purchases: {
                            post: {
                                body: {
                                    revision: string;
                                };
                                params: {
                                    listingId: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        tradeId: string;
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
    };
} & {
    v1: {
        economy: {
            market: {
                listings: {
                    ":listingId": {
                        cancel: {
                            post: {
                                body: {
                                    revision: string;
                                };
                                params: {
                                    listingId: string;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        listingId: string;
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
    };
} & {
    v1: {
        economy: {
            market: {
                trades: {
                    get: {
                        body: unknown;
                        params: {};
                        query: {
                            limit?: string | number;
                            cursor?: string;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                trades: {
                                    tradeId: string;
                                    listingId: string;
                                    assetId: string;
                                    amount: string;
                                    fee: string;
                                    sellerNet: string;
                                    status: "aborted" | "aborting" | "committing" | "completed" | "preparing";
                                    startedAt: string;
                                }[];
                                next: string | null;
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
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: Admission;
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
        readonly authorize: (resource: Resource, permit?: import("../http/admission.ts").AdmissionYield) => Promise<AccessCheck>;
        readonly authorizeCommand: (resource: Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "get", "/v1/economy/market/trades/:tradeId", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        tradeId: import("typebox").TString;
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
            tradeId: import("typebox").TString;
            listingId: import("typebox").TString;
            assetId: import("typebox").TString;
            amount: import("typebox").TString;
            fee: import("typebox").TString;
            sellerNet: import("typebox").TString;
            status: import("typebox").TUnion<[import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"committing">, import("typebox").TLiteral<"aborting">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"aborted">]>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': "market:buy" | "market:cancel" | "market:list" | "market:read";
        'x-authority-anchor': string;
        'x-authority-resource-types': string[];
        security: {
            bearerAuth: never[];
        }[];
    };
}, {}, "/v1/economy/market/trades/:tradeId">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, (ctx: {
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
            tradeId: string;
            listingId: string;
            assetId: string;
            amount: string;
            fee: string;
            sellerNet: string;
            status: "aborted" | "aborting" | "committing" | "completed" | "preparing";
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
            tradeId: string;
            listingId: string;
            assetId: string;
            amount: string;
            fee: string;
            sellerNet: string;
            status: "aborted" | "aborting" | "committing" | "completed" | "preparing";
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            tradeId: import("typebox").TString;
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
                tradeId: import("typebox").TString;
                listingId: import("typebox").TString;
                assetId: import("typebox").TString;
                amount: import("typebox").TString;
                fee: import("typebox").TString;
                sellerNet: import("typebox").TString;
                status: import("typebox").TUnion<[import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"committing">, import("typebox").TLiteral<"aborting">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"aborted">]>;
            }>;
        };
        detail: {
            operationId: string;
            'x-exposure': string;
            'x-action': "market:buy" | "market:cancel" | "market:list" | "market:read";
            'x-authority-anchor': string;
            'x-authority-resource-types': string[];
            security: {
                bearerAuth: never[];
            }[];
        };
    }, {}, "/v1/economy/market/trades/:tradeId">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: Admission;
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
            readonly authorize: (resource: Resource, permit?: import("../http/admission.ts").AdmissionYield) => Promise<AccessCheck>;
            readonly authorizeCommand: (resource: Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: globalThis.Request;
    store: {};
    body: unknown;
    query: Record<string, string | undefined>;
    params: {
        tradeId: string;
    };
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: Admission;
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
    readonly authorize: (resource: Resource, permit?: import("../http/admission.ts").AdmissionYield) => Promise<AccessCheck>;
    readonly authorizeCommand: (resource: Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<Readonly<{
    tradeId: string;
    listingId: string;
    status: 'preparing' | 'committing' | 'aborting' | 'completed' | 'aborted';
    assetId: string;
    amount: string;
    fee: string;
    sellerNet: string;
}>>, {
    params: import("typebox").TObject<{
        tradeId: import("typebox").TString;
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
            tradeId: import("typebox").TString;
            listingId: import("typebox").TString;
            assetId: import("typebox").TString;
            amount: import("typebox").TString;
            fee: import("typebox").TString;
            sellerNet: import("typebox").TString;
            status: import("typebox").TUnion<[import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"committing">, import("typebox").TLiteral<"aborting">, import("typebox").TLiteral<"completed">, import("typebox").TLiteral<"aborted">]>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': "market:buy" | "market:cancel" | "market:list" | "market:read";
        'x-authority-anchor': string;
        'x-authority-resource-types': string[];
        security: {
            bearerAuth: never[];
        }[];
    };
}>;
export {};
