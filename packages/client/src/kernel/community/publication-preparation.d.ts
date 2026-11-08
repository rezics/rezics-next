import type { SubjectSummary } from '../semantic/summaries.ts';
import type { PublicationDependencies, PublicationReadContext, PublicationVerdict } from './publication.ts';
export declare const PublicationPreparationSchema: import("typebox").TObject<{
    realm: import("typebox").TObject<{
        realmId: import("typebox").TString;
        spaceId: import("typebox").TString;
        contextId: import("typebox").TString;
        title: import("typebox").TString;
        hostTitle: import("typebox").TString;
    }>;
    subject: import("typebox").TObject<{
        originalId: import("typebox").TString;
        currentId: import("typebox").TString;
        presentation: import("typebox").TObject<{
            label: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"available">;
                value: import("typebox").TString;
                language: import("typebox").TString;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"empty">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"concealed">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
            }>]>;
            cover: import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TLiteral<"available">;
                value: import("typebox").TObject<{
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
                }>;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"empty">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"concealed">;
            }>, import("typebox").TObject<{
                state: import("typebox").TLiteral<"unavailable">;
            }>]>;
        }>;
    }>;
    current: import("typebox").TUnion<[import("typebox").TObject<{
        publicationId: import("typebox").TString;
        verdict: import("typebox").TUnion<[import("typebox").TLiteral<"adopt">, import("typebox").TLiteral<"reject">, import("typebox").TLiteral<"withdraw">]>;
        decidedAt: import("typebox").TString;
    }>, import("typebox").TNull]>;
    commands: import("typebox").TObject<{
        publish: import("typebox").TObject<{
            method: import("typebox").TLiteral<"POST">;
            href: import("typebox").TString;
            subjectId: import("typebox").TString;
            expectedHead: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            ifMatch: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>;
        withdraw: import("typebox").TUnion<[import("typebox").TObject<{
            method: import("typebox").TLiteral<"POST">;
            href: import("typebox").TString;
            subjectId: import("typebox").TString;
            expectedHead: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            ifMatch: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>, import("typebox").TNull]>;
        reject: import("typebox").TUnion<[import("typebox").TObject<{
            method: import("typebox").TLiteral<"POST">;
            href: import("typebox").TString;
            subjectId: import("typebox").TString;
            expectedHead: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            ifMatch: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
        }>, import("typebox").TNull]>;
    }>;
    recovery: import("typebox").TObject<{
        requestIdentity: import("typebox").TLiteral<"unknown">;
        replay: import("typebox").TLiteral<"original-command">;
    }>;
    viewer: import("typebox").TObject<{
        accountId: import("typebox").TString;
        clientId: import("typebox").TString;
        authnEpoch: import("typebox").TInteger;
    }>;
}>;
export declare const PublicationPreparationResponseSchema: import("typebox").TObject<{
    preparation: import("typebox").TObject<{
        realm: import("typebox").TObject<{
            realmId: import("typebox").TString;
            spaceId: import("typebox").TString;
            contextId: import("typebox").TString;
            title: import("typebox").TString;
            hostTitle: import("typebox").TString;
        }>;
        subject: import("typebox").TObject<{
            originalId: import("typebox").TString;
            currentId: import("typebox").TString;
            presentation: import("typebox").TObject<{
                label: import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TLiteral<"available">;
                    value: import("typebox").TString;
                    language: import("typebox").TString;
                }>, import("typebox").TObject<{
                    state: import("typebox").TLiteral<"empty">;
                }>, import("typebox").TObject<{
                    state: import("typebox").TLiteral<"concealed">;
                }>, import("typebox").TObject<{
                    state: import("typebox").TLiteral<"unavailable">;
                }>]>;
                cover: import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TLiteral<"available">;
                    value: import("typebox").TObject<{
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
                    }>;
                }>, import("typebox").TObject<{
                    state: import("typebox").TLiteral<"empty">;
                }>, import("typebox").TObject<{
                    state: import("typebox").TLiteral<"concealed">;
                }>, import("typebox").TObject<{
                    state: import("typebox").TLiteral<"unavailable">;
                }>]>;
            }>;
        }>;
        current: import("typebox").TUnion<[import("typebox").TObject<{
            publicationId: import("typebox").TString;
            verdict: import("typebox").TUnion<[import("typebox").TLiteral<"adopt">, import("typebox").TLiteral<"reject">, import("typebox").TLiteral<"withdraw">]>;
            decidedAt: import("typebox").TString;
        }>, import("typebox").TNull]>;
        commands: import("typebox").TObject<{
            publish: import("typebox").TObject<{
                method: import("typebox").TLiteral<"POST">;
                href: import("typebox").TString;
                subjectId: import("typebox").TString;
                expectedHead: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                ifMatch: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>;
            withdraw: import("typebox").TUnion<[import("typebox").TObject<{
                method: import("typebox").TLiteral<"POST">;
                href: import("typebox").TString;
                subjectId: import("typebox").TString;
                expectedHead: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                ifMatch: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>, import("typebox").TNull]>;
            reject: import("typebox").TUnion<[import("typebox").TObject<{
                method: import("typebox").TLiteral<"POST">;
                href: import("typebox").TString;
                subjectId: import("typebox").TString;
                expectedHead: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                ifMatch: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>, import("typebox").TNull]>;
        }>;
        recovery: import("typebox").TObject<{
            requestIdentity: import("typebox").TLiteral<"unknown">;
            replay: import("typebox").TLiteral<"original-command">;
        }>;
        viewer: import("typebox").TObject<{
            accountId: import("typebox").TString;
            clientId: import("typebox").TString;
            authnEpoch: import("typebox").TInteger;
        }>;
    }>;
}>;
declare function presentationValue(summary: SubjectSummary | null, coverState: 'available' | 'absent' | 'concealed' | undefined): {
    label: {
        state: 'concealed';
    };
    cover: {
        state: 'concealed';
        value?: never;
    };
} | {
    label: {
        state: 'available';
        value: string;
        language: string;
    } | {
        value?: never;
        language?: never;
        state: 'unavailable';
    } | {
        value?: never;
        language?: never;
        state: 'empty';
    };
    cover: {
        state: 'available';
        value: import("../semantic/summaries.ts").CoverSummary;
    } | {
        value?: never;
        state: 'empty';
    } | {
        value?: never;
        state: 'concealed';
    };
};
declare function unavailablePresentation(): {
    label: {
        state: 'unavailable';
    };
    cover: {
        state: 'unavailable';
    };
};
type SubjectPresentation = ReturnType<typeof presentationValue> | ReturnType<typeof unavailablePresentation>;
/** Exact operational inspection. All dependencies are prepared on released homes;
 * final equality is conservative, never a claim of a global atomic snapshot.
 * No receipt, mutation, idempotency key or repair participates in this GET.
 */
export declare function readPublicationPreparation(deps: PublicationDependencies, realmId: string, subjectId: string, context: PublicationReadContext): Promise<{
    preparation: {
        realm: {
            realmId: string;
            spaceId: string;
            contextId: string;
            title: string;
            hostTitle: string;
        };
        subject: {
            originalId: string;
            currentId: string;
            presentation: SubjectPresentation;
        };
        current: {
            publicationId: string;
            verdict: PublicationVerdict;
            decidedAt: string;
        } | null;
        commands: {
            publish: {
                method: 'POST';
                href: string;
                subjectId: string;
                expectedHead: string | null;
                ifMatch: string | null;
            };
            withdraw: {
                method: 'POST';
                href: string;
                subjectId: string;
                expectedHead: string | null;
                ifMatch: string | null;
            } | null;
            reject: {
                method: 'POST';
                href: string;
                subjectId: string;
                expectedHead: string | null;
                ifMatch: string | null;
            } | null;
        };
        recovery: {
            requestIdentity: 'unknown';
            replay: 'original-command';
        };
        viewer: {
            accountId: string;
            clientId: string;
            authnEpoch: number;
        };
    };
    components: Readonly<{
        partition: number;
        epoch: number;
        position: bigint;
    }>[];
} | null>;
export {};
