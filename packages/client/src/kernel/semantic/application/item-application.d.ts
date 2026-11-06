import type { DataType, RelationDefinition, Release } from '@rezics/definitions';
import type { HashPort, RoutePort } from '../contract/domain-ports.ts';
import type { Item, ItemFact, ItemFactRow, ItemMetadata } from '../contract/item-values.ts';
import { storedFactsFor, SubjectInputError } from '../core/index.ts';
export type ItemApplication = Readonly<{
    factsForItem(subjectId: string, input: unknown, type?: string, release?: Release): ItemFact[];
    resolveItem(subjectId: string, rows: readonly ItemFactRow[], type: string, dataTypes: Readonly<Record<string, DataType>>, metadata: ItemMetadata): Item;
    factDataTypes(release: Release, facts: readonly ItemFactRow[]): Record<string, DataType>;
    isRelationProperty(release: Release, property: string): boolean;
    statementSlotId(subject: string, property: string): string;
    relationSlotId(subject: string, property: string, target: string, slotKey?: {
        declared: boolean;
        value: string;
    }): string;
    relationSlotForStatement(subject: string, property: string, body: unknown, relation?: RelationDefinition): string;
    relationSlotForApi(subject: string, property: string, relation: RelationDefinition | undefined, input: {
        target?: string;
        sameAs?: string;
        key?: string;
    }): string;
    storedFacts(facts: readonly ItemFact[], releaseDigest: string, release: Release): ReturnType<typeof storedFactsFor>;
    relationProperties(release: Release, type: string): string[];
}>;
/** Item projection over hashing and routing ports. Callers never select crypto or route encoding. */
export declare function createItemApplication(ports: Readonly<{
    hashing: HashPort;
    routing: RoutePort;
}>): ItemApplication;
export { SubjectInputError };
