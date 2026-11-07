/** Native public-filter reduction statement names and immutable producer declaration. */
export type CollectionReductionStatement = 'owner' | 'ensure' | 'lock' | 'advance' | 'append' | 'coverage';
export type CollectionReductionDeclaration<Cost> = Readonly<{
  version: number;
  axes: readonly string[];
  statements: Readonly<Record<CollectionReductionStatement, Cost>>;
  cost: Cost;
}>;
