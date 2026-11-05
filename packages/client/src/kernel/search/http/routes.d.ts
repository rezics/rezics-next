import type { DiscoverySearch } from '../discovery-service.ts';
import type { Resource, AccessCheck } from '../../request/access.ts';
import type { Pool } from 'pg';
import type { Access, AccessFactory } from '../../request/access.ts';
import { createSearchService } from '../service.ts';
import { type KernelClock } from '../../clock.ts';
type SearchServiceImplementation = ReturnType<typeof createSearchService>;
export type SearchService = Omit<SearchServiceImplementation, 'releaseGroups'> & {
    releaseGroups?: SearchServiceImplementation['releaseGroups'];
};
export type EmptyRecoveryAction =
    | { kind: "edit-query" }
    | { kind: "remove-type" }
    | { kind: "remove-kind"; value: string }
    | { kind: "remove-facet"; property: string; value: string }
    | { kind: "remove-range"; property: string };
export type EmptyRecovery = {
    status: "ready" | "preparing" | "unavailable";
    alternatives: { query: string; label: string }[];
    actions: EmptyRecoveryAction[];
};

type SuggestionContextLabelSchema = import("typebox").TObject<{ value: import("typebox").TString; language: import("typebox").TString }>;
type SuggestionContextDateSchema = import("typebox").TUnion<[
    import("typebox").TObject<{ state: import("typebox").TLiteral<"value">; property: import("typebox").TString; value: import("typebox").TString; precision: import("typebox").TLiteral<"year"> }>,
    import("typebox").TObject<{ state: import("typebox").TLiteral<"value">; property: import("typebox").TString; value: import("typebox").TString; precision: import("typebox").TLiteral<"month"> }>,
    import("typebox").TObject<{ state: import("typebox").TLiteral<"value">; property: import("typebox").TString; value: import("typebox").TString; precision: import("typebox").TLiteral<"day"> }>,
    import("typebox").TObject<{ state: import("typebox").TUnion<[import("typebox").TLiteral<"unknown">, import("typebox").TLiteral<"no_value">, import("typebox").TLiteral<"withheld">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"not_applicable">]>; property: import("typebox").TString }>
]>;
type SuggestionWorkContextSchema = import("typebox").TUnion<[
    import("typebox").TObject<{
        subjectId: import("typebox").TString;
        status: import("typebox").TLiteral<"available">;
        creator: import("typebox").TObject<{ id: import("typebox").TString; label: SuggestionContextLabelSchema; property: import("typebox").TString; role: SuggestionContextLabelSchema }>;
        relation: import("typebox").TOptional<import("typebox").TObject<{ kind: import("typebox").TUnion<[import("typebox").TLiteral<"work">, import("typebox").TLiteral<"release">]>; id: import("typebox").TString; label: SuggestionContextLabelSchema; date: import("typebox").TOptional<SuggestionContextDateSchema> }>>;
        overflow: import("typebox").TOptional<import("typebox").TBoolean>;
    }>,
    import("typebox").TObject<{ subjectId: import("typebox").TString; status: import("typebox").TUnion<[import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"empty">, import("typebox").TLiteral<"withheld">, import("typebox").TLiteral<"unavailable">]> }>
]>;
type SuggestionContextLabel = { value: string; language: string };
type SuggestionContextDate =
    | { state: "value"; property: string; value: string; precision: "year" | "month" | "day" }
    | { state: "unknown" | "no_value" | "withheld" | "unavailable" | "not_applicable"; property: string };
type SuggestionWorkContext =
    | { subjectId: string; status: "available"; creator: { id: string; label: SuggestionContextLabel; property: string; role: SuggestionContextLabel }; relation?: { kind: "work" | "release"; id: string; label: SuggestionContextLabel; date?: SuggestionContextDate }; overflow?: boolean }
    | { subjectId: string; status: "absent" | "not_applicable" | "empty" | "withheld" | "unavailable" };
export declare const FactSchema: import("typebox").TUnion<[import("typebox").TObject<{
    kind: import("typebox").TLiteral<"item">;
    id: import("typebox").TString;
    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"time">;
    year: import("typebox").TInteger;
    month: import("typebox").TOptional<import("typebox").TInteger>;
    day: import("typebox").TOptional<import("typebox").TInteger>;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"quantity">;
    amount: import("typebox").TNumber;
    unit: import("typebox").TString;
}>, import("typebox").TObject<{
    kind: import("typebox").TLiteral<"code">;
    value: import("typebox").TString;
}>]>;
export declare function searchRoutes<App>(app: App, { pool, routeKey, search, discovery, access, gateAccess, clock, }: {
    pool: Pool;
    routeKey: Uint8Array;
    search?: SearchService;
    discovery?: DiscoverySearch;
    access?: Access | AccessFactory;
    gateAccess?: () => Access;
    clock?: KernelClock;
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
        trendingSearches: {
            get: {
                body: unknown;
                params: {};
                query: {
                    language: string;
                    limit?: string | number;
                };
                headers: unknown;
                response: {
                    200: {
                        trendingSearches: {
                            query: string;
                            display: string;
                        }[];
                        next: null;
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
        subjects: {
            $search: {
                post: {
                    body: {
                        prepareShare?: boolean;
                        representation?: "discovery-v1" | "release-groups-v1";
                        kindPage?: {
                            limit: number;
                            cursor?: string;
                        };
                        kindCountLeaf?: number;
                        text?: string;
                        filter?: any;
                        population?: {
                            realm: string;
                        };
                        spoilerThreshold?: number;
                        sort?: "collections" | "id" | "name" | "rating" | "relevance";
                        limit?: number;
                        cursor?: string;
                        work?: string;
                        childCursor?: string;
                        kindCursor?: string;
                        descriptions?: boolean;
                        languages?: string[];
                        properties?: string[];
                        emptyRecoveryActions?: EmptyRecoveryAction[];
                    };
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            hits: ({
                                key: {
                                    owner: "semantic";
                                    kind: string;
                                    route: number;
                                    id: string;
                                };
                                summary: {
                                    kind: "subject";
                                    value: {
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
                                };
                                matchEvidence: {
                                    state: "absent";
                                } | {
                                    state: "unsupported";
                                } | {
                                    state: "unavailable";
                                } | {
                                    state: "current";
                                    source: {
                                        id: string;
                                        revision: number;
                                    };
                                    query: string;
                                    reasons: {
                                        field: "alias" | "description" | "title";
                                        language: string;
                                        text: string;
                                        spans: {
                                            start: number;
                                            end: number;
                                        }[];
                                    }[];
                                };
                                labels?: Record<string, string>;
                                aliases?: Record<string, string[]>;
                                descriptions?: Record<string, string>;
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
                                figure?: {
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
                                listPresentation?: {
                                    imageAspect: "landscape" | "portrait" | "square";
                                    keyFacts: string[];
                                };
                                contexts?: {
                                    credits: {
                                        items: {
                                            id: string;
                                            labels: Record<string, string>;
                                            aliases?: Record<string, string[]>;
                                        }[];
                                        next: boolean;
                                    };
                                    appearances: {
                                        items: {
                                            id: string;
                                            labels: Record<string, string>;
                                            aliases?: Record<string, string[]>;
                                        }[];
                                        next: boolean;
                                    };
                                };
                            } | {
                                key: {
                                    owner: "accounts";
                                    kind: string;
                                    route: number;
                                    id: string;
                                };
                                summary: {
                                    kind: "account";
                                    value: {
                                        id: string;
                                        accountKind: "actor" | "organization";
                                        handle: string | null;
                                        displayName: string | null;
                                        automated: boolean;
                                        operatorId: string | null;
                                        avatar: {
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
                                            credit: null;
                                        } | null;
                                        verifiedAgent: {
                                            id: string;
                                            label: string;
                                            type: string;
                                        } | null;
                                    };
                                };
                                matchEvidence: {
                                    state: "absent";
                                } | {
                                    state: "unsupported";
                                } | {
                                    state: "unavailable";
                                } | {
                                    state: "current";
                                    source: {
                                        id: string;
                                        revision: number;
                                    };
                                    query: string;
                                    reasons: {
                                        field: "alias" | "description" | "title";
                                        language: string;
                                        text: string;
                                        spans: {
                                            start: number;
                                            end: number;
                                        }[];
                                    }[];
                                };
                            } | {
                                key: {
                                    owner: "library";
                                    kind: "collection";
                                    route: number;
                                    id: string;
                                };
                                summary: {
                                    kind: "collection";
                                    value: {
                                        id: string;
                                        title: string;
                                        description: string | null;
                                        card: {
                                            kind: "collection";
                                            id: string;
                                            destination: string;
                                            title: string;
                                            description: string | null;
                                            visibility: "public";
                                            revision: number;
                                            presentationKind: string | null;
                                            presentationKindSource: "mixed" | "owner";
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
                                            coverSource: "member" | "none" | "owner" | "pending";
                                            membershipKind: "curated";
                                            memberCount: number;
                                            orderEpoch: number;
                                            createdAt: string;
                                            updatedAt: string;
                                        } | {
                                            kind: "collection";
                                            id: string;
                                            destination: string;
                                            title: string;
                                            description: string | null;
                                            visibility: "public";
                                            revision: number;
                                            presentationKind: string | null;
                                            presentationKindSource: "mixed" | "owner";
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
                                            coverSource: "member" | "none" | "owner" | "pending";
                                            membershipKind: "dynamic";
                                            outputGeneration: string;
                                        };
                                    };
                                };
                                matchEvidence: {
                                    state: "absent";
                                } | {
                                    state: "unsupported";
                                } | {
                                    state: "unavailable";
                                } | {
                                    state: "current";
                                    source: {
                                        id: string;
                                        revision: number;
                                    };
                                    query: string;
                                    reasons: {
                                        field: "alias" | "description" | "title";
                                        language: string;
                                        text: string;
                                        spans: {
                                            start: number;
                                            end: number;
                                        }[];
                                    }[];
                                };
                            } | {
                                key: {
                                    owner: "content";
                                    kind: "review";
                                    route: number;
                                    id: string;
                                };
                                summary: {
                                    kind: "review";
                                    value: {
                                        id: string;
                                        kind: "review";
                                        title: string | null;
                                        author?: {
                                            displayName: string | null;
                                            handle: string | null;
                                        };
                                        excerpt?: string;
                                        subject?: {
                                            id: string;
                                            title: string | null;
                                        } | null;
                                    };
                                };
                                matchEvidence: {
                                    state: "absent";
                                } | {
                                    state: "unsupported";
                                } | {
                                    state: "unavailable";
                                } | {
                                    state: "current";
                                    source: {
                                        id: string;
                                        revision: number;
                                    };
                                    query: string;
                                    reasons: {
                                        field: "alias" | "description" | "title";
                                        language: string;
                                        text: string;
                                        spans: {
                                            start: number;
                                            end: number;
                                        }[];
                                    }[];
                                };
                            } | {
                                key: {
                                    owner: "community";
                                    kind: "space";
                                    route: number;
                                    id: string;
                                };
                                summary: {
                                    kind: "space";
                                    value: {
                                        id: string;
                                        title: string;
                                        address: string;
                                        summary?: string;
                                        realm?: {
                                            id: string;
                                            title: string | null;
                                        } | null;
                                    };
                                };
                                matchEvidence: {
                                    state: "absent";
                                } | {
                                    state: "unsupported";
                                } | {
                                    state: "unavailable";
                                } | {
                                    state: "current";
                                    source: {
                                        id: string;
                                        revision: number;
                                    };
                                    query: string;
                                    reasons: {
                                        field: "alias" | "description" | "title";
                                        language: string;
                                        text: string;
                                        spans: {
                                            start: number;
                                            end: number;
                                        }[];
                                    }[];
                                };
                            })[];
                            kinds: {
                                values: {
                                    id: string;
                                    labels: Record<string, string>;
                                    icon: string;
                                    count?: {
                                        kind: string;
                                        value: number;
                                        exact: true;
                                    } | {
                                        kind: string;
                                        value: number;
                                        exact: false;
                                    } | {
                                        kind: string;
                                        unavailable: true;
                                    };
                                }[];
                                next: string | null;
                            };
                            next: string | null;
                            as_of: string;
                            emptyRecovery?: EmptyRecovery;
                            viewerFacts?: {
                                state: "unavailable";
                                reason: "currentness" | "identity" | "response_limit";
                                retryable: boolean;
                            } | {
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
                                    resolvedSubjectId?: string;
                                }[];
                            } | null;
                        } | {
                            subjects: {
                                id: string;
                                type: string;
                                kind: string;
                                base: {
                                    id: string;
                                    kind: string;
                                    kindLabel: {
                                        value: string;
                                        language: string;
                                    };
                                    title: {
                                        value: string;
                                        language: string;
                                    } | null;
                                    image: {
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
                                        aspect: {
                                            width: number;
                                            height: number;
                                        };
                                    } | null;
                                    url: {
                                        id: string;
                                        label: {
                                            value: string;
                                            language: string;
                                        } | null;
                                    };
                                };
                                labels: Record<string, string>;
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
                                matchEvidence: {
                                    state: "absent";
                                } | {
                                    state: "unsupported";
                                } | {
                                    state: "unavailable";
                                } | {
                                    state: "current";
                                    source: {
                                        id: string;
                                        revision: number;
                                    };
                                    query: string;
                                    reasons: {
                                        field: "alias" | "description" | "title";
                                        language: string;
                                        text: string;
                                        spans: {
                                            start: number;
                                            end: number;
                                        }[];
                                    }[];
                                };
                                descriptions?: Record<string, string>;
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
                            }[];
                            kinds?: {
                                values: {
                                    value: string;
                                    label: {
                                        value: string;
                                        language: string;
                                    };
                                    icon: string | null;
                                    count?: {
                                        value: number;
                                        exact: boolean;
                                    };
                                }[];
                                next: string | null;
                            };
                            next: string | null;
                            as_of: string;
                            emptyRecovery?: EmptyRecovery;
                        } | import("../query-share.ts").QueryShare | {
                            status: "preparing" | "ready";
                            groups: ({
                                kind: "work";
                                id: string;
                                work: {
                                    id: string;
                                    type: string;
                                    kind: string;
                                    base: {
                                        id: string;
                                        kind: string;
                                        kindLabel: {
                                            value: string;
                                            language: string;
                                        };
                                        title: {
                                            value: string;
                                            language: string;
                                        } | null;
                                        image: {
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
                                            aspect: {
                                                width: number;
                                                height: number;
                                            };
                                        } | null;
                                        url: {
                                            id: string;
                                            label: {
                                                value: string;
                                                language: string;
                                            } | null;
                                        };
                                    };
                                    labels: Record<string, string>;
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
                                    matchEvidence: {
                                        state: "absent";
                                    } | {
                                        state: "unsupported";
                                    } | {
                                        state: "unavailable";
                                    } | {
                                        state: "current";
                                        source: {
                                            id: string;
                                            revision: number;
                                        };
                                        query: string;
                                        reasons: {
                                            field: "alias" | "description" | "title";
                                            language: string;
                                            text: string;
                                            spans: {
                                                start: number;
                                                end: number;
                                            }[];
                                        }[];
                                    };
                                    descriptions?: Record<string, string>;
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
                                releases: {
                                    id: string;
                                    type: string;
                                    kind: string;
                                    base: {
                                        id: string;
                                        kind: string;
                                        kindLabel: {
                                            value: string;
                                            language: string;
                                        };
                                        title: {
                                            value: string;
                                            language: string;
                                        } | null;
                                        image: {
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
                                            aspect: {
                                                width: number;
                                                height: number;
                                            };
                                        } | null;
                                        url: {
                                            id: string;
                                            label: {
                                                value: string;
                                                language: string;
                                            } | null;
                                        };
                                    };
                                    labels: Record<string, string>;
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
                                    matchEvidence: {
                                        state: "absent";
                                    } | {
                                        state: "unsupported";
                                    } | {
                                        state: "unavailable";
                                    } | {
                                        state: "current";
                                        source: {
                                            id: string;
                                            revision: number;
                                        };
                                        query: string;
                                        reasons: {
                                            field: "alias" | "description" | "title";
                                            language: string;
                                            text: string;
                                            spans: {
                                                start: number;
                                                end: number;
                                            }[];
                                        }[];
                                    };
                                    descriptions?: Record<string, string>;
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
                                }[];
                                next: string | null;
                            } | {
                                kind: "release";
                                id: string;
                                release: {
                                    id: string;
                                    type: string;
                                    kind: string;
                                    base: {
                                        id: string;
                                        kind: string;
                                        kindLabel: {
                                            value: string;
                                            language: string;
                                        };
                                        title: {
                                            value: string;
                                            language: string;
                                        } | null;
                                        image: {
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
                                            aspect: {
                                                width: number;
                                                height: number;
                                            };
                                        } | null;
                                        url: {
                                            id: string;
                                            label: {
                                                value: string;
                                                language: string;
                                            } | null;
                                        };
                                    };
                                    labels: Record<string, string>;
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
                                    matchEvidence: {
                                        state: "absent";
                                    } | {
                                        state: "unsupported";
                                    } | {
                                        state: "unavailable";
                                    } | {
                                        state: "current";
                                        source: {
                                            id: string;
                                            revision: number;
                                        };
                                        query: string;
                                        reasons: {
                                            field: "alias" | "description" | "title";
                                            language: string;
                                            text: string;
                                            spans: {
                                                start: number;
                                                end: number;
                                            }[];
                                        }[];
                                    };
                                    descriptions?: Record<string, string>;
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
                                workLink: "conflicting" | "missing" | "unavailable" | "unknown" | "unproven";
                            })[];
                            next: string | null;
                            as_of: string;
                        } | {
                            status: "preparing" | "ready";
                            children: {
                                id: string;
                                type: string;
                                kind: string;
                                base: {
                                    id: string;
                                    kind: string;
                                    kindLabel: {
                                        value: string;
                                        language: string;
                                    };
                                    title: {
                                        value: string;
                                        language: string;
                                    } | null;
                                    image: {
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
                                        aspect: {
                                            width: number;
                                            height: number;
                                        };
                                    } | null;
                                    url: {
                                        id: string;
                                        label: {
                                            value: string;
                                            language: string;
                                        } | null;
                                    };
                                };
                                labels: Record<string, string>;
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
                                matchEvidence: {
                                    state: "absent";
                                } | {
                                    state: "unsupported";
                                } | {
                                    state: "unavailable";
                                } | {
                                    state: "current";
                                    source: {
                                        id: string;
                                        revision: number;
                                    };
                                    query: string;
                                    reasons: {
                                        field: "alias" | "description" | "title";
                                        language: string;
                                        text: string;
                                        spans: {
                                            start: number;
                                            end: number;
                                        }[];
                                    }[];
                                };
                                descriptions?: Record<string, string>;
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
                            }[];
                            next: string | null;
                            as_of: string;
                        };                        400: Response | {
                            type: unknown;
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
                        default: {} | undefined;
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        subjects: {
            $facets: {
                post: {
                    body: {
                        text?: string;
                        filter?: any;
                        conditions?: any;
                        kinds?: string[];
                        languages?: string[];
                        scope?: {
                            kind: "collection" | "realm";
                            id: string;
                        };
                        facets: {
                            property: string;
                            size?: number;
                            cursor?: string;
                        }[];
                    };
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            facets: {
                                property: string;
                                next: string | null;
                                values: {
                                    value: string;
                                    labels: Record<string, string>;
                                }[];
                            }[];
                            as_of: string;
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
        readonly admission: import("../../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../../request/access.ts").AccountActor | {
            kind: 'anonymous';
        };
        readonly session: {
            readonly components: import("../../tokens/session.ts").SessionComponent[];
            record(component: import("../../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: Resource) => Promise<AccessCheck>;
        readonly authorizeCommand: (resource: Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "get", "/v1/subjects/$suggest", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    query: import("typebox").TObject<{
        q: import("typebox").TString;
        limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
        languages: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        filter: import("typebox").TOptional<import("typebox").TString>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subjects: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                type: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                summary: import("typebox").TUnion<[import("typebox").TObject<{
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
                }>, import("typebox").TNull]>;
                workContext: import("typebox").TOptional<SuggestionWorkContextSchema>;
            }>>;
            as_of: import("typebox").TString;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        description: string;
        'x-exposure': string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
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
}, "/v1/subjects/$suggest">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ query, authorize, admission, job, actor, set }: {
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
            subjects: {
                id: string;
                type: string;
                labels: Record<string, string>;
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
                workContext?: SuggestionWorkContext;
            }[];
            as_of: string;
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
    }>;
    problem: import("elysia").SelectiveProblem<{
        200: {
            subjects: {
                id: string;
                type: string;
                labels: Record<string, string>;
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
                workContext?: SuggestionWorkContext;
            }[];
            as_of: string;
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
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        query: import("typebox").TObject<{
            q: import("typebox").TString;
            limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
            languages: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            filter: import("typebox").TOptional<import("typebox").TString>;
        }>;
        response: {
            200: import("typebox").TObject<{
                subjects: import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TString;
                    type: import("typebox").TString;
                    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    summary: import("typebox").TUnion<[import("typebox").TObject<{
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
                    }>, import("typebox").TNull]>;
                workContext: import("typebox").TOptional<SuggestionWorkContextSchema>;
                }>>;
                as_of: import("typebox").TString;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            description: string;
            'x-exposure': string;
            'x-action': string;
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
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
    }, "/v1/subjects/$suggest">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("../../http/admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../../request/access.ts").AccountActor | {
                kind: 'anonymous';
            };
            readonly session: {
                readonly components: import("../../tokens/session.ts").SessionComponent[];
                record(component: import("../../tokens/session.ts").SessionComponent): void;
            };
            readonly authorize: (resource: Resource) => Promise<AccessCheck>;
            readonly authorizeCommand: (resource: Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: {
        q: string;
        limit?: number;
        languages?: string[];
        filter?: string;
    };
    params: {};
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("../../http/admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../../request/access.ts").AccountActor | {
        kind: 'anonymous';
    };
    readonly session: {
        readonly components: import("../../tokens/session.ts").SessionComponent[];
        record(component: import("../../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: Resource) => Promise<AccessCheck>;
    readonly authorizeCommand: (resource: Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    subjects: {
        id: string;
        type: string;
        labels: Record<string, string>;
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
        workContext?: SuggestionWorkContext;
    }[];
    as_of: string;
}>, {
    query: import("typebox").TObject<{
        q: import("typebox").TString;
        limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
        languages: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
        filter: import("typebox").TOptional<import("typebox").TString>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subjects: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                type: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                summary: import("typebox").TUnion<[import("typebox").TObject<{
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
                }>, import("typebox").TNull]>;
                workContext: import("typebox").TOptional<SuggestionWorkContextSchema>;
            }>>;
            as_of: import("typebox").TString;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<"invalid_format" | "invalid_type" | "out_of_range" | "required" | "unknown_field" | "unsupported">[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        description: string;
        'x-exposure': string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}> & App;
export {};
