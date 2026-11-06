import type { CreditSearchProjection } from './credit-search.ts';
/** One nested document per (statement, creator name). Shape matches `credit-search-mapping.ts`. */
export type CreditedNameDocument = {
    workId: string;
    statementId: string;
    revision: number;
    release: string;
    property: string;
    targetId: string;
    direction: 'outgoing';
    nameRevision: string;
    qualifiers: {
        property: string;
        value: string;
    }[];
    name: {
        language: string;
        value: string;
    };
};
/** Fields written beside a Subject's ordinary document when the generation carries the credit mapping. */
export type CreditSearchFields = {
    credit_search_complete: boolean;
    credited_names: CreditedNameDocument[];
};
/**
 * All-or-readiness per work: only a complete projection publishes names. Any other state replaces
 * the previous names with an explicit incomplete cut, so a stale creator name cannot survive.
 * The projection is already validated by `projectCreditSearch`; its witnesses are published unchanged.
 */
export declare function creditSearchFields(projection: CreditSearchProjection | undefined): CreditSearchFields;
