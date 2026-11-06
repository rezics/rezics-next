/** Semantic-owned item vocabulary. Definitions own property datatypes; this leaf names stored facts and projections. */

export const ITEM_SLOT_NAMESPACE = 'c30d6caa-d9e8-4108-a42a-35701219e8ec';
export const ITEM_STATEMENT_NAMESPACE = '9f44e74c-b77c-47aa-96d0-b7a4aa330182';
export const ITEM_FACT_LIMIT = 512;
export const ITEM_RELATION_GROUPS = [
  'order',
  'derivation',
  'world',
  'membership',
  'association',
  'credit',
  'appearance',
] as const;
export type ItemRelationGroup = (typeof ITEM_RELATION_GROUPS)[number];

export type ItemDataType =
  | 'wikibase-item'
  | 'string'
  | 'external-id'
  | 'url'
  | 'monolingualtext'
  | 'quantity'
  | 'time'
  | 'document'
  | 'media';

export type ItemValue = { type: 'value'; content: unknown } | { type: 'somevalue' } | { type: 'novalue' };
export type ItemSnak = { property: { id: string; data_type: ItemDataType }; value: ItemValue };
export type ItemReference = { parts: ItemSnak[]; hash: string };
export type ItemStatement = {
  id: string;
  rank: 'normal' | 'preferred' | 'deprecated';
  property: { id: string; data_type: ItemDataType };
  value: ItemValue;
  qualifiers: ItemSnak[];
  references: ItemReference[];
  rezics: { release: string; revision: number };
};
export type ItemSourceRecord = {
  name: string;
  url: string;
  licence?: { id: string; url?: string };
  attribution?: string;
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
  statements: Record<string, ItemStatement[]>;
  sourceRecords: ItemSourceRecord[];
};
export type ItemFact = {
  slot_id: string;
  log_seq: number;
  operation: 'assert' | 'retract' | 'expand';
  kind: 'label' | 'description' | 'alias' | 'statement';
  language: string | null;
  property: string | null;
  statement_id: string | null;
  body: unknown;
};
export type ItemFactRow = {
  kind: ItemFact['kind'];
  language: string | null;
  property: string | null;
  statement_id: string | null;
  operation: ItemFact['operation'];
  body: unknown;
  fact_revision?: number | null;
  fact_release?: string | null;
};
export type ItemMetadata = {
  revision: number;
  release: string;
  context: string;
  resolution?: Record<string, 'unresolved' | 'suppressed'>;
  relationCounts?: Record<string, number>;
};
export type ItemRelationSlots = {
  group?: string;
  slotKey?: string;
};
export type ItemReleaseSlice = {
  properties: Readonly<
    Record<string, { datatype?: ItemDataType; relation?: ItemRelationSlots; targets?: readonly string[] }>
  >;
  types: Readonly<Record<string, { properties?: readonly string[] }>>;
};
export type StoredItemFact = ItemFact & { release: string | null; relation?: boolean };
