import { Type as t } from 'typebox';
import type { ContentCoverCredit } from './domain-ports.ts';
export declare const CoverSummarySchema: t.TUnion<[t.TObject<{
    media: t.TString;
    width: t.TInteger;
    height: t.TInteger;
    placeholder: t.TObject<{
        thumbhash: t.TString;
        color: t.TString;
    }>;
    variants: t.TArray<t.TObject<{
        format: t.TUnion<[t.TLiteral<"avif">, t.TLiteral<"webp">]>;
        width: t.TInteger;
    }>>;
    focalPoint: t.TUnion<[t.TObject<{
        x: t.TNumber;
        y: t.TNumber;
    }>, t.TNull]>;
    credit: t.TObject<{
        rightsHolder: t.TString;
        via: t.TObject<{
            name: t.TString;
            url: t.TString;
        }>;
        license: t.TString;
        obligations: t.TArray<t.TString>;
    }>;
}>, t.TNull]>;
export declare const SubjectSummarySchema: t.TObject<{
    id: t.TString;
    type: t.TString;
    types: t.TArray<t.TString>;
    label: t.TUnion<[t.TObject<{
        value: t.TString;
        language: t.TString;
    }>, t.TNull]>;
    creativeWork: t.TBoolean;
    cover: t.TUnion<[t.TObject<{
        media: t.TString;
        width: t.TInteger;
        height: t.TInteger;
        placeholder: t.TObject<{
            thumbhash: t.TString;
            color: t.TString;
        }>;
        variants: t.TArray<t.TObject<{
            format: t.TUnion<[t.TLiteral<"avif">, t.TLiteral<"webp">]>;
            width: t.TInteger;
        }>>;
        focalPoint: t.TUnion<[t.TObject<{
            x: t.TNumber;
            y: t.TNumber;
        }>, t.TNull]>;
        credit: t.TObject<{
            rightsHolder: t.TString;
            via: t.TObject<{
                name: t.TString;
                url: t.TString;
            }>;
            license: t.TString;
            obligations: t.TArray<t.TString>;
        }>;
    }>, t.TNull]>;
}>;
/** Related summaries of a merged original add the survivor it redirects to, so receiving routes can follow it. */
export declare const RelatedSubjectSummarySchema: t.TObject<{
    id: t.TString;
    type: t.TString;
    types: t.TArray<t.TString>;
    label: t.TUnion<[t.TObject<{
        value: t.TString;
        language: t.TString;
    }>, t.TNull]>;
    creativeWork: t.TBoolean;
    cover: t.TUnion<[t.TObject<{
        media: t.TString;
        width: t.TInteger;
        height: t.TInteger;
        placeholder: t.TObject<{
            thumbhash: t.TString;
            color: t.TString;
        }>;
        variants: t.TArray<t.TObject<{
            format: t.TUnion<[t.TLiteral<"avif">, t.TLiteral<"webp">]>;
            width: t.TInteger;
        }>>;
        focalPoint: t.TUnion<[t.TObject<{
            x: t.TNumber;
            y: t.TNumber;
        }>, t.TNull]>;
        credit: t.TObject<{
            rightsHolder: t.TString;
            via: t.TObject<{
                name: t.TString;
                url: t.TString;
            }>;
            license: t.TString;
            obligations: t.TArray<t.TString>;
        }>;
    }>, t.TNull]>;
    redirect: t.TOptional<t.TString>;
}>;
/** Disclosed display vocabulary shared by native producers and receiving transports. */
export type CoverCredit = ContentCoverCredit;
export type CoverSummary = {
    media: string;
    width: number;
    height: number;
    placeholder: {
        thumbhash: string;
        color: string;
    };
    variants: {
        format: 'avif' | 'webp';
        width: number;
    }[];
    focalPoint: {
        x: number;
        y: number;
    } | null;
    credit: ContentCoverCredit;
};
export type SubjectSummary = {
    id: string;
    type: string;
    types: string[];
    label: {
        value: string;
        language: string;
    } | null;
    creativeWork: boolean;
    cover: CoverSummary | null;
};
/** An original retains its key while its visible survivor supplies the summary. */
export type RelatedSubjectSummary = SubjectSummary & {
    redirect?: string;
};
export type SummarySources = readonly Readonly<{
    partition: number;
    epoch: number;
    position: bigint;
}>[];
export type SummaryCoverState = 'available' | 'absent' | 'concealed';
/** Internal composition, never a browser-supplied witness or a cached allow.
 * Each component is an independent native home position, as in Subject reads.
 */
export type SubjectSummaryObservation = Readonly<{
    summaries: ReadonlyMap<string, SubjectSummary | null>;
    covers: ReadonlyMap<string, SummaryCoverState>;
    components: SummarySources;
    current: () => Promise<boolean>;
}>;
export type PublicSummaryQuery = Readonly<{
    ids: readonly string[];
    languages: readonly string[];
    deadline: number;
}>;
export type PublicSummaryRead<Summary extends SubjectSummary = SubjectSummary> = (query: PublicSummaryQuery) => Promise<ReadonlyMap<string, Summary>>;
