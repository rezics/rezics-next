import type { ShelfTitleSource } from './shelf-title-source.ts';
import type { TSchema } from 'typebox';
import type { Pool } from 'pg';
import { type KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type LoanHttpWorkOwner } from './loan-operation-bounds.ts';
import type { FollowingSpaceProjection } from './following-space-contract.ts';
import type { ShelfTypeDigest } from './shelf-type-keys.ts';
import { type ShelfReads } from './shelf-contract.ts';
export type { PersonalEntry, PersonalEntryAnnotationWrite, PersonalEntryFieldChange, PersonalEntryGuard, PersonalEntryObservation, PersonalEntryPrivacy, PersonalEntryPrivacyValue, PersonalEntrySourceAdmission, PersonalEntrySourceCorrection, PersonalEntryTimestamp, PersonalEntryTimestampInput, PersonalEntryTimestampValue, } from './entry-personal-model.ts';
type Dependencies = {
    routeKey: Uint8Array;
    pool: Pool;
    tokens: KeyRing;
    access: () => Access;
    clock?: KernelClock;
    shelves?: () => ShelfReads;
    loanHttpWork?: LoanHttpWorkOwner;
    shelfTypeDigest?: ShelfTypeDigest;
    titleSource?: ShelfTitleSource;
    typeSourceObserved?: import('./type-preparation-contract.ts').TypePreparationSourceObserved;
    followingSpaceTargets?: (actor: Actor, ids: readonly string[], deadline: number) => Promise<ReadonlyMap<string, FollowingSpaceProjection>>;
};
/** Private account-owned library transport. Domain commands retain authorization and receipts. */
export declare function personalLibraryRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
        libraryEntryAnnotationCorrections: {
            post: {
                body: {
                    items: {
                        subjectId: string;
                        incarnationId: string;
                        currentRevision: number;
                        note: {
                            op: "preserve";
                        } | {
                            op: "clear";
                        } | {
                            op: "set";
                            value: string;
                        };
                        priority: {
                            op: "preserve";
                        } | {
                            op: "clear";
                        } | {
                            op: "set";
                            value: number;
                        };
                    }[];
                };
                params: {};
                query: unknown;
                headers: unknown;
                response: {
                    200: {
                        review: {
                            reviewId: string;
                            epoch: string;
                            state: 'open' | 'confirmed' | 'cancelled' | 'expired';
                            createdAt: string;
                            expiresAt: string;
                            total: number;
                            page: number;
                            pageCount: number;
                            nextPage: number | null;
                            items: Readonly<{
                                selected: Readonly<{
                                    subjectId: string;
                                    incarnationId: string;
                                    currentRevision: number;
                                }>;
                                eligibility: 'ready' | 'stale' | 'unavailable';
                                current: import("./entry-annotation-correction.ts").EntryAnnotationCorrectionCurrent | null;
                                operation: Readonly<{
                                    note: import("./entry-annotation-correction.ts").EntryAnnotationOperation<string>;
                                    priority: import("./entry-annotation-correction.ts").EntryAnnotationOperation<number>;
                                }> | null;
                                outcome: 'accepted' | 'unchanged' | 'stale' | 'unavailable' | 'not-started';
                            }>[];
                        };
                    };
                    201: {
                        review: {
                            reviewId: string;
                            epoch: string;
                            state: "cancelled" | "confirmed" | "expired" | "open";
                            createdAt: string;
                            expiresAt: string;
                            total: number;
                            page: number;
                            pageCount: number;
                            nextPage: number | null;
                            items: readonly {
                                selected: {
                                    subjectId: string;
                                    incarnationId: string;
                                    currentRevision: number;
                                };
                                eligibility: "ready" | "stale" | "unavailable";
                                current: {
                                    annotationRevision: number;
                                    note: string | null;
                                    priority: number | null;
                                } | null;
                                operation: {
                                    note: {
                                        op: "preserve";
                                    } | {
                                        op: "clear";
                                    } | {
                                        op: "set";
                                        value: string;
                                    };
                                    priority: {
                                        op: "preserve";
                                    } | {
                                        op: "clear";
                                    } | {
                                        op: "set";
                                        value: number;
                                    };
                                } | null;
                                outcome: "accepted" | "not-started" | "stale" | "unavailable" | "unchanged";
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
        libraryEntryAnnotationCorrections: {
            ":reviewId": {
                get: {
                    body: unknown;
                    params: {
                        reviewId: string;
                    };
                    query: {
                        page?: number;
                    };
                    headers: unknown;
                    response: {
                        200: {
                            review: {
                                reviewId: string;
                                epoch: string;
                                state: "cancelled" | "confirmed" | "expired" | "open";
                                createdAt: string;
                                expiresAt: string;
                                total: number;
                                page: number;
                                pageCount: number;
                                nextPage: number | null;
                                items: readonly {
                                    selected: {
                                        subjectId: string;
                                        incarnationId: string;
                                        currentRevision: number;
                                    };
                                    eligibility: "ready" | "stale" | "unavailable";
                                    current: {
                                        annotationRevision: number;
                                        note: string | null;
                                        priority: number | null;
                                    } | null;
                                    operation: {
                                        note: {
                                            op: "preserve";
                                        } | {
                                            op: "clear";
                                        } | {
                                            op: "set";
                                            value: string;
                                        };
                                        priority: {
                                            op: "preserve";
                                        } | {
                                            op: "clear";
                                        } | {
                                            op: "set";
                                            value: number;
                                        };
                                    } | null;
                                    outcome: "accepted" | "not-started" | "stale" | "unavailable" | "unchanged";
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
        libraryEntryAnnotationCorrections: {
            ":reviewId": {
                confirm: {
                    post: {
                        body: {
                            epoch: string;
                            position: number;
                        };
                        params: {
                            reviewId: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                review: {
                                    reviewId: string;
                                    epoch: string;
                                    state: "cancelled" | "confirmed" | "expired" | "open";
                                    createdAt: string;
                                    expiresAt: string;
                                    total: number;
                                    page: number;
                                    pageCount: number;
                                    nextPage: number | null;
                                    items: readonly {
                                        selected: {
                                            subjectId: string;
                                            incarnationId: string;
                                            currentRevision: number;
                                        };
                                        eligibility: "ready" | "stale" | "unavailable";
                                        current: {
                                            annotationRevision: number;
                                            note: string | null;
                                            priority: number | null;
                                        } | null;
                                        operation: {
                                            note: {
                                                op: "preserve";
                                            } | {
                                                op: "clear";
                                            } | {
                                                op: "set";
                                                value: string;
                                            };
                                            priority: {
                                                op: "preserve";
                                            } | {
                                                op: "clear";
                                            } | {
                                                op: "set";
                                                value: number;
                                            };
                                        } | null;
                                        outcome: "accepted" | "not-started" | "stale" | "unavailable" | "unchanged";
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
        libraryEntryAnnotationCorrections: {
            ":reviewId": {
                cancel: {
                    post: {
                        body: {
                            epoch: string;
                        };
                        params: {
                            reviewId: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                reviewId: string;
                                epoch: string;
                                state: "cancelled" | "confirmed" | "expired" | "open";
                                expiresAt: string;
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
        libraryShelfTitlePreparation: {
            post: {
                body: unknown;
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        installation: "installed" | "pending";
                        prepared: number;
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
        libraryShelfScorePreparation: {
            post: {
                body: unknown;
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        installation: "installed" | "pending";
                        prepared: number;
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
        libraryEntries: {
            get: {
                body: unknown;
                params: {};
                query: {
                    view?: "BASIC" | "FULL";
                    limit?: number;
                    cursor?: string;
                    direction?: "asc" | "desc";
                    type?: string;
                    state?: string;
                    orderBy?: "createdAt" | "finishedAt" | "lastActivity" | "personalScore" | "priority" | "title";
                };
                headers: unknown;
                response: {
                    200: {
                        libraryEntries: ({
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
                            subjectId: string;
                            incarnationId?: string | null;
                            state: string;
                            revision: number;
                            createdAt: string;
                            updatedAt: string;
                            lastActivityAt: string;
                            finishedAt: string | null;
                            titleCoverage?: "labelled" | "missing";
                            personalScore?: number | null;
                            priority?: number | null;
                            activeProgressSession: {
                                id: string;
                                subjectId: string;
                                versionSubjectId: string | null;
                                mode: "completed_units" | "cursor_position" | "scalar_amount";
                                unit: string;
                                total: string | null;
                                amount: string | null;
                                locator: string | null;
                                position: string | null;
                                completedUnitCount: number;
                                state: "abandoned" | "active" | "completed";
                                revision: number;
                                startedAt: string;
                                completedAt: string | null;
                            } | null;
                            facts?: Record<string, ({
                                kind: "item";
                                id: string;
                                labels: Record<string, string>;
                            } | {
                                kind: "time";
                                year: number;
                                month?: number;
                                day?: number;
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
                            subjectId: string;
                            incarnationId?: string | null;
                            state: string;
                            revision: number;
                            createdAt: string;
                            updatedAt: string;
                            facts?: Record<string, ({
                                kind: "item";
                                id: string;
                                labels: Record<string, string>;
                            } | {
                                kind: "time";
                                year: number;
                                month?: number;
                                day?: number;
                            } | {
                                kind: "quantity";
                                amount: number;
                                unit: string;
                            } | {
                                kind: "code";
                                value: string;
                            })[]>;
                        })[];
                        scoreQuestion?: {
                            id: string;
                            meaning: string | null;
                            revision: number;
                            grain: string;
                            minimumUnits: number;
                            maximumUnits: number;
                            stepUnits: number;
                            lifecycleState: string;
                            lifecycleRevision: number;
                        };
                        next: string | null;
                        viewerFacts?: {
                            state: "current";
                            question: {
                                id: string;
                                revision: number;
                                grain: string;
                                scale: {
                                    min: number;
                                    max: number;
                                    displayStep: number;
                                };
                                meaning: string;
                            } | null;
                            rows: {
                                rowKey: string;
                                subjectId: string;
                                entry: {
                                    state: "present";
                                    incarnationId: string | null;
                                    entryState: string | null;
                                    revision: number;
                                } | {
                                    state: "absent";
                                } | {
                                    state: "unavailable";
                                    reason: "scope";
                                };
                                vote: {
                                    state: "present";
                                    questionId: string;
                                    questionRevision: number;
                                    units: number;
                                    revision: number;
                                } | {
                                    state: "absent";
                                    questionId: string;
                                    questionRevision: number;
                                } | {
                                    state: "unavailable";
                                    reason: "question" | "scope";
                                };
                            }[];
                        } | {
                            state: "unavailable";
                            reason: "currentness" | "identity" | "response_limit";
                            retryable: boolean;
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
        libraryShelfSummary: {
            get: {
                body: unknown;
                params: {};
                query: {
                    type?: string;
                };
                headers: unknown;
                response: {
                    200: {
                        tabs: {
                            all: {
                                total: number;
                                shown: number;
                            };
                            in_progress: {
                                total: number;
                                shown: number;
                            };
                            planned: {
                                total: number;
                                shown: number;
                            };
                            completed: {
                                total: number;
                                shown: number;
                            };
                            paused: {
                                total: number;
                                shown: number;
                            };
                            dropped: {
                                total: number;
                                shown: number;
                            };
                            collections: {
                                total: number;
                                shown: number;
                            };
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
        libraryShelfTypes: {
            get: {
                body: unknown;
                params: {};
                query: {
                    limit?: number;
                    cursor?: string;
                };
                headers: unknown;
                response: {
                    200: {
                        types: {
                            type: string;
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
        libraryEntries: {
            ":subjectId": {
                get: {
                    body: unknown;
                    params: {
                        subjectId: string;
                    };
                    query: {
                        view?: "BASIC" | "FULL";
                    };
                    headers: unknown;
                    response: {
                        200: {
                            libraryEntry: {
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
                                subjectId: string;
                                incarnationId?: string | null;
                                state: string;
                                revision: number;
                                createdAt: string;
                                updatedAt: string;
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
        libraryEntries: {
            ":subjectId": {
                "state-history": {
                    get: {
                        body: unknown;
                        params: {
                            subjectId: string;
                        };
                        query: {
                            cursor?: string;
                            limit?: number;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                incarnationId: string | null;
                                currentRevision: number;
                                changes: {
                                    revision: number;
                                    priorRevision: number | null;
                                    beforeState: string | null;
                                    afterState: string;
                                    commandId: string;
                                    commandKind: "library.entry.put" | "library.entry.state.restore";
                                    changedAt: string;
                                }[];
                                coverage: "complete" | "partial" | "unknown";
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
        libraryEntries: {
            ":subjectId": {
                "state-history": {
                    ":changeRevision": {
                        get: {
                            body: unknown;
                            params: {
                                subjectId: string;
                                changeRevision: number;
                            };
                            query: unknown;
                            headers: unknown;
                            response: {
                                200: {
                                    change: {
                                        revision: number;
                                        priorRevision: number | null;
                                        beforeState: string | null;
                                        afterState: string;
                                        commandId: string;
                                        commandKind: "library.entry.put" | "library.entry.state.restore";
                                        changedAt: string;
                                    };
                                    current: {
                                        incarnationId: string | null;
                                        revision: number;
                                        state: string;
                                    };
                                    availability: "available" | "no_prior_state" | "state_unavailable";
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
        libraryEntries: {
            ":subjectId": {
                "state-history": {
                    ":changeRevision": {
                        $restore: {
                            post: {
                                body: {
                                    incarnationId: string;
                                    currentRevision: number;
                                };
                                params: {
                                    subjectId: string;
                                    changeRevision: number;
                                };
                                query: unknown;
                                headers: {
                                    "idempotency-key": string;
                                };
                                response: {
                                    200: {
                                        libraryEntry: {
                                            subjectId: string;
                                            incarnationId?: string | null;
                                            state: string;
                                            revision: number;
                                            createdAt: string;
                                            updatedAt: string;
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
        libraryEntries: {
            ":subjectId": {
                personal: {
                    get: {
                        body: unknown;
                        params: {
                            subjectId: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                personalEntry: {
                                    subjectId: string;
                                    annotationRevision: number;
                                    note: string | null;
                                    priority: number | null;
                                    annotationUpdatedAt: string | null;
                                    sourceObservations: {
                                        provider: string;
                                        recordId: string;
                                        revision: number;
                                        privacy: {
                                            status: "absent";
                                        } | {
                                            status: "unknown";
                                            sourceValue?: string;
                                        } | {
                                            status: "cleared";
                                        } | {
                                            status: "known";
                                            meaning: "private" | "source_visible";
                                        };
                                        sourceCreated: {
                                            status: "absent";
                                        } | {
                                            status: "unknown";
                                            sourceValue?: string;
                                        } | {
                                            status: "cleared";
                                        } | {
                                            status: "known";
                                            value: string;
                                            precision: "day" | "fraction" | "minute" | "month" | "second" | "year";
                                            zone: "offset" | "unknown" | "utc";
                                        };
                                        sourceUpdated: {
                                            status: "absent";
                                        } | {
                                            status: "unknown";
                                            sourceValue?: string;
                                        } | {
                                            status: "cleared";
                                        } | {
                                            status: "known";
                                            value: string;
                                            precision: "day" | "fraction" | "minute" | "month" | "second" | "year";
                                            zone: "offset" | "unknown" | "utc";
                                        };
                                        recordedAt: string;
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
        libraryEntries: {
            ":subjectId": {
                annotations: {
                    put: {
                        body: {
                            revision: number;
                            note: {
                                op: "unchanged";
                            } | {
                                op: "clear";
                            } | {
                                op: "set";
                                value: unknown;
                            };
                            priority: {
                                op: "unchanged";
                            } | {
                                op: "clear";
                            } | {
                                op: "set";
                                value: unknown;
                            };
                            entryGuard?: {
                                incarnationId: string;
                                currentRevision: number;
                            };
                        };
                        params: {
                            subjectId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                personalEntry: {
                                    subjectId: string;
                                    annotationRevision: number;
                                    note: string | null;
                                    priority: number | null;
                                    annotationUpdatedAt: string | null;
                                    sourceObservations: {
                                        provider: string;
                                        recordId: string;
                                        revision: number;
                                        privacy: {
                                            status: "absent";
                                        } | {
                                            status: "unknown";
                                            sourceValue?: string;
                                        } | {
                                            status: "cleared";
                                        } | {
                                            status: "known";
                                            meaning: "private" | "source_visible";
                                        };
                                        sourceCreated: {
                                            status: "absent";
                                        } | {
                                            status: "unknown";
                                            sourceValue?: string;
                                        } | {
                                            status: "cleared";
                                        } | {
                                            status: "known";
                                            value: string;
                                            precision: "day" | "fraction" | "minute" | "month" | "second" | "year";
                                            zone: "offset" | "unknown" | "utc";
                                        };
                                        sourceUpdated: {
                                            status: "absent";
                                        } | {
                                            status: "unknown";
                                            sourceValue?: string;
                                        } | {
                                            status: "cleared";
                                        } | {
                                            status: "known";
                                            value: string;
                                            precision: "day" | "fraction" | "minute" | "month" | "second" | "year";
                                            zone: "offset" | "unknown" | "utc";
                                        };
                                        recordedAt: string;
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
        libraryEntries: {
            ":subjectId": {
                sourceObservations: {
                    post: {
                        body: {
                            provider: string;
                            recordId: string;
                            confirmReviewed: true;
                            privacy: {
                                status: "absent";
                            } | {
                                status: "unknown";
                                sourceValue?: string;
                            } | {
                                status: "known";
                                meaning: "private" | "source_visible";
                            };
                            sourceCreated: {
                                status: "absent";
                            } | {
                                status: "unknown";
                                sourceValue?: string;
                            } | {
                                status: "known";
                                value: string;
                            };
                            sourceUpdated: {
                                status: "absent";
                            } | {
                                status: "unknown";
                                sourceValue?: string;
                            } | {
                                status: "known";
                                value: string;
                            };
                        };
                        params: {
                            subjectId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                sourceObservation: {
                                    provider: string;
                                    recordId: string;
                                    revision: number;
                                    privacy: import("./entry-personal-model.ts").PrivacyFact;
                                    sourceCreated: import("./entry-personal-model.ts").TimestampFact;
                                    sourceUpdated: import("./entry-personal-model.ts").TimestampFact;
                                    recordedAt: string;
                                };
                            };
                            201: {
                                sourceObservation: {
                                    provider: string;
                                    recordId: string;
                                    revision: number;
                                    privacy: {
                                        status: "absent";
                                    } | {
                                        status: "unknown";
                                        sourceValue?: string;
                                    } | {
                                        status: "cleared";
                                    } | {
                                        status: "known";
                                        meaning: "private" | "source_visible";
                                    };
                                    sourceCreated: {
                                        status: "absent";
                                    } | {
                                        status: "unknown";
                                        sourceValue?: string;
                                    } | {
                                        status: "cleared";
                                    } | {
                                        status: "known";
                                        value: string;
                                        precision: "day" | "fraction" | "minute" | "month" | "second" | "year";
                                        zone: "offset" | "unknown" | "utc";
                                    };
                                    sourceUpdated: {
                                        status: "absent";
                                    } | {
                                        status: "unknown";
                                        sourceValue?: string;
                                    } | {
                                        status: "cleared";
                                    } | {
                                        status: "known";
                                        value: string;
                                        precision: "day" | "fraction" | "minute" | "month" | "second" | "year";
                                        zone: "offset" | "unknown" | "utc";
                                    };
                                    recordedAt: string;
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
        libraryEntries: {
            ":subjectId": {
                sourceObservations: {
                    patch: {
                        body: {
                            provider: string;
                            recordId: string;
                            revision: number;
                            confirmReviewed: true;
                            privacy: {
                                op: "unchanged";
                            } | {
                                op: "clear";
                            } | {
                                op: "set";
                                value: unknown;
                            };
                            sourceCreated: {
                                op: "unchanged";
                            } | {
                                op: "clear";
                            } | {
                                op: "set";
                                value: unknown;
                            };
                            sourceUpdated: {
                                op: "unchanged";
                            } | {
                                op: "clear";
                            } | {
                                op: "set";
                                value: unknown;
                            };
                        };
                        params: {
                            subjectId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                sourceObservation: {
                                    provider: string;
                                    recordId: string;
                                    revision: number;
                                    privacy: {
                                        status: "absent";
                                    } | {
                                        status: "unknown";
                                        sourceValue?: string;
                                    } | {
                                        status: "cleared";
                                    } | {
                                        status: "known";
                                        meaning: "private" | "source_visible";
                                    };
                                    sourceCreated: {
                                        status: "absent";
                                    } | {
                                        status: "unknown";
                                        sourceValue?: string;
                                    } | {
                                        status: "cleared";
                                    } | {
                                        status: "known";
                                        value: string;
                                        precision: "day" | "fraction" | "minute" | "month" | "second" | "year";
                                        zone: "offset" | "unknown" | "utc";
                                    };
                                    sourceUpdated: {
                                        status: "absent";
                                    } | {
                                        status: "unknown";
                                        sourceValue?: string;
                                    } | {
                                        status: "cleared";
                                    } | {
                                        status: "known";
                                        value: string;
                                        precision: "day" | "fraction" | "minute" | "month" | "second" | "year";
                                        zone: "offset" | "unknown" | "utc";
                                    };
                                    recordedAt: string;
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
        libraryEntries: {
            ":subjectId": {
                put: {
                    body: {
                        state: string;
                        revision?: number;
                        incarnationId?: string;
                    };
                    params: {
                        subjectId: string;
                    };
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            libraryEntry: {
                                subjectId: string;
                                incarnationId?: string | null;
                                state: string;
                                revision: number;
                                createdAt: string;
                                updatedAt: string;
                            };
                        };
                        201: {
                            libraryEntry: {
                                subjectId: string;
                                incarnationId?: string | null;
                                state: string;
                                revision: number;
                                createdAt: string;
                                updatedAt: string;
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
        libraryEntries: {
            ":subjectId": {
                delete: {
                    body: unknown;
                    params: {
                        subjectId: string;
                    };
                    query: {
                        revision?: number;
                        incarnationId?: string;
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
        libraryEntries: {
            ":subjectId": {
                $restore: {
                    post: {
                        body: {
                            deletionId: string;
                            revision: number;
                        };
                        params: {
                            subjectId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                libraryEntry: {
                                    subjectId: string;
                                    incarnationId?: string | null;
                                    state: string;
                                    revision: number;
                                    createdAt: string;
                                    updatedAt: string;
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
        copies: {
            post: {
                body: {
                    location?: string | null;
                    source?: string | null;
                    acquiredOn?: string | null;
                    disposedOn?: string | null;
                    note?: string | null;
                    mediaCondition?: "fair" | "good" | "mint" | "near_mint" | "poor" | "unknown" | "very_good" | "very_good_plus" | null;
                    packagingCondition?: "fair" | "good" | "mint" | "near_mint" | "poor" | "unknown" | "very_good" | "very_good_plus" | null;
                    subjectId: string;
                    kind?: string;
                    status?: string;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        copy: {
                            id: string;
                            subjectId: string;
                            kind?: string | null;
                            status: string;
                            revision: number;
                            location: string | null;
                            source: string | null;
                            acquiredOn: string | null;
                            disposedOn: string | null;
                            note: string | null;
                        };
                    };
                    201: {
                        copy: {
                            id: string;
                            subjectId: string;
                            kind?: string | null;
                            status: string;
                            revision: number;
                            location: string | null;
                            source: string | null;
                            acquiredOn: string | null;
                            disposedOn: string | null;
                            note: string | null;
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
        copies: {
            get: {
                body: unknown;
                params: {};
                query: {
                    view?: "BASIC" | "FULL";
                    cursor?: string;
                    limit?: number;
                    subjectId?: string;
                    kind?: string;
                    status?: string;
                };
                headers: unknown;
                response: {
                    200: {
                        copies: {
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
                            kind?: string | null;
                            status: string;
                            revision: number;
                            location: string | null;
                            source: string | null;
                            acquiredOn: string | null;
                            disposedOn: string | null;
                            note: string | null;
                            context?: {
                                state: "available";
                                work: {
                                    id: string;
                                    labels: Record<string, string>;
                                }[];
                                facts: Record<string, ({
                                    kind: "item";
                                    id: string;
                                    labels: Record<string, string>;
                                } | {
                                    kind: "time";
                                    year: number;
                                    month?: number;
                                    day?: number;
                                } | {
                                    kind: "quantity";
                                    amount: number;
                                    unit: string;
                                } | {
                                    kind: "code";
                                    value: string;
                                })[]>;
                            } | {
                                state: "unsupported";
                                facts: Record<string, ({
                                    kind: "item";
                                    id: string;
                                    labels: Record<string, string>;
                                } | {
                                    kind: "time";
                                    year: number;
                                    month?: number;
                                    day?: number;
                                } | {
                                    kind: "quantity";
                                    amount: number;
                                    unit: string;
                                } | {
                                    kind: "code";
                                    value: string;
                                })[]>;
                            } | {
                                state: "scope";
                            } | {
                                state: "withheld";
                            } | {
                                state: "missing";
                            } | {
                                state: "unavailable";
                            };
                        }[];
                        next: string | null;
                        filterOptions: {
                            kinds: {
                                state: "available" | "unavailable";
                                choices: {
                                    id: string;
                                    label: string;
                                    labelLanguage?: string;
                                    meaning: "available" | "unavailable" | "unsupported";
                                }[];
                            };
                            statuses: {
                                state: "available" | "unavailable";
                                choices: {
                                    id: string;
                                    label: string;
                                    labelLanguage?: string;
                                    meaning: "available" | "unavailable" | "unsupported";
                                }[];
                            };
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
                    413: Response | {
                        type: unknown;
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
        copies: {
            ":copyId": {
                get: {
                    body: unknown;
                    params: {
                        copyId: string;
                    };
                    query: {
                        view?: "BASIC" | "FULL";
                        presentation?: "FULL";
                    };
                    headers: unknown;
                    response: {
                        200: {
                            copy: {
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
                                kind?: string | null;
                                status: string;
                                revision: number;
                                location: string | null;
                                source: string | null;
                                acquiredOn: string | null;
                                disposedOn: string | null;
                                note: string | null;
                                presentation?: {
                                    meaning: "known" | "unavailable" | "unknown";
                                    kindLabel?: string;
                                    kindLabelLanguage?: string;
                                    statusLabel?: string;
                                    statusLabelLanguage?: string;
                                    statusEditing: {
                                        state: "supported";
                                        statuses: {
                                            id: string;
                                            label: string;
                                            labelLanguage: string;
                                        }[];
                                    } | {
                                        state: "unavailable" | "unsupported";
                                    };
                                    mediaCondition: {
                                        state: "not_recorded";
                                    } | {
                                        state: "unavailable";
                                    } | {
                                        state: "cleared";
                                    } | {
                                        state: "recorded";
                                        id: "fair" | "good" | "mint" | "near_mint" | "poor" | "unknown" | "very_good" | "very_good_plus";
                                        label: string;
                                    };
                                    packagingCondition: {
                                        state: "not_recorded";
                                    } | {
                                        state: "unavailable";
                                    } | {
                                        state: "cleared";
                                    } | {
                                        state: "recorded";
                                        id: "fair" | "good" | "mint" | "near_mint" | "poor" | "unknown" | "very_good" | "very_good_plus";
                                        label: string;
                                    };
                                    conditionEditing: {
                                        state: "supported";
                                        currentness: "current";
                                        choices: {
                                            id: "fair" | "good" | "mint" | "near_mint" | "poor" | "unknown" | "very_good" | "very_good_plus";
                                            label: string;
                                            description: string;
                                        }[];
                                    } | {
                                        state: "unavailable";
                                        currentness: "current" | "retired" | "unavailable";
                                        reason: "current_source_unavailable" | "retired" | "unrecognized_vocabulary" | "unsupported";
                                    };
                                };
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
        copies: {
            ":copyId": {
                patch: {
                    body: {
                        status?: string;
                        location?: string | null;
                        source?: string | null;
                        acquiredOn?: string | null;
                        disposedOn?: string | null;
                        note?: string | null;
                        mediaCondition?: "fair" | "good" | "mint" | "near_mint" | "poor" | "unknown" | "very_good" | "very_good_plus" | null;
                        packagingCondition?: "fair" | "good" | "mint" | "near_mint" | "poor" | "unknown" | "very_good" | "very_good_plus" | null;
                        revision?: number;
                    };
                    params: {
                        copyId: string;
                    };
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            copy: {
                                id: string;
                                subjectId: string;
                                kind?: string | null;
                                status: string;
                                revision: number;
                                location: string | null;
                                source: string | null;
                                acquiredOn: string | null;
                                disposedOn: string | null;
                                note: string | null;
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
        copies: {
            ":copyId": {
                delete: {
                    body: unknown;
                    params: {
                        copyId: string;
                    };
                    query: {
                        revision?: number;
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
        copies: {
            ":copyId": {
                $restore: {
                    post: {
                        body: {
                            deletionId: string;
                            revision: number;
                        };
                        params: {
                            copyId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                copy: {
                                    id: string;
                                    subjectId: string;
                                    kind?: string | null;
                                    status: string;
                                    revision: number;
                                    location: string | null;
                                    source: string | null;
                                    acquiredOn: string | null;
                                    disposedOn: string | null;
                                    note: string | null;
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
        "copy-loans": {
            get: {
                body: unknown;
                params: {};
                query: {
                    filter?: "history" | "open";
                    cursor?: string;
                    limit?: number;
                };
                headers: unknown;
                response: {
                    200: {
                        filter: "history" | "open";
                        boundary: {
                            calendar: "gregorian";
                            zone: "UTC";
                            today: string;
                        };
                        generation: number;
                        items: {
                            loan: {
                                id: string;
                                copyId: string;
                                direction: "borrowed" | "lent";
                                counterparty: {
                                    kind: "name";
                                    name: string;
                                } | {
                                    kind: "person";
                                    state: "available";
                                    personId: string;
                                    displayName: string;
                                } | {
                                    kind: "person";
                                    state: "concealed";
                                };
                                startedOn: string;
                                dueOn: string | null;
                                returnedOn: string | null;
                                revision: number;
                                state: "due" | "overdue" | "returned" | "undated";
                                viewer: {
                                    state: "owner";
                                };
                                actions: {
                                    extend: {
                                        allowed: boolean;
                                        reason: "copy_unavailable" | "returned" | null;
                                    };
                                    return: {
                                        allowed: boolean;
                                        reason: "copy_unavailable" | "returned" | null;
                                    };
                                };
                            };
                            copy: {
                                state: "available" | "deleted" | "missing";
                                id: string;
                                revision: number | null;
                                kind: string | null;
                                status: string | null;
                                context: {
                                    state: "available";
                                    work: {
                                        id: string;
                                        labels: Record<string, string>;
                                    }[];
                                    facts: Record<string, ({
                                        kind: "item";
                                        id: string;
                                        labels: Record<string, string>;
                                    } | {
                                        kind: "time";
                                        year: number;
                                        month?: number;
                                        day?: number;
                                    } | {
                                        kind: "quantity";
                                        amount: number;
                                        unit: string;
                                    } | {
                                        kind: "code";
                                        value: string;
                                    })[]>;
                                } | {
                                    state: "unsupported";
                                    facts: Record<string, ({
                                        kind: "item";
                                        id: string;
                                        labels: Record<string, string>;
                                    } | {
                                        kind: "time";
                                        year: number;
                                        month?: number;
                                        day?: number;
                                    } | {
                                        kind: "quantity";
                                        amount: number;
                                        unit: string;
                                    } | {
                                        kind: "code";
                                        value: string;
                                    })[]>;
                                } | {
                                    state: "scope";
                                } | {
                                    state: "withheld";
                                } | {
                                    state: "missing";
                                } | {
                                    state: "unavailable";
                                };
                            };
                        }[];
                        nextCursor: string | null;
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
        "copy-loans": {
            post: {
                body: {
                    copyId: string;
                    copyRevision: number;
                    direction: "borrowed" | "lent";
                    counterparty: {
                        kind: "name";
                        name: string;
                    } | {
                        kind: "person";
                        personId: string;
                    };
                    startedOn: string;
                    dueOn?: string | null;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        loan: {
                            id: string;
                            copyId: string;
                            direction: "borrowed" | "lent";
                            counterparty: {
                                kind: "name";
                                name: string;
                            } | {
                                kind: "person";
                                state: "available";
                                personId: string;
                                displayName: string;
                            } | {
                                kind: "person";
                                state: "concealed";
                            };
                            startedOn: string;
                            dueOn: string | null;
                            returnedOn: string | null;
                            revision: number;
                            state: "due" | "overdue" | "returned" | "undated";
                            viewer: {
                                state: "owner";
                            };
                            actions: {
                                extend: {
                                    allowed: boolean;
                                    reason: "copy_unavailable" | "returned" | null;
                                };
                                return: {
                                    allowed: boolean;
                                    reason: "copy_unavailable" | "returned" | null;
                                };
                            };
                        };
                        boundary: Readonly<{
                            calendar: 'gregorian';
                            zone: 'UTC';
                            today: string;
                        }>;
                    };
                    201: {
                        loan: {
                            id: string;
                            copyId: string;
                            direction: "borrowed" | "lent";
                            counterparty: {
                                kind: "name";
                                name: string;
                            } | {
                                kind: "person";
                                state: "available";
                                personId: string;
                                displayName: string;
                            } | {
                                kind: "person";
                                state: "concealed";
                            };
                            startedOn: string;
                            dueOn: string | null;
                            returnedOn: string | null;
                            revision: number;
                            state: "due" | "overdue" | "returned" | "undated";
                            viewer: {
                                state: "owner";
                            };
                            actions: {
                                extend: {
                                    allowed: boolean;
                                    reason: "copy_unavailable" | "returned" | null;
                                };
                                return: {
                                    allowed: boolean;
                                    reason: "copy_unavailable" | "returned" | null;
                                };
                            };
                        };
                        boundary: {
                            calendar: "gregorian";
                            zone: "UTC";
                            today: string;
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
        "copy-loans": {
            ":loanId": {
                patch: {
                    body: {
                        revision: number;
                        dueOn: string;
                    };
                    params: {
                        loanId: string;
                    };
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            loan: {
                                id: string;
                                copyId: string;
                                direction: "borrowed" | "lent";
                                counterparty: {
                                    kind: "name";
                                    name: string;
                                } | {
                                    kind: "person";
                                    state: "available";
                                    personId: string;
                                    displayName: string;
                                } | {
                                    kind: "person";
                                    state: "concealed";
                                };
                                startedOn: string;
                                dueOn: string | null;
                                returnedOn: string | null;
                                revision: number;
                                state: "due" | "overdue" | "returned" | "undated";
                                viewer: {
                                    state: "owner";
                                };
                                actions: {
                                    extend: {
                                        allowed: boolean;
                                        reason: "copy_unavailable" | "returned" | null;
                                    };
                                    return: {
                                        allowed: boolean;
                                        reason: "copy_unavailable" | "returned" | null;
                                    };
                                };
                            };
                            boundary: {
                                calendar: "gregorian";
                                zone: "UTC";
                                today: string;
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
        "copy-loans": {
            ":loanId": {
                return: {
                    post: {
                        body: {
                            revision: number;
                            returnedOn: string;
                        };
                        params: {
                            loanId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                loan: {
                                    id: string;
                                    copyId: string;
                                    direction: "borrowed" | "lent";
                                    counterparty: {
                                        kind: "name";
                                        name: string;
                                    } | {
                                        kind: "person";
                                        state: "available";
                                        personId: string;
                                        displayName: string;
                                    } | {
                                        kind: "person";
                                        state: "concealed";
                                    };
                                    startedOn: string;
                                    dueOn: string | null;
                                    returnedOn: string | null;
                                    revision: number;
                                    state: "due" | "overdue" | "returned" | "undated";
                                    viewer: {
                                        state: "owner";
                                    };
                                    actions: {
                                        extend: {
                                            allowed: boolean;
                                            reason: "copy_unavailable" | "returned" | null;
                                        };
                                        return: {
                                            allowed: boolean;
                                            reason: "copy_unavailable" | "returned" | null;
                                        };
                                    };
                                };
                                boundary: {
                                    calendar: "gregorian";
                                    zone: "UTC";
                                    today: string;
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
        followCounts: {
            outgoing: {
                get: {
                    body: unknown;
                    params: {};
                    query: object;
                    headers: unknown;
                    response: {
                        200: {
                            followingCount: number;
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
        followCounts: {
            ":targetType": {
                ":targetId": {
                    get: {
                        body: unknown;
                        params: {
                            targetType: "collection" | "space" | "subject";
                            targetId: string;
                        };
                        query: object;
                        headers: unknown;
                        response: {
                            200: {
                                targetType: "collection" | "space" | "subject";
                                targetId: string;
                                followerCount: number;
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
        follows: {
            ":targetId": {
                put: {
                    body: null | undefined;
                    params: {
                        targetId: string;
                    };
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            follow: {
                                targetId: string;
                                targetType: "collection" | "space" | "subject";
                                state: "following" | "unfollowed";
                                reason: "explicit" | "library" | "membership";
                                updatedAt: string;
                                ownerId: string;
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
        follows: {
            ":targetId": {
                delete: {
                    body: unknown;
                    params: {
                        targetId: string;
                    };
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            follow: {
                                targetId: string;
                                targetType: "collection" | "space" | "subject";
                                state: "following" | "unfollowed";
                                reason: "explicit" | "library" | "membership";
                                updatedAt: string;
                                ownerId: string;
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
        follows: {
            ":targetId": {
                get: {
                    body: unknown;
                    params: {
                        targetId: string;
                    };
                    query: {
                        view?: "BASIC" | "FULL";
                    };
                    headers: unknown;
                    response: {
                        200: {
                            follow: {
                                target?: {
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
                                    kind: "actor" | "organization";
                                    displayName: string | null;
                                } | {
                                    displayName: "Deleted account" | "Deleted organization";
                                } | {
                                    id: string;
                                    type: string;
                                    label: string;
                                } | null;
                                targetId: string;
                                targetType: "collection" | "space" | "subject";
                                state: "following" | "unfollowed";
                                reason: "explicit" | "library" | "membership";
                                updatedAt: string;
                                ownerId: string;
                                destination?: {
                                    kind: "space";
                                    spaceId: string;
                                    address: string;
                                } | {
                                    kind: "realm";
                                    realmId: string;
                                } | {
                                    kind: "unavailable";
                                };
                                actions?: {
                                    status: "available";
                                    resourceType: "community.realm" | "community.space";
                                    resourceId: string;
                                    viewerActions: {
                                        action: string;
                                        operations: string[];
                                    }[];
                                } | {
                                    status: "unavailable";
                                };
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
}, "get", "/v1/follows", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    query: import("typebox").TObject<{
        view: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"BASIC">, import("typebox").TLiteral<"FULL">]>>;
        cursor: import("typebox").TOptional<import("typebox").TString>;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        targetType: import("typebox").TOptional<import("typebox").TEnum<["collection", "space", "subject"]>>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            follows: import("typebox").TArray<import("typebox").TObject<{
                targetId: import("typebox").TString;
                targetType: import("typebox").TUnion<[import("typebox").TLiteral<"subject">, import("typebox").TLiteral<"collection">, import("typebox").TLiteral<"space">]>;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"following">, import("typebox").TLiteral<"unfollowed">]>;
                reason: import("typebox").TUnion<[import("typebox").TLiteral<"explicit">, import("typebox").TLiteral<"library">, import("typebox").TLiteral<"membership">]>;
                updatedAt: import("typebox").TString;
                ownerId: import("typebox").TString;
            } & {
                target: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
                }>, import("typebox").TObject<{
                    id: import("typebox").TString;
                    type: import("typebox").TString;
                    label: import("typebox").TString;
                }>, import("typebox").TNull]>>;
                destination: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"space">;
                    spaceId: import("typebox").TString;
                    address: import("typebox").TString;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"realm">;
                    realmId: import("typebox").TString;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"unavailable">;
                }>]>>;
                actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                    status: import("typebox").TLiteral<"available">;
                    resourceType: import("typebox").TUnion<[import("typebox").TLiteral<"community.space">, import("typebox").TLiteral<"community.realm">]>;
                    resourceId: import("typebox").TString;
                    viewerActions: import("typebox").TArray<import("typebox").TObject<{
                        action: import("typebox").TString;
                        operations: import("typebox").TArray<import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"unavailable">;
                }>]>>;
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
        'x-authority-anchor'?: string;
        'x-authority-resource-types'?: string[];
        'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
    };
}, {}, "/v1/follows">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ actor, query, admission, job, set }: {
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
            follows: {
                target?: {
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
                targetId: string;
                targetType: "collection" | "space" | "subject";
                state: "following" | "unfollowed";
                reason: "explicit" | "library" | "membership";
                updatedAt: string;
                ownerId: string;
                destination?: {
                    kind: "space";
                    spaceId: string;
                    address: string;
                } | {
                    kind: "realm";
                    realmId: string;
                } | {
                    kind: "unavailable";
                };
                actions?: {
                    status: "available";
                    resourceType: "community.realm" | "community.space";
                    resourceId: string;
                    viewerActions: {
                        action: string;
                        operations: string[];
                    }[];
                } | {
                    status: "unavailable";
                };
            }[];
            next: string | null;
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
            follows: {
                target?: {
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
                targetId: string;
                targetType: "collection" | "space" | "subject";
                state: "following" | "unfollowed";
                reason: "explicit" | "library" | "membership";
                updatedAt: string;
                ownerId: string;
                destination?: {
                    kind: "space";
                    spaceId: string;
                    address: string;
                } | {
                    kind: "realm";
                    realmId: string;
                } | {
                    kind: "unavailable";
                };
                actions?: {
                    status: "available";
                    resourceType: "community.realm" | "community.space";
                    resourceId: string;
                    viewerActions: {
                        action: string;
                        operations: string[];
                    }[];
                } | {
                    status: "unavailable";
                };
            }[];
            next: string | null;
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        query: import("typebox").TObject<{
            view: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"BASIC">, import("typebox").TLiteral<"FULL">]>>;
            cursor: import("typebox").TOptional<import("typebox").TString>;
            limit: import("typebox").TOptional<import("typebox").TInteger>;
            targetType: import("typebox").TOptional<import("typebox").TEnum<["collection", "space", "subject"]>>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            200: import("typebox").TObject<{
                follows: import("typebox").TArray<import("typebox").TObject<{
                    targetId: import("typebox").TString;
                    targetType: import("typebox").TUnion<[import("typebox").TLiteral<"subject">, import("typebox").TLiteral<"collection">, import("typebox").TLiteral<"space">]>;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"following">, import("typebox").TLiteral<"unfollowed">]>;
                    reason: import("typebox").TUnion<[import("typebox").TLiteral<"explicit">, import("typebox").TLiteral<"library">, import("typebox").TLiteral<"membership">]>;
                    updatedAt: import("typebox").TString;
                    ownerId: import("typebox").TString;
                } & {
                    target: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
                    }>, import("typebox").TObject<{
                        id: import("typebox").TString;
                        type: import("typebox").TString;
                        label: import("typebox").TString;
                    }>, import("typebox").TNull]>>;
                    destination: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"space">;
                        spaceId: import("typebox").TString;
                        address: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"realm">;
                        realmId: import("typebox").TString;
                    }>, import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"unavailable">;
                    }>]>>;
                    actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                        status: import("typebox").TLiteral<"available">;
                        resourceType: import("typebox").TUnion<[import("typebox").TLiteral<"community.space">, import("typebox").TLiteral<"community.realm">]>;
                        resourceId: import("typebox").TString;
                        viewerActions: import("typebox").TArray<import("typebox").TObject<{
                            action: import("typebox").TString;
                            operations: import("typebox").TArray<import("typebox").TString>;
                        }>>;
                    }>, import("typebox").TObject<{
                        status: import("typebox").TLiteral<"unavailable">;
                    }>]>>;
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
            'x-authority-anchor'?: string;
            'x-authority-resource-types'?: string[];
            'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        };
    }, {}, "/v1/follows">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
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
        targetType?: "collection" | "space" | "subject";
    };
    params: {};
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
    follows: ({
        targetId: string;
        targetType: import("./follow-model.ts").FollowTargetType;
        state: import("./follow-model.ts").FollowState;
        reason: import("./follow-model.ts").FollowReason;
        updatedAt: string;
        ownerId: string;
    } & object & {
        target?: (import("../semantic/summaries.ts").SubjectSummary | {
            id: string;
            label: string;
            type: string;
        }) | null;
    } & {
        destination?: import("./following-space-contract.ts").FollowingSpaceDestination;
        actions?: import("./following-space-contract.ts").FollowingSpaceActions;
    })[];
    next: string | null;
} & object>, {
    query: import("typebox").TObject<{
        view: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TLiteral<"BASIC">, import("typebox").TLiteral<"FULL">]>>;
        cursor: import("typebox").TOptional<import("typebox").TString>;
        limit: import("typebox").TOptional<import("typebox").TInteger>;
        targetType: import("typebox").TOptional<import("typebox").TEnum<["collection", "space", "subject"]>>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            follows: import("typebox").TArray<import("typebox").TObject<{
                targetId: import("typebox").TString;
                targetType: import("typebox").TUnion<[import("typebox").TLiteral<"subject">, import("typebox").TLiteral<"collection">, import("typebox").TLiteral<"space">]>;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"following">, import("typebox").TLiteral<"unfollowed">]>;
                reason: import("typebox").TUnion<[import("typebox").TLiteral<"explicit">, import("typebox").TLiteral<"library">, import("typebox").TLiteral<"membership">]>;
                updatedAt: import("typebox").TString;
                ownerId: import("typebox").TString;
            } & {
                target: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
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
                }>, import("typebox").TObject<{
                    id: import("typebox").TString;
                    type: import("typebox").TString;
                    label: import("typebox").TString;
                }>, import("typebox").TNull]>>;
                destination: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"space">;
                    spaceId: import("typebox").TString;
                    address: import("typebox").TString;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"realm">;
                    realmId: import("typebox").TString;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"unavailable">;
                }>]>>;
                actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                    status: import("typebox").TLiteral<"available">;
                    resourceType: import("typebox").TUnion<[import("typebox").TLiteral<"community.space">, import("typebox").TLiteral<"community.realm">]>;
                    resourceId: import("typebox").TString;
                    viewerActions: import("typebox").TArray<import("typebox").TObject<{
                        action: import("typebox").TString;
                        operations: import("typebox").TArray<import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"unavailable">;
                }>]>>;
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
        'x-authority-anchor'?: string;
        'x-authority-resource-types'?: string[];
        'x-rate-limit'?: Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
    };
}>;
