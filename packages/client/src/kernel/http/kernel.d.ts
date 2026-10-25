import { createApp } from './app.ts';
export type KernelDependencies = Parameters<typeof createApp>[0] & {
    routeKey: Uint8Array;
};
/** The route key must stay the same across restarts, or retries lose their receipts. */
export declare function createKernel(dependencies: KernelDependencies): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
    response: import("elysia/types").ExtractErrorFromHandle<Response>;
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
                            type: "schema:Book";
                            labels: Record<string, string>;
                            descriptions: Record<string, string>;
                            aliases: Record<string, string[]>;
                            statements: Record<string, {
                                id: string;
                                rank: "deprecated" | "normal" | "preferred";
                                property: {
                                    id: string;
                                    data_type: import("../semantic/profile.ts").DataType;
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
                                        data_type: import("../semantic/profile.ts").DataType;
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
                                            data_type: import("../semantic/profile.ts").DataType;
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
                            }[]>;
                        };
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    403: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("./admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").Actor;
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
}, "get", "/v1/subjects/:id", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    response: {
        200: import("typebox").TObject<{
            subject: import("typebox").TObject<{
                id: import("typebox").TString;
                type: import("typebox").TLiteral<"schema:Book">;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                descriptions: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                aliases: import("typebox").TRecord<"^.*$", import("typebox").TArray<import("typebox").TString>>;
                statements: import("typebox").TRecord<"^.*$", import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TString;
                    rank: import("typebox").TUnion<[import("typebox").TLiteral<"normal">, import("typebox").TLiteral<"preferred">, import("typebox").TLiteral<"deprecated">]>;
                    property: import("typebox").TObject<{
                        id: import("typebox").TString;
                        data_type: import("typebox").TUnsafe<import("../semantic/profile.ts").DataType>;
                    }>;
                    value: import("typebox").TUnion<[import("typebox").TObject<{
                        type: import("typebox").TLiteral<"value">;
                        content: import("typebox").TAny;
                    }>, import("typebox").TObject<{
                        type: import("typebox").TLiteral<"somevalue">;
                    }>, import("typebox").TObject<{
                        type: import("typebox").TLiteral<"novalue">;
                    }>]>;
                    qualifiers: import("typebox").TArray<import("typebox").TObject<{
                        property: import("typebox").TObject<{
                            id: import("typebox").TString;
                            data_type: import("typebox").TUnsafe<import("../semantic/profile.ts").DataType>;
                        }>;
                        value: import("typebox").TUnion<[import("typebox").TObject<{
                            type: import("typebox").TLiteral<"value">;
                            content: import("typebox").TAny;
                        }>, import("typebox").TObject<{
                            type: import("typebox").TLiteral<"somevalue">;
                        }>, import("typebox").TObject<{
                            type: import("typebox").TLiteral<"novalue">;
                        }>]>;
                    }>>;
                    references: import("typebox").TArray<import("typebox").TObject<{
                        parts: import("typebox").TArray<import("typebox").TObject<{
                            property: import("typebox").TObject<{
                                id: import("typebox").TString;
                                data_type: import("typebox").TUnsafe<import("../semantic/profile.ts").DataType>;
                            }>;
                            value: import("typebox").TUnion<[import("typebox").TObject<{
                                type: import("typebox").TLiteral<"value">;
                                content: import("typebox").TAny;
                            }>, import("typebox").TObject<{
                                type: import("typebox").TLiteral<"somevalue">;
                            }>, import("typebox").TObject<{
                                type: import("typebox").TLiteral<"novalue">;
                            }>]>;
                        }>>;
                        hash: import("typebox").TString;
                    }>>;
                }>>>;
            }>;
            related: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>>;
        }> & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
            };
        };
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}, {}, "/v1/subjects/:id">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ params, authorize, admission, job, session }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        200: {
            subject: {
                id: string;
                type: "schema:Book";
                labels: Record<string, string>;
                descriptions: Record<string, string>;
                aliases: Record<string, string[]>;
                statements: Record<string, {
                    id: string;
                    rank: "deprecated" | "normal" | "preferred";
                    property: {
                        id: string;
                        data_type: import("../semantic/profile.ts").DataType;
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
                            data_type: import("../semantic/profile.ts").DataType;
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
                                data_type: import("../semantic/profile.ts").DataType;
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
                }[]>;
            };
            related: Record<string, {
                labels: Record<string, string>;
            }>;
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        200: {
            subject: {
                id: string;
                type: "schema:Book";
                labels: Record<string, string>;
                descriptions: Record<string, string>;
                aliases: Record<string, string[]>;
                statements: Record<string, {
                    id: string;
                    rank: "deprecated" | "normal" | "preferred";
                    property: {
                        id: string;
                        data_type: import("../semantic/profile.ts").DataType;
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
                            data_type: import("../semantic/profile.ts").DataType;
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
                                data_type: import("../semantic/profile.ts").DataType;
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
                }[]>;
            };
            related: Record<string, {
                labels: Record<string, string>;
            }>;
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            id: import("typebox").TString;
        }>;
        response: {
            200: import("typebox").TObject<{
                subject: import("typebox").TObject<{
                    id: import("typebox").TString;
                    type: import("typebox").TLiteral<"schema:Book">;
                    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    descriptions: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    aliases: import("typebox").TRecord<"^.*$", import("typebox").TArray<import("typebox").TString>>;
                    statements: import("typebox").TRecord<"^.*$", import("typebox").TArray<import("typebox").TObject<{
                        id: import("typebox").TString;
                        rank: import("typebox").TUnion<[import("typebox").TLiteral<"normal">, import("typebox").TLiteral<"preferred">, import("typebox").TLiteral<"deprecated">]>;
                        property: import("typebox").TObject<{
                            id: import("typebox").TString;
                            data_type: import("typebox").TUnsafe<import("../semantic/profile.ts").DataType>;
                        }>;
                        value: import("typebox").TUnion<[import("typebox").TObject<{
                            type: import("typebox").TLiteral<"value">;
                            content: import("typebox").TAny;
                        }>, import("typebox").TObject<{
                            type: import("typebox").TLiteral<"somevalue">;
                        }>, import("typebox").TObject<{
                            type: import("typebox").TLiteral<"novalue">;
                        }>]>;
                        qualifiers: import("typebox").TArray<import("typebox").TObject<{
                            property: import("typebox").TObject<{
                                id: import("typebox").TString;
                                data_type: import("typebox").TUnsafe<import("../semantic/profile.ts").DataType>;
                            }>;
                            value: import("typebox").TUnion<[import("typebox").TObject<{
                                type: import("typebox").TLiteral<"value">;
                                content: import("typebox").TAny;
                            }>, import("typebox").TObject<{
                                type: import("typebox").TLiteral<"somevalue">;
                            }>, import("typebox").TObject<{
                                type: import("typebox").TLiteral<"novalue">;
                            }>]>;
                        }>>;
                        references: import("typebox").TArray<import("typebox").TObject<{
                            parts: import("typebox").TArray<import("typebox").TObject<{
                                property: import("typebox").TObject<{
                                    id: import("typebox").TString;
                                    data_type: import("typebox").TUnsafe<import("../semantic/profile.ts").DataType>;
                                }>;
                                value: import("typebox").TUnion<[import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"value">;
                                    content: import("typebox").TAny;
                                }>, import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"somevalue">;
                                }>, import("typebox").TObject<{
                                    type: import("typebox").TLiteral<"novalue">;
                                }>]>;
                            }>>;
                            hash: import("typebox").TString;
                        }>>;
                    }>>>;
                }>;
                related: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                }>>;
            }> & {
                headers: {
                    readonly "rezics-session-token": import("typebox").TString;
                };
            };
            401: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            404: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-action': string;
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
        };
    }, {}, "/v1/subjects/:id">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("./admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").Actor;
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
        id: string;
    };
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("./admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    subject: import("../semantic/item.ts").Item;
    related: Record<string, {
        labels: Record<string, string>;
    }>;
}>, {
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    response: {
        200: import("typebox").TObject<{
            subject: import("typebox").TObject<{
                id: import("typebox").TString;
                type: import("typebox").TLiteral<"schema:Book">;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                descriptions: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                aliases: import("typebox").TRecord<"^.*$", import("typebox").TArray<import("typebox").TString>>;
                statements: import("typebox").TRecord<"^.*$", import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TString;
                    rank: import("typebox").TUnion<[import("typebox").TLiteral<"normal">, import("typebox").TLiteral<"preferred">, import("typebox").TLiteral<"deprecated">]>;
                    property: import("typebox").TObject<{
                        id: import("typebox").TString;
                        data_type: import("typebox").TUnsafe<import("../semantic/profile.ts").DataType>;
                    }>;
                    value: import("typebox").TUnion<[import("typebox").TObject<{
                        type: import("typebox").TLiteral<"value">;
                        content: import("typebox").TAny;
                    }>, import("typebox").TObject<{
                        type: import("typebox").TLiteral<"somevalue">;
                    }>, import("typebox").TObject<{
                        type: import("typebox").TLiteral<"novalue">;
                    }>]>;
                    qualifiers: import("typebox").TArray<import("typebox").TObject<{
                        property: import("typebox").TObject<{
                            id: import("typebox").TString;
                            data_type: import("typebox").TUnsafe<import("../semantic/profile.ts").DataType>;
                        }>;
                        value: import("typebox").TUnion<[import("typebox").TObject<{
                            type: import("typebox").TLiteral<"value">;
                            content: import("typebox").TAny;
                        }>, import("typebox").TObject<{
                            type: import("typebox").TLiteral<"somevalue">;
                        }>, import("typebox").TObject<{
                            type: import("typebox").TLiteral<"novalue">;
                        }>]>;
                    }>>;
                    references: import("typebox").TArray<import("typebox").TObject<{
                        parts: import("typebox").TArray<import("typebox").TObject<{
                            property: import("typebox").TObject<{
                                id: import("typebox").TString;
                                data_type: import("typebox").TUnsafe<import("../semantic/profile.ts").DataType>;
                            }>;
                            value: import("typebox").TUnion<[import("typebox").TObject<{
                                type: import("typebox").TLiteral<"value">;
                                content: import("typebox").TAny;
                            }>, import("typebox").TObject<{
                                type: import("typebox").TLiteral<"somevalue">;
                            }>, import("typebox").TObject<{
                                type: import("typebox").TLiteral<"novalue">;
                            }>]>;
                        }>>;
                        hash: import("typebox").TString;
                    }>>;
                }>>>;
            }>;
            related: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>>;
        }> & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
            };
        };
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}>;
/** The app's type is the Eden contract. */
export type Kernel = ReturnType<typeof createKernel>;
