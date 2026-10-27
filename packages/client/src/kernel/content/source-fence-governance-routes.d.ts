import { type SourceFenceDependencies } from './source-fence-command.ts';
import type { sourceFenceRoutes } from './source-fence-routes.ts';
export declare function sourceFenceGovernanceRoutes(app: ReturnType<typeof sourceFenceRoutes>, deps: SourceFenceDependencies): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
                        409: {
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
                        422: Response | {
                            type: 'validation';
                            code: 'validation';
                            title: 'Validation Error';
                            status: 422;
                            detail?: string;
                            on: string;
                            found?: unknown;
                            property?: string;
                            expected?: string;
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
                            409: {
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
                            409: {
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
                            409: {
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
                                    409: {
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
                                    409: {
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
                                    409: {
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
                                    409: {
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
                                    409: {
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
                            409: {
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
                                candidates: {
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
                                }[];
                                adoption: {
                                    mode: "inherit" | "replace" | "suppress";
                                    head: number;
                                } | null;
                                next: string | null;
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
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
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
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
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
                                    count: number;
                                    cursor: string;
                                }[];
                            };
                            308: {
                                redirect: {
                                    from: string;
                                    to: string;
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
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
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
                                    type?: string;
                                    label?: string;
                                    summary?: {
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
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
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
                                    target: string | null;
                                    external: string | null;
                                    type?: string;
                                    label?: string;
                                }[];
                                count: {
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
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
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
                            409: {
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
                            409: {
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
                                409: {
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
                                        409: {
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
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        sourceFences: {
            $check: {
                get: {
                    body: unknown;
                    params: {};
                    query: {
                        source: string;
                        externalId: string;
                        fieldGroup: "cover" | "facts" | "summary";
                    };
                    headers: unknown;
                    response: {
                        200: {
                            fenced: boolean;
                            securityRevision: string | null;
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
                            type: 'validation';
                            code: 'validation';
                            title: 'Validation Error';
                            status: 422;
                            detail?: string;
                            on: string;
                            found?: unknown;
                            property?: string;
                            expected?: string;
                        };
                        500: {
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
    };
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("./reads.ts").Actor;
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
}, "post", "/v1/sourceFences/$takedown", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    parse: unknown;
    transform: unknown;
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    body: {
        '~standard': {
            version: 1;
            vendor: string;
            types: {
                input: {
                    source: string;
                    externalId: string;
                    fieldGroup: "cover" | "facts" | "summary";
                    reason: string;
                };
                output: {
                    source: string;
                    externalId: string;
                    fieldGroup: "cover" | "facts" | "summary";
                    reason: string;
                };
            } | undefined;
            validate(value: unknown): {
                value: {
                    source: string;
                    externalId: string;
                    fieldGroup: "cover" | "facts" | "summary";
                    reason: string;
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
                    source: import("typebox").TString;
                    externalId: import("typebox").TString;
                    fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                    reason: import("typebox").TString;
                }>;
                output: () => import("typebox").TObject<{
                    source: import("typebox").TString;
                    externalId: import("typebox").TString;
                    fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                    reason: import("typebox").TString;
                }>;
            };
        };
    };
    response: {
        200: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: {
                        securityRevision: string;
                    };
                    output: {
                        securityRevision: string;
                    };
                } | undefined;
                validate(value: unknown): {
                    value: {
                        securityRevision: string;
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
                        securityRevision: import("typebox").TString;
                    }>;
                    output: () => import("typebox").TObject<{
                        securityRevision: import("typebox").TString;
                    }>;
                };
            };
        } & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
                readonly 'cache-control': import("typebox").TString;
            };
        };
        400: import("typebox").TObject<{
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
        403: import("typebox").TObject<{
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
        413: import("typebox").TObject<{
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
        422: import("typebox").TObject<{
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
        429: import("typebox").TObject<{
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
        500: import("typebox").TObject<{
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
        'x-exposure': string;
        'x-action': string;
        'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        security: {
            bearerAuth: never[];
        }[];
    };
}, {}, "/v1/sourceFences/$takedown">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ actor, body, request, admission, job, session, set }: {
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
            securityRevision: string;
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
        413: {
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
        422: {
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
        429: {
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
        500: {
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
            securityRevision: string;
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
        413: {
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
        422: {
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
        429: {
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
        500: {
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
        parse: unknown;
        transform: unknown;
        headers: import("typebox").TObject<{
            "idempotency-key": import("typebox").TString;
        }>;
        body: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: {
                        source: string;
                        externalId: string;
                        fieldGroup: "cover" | "facts" | "summary";
                        reason: string;
                    };
                    output: {
                        source: string;
                        externalId: string;
                        fieldGroup: "cover" | "facts" | "summary";
                        reason: string;
                    };
                } | undefined;
                validate(value: unknown): {
                    value: {
                        source: string;
                        externalId: string;
                        fieldGroup: "cover" | "facts" | "summary";
                        reason: string;
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
                        source: import("typebox").TString;
                        externalId: import("typebox").TString;
                        fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                        reason: import("typebox").TString;
                    }>;
                    output: () => import("typebox").TObject<{
                        source: import("typebox").TString;
                        externalId: import("typebox").TString;
                        fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                        reason: import("typebox").TString;
                    }>;
                };
            };
        };
        response: {
            200: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            securityRevision: string;
                        };
                        output: {
                            securityRevision: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            securityRevision: string;
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
                            securityRevision: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            securityRevision: import("typebox").TString;
                        }>;
                    };
                };
            } & {
                headers: {
                    readonly "rezics-session-token": import("typebox").TString;
                    readonly 'cache-control': import("typebox").TString;
                };
            };
            400: import("typebox").TObject<{
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
            403: import("typebox").TObject<{
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
            413: import("typebox").TObject<{
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
            422: import("typebox").TObject<{
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
            429: import("typebox").TObject<{
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
            500: import("typebox").TObject<{
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
            'x-exposure': string;
            'x-action': string;
            'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            security: {
                bearerAuth: never[];
            }[];
        };
    }, {}, "/v1/sourceFences/$takedown">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("../http/admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("./reads.ts").Actor;
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
    body: {
        source: string;
        externalId: string;
        fieldGroup: "cover" | "facts" | "summary";
        reason: string;
    };
    query: Record<string, string | undefined>;
    params: {};
    headers: {
        "idempotency-key": string;
    };
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("../http/admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("./reads.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    securityRevision: string;
}>, {
    parse: ("json" | (({ request, contentType }: {
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
                securityRevision: string;
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
            413: {
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
            422: {
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
            429: {
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
            500: {
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
                securityRevision: string;
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
            413: {
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
            422: {
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
            429: {
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
            500: {
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
        defer: (fn: import("elysia/types").AfterResponseHandler<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
            parse: unknown;
            transform: unknown;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            source: string;
                            externalId: string;
                            fieldGroup: "cover" | "facts" | "summary";
                            reason: string;
                        };
                        output: {
                            source: string;
                            externalId: string;
                            fieldGroup: "cover" | "facts" | "summary";
                            reason: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            source: string;
                            externalId: string;
                            fieldGroup: "cover" | "facts" | "summary";
                            reason: string;
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
                            source: import("typebox").TString;
                            externalId: import("typebox").TString;
                            fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                            reason: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            source: import("typebox").TString;
                            externalId: import("typebox").TString;
                            fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                            reason: import("typebox").TString;
                        }>;
                    };
                };
            };
            response: {
                200: {
                    '~standard': {
                        version: 1;
                        vendor: string;
                        types: {
                            input: {
                                securityRevision: string;
                            };
                            output: {
                                securityRevision: string;
                            };
                        } | undefined;
                        validate(value: unknown): {
                            value: {
                                securityRevision: string;
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
                                securityRevision: import("typebox").TString;
                            }>;
                            output: () => import("typebox").TObject<{
                                securityRevision: import("typebox").TString;
                            }>;
                        };
                    };
                } & {
                    headers: {
                        readonly "rezics-session-token": import("typebox").TString;
                        readonly 'cache-control': import("typebox").TString;
                    };
                };
                400: import("typebox").TObject<{
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
                403: import("typebox").TObject<{
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
                413: import("typebox").TObject<{
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
                422: import("typebox").TObject<{
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
                429: import("typebox").TObject<{
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
                500: import("typebox").TObject<{
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
                'x-exposure': string;
                'x-action': string;
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        }, {}, "/v1/sourceFences/$takedown">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, import("elysia").DefaultSingleton & {
            derive: {
                readonly admission: import("../http/admission.ts").Admission;
                readonly job: {
                    deadline: number;
                    signal: AbortSignal;
                };
                readonly actor: import("./reads.ts").Actor;
                readonly session: {
                    readonly components: import("../tokens/session.ts").SessionComponent[];
                    record(component: import("../tokens/session.ts").SessionComponent): void;
                };
                readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
                readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
            };
        } & {
            derive: unknown;
        } & {
            decorator: {
                contentType: string;
            };
        }>) => import("elysia/types").MaybePromise<void>;
        readonly path: string;
        route?: string;
        rid?: string;
        request: Request;
        store: {};
        body: {
            source: string;
            externalId: string;
            fieldGroup: "cover" | "facts" | "summary";
            reason: string;
        };
        query: Record<string, string | undefined>;
        params: {};
        headers: {
            "idempotency-key": string;
        };
        cookie: Record<string, import("elysia").Cookie<unknown>>;
        contentType: string;
        readonly admission: import("../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("./reads.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    }) => Promise<any>))[];
    transform: ({ request }: {
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
                securityRevision: string;
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
            413: {
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
            422: {
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
            429: {
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
            500: {
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
                securityRevision: string;
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
            413: {
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
            422: {
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
            429: {
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
            500: {
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
        defer: (fn: import("elysia/types").AfterResponseHandler<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
            parse: unknown;
            transform: unknown;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            source: string;
                            externalId: string;
                            fieldGroup: "cover" | "facts" | "summary";
                            reason: string;
                        };
                        output: {
                            source: string;
                            externalId: string;
                            fieldGroup: "cover" | "facts" | "summary";
                            reason: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            source: string;
                            externalId: string;
                            fieldGroup: "cover" | "facts" | "summary";
                            reason: string;
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
                            source: import("typebox").TString;
                            externalId: import("typebox").TString;
                            fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                            reason: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            source: import("typebox").TString;
                            externalId: import("typebox").TString;
                            fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                            reason: import("typebox").TString;
                        }>;
                    };
                };
            };
            response: {
                200: {
                    '~standard': {
                        version: 1;
                        vendor: string;
                        types: {
                            input: {
                                securityRevision: string;
                            };
                            output: {
                                securityRevision: string;
                            };
                        } | undefined;
                        validate(value: unknown): {
                            value: {
                                securityRevision: string;
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
                                securityRevision: import("typebox").TString;
                            }>;
                            output: () => import("typebox").TObject<{
                                securityRevision: import("typebox").TString;
                            }>;
                        };
                    };
                } & {
                    headers: {
                        readonly "rezics-session-token": import("typebox").TString;
                        readonly 'cache-control': import("typebox").TString;
                    };
                };
                400: import("typebox").TObject<{
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
                403: import("typebox").TObject<{
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
                413: import("typebox").TObject<{
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
                422: import("typebox").TObject<{
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
                429: import("typebox").TObject<{
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
                500: import("typebox").TObject<{
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
                'x-exposure': string;
                'x-action': string;
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        }, {}, "/v1/sourceFences/$takedown">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, import("elysia").DefaultSingleton & {
            derive: {
                readonly admission: import("../http/admission.ts").Admission;
                readonly job: {
                    deadline: number;
                    signal: AbortSignal;
                };
                readonly actor: import("./reads.ts").Actor;
                readonly session: {
                    readonly components: import("../tokens/session.ts").SessionComponent[];
                    record(component: import("../tokens/session.ts").SessionComponent): void;
                };
                readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
                readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
            };
        } & {
            derive: unknown;
        }>) => import("elysia/types").MaybePromise<void>;
        readonly path: string;
        route?: string;
        rid?: string;
        request: Request;
        store: {};
        body: {
            source: string;
            externalId: string;
            fieldGroup: "cover" | "facts" | "summary";
            reason: string;
        };
        query: Record<string, string | undefined>;
        params: {};
        headers: {
            "idempotency-key": string;
        };
        cookie: Record<string, import("elysia").Cookie<unknown>>;
        readonly admission: import("../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("./reads.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    }) => void;
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    body: {
        '~standard': {
            version: 1;
            vendor: string;
            types: {
                input: {
                    source: string;
                    externalId: string;
                    fieldGroup: "cover" | "facts" | "summary";
                    reason: string;
                };
                output: {
                    source: string;
                    externalId: string;
                    fieldGroup: "cover" | "facts" | "summary";
                    reason: string;
                };
            } | undefined;
            validate(value: unknown): {
                value: {
                    source: string;
                    externalId: string;
                    fieldGroup: "cover" | "facts" | "summary";
                    reason: string;
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
                    source: import("typebox").TString;
                    externalId: import("typebox").TString;
                    fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                    reason: import("typebox").TString;
                }>;
                output: () => import("typebox").TObject<{
                    source: import("typebox").TString;
                    externalId: import("typebox").TString;
                    fieldGroup: import("typebox").TUnion<[import("typebox").TLiteral<"facts">, import("typebox").TLiteral<"summary">, import("typebox").TLiteral<"cover">]>;
                    reason: import("typebox").TString;
                }>;
            };
        };
    };
    response: {
        200: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: {
                        securityRevision: string;
                    };
                    output: {
                        securityRevision: string;
                    };
                } | undefined;
                validate(value: unknown): {
                    value: {
                        securityRevision: string;
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
                        securityRevision: import("typebox").TString;
                    }>;
                    output: () => import("typebox").TObject<{
                        securityRevision: import("typebox").TString;
                    }>;
                };
            };
        } & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
                readonly 'cache-control': import("typebox").TString;
            };
        };
        400: import("typebox").TObject<{
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
        403: import("typebox").TObject<{
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
        413: import("typebox").TObject<{
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
        422: import("typebox").TObject<{
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
        429: import("typebox").TObject<{
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
        500: import("typebox").TObject<{
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
        'x-exposure': string;
        'x-action': string;
        'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        security: {
            bearerAuth: never[];
        }[];
    };
}>;
