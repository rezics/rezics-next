import type { DataType, RelationDefinition, Release } from '@rezics/definitions/contract';
import type { HashPort, RoutePort } from '../contract/domain-ports.ts';
import type { Item, ItemFact, ItemFactRow, ItemMetadata } from '../contract/item-values.ts';
import {
  factDataTypes,
  isRelationProperty,
  itemFacts,
  relationPropertiesOf,
  relationSlotForApi,
  relationSlotForStatement,
  relationSlotId,
  resolveItem,
  statementSlotId,
  storedFactsFor,
  SubjectInputError,
} from '../core/index.ts';

export type ItemApplication = Readonly<{
  factsForItem(subjectId: string, input: unknown, type?: string, release?: Release): ItemFact[];
  resolveItem(
    subjectId: string,
    rows: readonly ItemFactRow[],
    type: string,
    dataTypes: Readonly<Record<string, DataType>>,
    metadata: ItemMetadata,
  ): Item;
  factDataTypes(release: Release, facts: readonly ItemFactRow[]): Record<string, DataType>;
  isRelationProperty(release: Release, property: string): boolean;
  statementSlotId(subject: string, property: string): string;
  relationSlotId(
    subject: string,
    property: string,
    target: string,
    slotKey?: { declared: boolean; value: string },
  ): string;
  relationSlotForStatement(subject: string, property: string, body: unknown, relation?: RelationDefinition): string;
  relationSlotForApi(
    subject: string,
    property: string,
    relation: RelationDefinition | undefined,
    input: { target?: string; sameAs?: string; key?: string },
  ): string;
  storedFacts(facts: readonly ItemFact[], releaseDigest: string, release: Release): ReturnType<typeof storedFactsFor>;
  relationProperties(release: Release, type: string): string[];
}>;

/** Item projection over hashing and routing ports. Callers never select crypto or route encoding. */
export function createItemApplication(ports: Readonly<{ hashing: HashPort; routing: RoutePort }>): ItemApplication {
  const { hashing, routing } = ports;
  return Object.freeze({
    factsForItem: (subjectId, input, type, release) => itemFacts(routing, subjectId, input, type, release),
    resolveItem: (subjectId, rows, type, dataTypes, metadata) =>
      resolveItem(hashing, subjectId, rows, type, dataTypes, metadata),
    factDataTypes,
    isRelationProperty,
    statementSlotId: (subject, property) => statementSlotId(routing, subject, property),
    relationSlotId: (subject, property, target, slotKey) => relationSlotId(routing, subject, property, target, slotKey),
    relationSlotForStatement: (subject, property, body, relation) =>
      relationSlotForStatement(routing, subject, property, body, relation),
    relationSlotForApi: (subject, property, relation, input) =>
      relationSlotForApi(routing, subject, property, relation, input),
    storedFacts: storedFactsFor,
    relationProperties: relationPropertiesOf,
  });
}

export { SubjectInputError };
