import { type SubjectSummary } from '../../semantic/summaries.ts';
import { activeRelease } from '../../semantic/definitions.ts';
import type { Resource, AccessCheck } from '../../request/access.ts';
import type { Static } from 'typebox';
import type { Pool } from 'pg';
import { type PublicSearchPage } from '../service.ts';
import { EmptyRecoverySchema } from './empty-recovery-schemas.ts';
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
declare function genericBase(): import("typebox").TObject<{
    id: import("typebox").TString;
    kind: import("typebox").TString;
    kindLabel: import("typebox").TObject<{
        value: import("typebox").TString;
        language: import("typebox").TString;
    }>;
    title: import("typebox").TUnion<[import("typebox").TObject<{
        value: import("typebox").TString;
        language: import("typebox").TString;
    }>, import("typebox").TNull]>;
    image: import("typebox").TUnion<[import("typebox").TObject<{
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
        aspect: import("typebox").TObject<{
            width: import("typebox").TInteger;
            height: import("typebox").TInteger;
        }>;
    }>, import("typebox").TNull]>;
    url: import("typebox").TObject<{
        id: import("typebox").TString;
        label: import("typebox").TUnion<[import("typebox").TObject<{
            value: import("typebox").TString;
            language: import("typebox").TString;
        }>, import("typebox").TNull]>;
    }>;
}>;
export declare function searchHit(): import("typebox").TObject<{
    id: import("typebox").TString;
    type: import("typebox").TString;
    kind: import("typebox").TString;
    base: import("typebox").TObject<{
        id: import("typebox").TString;
        kind: import("typebox").TString;
        kindLabel: import("typebox").TObject<{
            value: import("typebox").TString;
            language: import("typebox").TString;
        }>;
        title: import("typebox").TUnion<[import("typebox").TObject<{
            value: import("typebox").TString;
            language: import("typebox").TString;
        }>, import("typebox").TNull]>;
        image: import("typebox").TUnion<[import("typebox").TObject<{
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
            aspect: import("typebox").TObject<{
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
            }>;
        }>, import("typebox").TNull]>;
        url: import("typebox").TObject<{
            id: import("typebox").TString;
            label: import("typebox").TUnion<[import("typebox").TObject<{
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>, import("typebox").TNull]>;
        }>;
    }>;
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
    matchEvidence: import("typebox").TUnion<[import("typebox").TObject<{
        state: import("typebox").TLiteral<"absent">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unsupported">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"unavailable">;
    }>, import("typebox").TObject<{
        state: import("typebox").TLiteral<"current">;
        source: import("typebox").TObject<{
            id: import("typebox").TString;
            revision: import("typebox").TInteger;
        }>;
        query: import("typebox").TString;
        reasons: import("typebox").TArray<import("typebox").TObject<{
            field: import("typebox").TUnion<[import("typebox").TLiteral<"title">, import("typebox").TLiteral<"alias">, import("typebox").TLiteral<"description">]>;
            language: import("typebox").TString;
            text: import("typebox").TString;
            spans: import("typebox").TArray<import("typebox").TObject<{
                start: import("typebox").TInteger;
                end: import("typebox").TInteger;
            }>>;
        }>>;
    }>]>;
    descriptions: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
    facts: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
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
    }>]>>>>;
    figure: import("typebox").TRef<"PublicFigure">;
}>;
export declare function searchResponse(): import("typebox").TObject<{
    subjects: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        type: import("typebox").TString;
        kind: import("typebox").TString;
        base: import("typebox").TObject<{
            id: import("typebox").TString;
            kind: import("typebox").TString;
            kindLabel: import("typebox").TObject<{
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>;
            title: import("typebox").TUnion<[import("typebox").TObject<{
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>, import("typebox").TNull]>;
            image: import("typebox").TUnion<[import("typebox").TObject<{
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
                aspect: import("typebox").TObject<{
                    width: import("typebox").TInteger;
                    height: import("typebox").TInteger;
                }>;
            }>, import("typebox").TNull]>;
            url: import("typebox").TObject<{
                id: import("typebox").TString;
                label: import("typebox").TUnion<[import("typebox").TObject<{
                    value: import("typebox").TString;
                    language: import("typebox").TString;
                }>, import("typebox").TNull]>;
            }>;
        }>;
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
        matchEvidence: import("typebox").TUnion<[import("typebox").TObject<{
            state: import("typebox").TLiteral<"absent">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unsupported">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"unavailable">;
        }>, import("typebox").TObject<{
            state: import("typebox").TLiteral<"current">;
            source: import("typebox").TObject<{
                id: import("typebox").TString;
                revision: import("typebox").TInteger;
            }>;
            query: import("typebox").TString;
            reasons: import("typebox").TArray<import("typebox").TObject<{
                field: import("typebox").TUnion<[import("typebox").TLiteral<"title">, import("typebox").TLiteral<"alias">, import("typebox").TLiteral<"description">]>;
                language: import("typebox").TString;
                text: import("typebox").TString;
                spans: import("typebox").TArray<import("typebox").TObject<{
                    start: import("typebox").TInteger;
                    end: import("typebox").TInteger;
                }>>;
            }>>;
        }>]>;
        descriptions: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
        facts: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
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
        }>]>>>>;
        figure: import("typebox").TRef<"PublicFigure">;
    }>>;
    kinds: import("typebox").TOptional<import("typebox").TObject<{
        values: import("typebox").TArray<import("typebox").TObject<{
            value: import("typebox").TString;
            label: import("typebox").TObject<{
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>;
            icon: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            count: import("typebox").TOptional<import("typebox").TObject<{
                value: import("typebox").TInteger;
                exact: import("typebox").TBoolean;
            }>>;
        }>>;
        next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>>;
    next: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
    as_of: import("typebox").TString;
    freshness: import("typebox").TOptional<import("typebox").TObject<{
        state: import("typebox").TUnion<[import("typebox").TLiteral<"current">, import("typebox").TLiteral<"catching-up">, import("typebox").TLiteral<"unavailable">]>;
    }>>;
    emptyRecovery: import("typebox").TOptional<import("typebox").TObject<{
        status: import("typebox").TUnion<[import("typebox").TLiteral<"ready">, import("typebox").TLiteral<"preparing">, import("typebox").TLiteral<"unavailable">]>;
        alternatives: import("typebox").TArray<import("typebox").TObject<{
            query: import("typebox").TString;
            label: import("typebox").TString;
        }>>;
        actions: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
            kind: import("typebox").TLiteral<"edit-query">;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"remove-type">;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"remove-kind">;
            value: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"remove-facet">;
            property: import("typebox").TString;
            value: import("typebox").TString;
        }>, import("typebox").TObject<{
            kind: import("typebox").TLiteral<"remove-range">;
            property: import("typebox").TString;
        }>]>>;
    }>>;
}>;
export type SearchHttpBase = Static<ReturnType<typeof genericBase>>;
export type SearchHttpResponse = Omit<PublicSearchPage, 'subjects'> & {
    emptyRecovery?: Static<typeof EmptyRecoverySchema>;
    subjects: (PublicSearchPage['subjects'][number] & {
        summary: SubjectSummary | null;
        kind: string;
        base: SearchHttpBase;
    })[];
};
/** Shared native summary hydration for catalogue and suggestion responses. */
export declare function createCatalogueResponseAdapter({ pool, routeKey }: {
    pool: Pool;
    routeKey: Uint8Array;
}): {
    fill: <T extends {
        subjects: {
            id: string;
            type: string;
            labels: Record<string, string>;
        }[];
    }>(page: T, authorize: (resource: Resource) => Promise<AccessCheck>, languages?: readonly string[], active?: Awaited<ReturnType<typeof activeRelease>> | undefined) => Promise<Omit<T, 'subjects'> & {
        subjects: (T['subjects'][number] & {
            summary: SubjectSummary | null;
        })[];
    }>;
    publicBases: <T extends {
        subjects: {
            id: string;
            type: string;
            labels: Record<string, string>;
            summary: SubjectSummary | null;
        }[];
    }>(page: T, languages: readonly string[], active: Awaited<ReturnType<typeof activeRelease>>) => Omit<T, 'subjects'> & {
        subjects: (T['subjects'][number] & {
            kind: string;
            base: SearchHttpBase;
        })[];
    };
    renderSelected: (subjects: readonly string[], authorize: (resource: Resource) => Promise<AccessCheck>, languages?: readonly string[], active?: Awaited<ReturnType<typeof activeRelease>> | undefined) => Promise<Omit<Omit<{
        subjects: {
            id: string;
            type: string;
            labels: Record<string, string>;
        }[];
    }, "subjects"> & {
        subjects: ({
            id: string;
            type: string;
            labels: Record<string, string>;
        } & {
            summary: SubjectSummary | null;
        })[];
    }, "subjects"> & {
        subjects: ({
            id: string;
            type: string;
            labels: Record<string, string>;
        } & {
            summary: SubjectSummary | null;
        } & {
            kind: string;
            base: SearchHttpBase;
        })[];
    }>;
};
export {};
