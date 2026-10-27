import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { type MediaDependencies } from './media.ts';
type Dependencies = MediaDependencies & {
    routeKey: Uint8Array;
};
export declare function mediaRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
        media: {
            post: {
                body: {
                    mediaType: "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";
                    byteCount: number;
                    sha256?: string;
                    containerId: string;
                    purpose: "avatar" | "post-image";
                } | {
                    mediaType: "image/avif" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";
                    byteCount: number;
                    sha256?: string;
                    newThread: {
                        boardId: string;
                        idempotencyKey: string;
                    };
                    purpose: "post-image";
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    201: {
                        media: {
                            id: string;
                            state: "available" | "erased" | "rejected" | "reserved" | "uploaded";
                            byteCount: number;
                            mediaType: string;
                            sha256: string | null;
                            containerId: string;
                            uploaderId: string;
                            key: string;
                            reservationRequestId: string;
                        } | {
                            id: string;
                            state: "available" | "erased" | "rejected" | "reserved" | "uploaded";
                            byteCount: number;
                            mediaType: string;
                            sha256: string | null;
                            containerId: string;
                            uploaderId: string;
                            key: string;
                            reservationRequestId: string;
                            purpose: "avatar";
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
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        media: {
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
                            media: {
                                id: string;
                                state: "available" | "erased" | "rejected" | "reserved" | "uploaded";
                                byteCount: number;
                                mediaType: string;
                                sha256: string | null;
                                containerId: string;
                                uploaderId: string;
                                key: string;
                                reservationRequestId: string;
                            } | {
                                id: string;
                                state: "available" | "erased" | "rejected" | "reserved" | "uploaded";
                                byteCount: number;
                                mediaType: string;
                                sha256: string | null;
                                containerId: string;
                                uploaderId: string;
                                key: string;
                                reservationRequestId: string;
                                purpose: "avatar";
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
} & {
    v1: {
        media: {
            ":id": {
                $complete: {
                    post: {
                        body: {
                            containerId: string;
                            reservationRequestId: string;
                            byteCount: number;
                            sha256: string;
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
                                media: {
                                    id: string;
                                    state: "uploaded";
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
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        media: {
            ":id": {
                delete: {
                    body: unknown;
                    params: {
                        id: string;
                    };
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        204: void;
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
}, "get", "/v1/media/:id/$authorizeDownload", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    query: {
        '~standard': {
            version: 1;
            vendor: string;
            types: {
                input: {
                    variant: string;
                };
                output: {
                    variant: string;
                };
            } | undefined;
            validate(value: unknown): {
                value: {
                    variant: string;
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
                    variant: import("typebox").TString;
                }>;
                output: () => import("typebox").TObject<{
                    variant: import("typebox").TString;
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
        200: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: {
                        allowed: true;
                        key: string;
                        sha256: string;
                        mediaType: string;
                        byteCount: number;
                        publicCache: false;
                        cacheControl: "private, no-cache" | "private, no-store";
                    };
                    output: {
                        allowed: true;
                        key: string;
                        sha256: string;
                        mediaType: string;
                        byteCount: number;
                        publicCache: false;
                        cacheControl: "private, no-cache" | "private, no-store";
                    };
                } | undefined;
                validate(value: unknown): {
                    value: {
                        allowed: true;
                        key: string;
                        sha256: string;
                        mediaType: string;
                        byteCount: number;
                        publicCache: false;
                        cacheControl: "private, no-cache" | "private, no-store";
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
                        allowed: import("typebox").TLiteral<true>;
                        key: import("typebox").TString;
                        sha256: import("typebox").TString;
                        mediaType: import("typebox").TString;
                        byteCount: import("typebox").TInteger;
                        publicCache: import("typebox").TLiteral<false>;
                        cacheControl: import("typebox").TUnion<[import("typebox").TLiteral<"private, no-cache">, import("typebox").TLiteral<"private, no-store">]>;
                    }>;
                    output: () => import("typebox").TObject<{
                        allowed: import("typebox").TLiteral<true>;
                        key: import("typebox").TString;
                        sha256: import("typebox").TString;
                        mediaType: import("typebox").TString;
                        byteCount: import("typebox").TInteger;
                        publicCache: import("typebox").TLiteral<false>;
                        cacheControl: import("typebox").TUnion<[import("typebox").TLiteral<"private, no-cache">, import("typebox").TLiteral<"private, no-store">]>;
                    }>;
                };
            };
        } & {
            headers: {
                "rezics-session-token": import("typebox").TString;
            };
        };
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        security: {}[];
    };
}, {}, "/v1/media/:id/$authorizeDownload">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ params: { id }, query, actor, admission, job, set }: {
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
        200: {
            allowed: true;
            key: string;
            sha256: string;
            mediaType: string;
            byteCount: number;
            publicCache: false;
            cacheControl: "private, no-cache" | "private, no-store";
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
        200: {
            allowed: true;
            key: string;
            sha256: string;
            mediaType: string;
            byteCount: number;
            publicCache: false;
            cacheControl: "private, no-cache" | "private, no-store";
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            id: import("typebox").TString;
        }>;
        query: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: {
                        variant: string;
                    };
                    output: {
                        variant: string;
                    };
                } | undefined;
                validate(value: unknown): {
                    value: {
                        variant: string;
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
                        variant: import("typebox").TString;
                    }>;
                    output: () => import("typebox").TObject<{
                        variant: import("typebox").TString;
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
            200: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            allowed: true;
                            key: string;
                            sha256: string;
                            mediaType: string;
                            byteCount: number;
                            publicCache: false;
                            cacheControl: "private, no-cache" | "private, no-store";
                        };
                        output: {
                            allowed: true;
                            key: string;
                            sha256: string;
                            mediaType: string;
                            byteCount: number;
                            publicCache: false;
                            cacheControl: "private, no-cache" | "private, no-store";
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            allowed: true;
                            key: string;
                            sha256: string;
                            mediaType: string;
                            byteCount: number;
                            publicCache: false;
                            cacheControl: "private, no-cache" | "private, no-store";
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
                            allowed: import("typebox").TLiteral<true>;
                            key: import("typebox").TString;
                            sha256: import("typebox").TString;
                            mediaType: import("typebox").TString;
                            byteCount: import("typebox").TInteger;
                            publicCache: import("typebox").TLiteral<false>;
                            cacheControl: import("typebox").TUnion<[import("typebox").TLiteral<"private, no-cache">, import("typebox").TLiteral<"private, no-store">]>;
                        }>;
                        output: () => import("typebox").TObject<{
                            allowed: import("typebox").TLiteral<true>;
                            key: import("typebox").TString;
                            sha256: import("typebox").TString;
                            mediaType: import("typebox").TString;
                            byteCount: import("typebox").TInteger;
                            publicCache: import("typebox").TLiteral<false>;
                            cacheControl: import("typebox").TUnion<[import("typebox").TLiteral<"private, no-cache">, import("typebox").TLiteral<"private, no-store">]>;
                        }>;
                    };
                };
            } & {
                headers: {
                    "rezics-session-token": import("typebox").TString;
                };
            };
        };
        detail: {
            operationId: string;
            'x-exposure': string;
            'x-action': string;
            security: {}[];
        };
    }, {}, "/v1/media/:id/$authorizeDownload">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
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
    body: unknown;
    query: {
        variant: string;
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
    readonly actor: import("./reads.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<Readonly<{
    allowed: true;
    key: string;
    sha256: string;
    mediaType: string;
    byteCount: number;
    publicCache: false;
    cacheControl: 'private, no-cache' | 'private, no-store';
}>>, {
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    query: {
        '~standard': {
            version: 1;
            vendor: string;
            types: {
                input: {
                    variant: string;
                };
                output: {
                    variant: string;
                };
            } | undefined;
            validate(value: unknown): {
                value: {
                    variant: string;
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
                    variant: import("typebox").TString;
                }>;
                output: () => import("typebox").TObject<{
                    variant: import("typebox").TString;
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
        200: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: {
                        allowed: true;
                        key: string;
                        sha256: string;
                        mediaType: string;
                        byteCount: number;
                        publicCache: false;
                        cacheControl: "private, no-cache" | "private, no-store";
                    };
                    output: {
                        allowed: true;
                        key: string;
                        sha256: string;
                        mediaType: string;
                        byteCount: number;
                        publicCache: false;
                        cacheControl: "private, no-cache" | "private, no-store";
                    };
                } | undefined;
                validate(value: unknown): {
                    value: {
                        allowed: true;
                        key: string;
                        sha256: string;
                        mediaType: string;
                        byteCount: number;
                        publicCache: false;
                        cacheControl: "private, no-cache" | "private, no-store";
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
                        allowed: import("typebox").TLiteral<true>;
                        key: import("typebox").TString;
                        sha256: import("typebox").TString;
                        mediaType: import("typebox").TString;
                        byteCount: import("typebox").TInteger;
                        publicCache: import("typebox").TLiteral<false>;
                        cacheControl: import("typebox").TUnion<[import("typebox").TLiteral<"private, no-cache">, import("typebox").TLiteral<"private, no-store">]>;
                    }>;
                    output: () => import("typebox").TObject<{
                        allowed: import("typebox").TLiteral<true>;
                        key: import("typebox").TString;
                        sha256: import("typebox").TString;
                        mediaType: import("typebox").TString;
                        byteCount: import("typebox").TInteger;
                        publicCache: import("typebox").TLiteral<false>;
                        cacheControl: import("typebox").TUnion<[import("typebox").TLiteral<"private, no-cache">, import("typebox").TLiteral<"private, no-store">]>;
                    }>;
                };
            };
        } & {
            headers: {
                "rezics-session-token": import("typebox").TString;
            };
        };
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        security: {}[];
    };
}>;
export {};
