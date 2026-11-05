export declare const VNDB_LIMITS: {
    readonly bytes: number;
    readonly wireBytes: number;
    readonly depth: 32;
    readonly rows: 5000;
    readonly evidenceBytes: number;
    readonly page: 8;
    readonly uploads: 4;
    readonly lifetimeMs: 86400000;
    readonly applyMs: 5000;
};
export declare class VndbInvalid extends Error {
    constructor();
}
export type SourceValue = {
    kind: 'missing' | 'unknown' | 'invalid' | 'value';
    raw: string | null;
    value?: string | number;
    precision?: 'year' | 'month' | 'day';
    scale?: {
        min: number;
        max: number;
        step: number;
    };
};
export type VndbRow = {
    ordinal: number;
    kind: 'vn' | 'retained';
    identifier: {
        provider: 'vndb';
        kind: 'vn';
        value: string;
    } | null;
    title: string;
    labels: string[];
    suggestedRole: string | null;
    fields: Record<string, SourceValue>;
    retainedReason: string;
    evidence: unknown;
};
/** Derived from legacy-final's VNDB adapter and contract/bounds/XML helpers.
 * Lexical depth admission precedes the parser, including for malformed documents. */
export declare function parseVndb(xml: string): VndbRow[];
