import type { DataType, RelationDefinition, Release } from '@rezics/definitions';
import { type Violation } from '@rezics/definitions/validate';
import { ITEM_FACT_LIMIT, ITEM_RELATION_GROUPS, ITEM_SLOT_NAMESPACE, ITEM_STATEMENT_NAMESPACE, type Item, type ItemDataType, type ItemFact, type ItemFactRow, type ItemMetadata } from '../contract/item-values.ts';
import type { HashPort, RoutePort } from '../contract/domain-ports.ts';
export { ITEM_FACT_LIMIT, ITEM_RELATION_GROUPS, ITEM_SLOT_NAMESPACE, ITEM_STATEMENT_NAMESPACE };
export declare const RELATION_GROUPS: Set<string>;
export declare class SubjectInputError extends Error {
    readonly violations: Violation[];
    constructor(violations: Violation[]);
}
export declare function factDataTypes(release: Release, facts: readonly ItemFactRow[]): Record<string, DataType>;
export declare function isRelationProperty(release: Release, property: string): boolean;
export declare function statementSlotId(route: RoutePort, subject: string, property: string): string;
export declare function relationSlotId(route: RoutePort, subject: string, property: string, target: string, slotKey?: {
    declared: boolean;
    value: string;
}): string;
export declare function relationSlotForStatement(route: RoutePort, subject: string, property: string, body: unknown, relation?: RelationDefinition): string;
export declare function relationSlotForApi(route: RoutePort, subject: string, property: string, relation: RelationDefinition | undefined, input: {
    target?: string;
    sameAs?: string;
    key?: string;
}): string;
export declare function canonicalItemValue(value: unknown): string;
export declare function itemFacts(route: RoutePort, subjectId: string, input: unknown, _type?: string, release?: Release): ItemFact[];
export declare function resolveItem(hash: HashPort, subjectId: string, rows: readonly ItemFactRow[], type: string, dataTypes: Readonly<Record<string, DataType | ItemDataType>>, metadata: ItemMetadata): Item;
export declare function relationPropertiesOf(release: Release, type: string): string[];
export declare function storedFactsFor(facts: readonly ItemFact[], releaseDigest: string, release: Release): Array<ItemFact & {
    release: string | null;
    relation?: boolean;
}>;
