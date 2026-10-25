import { SUBJECT_TYPE, type DataType } from './profile.ts';
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
};
export type Item = {
    id: string;
    type: typeof SUBJECT_TYPE;
    labels: Record<string, string>;
    descriptions: Record<string, string>;
    aliases: Record<string, string[]>;
    statements: Record<string, Statement[]>;
};
export type Fact = {
    slot_id: string;
    log_seq: number;
    operation: 'assert' | 'retract';
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
};
export type Violation = {
    pointer: string;
    code: 'required' | 'unknown_field' | 'invalid_type' | 'invalid_format' | 'out_of_range' | 'unsupported';
};
export declare class SubjectInputError extends Error {
    readonly violations: Violation[];
    constructor(violations: Violation[]);
}
export declare function itemFacts(subjectId: string, input: unknown): Fact[];
export declare function resolveItem(subjectId: string, rows: readonly FactRow[]): Item;
