import type { IndexedStatement, IndexedSubject, SubjectSnapshot } from './source.ts';
export declare const MISSING_NAME = "􏿿";
export declare const MAX_NAME_SORT_CHARACTERS = 512;
/** One nested fact. Qualifiers are `property=value` strings, unique and in source order. */
export type SubjectFact =
  | { property: string; value: string; qualifiers: string[] }
  | { property: string; year: number; qualifiers: string[] }
  | { property: string; amount: number; unit: string; qualifiers: string[] };
export type SubjectDocument = {
  id: string;
  partition: number;
  type: string;
  security_revision: number;
  names: string[];
  descriptions: string[];
  name_sort: string | null;
  statements: string[];
  facts: SubjectFact[];
  relation_facet_overflow?: string[];
  public_collection_count?: number;
  rating_score?: number | null;
  rating_prior_epoch?: number | null;
};
export type IndexAction =
  | { op: 'index'; id: string; version: bigint; document: SubjectDocument }
  | { op: 'delete'; id: string; version: bigint };
export declare function documentActions(snapshot: SubjectSnapshot, ids: readonly string[], counts?: ReadonlyMap<string, number>): IndexAction[];
export declare function bulkLines(index: string, actions: readonly IndexAction[]): unknown[];
