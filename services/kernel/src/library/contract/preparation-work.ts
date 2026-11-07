import type { CollectionSourceObservation, NativeSourceIdentity } from './source.ts';

/** Live episode locator. It is not Source authority or a reader Actor. */
export type PreparationLocator = Readonly<{
  route: number;
  ownerAccountId: string;
  collectionId: string;
  episodeId: string;
}>;

/** Structural Members episode inputs Search and Library both compare. Filter bodies stay with the producer. */
export type MembersWorkDefinition = Readonly<{
  definition: Readonly<{ sort: 'id' | 'ordinal'; release: Readonly<{ digest: string }> }>;
  sourceIdentity: NativeSourceIdentity;
  observation: CollectionSourceObservation;
}>;

/** The Source producer returns only fully evaluated rows and its retained opaque frontier. */
export type PreparationSourcePrefix = Readonly<{
  checkpoint: string;
  subjects: readonly string[];
  exhausted: boolean;
  observation: CollectionSourceObservation;
}>;

/** Library supplies the original native frame and ledger. Search supplies execution and its meters.
 * Declaration and execution share the same original; this capability grants no authority or funding.
 */
export interface PreparationWorkCapability<Transaction, Budget, Request> {
  prefix(input: Request): Promise<PreparationSourcePrefix | null>;
  withBudget<T>(budget: Budget, body: () => Promise<T>): Promise<T>;
  definition<T>(tx: Transaction, body: () => Promise<T>): Promise<T>;
}

/** Re-read the actual native producer definition for each structural Source use. */
export interface ScopeWorkCapability<Context, Options, Definition> {
  readDefinition(work: Context, options: Options): Promise<Definition>;
}
