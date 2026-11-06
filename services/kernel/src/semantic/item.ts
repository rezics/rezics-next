import type { DataType, RelationDefinition, Release } from '@rezics/definitions';
export type { Violation } from '@rezics/definitions/validate';
import { memoizedValue } from '../memoized.ts';
import type { ItemFact, ItemFactRow, Item as ContractItem, ItemSourceRecord } from './contract/item-values.ts';
import { ITEM_SLOT_NAMESPACE, ITEM_STATEMENT_NAMESPACE } from './contract/item-values.ts';
import { createItemApplication, SubjectInputError } from './application/index.ts';
import { RELATION_GROUPS } from './core/index.ts';
import { nativeHashing } from './adapters/hashing.ts';
import { nativeRouting } from './adapters/routing.ts';
import { defaultSemanticDomain } from './adapters/registry.ts';
import type { SourceRecord } from './source-records.ts';

export type Value = { type: 'value'; content: unknown } | { type: 'somevalue' } | { type: 'novalue' };
export type Snak = { property: { id: string; data_type: DataType }; value: Value };
export type Reference = { parts: Snak[]; hash: string };
export type Statement = {
  id: string;
  rank: 'normal' | 'preferred' | 'deprecated';
  property: { id: string; data_type: DataType };
  value: Value;
  qualifiers: Snak[];
  references: Reference[];
  rezics: { release: string; revision: number };
};
export type Item = Omit<ContractItem, 'sourceRecords' | 'statements'> & {
  statements: Record<string, Statement[]>;
  sourceRecords: SourceRecord[];
};
export type Fact = ItemFact;
export type FactRow = ItemFactRow;
export { SubjectInputError, RELATION_GROUPS };
export const SLOT_NS = ITEM_SLOT_NAMESPACE;
export const STATEMENT_NS = ITEM_STATEMENT_NAMESPACE;

function items() {
  return (
    defaultSemanticDomain()?.items ??
    memoizedValue(items, () => createItemApplication({ hashing: nativeHashing(), routing: nativeRouting() }))
  );
}

export function factDataTypes(release: Release, facts: readonly FactRow[]): Record<string, DataType> {
  return items().factDataTypes(release, facts);
}

export function isRelationProperty(release: Release, property: string): boolean {
  return items().isRelationProperty(release, property);
}

export function statementSlotId(subject: string, property: string): string {
  return items().statementSlotId(subject, property);
}

export function relationSlotId(
  subject: string,
  property: string,
  target: string,
  slotKey?: { declared: boolean; value: string },
): string {
  return items().relationSlotId(subject, property, target, slotKey);
}

export function relationSlotForStatement(
  subject: string,
  property: string,
  body: unknown,
  relation?: RelationDefinition,
): string {
  return items().relationSlotForStatement(subject, property, body, relation);
}

export function relationSlotForApi(
  subject: string,
  property: string,
  relation: RelationDefinition | undefined,
  input: { target?: string; sameAs?: string; key?: string },
): string {
  return items().relationSlotForApi(subject, property, relation, input);
}

export function itemFacts(subjectId: string, input: unknown, _type?: string, release?: Release): Fact[] {
  return items().factsForItem(subjectId, input, _type, release);
}

export function resolveItem(
  subjectId: string,
  rows: readonly FactRow[],
  type: string,
  dataTypes: Readonly<Record<string, DataType>>,
  metadata: {
    revision: number;
    release: string;
    context: string;
    resolution?: Record<string, 'unresolved' | 'suppressed'>;
    relationCounts?: Record<string, number>;
  },
): Item {
  const item = items().resolveItem(subjectId, rows, type, dataTypes, metadata);
  return { ...item, sourceRecords: item.sourceRecords as SourceRecord[] };
}

export type { ItemSourceRecord };
