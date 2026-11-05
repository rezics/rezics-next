import type { DataType, RelationDefinition, Release } from '@rezics/definitions';
import { type Violation } from '@rezics/definitions/validate';
export type { Violation } from '@rezics/definitions/validate';
import type { SourceRecord } from './source-records.ts';
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
    resolution: Record<string, 'unresolved' | 'suppressed'>;
    relationCounts: Record<string, number>;
    labels: Record<string, string>;
    descriptions: Record<string, string>;
    aliases: Record<string, string[]>;
    statements: Record<string, Statement[]>;
    sourceRecords: SourceRecord[];
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
/** Datatypes for the properties named by these facts, without walking the rest of the release. */
export declare function factDataTypes(release: Release, facts: readonly FactRow[]): Record<string, DataType>;
export declare class SubjectInputError extends Error {
    readonly violations: Violation[];
    constructor(violations: Violation[]);
}
export declare const SLOT_NS = "c30d6caa-d9e8-4108-a42a-35701219e8ec";
export declare const RELATION_GROUPS: Set<string>;
export declare function isRelationProperty(release: Release, property: string): boolean;
export declare function statementSlotId(subject: string, property: string): string;
/** Relation slots isolate one target (and, where declared, one repeatable item qualifier). */
export declare function relationSlotId(subject: string, property: string, target: string, slotKey?: {
    declared: boolean;
    value: string;
}): string;
export declare function relationSlotForStatement(subject: string, property: string, body: unknown, relation?: RelationDefinition): string;
export declare function relationSlotForApi(subject: string, property: string, relation: RelationDefinition | undefined, input: {
    target?: string;
    sameAs?: string;
    key?: string;
}): string;
export declare function itemFacts(subjectId: string, input: unknown, _type?: string, release?: Release): Fact[];
export declare function resolveItem(subjectId: string, rows: readonly FactRow[], type: string, dataTypes: Readonly<Record<string, DataType>>, metadata: {
    revision: number;
    release: string;
    context: string;
    resolution?: Record<string, 'unresolved' | 'suppressed'>;
    relationCounts?: Record<string, number>;
}): Item;
