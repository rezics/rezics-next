import type { DataType } from '@rezics/definitions';
export type Value = {
    type: 'value';
    content: unknown;
} | {
    type: 'somevalue';
} | {
    type: 'novalue';
};
export type Snak = {
    property: {
        id: string;
        data_type: DataType;
    };
    value: Value;
};
export type Reference = {
    parts: Snak[];
    hash: string;
};
export type Statement = {
    id: string;
    rank: 'normal' | 'preferred' | 'deprecated';
    property: {
        id: string;
        data_type: DataType;
    };
    value: Value;
    qualifiers: Snak[];
    references: Reference[];
    rezics: {
        release: string;
        revision: number;
    };
};
export type Item = {
    id: string;
    type: string;
    revision: number;
    release: string;
    context: string;
    resolution: Record<string, never>;
    labels: Record<string, string>;
    descriptions: Record<string, string>;
    aliases: Record<string, string[]>;
    statements: Record<string, Statement[]>;
};
export type Fact = {
    slot_id: string;
    log_seq: number;
    operation: 'assert' | 'retract' | 'expand';
    kind: 'label' | 'description' | 'alias' | 'statement';
    language: string | null;
    property: string | null;
    statement_id: string | null;
    body: unknown;
};
export type FactRow = {
    kind: Fact['kind'];
    language: string | null;
    property: string | null;
    statement_id: string | null;
    operation: Fact['operation'];
    body: unknown;
    fact_revision?: number | null;
    fact_release?: string | null;
};
export type Violation = {
    pointer: string;
    code: 'required' | 'unknown_field' | 'invalid_type' | 'invalid_format' | 'out_of_range' | 'unsupported';
};
export declare class SubjectInputError extends Error {
    readonly violations: Violation[];
    constructor(violations: Violation[]);
}
export declare const SLOT_NS = "c30d6caa-d9e8-4108-a42a-35701219e8ec";
export declare function itemFacts(subjectId: string, input: unknown, _type?: string): Fact[];
export declare function resolveItem(subjectId: string, rows: readonly FactRow[], type: string, dataTypes: Readonly<Record<string, DataType>>, metadata: {
    revision: number;
    release: string;
    context: string;
}): Item;
