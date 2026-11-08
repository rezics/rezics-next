import { type ZoneConfiguration } from '@rezics/composition';
import type { Static, TLiteral, TOptional, TSchema, TUnion } from 'typebox';
type OptionalLocaleProperties<Locales extends readonly string[], Value extends TSchema> = {
    [Locale in Locales[number]]: TOptional<Value>;
};
/** Public Zone fields only. Configuration, owner, mount, and scope data stay private. */
export declare function ZonePublicSchema(): import("typebox").TObject<{
    id: import("typebox").TString;
    revision: import("typebox").TString;
    labels: import("typebox").TObject<OptionalLocaleProperties<readonly ["en", "zh-Hant", "zh-Hans", "ja", "ko", "de", "fr", "es"], import("typebox").TIntersect<[import("typebox").TString, import("typebox").TString]>>>;
    primaryLanguage: TOptional<TUnion<[TLiteral<"en">, TLiteral<"zh-Hant">, TLiteral<"zh-Hans">, TLiteral<"ja">, TLiteral<"ko">, TLiteral<"de">, TLiteral<"fr">, TLiteral<"es">]>>;
    visibility: TUnion<[TLiteral<"private">, TLiteral<"unlisted">, TLiteral<"public">]>;
    appearance: import("typebox").TObject<{
        density: TOptional<TUnion<[TLiteral<"compact">, TLiteral<"comfortable">]>>;
        radius: TOptional<TUnion<[TLiteral<"sm">, TLiteral<"md">, TLiteral<"lg">]>>;
        surface: TOptional<TUnion<[TLiteral<"flat">, TLiteral<"cards">]>>;
        cover: TOptional<TUnion<[TLiteral<"portrait">, TLiteral<"square">, TLiteral<"landscape">]>>;
        headingScale: TOptional<TUnion<[TLiteral<"md">, TLiteral<"lg">]>>;
    }>;
    navigation: import("typebox").TArray<import("typebox").TObject<{
        route: import("typebox").TString;
    }>>;
}>;
/** The body accepted by a future Zone page-read command. */
export declare function ZonePageRequestSchema(): import("typebox").TObject<{
    target: TUnion<[import("typebox").TObject<{
        route: import("typebox").TString;
    }>, import("typebox").TObject<{
        subject: import("typebox").TString;
        view: TOptional<TUnion<[TLiteral<"overview">, TLiteral<"editions">, TLiteral<"contents">, TLiteral<"characters">, TLiteral<"appearances">, TLiteral<"credits">, TLiteral<"works">, TLiteral<"relations">, TLiteral<"posts">, TLiteral<"reviews">, TLiteral<"discussion">, TLiteral<"lists">, TLiteral<"collections">, TLiteral<"details">]>>;
    }>]>;
    languages: TOptional<import("typebox").TArray<import("typebox").TString>>;
}>;
/** The existing common page response with a top-level public Zone shell. */
export declare function ZonePageResponseSchema(): import("typebox").TObject<{
    subject: TOptional<import("typebox").TString>;
    account: TOptional<import("typebox").TString>;
    context: TOptional<import("typebox").TObject<{
        id: import("typebox").TString;
        population: TUnion<[import("typebox").TObject<{
            kind: TLiteral<"global">;
        }>, import("typebox").TObject<{
            kind: TLiteral<"realm">;
            id: import("typebox").TString;
            title: import("typebox").TString;
        }>]>;
    }>>;
    continuation: TOptional<import("typebox").TObject<{
        node: import("typebox").TString;
        cursor: import("typebox").TString;
    }>>;
    streams: TOptional<import("typebox").TObject<{
        selected: TOptional<import("typebox").TString>;
        entries: import("typebox").TArray<import("typebox").TObject<{
            node: import("typebox").TString;
            property: import("typebox").TString;
            direction: TUnion<[TLiteral<"forward">, TLiteral<"inverse">]>;
        }>>;
    }>>;
    profile: import("typebox").TString;
    template: import("typebox").TObject<{
        scope: TUnion<[TLiteral<"route">, TLiteral<"type">, TLiteral<"base">, TLiteral<"generic">]>;
        key: TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
    document: import("typebox").TAny;
    views: TOptional<import("typebox").TArray<import("typebox").TString>>;
    catalogue: TOptional<import("typebox").TObject<{
        state: TUnion<[TLiteral<"released">, TLiteral<"unsupported">, TLiteral<"unavailable">]>;
        type: import("typebox").TString;
        digest: TOptional<import("typebox").TString>;
        definitions: TOptional<import("typebox").TObject<{
            types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
            properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
        }>>;
        directions: TOptional<import("typebox").TArray<TUnion<[import("typebox").TObject<{
            state: TLiteral<"admitted">;
            property: import("typebox").TString;
            direction: TUnion<[TLiteral<"forward">, TLiteral<"inverse">]>;
            inverse: TUnion<[import("typebox").TString, import("typebox").TNull]>;
            sourceTypes: import("typebox").TArray<import("typebox").TString>;
            targetTypes: import("typebox").TArray<import("typebox").TString>;
            viaQualifier: TOptional<import("typebox").TString>;
            release: import("typebox").TString;
            qualifiers: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                datatype: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>>;
        }>, import("typebox").TObject<{
            state: TUnion<[TLiteral<"unsupported">, TLiteral<"unavailable">]>;
            property: import("typebox").TString;
            direction: TUnion<[TLiteral<"forward">, TLiteral<"inverse">]>;
            release: TUnion<[import("typebox").TString, import("typebox").TNull]>;
            reason: TUnion<[TLiteral<"missing-release-pin">, TLiteral<"stale-release">, TLiteral<"missing-property">, TLiteral<"missing-inverse">, TLiteral<"ambiguous-inverse">, TLiteral<"inapplicable-type">, TLiteral<"stale-descriptor">]>;
        }>]>>>;
    }>>;
    viewer: TOptional<TUnion<[import("typebox").TObject<{
        state: TUnion<[TLiteral<"anonymous">, TLiteral<"account">]>;
        account: TOptional<import("typebox").TString>;
        context: import("typebox").TString;
        actions: import("typebox").TObject<{
            statementPropose: TUnion<[TLiteral<"allowed">, TLiteral<"denied">, TLiteral<"unavailable">]>;
        }>;
    }>, import("typebox").TObject<{
        kind: TUnion<[TLiteral<"anonymous">, TLiteral<"account">]>;
        account: TOptional<import("typebox").TString>;
    }>]>>;
    reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
        status: import("typebox").TInteger;
        body: import("typebox").TAny;
        headers: TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
    }>>;
    meanings: TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
        text: import("typebox").TString;
        lang: TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>>>;
    unavailable: TOptional<import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        admitted: TLiteral<false>;
    }>>>;
    actions: TOptional<TUnion<[import("typebox").TArray<import("typebox").TObject<{
        action: import("typebox").TString;
        operationId: import("typebox").TString;
        state: TUnion<[TLiteral<"allowed">, TLiteral<"denied">, TLiteral<"unavailable">, TLiteral<"unsupported">, TLiteral<"absent">, TLiteral<"withheld">]>;
    }>>, import("typebox").TObject<{
        status: TLiteral<"ready">;
        viewerActions: import("typebox").TArray<import("typebox").TObject<{
            action: import("typebox").TString;
            operations: import("typebox").TArray<import("typebox").TString>;
        }>>;
    }>, import("typebox").TObject<{
        status: TLiteral<"withheld">;
    }>, import("typebox").TObject<{
        status: TLiteral<"unavailable">;
    }>, import("typebox").TObject<{
        status: TLiteral<"denied">;
    }>]>>;
} & {
    zone: import("typebox").TObject<{
        id: import("typebox").TString;
        revision: import("typebox").TString;
        labels: import("typebox").TObject<OptionalLocaleProperties<readonly ["en", "zh-Hant", "zh-Hans", "ja", "ko", "de", "fr", "es"], import("typebox").TIntersect<[import("typebox").TString, import("typebox").TString]>>>;
        primaryLanguage: TOptional<TUnion<[TLiteral<"en">, TLiteral<"zh-Hant">, TLiteral<"zh-Hans">, TLiteral<"ja">, TLiteral<"ko">, TLiteral<"de">, TLiteral<"fr">, TLiteral<"es">]>>;
        visibility: TUnion<[TLiteral<"private">, TLiteral<"unlisted">, TLiteral<"public">]>;
        appearance: import("typebox").TObject<{
            density: TOptional<TUnion<[TLiteral<"compact">, TLiteral<"comfortable">]>>;
            radius: TOptional<TUnion<[TLiteral<"sm">, TLiteral<"md">, TLiteral<"lg">]>>;
            surface: TOptional<TUnion<[TLiteral<"flat">, TLiteral<"cards">]>>;
            cover: TOptional<TUnion<[TLiteral<"portrait">, TLiteral<"square">, TLiteral<"landscape">]>>;
            headingScale: TOptional<TUnion<[TLiteral<"md">, TLiteral<"lg">]>>;
        }>;
        navigation: import("typebox").TArray<import("typebox").TObject<{
            route: import("typebox").TString;
        }>>;
    }>;
}>;
/** Complete create command input, before registry and saved-filter validation. */
export declare function ZoneCreateInputSchema(): import("typebox").TObject<{
    configuration: import("typebox").TUnsafe<ZoneConfiguration>;
    mounts: import("typebox").TArray<import("typebox").TString>;
    visibility: TUnion<[TLiteral<"private">, TLiteral<"unlisted">, TLiteral<"public">]>;
}>;
/** Complete configure command input, before registry and saved-filter validation. */
export declare function ZoneConfigureInputSchema(): import("typebox").TObject<{
    configuration: import("typebox").TUnsafe<ZoneConfiguration>;
    mounts: import("typebox").TArray<import("typebox").TString>;
}>;
export type ZonePublic = Static<ReturnType<typeof ZonePublicSchema>>;
export type ZonePageRequest = Static<ReturnType<typeof ZonePageRequestSchema>>;
export type ZonePageResponse = Static<ReturnType<typeof ZonePageResponseSchema>>;
export type ZoneCreateInput = Static<ReturnType<typeof ZoneCreateInputSchema>>;
export type ZoneConfigureInput = Static<ReturnType<typeof ZoneConfigureInputSchema>>;
export declare function ZoneOwnedSchema(): import("typebox").TObject<{
    id: import("typebox").TString;
    revision: import("typebox").TString;
    labels: import("typebox").TObject<OptionalLocaleProperties<readonly ["en", "zh-Hant", "zh-Hans", "ja", "ko", "de", "fr", "es"], import("typebox").TIntersect<[import("typebox").TString, import("typebox").TString]>>>;
    primaryLanguage: TOptional<TUnion<[TLiteral<"en">, TLiteral<"zh-Hant">, TLiteral<"zh-Hans">, TLiteral<"ja">, TLiteral<"ko">, TLiteral<"de">, TLiteral<"fr">, TLiteral<"es">]>>;
    visibility: TUnion<[TLiteral<"private">, TLiteral<"unlisted">, TLiteral<"public">]>;
    appearance: import("typebox").TObject<{
        density: TOptional<TUnion<[TLiteral<"compact">, TLiteral<"comfortable">]>>;
        radius: TOptional<TUnion<[TLiteral<"sm">, TLiteral<"md">, TLiteral<"lg">]>>;
        surface: TOptional<TUnion<[TLiteral<"flat">, TLiteral<"cards">]>>;
        cover: TOptional<TUnion<[TLiteral<"portrait">, TLiteral<"square">, TLiteral<"landscape">]>>;
        headingScale: TOptional<TUnion<[TLiteral<"md">, TLiteral<"lg">]>>;
    }>;
    navigation: import("typebox").TArray<import("typebox").TObject<{
        route: import("typebox").TString;
    }>>;
    ownerId: import("typebox").TString;
    deletedAt: TUnion<[import("typebox").TString, import("typebox").TNull]>;
    restoreUntil: TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare function ZoneResponseSchema(): import("typebox").TObject<{
    zone: import("typebox").TObject<{
        id: import("typebox").TString;
        revision: import("typebox").TString;
        labels: import("typebox").TObject<OptionalLocaleProperties<readonly ["en", "zh-Hant", "zh-Hans", "ja", "ko", "de", "fr", "es"], import("typebox").TIntersect<[import("typebox").TString, import("typebox").TString]>>>;
        primaryLanguage: TOptional<TUnion<[TLiteral<"en">, TLiteral<"zh-Hant">, TLiteral<"zh-Hans">, TLiteral<"ja">, TLiteral<"ko">, TLiteral<"de">, TLiteral<"fr">, TLiteral<"es">]>>;
        visibility: TUnion<[TLiteral<"private">, TLiteral<"unlisted">, TLiteral<"public">]>;
        appearance: import("typebox").TObject<{
            density: TOptional<TUnion<[TLiteral<"compact">, TLiteral<"comfortable">]>>;
            radius: TOptional<TUnion<[TLiteral<"sm">, TLiteral<"md">, TLiteral<"lg">]>>;
            surface: TOptional<TUnion<[TLiteral<"flat">, TLiteral<"cards">]>>;
            cover: TOptional<TUnion<[TLiteral<"portrait">, TLiteral<"square">, TLiteral<"landscape">]>>;
            headingScale: TOptional<TUnion<[TLiteral<"md">, TLiteral<"lg">]>>;
        }>;
        navigation: import("typebox").TArray<import("typebox").TObject<{
            route: import("typebox").TString;
        }>>;
        ownerId: import("typebox").TString;
        deletedAt: TUnion<[import("typebox").TString, import("typebox").TNull]>;
        restoreUntil: TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
}>;
export declare function ZoneMetadataResponseSchema(): import("typebox").TObject<{
    zone: import("typebox").TObject<{
        id: import("typebox").TString;
        revision: import("typebox").TString;
        labels: import("typebox").TObject<OptionalLocaleProperties<readonly ["en", "zh-Hant", "zh-Hans", "ja", "ko", "de", "fr", "es"], import("typebox").TIntersect<[import("typebox").TString, import("typebox").TString]>>>;
        primaryLanguage: TOptional<TUnion<[TLiteral<"en">, TLiteral<"zh-Hant">, TLiteral<"zh-Hans">, TLiteral<"ja">, TLiteral<"ko">, TLiteral<"de">, TLiteral<"fr">, TLiteral<"es">]>>;
        visibility: TUnion<[TLiteral<"private">, TLiteral<"unlisted">, TLiteral<"public">]>;
        appearance: import("typebox").TObject<{
            density: TOptional<TUnion<[TLiteral<"compact">, TLiteral<"comfortable">]>>;
            radius: TOptional<TUnion<[TLiteral<"sm">, TLiteral<"md">, TLiteral<"lg">]>>;
            surface: TOptional<TUnion<[TLiteral<"flat">, TLiteral<"cards">]>>;
            cover: TOptional<TUnion<[TLiteral<"portrait">, TLiteral<"square">, TLiteral<"landscape">]>>;
            headingScale: TOptional<TUnion<[TLiteral<"md">, TLiteral<"lg">]>>;
        }>;
        navigation: import("typebox").TArray<import("typebox").TObject<{
            route: import("typebox").TString;
        }>>;
    }>;
}>;
export declare function ZoneConfigurationResponseSchema(): import("typebox").TObject<{
    zone: import("typebox").TObject<{
        id: import("typebox").TString;
        revision: import("typebox").TString;
        labels: import("typebox").TObject<OptionalLocaleProperties<readonly ["en", "zh-Hant", "zh-Hans", "ja", "ko", "de", "fr", "es"], import("typebox").TIntersect<[import("typebox").TString, import("typebox").TString]>>>;
        primaryLanguage: TOptional<TUnion<[TLiteral<"en">, TLiteral<"zh-Hant">, TLiteral<"zh-Hans">, TLiteral<"ja">, TLiteral<"ko">, TLiteral<"de">, TLiteral<"fr">, TLiteral<"es">]>>;
        visibility: TUnion<[TLiteral<"private">, TLiteral<"unlisted">, TLiteral<"public">]>;
        appearance: import("typebox").TObject<{
            density: TOptional<TUnion<[TLiteral<"compact">, TLiteral<"comfortable">]>>;
            radius: TOptional<TUnion<[TLiteral<"sm">, TLiteral<"md">, TLiteral<"lg">]>>;
            surface: TOptional<TUnion<[TLiteral<"flat">, TLiteral<"cards">]>>;
            cover: TOptional<TUnion<[TLiteral<"portrait">, TLiteral<"square">, TLiteral<"landscape">]>>;
            headingScale: TOptional<TUnion<[TLiteral<"md">, TLiteral<"lg">]>>;
        }>;
        navigation: import("typebox").TArray<import("typebox").TObject<{
            route: import("typebox").TString;
        }>>;
        ownerId: import("typebox").TString;
        deletedAt: TUnion<[import("typebox").TString, import("typebox").TNull]>;
        restoreUntil: TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>;
    configuration: import("typebox").TUnsafe<ZoneConfiguration>;
    mounts: import("typebox").TArray<import("typebox").TString>;
}>;
export declare function ZoneListSchema(): import("typebox").TObject<{
    zones: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        revision: import("typebox").TString;
        labels: import("typebox").TObject<OptionalLocaleProperties<readonly ["en", "zh-Hant", "zh-Hans", "ja", "ko", "de", "fr", "es"], import("typebox").TIntersect<[import("typebox").TString, import("typebox").TString]>>>;
        primaryLanguage: TOptional<TUnion<[TLiteral<"en">, TLiteral<"zh-Hant">, TLiteral<"zh-Hans">, TLiteral<"ja">, TLiteral<"ko">, TLiteral<"de">, TLiteral<"fr">, TLiteral<"es">]>>;
        visibility: TUnion<[TLiteral<"private">, TLiteral<"unlisted">, TLiteral<"public">]>;
        appearance: import("typebox").TObject<{
            density: TOptional<TUnion<[TLiteral<"compact">, TLiteral<"comfortable">]>>;
            radius: TOptional<TUnion<[TLiteral<"sm">, TLiteral<"md">, TLiteral<"lg">]>>;
            surface: TOptional<TUnion<[TLiteral<"flat">, TLiteral<"cards">]>>;
            cover: TOptional<TUnion<[TLiteral<"portrait">, TLiteral<"square">, TLiteral<"landscape">]>>;
            headingScale: TOptional<TUnion<[TLiteral<"md">, TLiteral<"lg">]>>;
        }>;
        navigation: import("typebox").TArray<import("typebox").TObject<{
            route: import("typebox").TString;
        }>>;
        ownerId: import("typebox").TString;
        deletedAt: TUnion<[import("typebox").TString, import("typebox").TNull]>;
        restoreUntil: TUnion<[import("typebox").TString, import("typebox").TNull]>;
    }>>;
    next: TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export declare const ZonePublishInputSchema: import("typebox").TObject<{
    visibility: TUnion<[TLiteral<"private">, TLiteral<"unlisted">, TLiteral<"public">]>;
}>;
export declare const ZoneTakedownInputSchema: import("typebox").TObject<{
    pointers: import("typebox").TArray<import("typebox").TString>;
}>;
export type ZoneTakedownInput = Static<typeof ZoneTakedownInputSchema>;
export declare const ZoneHoldInputSchema: import("typebox").TObject<{
    reason: import("typebox").TString;
}>;
export type ZoneHoldInput = Static<typeof ZoneHoldInputSchema>;
export declare const ZonePurgeInputSchema: import("typebox").TObject<{
    reason: TOptional<import("typebox").TString>;
    order: TOptional<import("typebox").TString>;
}>;
export type ZonePurgeInput = Static<typeof ZonePurgeInputSchema>;
export declare const ZoneHoldResponseSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    held: import("typebox").TBoolean;
}>;
export declare const ZonePurgeResponseSchema: import("typebox").TObject<{
    id: import("typebox").TString;
    state: TLiteral<"purge_pending">;
}>;
export type ZoneOwned = Static<ReturnType<typeof ZoneOwnedSchema>>;
export type ZoneResponse = Static<ReturnType<typeof ZoneResponseSchema>>;
export type ZoneMetadataResponse = Static<ReturnType<typeof ZoneMetadataResponseSchema>>;
export type ZoneConfigurationResponse = Static<ReturnType<typeof ZoneConfigurationResponseSchema>>;
export type ZoneList = Static<ReturnType<typeof ZoneListSchema>>;
export type ZonePublishInput = Static<typeof ZonePublishInputSchema>;
declare function zoneSubjectListItemSchema(): import("typebox").TObject<{
    id: import("typebox").TString;
    type: import("typebox").TString;
    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
    summary: import("typebox").TObject<{
        id: import("typebox").TString;
        type: import("typebox").TString;
        types: import("typebox").TArray<import("typebox").TString>;
        label: TUnion<[import("typebox").TObject<{
            value: import("typebox").TString;
            language: import("typebox").TString;
        }>, import("typebox").TNull]>;
        creativeWork: import("typebox").TBoolean;
        cover: TUnion<[import("typebox").TObject<{
            media: import("typebox").TString;
            width: import("typebox").TInteger;
            height: import("typebox").TInteger;
            placeholder: import("typebox").TObject<{
                thumbhash: import("typebox").TString;
                color: import("typebox").TString;
            }>;
            variants: import("typebox").TArray<import("typebox").TObject<{
                format: TUnion<[TLiteral<"avif">, TLiteral<"webp">]>;
                width: import("typebox").TInteger;
            }>>;
            focalPoint: TUnion<[import("typebox").TObject<{
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
}>;
/** Canonical UUID membership page. Continuation uses the default list-cursor profile. */
export declare function ZoneSubjectListResponseSchema(): import("typebox").TObject<{
    subjects: import("typebox").TArray<import("typebox").TObject<{
        id: import("typebox").TString;
        type: import("typebox").TString;
        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
        summary: import("typebox").TObject<{
            id: import("typebox").TString;
            type: import("typebox").TString;
            types: import("typebox").TArray<import("typebox").TString>;
            label: TUnion<[import("typebox").TObject<{
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>, import("typebox").TNull]>;
            creativeWork: import("typebox").TBoolean;
            cover: TUnion<[import("typebox").TObject<{
                media: import("typebox").TString;
                width: import("typebox").TInteger;
                height: import("typebox").TInteger;
                placeholder: import("typebox").TObject<{
                    thumbhash: import("typebox").TString;
                    color: import("typebox").TString;
                }>;
                variants: import("typebox").TArray<import("typebox").TObject<{
                    format: TUnion<[TLiteral<"avif">, TLiteral<"webp">]>;
                    width: import("typebox").TInteger;
                }>>;
                focalPoint: TUnion<[import("typebox").TObject<{
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
    }>>;
    next: TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export type ZoneSubjectListItem = Static<ReturnType<typeof zoneSubjectListItemSchema>>;
export type ZoneSubjectListResponse = Static<ReturnType<typeof ZoneSubjectListResponseSchema>>;
/** Mounted Collection summaries use the Collection owner's existing safe resource projection. */
export declare function ZoneCollectionListResponseSchema(): import("typebox").TObject<{
    collections: import("typebox").TArray<import("typebox").TUnsafe<import("./collection-port.ts").ZoneCollectionPublicView>>;
    next: TUnion<[import("typebox").TString, import("typebox").TNull]>;
}>;
export type ZoneCollectionListResponse = Static<ReturnType<typeof ZoneCollectionListResponseSchema>>;
export {};
