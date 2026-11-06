import type { DataType, RelationDefinition, Release } from '@rezics/definitions';
export type { Violation } from '@rezics/definitions/validate';
import type { ItemFact, ItemFactRow, Item as ContractItem, ItemSourceRecord } from './contract/item-values.ts';
import { SubjectInputError } from './application/index.ts';
import { RELATION_GROUPS } from './core/index.ts';
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
export type Item = Omit<ContractItem, 'sourceRecords' | 'statements'> & {
    statements: Record<string, Statement[]>;
    sourceRecords: SourceRecord[];
};
export type Fact = ItemFact;
export type FactRow = ItemFactRow;
export { SubjectInputError, RELATION_GROUPS };
export declare const SLOT_NS = "c30d6caa-d9e8-4108-a42a-35701219e8ec";
export declare const STATEMENT_NS = "9f44e74c-b77c-47aa-96d0-b7a4aa330182";
export declare function factDataTypes(release: Release, facts: readonly FactRow[]): Record<string, DataType>;
export declare function isRelationProperty(release: Release, property: string): boolean;
export declare function statementSlotId(subject: string, property: string): string;
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
export type { ItemSourceRecord };
